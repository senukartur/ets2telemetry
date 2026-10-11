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
$initialHandles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
$view=[ordered]@{passed=$false;observerPid=$PID;driverPid=$DriverPid;controllerPid=$ControllerPid;parentProcessId=$null;driverParentProcessId=$null;driverImage=$null;controllerImage=$null;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;failure=$null;drained=$false;finalPids=@();processes=@();initialPidSnapshot=$null;initialScope=$null;initialScopeFailure=$null;jobScope=$null;metadataWorkers=4;metadataQueueSeconds=3;metadataQuerySeconds=3;metadataCompletionSeconds=8;warmupMilliseconds=$null;pollCount=0;maximumPollGapMilliseconds=0}
$view.initialUnexpectedProcesses=@();$view.initialDiagnosticMilliseconds=0;$view.initialDiagnosticFailure=$null
$view.consoleHost=$null;$view.consoleLastExitCode=$null
try {
    $view.initialPidSnapshot=[InstallerJobView]::ReadPids()
    # Preserve unexpected native identities before metadata or the unchanged fresh guard.
    $initialQueries=@{}
    $initialRecords=[Collections.Generic.List[object]]::new();$initialClock=[Diagnostics.Stopwatch]::StartNew()
    try{
        foreach($initialPid in $view.initialPidSnapshot.Pids){
            if($initialPid -eq $DriverPid -or $initialPid -eq $PID){continue}
            $entry=[ordered]@{pid=$initialPid;observedUtc=[datetime]::UtcNow.ToString('o');nativeImage=$null;nativeImageFailure=$null;nativeExitBefore=$null;nativeExitAfter=$null;nativeSignaledBefore=$null;nativeSignaledAfter=$null;nativeExitFailure=$null;parentProcessId=$null;commandLine=$null;metadataImage=$null;metadataFailure=$null;queryElapsedMilliseconds=$null}
            $initialRecords.Add($entry)
            $held=[InstallerJobView]::Hold($initialPid)
            if($held -eq [IntPtr]::Zero){$entry.nativeImageFailure='Unexpected initial PID vanished or could not be held.';continue}
            $initialHandles.Add($initialPid,$held)
            try{$entry.nativeImage=[InstallerJobView]::Image($held)}catch{$entry.nativeImageFailure=$_.Exception.ToString()}
            try{$entry.nativeExitBefore=[InstallerJobView]::ExitCode($held);$entry.nativeSignaledBefore=[InstallerJobView]::Signaled($held)}catch{$entry.nativeExitFailure=$_.Exception.ToString()}
        }
        $view.initialUnexpectedProcesses=$initialRecords.ToArray()
        # Retain native evidence even if the existing controller deadline ends metadata work.
        $view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath ($ResultFile+'.initial.json') -Encoding UTF8
        foreach($entry in $initialRecords){if($initialHandles.ContainsKey($entry.pid)){$initialQueries[$entry.pid]=[InstallerJobView]::QueryAsync($entry.pid)}}
        foreach($entry in $initialRecords){
            if(!$initialQueries.ContainsKey($entry.pid)){continue}
            $query=$initialQueries[$entry.pid];$remaining=[math]::Max(0,1500-[int]$initialClock.ElapsedMilliseconds)
            if($query.Wait($remaining)){
                $metadata=$query.Result;$entry.queryElapsedMilliseconds=$metadata.ElapsedMilliseconds
                if($metadata.Failure){$entry.metadataFailure=$metadata.Failure}
                elseif($metadata.CommandLine.Length -gt 32768 -or $metadata.ExecutablePath.Length -gt 32768){$entry.metadataFailure='Initial metadata exceeds bounded text retention.'}
                else{$entry.parentProcessId=$metadata.ParentProcessId;$entry.commandLine=$metadata.CommandLine;$entry.metadataImage=$metadata.ExecutablePath;if($entry.nativeImage -and $metadata.ExecutablePath -ine $entry.nativeImage){$entry.metadataFailure='Initial metadata image differs from held native identity.'}}
            }else{$entry.metadataFailure='Initial metadata exceeded the aggregate 1500 ms diagnostic allowance.'}
            try{$entry.nativeExitAfter=[InstallerJobView]::ExitCode($initialHandles[$entry.pid]);$entry.nativeSignaledAfter=[InstallerJobView]::Signaled($initialHandles[$entry.pid])}catch{$entry.nativeExitFailure=$_.Exception.ToString()}
        }
    }catch{$view.initialDiagnosticFailure=$_.Exception.ToString()}
    finally{$view.initialUnexpectedProcesses=$initialRecords.ToArray();$view.initialDiagnosticMilliseconds=$initialClock.Elapsed.TotalMilliseconds}
    # Capture immediate-Job limits even when the unchanged fresh-membership gate fails.
    try{$view.initialScope=[InstallerJobView]::ReadScope()}catch{$view.initialScopeFailure=$_.Exception.ToString()}
    $initial=[InstallerJobView]::ValidatePids($view.initialPidSnapshot)
    if($view.initialDiagnosticFailure){throw 'Initial native/metadata proof capture failed.'}
    if($DriverPid -eq $ControllerPid -or $DriverPid -eq $PID -or $ControllerPid -eq $PID -or $initial -notcontains $DriverPid -or $initial -notcontains $PID -or $initial -contains $ControllerPid -or $initial.Count -notin @(2,3) -or @($initial|Select-Object -Unique).Count -ne $initial.Count){throw 'Fresh Job must contain exactly the two roots and at most one audited observer console host.'}
    if($initial.Count -eq 3){
        if($initialRecords.Count -ne 1){throw 'One fully observed console identity required.'}
        $console=$initialRecords[0]
        if($console.nativeImage -ine 'C:\Windows\System32\conhost.exe' -or $console.metadataImage -ine $console.nativeImage -or $console.parentProcessId -ne $PID -or $console.commandLine -ine '\??\C:\Windows\System32\conhost.exe 0x4' -or $console.nativeExitBefore -ne 259 -or $console.nativeExitAfter -ne 259 -or $console.nativeSignaledBefore -ne $false -or $console.nativeSignaledAfter -ne $false -or $console.nativeImageFailure -or $console.nativeExitFailure -or $console.metadataFailure -or $view.initialDiagnosticFailure -or !$initialHandles.ContainsKey($console.pid)){throw 'Unexpected root is not the live, held, fully verified observer-owned System32 console host.'}
        $view.consoleHost=$console
    }
    function Assert-ObserverMembers($members){if($members.Count -ne $initial.Count -or @($members|Where-Object {$_ -notin $initial}).Count -ne 0){throw 'Audited root/console membership changed.'};if($view.consoleHost){$view.consoleLastExitCode=[InstallerJobView]::ExitCode($initialHandles[$view.consoleHost.pid]);if($view.consoleLastExitCode -ne 259 -or [InstallerJobView]::Signaled($initialHandles[$view.consoleHost.pid])){throw 'Held observer console exited before observer completion.'}}}
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
    Assert-ObserverMembers ([InstallerJobView]::Pids())
    $ready=[ordered]@{ready=$true;observerPid=$PID;driverPid=$DriverPid;controllerPid=$ControllerPid;parentProcessId=$view.parentProcessId;driverParentProcessId=$view.driverParentProcessId;driverImage=$view.driverImage;controllerImage=$view.controllerImage;initialPids=$initial;consoleHost=$view.consoleHost;jobScope=$view.jobScope;warmupMilliseconds=$view.warmupMilliseconds}
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
            if($view.consoleHost -and $ownedPid -eq $view.consoleHost.pid){if([InstallerJobView]::ExitCode($initialHandles[$ownedPid]) -ne 259){throw 'Held observer console exited during helper observation.'};continue}
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
        if((Test-Path -LiteralPath $StopFile) -and $pids.Count -eq $initial.Count -and $handles.Count -eq 0 -and $queries.Count -eq 0){Assert-ObserverMembers $pids;$view.drained=$true;$view.finalPids=$pids;break}
        Start-Sleep -Milliseconds 20
    }while([datetime]::UtcNow -lt $deadline)
    if(!$view.drained){throw 'Installer descendants did not drain within the observer deadline.'}
    $view.passed=$true
}catch{$view.failure=$_.Exception.ToString()}
finally{foreach($handle in $handles.Values){[InstallerJobView]::Release($handle)};foreach($handle in $initialHandles.Values){[InstallerJobView]::Release($handle)};$view.finishedUtc=[datetime]::UtcNow.ToString('o');$view.processes=$records.ToArray();$view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ResultFile -Encoding UTF8}
if(!$view.passed){exit 1}
