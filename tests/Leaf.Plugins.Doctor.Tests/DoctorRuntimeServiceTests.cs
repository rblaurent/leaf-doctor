namespace Leaf.Plugins.Doctor.Tests;

using System.Text.Json.Nodes;
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
}
