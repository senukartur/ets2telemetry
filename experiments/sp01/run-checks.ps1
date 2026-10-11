param(
  [Parameter(Mandatory)][string]$NodePath,
  [Parameter(Mandatory)][string]$CMakeBin,
  [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$spRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Add-Type -Path (Join-Path $spRoot 'scripts/watchdog/BoundedProcess.cs')
$spOutput = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $spOutput -Force | Out-Null
$spCtest = Join-Path $CMakeBin 'ctest.exe'
$spCode = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($spCtest, [string[]]@('--test-dir', (Join-Path $PSScriptRoot 'build'), '-C', 'Release', '--output-on-failure'), $spRoot, (Join-Path $spOutput 'native'), 15000)
if ($spCode -ne 0) { throw "Native checks failed: $spCode; inspect $spOutput/native" }
$spCode = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($NodePath, [string[]]@('--test', (Join-Path $PSScriptRoot 'tests/codec.test.cjs'), (Join-Path $PSScriptRoot 'tests/window-geometry.test.cjs')), $spRoot, (Join-Path $spOutput 'codec'), 10000)
if ($spCode -ne 0) { throw "Codec checks failed: $spCode; inspect $spOutput/codec" }
Get-Content -LiteralPath (Join-Path $spOutput 'native/stdout.log')
Get-Content -LiteralPath (Join-Path $spOutput 'codec/stdout.log')
