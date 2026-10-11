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
function Resolve-InstallerHelperParent($record,$records,[int]$driverPid,[int]$observerPid,[int]$controllerPid,$consolePids){
    $forbidden=@($observerPid,$controllerPid)+@($consolePids)
    $seen=[Collections.Generic.HashSet[int]]::new();$null=$seen.Add($record.pid)
    $parent=$record.metadataParentProcessId;$pending=$false
    while($parent -ne $driverPid){
        if($null -eq $parent -or $parent -le 0 -or $forbidden -contains $parent -or !$seen.Add($parent)){throw 'Helper parent chain is unknown, conflicted or cyclic.'}
        $matches=@($records|Where-Object {$_.pid -eq $parent})
        if($matches.Count -ne 1){throw 'Helper parent chain is unknown, conflicted or cyclic.'}
        $ancestor=$matches[0]
        if($ancestor.role -cne 'installer-helper' -or $ancestor.executablePath -ieq 'C:\Windows\System32\conhost.exe' -or $ancestor.nativeIdentityHeld -ne $true -or $null -ne $ancestor.queryFailure -or $null -ne $ancestor.exitQueryFailure -or $null -ne $ancestor.nativeImageAfterQueryFailure -or $null -ne $ancestor.nativeExitAfterQueryFailure -or ($null -ne $ancestor.exitCode -and $ancestor.exitCode -ne 0) -or ($ancestor.nativeIdentityRetired -eq $true -and ($ancestor.nativeFinalSignaled -ne $true -or $ancestor.exitCode -ne 0))){throw 'Helper parent proof failed or belongs to another role.'}
        if($ancestor.metadataPolicy -notin @('held-native-helper-wmi-null','held-native-helper-wmi-image')){
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
    foreach($key in @('nativeIdentityHeld','metadataCompleted','queryFailure','exitQueryFailure','diagnosticTruncatedFields','executablePath','nativeExitBefore','nativeSignaledBefore','nativeImageAfterQuery','nativeImageAfterQueryFailure','nativeExitAfterQueryFailure','nativeExitAfterQuery','nativeSignaledAfterQuery','metadataParentProcessId')){if(!$record.Contains($key)){throw 'Helper native observation operands are missing.'}}
    if($null -eq $metadata.PSObject.Properties['ExecutablePath'] -or $null -eq $metadata.PSObject.Properties['CommandLine'] -or $null -eq $metadata.PSObject.Properties['ParentProcessId'] -or $null -eq $metadata.PSObject.Properties['Failure']){throw 'Helper metadata operands are missing.'}
    $roots=@($driverPid,$observerPid,$controllerPid)
    if(@($roots|Where-Object {$_ -le 0}).Count -or @($roots|Select-Object -Unique).Count -ne 3 -or $record.pid -le 0 -or $roots -contains $record.pid -or $consolePids -contains $record.pid -or @($records|Where-Object {$_.pid -eq $record.pid}).Count -ne 1 -or $record.role -cne 'installer-helper' -or $record.executablePath -ieq 'C:\Windows\System32\conhost.exe'){throw 'Helper identity duplicates or overlaps another role.'}
    if($record.nativeIdentityHeld -isnot [bool] -or !$record.nativeIdentityHeld -or $record.metadataCompleted -isnot [bool] -or !$record.metadataCompleted -or $null -ne $metadata.Failure -or $null -ne $record.queryFailure -or $null -ne $record.exitQueryFailure -or $null -eq $record.diagnosticTruncatedFields -or $record.diagnosticTruncatedFields.Count -ne 0){throw 'Helper metadata observation is incomplete or clipped.'}
    if($record.executablePath -isnot [string] -or !$record.executablePath -or $record.nativeExitBefore -ne 259 -or $record.nativeSignaledBefore -isnot [bool] -or $record.nativeSignaledBefore -or ![string]::Equals($record.nativeImageAfterQuery,$record.executablePath,[StringComparison]::OrdinalIgnoreCase) -or $null -ne $record.nativeImageAfterQueryFailure -or $null -ne $record.nativeExitAfterQueryFailure -or $record.nativeExitAfterQuery -notin @(259,0) -or $record.nativeSignaledAfterQuery -isnot [bool] -or ($record.nativeExitAfterQuery -eq 259 -and $record.nativeSignaledAfterQuery)){throw 'Helper held native identity or after-query state differs.'}
    if($null -ne $metadata.ExecutablePath -and ($metadata.ExecutablePath -isnot [string] -or ![string]::Equals($metadata.ExecutablePath,$record.executablePath,[StringComparison]::OrdinalIgnoreCase))){throw 'Helper non-null metadata image differs.'}
    $token=Read-InstallerHelperExecutable $metadata.CommandLine
    if(![string]::Equals($token,$record.executablePath,[StringComparison]::OrdinalIgnoreCase)){throw 'Helper command executable differs from its native image.'}
    if($metadata.ParentProcessId -ne $record.metadataParentProcessId){throw 'Helper recorded parent differs from its original metadata.'}
    $parent=Resolve-InstallerHelperParent $record $records $driverPid $observerPid $controllerPid $consolePids
    if($parent -eq 'pending-audited-parent'){return $parent}
    if($null -eq $metadata.ExecutablePath){return 'held-native-helper-wmi-null'}
    return 'held-native-helper-wmi-image'
}
function Assert-InstallerHelperExit($record){
    foreach($key in @('metadataPolicy','nativeFinalSignaled','exitCode','queryFailure','exitQueryFailure')){if(!$record.Contains($key)){throw 'Helper final native signaled exit 0 proof is incomplete.'}}
    if($record.metadataPolicy -notin @('held-native-helper-wmi-null','held-native-helper-wmi-image','strict-console-image') -or $record.nativeFinalSignaled -isnot [bool] -or !$record.nativeFinalSignaled -or $record.exitCode -ne 0 -or $null -ne $record.queryFailure -or $null -ne $record.exitQueryFailure){throw 'Helper final native signaled exit 0 proof is incomplete.'}
}
