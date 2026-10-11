param([string]$NodePath, [string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot '../../scripts/watchdog/BoundedProcess.cs')
$fixture = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot 'fixture.cjs')).Path
$code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($NodePath, [string[]]@($fixture, 'hang', $OutputDirectory), $OutputDirectory, $OutputDirectory, 60000)
exit $code
