namespace Leaf.Plugins.Doctor.Tests;

using Xunit;

public sealed class RuntimeMaterializerTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(), $"leaf-doctor-materializer-{Guid.NewGuid():N}");

    [Fact]
    public void ExistingVersionFileIsNotOverwrittenWhileInUse()
    {
        Directory.CreateDirectory(_root);
        var source = Path.Combine(_root, "source.exe");
        var destination = Path.Combine(_root, "version", "node.exe");
        File.WriteAllText(source, "new package bytes");
        Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
        File.WriteAllText(destination, "running version bytes");

        using var runningExecutable = new FileStream(
            destination, FileMode.Open, FileAccess.Read, FileShare.Read);

        RuntimeMaterializer.CopyVersionFile(source, destination);

        runningExecutable.Position = 0;
        using var reader = new StreamReader(runningExecutable, leaveOpen: true);
        Assert.Equal("running version bytes", reader.ReadToEnd());
    }

    [Fact]
    public void MissingVersionFileIsMaterialized()
    {
        Directory.CreateDirectory(_root);
        var source = Path.Combine(_root, "source.js");
        var destination = Path.Combine(_root, "version", "leaf-doctor.js");
        File.WriteAllText(source, "runtime payload");

        RuntimeMaterializer.CopyVersionFile(source, destination);

        Assert.Equal("runtime payload", File.ReadAllText(destination));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(destination)!, "*.tmp"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
