# Fixed console-only fixture. Never loads production observer or native Job queries.
param([int]$DriverPid,[int]$ControllerPid,[string]$StopFile,[string]$ResultFile,[string]$ReadyFile)
$ErrorActionPreference='Stop'
$mode=$env:ETS2TELEMETRY_SIBLING_FIXTURE
if($mode -notin @('normal','deadline','owner-death','nonzero','orphan','output','late-wrong-parent','late-wrong-image','late-role-overlap','late-mutation')){throw 'Fixed harmless fixture mode required.'}
$directory=Split-Path -Parent $ReadyFile
[ordered]@{pid=$PID;controllerPid=$ControllerPid;marker='SIBLING_POWERSHELL_REACHED'}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Encoding UTF8
if($mode -eq 'nonzero'){exit 9}
'SIBLING_POWERSHELL_REACHED'|Write-Output
if($mode -eq 'output'){Write-Output ('y'*(2*1024*1024))}
. (Join-Path $PSScriptRoot 'sibling-console-metadata-fixture.ps1')
$console=Get-FixtureConsole $directory
[ordered]@{ready=$true;driverPid=$DriverPid;observerPid=$PID;controllerPid=$ControllerPid;consoleHost=$console;fixtureOnly=$true}|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath ($ReadyFile+'.partial') -Encoding UTF8
Move-Item -LiteralPath ($ReadyFile+'.partial') -Destination $ReadyFile
while(!(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))){Start-Sleep -Milliseconds 10}
$known=[int[]]@($DriverPid,$PID)+[int[]]@($console.pid|Where-Object {$_})
$late=Publish-FixtureDriverConsole $directory $known $mode
if($mode -eq 'late-mutation'){
    while(!(Test-Path -LiteralPath (Join-Path $directory 'job/driver-console-custody.json'))){Start-Sleep -Milliseconds 10}
    $late.consoleHost.commandLine+=' mutated';$late|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath (Join-Path $directory 'late-driver-console.json.partial') -Encoding UTF8
    [IO.File]::Replace((Join-Path $directory 'late-driver-console.json.partial'),(Join-Path $directory 'late-driver-console.json'),[NullString]::Value)
}
while(!(Test-Path -LiteralPath $StopFile)){Start-Sleep -Milliseconds 10}
$members=Get-Content -LiteralPath (Join-Path $directory 'job/controller-members.json') -Raw|ConvertFrom-Json;$expected=@($known)+@($late.consoleHost.pid)
if($members.pids.Count -ne $expected.Count -or @($members.pids|Where-Object {$_ -notin $expected}).Count){throw 'Ordering fixture Stop contains unaudited members.'}
[ordered]@{passed=$true;fixtureOnly=$true}|ConvertTo-Json -Compress|Set-Content -LiteralPath $ResultFile -Encoding UTF8
exit 0
