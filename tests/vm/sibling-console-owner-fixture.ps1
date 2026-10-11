# Fixed console-only owner-death fixture; never imports the production observer.
param([string]$NodePath,[string]$OutputDirectory,[ValidateSet('owner-death','live')][string]$Mode='owner-death')
$ErrorActionPreference='Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
$entry=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess].GetMethod('RunConsoleFixture',[Reflection.BindingFlags]'NonPublic,Static')
$invocation=[object[]]@([string]$NodePath,[string[]]@([string](Join-Path $PSScriptRoot 'sibling-console-fixture.cjs'),[string]$Mode,[string]$OutputDirectory),[string](Join-Path $PSScriptRoot 'sibling-console-observer-fixture.ps1'),[string]$OutputDirectory,[string](Join-Path $OutputDirectory 'job'),[int]5000)
$code=$entry.Invoke($null,$invocation)
exit $code
