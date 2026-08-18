using System.Diagnostics;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Leaf.Sdk.Services;
using Microsoft.Extensions.Logging;

namespace Leaf.Plugins.Doctor;

public sealed class DoctorRuntimeService(
    string pluginDirectory,
    string pluginVersion,
    IEntityStore entities,
    ILogger logger)
{
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(4) };
    private static readonly string[] RuntimeFiles =
        ["leaf-doctor.js", "dashboard.html", "doctor-prompt.md", "package.json"];
    private readonly SemaphoreSlim _gate = new(1, 1);

    private string RootDirectory => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "RedLeaf", "Doctor");
    private string VersionsDirectory => Path.Combine(RootDirectory, "versions");
    private string StateDirectory => Path.Combine(RootDirectory, "state");
    private string StatePath => Path.Combine(StateDirectory, "launcher.json");

    public async Task EnsureDefaultsAsync(CancellationToken ct = default)
    {
        if (await entities.GetBySlugAsync(DoctorData.ConfigType, DoctorData.ConfigSlug, ct) != null)
            return;

        var data = new JsonObject
        {
            ["enabled"] = true,
            ["port"] = 18899,
            ["config_revision"] = 1,
            ["doctor_provider"] = "claude",
            ["dangerous_permissions"] = true,
            ["tunnel_enabled"] = false,
            ["access_token"] = Secret(),
            ["control_key"] = Secret(),
        };

        ImportLegacyConfig(data);
        await entities.UpsertBySlugAsync(
            DoctorData.ConfigType, DoctorData.ConfigSlug, "Doctor Config", data, ct);
    }

    internal async Task<DoctorConfigSnapshot> GetConfigAsync(CancellationToken ct = default)
    {
        var entity = await entities.GetBySlugAsync(
            DoctorData.ConfigType, DoctorData.ConfigSlug, ct)
            ?? throw new InvalidOperationException("Doctor configuration is missing");
        var data = entity.Data;
        return new DoctorConfigSnapshot(
            entity,
            DoctorData.Boolean(data, "enabled", true),
            Math.Clamp(DoctorData.Integer(data, "port", 18899), 1024, 65535),
            Math.Max(1, DoctorData.Integer(data, "config_revision", 1)),
            DoctorData.String(data, "doctor_provider") ?? "claude",
            DoctorData.Boolean(data, "dangerous_permissions", true),
            DoctorData.Boolean(data, "tunnel_enabled"),
            DoctorData.String(data, "access_token") ?? "",
            DoctorData.String(data, "tunnel_token") ?? "",
            DoctorData.String(data, "control_key") ?? "",
            DoctorData.String(data, "node_path"),
            DoctorData.String(data, "cloudflared_path"),
            DoctorData.String(data, "tunnel_config_file"),
            DoctorData.String(data, "claude_cli"),
            DoctorData.String(data, "codex_cli"),
            DoctorData.String(data, "workspace_root"),
            DoctorData.String(data, "rebuild_script"),
            DoctorData.String(data, "redleaf_exe"),
            DoctorData.String(data, "redcompute_exe"));
    }

    internal async Task<DoctorConfigSnapshot> ApplySettingsAsync(
        JsonObject patch, CancellationToken ct = default)
    {
        var current = await GetConfigAsync(ct);
        patch["config_revision"] = current.Revision + 1;
        await entities.PatchAsync(current.Entity.Id, patch, ct: ct);
        var updated = await GetConfigAsync(ct);
        await ReconcileAsync(updated, ct);
        return updated;
    }

    public async Task<string> RotateAccessTokenAsync(CancellationToken ct = default)
    {
        var token = Secret();
        await ApplySettingsAsync(new JsonObject { ["access_token"] = token }, ct);
        return token;
    }

    public async Task EnsureRunningAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await ReconcileCoreAsync(await GetConfigAsync(ct), forceRestart: false, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task RestartAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await ReconcileCoreAsync(await GetConfigAsync(ct), forceRestart: true, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task ReconcileAsync(DoctorConfigSnapshot config, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            await ReconcileCoreAsync(config, forceRestart: false, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task ReconcileCoreAsync(
        DoctorConfigSnapshot config, bool forceRestart, CancellationToken ct)
    {
        var previous = ReadLauncherState();
        var existingPort = previous?["port"]?.GetValue<int?>() ?? config.Port;

        if (!config.Enabled)
        {
            await ShutdownAsync(existingPort, config.ControlKey, ct);
            WriteLauncherState(config, runtimeDirectory: null, running: false);
            logger.LogInformation("Doctor is disabled");
            return;
        }

        var runtimeDirectory = MaterializeRuntime();
        var health = await ReadHealthAsync(existingPort, ct);
        var healthyVersion = health?["version"]?.GetValue<string>();
        var healthyRevision = health?["configRevision"]?.GetValue<int?>();

        if (!forceRestart && health != null
            && healthyVersion == pluginVersion
            && healthyRevision == config.Revision)
        {
            WriteLauncherState(config, runtimeDirectory, running: true);
            logger.LogInformation("Doctor {Version} already healthy on port {Port}",
                pluginVersion, existingPort);
            return;
        }

        if (!forceRestart && health != null && healthyVersion == pluginVersion
            && existingPort == config.Port
            && await TryReconfigureAsync(existingPort, config, ct))
        {
            WriteLauncherState(config, runtimeDirectory, running: true);
            logger.LogInformation("Doctor accepted configuration revision {Revision}", config.Revision);
            return;
        }

        if (health != null)
        {
            var stopped = await ShutdownAsync(existingPort, config.ControlKey, ct);
            if (!stopped && health["service"]?.GetValue<string>() == "leaf-doctor"
                && health["version"] == null)
                stopped = TryStopLegacyRuntime(existingPort);
            if (!stopped)
                throw new InvalidOperationException(
                    $"Doctor is running on port {existingPort} but rejected the authenticated restart");
            await WaitUntilStoppedAsync(existingPort, ct);
        }

        await LaunchAsync(runtimeDirectory, config, ct);
        for (var attempt = 0; attempt < 12; attempt++)
        {
            await Task.Delay(250, ct);
            health = await ReadHealthAsync(config.Port, ct);
            if (health?["version"]?.GetValue<string>() == pluginVersion)
            {
                WriteLauncherState(config, runtimeDirectory, running: true);
                logger.LogInformation("Doctor {Version} started on port {Port}", pluginVersion, config.Port);
                return;
            }
        }

        throw new InvalidOperationException(
            $"Doctor process was launched but did not become healthy on port {config.Port}");
    }

    public async Task<JsonObject> StatusAsync(CancellationToken ct = default)
    {
        var config = await GetConfigAsync(ct);
        var state = ReadLauncherState();
        var effectivePort = state?["port"]?.GetValue<int?>() ?? config.Port;
        var health = await ReadHealthAsync(effectivePort, ct);
        return new JsonObject
        {
            ["enabled"] = config.Enabled,
            ["healthy"] = health != null,
            ["configuredRevision"] = config.Revision,
            ["effectiveRevision"] = health?["configRevision"]?.DeepClone(),
            ["packagedVersion"] = pluginVersion,
            ["effectiveVersion"] = health?["version"]?.DeepClone(),
            ["port"] = effectivePort,
            ["url"] = $"http://127.0.0.1:{effectivePort}/",
            ["tunnelEnabled"] = config.TunnelEnabled,
            ["accessTokenConfigured"] = !string.IsNullOrWhiteSpace(config.AccessToken),
            ["tunnelTokenConfigured"] = !string.IsNullOrWhiteSpace(config.TunnelToken),
        };
    }

    private string MaterializeRuntime()
    {
        var packaged = Path.Combine(pluginDirectory, "payload", "doctor");
        var source = Directory.Exists(packaged) ? packaged : pluginDirectory;
        var versionDirectory = Path.Combine(VersionsDirectory, SafeSegment(pluginVersion));
        Directory.CreateDirectory(versionDirectory);
        Directory.CreateDirectory(StateDirectory);

        foreach (var file in RuntimeFiles)
        {
            var from = Path.Combine(source, file);
            if (!File.Exists(from))
                throw new FileNotFoundException($"Doctor package is missing runtime file '{file}'", from);
            RuntimeMaterializer.CopyVersionFile(from, Path.Combine(versionDirectory, file));
        }

        var bundledNode = Path.Combine(source, "node.exe");
        if (File.Exists(bundledNode))
            RuntimeMaterializer.CopyVersionFile(
                bundledNode, Path.Combine(versionDirectory, "node.exe"));

        return versionDirectory;
    }

    private async Task LaunchAsync(
        string runtimeDirectory, DoctorConfigSnapshot config, CancellationToken ct)
    {
        var node = FindNode(runtimeDirectory, config.NodePath)
            ?? throw new InvalidOperationException(
                "Node.js is unavailable. The Doctor package has no bundled node.exe and node was not found on PATH.");
        var runtimeConfig = BuildRuntimeConfig(config);
        var psi = new ProcessStartInfo
        {
            FileName = node,
            WorkingDirectory = runtimeDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = false,
            RedirectStandardError = false,
        };
        psi.ArgumentList.Add(Path.Combine(runtimeDirectory, "leaf-doctor.js"));
        psi.ArgumentList.Add("--config-stdin");

        using var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Process.Start returned null for Doctor");
        await process.StandardInput.WriteAsync(runtimeConfig.ToJsonString().AsMemory(), ct);
        process.StandardInput.Close();
    }

    private JsonObject BuildRuntimeConfig(DoctorConfigSnapshot config)
    {
        var workspaceRoot = config.WorkspaceRoot;
        var rebuildScript = config.RebuildScript;
        var redLeafExe = config.RedLeafExe ?? Environment.ProcessPath;
        return new JsonObject
        {
            ["port"] = config.Port,
            ["bindAddress"] = "127.0.0.1",
            ["runtimeVersion"] = pluginVersion,
            ["configRevision"] = config.Revision,
            ["stateDir"] = StateDirectory,
            ["authToken"] = config.AccessToken,
            ["controlKey"] = config.ControlKey,
            ["doctorProvider"] = config.Provider,
            ["dangerousPermissions"] = config.DangerousPermissions,
            ["rebuildByDefault"] = !string.IsNullOrWhiteSpace(rebuildScript)
                && File.Exists(rebuildScript),
            ["paths"] = new JsonObject
            {
                ["redleafExe"] = redLeafExe,
                ["redcomputeExe"] = config.RedComputeExe,
                ["cloudflared"] = config.CloudflaredPath,
                ["claudeCli"] = config.ClaudeCli,
                ["codexCli"] = config.CodexCli,
                ["redleafRoot"] = workspaceRoot,
                ["rebuildScript"] = rebuildScript,
                ["doctorPrompt"] = "doctor-prompt.md",
            },
            ["tunnel"] = new JsonObject
            {
                ["enabled"] = config.TunnelEnabled,
                ["token"] = config.TunnelToken,
                ["configFile"] = config.TunnelConfigFile,
            },
            ["services"] = DefaultServices(),
        };
    }

    private async Task<bool> TryReconfigureAsync(
        int port, DoctorConfigSnapshot config, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post, $"http://127.0.0.1:{port}/internal/reconcile");
            request.Headers.TryAddWithoutValidation("X-Doctor-Control", config.ControlKey);
            request.Content = JsonContent.Create(BuildRuntimeConfig(config));
            using var response = await Http.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode) return false;
            var result = await response.Content.ReadFromJsonAsync<JsonObject>(cancellationToken: ct);
            return result?["restartRequired"]?.GetValue<bool>() != true;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<bool> ShutdownAsync(
        int port, string controlKey, CancellationToken ct)
    {
        try
        {
            using var request = new HttpRequestMessage(
                HttpMethod.Post, $"http://127.0.0.1:{port}/internal/shutdown");
            request.Headers.TryAddWithoutValidation("X-Doctor-Control", controlKey);
            using var response = await Http.SendAsync(request, ct);
            return response.IsSuccessStatusCode;
        }
        catch
        {
            return false;
        }
    }

    private static async Task<JsonObject?> ReadHealthAsync(int port, CancellationToken ct)
    {
        try
        {
            return await Http.GetFromJsonAsync<JsonObject>(
                $"http://127.0.0.1:{port}/health", ct);
        }
        catch
        {
            return null;
        }
    }

    private static async Task WaitUntilStoppedAsync(int port, CancellationToken ct)
    {
        for (var attempt = 0; attempt < 20; attempt++)
        {
            if (await ReadHealthAsync(port, ct) == null) return;
            await Task.Delay(100, ct);
        }
        throw new InvalidOperationException($"Doctor did not stop listening on port {port}");
    }

    /// <summary>
    /// One-time takeover for the pre-extension Node process, which had a health endpoint
    /// but no authenticated control API. The health identity and process name are both
    /// checked before terminating anything.
    /// </summary>
    private bool TryStopLegacyRuntime(int port)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netstat.exe",
                Arguments = "-ano -p TCP",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            using var netstat = Process.Start(psi);
            if (netstat == null) return false;
            var output = netstat.StandardOutput.ReadToEnd();
            netstat.WaitForExit(3000);
            foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            {
                var columns = line.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
                if (columns.Length < 5 || !columns[0].Equals("TCP", StringComparison.OrdinalIgnoreCase)
                    || !columns[1].EndsWith($":{port}", StringComparison.Ordinal)
                    || !int.TryParse(columns[^1], out var pid))
                    continue;

                using var process = Process.GetProcessById(pid);
                if (!process.ProcessName.Equals("node", StringComparison.OrdinalIgnoreCase)
                    && !process.ProcessName.Equals("leaf-doctor", StringComparison.OrdinalIgnoreCase))
                    return false;
                process.Kill(entireProcessTree: true);
                logger.LogInformation("Stopped legacy Doctor runtime PID {Pid} during extension takeover", pid);
                return true;
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not stop the legacy Doctor runtime");
        }
        return false;
    }

    private JsonObject? ReadLauncherState()
    {
        try
        {
            return File.Exists(StatePath)
                ? JsonNode.Parse(File.ReadAllText(StatePath)) as JsonObject
                : null;
        }
        catch
        {
            return null;
        }
    }

    private void WriteLauncherState(
        DoctorConfigSnapshot config, string? runtimeDirectory, bool running)
    {
        Directory.CreateDirectory(StateDirectory);
        var state = new JsonObject
        {
            ["version"] = pluginVersion,
            ["configRevision"] = config.Revision,
            ["port"] = config.Port,
            ["runtimeDirectory"] = runtimeDirectory,
            ["running"] = running,
            ["updatedAt"] = DateTimeOffset.UtcNow.ToString("O"),
        };
        var temp = StatePath + ".tmp";
        File.WriteAllText(temp, state.ToJsonString());
        File.Move(temp, StatePath, overwrite: true);
    }

    private void ImportLegacyConfig(JsonObject target)
    {
        var path = Path.Combine(pluginDirectory, "config.json");
        if (!File.Exists(path)) return;
        try
        {
            var legacy = JsonNode.Parse(File.ReadAllText(path)) as JsonObject;
            if (legacy == null) return;
            Copy(legacy, target, "authToken", "access_token");
            Copy(legacy, target, "doctorProvider", "doctor_provider");
            if (legacy["paths"] is JsonObject paths)
            {
                Copy(paths, target, "redleafExe", "redleaf_exe");
                Copy(paths, target, "redcomputeExe", "redcompute_exe");
                Copy(paths, target, "cloudflared", "cloudflared_path");
                Copy(paths, target, "claudeCli", "claude_cli");
                Copy(paths, target, "codexCli", "codex_cli");
                Copy(paths, target, "redleafRoot", "workspace_root");
                Copy(paths, target, "rebuildScript", "rebuild_script");
            }
            if (legacy["tunnel"] is JsonObject tunnel)
            {
                target["tunnel_enabled"] = DoctorData.Boolean(tunnel, "enabled");
                Copy(tunnel, target, "token", "tunnel_token");
                Copy(tunnel, target, "configFile", "tunnel_config_file");
            }
            logger.LogInformation("Imported legacy Doctor config into extension settings");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Could not import legacy Doctor config");
        }
    }

    private static void Copy(JsonObject source, JsonObject target, string from, string to)
    {
        if (DoctorData.String(source, from) is { Length: > 0 } value)
            target[to] = value;
    }

    internal static JsonObject DefaultServices() => new()
    {
        ["redleaf"] = new JsonObject { ["port"] = 18804, ["pingPath"] = "/ping" },
        ["redcompute"] = new JsonObject { ["port"] = 18800, ["pingPath"] = "/ping" },
        ["postgres"] = new JsonObject { ["port"] = 18832, ["process"] = "postgres.exe" },
        ["nova"] = new JsonObject { ["port"] = 18804, ["pingPath"] = "/api/apps/nova/discussions?limit=1" },
        ["codered"] = new JsonObject { ["port"] = 18801, ["pingPath"] = "/discover" },
        ["api"] = new JsonObject
        {
            ["port"] = 18804,
            ["checks"] = new JsonArray
            {
                new JsonObject { ["name"] = "Entities API", ["path"] = "/api/entities?type=agent&limit=1" },
                new JsonObject { ["name"] = "Automations", ["path"] = "/api/automations/status" },
                new JsonObject { ["name"] = "Streams", ["path"] = "/api/streams" },
                new JsonObject { ["name"] = "Discovery API", ["path"] = "/discover" },
            },
        },
    };

    private static string? FindNode(string runtimeDirectory, string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured)) return configured;
        var bundled = Path.Combine(runtimeDirectory, "node.exe");
        if (File.Exists(bundled)) return bundled;
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "where.exe",
                Arguments = "node",
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
            };
            using var process = Process.Start(psi);
            process?.WaitForExit(3000);
            if (process?.ExitCode == 0)
            {
                var path = process.StandardOutput.ReadLine()?.Trim();
                if (!string.IsNullOrWhiteSpace(path) && File.Exists(path)) return path;
            }
        }
        catch { }
        return null;
    }

    private static string Secret()
        => Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));

    private static string SafeSegment(string value)
        => string.Concat(value.Select(c => char.IsLetterOrDigit(c) || c is '.' or '-' or '_' ? c : '_'));
}

internal static class RuntimeMaterializer
{
    /// <summary>
    /// A package version is immutable. Once a runtime file exists in its version directory,
    /// leave it alone. In particular, Windows cannot overwrite the node.exe that Doctor is
    /// currently executing during a settings reconcile or an explicit restart.
    /// </summary>
    internal static void CopyVersionFile(string source, string destination)
    {
        if (File.Exists(destination)) return;

        Directory.CreateDirectory(Path.GetDirectoryName(destination)
            ?? throw new ArgumentException("Destination must include a directory", nameof(destination)));
        var temporary = $"{destination}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.Copy(source, temporary, overwrite: false);
            try
            {
                File.Move(temporary, destination, overwrite: false);
            }
            catch (IOException) when (File.Exists(destination))
            {
                // Another reconcile completed the same immutable materialization first.
            }
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }
}
