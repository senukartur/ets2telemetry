[CmdletBinding()]
param([ValidateSet('development','packaged')][string]$Mode,
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','recording','journal','plugin')][string]$Scenario = 'scaffold',
    [switch]$ForceRendererReuse,
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
# The lifecycle, recording, journal and plugin restart runs reuse the profile and LOCALAPPDATA but write their own diagnostics.
if ($Scenario -eq 'lifecycle' -or $Scenario -eq 'recording' -or $Scenario -eq 'journal' -or $Scenario -eq 'plugin') {
    $paths.diagnosticsRestart = Join-Path $output 'diagnostics-restart'
    New-Item -ItemType Directory -Path $paths.diagnosticsRestart | Out-Null
}
$config = $paths.Clone()
$config.mode = $Mode; $config.output = $output; $config.checkout = $checkout
$config.scenario = $Scenario
if ($ForceRendererReuse -and $Scenario -ne 'overlay') { throw 'Renderer reuse control is restricted to the hidden overlay fixture.' }
$config.forceRendererProcessReuse = [bool]$ForceRendererReuse
$config.commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
$config.executable = Join-Path $checkout 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe'
if ($Mode -eq 'packaged' -and !(Test-Path -LiteralPath $config.executable -PathType Leaf)) { throw 'Forge package missing.' }
$configFile = Join-Path $output 'config.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
. (Join-Path $PSScriptRoot 'RuntimeReceipt.ps1')
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
# Every scenario runs in a 60 s Job. The plugin journey had 120 s until October 18, 2026; its hosted step took at most
# 14 s, so 60 s keeps more than four times that (docs/ci.md#et-017-plugin-smoke-scenario).
$started = [datetime]::UtcNow
$code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node,
    [string[]]@((Join-Path $PSScriptRoot 'runtime-smoke.mjs'), $configFile),
    $checkout, (Join-Path $output 'job'), 60000, $true)
$durationSeconds = ([datetime]::UtcNow-$started).TotalSeconds
# Diagnostic only: Job/system CPU use separates starvation under the cap from outside load or a block
# inside the application. A missing or malformed series is recorded and never changes the smoke result.
$cpu = [ordered]@{error='CPU_SERIES_UNAVAILABLE'}
$cpuSeries = Join-Path $output 'job/cpu.jsonl'
if (Test-Path -LiteralPath $cpuSeries -PathType Leaf) {
    try {
        $summary = & $node (Join-Path $PSScriptRoot 'job-cpu-summary.mjs') $cpuSeries 2>$null
        if ($LASTEXITCODE -eq 0) { $cpu = $summary | ConvertFrom-Json } else { $cpu.error = 'CPU_SERIES_INVALID' }
    } catch { $cpu.error = 'CPU_SERIES_INVALID' }
}
@{mode=$Mode; scenario=$Scenario; commit=$config.commit; exitCode=$code; retries=0;
  durationSeconds=$durationSeconds;
  limits='60 s; 16 processes; 2 GiB; 25% CPU; kill-on-close';
  descendantsNaturallyDrained=($code -eq 0); cpu=$cpu} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'job-result.json') -Encoding utf8
$validation = Test-RuntimeReceipt -DriverResultPath (Join-Path $output 'result.json') -ExpectedCommit $config.commit -ExpectedMode $Mode -ExpectedScenario $Scenario -JobExitCode $code
# ET-015a PR-4: recorded, never asserted. Live-only hellos the recording proxy refused while storage was still opening
# (the R10 window the journey does not exercise), holds that expired before admission and the slowest event-to-ACK time.
# Read only a receipt that Test-RuntimeReceipt accepted for reading (size bound, no reparse point, parsed); otherwise fail closed.
$recordingFacts = $null
if ($Scenario -eq 'recording' -and $validation.driverResultAvailable -ne $true) { $recordingFacts = [ordered]@{error='RECORDING_FACTS_UNAVAILABLE'} }
elseif ($Scenario -eq 'recording') {
    try {
        $driverResult = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $recordingFacts = [ordered]@{refusedLiveOnly=$driverResult.recording.refusedLiveOnly; expiredHolds=$driverResult.recording.expiredHolds;
            maxAckLatencyMs=$driverResult.recording.maxAckLatencyMs}
    } catch { $recordingFacts = [ordered]@{error='RECORDING_FACTS_UNAVAILABLE'} }
}
$ownedPidPath = Join-Path $output 'job/owned-pid.txt'
$ownedPid = if (Test-Path -LiteralPath $ownedPidPath -PathType Leaf) { (Get-Content -LiteralPath $ownedPidPath -Raw).Trim() } else { $null }
$receipt = [ordered]@{passed=$validation.passed; scenario=$Scenario;
    mode=$Mode; commit=$config.commit; validation=$validation; actualJobExitCode=$code;
    expected=@{jobExitCode=0; driverPassed=$true; status='ready; isolated storage verified; orderly exit'};
    driverResultPath=(Join-Path $output 'result.json'); stdoutPath=(Join-Path $output 'job/stdout.log');
    stderrPath=(Join-Path $output 'job/stderr.log'); ownedPidPath=$ownedPidPath; ownedPid=$ownedPid; recordingFacts=$recordingFacts;
    observedNodeVersion=(& $node --version); actualElectronRuntimeVersion=$null;
    playwrightMetadataVersion=(Get-Content -LiteralPath (Join-Path $checkout 'node_modules/playwright-core/package.json') -Raw | ConvertFrom-Json).version;
    finishedUtc=[datetime]::UtcNow.ToString('o')}
# Never overwrite the driver's receipt or invent observations when it died early.
$receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'wrapper-result.json') -Encoding utf8
# Review evidence only (docs/ci.md): name a skipped hidden-overlay PNG in the job log; this never changes the result.
if ($Scenario -eq 'overlay' -and $validation.driverResultAvailable -eq $true) {
    try {
        $capture = (Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json).overlay.capture
        if ($null -ne $capture -and $capture.screenshot.captured -eq $false) {
            Write-Output "Hidden overlay PNG skipped (review evidence only): $($capture.screenshot.error.message) DOM capture: $($capture.dom.file)"
        }
    } catch { Write-Output 'Hidden overlay capture facts unavailable.' }
}
Write-Output "Runtime evidence: $output"
if (!$validation.passed) { throw "Runtime smoke failed: $($validation.reason), Job exit $code; retained evidence: $output" }
