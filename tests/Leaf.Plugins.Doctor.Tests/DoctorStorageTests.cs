using System.Text.Json.Nodes;
using Xunit;

namespace Leaf.Plugins.Doctor.Tests;

public sealed class DoctorStorageTests : IDisposable
{
    private readonly string _dataRoot = Directory.CreateTempSubdirectory("doctor-storage").FullName;

    private string DataDirectory => Path.Combine(_dataRoot, "PluginData", "doctor");
    private string Legacy => Path.Combine(_dataRoot, "Doctor");

    public void Dispose()
    {
        try { Directory.Delete(_dataRoot, true); } catch (IOException) { }
    }

    [Fact]
    public void Versions_and_state_resolve_under_the_data_directory()
    {
        var storage = new DoctorStorage(DataDirectory);

        Assert.Equal(Path.Combine(DataDirectory, "versions"), storage.VersionsDirectory);
        Assert.Equal(Path.Combine(DataDirectory, "state"), storage.StateDirectory);
        Assert.Equal(Path.Combine(DataDirectory, "state", "launcher.json"), storage.StatePath);
        Assert.Equal(Legacy, storage.LegacyDirectory);
    }

    [Fact]
    public void The_old_folder_copies_state_in_once_skips_the_rebuildable_versions_keeps_the_old_folder_and_rewrites_the_stored_path()
    {
        Directory.CreateDirectory(Path.Combine(Legacy, "state"));
        Directory.CreateDirectory(Path.Combine(Legacy, "versions", "1.1.1"));
        File.WriteAllText(Path.Combine(Legacy, "versions", "1.1.1", "leaf-doctor.js"), "js");
        var legacyState = new JsonObject
        {
            ["version"] = "1.1.1",
            ["port"] = 18899,
            ["runtimeDirectory"] = Path.Combine(Legacy, "versions", "1.1.1"),
            ["running"] = true,
        }.ToJsonString();
        File.WriteAllText(Path.Combine(Legacy, "state", "launcher.json"), legacyState);

        var storage = new DoctorStorage(DataDirectory);
        var first = storage.MigrateLegacy();

        Assert.Equal(LegacyMigrationOutcome.Migrated, first!.Outcome);
        Assert.Equal(1, first.Copied);
        Assert.Equal(1, first.SkippedRebuildable);
        Assert.False(Directory.Exists(storage.VersionsDirectory));
        // The old folder is untouched, versions included, and its launcher.json still has its own path.
        Assert.Equal("js", File.ReadAllText(Path.Combine(Legacy, "versions", "1.1.1", "leaf-doctor.js")));
        Assert.Equal(legacyState, File.ReadAllText(Path.Combine(Legacy, "state", "launcher.json")));
        // The copy in the new folder points at the new folder (absolute form kept).
        var state = JsonNode.Parse(File.ReadAllText(storage.StatePath))!.AsObject();
        Assert.Equal(Path.Combine(DataDirectory, "versions", "1.1.1"), state["runtimeDirectory"]!.GetValue<string>());
        Assert.Equal(18899, state["port"]!.GetValue<int>());

        Assert.Equal(LegacyMigrationOutcome.AlreadyMigrated, new DoctorStorage(DataDirectory).MigrateLegacy()!.Outcome);
    }

    [Fact]
    public void A_running_runtime_locking_the_old_versions_folder_changes_nothing_because_nothing_is_deleted()
    {
        Directory.CreateDirectory(Path.Combine(Legacy, "state"));
        Directory.CreateDirectory(Path.Combine(Legacy, "versions", "1.1.1"));
        File.WriteAllText(Path.Combine(Legacy, "state", "launcher.json"), "{}");
        var locked = Path.Combine(Legacy, "versions", "1.1.1", "node.exe");
        File.WriteAllText(locked, "node");
        using var hold = new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.Read);

        var result = new DoctorStorage(DataDirectory).MigrateLegacy()!;

        Assert.Equal(LegacyMigrationOutcome.Migrated, result.Outcome);
        Assert.Equal(0, result.Failed);
        Assert.True(File.Exists(Path.Combine(DataDirectory, "state", "launcher.json")));
        Assert.True(File.Exists(locked));
    }

    [Fact]
    public void The_manifest_requires_a_kernel_that_has_the_data_directory()
    {
        var kernelApi = new DoctorPlugin().Manifest.KernelApi;
        Assert.Equal("^0.1.13", kernelApi);
    }
}
