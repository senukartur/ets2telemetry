[CmdletBinding()]
param([ValidateRange(1, 90)][int]$Minutes = 30,
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../.local/ci'))
# ET-019 PR-12a (docs/ci.md#et-019-recording-soak-workflow-dispatch-only): soaks the protocol v1 simulator's soak source
# alone. `smoke-soak-v1` serves the generated timeline to its in-process durable client in real time and checks the
# schedule's totals; this wrapper runs it under BoundedProcess.RunExtended (16 processes, 2 GiB, 25% CPU, kill-on-close)
# and writes soak-result.json. Heap and Job memory are recorded, never compared with a threshold (ET-019 plan decision D3).
# Synthetic only: no application, database, game folder or real profile is involved. Build the simulator first.
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$node = (Get-Command node -ErrorAction Stop).Source
$cli = Join-Path $checkout 'tools/telemetry-simulator/dist/cli.cjs'
if (!(Test-Path -LiteralPath $cli -PathType Leaf)) { throw 'Simulator CLI missing; run npm run build --workspace @ets2telemetry/telemetry-simulator first.' }
$output = Join-Path ([IO.Path]::GetFullPath($OutputRoot)) ('soak-source-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
$commit = (& git -C $checkout rev-parse HEAD)
if ($LASTEXITCODE -ne 0) { throw 'Commit identity unavailable.' }
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
# The smoke stops its source 5 s into the 300 s tail, so the schedule plus the whole tail is the deadline: 360,000 ms for
# one minute, 5,700,000 ms for 90, inside RunExtended's 60,001..6,000,000 ms range.
$timeoutMs = ($Minutes * 60 + 300) * 1000
$started = [datetime]::UtcNow
$code = [ETS2Telemetry.Diagnostics.BoundedProcess]::RunExtended($node, [string[]]@($cli, 'smoke-soak-v1', '--minutes', [string]$Minutes),
    $checkout, (Join-Path $output 'job'), $timeoutMs, $true)
$durationSeconds = ([datetime]::UtcNow - $started).TotalSeconds
# The smoke's stdout: progress lines about every 10 s, then one summary line. Unparsable lines are counted, not trusted.
$progress = New-Object System.Collections.Generic.List[object]
$summary = $null; $invalidLines = 0
$stdout = Join-Path $output 'job/stdout.log'
if (Test-Path -LiteralPath $stdout -PathType Leaf) {
    foreach ($text in Get-Content -LiteralPath $stdout -Encoding UTF8) {
        if (!$text) { continue }
        try { $line = $text | ConvertFrom-Json -ErrorAction Stop } catch { $invalidLines++; continue }
        if ($line.type -eq 'progress') { $progress.Add($line) } elseif ($line.type -eq 'summary') { $summary = $line } else { $invalidLines++ }
    }
}
$heap = [ordered]@{samples=$progress.Count; firstBytes=$null; minBytes=$null; maxBytes=$null; lastBytes=$null}
if ($progress.Count -gt 0) {
    $values = @($progress | ForEach-Object { [double]$_.heapUsedBytes })
    $heap.firstBytes = $values[0]; $heap.lastBytes = $values[-1]
    $heap.minBytes = ($values | Measure-Object -Minimum).Minimum; $heap.maxBytes = ($values | Measure-Object -Maximum).Maximum
}
# Diagnostic only, as in Invoke-RuntimeSmoke.ps1: a missing or malformed CPU series or memory file is recorded, never a failure.
$cpu = [ordered]@{error='CPU_SERIES_UNAVAILABLE'}
$cpuSeries = Join-Path $output 'job/cpu.jsonl'
if (Test-Path -LiteralPath $cpuSeries -PathType Leaf) {
    try {
        $cpuText = & $node (Join-Path $PSScriptRoot 'job-cpu-summary.mjs') $cpuSeries 2>$null
        if ($LASTEXITCODE -eq 0) { $cpuSummary = $cpuText | ConvertFrom-Json; $cpu = [ordered]@{samples=$cpuSummary.samples; elapsedMs=$cpuSummary.elapsedMs; capProcessors=$cpuSummary.capProcessors
            averageJobProcessors=$cpuSummary.averageJobProcessors; peakJobProcessors=$cpuSummary.peakJobProcessors; peakSystemBusyProcessors=$cpuSummary.peakSystemBusyProcessors} }
        else { $cpu.error = 'CPU_SERIES_INVALID' }
    } catch { $cpu.error = 'CPU_SERIES_INVALID' }
}
$memory = [ordered]@{error='JOB_MEMORY_UNAVAILABLE'}
$memoryFile = Join-Path $output 'job/memory.json'
if (Test-Path -LiteralPath $memoryFile -PathType Leaf) {
    try { $memory = Get-Content -LiteralPath $memoryFile -Raw | ConvertFrom-Json -ErrorAction Stop } catch { $memory = $null }
    if ($null -eq $memory) { $memory = [ordered]@{error='JOB_MEMORY_INVALID'} }
}
$reason = $null
if ($code -ne 0) { $reason = "JOB_EXIT_$code" }
elseif ($null -eq $summary) { $reason = 'SOAK_SUMMARY_MISSING' }
elseif ($summary.passed -ne $true -or $summary.minutes -ne $Minutes -or $summary.mode -ne 'soak-smoke' -or $summary.history -ne $false) { $reason = 'SOAK_SUMMARY_FAILED' }
$result = [ordered]@{passed=($null -eq $reason); reason=$reason; minutes=$Minutes; commit=$commit; exitCode=$code; durationSeconds=$durationSeconds; timeoutMs=$timeoutMs
    limits='RunExtended; 16 processes; 2 GiB; 25% CPU; kill-on-close'; summary=$summary; heapUsedBytes=$heap; invalidLines=$invalidLines; cpu=$cpu; jobMemory=$memory
    finishedUtc=[datetime]::UtcNow.ToString('o')}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $output 'soak-result.json') -Encoding utf8
if ($progress.Count -gt 0) {
    Write-Output ("Soak source heap (recorded, not gated): {0} progress lines, first {1:N1} MiB, min {2:N1} MiB, max {3:N1} MiB, last {4:N1} MiB" -f
        $progress.Count, ($heap.firstBytes / 1MB), ($heap.minBytes / 1MB), ($heap.maxBytes / 1MB), ($heap.lastBytes / 1MB))
}
Write-Output "Soak evidence: $output"
if ($null -ne $reason) { throw "Soak source failed: $reason, Job exit $code; retained evidence: $output" }
