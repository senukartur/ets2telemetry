# Guest-only launcher. The coordinator must arm the outer VM watchdog before boot.
[CmdletBinding()]
param(
    [switch]$Run,
    [string]$ExpectedManifestSha256,
    [string]$ExpectedPackageSha256,
    [string]$ExpectedAsarSha256,
    [string]$OuterDeadlineUtc
)
$ErrorActionPreference = 'Stop'
$kit = 'C:\ETS2ET001Acceptance'
if (!$Run) {
    [ordered]@{run=$false;applicationLaunched=$false;guestRoot=$kit;innerTimeoutSeconds=60;launches=2;action='Guest only: supply reviewed manifest/package/ASAR SHA256 and the already armed outer deadline with -Run.'} | ConvertTo-Json
    return
}
# Refuse physical-host use before creating any directories or loading test code.
$identity = Get-CimInstance Win32_ComputerSystemProduct
$computer = Get-CimInstance Win32_ComputerSystem
if ($identity.UUID -ne '94674D56-D803-F4D5-9AAC-C4E91CFB475F' -or $computer.Manufacturer -notmatch '^VMware' -or $computer.Model -notmatch 'VMware') { throw 'Wrong machine; this launch is restricted to the disposable VMware guest.' }
if ((Get-Content -LiteralPath 'C:\ETS2VMwareLab\guest-marker.txt' -Raw).Trim() -ne '9a047927-f94b-41cb-bda8-abcc7d0b76f1') { throw 'Wrong baseline guest marker.' }
if ([IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\') -ne $kit) { throw 'Harness must be transferred to the distinct acceptance kit root.' }
$runDirectory = Join-Path $kit ('evidence/' + [guid]::NewGuid().ToString('N'))
$report = [ordered]@{schemaVersion=1;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;passed=$false;applicationLaunchAttempted=$false;jobExitCode=$null;failure=$null;vmUuid=$identity.UUID;labId='9a047927-f94b-41cb-bda8-abcc7d0b76f1';runDirectory=$runDirectory;outerDeadlineUtc=$OuterDeadlineUtc;manifestSha256=$ExpectedManifestSha256;packageSha256=$ExpectedPackageSha256;asarSha256=$ExpectedAsarSha256;limits=@{timeoutSeconds=60;processes=16;jobCommittedMemoryBytes=2147483648;systemCpuPercent=25;outputBytesPerStream=1048576};driver=$null}
$savedEnvironment = @{}
try {
    foreach ($hash in @($ExpectedManifestSha256, $ExpectedPackageSha256, $ExpectedAsarSha256)) { if ($hash -notmatch '^[0-9a-fA-F]{64}$') { throw 'Explicit reviewed SHA256 values are required.' } }
    if (!$OuterDeadlineUtc -or ([datetime]$OuterDeadlineUtc).ToUniversalTime().Subtract([datetime]::UtcNow).TotalSeconds -lt 100) { throw 'At least 100 seconds must remain on the already armed outer VM deadline.' }
    $manifestPath = Join-Path $kit 'kit-manifest.json'
    if ((Get-FileHash -LiteralPath $manifestPath).Hash -ne $ExpectedManifestSha256) { throw 'Transferred manifest hash mismatch.' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($manifest.schemaVersion -ne 1 -or $manifest.guestRoot -ne $kit -or $manifest.guestUuid -ne $identity.UUID -or $manifest.labId -ne $report.labId -or $manifest.packageSha256 -ne $ExpectedPackageSha256 -or $manifest.asarSha256 -ne $ExpectedAsarSha256 -or $manifest.nodeVersion -ne '24.19.0' -or $manifest.playwrightCoreVersion -ne '1.64.0') { throw 'Unexpected kit identity or pinned versions.' }
    $expected = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $manifest.files) {
        if (!$file.path -or $file.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or !$expected.Add($file.path)) { throw 'Invalid or duplicate kit manifest path.' }
        $filename = Join-Path $kit $file.path
        $item = Get-Item -LiteralPath $filename
        if ($item.PSIsContainer -or $item.Length -ne $file.bytes -or (Get-FileHash -LiteralPath $filename).Hash -ne $file.sha256) { throw ('Kit file integrity mismatch: ' + $file.path) }
    }
    foreach ($item in Get-ChildItem -LiteralPath $kit -Recurse -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Kit reparse points are prohibited.' }
        if (!$item.PSIsContainer) {
            $relative = $item.FullName.Substring($kit.Length + 1).Replace('\', '/')
            if ($relative -ne 'kit-manifest.json' -and !$relative.StartsWith('evidence/', [StringComparison]::Ordinal) -and !$expected.Contains($relative)) { throw ('Unexpected kit file: ' + $relative) }
        }
    }
    # These functions are loaded only after every transferred source byte is verified.
    . (Join-Path $kit 'tools/verify-package.ps1')
    $package = Join-Path $kit 'package'
    $integrity = Test-PackageIntegrity -PackageDirectory $package
    if ($integrity.packageSha256 -ne $ExpectedPackageSha256 -or (Get-FileHash -LiteralPath (Join-Path $package 'resources/app.asar')).Hash -ne $ExpectedAsarSha256 -or (Get-FileHash -LiteralPath (Join-Path $package 'ETS2TelemetryDesktop.exe')).Hash -ne $manifest.executableSha256) { throw 'Guest package differs from the reviewed artifact.' }
    if (Get-Process -Name ETS2TelemetryDesktop -ErrorAction SilentlyContinue) { throw 'Existing guest application instance; no launch attempted.' }
    New-Item -ItemType Directory -Path $runDirectory | Out-Null
    $guard = [ordered]@{verifiedUtc=[datetime]::UtcNow.ToString('o');vmUuid=$identity.UUID;manufacturer=$computer.Manufacturer;model=$computer.Model;labId=$report.labId;kit=$kit;manifestSha256=$ExpectedManifestSha256;packageSha256=$integrity.packageSha256;asarSha256=$ExpectedAsarSha256;filesVerified=$expected.Count;outerDeadlineUtc=$OuterDeadlineUtc;jobRequired=$true}
    $guardPath = Join-Path $runDirectory 'guest-guard.json'
    $guard | ConvertTo-Json | Set-Content -LiteralPath $guardPath -Encoding UTF8
    foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH', 'ETS2TELEMETRY_VM_JOB', 'NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH')) { $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    foreach ($name in @('APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) { $value=Join-Path $runDirectory $name;New-Item -ItemType Directory -Path $value | Out-Null;[Environment]::SetEnvironmentVariable($name, $value, 'Process') }
    $env:ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH='1';$env:ETS2TELEMETRY_VM_JOB='1'
    foreach ($name in @('NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'NODE_PATH')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    Add-Type -Path (Join-Path $kit 'tools/BoundedProcess.cs')
    $report.applicationLaunchAttempted=$true
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run((Join-Path $kit 'tools/node.exe'), @((Join-Path $kit 'harness/packaged-lifecycle.mjs'), $kit, $runDirectory, $guardPath), $runDirectory, (Join-Path $runDirectory 'job'), 60000)
    $report.jobExitCode=$code
    $driverPath = Join-Path $runDirectory 'driver-result.json'
    if (!(Test-Path -LiteralPath $driverPath)) { throw ('No driver result; Job exit ' + $code) }
    $report.driver = Get-Content -LiteralPath $driverPath -Raw | ConvertFrom-Json
    if ($code -ne 0 -or $report.driver.passed -ne $true -or @($report.driver.runs).Count -ne 2) { throw ('Packaged lifecycle failed; Job exit ' + $code) }
    $after = Test-PackageIntegrity -PackageDirectory $package
    if ($after.packageSha256 -ne $ExpectedPackageSha256) { throw 'Package changed during acceptance.' }
    $report.passed=$true
} catch { $report.failure=$_.Exception.ToString() }
finally {
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    $report.finishedUtc=[datetime]::UtcNow.ToString('o')
    if (!(Test-Path -LiteralPath $runDirectory)) { New-Item -ItemType Directory -Path $runDirectory | Out-Null }
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $runDirectory 'guest-result.json') -Encoding UTF8
    # Stable pointer for the coordinator's bounded guest export. Keep all failures and diagnostics.
    [ordered]@{runDirectory=$runDirectory;passed=$report.passed;finishedUtc=$report.finishedUtc} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $kit 'evidence/latest.json') -Encoding UTF8
    $report | ConvertTo-Json -Depth 12
}
if (!$report.passed) { exit 1 }
