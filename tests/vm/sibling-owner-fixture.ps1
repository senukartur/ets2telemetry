# Console-only owner used to test sole Job handle death. No production observer.
param([string]$NodePath,[string]$OutputDirectory,[string]$Mode='owner-death')
$ErrorActionPreference='Stop'
if($Mode -notin @('owner-death','deadline')){throw 'Fixed hanging fixture mode required.'}
$env:ETS2TELEMETRY_SIBLING_FIXTURE=$Mode
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
$entry=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess].GetMethod('RunLegacyFixture',[Reflection.BindingFlags]'NonPublic,Static')
$invocation=[object[]]@([string]$NodePath,[string[]]@([string](Join-Path $PSScriptRoot 'sibling-fixture.cjs'),[string]$Mode,[string]$OutputDirectory),[string](Join-Path $PSScriptRoot 'sibling-observer-fixture.ps1'),[string]$OutputDirectory,[string](Join-Path $OutputDirectory 'job'),[int]5000)
$code=$entry.Invoke($null,$invocation)
exit $code
