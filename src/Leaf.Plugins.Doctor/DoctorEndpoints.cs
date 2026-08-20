using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using System.Net;

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

        group.MapPost("/execution-token", async (
            HttpContext context,
            DoctorExecutionTokenRequest request,
            DoctorRuntimeService runtime,
            CancellationToken ct) =>
        {
            if (context.Connection.RemoteIpAddress is not { } remote
                || !IPAddress.IsLoopback(remote))
                return Results.NotFound();

            var controlKey = context.Request.Headers["X-Doctor-Control"].ToString();
            try
            {
                var issued = await runtime.IssueExecutionTokenAsync(
                    controlKey, request.SessionId, request.Provider, ct);
                return Results.Ok(new
                {
                    accessToken = issued.AccessToken,
                    expiresAt = issued.ExpiresAt,
                    executionId = issued.ExecutionId,
                });
            }
            catch (UnauthorizedAccessException)
            {
                return Results.NotFound();
            }
        });

    }
}

internal sealed record DoctorExecutionTokenRequest(string SessionId, string Provider);
