using System.Text.Json.Nodes;
using Leaf.Sdk;

namespace Leaf.Plugins.Doctor;

internal static class DoctorData
{
    public const string ConfigType = "doctor-config";
    public const string ConfigSlug = "doctor-config-singleton";

    public static string? String(JsonObject data, string key)
        => data[key] is JsonValue value && value.TryGetValue<string>(out var result)
            ? result : null;

    public static bool Boolean(JsonObject data, string key, bool fallback = false)
        => data[key] is JsonValue value && value.TryGetValue<bool>(out var result)
            ? result : fallback;

    public static int Integer(JsonObject data, string key, int fallback = 0)
        => data[key] is JsonValue value && value.TryGetValue<int>(out var result)
            ? result : fallback;
}

internal sealed record DoctorConfigSnapshot(
    LeafEntity Entity,
    bool Enabled,
    int Port,
    int Revision,
    string Provider,
    bool DangerousPermissions,
    bool TunnelEnabled,
    string AccessToken,
    string TunnelToken,
    string ControlKey,
    string? NodePath,
    string? CloudflaredPath,
    string? TunnelConfigFile,
    string? ClaudeCli,
    string? CodexCli,
    string? WorkspaceRoot,
    string? RebuildScript,
    string? RedLeafExe,
    string? RedComputeExe);
