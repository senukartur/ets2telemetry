[CmdletBinding()]
param([ValidateSet('development','packaged','installed')][string]$Mode,
    [ValidateSet('scaffold','telemetry','overlay','lifecycle','recording','journal','hard-mode','plugin','refusal','soak','ui')][string]$Scenario = 'scaffold',
    [ValidateSet('shell','live','journal','settings','overlay')][string]$UiCase,
    [switch]$ForceRendererReuse,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'),
    # ET-018 PR-1 (U11): the installed mode runs `<binary root>\app-<version>\ETS2TelemetryDesktop.exe` of a Squirrel install.
    [string]$Executable,
    # ET-019 PR-12b: the soak's length in whole minutes, 1 to 90; given only with -Scenario soak.
    [ValidateRange(0, 90)][int]$SoakMinutes = 0)
$ErrorActionPreference = 'Stop'
# ET-019 PR-12b (docs/ci.md#et-019-recording-soak-workflow-dispatch-only): the soak runs the development or packaged
# application only; the installed smokes of the installer lifecycle never soak.
if ($Scenario -eq 'soak') {
    if ($Mode -eq 'installed') { throw 'The soak runs only in the development and packaged modes.' }
    if ($SoakMinutes -lt 1) { throw 'The soak needs -SoakMinutes from 1 to 90.' }
} elseif ($SoakMinutes -ne 0) { throw 'Soak minutes are given only with -Scenario soak.' }
if ($Scenario -eq 'ui') {
    if ($Mode -eq 'installed' -or !$UiCase) { throw 'UI shards require development/packaged mode and -UiCase.' }
} elseif ($UiCase) { throw 'UiCase is given only with -Scenario ui.' }
if ($Mode -ne 'installed' -and $Executable) { throw 'An executable is given only in the installed mode.' }
if ($Mode -eq 'installed') {
    # Only an installed layout: ETS2TelemetryDesktop\app-<semver>\ETS2TelemetryDesktop.exe beside the binary root's Update.exe.
    if (!$Executable -or ![IO.Path]::IsPathRooted($Executable) -or !(Test-Path -LiteralPath $Executable -PathType Leaf)) { throw 'Installed executable missing.' }
    $Executable = (Get-Item -LiteralPath $Executable).FullName
    $appDirectory = Split-Path -Parent $Executable; $binaryRoot = Split-Path -Parent $appDirectory
    if ((Split-Path -Leaf $Executable) -cne 'ETS2TelemetryDesktop.exe' -or (Split-Path -Leaf $appDirectory) -cnotmatch '^app-[0-9]+\.[0-9]+\.[0-9]+$' -or
        (Split-Path -Leaf $binaryRoot) -cne 'ETS2TelemetryDesktop' -or !(Test-Path -LiteralPath (Join-Path $binaryRoot 'Update.exe') -PathType Leaf)) {
        throw 'Not an installed layout: ETS2TelemetryDesktop\app-<version>\ETS2TelemetryDesktop.exe with Update.exe.'
    }
}
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
if ($Scenario -eq 'lifecycle' -or $Scenario -eq 'recording' -or $Scenario -eq 'journal' -or $Scenario -eq 'plugin' -or ($Scenario -eq 'ui' -and $UiCase -eq 'settings')) {
    $paths.diagnosticsRestart = Join-Path $output 'diagnostics-restart'
    New-Item -ItemType Directory -Path $paths.diagnosticsRestart | Out-Null
}
$config = $paths.Clone()
$config.mode = $Mode; $config.output = $output; $config.checkout = $checkout
$config.scenario = $Scenario
if ($Scenario -eq 'ui') { $config.uiCase = $UiCase }
if ($ForceRendererReuse -and $Scenario -ne 'overlay') { throw 'Renderer reuse control is restricted to the hidden overlay fixture.' }
$config.forceRendererProcessReuse = [bool]$ForceRendererReuse
if ($Scenario -eq 'soak') { $config.soakMinutes = $SoakMinutes }
$config.commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
$config.executable = if ($Mode -eq 'installed') { $Executable } else { Join-Path $checkout 'out/ETS2Telemetry Desktop-win32-x64/ETS2TelemetryDesktop.exe' }
if ($Mode -eq 'packaged' -and !(Test-Path -LiteralPath $config.executable -PathType Leaf)) { throw 'Forge package missing.' }
$configFile = Join-Path $output 'config.json'
$config | ConvertTo-Json | Set-Content -LiteralPath $configFile -Encoding utf8
. (Join-Path $PSScriptRoot 'RuntimeReceipt.ps1')
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
# Every scenario but the soak and the UI shards runs in a 60 s Job. The plugin journey had 120 s until October 18, 2026; its hosted
# step took at most 14 s, so 60 s keeps more than four times that (docs/ci.md#et-017-plugin-smoke-scenario). Since ET-045e the UI
# shards run under RunExtended with 120 s: hosted settings shards took 48-61 s and timed out at 60 s (docs/ci.md#yukon-ui-shard-job).
$started = [datetime]::UtcNow
$limits = '60 s; 16 processes; 2 GiB; 25% CPU; kill-on-close'
if ($Scenario -eq 'soak') {
    # ET-019 PR-12b: the same limits under RunExtended, with the soak source's whole schedule as the deadline: M minutes of
    # cycles and its 300 s tail, which the driver stops 10 s in. 360,000 ms for one minute, 5,700,000 ms for 90.
    $timeoutMs = ($SoakMinutes * 60 + 300) * 1000
    $limits = "RunExtended $($timeoutMs / 1000) s; 16 processes; 2 GiB; 25% CPU; kill-on-close"
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::RunExtended($node,
        [string[]]@((Join-Path $PSScriptRoot 'runtime-smoke.mjs'), $configFile),
        $checkout, (Join-Path $output 'job'), $timeoutMs, $true)
} elseif ($Scenario -eq 'ui') {
    $limits = 'RunExtended 120 s; 16 processes; 2 GiB; 25% CPU; kill-on-close'
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::RunExtended($node,
        [string[]]@((Join-Path $PSScriptRoot 'runtime-smoke.mjs'), $configFile),
        $checkout, (Join-Path $output 'job'), 120000, $true)
} else {
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($node,
        [string[]]@((Join-Path $PSScriptRoot 'runtime-smoke.mjs'), $configFile),
        $checkout, (Join-Path $output 'job'), 60000, $true)
}
$durationSeconds = ([datetime]::UtcNow-$started).TotalSeconds
# Diagnostic only: Job/system CPU use separates starvation under the cap from outside load or a block
# inside the application. A missing or malformed series is recorded and never changes the smoke result.
$cpu = [ordered]@{error='CPU_SERIES_UNAVAILABLE'}
$cpuSeries = Join-Path $output 'job/cpu.jsonl'
# ET-019 PR-12b: a soak's series is summarized in 10 s buckets, so job-result.json stays within its 256 KiB read bound.
$cpuArguments = @()
if ($Scenario -eq 'soak') { $cpuArguments = @('--bucket-ms', '10000') }
if (Test-Path -LiteralPath $cpuSeries -PathType Leaf) {
    try {
        $summary = & $node (Join-Path $PSScriptRoot 'job-cpu-summary.mjs') $cpuSeries @cpuArguments 2>$null
        if ($LASTEXITCODE -eq 0) { $cpu = $summary | ConvertFrom-Json } else { $cpu.error = 'CPU_SERIES_INVALID' }
    } catch { $cpu.error = 'CPU_SERIES_INVALID' }
}
# ET-019 PR-11: the Job's peak committed memory of one process and of the whole Job, which BoundedProcess writes after the
# run. Recorded, never compared with a threshold; Test-RuntimeReceipt fails a missing or implausible value.
$memory = [ordered]@{error='JOB_MEMORY_UNAVAILABLE'}
$memoryFile = Join-Path $output 'job/memory.json'
if (Test-Path -LiteralPath $memoryFile -PathType Leaf) {
    # An empty file (a write that failed after creating it) parses to null; record it like any other invalid file.
    try { $memory = Get-Content -LiteralPath $memoryFile -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $memory = $null }
    if ($null -eq $memory) { $memory = [ordered]@{error='JOB_MEMORY_INVALID'} }
}
@{mode=$Mode; scenario=$Scenario; commit=$config.commit; exitCode=$code; retries=0;
  durationSeconds=$durationSeconds;
  limits=$limits;
  descendantsNaturallyDrained=($code -eq 0); cpu=$cpu; memory=$memory} | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output 'job-result.json') -Encoding utf8
