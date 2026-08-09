<# Canonical RedLeaf producer for Doctor's protected extension plus detached runtime. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PluginDir,
    [Parameter(Mandatory = $true)][string]$Metadata,
    [Parameter(Mandatory = $true)][string]$OutputDir,
    [Parameter(Mandatory = $true)][string]$RedLeafToolDll,
    [Parameter(Mandatory = $true)][string]$LeafSdkProject,
    [Parameter(Mandatory = $true)][string]$RedBambooLock,
    [Parameter(Mandatory = $true)][string]$NodeExecutable,
    [Parameter(Mandatory = $true)][string]$CentralReleaseTag
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Fail([string]$Message) { throw $Message }
function Resolve-File([string]$Path, [string]$Label) {
    try {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) { Fail "$Label must be a file." }
        return $resolved
    } catch { Fail "$Label does not exist: $Path" }
}
function Resolve-Directory([string]$Path, [string]$Label) {
    try {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
        if (-not (Test-Path -LiteralPath $resolved -PathType Container)) { Fail "$Label must be a directory." }
        return $resolved
    } catch { Fail "$Label does not exist: $Path" }
}
function Invoke-Checked([string]$Label, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { Fail "$Label failed with exit code $LASTEXITCODE." }
}
function Copy-SafeFile([string]$Source, [string]$Destination, [string]$Label) {
    $item = Get-Item -LiteralPath $Source -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label must not be a link or reparse point." }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Destination)) | Out-Null
    Copy-Item -LiteralPath $item.FullName -Destination $Destination
}
function Copy-SafeTree([string]$Source, [string]$Destination, [string]$Label) {
    $root = Resolve-Directory $Source $Label
    foreach ($item in Get-ChildItem -LiteralPath $root -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { Fail "$Label contains a link or reparse point: $($item.FullName)" }
        $relative = $item.FullName.Substring($root.TrimEnd('\', '/').Length + 1)
        $target = Join-Path $Destination $relative
        if ($item.PSIsContainer) { [IO.Directory]::CreateDirectory($target) | Out-Null }
        else { Copy-SafeFile $item.FullName $target $Label }
    }
}
function Resolve-CentralReleaseUrl([string]$Tag, [string]$Version) {
    if ($Tag -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { Fail 'CentralReleaseTag must be a safe GitHub release-tag segment.' }
    if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]{0,127}$') { Fail 'Doctor version must be a safe package-name segment.' }
    return "https://github.com/RedBamboo-Interactive/redleaf/releases/download/$Tag/doctor-$Version.leafpkg"
}

$pluginRoot = Resolve-Directory $PluginDir 'PluginDir'
$metadataPath = Resolve-File $Metadata 'Metadata'
$tool = Resolve-File $RedLeafToolDll 'RedLeafToolDll'
$leafSdk = Resolve-File $LeafSdkProject 'LeafSdkProject'
$sharedLock = Resolve-File $RedBambooLock 'RedBambooLock'
$node = Resolve-File $NodeExecutable 'NodeExecutable'
$manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'plugin.json') -Raw | ConvertFrom-Json
$metadataObject = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
$producerInput = Get-Content -LiteralPath (Join-Path $pluginRoot 'release\producer-input.v1.json') -Raw | ConvertFrom-Json
$runtimeLock = Get-Content -LiteralPath (Join-Path $pluginRoot $producerInput.runtime.lockPath) -Raw | ConvertFrom-Json

if ([string]$metadataObject.metadataType -cne 'redleaf-extension-release-metadata' -or [int]$metadataObject.schemaVersion -ne 1) { Fail 'Metadata contract is invalid.' }
if ([string]$manifest.id -cne 'doctor' -or [string]$metadataObject.classification -cne 'protected') { Fail 'Doctor identity/classification is invalid.' }
$artifactUrl = Resolve-CentralReleaseUrl $CentralReleaseTag ([string]$manifest.version)
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$runtimeLock.node.executable.sha256) { Fail 'Bundled node.exe does not match the committed runtime lock.' }
$nodeVersion = (& $node --version).Trim().TrimStart('v')
if ($nodeVersion -cne [string]$runtimeLock.node.version) { Fail 'Bundled node.exe version does not match the committed runtime lock.' }

