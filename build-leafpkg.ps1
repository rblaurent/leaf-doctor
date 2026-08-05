<#
.SYNOPSIS
  Build the Doctor extension and its self-contained detached runtime into a .leafpkg.
#>
[CmdletBinding()]
param(
    [string]$OutputDir,
    [string]$LeafSdkProject,
    [switch]$SkipFrontend,
    [switch]$SkipBundledNode
)

$ErrorActionPreference = "Stop"
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot "dist" }
$manifest = Get-Content (Join-Path $PSScriptRoot "plugin.json") -Raw | ConvertFrom-Json
$id = $manifest.id
$version = $manifest.version
if (-not $version) { throw "plugin.json must contain a version" }

New-Item -ItemType Directory -Force $OutputDir | Out-Null
$staging = Join-Path ([System.IO.Path]::GetTempPath()) "leafpkg-$id-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory $staging | Out-Null

try {
    $gitSha = "unknown"
    try { $gitSha = (git -C $PSScriptRoot rev-parse HEAD 2>$null).Trim() } catch {}
    $manifest | Add-Member -NotePropertyName build -NotePropertyValue ([PSCustomObject]@{
        commit = $gitSha
        date = [DateTime]::UtcNow.ToString("o")
    }) -Force
    [System.IO.File]::WriteAllText(
        (Join-Path $staging "plugin.json"),
        ($manifest | ConvertTo-Json -Depth 16),
        (New-Object System.Text.UTF8Encoding $false))

    $backendDir = Join-Path $staging "backend"
    $project = Join-Path $PSScriptRoot "src\Leaf.Plugins.Doctor\Leaf.Plugins.Doctor.csproj"
    $sdkArgs = @()
    if ($LeafSdkProject) { $sdkArgs = @("-p:LeafSdkProject=$LeafSdkProject") }
    dotnet publish $project -c Release -o $backendDir --nologo -v quiet @sdkArgs
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
    foreach ($name in @("Leaf.Sdk", "RedBamboo.AppHost")) {
        foreach ($extension in @(".dll", ".pdb", ".xml")) {
            $candidate = Join-Path $backendDir "$name$extension"
            if (Test-Path $candidate) { Remove-Item $candidate -Force }
        }
    }

    if (-not $SkipFrontend) {
        Push-Location (Join-Path $PSScriptRoot "web")
        try {
            pnpm run build:pkg
            if ($LASTEXITCODE -ne 0) { throw "frontend build failed" }
        }
        finally { Pop-Location }
    }
    $webDist = Join-Path $PSScriptRoot "web\dist"
    if (-not (Test-Path (Join-Path $webDist "plugin.js"))) {
        throw "web/dist/plugin.js is missing"
    }
    $targetWeb = Join-Path $staging "web\dist"
    New-Item -ItemType Directory -Force $targetWeb | Out-Null
    Copy-Item (Join-Path $webDist "*") $targetWeb -Recurse

    $targetSeeds = Join-Path $staging "seeds"
    New-Item -ItemType Directory $targetSeeds | Out-Null
    Copy-Item (Join-Path $PSScriptRoot "seeds\*.json") $targetSeeds

    $runtime = Join-Path $staging "payload\doctor"
    New-Item -ItemType Directory -Force $runtime | Out-Null
    foreach ($file in @("leaf-doctor.js", "dashboard.html", "doctor-prompt.md", "package.json")) {
        Copy-Item (Join-Path $PSScriptRoot $file) $runtime
    }
    if (-not $SkipBundledNode) {
        $node = Get-Command node.exe -ErrorAction Stop
        Copy-Item $node.Source (Join-Path $runtime "node.exe")
    }

    $pkgPath = Join-Path $OutputDir "$id-$version.leafpkg"
    $zipPath = Join-Path $OutputDir "$id-$version.zip"
    if (Test-Path $pkgPath) { Remove-Item $pkgPath -Force }
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    Compress-Archive -Path (Join-Path $staging "*") -DestinationPath $zipPath
    Move-Item $zipPath $pkgPath -Force

    $sha256 = (Get-FileHash $pkgPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [System.IO.File]::WriteAllText(
        "$pkgPath.sha256", $sha256 + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
    Write-Host $pkgPath -ForegroundColor Green
    Write-Host "sha256: $sha256" -ForegroundColor Green
}
finally {
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}
