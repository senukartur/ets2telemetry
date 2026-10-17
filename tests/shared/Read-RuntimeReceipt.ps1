param([string]$Configuration)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/ci/RuntimeReceipt.ps1')
# One Windows PowerShell 5.1 process validates every case: process startup, not validation, dominated the per-case cost.
# Test-RuntimeReceipt keeps no state between calls; each case reads its own receipt file.
$config = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]
# PowerShell 7, which runs the CI steps, parses every JSON integer as Int64; Windows PowerShell 5.1 uses Int32.
# An `int64` case retypes the parsed lifecycle receipt the way PowerShell 7 would before validating it. It reads the
# receipt as UTF-8, as Test-RuntimeReceipt does (ET-016 PR-8: the recording receipt carries the journal's non-ASCII texts).
function ConvertTo-Int64Number {
    param([object]$Value)
    if ($Value -is [int]) { return [long]$Value }
    if ($Value -is [array]) { return ,@($Value | ForEach-Object { ConvertTo-Int64Number -Value $_ }) }
    if ($Value -is [System.Management.Automation.PSCustomObject]) {
        foreach ($property in $Value.PSObject.Properties) { $property.Value = ConvertTo-Int64Number -Value $property.Value }
    }
    return $Value
}
foreach ($case in @($config.cases)) {
    try {
        if ($case.numbers -ceq 'int64' -and $case.scenario -ceq 'recording') {
            # ET-015a PR-4: the recording receipt the same way.
            $driver = ConvertTo-Int64Number -Value (Get-Content -LiteralPath $case.receipt -Raw -Encoding UTF8 | ConvertFrom-Json)
            if ($driver.recording.trayExit.launcherExit -isnot [long] -or $driver.recording.servicePid -isnot [long]) { throw 'Int64 conversion failed.' }
            $valid = [bool](Test-RecordingReceipt -Driver $driver)
            $results.Add([ordered]@{passed = $valid; driverResultAvailable = $true; reason = $(if ($valid) { $null } else { 'RECORDING_RESULT_INCOMPLETE_OR_INVALID' })})
            continue
        }
        if ($case.numbers -ceq 'int64' -and $case.scenario -ceq 'journal') {
            # ET-016 PR-4: the journal receipt the same way.
            $driver = ConvertTo-Int64Number -Value (Get-Content -LiteralPath $case.receipt -Raw -Encoding UTF8 | ConvertFrom-Json)
            if ($driver.journal.seed.trips -isnot [long] -or $driver.journal.restartLauncherExit -isnot [long]) { throw 'Int64 conversion failed.' }
            $valid = [bool](Test-JournalReceipt -Driver $driver)
            $results.Add([ordered]@{passed = $valid; driverResultAvailable = $true; reason = $(if ($valid) { $null } else { 'JOURNAL_RESULT_INCOMPLETE_OR_INVALID' })})
            continue
        }
        if ($case.numbers -ceq 'int64') {
            $driver = ConvertTo-Int64Number -Value (Get-Content -LiteralPath $case.receipt -Raw -Encoding UTF8 | ConvertFrom-Json)
            if ($driver.lifecycle.secondInstance.exitCode -isnot [long] -or $driver.lifecycle.restartLauncherExit -isnot [long]) { throw 'Int64 conversion failed.' }
            $valid = [bool](Test-LifecycleReceipt -Driver $driver)
            $results.Add([ordered]@{passed = $valid; driverResultAvailable = $true; reason = $(if ($valid) { $null } else { 'LIFECYCLE_RESULT_INCOMPLETE_OR_INVALID' })})
            continue
        }
        $output = @(Test-RuntimeReceipt -DriverResultPath $case.receipt -ExpectedCommit 'candidate' -ExpectedMode 'packaged' `
            -ExpectedScenario $case.scenario -JobExitCode $case.code)
        # Exactly one result object per case, as when each case ran in its own process.
        if ($output.Count -ne 1) { $results.Add([ordered]@{error = "Expected one result, got $($output.Count)."}) }
        else { $results.Add($output[0]) }
    } catch { $results.Add([ordered]@{error = $_.Exception.Message}) }
}
# ToArray: PS5.1 ConvertTo-Json rejects @() over a generic List with "Argument types do not match".
ConvertTo-Json -InputObject $results.ToArray() -Compress -Depth 3