$outputRoot = [IO.Path]::GetFullPath($OutputDir)
[IO.Directory]::CreateDirectory($outputRoot) | Out-Null
$artifact = Join-Path $outputRoot "$($manifest.id)-$($manifest.version).leafpkg"
$descriptor = Join-Path $outputRoot "$($manifest.id)-$($manifest.version).component-input.v1.json"
$candidate = Join-Path $outputRoot "$($manifest.id)-candidate.unsigned.json"
$signatureInput = Join-Path $outputRoot "$($manifest.id)-signature-input.json"
foreach ($path in @($artifact, $descriptor, $candidate, $signatureInput)) {
    if (Test-Path -LiteralPath $path) { Fail "Immutable output already exists: $path" }
}

$scratchBase = Join-Path ([IO.Path]::GetTempPath()) 'RedLeaf\doctor-release'
[IO.Directory]::CreateDirectory($scratchBase) | Out-Null
$staging = Join-Path $scratchBase ([Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($staging) | Out-Null

try {
    Invoke-Checked 'canonical manifest staging' {
        dotnet $tool extension stage-manifest --source (Join-Path $pluginRoot 'plugin.json') --metadata $metadataPath --output (Join-Path $staging 'plugin.json')
    }

    $backend = Join-Path $pluginRoot $producerInput.build.backendProject
    $backendOutput = Join-Path $staging 'backend'
    Invoke-Checked 'locked backend restore' {
        dotnet restore $backend --locked-mode --nologo -p:LeafSdkProject=$leafSdk -p:ContinuousIntegrationBuild=true -p:Deterministic=true
    }
    Invoke-Checked 'deterministic backend publish' {
        dotnet publish $backend --configuration Release --no-restore --output $backendOutput --nologo -p:LeafSdkProject=$leafSdk -p:ContinuousIntegrationBuild=true -p:Deterministic=true
    }
    Invoke-Checked 'canonical kernel assembly filter' {
        dotnet $tool extension filter-backend --directory $backendOutput
    }

    $frontend = Join-Path $pluginRoot $producerInput.build.frontendDirectory
    Invoke-Checked 'frozen frontend restore' { corepack pnpm --dir $frontend install --frozen-lockfile }
    Invoke-Checked 'deterministic frontend build' { corepack pnpm --dir $frontend run build:pkg }
    $frontendDist = Join-Path $frontend 'dist'
    if (-not (Test-Path -LiteralPath (Join-Path $frontendDist 'plugin.js') -PathType Leaf)) { Fail 'Frontend build lacks dist/plugin.js.' }
    Copy-SafeTree $frontendDist (Join-Path $staging 'web\dist') 'frontend dist'
    Copy-SafeTree (Join-Path $pluginRoot 'seeds') (Join-Path $staging 'seeds') 'seeds'

    $runtimeTarget = Join-Path $staging 'payload\doctor'
    foreach ($entry in @($producerInput.runtime.payload)) {
        Copy-SafeFile (Join-Path $pluginRoot ([string]$entry.source)) (Join-Path $runtimeTarget ([string]$entry.target)) "runtime payload '$($entry.source)'"
    }
    Copy-SafeFile $node (Join-Path $runtimeTarget 'node.exe') 'bundled node.exe'

    $lockPaths = @{
        'backend-nuget-lock' = Join-Path $pluginRoot 'src\Leaf.Plugins.Doctor\packages.lock.json'
        'redbamboo-pnpm-lock' = $sharedLock
        'tests-nuget-lock' = Join-Path $pluginRoot 'tests\Leaf.Plugins.Doctor.Tests\packages.lock.json'
        'web-pnpm-lock' = Join-Path $pluginRoot 'web\pnpm-lock.yaml'
    }
    $arguments = @($tool, 'extension', 'produce', '--source', $staging, '--metadata', $metadataPath, '--artifact', $artifact, '--descriptor', $descriptor)
    foreach ($id in $lockPaths.Keys | Sort-Object) { $arguments += @('--lock', "$id=$($lockPaths[$id])") }
    Invoke-Checked 'canonical deterministic package production' { dotnet @arguments }
    Invoke-Checked 'canonical channel-neutral candidate ingestion' {
        dotnet $tool candidate ingest-extension --descriptor $descriptor --artifact $artifact --artifact-url $artifactUrl --output $candidate --signature-input $signatureInput
    }
} finally {
    $base = [IO.Path]::GetFullPath($scratchBase).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $target = [IO.Path]::GetFullPath($staging)
    if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { Fail 'Refusing to clean outside the Doctor release scratch boundary.' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
