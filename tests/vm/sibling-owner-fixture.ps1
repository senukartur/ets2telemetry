# Console-only owner used to test sole Job handle death. No production observer.
param([string]$NodePath,[string]$OutputDirectory,[string]$Mode='owner-death')
$ErrorActionPreference='Stop'
if($Mode -notin @('owner-death','deadline')){throw 'Fixed hanging fixture mode required.'}
$env:ETS2TELEMETRY_SIBLING_FIXTURE=$Mode
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
$code=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess]::Run($NodePath,[string[]]@((Join-Path $PSScriptRoot 'sibling-fixture.cjs'),$Mode,$OutputDirectory),(Join-Path $PSScriptRoot 'sibling-observer-fixture.ps1'),$OutputDirectory,(Join-Path $OutputDirectory 'job'),5000)
exit $code
