using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace Leaf.Plugins.Doctor;

internal static class DoctorEndpoints
{
    public static void Map(RouteGroupBuilder group)
    {
        group.MapGet("/", () => Results.Ok(new
        {
            id = DoctorPlugin.PluginId,
            service = "Leaf Doctor extension",
            settings = "/api/extensions/doctor/settings",
            status = "/api/extensions/doctor/status",
        }));

        group.MapGet("/discover", () => Results.Ok(new
        {
            id = DoctorPlugin.PluginId,
            role = "system-companion",
            settings = "/api/extensions/doctor/settings",
            actions = new[] { "restart-runtime", "rotate-access-token" },
        }));

        group.MapGet("/status", async (DoctorRuntimeService runtime, CancellationToken ct) =>
            Results.Ok(await runtime.StatusAsync(ct)));

    }
}
