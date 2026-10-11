# Pure helper proof rules. No native APIs, process creation, queries or file access.
function Assert-InstallerAccountingContext($guard,$manifest,[string]$manifestSha256,[string]$directory,[string]$readyFile,[string]$stopFile,[string]$resultFile,[string]$binaryRoot,[datetime]$now){
    $kit='C:\ETS2ET001Acceptance'
    if($directory -notmatch '^C:\\ETS2ET001Acceptance\\evidence\\[a-fA-F0-9]{32}\\step-([1-6])-(install|repair|smoke|update|uninstall)-(0\.1\.[01])$'){throw 'Accounting context paths differ from the controlled step.'}
    $index=[int]$Matches[1];$step=$Matches[2];$version=$Matches[3]
    if($readyFile -ine ($directory+'\observer-ready.json') -or $stopFile -ine ($directory+'\observer-stop.json') -or $resultFile -ine ($directory+'\job-observation.json')){throw 'Accounting context paths differ from the controlled step.'}
    $definitions=@(@('install','0.1.0',45000),@('repair','0.1.0',45000),@('smoke','0.1.0',30000),@('update','0.1.1',45000),@('smoke','0.1.1',30000),@('uninstall','0.1.1',30000))
    if($manifestSha256 -notmatch '^[a-fA-F0-9]{64}$' -or $guard.manifestSha256 -ine $manifestSha256 -or $guard.vmUuid -cne '94674D56-D803-F4D5-9AAC-C4E91CFB475F' -or $guard.labId -cne '9a047927-f94b-41cb-bda8-abcc7d0b76f1' -or $guard.jobRequired -isnot [bool] -or !$guard.jobRequired -or $guard.step -cne $step -or $guard.version -cne $version -or $definitions[$index-1][0] -cne $step -or $definitions[$index-1][1] -cne $version -or $guard.binaryRoot -ine $binaryRoot -or $manifest.schemaVersion -ne 1 -or $manifest.kind -cne 'et001-installer' -or $manifest.guestRoot -cne $kit -or $manifest.guestUuid -cne $guard.vmUuid -or $manifest.labId -cne $guard.labId -or $manifest.fixtureOnly -isnot [bool] -or !$manifest.fixtureOnly -or $manifest.applicationVersion -cne '0.1.0' -or $manifest.fixtureVersion -cne '0.1.1'){throw 'Accounting context manifest, lab identity or step differs.'}
    $verified=[datetime]::MinValue;$outer=[datetime]::MinValue
    if($guard.verifiedUtc -isnot [string] -or $guard.outerDeadlineUtc -isnot [string] -or ![datetime]::TryParse($guard.verifiedUtc,[ref]$verified) -or ![datetime]::TryParse($guard.outerDeadlineUtc,[ref]$outer)){throw 'Accounting context timestamps are malformed.'}
    $age=($now-$verified.ToUniversalTime()).TotalSeconds
    if($age -lt 0 -or $age -ge 90 -or $outer.ToUniversalTime() -le $now){throw 'Accounting context guard has expired.'}
    $row=@($manifest.runtimeFiles|Where-Object {$_.path -ceq 'ETS2TelemetryDesktop.exe'})
    if($row.Count -ne 1 -or $row[0].sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $row[0].bytes -le 0){throw 'Accounting context has no exact sealed app image.'}
    $versions=if($step -ceq 'update'){@('0.1.0','0.1.1')}else{@($version)}
    $images=@($versions|ForEach-Object {@{path=($binaryRoot+'\app-'+$_+'\ETS2TelemetryDesktop.exe');sha256=$row[0].sha256;bytes=$row[0].bytes}})
    return @{manifestSha256=$manifestSha256;directory=$directory;step=$step;version=$version;maximumMilliseconds=$definitions[$index-1][2];expectedImages=$images}
}
function Assert-InstallerAccountingCommand($context,$receipt,[int]$driverPid,[int]$observerPid,[int]$controllerPid){
    $expectedArgs=@('C:\ETS2ET001Acceptance\tools\node.exe','C:\ETS2ET001Acceptance\harness\installer-step.mjs','C:\ETS2ET001Acceptance',$context.directory,($context.directory+'\step-guard.json'),$context.step,$context.version)
    foreach($arg in $expectedArgs){if($arg -isnot [string] -or $arg -match '["\r\n]' -or $arg.EndsWith('\')){throw 'Accounting context contains command delimiters.'}}
    $prefix=(@($expectedArgs|ForEach-Object {'"'+$_+'"'}) -join ' ')+' '
    if($receipt.driverPid -ne $driverPid -or $receipt.observerPid -ne $observerPid -or $receipt.controllerPid -ne $controllerPid -or $receipt.driverCommandLine -isnot [string] -or !$receipt.driverCommandLine.StartsWith($prefix,[StringComparison]::Ordinal)){throw 'Accounting context differs from the exact created driver command.'}
    $budgetText=$receipt.driverCommandLine.Substring($prefix.Length)
    if($budgetText -notmatch '^"([0-9]{5})"$'){throw 'Accounting context differs from the exact created driver command.'}
    $budget=[int]$Matches[1]
    if($budget -lt 10000 -or $budget -gt $context.maximumMilliseconds){throw 'Accounting context created budget exceeds the existing step bounds.'}
    return $budget
}
function Read-InstallerHelperExecutable($command){
    if($command -isnot [string] -or !$command -or $command -match '[\x00\r\n]' -or [char]::IsWhiteSpace($command[0])){throw 'Helper executable token is missing or malformed.'}
    if($command[0] -eq '"'){
        $end=$command.IndexOf('"',1)
        if($end -le 1 -or ($end+1 -lt $command.Length -and $command[$end+1] -notin @(' ',"`t"))){throw 'Helper executable token is missing or malformed.'}
        $token=$command.Substring(1,$end-1)
    }else{
        $token=($command -split '[ \t]',2)[0]
        if($token.Contains('"')){throw 'Helper executable token is missing or malformed.'}
    }
    if($token -notmatch '^(?:[A-Za-z]:\\|\\\\[^\\]+\\[^\\]+\\)' -or $token.Contains('"')){throw 'Helper executable token is missing or malformed.'}
    return $token
}
function Read-InstallerHelperImageObservation($metadata,[string]$nativeImage){
    if($null -eq $metadata.PSObject.Properties['ExecutablePath']){throw 'Helper metadata operands are missing.'}
    if($null -eq $metadata.ExecutablePath){return 'explicit-null'}
    if($metadata.ExecutablePath -isnot [string] -or !$metadata.ExecutablePath){throw 'Helper advisory metadata image is empty or malformed.'}
    if([string]::Equals($metadata.ExecutablePath,$nativeImage,[StringComparison]::OrdinalIgnoreCase)){return 'matched-native'}
    return 'advisory-mismatch'
}
function Assert-InstallerHelperMetadataKey($record,$metadata){
    foreach($key in @('RequestedProcessId','ProcessId','Handle','ObjectPath','ClassName')){if($null -eq $metadata.PSObject.Properties[$key]){throw 'Helper returned metadata identity operands are missing.'}}
    $keyText=$record.pid.ToString([Globalization.CultureInfo]::InvariantCulture)
    $keyPaths=@(('Win32_Process.Handle="'+$keyText+'"'),("Win32_Process.Handle='"+$keyText+"'"))
    if($metadata.RequestedProcessId -isnot [int] -or $metadata.RequestedProcessId -ne $record.pid -or ($metadata.ProcessId -isnot [uint32] -and $metadata.ProcessId -isnot [int]) -or $metadata.ProcessId -ne $record.pid -or $metadata.Handle -isnot [string] -or ![string]::Equals($metadata.Handle,$keyText,[StringComparison]::Ordinal) -or $metadata.ClassName -isnot [string] -or ![string]::Equals($metadata.ClassName,'Win32_Process',[StringComparison]::OrdinalIgnoreCase) -or $metadata.ObjectPath -isnot [string] -or !(@($keyPaths|Where-Object {[string]::Equals($_,$metadata.ObjectPath,[StringComparison]::OrdinalIgnoreCase)}).Count)){throw 'Helper returned WMI process key or class differs.'}
}
function Assert-InstallerHelperNativeAfter($record){
    foreach($key in @('nativeImageAttemptedAfterQuery','nativeImageAfterQuery','nativeImageAfterQueryFailure','nativeImageAfterQueryErrorCode','nativeExitAfterQuery','nativeSignaledAfterQuery','nativeExitAfterQueryFailure')){if(!$record.Contains($key)){throw 'Helper after-query native operands are missing.'}}
    if($record.nativeImageAttemptedAfterQuery -isnot [bool] -or $record.nativeSignaledAfterQuery -isnot [bool] -or $null -ne $record.nativeExitAfterQueryFailure -or $record.nativeExitAfterQuery -notin @(259,0) -or ($record.nativeExitAfterQuery -eq 259 -and $record.nativeSignaledAfterQuery) -or ($null -ne $record.nativeImageAfterQueryErrorCode -and $record.nativeImageAfterQueryErrorCode -isnot [int])){throw 'Helper after-query native state is invalid.'}
    # A successfully returned differing image is never an acceptable terminal observation.
    if($null -ne $record.nativeImageAfterQuery -and ($record.nativeImageAfterQuery -isnot [string] -or ![string]::Equals($record.nativeImageAfterQuery,$record.executablePath,[StringComparison]::OrdinalIgnoreCase))){throw 'Helper successful after-query native image differs.'}
    if(!$record.nativeImageAttemptedAfterQuery){
        if($record.nativeSignaledAfterQuery -and $record.nativeExitAfterQuery -eq 0 -and $null -eq $record.nativeImageAfterQuery -and $null -eq $record.nativeImageAfterQueryFailure -and $null -eq $record.nativeImageAfterQueryErrorCode){return 'terminal-held-identity'}
        throw 'Helper skipped after-query image without terminal exit 0.'
    }
    if($null -eq $record.nativeImageAfterQueryFailure -and $null -eq $record.nativeImageAfterQueryErrorCode -and $null -ne $record.nativeImageAfterQuery){return 'live-image'}
    if($record.nativeImageAfterQueryFailure -is [string] -and $record.nativeImageAfterQueryFailure.Length -gt 0 -and $null -eq $record.nativeImageAfterQuery -and $record.nativeSignaledAfterQuery -and $record.nativeExitAfterQuery -eq 0){return 'terminal-after-image-race'}
    throw 'Helper failed after-query image lacks same-handle terminal exit 0.'
}
function Resolve-InstallerHelperParent($record,$records,[int]$driverPid,[int]$observerPid,[int]$controllerPid,$consolePids){
    $forbidden=@($observerPid,$controllerPid)+@($consolePids)
    $seen=[Collections.Generic.HashSet[int]]::new();$null=$seen.Add($record.pid)
    $parent=$record.metadataParentProcessId;$pending=$false
    while($parent -ne $driverPid){
        if($null -eq $parent -or $parent -le 0 -or $forbidden -contains $parent -or !$seen.Add($parent)){throw 'Helper parent chain is unknown, conflicted or cyclic.'}
        $parentRecords=@($records|Where-Object {$_.pid -eq $parent})
        if($parentRecords.Count -ne 1){throw 'Helper parent chain is unknown, conflicted or cyclic.'}
        $ancestor=$parentRecords[0]
        if($ancestor.role -cne 'installer-helper' -or $ancestor.executablePath -ieq 'C:\Windows\System32\conhost.exe' -or $ancestor.nativeIdentityHeld -ne $true -or $null -ne $ancestor.queryFailure -or $null -ne $ancestor.exitQueryFailure -or $null -ne $ancestor.nativeExitAfterQueryFailure -or ($null -ne $ancestor.exitCode -and $ancestor.exitCode -ne 0) -or ($ancestor.nativeIdentityRetired -eq $true -and ($ancestor.nativeFinalSignaled -ne $true -or $ancestor.exitCode -ne 0))){throw 'Helper parent proof failed or belongs to another role.'}
        if($ancestor.metadataCompleted -eq $true){try{$parentNative=Assert-InstallerHelperNativeAfter $ancestor;if($ancestor.nativeAfterQueryProof -cne $parentNative){throw 'Parent native classification differs.'}}catch{throw 'Helper parent proof failed or belongs to another role.'}}
        if($ancestor.metadataPolicy -notin @('held-native-helper-wmi-null','held-native-helper-wmi-image','held-native-helper-wmi-advisory-mismatch')){
            if($ancestor.metadataCompleted -eq $true -and ($null -ne $ancestor.metadataProviderFailure -or $ancestor.diagnosticTruncatedFields.Count -ne 0)){throw 'Helper parent proof failed or belongs to another role.'}
            $pending=$true
            if($ancestor.metadataCompleted -ne $true){return 'pending-audited-parent'}
        }
        $parent=$ancestor.metadataParentProcessId
    }
    if($pending){return 'pending-audited-parent'}
    return 'driver-anchored'
}
function Assert-InstallerHelperProvenance($record,$metadata,$records,[int]$driverPid,[int]$observerPid,[int]$controllerPid,$consolePids){
    foreach($key in @('nativeIdentityHeld','metadataCompleted','queryFailure','exitQueryFailure','diagnosticTruncatedFields','executablePath','nativeExitBefore','nativeSignaledBefore','nativeAfterQueryProof','metadataParentProcessId')){if(!$record.Contains($key)){throw 'Helper native observation operands are missing.'}}
    if($null -eq $metadata.PSObject.Properties['ExecutablePath'] -or $null -eq $metadata.PSObject.Properties['CommandLine'] -or $null -eq $metadata.PSObject.Properties['ParentProcessId'] -or $null -eq $metadata.PSObject.Properties['Failure']){throw 'Helper metadata operands are missing.'}
    $roots=@($driverPid,$observerPid,$controllerPid)
    if(@($roots|Where-Object {$_ -le 0}).Count -or @($roots|Select-Object -Unique).Count -ne 3 -or $record.pid -le 0 -or $roots -contains $record.pid -or $consolePids -contains $record.pid -or @($records|Where-Object {$_.pid -eq $record.pid}).Count -ne 1 -or $record.role -cne 'installer-helper' -or $record.executablePath -ieq 'C:\Windows\System32\conhost.exe'){throw 'Helper identity duplicates or overlaps another role.'}
    if($record.nativeIdentityHeld -isnot [bool] -or !$record.nativeIdentityHeld -or $record.metadataCompleted -isnot [bool] -or !$record.metadataCompleted -or $null -ne $metadata.Failure -or $null -ne $record.queryFailure -or $null -ne $record.exitQueryFailure -or $null -eq $record.diagnosticTruncatedFields -or $record.diagnosticTruncatedFields.Count -ne 0){throw 'Helper metadata observation is incomplete or clipped.'}
    if($record.executablePath -isnot [string] -or !$record.executablePath -or $record.nativeExitBefore -ne 259 -or $record.nativeSignaledBefore -isnot [bool] -or $record.nativeSignaledBefore){throw 'Helper held initial native identity or liveness differs.'}
    $afterProof=Assert-InstallerHelperNativeAfter $record
    if($record.nativeAfterQueryProof -cne $afterProof){throw 'Helper after-query native classification differs.'}
    Assert-InstallerHelperMetadataKey $record $metadata
    $imageObservation=Read-InstallerHelperImageObservation $metadata $record.executablePath
    $token=Read-InstallerHelperExecutable $metadata.CommandLine
    if(![string]::Equals($token,$record.executablePath,[StringComparison]::OrdinalIgnoreCase)){throw 'Helper command executable differs from its native image.'}
    if($metadata.ParentProcessId -ne $record.metadataParentProcessId){throw 'Helper recorded parent differs from its original metadata.'}
    $parent=Resolve-InstallerHelperParent $record $records $driverPid $observerPid $controllerPid $consolePids
    if($parent -eq 'pending-audited-parent'){return $parent}
    if($imageObservation -eq 'explicit-null'){return 'held-native-helper-wmi-null'}
    if($imageObservation -eq 'advisory-mismatch'){return 'held-native-helper-wmi-advisory-mismatch'}
    return 'held-native-helper-wmi-image'
}
function Assert-InstallerHelperExit($record){
    foreach($key in @('metadataPolicy','nativeFinalSignaled','exitCode','queryFailure','exitQueryFailure')){if(!$record.Contains($key)){throw 'Helper final native signaled exit 0 proof is incomplete.'}}
    if($record.metadataPolicy -notin @('held-native-helper-wmi-null','held-native-helper-wmi-image','held-native-helper-wmi-advisory-mismatch','strict-console-image','terminal-metadata-unresolved') -or $record.nativeFinalSignaled -isnot [bool] -or !$record.nativeFinalSignaled -or $record.exitCode -ne 0 -or $null -ne $record.queryFailure -or $null -ne $record.exitQueryFailure){throw 'Helper final native signaled exit 0 proof is incomplete.'}
    if(($record.metadataPolicy -ceq 'terminal-metadata-unresolved') -ne ($record.role -ceq 'terminal-metadata-unresolved')){throw 'Terminal accounting role or policy was changed.'}
}
function Assert-InstallerTerminalAccounting($record,$metadata,$records,$expectedImages,[int]$driverPid,[int]$observerPid,[int]$controllerPid,$consolePids){
    $roots=@($driverPid,$observerPid,$controllerPid)
    if(@($roots|Where-Object {$_ -le 0}).Count -or @($roots|Select-Object -Unique).Count -ne 3 -or $record.pid -le 0 -or $roots -contains $record.pid -or $consolePids -contains $record.pid -or @($records|Where-Object {$_.pid -eq $record.pid}).Count -ne 1 -or $record.role -cne 'installer-helper'){throw 'Terminal accounting identity overlaps another role.'}
    foreach($key in @('RequestedProcessId','ProcessId','Handle','ObjectPath','ClassName','ExecutablePath','CommandLine','ParentProcessId','Failure','FailureStage','ManagementErrorCode')){if($null -eq $metadata.PSObject.Properties[$key]){throw 'Terminal accounting typed metadata operands are missing.'}}
    if($metadata.RequestedProcessId -isnot [int] -or $metadata.RequestedProcessId -ne $record.pid -or $metadata.Failure -isnot [string] -or !$metadata.Failure -or $metadata.FailureStage -cne 'get' -or $metadata.ManagementErrorCode -isnot [int] -or $metadata.ManagementErrorCode -ne -2147217406){throw 'Terminal accounting requires typed single-Get NotFound.'}
    foreach($key in @('ProcessId','Handle','ObjectPath','ClassName','ExecutablePath','CommandLine')){if($null -ne $metadata.$key){throw 'Terminal accounting cannot consume partial returned metadata.'}}
    if($metadata.ParentProcessId -isnot [int] -or $metadata.ParentProcessId -ne 0 -or $null -ne $record.commandLine -or $null -ne $record.parentProcessId){throw 'Terminal accounting cannot invent arguments or ancestry.'}
    if($record.nativeIdentityHeld -ne $true -or $record.nativeExitBefore -ne 259 -or $record.nativeSignaledBefore -isnot [bool] -or $record.nativeSignaledBefore -or $record.metadataCompleted -ne $true -or $record.queryFailure -or $record.exitQueryFailure -or $null -eq $record.diagnosticTruncatedFields -or $record.diagnosticTruncatedFields.Count){throw 'Terminal accounting native or metadata custody is incomplete.'}
    $custody=$record.nativeCustody
    if(!$custody -or $null -ne $custody.failure -or $custody.exitCode -ne 259 -or $custody.signaled -isnot [bool] -or $custody.signaled -or !$custody.snapshot -or !$custody.scope){throw 'Terminal accounting live Job custody is incomplete.'}
    $pids=@($custody.snapshot.Pids)
    if($custody.snapshot.AssignedCount -ne $pids.Count -or $custody.snapshot.ListedCount -ne $pids.Count -or $pids.Count -lt 3 -or $pids.Count -gt 16 -or @($pids|Select-Object -Unique).Count -ne $pids.Count -or @($pids|Where-Object {$_ -le 0}).Count -or $pids -notcontains $record.pid -or $pids -notcontains $driverPid -or $pids -notcontains $observerPid -or $pids -contains $controllerPid){throw 'Terminal accounting Job membership differs.'}
    if($custody.scope.LimitFlags -ne 8712 -or $custody.scope.ActiveProcessLimit -ne 16 -or $custody.scope.JobMemoryBytes -ne 2147483648 -or $custody.scope.CpuFlags -ne 5 -or $custody.scope.CpuRate -ne 2500){throw 'Terminal accounting Job limits differ.'}
    $image=@($expectedImages|Where-Object {[string]::Equals($_.path,$record.executablePath,[StringComparison]::OrdinalIgnoreCase)})
    if($image.Count -ne 1 -or $image[0].sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $image[0].bytes -le 0 -or $record.sealedImageFailure -or $record.sealedImageSha256 -ine $image[0].sha256 -or $record.sealedImageBytes -ne $image[0].bytes){throw 'Terminal accounting installed image is not sealed.'}
    $phase=Assert-InstallerHelperNativeAfter $record
    if($null -ne $record.nativeImageAfterQueryFailure -or $null -ne $record.nativeImageAfterQueryErrorCode){throw 'Terminal accounting native state has image errors.'}
    if($record.nativeAfterQueryProof -cne $phase -or $record.nativeSignaledAfterQuery -ne $true -or $record.nativeExitAfterQuery -ne 0){throw 'Terminal accounting requires actual same-handle terminal exit 0.'}
    return 'terminal-metadata-unresolved'
}
