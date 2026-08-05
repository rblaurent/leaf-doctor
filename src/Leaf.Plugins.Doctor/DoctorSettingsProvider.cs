using System.Text.Json.Nodes;
using Leaf.Sdk.Services;

namespace Leaf.Plugins.Doctor;

public sealed class DoctorSettingsProvider(DoctorRuntimeService runtime)
    : IPluginSettingsProvider
{
    private static readonly IReadOnlyDictionary<string, HashSet<string>> Allowed =
        new Dictionary<string, HashSet<string>>(StringComparer.Ordinal)
        {
            ["runtime"] = ["enabled", "port", "node_path", "restart_runtime"],
            ["access"] = ["access_token", "rotate_access_token"],
            ["tunnel"] = ["tunnel_enabled", "tunnel_token", "cloudflared_path", "tunnel_config_file"],
            ["repair"] = ["doctor_provider", "dangerous_permissions", "claude_cli", "codex_cli"],
            ["advanced"] = ["workspace_root", "rebuild_script", "redleaf_exe", "redcompute_exe"],
        };

    public string PluginId => DoctorPlugin.PluginId;

    public async Task<JsonObject> DescribeAsync(string? userId, CancellationToken ct = default)
    {
        var config = await runtime.GetConfigAsync(ct);
        var status = await runtime.StatusAsync(ct);
        return new JsonObject
        {
            ["id"] = PluginId,
            ["status"] = status,
            ["sourceOfTruth"] = "entities",
            ["sections"] = new JsonArray
            {
                Section("runtime", "Runtime", new JsonArray
                {
                    Field("enabled", "boolean", config.Enabled,
                        "Launch Doctor independently when RedLeaf starts."),
                    Field("port", "number", config.Port,
                        "Loopback port used by Doctor and Cloudflare Tunnel."),
                    Field("node_path", "string", config.NodePath,
                        "Optional Node.js override. A bundled runtime or PATH is used by default."),
                    Action("restart_runtime", "settings:runtime",
                        "Restart the detached runtime and verify its health."),
                }),
                Section("access", "Access", new JsonArray
                {
                    SecretField("access_token", !string.IsNullOrWhiteSpace(config.AccessToken),
                        "Authenticates the standalone recovery dashboard."),
                    Action("rotate_access_token", "/api/extensions/doctor/actions/rotate-access-token",
                        "Generate a new access token and reveal it once."),
                }),
                Section("tunnel", "Cloudflare Tunnel", new JsonArray
                {
                    Field("tunnel_enabled", "boolean", config.TunnelEnabled,
                        "Expose Doctor through its dedicated Cloudflare Tunnel."),
                    SecretField("tunnel_token", !string.IsNullOrWhiteSpace(config.TunnelToken),
                        "Cloudflare remotely managed tunnel token."),
                    Field("cloudflared_path", "string", config.CloudflaredPath,
                        "Optional cloudflared executable override."),
                    Field("tunnel_config_file", "string", config.TunnelConfigFile,
                        "Optional local tunnel configuration file instead of a token."),
                }),
                Section("repair", "Repair sessions", new JsonArray
                {
                    Field("doctor_provider", "select", config.Provider,
                        "Default coding agent for deep repairs.", new JsonArray("claude", "codex")),
                    Field("dangerous_permissions", "boolean", config.DangerousPermissions,
                        "Allow the selected coding agent to repair the machine without approval prompts."),
                    Field("claude_cli", "string", config.ClaudeCli,
                        "Optional Claude Code executable override."),
                    Field("codex_cli", "string", config.CodexCli,
                        "Optional Codex executable override."),
                }),
                Section("advanced", "Advanced", new JsonArray
                {
                    Field("workspace_root", "string", config.WorkspaceRoot,
                        "Developer checkout used as the repair session working directory."),
                    Field("rebuild_script", "string", config.RebuildScript,
                        "Developer-only suite rebuild script."),
                    Field("redleaf_exe", "string", config.RedLeafExe,
                        "Optional RedLeaf executable override."),
                    Field("redcompute_exe", "string", config.RedComputeExe,
                        "Optional RedCompute executable override."),
                }),
            },
            ["actions"] = new JsonObject
            {
                ["restartRuntime"] = "PUT /api/extensions/doctor/settings section=runtime",
                ["rotateAccessToken"] = "PUT /api/extensions/doctor/settings section=access",
            },
            ["secretPolicy"] = new JsonObject
            {
                ["fieldType"] = "secret",
                ["protection"] = "encrypted",
                ["readable"] = false,
            },
        };
    }

    public async Task<JsonObject> WriteAsync(
        string? userId,
        string section,
        JsonObject values,
        bool validateOnly,
        CancellationToken ct = default)
    {
        if (!Allowed.TryGetValue(section, out var allowed))
            throw new ArgumentException($"Unknown Doctor settings section '{section}'");

        if (section == "runtime" && values["restart_runtime"]?.GetValue<bool>() == true)
        {
            if (!validateOnly) await runtime.RestartAsync(ct);
            return new JsonObject
            {
                ["ok"] = true,
                ["validatedOnly"] = validateOnly,
                ["section"] = section,
                ["status"] = validateOnly ? null : await runtime.StatusAsync(ct),
            };
        }

        if (section == "access" && values["rotate_access_token"]?.GetValue<bool>() == true)
        {
            var token = validateOnly ? null : await runtime.RotateAccessTokenAsync(ct);
            return new JsonObject
            {
                ["ok"] = true,
                ["validatedOnly"] = validateOnly,
                ["section"] = section,
                ["token"] = token,
                ["oneTime"] = !validateOnly,
            };
        }

        var patch = new JsonObject();
        foreach (var (key, value) in values)
        {
            if (!allowed.Contains(key)) throw new ArgumentException($"Unknown setting '{key}'");
            if (value == null) continue;
            if (key is "access_token" or "tunnel_token"
                && value is JsonValue secretValue
                && secretValue.TryGetValue<string>(out var secret)
                && string.IsNullOrWhiteSpace(secret))
                continue;
            patch[key] = value.DeepClone();
        }

        Validate(patch);
        if (section == "tunnel") await ValidateTunnelAsync(patch, ct);

        if (!validateOnly && patch.Count > 0)
            await runtime.ApplySettingsAsync(patch, ct);

        var visible = patch.DeepClone().AsObject();
        foreach (var key in new[] { "access_token", "tunnel_token" })
            if (visible.Remove(key)) visible[key] = new JsonObject { ["configured"] = true };

        return new JsonObject
        {
            ["ok"] = true,
            ["validatedOnly"] = validateOnly,
            ["section"] = section,
            ["values"] = visible,
            ["status"] = validateOnly ? null : await runtime.StatusAsync(ct),
        };
    }

    private async Task ValidateTunnelAsync(JsonObject patch, CancellationToken ct)
    {
        var current = await runtime.GetConfigAsync(ct);
        var enabled = patch["tunnel_enabled"]?.GetValue<bool>() ?? current.TunnelEnabled;
        var token = patch["tunnel_token"]?.GetValue<string>() ?? current.TunnelToken;
        var file = patch["tunnel_config_file"]?.GetValue<string>() ?? current.TunnelConfigFile;
        if (enabled && string.IsNullOrWhiteSpace(token) && string.IsNullOrWhiteSpace(file))
            throw new ArgumentException(
                "Cloudflare Tunnel requires either a tunnel token or a tunnel configuration file");
    }

    private static void Validate(JsonObject patch)
    {
        if (patch["port"] is JsonValue portValue
            && (!portValue.TryGetValue<int>(out var port) || port is < 1024 or > 65535))
            throw new ArgumentException("port must be between 1024 and 65535");

        if (patch["doctor_provider"] is JsonValue providerValue
            && (!providerValue.TryGetValue<string>(out var provider)
                || provider is not ("claude" or "codex")))
            throw new ArgumentException("doctor_provider must be 'claude' or 'codex'");

        if (patch["access_token"] is JsonValue tokenValue
            && tokenValue.TryGetValue<string>(out var token)
            && token.Trim().Length < 24)
            throw new ArgumentException("access_token must contain at least 24 characters");

        foreach (var pathKey in new[]
                 {
                     "node_path", "cloudflared_path", "tunnel_config_file", "claude_cli",
                     "codex_cli", "workspace_root", "rebuild_script", "redleaf_exe", "redcompute_exe",
                 })
        {
            if (patch[pathKey] is JsonValue pathValue
                && pathValue.TryGetValue<string>(out var path))
                patch[pathKey] = string.IsNullOrWhiteSpace(path) ? null : path.Trim();
        }
    }

    private static JsonObject Section(string id, string label, JsonArray fields)
        => new() { ["id"] = id, ["label"] = label, ["kind"] = "entity-settings", ["fields"] = fields };

    private static JsonObject Field(
        string key, string type, object? value, string description, JsonArray? options = null)
    {
        var field = new JsonObject
        {
            ["key"] = key,
            ["type"] = type,
            ["value"] = JsonValue.Create(value),
            ["description"] = description,
        };
        if (options != null) field["options"] = options;
        return field;
    }

    private static JsonObject SecretField(string key, bool configured, string description)
        => new()
        {
            ["key"] = key,
            ["type"] = "secret",
            ["configured"] = configured,
            ["description"] = description,
        };

    private static JsonObject Action(string key, string endpoint, string description)
        => new()
        {
            ["key"] = key,
            ["type"] = "action",
            ["endpoint"] = endpoint,
            ["description"] = description,
        };
}
