# Fixed console-only fixture. Never loads production observer or native Job queries.
param([int]$DriverPid,[int]$ControllerPid,[string]$StopFile,[string]$ResultFile,[string]$ReadyFile)
$ErrorActionPreference='Stop'
$mode=$env:ETS2TELEMETRY_SIBLING_FIXTURE
if($mode -notin @('normal','deadline','owner-death','nonzero','orphan','output')){throw 'Fixed harmless fixture mode required.'}
$directory=Split-Path -Parent $ReadyFile
[ordered]@{pid=$PID;controllerPid=$ControllerPid;marker='SIBLING_POWERSHELL_REACHED'}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Encoding UTF8
if($mode -eq 'nonzero'){exit 9}
'SIBLING_POWERSHELL_REACHED'|Write-Output
if($mode -eq 'output'){Write-Output ('y'*(2*1024*1024))}
[ordered]@{ready=$true;driverPid=$DriverPid;observerPid=$PID;controllerPid=$ControllerPid}|ConvertTo-Json -Compress|Set-Content -LiteralPath ($ReadyFile+'.partial') -Encoding UTF8
Move-Item -LiteralPath ($ReadyFile+'.partial') -Destination $ReadyFile
while(!(Test-Path -LiteralPath $StopFile)){Start-Sleep -Milliseconds 10}
[ordered]@{passed=$true;fixtureOnly=$true}|ConvertTo-Json -Compress|Set-Content -LiteralPath $ResultFile -Encoding UTF8
exit 0
