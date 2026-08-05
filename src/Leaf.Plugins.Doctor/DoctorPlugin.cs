using System.Reflection;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Leaf.Plugins.Doctor;

public sealed class DoctorPlugin : ILeafPlugin
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
        services.AddSingleton(sp => new DoctorRuntimeService(
            ctx.PluginDirectory,
            ctx.Manifest.Version ?? "workspace",
            sp.GetRequiredKeyedService<IEntityStore>(PluginId),
            sp.GetRequiredService<ILoggerFactory>().CreateLogger("Leaf.Plugins.Doctor.Runtime")));
        services.AddSingleton<DoctorSettingsProvider>();
        services.AddSingleton<IPluginSettingsProvider>(sp =>
            sp.GetRequiredService<DoctorSettingsProvider>());
    }

    public void MapEndpoints(RouteGroupBuilder group) => DoctorEndpoints.Map(group);

    public async Task OnStartupAsync(IPluginHost host, CancellationToken ct)
    {
        var runtime = host.GetRequiredService<DoctorRuntimeService>();
        await runtime.EnsureDefaultsAsync(ct);
        await runtime.EnsureRunningAsync(ct);
    }
}
