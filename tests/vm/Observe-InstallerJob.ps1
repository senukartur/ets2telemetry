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
$driverRule=Join-Path $PSScriptRoot 'Assert-InstallerDriverProvenance.ps1'
$driverRuleRow=@($observerManifest.files|Where-Object {$_.path -ceq 'harness/Assert-InstallerDriverProvenance.ps1'})
if($driverRuleRow.Count -ne 1 -or $driverRuleRow[0].sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $driverRule).Hash -ne $driverRuleRow[0].sha256 -or (Get-Item -LiteralPath $driverRule).Length -ne $driverRuleRow[0].bytes){throw 'Sealed initial-driver proof rule preimage mismatch.'}
. $driverRule
$helperRule=Join-Path $PSScriptRoot 'Assert-InstallerHelperProvenance.ps1'
$helperRuleRow=@($observerManifest.files|Where-Object {$_.path -ceq 'harness/Assert-InstallerHelperProvenance.ps1'})
if($helperRuleRow.Count -ne 1 -or $helperRuleRow[0].sha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath $helperRule).Hash -ne $helperRuleRow[0].sha256 -or (Get-Item -LiteralPath $helperRule).Length -ne $helperRuleRow[0].bytes){throw 'Sealed installer-helper proof rule preimage mismatch.'}
. $helperRule
$seen=[Collections.Generic.HashSet[int]]::new()
$records=[Collections.Generic.List[object]]::new()
$handles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
# Completed approved parents retain their original handle until finally; never reopen a PID.
$retiredHandles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
$queries=@{}
$initialHandles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
$view=[ordered]@{passed=$false;observerPid=$PID;driverPid=$DriverPid;controllerPid=$ControllerPid;parentProcessId=$null;driverParentProcessId=$null;driverImage=$null;controllerImage=$null;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;failure=$null;drained=$false;finalPids=@();processes=@();initialPidSnapshot=$null;initialScope=$null;initialScopeFailure=$null;jobScope=$null;metadataWorkers=4;metadataQueueSeconds=3;metadataQuerySeconds=3;metadataCompletionSeconds=8;warmupMilliseconds=$null;pollCount=0;maximumPollGapMilliseconds=0}
$view.initialUnexpectedProcesses=@();$view.initialDiagnosticMilliseconds=0;$view.initialDiagnosticFailure=$null
$view.consoleHost=$null;$view.consoleLastExitCode=$null;$view.driverConsoleHost=$null;$view.driverConsoleLastExitCode=$null
function Read-InstallerNativeErrorCode($failure){
    $current=$failure
    for($depth=0;$depth -lt 8 -and $null -ne $current;$depth++){
        if($current -is [ComponentModel.Win32Exception]){return $current.NativeErrorCode}
        $current=$current.InnerException
    }
    return $null
}
function Set-HelperMetadataDiagnostics($record,$metadata){
    $record.metadataCompleted=$true;$record.metadataImage=$metadata.ExecutablePath;$record.metadataCommandLine=$metadata.CommandLine;$record.metadataParentProcessId=$metadata.ParentProcessId;$record.metadataProviderFailure=$metadata.Failure;$record.metadataQueryElapsedMilliseconds=$metadata.ElapsedMilliseconds
    $record.metadataRequestedProcessId=$metadata.RequestedProcessId;$record.metadataProcessId=$metadata.ProcessId;$record.metadataHandle=$metadata.Handle;$record.metadataObjectPath=$metadata.ObjectPath;$record.metadataClassName=$metadata.ClassName
    try{$record.metadataImageObservation=Read-InstallerHelperImageObservation $metadata $record.executablePath}catch{$record.metadataImageObservation='invalid'}
    foreach($key in @('metadataImage','metadataCommandLine','metadataProviderFailure','metadataProcessId','metadataHandle','metadataObjectPath','metadataClassName','nativeImageAfterQuery','nativeImageAfterQueryFailure','nativeExitAfterQueryFailure')){if($record[$key] -is [string] -and $record[$key].Length -gt 4096){$record[$key]=$record[$key].Substring(0,4096);$record.diagnosticTruncatedFields+=@($key)}}
}
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
    function Assert-ObserverMembers($members){$expected=@($initial);if($view.driverConsoleHost){$expected+=@($view.driverConsoleHost.pid)};if($members.Count -ne $expected.Count -or @($members|Where-Object {$_ -notin $expected}).Count -ne 0){throw 'Audited root/console membership changed.'};foreach($role in @(@{host=$view.consoleHost;key='consoleLastExitCode'},@{host=$view.driverConsoleHost;key='driverConsoleLastExitCode'})){if($role.host){$view[$role.key]=[InstallerJobView]::ExitCode($initialHandles[$role.host.pid]);if($view[$role.key] -ne 259 -or [InstallerJobView]::Signaled($initialHandles[$role.host.pid])){throw 'Held root console exited before observer completion.'}}}}
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
    $view.driverProvenance=[ordered]@{phase='pre-resume-suspended-driver';pid=$DriverPid;nativeHandleHeld=$false;nativeImageBefore=$null;nativeExitBefore=$null;nativeSignaledBefore=$null;nativeFailureBefore=$null;nativeImageAfter=$null;nativeExitAfter=$null;nativeSignaledAfter=$null;nativeFailureAfter=$null;metadataImage=$null;metadataParentProcessId=$null;metadataCommandLine=$null;metadataFailure=$null;metadataCompleted=$false;queryElapsedMilliseconds=$null;waitElapsedMilliseconds=$null;diagnosticFailure=$null;textLimitCharacters=4096;truncatedFields=@()}
    function Save-DriverProvenance([string]$suffix){
        foreach($key in @('nativeImageBefore','nativeImageAfter','nativeFailureBefore','nativeFailureAfter','metadataImage','metadataCommandLine','metadataFailure','diagnosticFailure')){if($null -ne $view.driverProvenance[$key] -and $view.driverProvenance[$key].Length -gt 4096){$view.driverProvenance[$key]=$view.driverProvenance[$key].Substring(0,4096);if($view.driverProvenance.truncatedFields -notcontains $key){$view.driverProvenance.truncatedFields+=@($key)}}}
        try{$view.driverProvenance|ConvertTo-Json -Depth 3|Set-Content -LiteralPath ($ResultFile+$suffix) -Encoding UTF8}catch{$view.driverProvenance.diagnosticFailure=$_.Exception.Message.Substring(0,[math]::Min(4096,$_.Exception.Message.Length))}
    }
    $driverIdentity=[IntPtr]::Zero
    try{
        try{
            $driverIdentity=[InstallerJobView]::Hold($DriverPid);$view.driverProvenance.nativeHandleHeld=$driverIdentity -ne [IntPtr]::Zero
            if($driverIdentity -eq [IntPtr]::Zero){throw 'Suspended driver diagnostic identity could not be held.'}
            $view.driverProvenance.nativeImageBefore=[InstallerJobView]::Image($driverIdentity);$view.driverProvenance.nativeExitBefore=[InstallerJobView]::ExitCode($driverIdentity);$view.driverProvenance.nativeSignaledBefore=[InstallerJobView]::Signaled($driverIdentity)
        }catch{$view.driverProvenance.nativeFailureBefore=$_.Exception.ToString()}
        Save-DriverProvenance '.driver-before.json'
        $driverMetadata=[InstallerJobView]::QueryAsync($DriverPid);$driverWait=[Diagnostics.Stopwatch]::StartNew()
        try{
            $view.driverProvenance.metadataCompleted=$driverMetadata.Wait(5000)
            if($view.driverProvenance.metadataCompleted){$view.driverProvenance.metadataImage=$driverMetadata.Result.ExecutablePath;$view.driverProvenance.metadataParentProcessId=$driverMetadata.Result.ParentProcessId;$view.driverProvenance.metadataCommandLine=$driverMetadata.Result.CommandLine;$view.driverProvenance.metadataFailure=$driverMetadata.Result.Failure;$view.driverProvenance.queryElapsedMilliseconds=$driverMetadata.Result.ElapsedMilliseconds}else{$view.driverProvenance.metadataFailure='Existing suspended sibling metadata wait exceeded 5000 ms.'}
        }catch{$view.driverProvenance.metadataFailure=$_.Exception.ToString();throw}
        finally{
            $view.driverProvenance.waitElapsedMilliseconds=$driverWait.Elapsed.TotalMilliseconds
            try{if($driverIdentity -ne [IntPtr]::Zero){$view.driverProvenance.nativeImageAfter=[InstallerJobView]::Image($driverIdentity);$view.driverProvenance.nativeExitAfter=[InstallerJobView]::ExitCode($driverIdentity);$view.driverProvenance.nativeSignaledAfter=[InstallerJobView]::Signaled($driverIdentity)}}catch{$view.driverProvenance.nativeFailureAfter=$_.Exception.ToString()}
            Save-DriverProvenance '.driver-provenance.json'
        }
        if(!$view.driverProvenance.metadataCompleted -or $driverMetadata.Result.Failure){throw 'Suspended sibling metadata query failed.'}
        $view.driverParentProcessId=$driverMetadata.Result.ParentProcessId
        $receiptStream=[IO.File]::Open((Join-Path (Split-Path -Parent $ResultFile) 'job/controller-receipt.json'),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        try{
            $receiptBytes=[byte[]]::new(8193);$receiptKept=0
            while($receiptKept -lt $receiptBytes.Length){$receiptRead=$receiptStream.Read($receiptBytes,$receiptKept,$receiptBytes.Length-$receiptKept);if($receiptRead -eq 0){break};$receiptKept+=$receiptRead}
            if($receiptKept -gt 8192){throw 'Initial controller receipt exceeds 8 KiB.'}
        }finally{$receiptStream.Dispose()}
        $receipt=[Text.Encoding]::UTF8.GetString($receiptBytes,0,$receiptKept).TrimStart([char]0xfeff)|ConvertFrom-Json
        $rawProof=[ordered]@{};foreach($key in $view.driverProvenance.Keys){$rawProof[$key]=$view.driverProvenance[$key]}
        # Compare original WMI values; bounded diagnostic copies cannot authorize a match.
        $rawProof.metadataImage=$driverMetadata.Result.ExecutablePath;$rawProof.metadataCommandLine=$driverMetadata.Result.CommandLine;$rawProof.metadataFailure=$driverMetadata.Result.Failure
        $view.driverProvenance.policy=Assert-InstallerDriverProvenance $rawProof $receipt $initial $view.jobScope $DriverPid $PID $ControllerPid 'C:\ETS2ET001Acceptance\tools\node.exe' $view.consoleHost.pid
    }finally{if($driverIdentity -ne [IntPtr]::Zero){[InstallerJobView]::Release($driverIdentity)}}
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
            $record=[ordered]@{pid=$ownedPid;observedUtc=[datetime]::UtcNow.ToString('o');commandLine=$null;executablePath=$null;parentProcessId=$null;role='installer-helper';nativeIdentityHeld=$false;nativeIdentityRetired=$false;nativeFinalSignaled=$false;metadataPolicy=$null;nativeExitBefore=$null;nativeSignaledBefore=$null;queryFailure=$null;queryElapsedMilliseconds=$null;queryStartedMilliseconds=$pollClock.Elapsed.TotalMilliseconds;exitCode=$null;exitQueryFailure=$null;metadataCompleted=$false;metadataImage=$null;metadataImageObservation=$null;metadataRequestedProcessId=$null;metadataProcessId=$null;metadataHandle=$null;metadataObjectPath=$null;metadataClassName=$null;metadataCommandLine=$null;metadataParentProcessId=$null;metadataProviderFailure=$null;metadataQueryElapsedMilliseconds=$null;nativeImageAfterQuery=$null;nativeImageAfterQueryFailure=$null;nativeImageAfterQueryErrorCode=$null;nativeImageAttemptedAfterQuery=$false;nativeAfterQueryProof=$null;nativeExitAfterQuery=$null;nativeSignaledAfterQuery=$null;nativeExitAfterQueryFailure=$null;diagnosticTextLimitCharacters=4096;diagnosticTruncatedFields=@()}
            # Capture native identity/handles immediately, before asynchronous metadata.
            $handle=[InstallerJobView]::Hold($ownedPid)
            if($handle -ne [IntPtr]::Zero){
                $handles.Add($ownedPid,$handle)
                $record.nativeIdentityHeld=$true
                try{$record.executablePath=[InstallerJobView]::Image($handle);$record.nativeExitBefore=[InstallerJobView]::ExitCode($handle);$record.nativeSignaledBefore=[InstallerJobView]::Signaled($handle)}catch{$record.queryFailure=$_.Exception.Message}
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
                    # Capture once, then resolve pending parents using this same completed query.
                    if(!$record.metadataCompleted){
                        if($handles.ContainsKey($record.pid)){
                            if($record.executablePath -ieq 'C:\Windows\System32\conhost.exe'){
                                # Console proof stays live/image strict and keeps its existing ordering.
                                $record.nativeImageAttemptedAfterQuery=$true
                                try{$record.nativeImageAfterQuery=[InstallerJobView]::Image($handles[$record.pid])}catch{$record.nativeImageAfterQueryFailure=$_.Exception.ToString();$record.nativeImageAfterQueryErrorCode=Read-InstallerNativeErrorCode $_.Exception}
                                try{$record.nativeExitAfterQuery=[InstallerJobView]::ExitCode($handles[$record.pid]);$record.nativeSignaledAfterQuery=[InstallerJobView]::Signaled($handles[$record.pid])}catch{$record.nativeExitAfterQueryFailure=$_.Exception.ToString()}
                            }else{
                                # The retained process object is authoritative after terminal exit 0.
                                try{$record.nativeSignaledAfterQuery=[InstallerJobView]::Signaled($handles[$record.pid]);$record.nativeExitAfterQuery=[InstallerJobView]::ExitCode($handles[$record.pid])}catch{$record.nativeExitAfterQueryFailure=$_.Exception.ToString()}
                                if($null -eq $record.nativeExitAfterQueryFailure -and !($record.nativeSignaledAfterQuery -and $record.nativeExitAfterQuery -eq 0)){
                                    $record.nativeImageAttemptedAfterQuery=$true
                                    try{$record.nativeImageAfterQuery=[InstallerJobView]::Image($handles[$record.pid])}catch{
                                        $record.nativeImageAfterQueryFailure=$_.Exception.ToString();$record.nativeImageAfterQueryErrorCode=Read-InstallerNativeErrorCode $_.Exception
                                        # One fixed zero-time same-handle check resolves an image/exit race.
                                        try{$record.nativeSignaledAfterQuery=[InstallerJobView]::Signaled($handles[$record.pid]);$record.nativeExitAfterQuery=[InstallerJobView]::ExitCode($handles[$record.pid])}catch{$record.nativeExitAfterQueryFailure=$_.Exception.ToString()}
                                    }
                                }
                            }
                        }else{$record.nativeImageAfterQueryFailure='Existing metadata query has no retained native identity.'}
                        Set-HelperMetadataDiagnostics $record $metadata
                    }
                    if($record.executablePath -ieq 'C:\Windows\System32\conhost.exe'){
                        # Console identities never use the non-console null-image policy.
                        if($metadata.Failure -or $null -eq $metadata.ExecutablePath -or $metadata.ExecutablePath -ine $record.executablePath -or $record.diagnosticTruncatedFields.Count){throw 'Console helper metadata image or observation differs.'}
                        $record.metadataPolicy='strict-console-image'
                    }else{
                        try{$record.nativeAfterQueryProof=Assert-InstallerHelperNativeAfter $record;$policy=Assert-InstallerHelperProvenance $record $metadata $records $DriverPid $PID $ControllerPid @($view.consoleHost.pid,$view.driverConsoleHost.pid)}catch{$record.queryFailure=$_.Exception.Message;throw}
                        if($policy -eq 'pending-audited-parent'){
                            if($pollClock.Elapsed.TotalMilliseconds-$record.queryStartedMilliseconds -ge 8000){throw 'Helper parent approval exceeded the existing eight-second completion deadline.'}
                            continue
                        }
                        $record.metadataPolicy=$policy
                    }
                    $record.commandLine=$metadata.CommandLine;$record.parentProcessId=$metadata.ParentProcessId
                    $queries.Remove($record.pid)
                    if($record.executablePath -ieq 'C:\Windows\System32\conhost.exe' -and $record.parentProcessId -eq $DriverPid){
                        if($view.driverConsoleHost -or !$handles.ContainsKey($record.pid) -or $initial -contains $record.pid -or $record.pid -eq $ControllerPid){throw 'Late driver console duplicates or overlaps an existing role.'}
                        $held=$handles[$record.pid];$after=[InstallerJobView]::ExitCode($held);$signaled=[InstallerJobView]::Signaled($held)
                        if($record.commandLine -ine '\??\C:\Windows\System32\conhost.exe 0x4' -or $record.nativeExitBefore -ne 259 -or $record.nativeSignaledBefore -ne $false -or $after -ne 259 -or $signaled -or $record.queryFailure -or $record.exitQueryFailure){throw 'Late driver console metadata or native liveness is invalid.'}
                        $view.driverConsoleHost=[ordered]@{pid=$record.pid;nativeImage=$record.executablePath;metadataImage=$metadata.ExecutablePath;parentProcessId=$metadata.ParentProcessId;commandLine=$record.commandLine;nativeExitBefore=$record.nativeExitBefore;nativeExitAfter=$after;nativeSignaledBefore=$record.nativeSignaledBefore;nativeSignaledAfter=$signaled;nativeImageFailure=$null;nativeExitFailure=$null;metadataFailure=$null;queryElapsedMilliseconds=$record.queryElapsedMilliseconds}
                        $record.role='driver-console';$initialHandles.Add($record.pid,$held);$null=$handles.Remove($record.pid)
                        $lateFile=Join-Path (Split-Path -Parent $ReadyFile) 'late-driver-console.json'
                        [ordered]@{phase='late-driver-console';driverPid=$DriverPid;observerPid=$PID;controllerPid=$ControllerPid;consoleHost=$view.driverConsoleHost}|ConvertTo-Json -Depth 4 -Compress|Set-Content -LiteralPath ($lateFile+'.partial') -Encoding UTF8
                        Move-Item -LiteralPath ($lateFile+'.partial') -Destination $lateFile
                    }
                }elseif($pollClock.Elapsed.TotalMilliseconds-$record.queryStartedMilliseconds -ge 8000){throw 'Read-only metadata query exceeded its eight-second completion deadline.'}
            }
            if(!$handles.ContainsKey($record.pid)){continue}
            try{
                if([InstallerJobView]::Signaled($handles[$record.pid])){
                    $record.nativeFinalSignaled=$true;$record.exitCode=[InstallerJobView]::ExitCode($handles[$record.pid])
                    if(!$queries.ContainsKey($record.pid)){
                        Assert-InstallerHelperExit $record
                        # Retain the very same approved parent identity; no release/reopen window.
                        $retiredHandles.Add($record.pid,$handles[$record.pid]);$null=$handles.Remove($record.pid);$record.nativeIdentityRetired=$true
                    }
                }
            }catch{$record.exitQueryFailure=$_.Exception.Message;throw}
        }
        # Stop is requested only after the primary installer/updater has exited.
        # The PID list includes child jobs. Require natural exit and completed metadata.
        if((Test-Path -LiteralPath $StopFile) -and $pids.Count -eq ($initial.Count+[int][bool]$view.driverConsoleHost) -and $handles.Count -eq 0 -and $queries.Count -eq 0){Assert-ObserverMembers $pids;foreach($record in $records){if($record.role -ne 'driver-console'){Assert-InstallerHelperExit $record;if(!$record.nativeIdentityRetired -or !$retiredHandles.ContainsKey($record.pid)){throw 'Completed helper parent identity was not continuously retained.'}}};$view.drained=$true;$view.finalPids=$pids;break}
        Start-Sleep -Milliseconds 20
    }while([datetime]::UtcNow -lt $deadline)
    if(!$view.drained){throw 'Installer descendants did not drain within the observer deadline.'}
    $view.passed=$true
}catch{$view.failure=$_.Exception.ToString()}
finally{foreach($handle in $handles.Values){[InstallerJobView]::Release($handle)};foreach($handle in $retiredHandles.Values){[InstallerJobView]::Release($handle)};foreach($handle in $initialHandles.Values){[InstallerJobView]::Release($handle)};$view.finishedUtc=[datetime]::UtcNow.ToString('o');$view.processes=$records.ToArray();$view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ResultFile -Encoding UTF8}
if(!$view.passed){exit 1}
