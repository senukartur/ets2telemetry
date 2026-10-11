# Pure helper proof rules. No native APIs, process creation, queries or file access.
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
        $matches=@($records|Where-Object {$_.pid -eq $parent})
        if($matches.Count -ne 1){throw 'Helper parent chain is unknown, conflicted or cyclic.'}
        $ancestor=$matches[0]
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
    if($record.metadataPolicy -notin @('held-native-helper-wmi-null','held-native-helper-wmi-image','held-native-helper-wmi-advisory-mismatch','strict-console-image') -or $record.nativeFinalSignaled -isnot [bool] -or !$record.nativeFinalSignaled -or $record.exitCode -ne 0 -or $null -ne $record.queryFailure -or $null -ne $record.exitQueryFailure){throw 'Helper final native signaled exit 0 proof is incomplete.'}
}
