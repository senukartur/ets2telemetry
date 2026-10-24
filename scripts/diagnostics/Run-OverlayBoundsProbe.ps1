# ET-045c local DPI evidence: what Windows applies for the overlay window's setBounds sequences, and the real
# OverlayController replaying the owner's sections change. Manual only, never CI; no game, settings or user data.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$OutputRoot)
$ErrorActionPreference = 'Stop'
$checkout = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
$output = [IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $output) { throw 'Choose a new evidence directory.' }
New-Item -ItemType Directory -Path $output | Out-Null
$entry = Join-Path $output 'probe.cjs'
# Bundle the actual controller and geometry; Electron remains external.
Push-Location -LiteralPath $checkout
try { & node (Join-Path $PSScriptRoot 'build-overlay-bounds-probe.mjs') $output }
finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Probe bundle failed.' }
Add-Type -Path (Join-Path $checkout 'scripts/watchdog/BoundedProcess.cs')
$electron = Join-Path $checkout 'node_modules/electron/dist/electron.exe'
$nodeMode = $env:ELECTRON_RUN_AS_NODE
try {
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    $code = [ETS2Telemetry.Diagnostics.BoundedProcess]::Run($electron, [string[]]@($entry, $checkout, $output), $checkout,
        (Join-Path $output 'job'), 30000, $true)
} finally { $env:ELECTRON_RUN_AS_NODE = $nodeMode }
if ($code -ne 0) { throw "Overlay bounds probe failed ($code): $output" }
$result = Get-Content -LiteralPath (Join-Path $output 'result.json') -Raw | ConvertFrom-Json
if ($null -eq $result -or $result.passed -ne $true -or @($result.sequences).Count -ne 7 -or @($result.controller.steps).Count -ne 6) {
    throw 'Missing or incomplete overlay bounds probe receipt.'
}
Write-Output $output
