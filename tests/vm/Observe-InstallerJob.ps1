# Read-only observer, a contained sibling of the Node driver. Never creates/kills a process.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$DriverPid, [Parameter(Mandatory)][int]$ControllerPid, [Parameter(Mandatory)][string]$StopFile, [Parameter(Mandatory)][string]$ResultFile, [Parameter(Mandatory)][string]$ReadyFile)
$ErrorActionPreference='Stop'
if($env:ETS2TELEMETRY_VM_JOB -ne '1'){throw 'Contained guest driver required.'}
Add-Type -AssemblyName System.Management
$observerAssembly=Join-Path (Split-Path -Parent $PSScriptRoot) 'tools/InstallerJobView.dll'
$observerManifest=Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'kit-manifest.json') -Raw|ConvertFrom-Json
if($observerManifest.observerAssemblySha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $observerAssembly).Hash -ne $observerManifest.observerAssemblySha256){throw 'Sealed observer assembly preimage mismatch.'}
[void][Reflection.Assembly]::LoadFrom($observerAssembly)
$seen=[Collections.Generic.HashSet[int]]::new()
$records=[Collections.Generic.List[object]]::new()
$handles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
$queries=@{}
$view=[ordered]@{passed=$false;observerPid=$PID;driverPid=$DriverPid;controllerPid=$ControllerPid;parentProcessId=$null;driverParentProcessId=$null;driverImage=$null;controllerImage=$null;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;failure=$null;drained=$false;finalPids=@();processes=@();initialPidSnapshot=$null;initialScope=$null;initialScopeFailure=$null;jobScope=$null;metadataWorkers=4;metadataQueueSeconds=3;metadataQuerySeconds=3;metadataCompletionSeconds=8;warmupMilliseconds=$null;pollCount=0;maximumPollGapMilliseconds=0}
try {
    $view.initialPidSnapshot=[InstallerJobView]::ReadPids()
    # Capture immediate-Job limits even when the unchanged fresh-membership gate fails.
    try{$view.initialScope=[InstallerJobView]::ReadScope()}catch{$view.initialScopeFailure=$_.Exception.ToString()}
    $initial=[InstallerJobView]::ValidatePids($view.initialPidSnapshot)
    if($DriverPid -eq $ControllerPid -or $DriverPid -eq $PID -or $ControllerPid -eq $PID -or $initial -notcontains $DriverPid -or $initial -notcontains $PID -or $initial.Count -ne 2){throw 'Observer must start in a fresh Job containing exactly suspended driver and observer.'}
    $view.jobScope=[InstallerJobView]::AuthoritativeScope()
    foreach($entry in @(@{pid=$DriverPid;key='driverImage';image='C:\ETS2ET001Acceptance\tools\node.exe'},@{pid=$ControllerPid;key='controllerImage';image='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'})){
        $identityHandle=[InstallerJobView]::Hold($entry.pid)
        if($identityHandle -eq [IntPtr]::Zero){throw 'Sibling/controller native identity cannot be held.'}
        try{$view[$entry.key]=[InstallerJobView]::Image($identityHandle)}finally{[InstallerJobView]::Release($identityHandle)}
        if($view[$entry.key] -ine $entry.image){throw 'Sibling/controller native image differs from fixed reviewed identity.'}
    }
    # Warm WMI before Setup starts; a cold provider cannot consume the hook interval.
    $warmup=[InstallerJobView]::QueryAsync($PID)
    if(!$warmup.Wait(5000)){throw 'Read-only metadata provider warmup exceeded five seconds.'}
    if($warmup.Result.Failure -or !$warmup.Result.CommandLine){throw 'Read-only metadata provider warmup failed.'}
    $view.parentProcessId=$warmup.Result.ParentProcessId
    if($view.parentProcessId -ne $ControllerPid -or $warmup.Result.ExecutablePath -ine 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'){throw 'Observer parent/image provenance differs from actual controller.'}
    $driverMetadata=[InstallerJobView]::QueryAsync($DriverPid)
    if(!$driverMetadata.Wait(5000) -or $driverMetadata.Result.Failure){throw 'Suspended sibling metadata query failed.'}
    $view.driverParentProcessId=$driverMetadata.Result.ParentProcessId
    if($view.driverParentProcessId -ne $ControllerPid -or $driverMetadata.Result.ExecutablePath -ine $view.driverImage){throw 'Driver parent/image provenance differs from actual controller.'}
    $view.warmupMilliseconds=$warmup.Result.ElapsedMilliseconds
    $ready=[ordered]@{ready=$true;observerPid=$PID;driverPid=$DriverPid;controllerPid=$ControllerPid;parentProcessId=$view.parentProcessId;driverParentProcessId=$view.driverParentProcessId;driverImage=$view.driverImage;controllerImage=$view.controllerImage;initialPids=$initial;jobScope=$view.jobScope;warmupMilliseconds=$view.warmupMilliseconds}
    $ready|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath ($ReadyFile+'.partial') -Encoding UTF8
    Move-Item -LiteralPath ($ReadyFile+'.partial') -Destination $ReadyFile
    $ready|ConvertTo-Json -Depth 4 -Compress|Write-Output
    $deadline=[datetime]::UtcNow.AddSeconds(55)
    $pollClock=[Diagnostics.Stopwatch]::StartNew();$previousPoll=0
    do {
        $now=$pollClock.Elapsed.TotalMilliseconds
        $view.maximumPollGapMilliseconds=[math]::Max($view.maximumPollGapMilliseconds,$now-$previousPoll);$previousPoll=$now;$view.pollCount++
        $pids=[InstallerJobView]::Pids()
        if($pids -notcontains $DriverPid -or $pids -notcontains $PID){throw 'Job identity lost.'}
        foreach($ownedPid in $pids){
            if($ownedPid -eq $PID -or $ownedPid -eq $DriverPid -or !$seen.Add($ownedPid)){continue}
            if($records.Count -ge 64){throw 'Owned process observation lifetime bound exceeded.'}
            $record=[ordered]@{pid=$ownedPid;observedUtc=[datetime]::UtcNow.ToString('o');commandLine=$null;executablePath=$null;queryFailure=$null;queryElapsedMilliseconds=$null;queryStartedMilliseconds=$pollClock.Elapsed.TotalMilliseconds;exitCode=$null;exitQueryFailure=$null}
            # Capture native identity/handles immediately, before asynchronous metadata.
            $handle=[InstallerJobView]::Hold($ownedPid)
            if($handle -ne [IntPtr]::Zero){
                $handles.Add($ownedPid,$handle)
                try{$record.executablePath=[InstallerJobView]::Image($handle)}catch{$record.queryFailure=$_.Exception.Message}
                if($queries.Count -ge 16){throw 'Pending metadata query bound exceeded.'}
                $queries[$ownedPid]=[InstallerJobView]::QueryAsync($ownedPid)
            }else{$record.exitQueryFailure='Owned process exited before a read-only handle could be opened.'}
            $records.Add($record)
        }
        foreach($record in $records){
            if($queries.ContainsKey($record.pid)){
                $query=$queries[$record.pid]
                if($query.IsCompleted){
                    $metadata=$query.Result
                    $record.queryElapsedMilliseconds=$metadata.ElapsedMilliseconds
                    if($metadata.Failure){$record.queryFailure=$metadata.Failure}
                    elseif($metadata.ExecutablePath -ne $record.executablePath){$record.queryFailure='Metadata image differs from the held native process identity.'}
                    else{$record.commandLine=$metadata.CommandLine}
                    $queries.Remove($record.pid)
                }elseif($pollClock.Elapsed.TotalMilliseconds-$record.queryStartedMilliseconds -ge 8000){throw 'Read-only metadata query exceeded its eight-second completion deadline.'}
            }
            if(!$handles.ContainsKey($record.pid)){continue}
            try{
                if($null -eq $record.exitCode){$code=[InstallerJobView]::ExitCode($handles[$record.pid]);if($code -ne 259){$record.exitCode=$code}}
                # Hold identity through metadata completion; an exited PID cannot be reused.
                if($null -ne $record.exitCode -and !$queries.ContainsKey($record.pid)){[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
            }catch{$record.exitQueryFailure=$_.Exception.Message;[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
        }
        # Stop is requested only after the primary installer/updater has exited.
        # The PID list includes child jobs. Require natural exit and completed metadata.
        if((Test-Path -LiteralPath $StopFile) -and $pids.Count -eq 2 -and $handles.Count -eq 0 -and $queries.Count -eq 0){$view.drained=$true;$view.finalPids=$pids;break}
        Start-Sleep -Milliseconds 20
    }while([datetime]::UtcNow -lt $deadline)
    if(!$view.drained){throw 'Installer descendants did not drain within the observer deadline.'}
    $view.passed=$true
}catch{$view.failure=$_.Exception.ToString()}
finally{foreach($handle in $handles.Values){[InstallerJobView]::Release($handle)};$view.finishedUtc=[datetime]::UtcNow.ToString('o');$view.processes=$records.ToArray();$view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ResultFile -Encoding UTF8}
if(!$view.passed){exit 1}
