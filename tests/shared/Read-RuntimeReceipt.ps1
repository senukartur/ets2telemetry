param([string]$Configuration)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../scripts/ci/RuntimeReceipt.ps1')
$config = Get-Content -LiteralPath $Configuration -Raw | ConvertFrom-Json
Test-RuntimeReceipt -DriverResultPath $config.receipt -ExpectedCommit 'candidate' -ExpectedMode 'packaged' -JobExitCode $config.code | ConvertTo-Json -Compress