$validation = Test-RuntimeReceipt -DriverResultPath (Join-Path $output 'result.json') -ExpectedCommit $config.commit -ExpectedMode $Mode -ExpectedScenario $Scenario -ExpectedUiCase $UiCase -JobExitCode $code `
    -JobResultPath (Join-Path $output 'job-result.json')
# ET-019 PR-11: the resource evidence beside the wrapper's own facts, copied only from a receipt that could be read.
$resourceFacts = [ordered]@{jobMemory=$memory; coldLaunchOrigin=$null; coldLaunchMs=$null; processMemory=$null}
if ($validation.driverResultAvailable -eq $true) {
    try {
        $driverResources = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        $resourceFacts.coldLaunchOrigin = $driverResources.coldLaunch.origin; $resourceFacts.coldLaunchMs = $driverResources.coldLaunch.phasesMs; $resourceFacts.processMemory = $driverResources.processMemory.kinds
    } catch { $resourceFacts.error = 'RESOURCE_FACTS_UNAVAILABLE' }
}
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
# ET-019 PR-12b: the soak's evidence, recorded and never gated (ET-019 plan decision D3): the source, the stored counts,
# the database size per sample-hour, each log's budget use projected to 90 minutes and each process kind's private bytes.
$soakFacts = $null
if ($Scenario -eq 'soak' -and $validation.driverResultAvailable -ne $true) { $soakFacts = [ordered]@{error='SOAK_FACTS_UNAVAILABLE'} }
elseif ($Scenario -eq 'soak') {
    try {
        $soak = (Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json).soak
        $soakFacts = [ordered]@{minutes=$soak.minutes; probes=@($soak.series).Count; source=$soak.sourceFacts; counts=$soak.database.counts; growth=$soak.growth; logs=$soak.logs
            memory=$soak.seriesSummary}
    } catch { $soakFacts = [ordered]@{error='SOAK_FACTS_UNAVAILABLE'} }
}
$ownedPidPath = Join-Path $output 'job/owned-pid.txt'
$ownedPid = if (Test-Path -LiteralPath $ownedPidPath -PathType Leaf) { (Get-Content -LiteralPath $ownedPidPath -Raw).Trim() } else { $null }
$receipt = [ordered]@{passed=$validation.passed; scenario=$Scenario;
    mode=$Mode; commit=$config.commit; validation=$validation; actualJobExitCode=$code;
    expected=@{jobExitCode=0; driverPassed=$true; status='ready; isolated storage verified; orderly exit'};
    driverResultPath=(Join-Path $output 'result.json'); stdoutPath=(Join-Path $output 'job/stdout.log');
    stderrPath=(Join-Path $output 'job/stderr.log'); ownedPidPath=$ownedPidPath; ownedPid=$ownedPid; recordingFacts=$recordingFacts;
    resourceFacts=$resourceFacts;
    observedNodeVersion=(& $node --version); actualElectronRuntimeVersion=$null;
    playwrightMetadataVersion=(Get-Content -LiteralPath (Join-Path $checkout 'node_modules/playwright-core/package.json') -Raw | ConvertFrom-Json).version;
    finishedUtc=[datetime]::UtcNow.ToString('o')}
if ($Scenario -eq 'soak') { $receipt.soakFacts = $soakFacts }
# Never overwrite the driver's receipt or invent observations when it died early.
# The soak's facts nest two levels deeper than any other scenario's.
$receipt | ConvertTo-Json -Depth $(if ($Scenario -eq 'soak') { 8 } else { 6 }) | Set-Content -LiteralPath (Join-Path $output 'wrapper-result.json') -Encoding utf8
# Review evidence only (docs/ci.md): name a skipped hidden-overlay PNG in the job log; this never changes the result.
if ($Scenario -eq 'overlay' -and $validation.driverResultAvailable -eq $true) {
    try {
        $capture = (Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw -Encoding UTF8 | ConvertFrom-Json).overlay.capture
        if ($null -ne $capture -and $capture.screenshot.captured -eq $false) {
            Write-Output "Hidden overlay PNG skipped (review evidence only): $($capture.screenshot.error.message) DOM capture: $($capture.dom.file)"
        }
    } catch { Write-Output 'Hidden overlay capture facts unavailable.' }
}
# One line of the recorded resource evidence in the job log; numbers only, never a threshold.
if ($null -ne $memory.peakJobMemoryBytes -and $null -ne $resourceFacts.coldLaunchMs) {
    $phasesMs = $resourceFacts.coldLaunchMs
    Write-Output ("Resource evidence (recorded, not gated): peak Job memory {0} MiB, peak process memory {1} MiB; ms after {2}: service ready {3}, first window {4}, first contentful paint {5}, dashboard ready {6}" -f
        [math]::Round([double]$memory.peakJobMemoryBytes / 1MB), [math]::Round([double]$memory.peakProcessMemoryBytes / 1MB), $resourceFacts.coldLaunchOrigin, $phasesMs.serviceReady, $phasesMs.firstWindowShown,
        $phasesMs.rendererFirstContentfulPaint, $phasesMs.dashboardReadyVisible)
}
if ($Scenario -eq 'soak' -and $null -ne $soakFacts.growth -and $null -ne $soakFacts.logs) {
    $growth = $soakFacts.growth
    Write-Output ("Soak evidence (recorded, not gated): {0} minutes, {1} probes; database {2} bytes per sample-hour ({3} of the measured {4}); logs main {5}/{6} bytes and {7}/{8} records, service {9}/{10} bytes and {11}/{12} records; projected to 90 minutes main {13} bytes and {14} records, service {15} bytes and {16} records" -f
        $soakFacts.minutes, $soakFacts.probes, $growth.bytesPerSampleHour, $growth.ratioToMeasured, $growth.measuredBytesPerSampleHour,
        $soakFacts.logs.main.bytes, $soakFacts.logs.main.budgetBytes, $soakFacts.logs.main.records, $soakFacts.logs.main.budgetRecords,
        $soakFacts.logs.service.bytes, $soakFacts.logs.service.budgetBytes, $soakFacts.logs.service.records, $soakFacts.logs.service.budgetRecords,
        $soakFacts.logs.main.projected.bytes, $soakFacts.logs.main.projected.records, $soakFacts.logs.service.projected.bytes, $soakFacts.logs.service.projected.records)
    foreach ($kind in @($soakFacts.memory.PSObject.Properties | ForEach-Object { $_.Name })) {
        $private = $soakFacts.memory.$kind.privateBytes; $trend = $soakFacts.memory.$kind.trend
        if ($null -eq $private) { continue }
        Write-Output ("Soak memory (recorded, not gated): {0} private MiB first {1:N1}, max {2:N1}, last {3:N1}; trend {4} {5}" -f $kind, ($private.first / 1MB), ($private.max / 1MB),
            ($private.last / 1MB), $trend.status, $(if ($trend.status -ceq 'MEASURED') { "$([math]::Round($trend.slopeBytesPerHour / 1MB, 1)) MiB/h, r2 $($trend.r2)" } else { "($($trend.points) points after the warm-up)" }))
    }
}
Write-Output "Runtime evidence: $output"
if (!$validation.passed) { throw "Runtime smoke failed: $($validation.reason), Job exit $code; retained evidence: $output" }
