using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging;

namespace Leaf.Plugins.Doctor;

/// <summary>
/// Where Doctor keeps its own files: <c>PluginContext.DataDirectory</c>, which RedLeaf places under its data location
/// and moves with it. Holds <c>versions\&lt;version&gt;</c> (the runtime files copied out of the plugin package, rebuilt
/// by every start) and <c>state\launcher.json</c>. Doctor used to pick <c>%LOCALAPPDATA%\RedLeaf\Doctor</c> itself.
/// </summary>
internal sealed class DoctorStorage
{
    public DoctorStorage(string dataDirectory) => DataDirectory = Path.GetFullPath(dataDirectory);

    public string DataDirectory { get; }
    public string VersionsDirectory => Path.Combine(DataDirectory, "versions");
    public string StateDirectory => Path.Combine(DataDirectory, "state");
    public string StatePath => Path.Combine(StateDirectory, "launcher.json");

    /// <summary>The folder Doctor used before data had a plugin folder: <c>&lt;data location&gt;\Doctor</c>; null when the data directory is not laid out as <c>&lt;data location&gt;\PluginData\&lt;id&gt;</c> (a test).</summary>
    public string? LegacyDirectory
    {
        get
        {
            var pluginData = Path.GetDirectoryName(DataDirectory);
            return pluginData is not null && string.Equals(Path.GetFileName(pluginData), "PluginData", StringComparison.OrdinalIgnoreCase)
                && Path.GetDirectoryName(pluginData) is { } root
                ? Path.Combine(root, "Doctor")
                : null;
        }
    }

    internal LegacyMigrationResult? Migration { get; private set; }
    internal Exception? MigrationError { get; private set; }

    /// <summary>
    /// Copy the old folder in, once, and keep it for rollback. <c>versions\</c> is not copied: it is rebuilt from the plugin
    /// package on every start (and a running runtime may hold the old copy). Never throws: a failed copy must not stop the plugin loading.
    /// </summary>
    internal LegacyMigrationResult? MigrateLegacy(ILogger? log = null)
    {
        try
        {
            if (LegacyDirectory is not { } legacy) return null;
            Migration = LegacyDataMigration.Run(legacy, DataDirectory, log, skipRelativePath: IsVersionsFile);
            if (Migration.Outcome is LegacyMigrationOutcome.Migrated or LegacyMigrationOutcome.Incomplete)
                RewriteLauncherState(legacy);
        }
        catch (Exception ex)
        {
            MigrationError = ex;
            log?.LogError(ex, "Doctor could not migrate its old data folder into {Target}", DataDirectory);
        }
        return Migration;
    }

    private static bool IsVersionsFile(string relative)
        => relative.StartsWith("versions" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// <c>launcher.json</c> (the copy in the new folder; the old one is untouched) names the runtime directory by absolute path.
    /// Keep the absolute form and point it at the new folder. The path is only ever written, never read, and the same startup
    /// materializes that folder before rewriting the file, so a rolled-back version finds a real path either way.
    /// </summary>
    private void RewriteLauncherState(string legacy)
    {
        try
        {
            if (!File.Exists(StatePath)) return;
            if (JsonNode.Parse(File.ReadAllText(StatePath)) is not JsonObject state
                || state["runtimeDirectory"]?.GetValue<string>() is not { Length: > 0 } runtime)
                return;
            var prefix = Path.TrimEndingDirectorySeparator(legacy);
            if (!runtime.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return;
            state["runtimeDirectory"] = DataDirectory + runtime[prefix.Length..];
            var temp = StatePath + ".tmp";
            File.WriteAllText(temp, state.ToJsonString());
            File.Move(temp, StatePath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or InvalidOperationException)
        {
            // Doctor's own reconcile rewrites this file on the next start.
        }
    }

    internal void LogMigration(ILogger log)
    {
        if (MigrationError is { } error)
            log.LogError(error, "Doctor could not migrate its old data folder into {Target}", DataDirectory);
        else if (Migration is { } result)
            log.LogInformation("Doctor data folder {Legacy} -> {Target}: {Result}", LegacyDirectory, DataDirectory, result);
    }
}
