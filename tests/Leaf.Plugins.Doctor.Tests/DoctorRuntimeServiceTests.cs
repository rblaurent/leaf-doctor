namespace Leaf.Plugins.Doctor.Tests;

using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Leaf.Sdk;
using Leaf.Sdk.Services;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

public sealed class DoctorRuntimeServiceTests
{
    [Fact]
    public void StandaloneApiChecksUsePublicRecoveryContracts()
    {
        var services = DoctorRuntimeService.DefaultServices();
        var checks = services["api"]?["checks"]?.AsArray()
            ?? throw new InvalidOperationException("Doctor API checks are missing");

        Assert.Contains(checks, check =>
            check?["name"]?.GetValue<string>() == "Discovery API"
            && check["path"]?.GetValue<string>() == "/discover");
        Assert.DoesNotContain(checks, check =>
            check?["path"]?.GetValue<string>() == "/ai-session/quality-modes");
    }

    [Fact]
    public async Task ExecutionTokenRequiresControlKeyAndCarriesExactSessionContext()
    {
        var controlKey = "control-key".PadRight(64, 'x');
        var tokens = new CapturingExecutionTokens();
        var runtime = CreateRuntime(controlKey, tokens);
        var sessionId = Guid.NewGuid().ToString();

        await Assert.ThrowsAsync<UnauthorizedAccessException>(() =>
            runtime.IssueExecutionTokenAsync("wrong", sessionId, "codex"));

        var issued = await runtime.IssueExecutionTokenAsync(controlKey, sessionId, "codex");
        Assert.Equal("signed-test-token", issued.AccessToken);
        Assert.NotNull(tokens.Request);
        Assert.Equal("doctor-codex", tokens.Request!.ActorId);
        var context = Assert.Single(tokens.Request.Context);
        Assert.Equal("doctor-session", context.Kind);
        Assert.Equal(sessionId, context.Id);
        Assert.Equal(TimeSpan.FromMinutes(10), tokens.Request.Lifetime);
    }

    private static DoctorRuntimeService CreateRuntime(string controlKey, IExecutionTokens tokens)
    {
        var entity = new LeafEntity(
            Guid.NewGuid(),
            DoctorData.ConfigType,
            DoctorData.ConfigSlug,
            "Doctor Config",
            new JsonObject
            {
                ["control_key"] = controlKey,
                ["access_token"] = "access-token".PadRight(64, 'x'),
            },
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow,
            "plugin:doctor");
        var store = new StaticEntityStore(entity);
        return new DoctorRuntimeService(
            AppContext.BaseDirectory,
            "test",
            store,
            tokens,
            NullLogger.Instance);
    }

    private static async Task<int> PostExecutionTokenAsync(
        DoctorRuntimeService runtime, string? remoteIp, string? controlKey, string? body)
    {
        var context = new DefaultHttpContext { RequestServices = new ServiceCollection().AddLogging().BuildServiceProvider() };
        context.Connection.RemoteIpAddress = remoteIp is null ? null : IPAddress.Parse(remoteIp);
        if (controlKey is not null) context.Request.Headers["X-Doctor-Control"] = controlKey;
        if (body is not null)
        {
            context.Request.ContentType = "application/json";
            context.Request.Body = new MemoryStream(Encoding.UTF8.GetBytes(body));
        }
        context.Response.Body = new MemoryStream();
        var result = await DoctorEndpoints.IssueExecutionTokenAsync(context, runtime, CancellationToken.None);
        await result.ExecuteAsync(context);
        return context.Response.StatusCode;
    }

    [Theory]
    [InlineData("{\"sessionId\":\"not-a-uuid\",\"provider\":\"codex\"}")]
    [InlineData("{\"sessionId\":\"00000000-0000-0000-0000-000000000001\",\"provider\":\"other\"}")]
    [InlineData("{\"provider\":\"codex\"}")]
    [InlineData("{\"sessionId\":\"00000000-0000-0000-0000-000000000001\"}")]
    [InlineData("null")]
    [InlineData("")]
    [InlineData("{not json")]
    public async Task ExecutionTokenRouteRejectsInvalidBodiesWith400(string body)
    {
        var controlKey = "control-key".PadRight(64, 'x');
        var runtime = CreateRuntime(controlKey, new CapturingExecutionTokens());

        Assert.Equal(400, await PostExecutionTokenAsync(runtime, "127.0.0.1", controlKey, body));
    }

    [Theory]
    [InlineData("203.0.113.5", "control", "{\"sessionId\":\"not-a-uuid\"}")]
    [InlineData("127.0.0.1", "wrong", "{\"sessionId\":\"not-a-uuid\"}")]
    [InlineData("127.0.0.1", "wrong", "{not json")]
    [InlineData("127.0.0.1", null, null)]
    public async Task ExecutionTokenRouteHidesValidationFromUntrustedCallers(
        string remoteIp, string? keyKind, string? body)
    {
        var controlKey = "control-key".PadRight(64, 'x');
        var runtime = CreateRuntime(controlKey, new CapturingExecutionTokens());
        var key = keyKind == "control" ? controlKey : keyKind;

        Assert.Equal(404, await PostExecutionTokenAsync(runtime, remoteIp, key, body));
    }

    [Fact]
    public async Task ExecutionTokenRouteIssuesTokenForValidLoopbackRequest()
    {
        var controlKey = "control-key".PadRight(64, 'x');
        var runtime = CreateRuntime(controlKey, new CapturingExecutionTokens());
        var body = $"{{\"sessionId\":\"{Guid.NewGuid()}\",\"provider\":\"claude\"}}";

        Assert.Equal(200, await PostExecutionTokenAsync(runtime, "127.0.0.1", controlKey, body));
    }

    private sealed class CapturingExecutionTokens : IExecutionTokens
    {
        public PluginSystemExecutionTokenRequest? Request { get; private set; }

        public PluginExecutionToken IssueSystem(PluginSystemExecutionTokenRequest request)
        {
            Request = request;
            return new PluginExecutionToken(
                "signed-test-token",
                DateTimeOffset.UtcNow.AddMinutes(10),
                Guid.NewGuid().ToString());
        }
    }

    private sealed class StaticEntityStore(LeafEntity entity) : IEntityStore
    {
        public Task<LeafEntity?> GetAsync(Guid id, CancellationToken ct = default)
            => Task.FromResult<LeafEntity?>(id == entity.Id ? entity : null);

        public Task<LeafEntity?> GetBySlugAsync(string slug, CancellationToken ct = default)
            => Task.FromResult<LeafEntity?>(slug == entity.Slug ? entity : null);

        public Task<IReadOnlyList<LeafEntity>> QueryAsync(EntityQuery query, CancellationToken ct = default)
            => Task.FromResult<IReadOnlyList<LeafEntity>>([entity]);

        public Task<LeafEntity> CreateAsync(string typeSlug, string name, JsonObject? data = null, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<LeafEntity> UpsertBySlugAsync(string typeSlug, string slug, string name, JsonObject? data = null, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<LeafEntity> PatchAsync(Guid id, JsonObject dataPatch, string? name = null, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task<LeafEntity> ReplaceDataAsync(Guid id, JsonObject data, string? name = null, CancellationToken ct = default)
            => throw new NotSupportedException();

        public Task DeleteAsync(Guid id, CancellationToken ct = default)
            => throw new NotSupportedException();
    }
}
