[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $checkout ('.local/ci/extended-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output | Out-Null
# Existing fixtures launch harmless Node children under the unchanged Job helper.
$lines = @(& (Join-Path $checkout 'tests/watchdog/run.ps1') -NodePath (Get-Command node).Source)
$lines | Set-Content -LiteralPath (Join-Path $output 'watchdog-summary.txt') -Encoding utf8
$lines | Write-Output
$evidence = @($lines | Where-Object { $_ -like 'Evidence: *' })
if ($evidence.Count -ne 1) { throw 'Watchdog did not report a unique evidence directory.' }
$source = [IO.Path]::GetFullPath($evidence[0].Substring('Evidence: '.Length))
$prefix = Join-Path ([IO.Path]::GetTempPath()) 'ets2-watchdog-tests-'
if (!$source.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
    (Get-Item -LiteralPath $source).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Unexpected watchdog evidence ownership.'
}
Copy-Item -LiteralPath $source -Destination (Join-Path $output 'watchdog') -Recurse
& (Join-Path $checkout 'tests/windows/Test-UninstallResidue.ps1') -FixtureDirectory (Join-Path $output 'uninstall-residue')
# Evidence remains for always-upload, including inert rejected residue fixtures.
