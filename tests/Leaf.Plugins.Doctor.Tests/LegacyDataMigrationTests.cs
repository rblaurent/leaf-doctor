using System.Security.Cryptography;
using Xunit;

namespace Leaf.Plugins.Doctor.Tests;

public sealed class LegacyDataMigrationTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("legacy-migration").FullName;

    private string Legacy => Path.Combine(_root, "Legacy");
    private string Target => Path.Combine(_root, "PluginData", "plugin");

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { }
    }

    private void Write(string folder, string relative, string content, DateTime? utc = null)
    {
        var path = Path.Combine(folder, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        if (utc is { } stamp) File.SetLastWriteTimeUtc(path, stamp);
    }

    private void SeedLegacy()
    {
        Write(Legacy, "state.json", "{\"a\":1}", new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc));
        Write(Legacy, Path.Combine("sub", "deep", "data.bin"), "bytes");
        Write(Legacy, "cache.tmp", "rebuildable");
    }

    /// <summary>Every file in a folder: relative path, SHA-256 and write time, to prove it did not change.</summary>
    private static List<string> Snapshot(string folder) => Directory
        .EnumerateFiles(folder, "*", SearchOption.AllDirectories).Order()
        .Select(f => $"{Path.GetRelativePath(folder, f)}|{Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(f)))}|{File.GetLastWriteTimeUtc(f).Ticks}")
        .ToList();

    [Fact]
    public void Data_is_copied_once_the_old_folder_is_left_byte_identical_and_a_second_start_does_nothing()
    {
        SeedLegacy();
        var before = Snapshot(Legacy);

        var first = LegacyDataMigration.Run(Legacy, Target, skipRelativePath: p => p.EndsWith(".tmp"));

        Assert.Equal(LegacyMigrationOutcome.Migrated, first.Outcome);
        Assert.Equal(2, first.Copied);
        Assert.Equal(1, first.SkippedRebuildable);
        Assert.True(first.LegacyBytes > 0);
        Assert.Equal("{\"a\":1}", File.ReadAllText(Path.Combine(Target, "state.json")));
        Assert.Equal("bytes", File.ReadAllText(Path.Combine(Target, "sub", "deep", "data.bin")));
        Assert.Equal(new DateTime(2026, 3, 1, 0, 0, 0, DateTimeKind.Utc), File.GetLastWriteTimeUtc(Path.Combine(Target, "state.json")));
        Assert.False(File.Exists(Path.Combine(Target, "cache.tmp")));
        Assert.True(File.Exists(Path.Combine(Target, LegacyDataMigration.MarkerName)));
        // Nothing in the old folder was deleted, renamed or modified, rebuildable file included.
        Assert.Equal(before, Snapshot(Legacy));

        var second = LegacyDataMigration.Run(Legacy, Target);
        Assert.Equal(LegacyMigrationOutcome.AlreadyMigrated, second.Outcome);
        Assert.Equal(0, second.Copied);
    }

    [Fact]
    public void Once_the_marker_exists_later_changes_in_the_old_folder_are_never_copied()
    {
        SeedLegacy();
        LegacyDataMigration.Run(Legacy, Target);

        // A rolled-back old version writes fresh state and a new file in its own folder.
        Write(Legacy, "state.json", "rolled-back write", DateTime.UtcNow.AddDays(1));
        Write(Legacy, "new.json", "also rolled back");
        var legacyAfter = Snapshot(Legacy);

        var again = LegacyDataMigration.Run(Legacy, Target);

        Assert.Equal(LegacyMigrationOutcome.AlreadyMigrated, again.Outcome);
        Assert.Equal(0, again.Copied);
        Assert.Equal("{\"a\":1}", File.ReadAllText(Path.Combine(Target, "state.json")));
        Assert.False(File.Exists(Path.Combine(Target, "new.json")));
        Assert.Equal(legacyAfter, Snapshot(Legacy));
    }

    [Fact]
    public void A_file_already_in_the_new_folder_is_never_overwritten_even_when_the_old_one_is_newer()
    {
        Write(Legacy, "state.json", "old", DateTime.UtcNow.AddDays(1));
        Write(Target, "state.json", "written by the new version", new DateTime(2026, 1, 1, 0, 0, 0, DateTimeKind.Utc));
        Write(Legacy, "other.json", "other");

        var result = LegacyDataMigration.Run(Legacy, Target);

        Assert.Equal("written by the new version", File.ReadAllText(Path.Combine(Target, "state.json")));
        Assert.Equal("other", File.ReadAllText(Path.Combine(Target, "other.json")));
        Assert.Equal(1, result.KeptExisting);
        Assert.Equal(1, result.Copied);
        Assert.Equal("old", File.ReadAllText(Path.Combine(Legacy, "state.json")));
    }

    [Fact]
    public void A_crash_before_the_marker_reruns_safely_cleans_the_stale_temp_and_loses_nothing()
    {
        SeedLegacy();
        var before = Snapshot(Legacy);
        // What a crash half way leaves: one file already copied, one half-copied temp file, no marker.
        Write(Target, "state.json", "{\"a\":1}");
        Write(Target, Path.Combine("sub", "deep", "data.bin.migrating"), "par");
        Assert.False(File.Exists(Path.Combine(Target, LegacyDataMigration.MarkerName)));

        var result = LegacyDataMigration.Run(Legacy, Target);

        Assert.Equal(LegacyMigrationOutcome.Migrated, result.Outcome);
        Assert.Equal("bytes", File.ReadAllText(Path.Combine(Target, "sub", "deep", "data.bin")));
        Assert.Equal("{\"a\":1}", File.ReadAllText(Path.Combine(Target, "state.json")));
        Assert.Empty(Directory.EnumerateFiles(Target, "*.migrating", SearchOption.AllDirectories));
        Assert.True(File.Exists(Path.Combine(Target, LegacyDataMigration.MarkerName)));
        Assert.Equal(before, Snapshot(Legacy));
    }

    [Fact]
    public void A_locked_file_keeps_the_marker_back_so_the_next_start_retries_it()
    {
        SeedLegacy();
        var locked = Path.Combine(Legacy, "state.json");
        using (new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            var first = LegacyDataMigration.Run(Legacy, Target);
            Assert.Equal(LegacyMigrationOutcome.Incomplete, first.Outcome);
            Assert.Equal(1, first.Failed);
            Assert.False(File.Exists(Path.Combine(Target, LegacyDataMigration.MarkerName)));
        }

        var second = LegacyDataMigration.Run(Legacy, Target);

        Assert.Equal(LegacyMigrationOutcome.Migrated, second.Outcome);
        Assert.Equal("{\"a\":1}", File.ReadAllText(Path.Combine(Target, "state.json")));
    }

    [Fact]
    public void The_same_folder_or_nesting_is_left_alone()
    {
        Write(Target, "state.json", "kept");

        Assert.Equal(LegacyMigrationOutcome.SameFolder, LegacyDataMigration.Run(Target, Target).Outcome);
        Assert.Equal(LegacyMigrationOutcome.SameFolder, LegacyDataMigration.Run(Path.GetDirectoryName(Target)!, Target).Outcome);
        Assert.Equal("kept", File.ReadAllText(Path.Combine(Target, "state.json")));
    }

    [Fact]
    public void No_old_folder_is_a_quiet_no_op()
    {
        var result = LegacyDataMigration.Run(Legacy, Target);

        Assert.Equal(LegacyMigrationOutcome.NothingToMigrate, result.Outcome);
        Assert.False(File.Exists(Path.Combine(Target, LegacyDataMigration.MarkerName)));
    }
}
