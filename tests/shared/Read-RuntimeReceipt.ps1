param([string]$Configuration)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/ci/RuntimeReceipt.ps1')
# One Windows PowerShell 5.1 process validates every case: process startup, not validation, dominated the per-case cost.
# Test-RuntimeReceipt keeps no state between calls; each case reads its own receipt file.
$config = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]
foreach ($case in @($config.cases)) {
    try {
        $output = @(Test-RuntimeReceipt -DriverResultPath $case.receipt -ExpectedCommit 'candidate' -ExpectedMode 'packaged' `
            -ExpectedScenario $case.scenario -JobExitCode $case.code)
        # Exactly one result object per case, as when each case ran in its own process.
        if ($output.Count -ne 1) { $results.Add([ordered]@{error = "Expected one result, got $($output.Count)."}) }
        else { $results.Add($output[0]) }
    } catch { $results.Add([ordered]@{error = $_.Exception.Message}) }
}
# ToArray: PS5.1 ConvertTo-Json rejects @() over a generic List with "Argument types do not match".
ConvertTo-Json -InputObject $results.ToArray() -Compress -Depth 3
