[CmdletBinding()]
param([ValidateSet('development','packaged')][string]$Mode,
    [ValidateSet('scaffold','telemetry','overlay')][string]$Scenario = 'scaffold',
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'))
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$output = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ($Mode + '-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
$paths = @{}
foreach ($name in @('cwd','temp','appdata','localappdata','profile','diagnostics')) {
    $paths[$name] = Join-Path $output $name
    New-Item -ItemType Directory -Path $paths[$name] | Out-Null
}
$config = $paths.Clone()
$config.mode = $Mode; $config.output = $output; $config.checkout = $checkout
$config.scenario = $Scenario
$config.commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
$config.executable = Join-Path $checkout 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe'
if ($Mode -eq 'packaged' -and !(Test-Path -LiteralPath $config.executable -PathType Leaf)) { throw 'Forge package missing.' }
$configFile = Join-Path $output 'config.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
. (Join-Path $PSScriptRoot 'RuntimeReceipt.ps1')
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
$started = [datetime]::UtcNow
$code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node,
    [string[]]@((Join-Path $PSScriptRoot 'runtime-smoke.mjs'), $configFile),
    $checkout, (Join-Path $output 'job'), 60000)
@{mode=$Mode; scenario=$Scenario; commit=$config.commit; exitCode=$code; retries=0;
  durationSeconds=([datetime]::UtcNow-$started).TotalSeconds;
  limits='60 s; 16 processes; 2 GiB; 25% CPU; kill-on-close';
  descendantsNaturallyDrained=($code -eq 0)} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'job-result.json') -Encoding utf8
$validation = Test-RuntimeReceipt -DriverResultPath (Join-Path $output 'result.json') -ExpectedCommit $config.commit -ExpectedMode $Mode -ExpectedScenario $Scenario -JobExitCode $code
$ownedPidPath = Join-Path $output 'job/owned-pid.txt'
$ownedPid = if (Test-Path -LiteralPath $ownedPidPath -PathType Leaf) { (Get-Content -LiteralPath $ownedPidPath -Raw).Trim() } else { $null }
$receipt = [ordered]@{passed=$validation.passed; scenario=$Scenario;
    mode=$Mode; commit=$config.commit; validation=$validation; actualJobExitCode=$code;
    expected=@{jobExitCode=0; driverPassed=$true; status='ready; isolated storage verified; orderly exit'};
    driverResultPath=(Join-Path $output 'result.json'); stdoutPath=(Join-Path $output 'job/stdout.log');
    stderrPath=(Join-Path $output 'job/stderr.log'); ownedPidPath=$ownedPidPath; ownedPid=$ownedPid;
    observedNodeVersion=(& $node --version); actualElectronRuntimeVersion=$null;
    playwrightMetadataVersion=(Get-Content -LiteralPath (Join-Path $checkout 'node_modules/playwright-core/package.json') -Raw | ConvertFrom-Json).version;
    finishedUtc=[datetime]::UtcNow.ToString('o')}
# Never overwrite the driver's receipt or invent observations when it died early.
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'wrapper-result.json') -Encoding utf8
Write-Output "Runtime evidence: $output"
if (!$validation.passed) { throw "Runtime smoke failed: $($validation.reason), Job exit $code; retained evidence: $output" }
