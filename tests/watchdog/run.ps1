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
    Write-Output 'PASS: exit codes, argument quoting, stderr, timeout tree cleanup, orphan cleanup, output cap, owner-death cleanup, unrelated process preservation.'
    Write-Output "Evidence: $root"
} finally {
    if ($null -ne $owner -and !$owner.HasExited) { $owner.Kill(); $null = $owner.WaitForExit(5000) }
    if ($null -ne $sentinel -and !$sentinel.HasExited) { $sentinel.Kill(); $null = $sentinel.WaitForExit(5000) }
}
