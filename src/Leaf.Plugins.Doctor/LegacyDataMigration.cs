using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Leaf.Plugins.Doctor;

/// <summary>What one <see cref="LegacyDataMigration.Run"/> did.</summary>
/// <param name="Outcome">Why it did or did not copy anything.</param>
/// <param name="Copied">Files copied into the new folder this run.</param>
/// <param name="KeptExisting">Files the new folder already had; they are never overwritten (the new version wrote them, so they are newer).</param>
/// <param name="SkippedRebuildable">Rebuildable files deliberately not copied (the plugin rebuilds them).</param>
/// <param name="Failed">Files that could not be copied this time (locked, denied); the next start retries them.</param>
/// <param name="LegacyBytes">Size of the old folder, which is left exactly as it was.</param>
internal sealed record LegacyMigrationResult(
    LegacyMigrationOutcome Outcome, int Copied, int KeptExisting, int SkippedRebuildable, int Failed, long LegacyBytes = 0)
{
    public static LegacyMigrationResult Of(LegacyMigrationOutcome outcome) => new(outcome, 0, 0, 0, 0);

    public override string ToString() =>
        $"{Outcome}: copied {Copied}, kept existing {KeptExisting}, skipped rebuildable {SkippedRebuildable}, failed {Failed}, legacy folder {LegacyBytes} bytes";
}

internal enum LegacyMigrationOutcome
{
    /// <summary>The old folder is the new folder (or one holds the other); nothing to do.</summary>
    SameFolder,
    /// <summary>The marker exists: a previous start finished the copy. Never runs again, whatever the old folder holds later.</summary>
    AlreadyMigrated,
    /// <summary>There is no old folder.</summary>
    NothingToMigrate,
    /// <summary>The old folder was copied into the new one and the marker written.</summary>
    Migrated,
    /// <summary>Some files could not be copied; no marker, the next start continues.</summary>
    Incomplete,
}

/// <summary>
/// Copies the folder a plugin used to pick for itself (<c>%LOCALAPPDATA%\RedLeaf\&lt;name&gt;</c>) into the folder RedLeaf
/// now gives it (<c>PluginData\&lt;id&gt;</c>), once, and keeps the original.
/// <list type="bullet">
/// <item>Copy and keep: nothing in the old folder is deleted, renamed or modified, so a plugin rolled back to the previous
/// version finds its data where it left it. A later release removes the old folder.</item>
/// <item>Each file goes through a <c>.migrating</c> temp file, is verified by length and SHA-256, and is renamed into place
/// with its write time preserved; a crash leaves either nothing or a stale temp that the next run cleans.</item>
/// <item>A file already in the new folder is never overwritten: the new version wrote it, so it is newer by definition.</item>
/// <item>The marker is written last and, once it exists, the migration never runs again; whatever a rolled-back version
/// writes to the old folder afterwards is the accepted loss of a rollback.</item>
/// </list>
/// </summary>
internal static class LegacyDataMigration
{
    public const string MarkerName = ".migrated-from-legacy.json";
    private const string TempSuffix = ".migrating";

    /// <param name="legacyDirectory">The folder the plugin used before.</param>
    /// <param name="targetDirectory">The plugin's <c>DataDirectory</c>.</param>
    /// <param name="skipRelativePath">Rebuildable content: a relative path for which this returns true is not copied
    /// (and not deleted from the old folder either).</param>
    public static LegacyMigrationResult Run(
        string legacyDirectory,
        string targetDirectory,
        ILogger? log = null,
        Func<string, bool>? skipRelativePath = null)
    {
        var legacy = Path.TrimEndingDirectorySeparator(Path.GetFullPath(legacyDirectory));
        var target = Path.TrimEndingDirectorySeparator(Path.GetFullPath(targetDirectory));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var markerPath = Path.Combine(target, MarkerName);

        // A target inside the old folder (or the reverse) would copy a folder into itself.
        if (string.Equals(legacy, target, comparison)
            || IsInside(target, legacy, comparison) || IsInside(legacy, target, comparison))
            return Finish(log, legacy, target, LegacyMigrationResult.Of(LegacyMigrationOutcome.SameFolder));
        if (File.Exists(markerPath))
            return Finish(log, legacy, target, LegacyMigrationResult.Of(LegacyMigrationOutcome.AlreadyMigrated));
        if (!Directory.Exists(legacy))
            return Finish(log, legacy, target, LegacyMigrationResult.Of(LegacyMigrationOutcome.NothingToMigrate));

        Directory.CreateDirectory(target);
        // Half-copies left by a crashed earlier run.
        foreach (var stale in Directory.EnumerateFiles(target, "*" + TempSuffix, SearchOption.AllDirectories))
            try { File.Delete(stale); } catch (IOException) { }

        int copied = 0, kept = 0, skipped = 0, failed = 0;
        long legacyBytes = 0;
        foreach (var source in Directory.EnumerateFiles(legacy, "*", SearchOption.AllDirectories).ToList())
        {
            var relative = Path.GetRelativePath(legacy, source);
            try
            {
                legacyBytes += new FileInfo(source).Length;
                if (skipRelativePath?.Invoke(relative) == true)
                {
                    skipped++;
                    continue;
                }

                var destination = Path.Combine(target, relative);
                if (File.Exists(destination))
                {
                    kept++;
                    continue;
                }

                Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
                CopyVerify(source, destination);
                copied++;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                failed++;
                log?.LogWarning(ex, "Could not copy {File} from {Legacy} to {Target}; the next start retries it",
                    relative, legacy, target);
            }
        }

        var result = new LegacyMigrationResult(
            failed > 0 ? LegacyMigrationOutcome.Incomplete : LegacyMigrationOutcome.Migrated,
            copied, kept, skipped, failed, legacyBytes);
        if (failed == 0)
        {
            // Last: until this exists a crash simply reruns the loop above.
            var temp = markerPath + TempSuffix;
            File.WriteAllText(temp, JsonSerializer.Serialize(new
            {
                migratedAtUtc = DateTimeOffset.UtcNow,
                from = legacy,
                copied,
                keptExisting = kept,
                skippedRebuildable = skipped,
                legacyBytes,
            }));
            File.Move(temp, markerPath, overwrite: true);
        }
        return Finish(log, legacy, target, result);
    }

    private static LegacyMigrationResult Finish(ILogger? log, string legacy, string target, LegacyMigrationResult result)
    {
        if (result.Outcome is LegacyMigrationOutcome.Migrated or LegacyMigrationOutcome.Incomplete)
            log?.LogInformation(
                "Plugin data migration {Target}: {Result}. {Legacy} ({Bytes} bytes) is kept for rollback; a later release removes it",
                target, result, legacy, result.LegacyBytes);
        else
            log?.LogDebug("Plugin data migration {Legacy} -> {Target}: {Result}", legacy, target, result);
        return result;
    }

    private static bool IsInside(string path, string folder, StringComparison comparison)
        => path.StartsWith(folder + Path.DirectorySeparatorChar, comparison);

    private static byte[] Sha256(string path)
    {
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        return SHA256.HashData(stream);
    }

    private static void CopyVerify(string source, string destination)
    {
        var temp = destination + TempSuffix;
        File.Copy(source, temp, overwrite: true);
        if (new FileInfo(source).Length != new FileInfo(temp).Length || !Sha256(source).AsSpan().SequenceEqual(Sha256(temp)))
        {
            File.Delete(temp);
            throw new IOException($"The copy of '{source}' did not verify");
        }
        File.SetLastWriteTimeUtc(temp, File.GetLastWriteTimeUtc(source));
        File.Move(temp, destination, overwrite: false);
    }
}
