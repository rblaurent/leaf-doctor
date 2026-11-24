using System.Reflection;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Leaf.Plugins.Doctor;

public sealed class DoctorPlugin : ILeafPlugin, IDetachedChildHost
{
    public const string PluginId = "doctor";

    public PluginManifest Manifest { get; } = LoadManifest();

    private static PluginManifest LoadManifest()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("plugin.json")
            ?? throw new InvalidOperationException("Embedded plugin.json is missing");
        using var reader = new StreamReader(stream);
        return PluginManifest.Parse(reader.ReadToEnd());
    }

    public void ConfigureServices(IServiceCollection services, PluginContext ctx)
    {
        // Everything Doctor stores lives in the folder RedLeaf gives it; the folder Doctor used to pick moves in first.
        var storage = new DoctorStorage(ctx.DataDirectory);
        storage.MigrateLegacy();
        services.AddSingleton(storage);
        services.AddSingleton(sp => new DoctorRuntimeService(
            ctx.PluginDirectory,
            storage.DataDirectory,
            ctx.Manifest.Version ?? "workspace",
            sp.GetRequiredKeyedService<IEntityStore>(PluginId),
            sp.GetRequiredKeyedService<IExecutionTokens>(PluginId),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger("Leaf.Plugins.Doctor.Runtime")));
        services.AddSingleton<DoctorSettingsProvider>();
        services.AddSingleton<IPluginSettingsProvider>(sp =>
            sp.GetRequiredService<DoctorSettingsProvider>());
    }

    public void MapEndpoints(RouteGroupBuilder group) => DoctorEndpoints.Map(group);

    /// <summary>Doctor is a detached companion that runs from this plugin's data folder; a data move stops it and the next boot starts it again.</summary>
    public Task StopDetachedChildrenAsync(IPluginHost host, CancellationToken ct)
        => host.GetRequiredService<DoctorRuntimeService>().StopForRelocationAsync(ct);

    /// <summary>A data move that stopped Doctor but did not end in the kernel stopping: start it again from where the data folder still is.</summary>
    public Task StartDetachedChildrenAsync(IPluginHost host, CancellationToken ct)
        => host.GetRequiredService<DoctorRuntimeService>().EnsureRunningAsync(ct);

    public async Task OnStartupAsync(IPluginHost host, CancellationToken ct)
    {
        host.GetRequiredService<DoctorStorage>().LogMigration(host.GetRequiredService<ILoggerFactory>().CreateLogger("Leaf.Plugins.Doctor.Storage"));
        var runtime = host.GetRequiredService<DoctorRuntimeService>();
        await runtime.EnsureDefaultsAsync(ct);
        await runtime.EnsureRunningAsync(ct);
    }
}
