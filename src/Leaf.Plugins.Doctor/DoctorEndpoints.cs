using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;
using System.Net;
using System.Text.Json;

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
        })).WithSummary("Returns the Doctor extension id and links to its settings and status routes.");

        group.MapGet("/discover", () => Results.Ok(new
        {
            id = DoctorPlugin.PluginId,
            role = "system-companion",
            settings = "/api/extensions/doctor/settings",
            actions = new[] { "restart-runtime", "rotate-access-token" },
        })).WithSummary("Returns the Doctor extension role, its settings link and the names of its recovery actions.");

        group.MapGet("/status", async (DoctorRuntimeService runtime, CancellationToken ct) =>
            Results.Ok(await runtime.StatusAsync(ct)))
            .WithSummary("Returns the current status of the detached Doctor recovery companion.");

        group.MapPost("/execution-token", IssueExecutionTokenAsync)
            .WithSummary("Issues a 10 minute execution token for a Doctor coding agent session. Loopback callers only, needs the X-Doctor-Control header and a JSON body with sessionId (a UUID) and provider (claude or codex); any other caller or a wrong control key gets 404, and a missing or invalid body field gets 400.");
    }

    // The body is read by hand, after the loopback and control key checks, so a caller
    // that fails them gets the same 404 whatever it sent.
    internal static async Task<IResult> IssueExecutionTokenAsync(
        HttpContext context,
        DoctorRuntimeService runtime,
        CancellationToken ct)
    {
        if (context.Connection.RemoteIpAddress is not { } remote
            || !IPAddress.IsLoopback(remote))
            return Results.NotFound();

        DoctorExecutionTokenRequest? request = null;
        try
        {
            request = await context.Request.ReadFromJsonAsync<DoctorExecutionTokenRequest>(ct);
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException)
        {
            // Unreadable body: validated below as missing fields, after the control key check.
        }

        var controlKey = context.Request.Headers["X-Doctor-Control"].ToString();
        try
        {
            var issued = await runtime.IssueExecutionTokenAsync(
                controlKey, request?.SessionId!, request?.Provider!, ct);
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
        catch (ArgumentException ex)
        {
            return Results.BadRequest(new { error = ex.Message });
        }
    }
}

internal sealed record DoctorExecutionTokenRequest(string SessionId, string Provider);
