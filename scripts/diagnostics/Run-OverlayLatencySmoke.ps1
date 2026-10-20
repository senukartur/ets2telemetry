[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $output) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$entry = Join-Path $output 'smoke.cjs'
# Bundle the actual frame observer/collector; Electron remains external. The production renderer/preload must be built first.
Push-Location -LiteralPath $checkout
try { & node (Join-Path $PSScriptRoot 'build-overlay-latency-smoke.mjs') $output }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Smoke bundle failed.' }
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
$electron = Join-Path $checkout 'node_modules/electron/dist/electron.exe'
$nodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($electron, [string[]]@($entry, $checkout, $output), $checkout,
        (Join-Path $output 'job'), 30000, $true)
} finally { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
if ($code -ne 0) { throw "Latency compositor smoke failed ($code): $output" }
$result = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
if ($null -eq $result -or $result.passed -ne $true -or @($result.results).Count -ne 3) { throw 'Missing or incomplete compositor smoke receipt.' }
foreach ($scale in $result.results) {
    if ($scale.attempted -ne 25 -or $scale.valid -lt 15) { throw 'Incomplete compositor smoke scale.' }
}
Write-Output $output
