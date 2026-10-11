# Fixed marker/surrogate console fixture. Never loads the production observer DLL.
param([int]$DriverPid,[int]$ControllerPid,[string]$StopFile,[string]$ResultFile,[string]$ReadyFile,[string]$NodePath,[string]$FixturePath,[ValidateSet('normal','absent','outside','nonzero','live','owner-death','wrong-image')][string]$Mode)
$ErrorActionPreference='Stop';$directory=Split-Path -Parent $ReadyFile
. (Join-Path $PSScriptRoot 'sibling-console-metadata-fixture.ps1')
$ownConsole=Get-FixtureConsole $directory
$surrogate=$null;$quietTasks=@();$quietBuffers=@()
function Assert-FixtureQuietStreams{foreach($task in $quietTasks){if($task.IsCompleted -and $task.GetAwaiter().GetResult() -ne 0){throw 'Fixed quiet surrogate unexpectedly wrote stdout/stderr.'}}}
if($Mode -in @('normal','nonzero','live','owner-death','wrong-image')){
    $start=[Diagnostics.ProcessStartInfo]::new();$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.WorkingDirectory=$directory
    $start.RedirectStandardInput=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
    if($Mode -eq 'wrong-image'){$start.FileName='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe';$start.Arguments='-NoProfile -NonInteractive -File "'+(Join-Path $PSScriptRoot 'sibling-wrong-image-fixture.ps1')+'" -Directory "'+$directory+'"'}
    else{$start.FileName=$NodePath;$start.Arguments='"'+$FixturePath+'" surrogate "'+$directory+'" '+$Mode}
    $surrogate=[Diagnostics.Process]::new();$surrogate.StartInfo=$start;if(!$surrogate.Start()){throw 'Fixed surrogate did not start.'};$candidate=$surrogate.Id
    $surrogate.StandardInput.Close()
    # Fixed sources are quiet: retain bounded CLR reads and reject any output.
    foreach($stream in @($surrogate.StandardOutput.BaseStream,$surrogate.StandardError.BaseStream)){$buffer=[byte[]]::new(8192);$quietBuffers+=,$buffer;$quietTasks+=,$stream.ReadAsync($buffer,0,$buffer.Length)}
    $marker=if($Mode -eq 'wrong-image'){'wrong-image-marker.json'}else{'surrogate-marker.json'};$markerClock=[Diagnostics.Stopwatch]::StartNew()
    while(!(Test-Path -LiteralPath (Join-Path $directory $marker))){Assert-FixtureQuietStreams;if($surrogate.HasExited -or $markerClock.ElapsedMilliseconds -ge 1500){throw 'Fixed surrogate execution marker did not arrive.'};Start-Sleep -Milliseconds 10}
    if((Get-Content -LiteralPath (Join-Path $directory $marker) -Raw|ConvertFrom-Json).pid -ne $candidate){throw 'Fixed surrogate marker PID differs.'}
}elseif($Mode -eq 'outside'){$candidate=[int]$env:ETS2TELEMETRY_CONSOLE_OUTSIDE_PID}else{$candidate=2147483647}
# Synthetic descriptor is marked fixture-only; controller native custody must verify it.
$console=[ordered]@{pid=$candidate;nativeImage=$NodePath;metadataImage=$NodePath;parentProcessId=$PID;commandLine='FIXED_NODE_CONSOLE_SURROGATE';nativeExitBefore=259;nativeExitAfter=259;nativeSignaledBefore=$false;nativeSignaledAfter=$false;nativeImageFailure=$null;nativeExitFailure=$null;metadataFailure=$null;queryElapsedMilliseconds=0;fixtureMetadata=$true}
[ordered]@{pid=$PID;surrogatePid=$candidate;marker='CONSOLE_POWERSHELL_REACHED'}|ConvertTo-Json -Compress|Set-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Encoding UTF8
$diagnostic=Save-FixtureUnexpectedMembers $directory ([int[]]@($DriverPid,$PID,$candidate)+[int[]]@($ownConsole.pid|Where-Object {$_}))
$nodeConsole=$null
if($diagnostic.failure -or $diagnostic.unexpected.Count -gt 1){throw 'Fixture surrogate console candidate set differs.'}
if($diagnostic.unexpected.Count){
    $row=$diagnostic.unexpected[0]
    if(!$surrogate -or $row.nativeImage -ine 'C:\Windows\System32\conhost.exe' -or $row.metadataImage -ine 'C:\Windows\System32\conhost.exe' -or $row.parentProcessId -ne $candidate -or $row.commandLine -ine '\??\C:\Windows\System32\conhost.exe 0x4' -or $row.nativeSignaledBefore -isnot [bool] -or $row.nativeSignaledAfter -isnot [bool] -or $row.nativeSignaledBefore -or $row.nativeSignaledAfter -or $row.nativeFailure -or $row.metadataFailure){throw 'Fixture surrogate-owned console identity differs.'}
    $nodeConsole=[ordered]@{pid=$row.pid;nativeImage=$row.nativeImage;metadataImage=$row.metadataImage;parentProcessId=$row.parentProcessId;commandLine=$row.commandLine;nativeExitBefore=259;nativeExitAfter=259;nativeSignaledBefore=$row.nativeSignaledBefore;nativeSignaledAfter=$row.nativeSignaledAfter;nativeImageFailure=$null;nativeExitFailure=$null;metadataFailure=$null;queryElapsedMilliseconds=$diagnostic.elapsedMilliseconds;fixtureMetadata=$true}
}
Assert-FixtureQuietStreams
[ordered]@{ready=$true;driverPid=$DriverPid;observerPid=$PID;controllerPid=$ControllerPid;consoleHost=$console;fixtureConsoleHost=$ownConsole;fixtureConsoleNodeHost=$nodeConsole;fixtureOnly=$true}|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath ($ReadyFile+'.partial') -Encoding UTF8
Move-Item -LiteralPath ($ReadyFile+'.partial') -Destination $ReadyFile
while(!(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))){Assert-FixtureQuietStreams;Start-Sleep -Milliseconds 10}
$lateKnown=[int[]]@($DriverPid,$PID,$candidate)+[int[]]@(@($ownConsole.pid,$nodeConsole.pid)|Where-Object {$_})
$late=Publish-FixtureDriverConsole $directory $lateKnown ''
while(!(Test-Path -LiteralPath $StopFile)){Assert-FixtureQuietStreams;Start-Sleep -Milliseconds 10}
if($Mode -eq 'live'){while(!(Test-Path -LiteralPath (Join-Path $directory 'fixture-release.json'))){Assert-FixtureQuietStreams;Start-Sleep -Milliseconds 10}}
Assert-FixtureQuietStreams
$members=Get-Content -LiteralPath (Join-Path $directory 'job/controller-members.json') -Raw|ConvertFrom-Json;$stopExpected=@($lateKnown)+@($late.consoleHost.pid)
if($members.pids.Count -ne $stopExpected.Count -or @($members.pids|Where-Object {$_ -notin $stopExpected}).Count){throw 'Fixed surrogate Stop contains unaudited members.'}
'{}'|Set-Content -LiteralPath (Join-Path $directory 'surrogate-stop.json') -Encoding UTF8
if($surrogate){$surrogate.Dispose()}
exit 0
