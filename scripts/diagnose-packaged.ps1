[CmdletBinding()]
param(
    # The package of the build that was made (scripts/build-channel.mjs --built, ET-055 PR-4) unless one is given.
    [string]$PackageDirectory,
    [ValidateRange(5, 60)][int]$TimeoutSeconds = 30,
    [string]$ExpectedAsarSha256,
    [string]$ExpectedPackageSha256,
    [switch]$Launch
)
$ErrorActionPreference = 'Stop'
$builtText = & (Get-Command node -ErrorAction Stop).Source (Join-Path $PSScriptRoot 'build-channel.mjs') --built
if ($LASTEXITCODE -ne 0) { throw 'Build evidence unavailable: run npm run package first.' }
$built = ($builtText -join "`n") | ConvertFrom-Json
# A local, not the [string] parameter itself (tests/windows/Test-HarnessVariables.ps1).
$packageSource = if ($PackageDirectory) { $PackageDirectory } else { Join-Path $PSScriptRoot ('../' + $built.packageDirectory) }
$package = (Resolve-Path -LiteralPath $packageSource).Path
$executable = Join-Path $package $built.executable
$archive = Join-Path $package 'resources/app.asar'
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash
if (!(Test-Path -LiteralPath $executable -PathType Leaf)) { throw 'Packaged executable is missing.' }
. (Join-Path $PSScriptRoot 'verify-package.ps1')
$integrity = Test-PackageIntegrity -PackageDirectory $package
$plan = [ordered]@{ executable=$executable; asarSha256=$hash; packageSha256=$integrity.packageSha256; unpackedFilesVerified=$integrity.unpackedFilesVerified; packageFilesVerified=$integrity.packageFilesVerified; timeoutSeconds=$TimeoutSeconds; launch=[bool]$Launch; limits='16 processes; 2 GiB job memory; 25% system CPU; kill on watchdog exit' }
if (!$Launch) { $plan | ConvertTo-Json; return }
if (!$ExpectedAsarSha256 -or $ExpectedAsarSha256 -ne $hash) { throw 'Launch requires the reviewed package ASAR SHA256. Run without -Launch to inspect it.' }
if (!$ExpectedPackageSha256 -or $ExpectedPackageSha256 -ne $integrity.packageSha256) { throw 'Launch requires the reviewed full package SHA256, including all executable and unpacked bytes.' }
if (Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($built.executable)) -ErrorAction SilentlyContinue) { throw 'A desktop instance already exists. No launch performed.' }
Add-Type -Path (Join-Path $PSScriptRoot 'watchdog/BoundedProcess.cs')
$runDirectory = Join-Path $PSScriptRoot ('../.local/diagnostics/watchdog-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$runDirectory = (Resolve-Path -LiteralPath $runDirectory).Path
$plan.startedUtc = [datetime]::UtcNow.ToString('o')
$plan | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'launch.json') -Encoding utf8
$isolated = @{
    TEMP = (Join-Path $runDirectory 'temp'); TMP = (Join-Path $runDirectory 'temp')
    APPDATA = (Join-Path $runDirectory 'roaming'); LOCALAPPDATA = (Join-Path $runDirectory 'local')
    ETS2TELEMETRY_PROFILE_DIR = (Join-Path $runDirectory 'profile')
    ETS2TELEMETRY_DIAGNOSTIC_DIR = (Join-Path $runDirectory 'application')
}
$previous = @{}
try {
    foreach ($key in $isolated.Keys) {
        $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
        New-Item -ItemType Directory -Path $isolated[$key] -Force | Out-Null
        [Environment]::SetEnvironmentVariable($key, $isolated[$key], 'Process')
    }
    # Launch directly within this separate PowerShell watchdog process, never through a shell command string.
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($executable, [string[]]@('--enable-logging=stderr'), $runDirectory, $runDirectory, $TimeoutSeconds * 1000)
    @{exitCode=$code; finishedUtc=[datetime]::UtcNow.ToString('o')} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runDirectory 'result.json') -Encoding utf8
    Write-Output "Diagnostics: $runDirectory"
    exit $code
} finally {
    foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
}
