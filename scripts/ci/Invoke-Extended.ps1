[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $checkout ('.local/ci/extended-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
# Existing fixtures launch harmless Node children under the unchanged Job helper.
# Place evidence under the artifact root before execution, including failure paths.
$temporary = Join-Path $output 'watchdog-fixtures'
New-Item -ItemType Directory -Path $temporary | Out-Null
$previousTemp = $env:TEMP; $previousTmp = $env:TMP
try {
    $env:TEMP = $temporary; $env:TMP = $temporary
    & (Join-Path $checkout 'tests/watchdog/run.ps1') -NodePath (Get-Command node).Source |
        Tee-Object -FilePath (Join-Path $output 'watchdog-summary.txt')
} finally { $env:TEMP = $previousTemp; $env:TMP = $previousTmp }
& (Join-Path $checkout 'tests/windows/Test-UninstallResidue.ps1') -FixtureDirectory (Join-Path $output 'uninstall-residue')
# Evidence remains for always-upload, including inert rejected residue fixtures.
