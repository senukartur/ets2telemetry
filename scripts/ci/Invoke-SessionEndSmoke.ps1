param(
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$PackageDirectory,
    [string]$ExpectedPackageSha256,
    [switch]$BaselineMissingAudit
)
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
if (!$PackageDirectory) { $PackageDirectory = Join-Path $checkout 'out/ETS2Telemetry Desktop-win32-x64' }
$PackageDirectory = (Resolve-Path -LiteralPath $PackageDirectory).Path
if (!$ExpectedPackageSha256 -or $ExpectedPackageSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'An expected frozen package SHA-256 is required.' }
$output = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('session-end-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
$config = @{ checkout = $checkout; output = $output; packageDirectory = $PackageDirectory; expectedPackageSha256 = $ExpectedPackageSha256;
    executable = (Join-Path $PackageDirectory 'ETS2TelemetryDesktop.exe'); baselineMissingAudit = [bool]$BaselineMissingAudit }
foreach ($name in @('temp', 'appdata', 'localappdata', 'profile', 'diagnostics')) {
    $config[$name] = Join-Path $output $name
    New-Item -ItemType Directory -Path $config[$name] | Out-Null
}
$config.commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
$config.sender = Join-Path $output 'SessionEndSender.exe'
& 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe' /nologo /target:exe /platform:x64 /out:$($config.sender) (Join-Path $PSScriptRoot 'SessionEndSender.cs')
if ($LASTEXITCODE -ne 0) { throw 'Owned-window sender compilation failed.' }
$configFile = Join-Path $output 'config.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
$node = (Get-Command node -ErrorAction Stop).Source
$code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node, [string[]]@((Join-Path $PSScriptRoot 'session-end-smoke.mjs'), $configFile), $checkout, (Join-Path $output 'job'), 60000, $true)
$result = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
[ordered]@{ jobExitCode = $code; limits = '60 s; 16 processes; 2 GiB; 25% CPU; kill-on-close'; baseline = [bool]$BaselineMissingAudit;
    passed = $result.passed; reproducedLogLoss = $result.reproducedLogLoss } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'receipt.json') -Encoding utf8
Write-Output "Session-end evidence: $output"
if ($code -ne 0 -or (!$BaselineMissingAudit -and !$result.passed) -or ($BaselineMissingAudit -and !$result.reproducedLogLoss)) { throw 'Session-end native-message check failed; preserve its evidence.' }
