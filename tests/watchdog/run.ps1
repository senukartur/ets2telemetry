[CmdletBinding()]
param([string]$NodePath = (Get-Command node -ErrorAction Stop).Source)
$ErrorActionPreference = 'Stop'
$NodePath = (Resolve-Path -LiteralPath $NodePath).Path
if ([IO.Path]::GetFileName($NodePath) -ne 'node.exe') { throw 'Tests require Node, never Electron or the packaged application.' }
Add-Type -Path (Join-Path $PSScriptRoot '../../scripts/watchdog/BoundedProcess.cs')
$fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'fixture.cjs')).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('ets2-watchdog-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root | Out-Null
function Assert($condition, $message) { if (!$condition) { throw $message } }
function Run-Fixture($name, $mode, $timeoutMs, [string[]]$Extra = @()) {
    $directory = Join-Path $root $name
    New-Item -ItemType Directory -Path $directory | Out-Null
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($NodePath, [string[]](@($fixture, $mode, $directory) + $Extra), $directory, $directory, $timeoutMs)
    return @{ Code=$code; Directory=$directory }
}
function Assert-Stopped($directory) {
    $pids = Get-Content -LiteralPath (Join-Path $directory 'fixture-pids.json') -Raw | ConvertFrom-Json
    $deadline = [datetime]::UtcNow.AddSeconds(5)
    do {
        $remaining = @($pids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        if ($remaining.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    throw "Fixture processes remain: $($remaining.Id -join ',')"
}
$sentinel = $null
$owner = $null
try {
    $sentinelArgs = [ETS2Telemetry.Diagnostics.BoundedProcess]::Quote($fixture) + ' leaf ' + [ETS2Telemetry.Diagnostics.BoundedProcess]::Quote($root)
    $sentinel = Start-Process -FilePath $NodePath -ArgumentList $sentinelArgs -WindowStyle Hidden -PassThru
    $expected = [string[]]@('with spaces', 'quote"inside', 'trailing\', '')
    $normal = Run-Fixture 'normal' 'normal' 5000 $expected
    Assert ($normal.Code -eq 7) 'Child exit code was not preserved.'
    $actual = Get-Content -LiteralPath (Join-Path $normal.Directory 'stdout.log') -Raw | ConvertFrom-Json
    Assert (($actual | ConvertTo-Json -Compress) -eq ($expected | ConvertTo-Json -Compress)) 'Windows argument quoting failed.'
    Assert ((Get-Content -LiteralPath (Join-Path $normal.Directory 'stderr.log') -Raw).Contains('fixture stderr')) 'stderr was not captured.'
    $timeout = Run-Fixture 'timeout' 'hang' 1500
    Assert ($timeout.Code -eq 124) 'Timeout did not fail with code 124.'
    Assert-Stopped $timeout.Directory
    $orphan = Run-Fixture 'orphan' 'orphan' 5000
    Assert ($orphan.Code -eq 125) "Orphaned child was not reported as failure (code $($orphan.Code))."
    Assert-Stopped $orphan.Directory
    $output = Run-Fixture 'output' 'output' 5000
    Assert ($output.Code -eq 0) 'Output fixture failed.'
    Assert ((Get-Item -LiteralPath (Join-Path $output.Directory 'stdout.log')).Length -eq 1048576) 'Output capture is not capped at 1 MiB.'
    Assert (!(Test-Path -LiteralPath (Join-Path $normal.Directory 'cpu.jsonl'))) 'CPU samples were written without being requested.'
    Assert (!(Test-Path -LiteralPath (Join-Path $normal.Directory 'memory.json'))) 'Peak memory was written without being requested.'
    $sampledDirectory = Join-Path $root 'cpu-sampled'
    New-Item -ItemType Directory -Path $sampledDirectory | Out-Null
    $sampledCode = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($NodePath, [string[]]@($fixture, 'spin', $sampledDirectory), $sampledDirectory, $sampledDirectory, 5000, $true)
    Assert ($sampledCode -eq 0) "Sampled fixture failed (code $sampledCode)."
    $lines = @(Get-Content -LiteralPath (Join-Path $sampledDirectory 'cpu.jsonl') | ForEach-Object { $_ | ConvertFrom-Json })
    Assert ($lines[0].type -eq 'start' -and $lines[0].logicalProcessors -eq [Environment]::ProcessorCount -and $lines[0].jobCpuRatePercent -eq 25) 'CPU sample header is wrong.'
    $samples = @($lines | Select-Object -Skip 1)
    Assert ($samples.Count -ge 8) "Too few CPU samples ($($samples.Count))."
    for ($i = 1; $i -lt $samples.Count; $i++) {
        Assert ($samples[$i].elapsedMs -ge $samples[$i - 1].elapsedMs -and $samples[$i].jobCpuMs -ge $samples[$i - 1].jobCpuMs) 'CPU samples are not cumulative.'
    }
    $last = $samples[-1]
    # A one-second spin under the hard cap: some CPU, but no more than the cap allows plus enforcement slack.
    Assert ($last.jobCpuMs -gt 50) "Job CPU time was not recorded ($($last.jobCpuMs) ms)."
    Assert ($last.jobCpuMs -le 0.25 * [Environment]::ProcessorCount * $last.elapsedMs + 250) "Job CPU time exceeds the 25% cap ($($last.jobCpuMs) ms in $($last.elapsedMs) ms)."
    # ET-019 PR-11: the Job's peak committed memory, in bytes: a Node process commits several MiB, one process never more than the Job.
    $memory = Get-Content -LiteralPath (Join-Path $sampledDirectory 'memory.json') -Raw | ConvertFrom-Json
    Assert ((@($memory.PSObject.Properties | ForEach-Object { $_.Name }) -join ',') -eq 'peakProcessMemoryBytes,peakJobMemoryBytes') 'Peak memory fields are wrong.'
    Assert ($memory.peakProcessMemoryBytes -ge 1MB -and $memory.peakProcessMemoryBytes -le $memory.peakJobMemoryBytes -and $memory.peakJobMemoryBytes -le 2GB) "Peak memory is implausible ($($memory.peakProcessMemoryBytes), $($memory.peakJobMemoryBytes))."
    # ET-019 PR-12a: RunExtended is Run's containment for long runs, with its own 60,001..6,000,000 ms deadline range;
    # Run keeps 100..60,000 ms. A rejected deadline starts nothing and creates no output directory.
    $outOfRange = @(@{Method='Run'; Ms=60001}, @{Method='RunExtended'; Ms=60000}, @{Method='RunExtended'; Ms=6000001})
    foreach ($case in $outOfRange) {
        $rejectedDirectory = Join-Path $root ("rejected-$($case.Method)-$($case.Ms)")
        $rejected = $false
        $method = $case.Method
        try { [void][ETS2Telemetry.Diagnostics.BoundedProcess]::$method($NodePath, [string[]]@($fixture, 'normal', $rejectedDirectory), $root, $rejectedDirectory, $case.Ms, $true) }
        catch { $rejected = $_.Exception.InnerException -is [ArgumentOutOfRangeException] }
        Assert $rejected "$($case.Method) accepted a $($case.Ms) ms deadline."
        Assert (!(Test-Path -LiteralPath $rejectedDirectory)) "$($case.Method) created output for a rejected $($case.Ms) ms deadline."
    }
    $extendedDirectory = Join-Path $root 'extended'
    New-Item -ItemType Directory -Path $extendedDirectory | Out-Null
    $extendedCode = [ETS2Telemetry.Diagnostics.BoundedProcess]::RunExtended($NodePath, [string[]]@($fixture, 'output', $extendedDirectory), $extendedDirectory, $extendedDirectory, 61000, $true)
    Assert ($extendedCode -eq 0) "Extended fixture failed (code $extendedCode)."
    Assert ((Get-Item -LiteralPath (Join-Path $extendedDirectory 'stdout.log')).Length -eq 1048576) 'Extended output capture is not capped at 1 MiB.'
    $extendedHeader = Get-Content -LiteralPath (Join-Path $extendedDirectory 'cpu.jsonl') -TotalCount 1 | ConvertFrom-Json
    Assert ($extendedHeader.type -eq 'start' -and $extendedHeader.jobCpuRatePercent -eq 25) 'Extended CPU sample header is wrong.'
    $extendedMemory = Get-Content -LiteralPath (Join-Path $extendedDirectory 'memory.json') -Raw | ConvertFrom-Json
    Assert ((@($extendedMemory.PSObject.Properties | ForEach-Object { $_.Name }) -join ',') -eq 'peakProcessMemoryBytes,peakJobMemoryBytes') 'Extended peak memory fields are wrong.'
    Assert ($extendedMemory.peakProcessMemoryBytes -ge 1MB -and $extendedMemory.peakProcessMemoryBytes -le $extendedMemory.peakJobMemoryBytes -and $extendedMemory.peakJobMemoryBytes -le 2GB) 'Extended peak memory is implausible.'
    $ownerDirectory = Join-Path $root 'owner-death'
    New-Item -ItemType Directory -Path $ownerDirectory | Out-Null
    $shellPath = (Get-Process -Id $PID).Path
    $ownerScript = Join-Path $PSScriptRoot 'owner.ps1'
    $ownerArgs = @('-NoProfile', '-File', $ownerScript, '-NodePath', $NodePath, '-OutputDirectory', $ownerDirectory) | ForEach-Object { [ETS2Telemetry.Diagnostics.BoundedProcess]::Quote($_) }
    $owner = Start-Process -FilePath $shellPath -ArgumentList ($ownerArgs -join ' ') -WindowStyle Hidden -PassThru
    $deadline = [datetime]::UtcNow.AddSeconds(10)
    while (!(Test-Path -LiteralPath (Join-Path $ownerDirectory 'fixture-pids.json'))) {
        if ($owner.HasExited -or [datetime]::UtcNow -gt $deadline) { throw 'Watchdog death fixture failed to start.' }
        Start-Sleep -Milliseconds 100
    }
    $owner.Kill()
    Assert ($owner.WaitForExit(5000)) 'Watchdog fixture process did not stop.'
    Assert-Stopped $ownerDirectory
    Assert (!$sentinel.HasExited) 'Watchdog affected an unrelated process.'
    Write-Output 'PASS: exit codes, argument quoting, stderr, timeout tree cleanup, orphan cleanup, output cap, opt-in CPU samples and peak memory, deadline ranges of Run and RunExtended, an extended run, owner-death cleanup, unrelated process preservation.'
    Write-Output "Evidence: $root"
} finally {
    if ($null -ne $owner -and !$owner.HasExited) { $owner.Kill(); $null = $owner.WaitForExit(5000) }
    if ($null -ne $sentinel -and !$sentinel.HasExited) { $sentinel.Kill(); $null = $sentinel.WaitForExit(5000) }
}
