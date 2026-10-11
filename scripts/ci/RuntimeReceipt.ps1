# Pure receipt validation; this file never launches a process.
function Test-RuntimeReceipt {
    param([string]$DriverResultPath, [string]$ExpectedCommit, [string]$ExpectedMode, [int]$JobExitCode)
    $validation = [ordered]@{passed=$false; driverResultAvailable=$false; reason=$null; driverPassed=$null}
    if (!(Test-Path -LiteralPath $DriverResultPath -PathType Leaf)) {
        $validation.reason = 'DRIVER_RESULT_MISSING'; return $validation
    }
    try {
        $item = Get-Item -LiteralPath $DriverResultPath
        if ($item.Length -gt 524288 -or $item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unsafe receipt.' }
        $driver = Get-Content -LiteralPath $DriverResultPath -Raw | ConvertFrom-Json -ErrorAction Stop
        if (!$driver -or $driver -is [array] -or $driver.passed -isnot [bool]) { throw 'Invalid receipt.' }
    } catch { $validation.reason = 'DRIVER_RESULT_MALFORMED'; return $validation }
    $validation.driverResultAvailable = $true
    $validation.driverPassed = $driver.passed
    if ($driver.commit -cne $ExpectedCommit -or $driver.mode -cne $ExpectedMode) {
        $validation.reason = 'DRIVER_RESULT_IDENTITY_MISMATCH'; return $validation
    }
    if ($JobExitCode -ne 0) { $validation.reason = 'JOB_FAILED'; return $validation }
    if ($driver.passed -ne $true) { $validation.reason = 'DRIVER_FAILED'; return $validation }
    $validation.passed = $true
    return $validation
}
