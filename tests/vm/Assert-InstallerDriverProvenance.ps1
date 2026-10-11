# Pure pre-resume proof rule; no native calls, queries, process creation or file access.
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidInvokingEmptyMembers', '', Justification = 'Before/After proof fields are selected by a fixed suffix list.')]
param()
function Assert-InstallerDriverProvenance($proof,$receipt,$members,$scope,[int]$driverPid,[int]$observerPid,[int]$controllerPid,[string]$nodeImage,$consolePid){
    $roles=@($driverPid,$observerPid,$controllerPid)
    if(@($roles|Where-Object {$_ -le 0}).Count -or @($roles|Select-Object -Unique).Count -ne 3){throw 'Initial driver roles overlap or are invalid.'}
    $expectedMembers=@($driverPid,$observerPid)
    if($null -ne $consolePid){if($consolePid -isnot [int] -or $consolePid -le 0 -or $roles -contains $consolePid){throw 'Initial driver Job membership differs.'};$expectedMembers+=@($consolePid)}
    if($members.Count -ne $expectedMembers.Count -or @($members|Select-Object -Unique).Count -ne $members.Count -or @($members|Where-Object {$_ -notin $expectedMembers}).Count){throw 'Initial driver Job membership differs.'}
    foreach($limit in @(@{scope='LimitFlags';receipt='limitFlags';value=0x2208},@{scope='ActiveProcessLimit';receipt='processLimit';value=16},@{scope='JobMemoryBytes';receipt='jobMemoryBytes';value=2147483648L},@{scope='CpuFlags';receipt='cpuFlags';value=5},@{scope='CpuRate';receipt='cpuRate';value=2500})){if($scope.($limit.scope) -ne $limit.value -or $receipt.($limit.receipt) -ne $limit.value){throw 'Initial driver Job limits differ.'}}
    if($receipt.driverPid -ne $driverPid -or $receipt.observerPid -ne $observerPid -or $receipt.controllerPid -ne $controllerPid -or $receipt.atomicJobAssignment -isnot [bool] -or !$receipt.atomicJobAssignment -or $receipt.jobHandleInherited -isnot [bool] -or $receipt.jobHandleInherited -or ![string]::Equals($receipt.nodeExecutable,$nodeImage,[StringComparison]::OrdinalIgnoreCase)){throw 'Initial driver controller receipt differs.'}
    $initial=$receipt.initialJobSnapshot
    if($null -ne $initial.failure -or $initial.assignedCount -ne 2 -or $initial.listedCount -ne 2 -or $initial.pids.Count -ne 2 -or @($initial.pids|Select-Object -Unique).Count -ne 2 -or $initial.pids -notcontains $driverPid -or $initial.pids -notcontains $observerPid){throw 'Initial suspended native roots differ.'}
    if($proof -isnot [Collections.IDictionary] -or @(@('metadataImage','metadataFailure','nativeFailureBefore','nativeFailureAfter','diagnosticFailure','truncatedFields')|Where-Object {!$proof.Contains($_)}).Count -ne 0 -or $proof.phase -cne 'pre-resume-suspended-driver' -or $proof.pid -ne $driverPid -or $proof.nativeHandleHeld -isnot [bool] -or !$proof.nativeHandleHeld -or $proof.metadataCompleted -isnot [bool] -or !$proof.metadataCompleted -or $null -ne $proof.metadataFailure -or $null -ne $proof.diagnosticFailure -or $null -eq $proof.truncatedFields -or $proof.truncatedFields.Count -ne 0){throw 'Initial driver observation is incomplete or clipped.'}
    foreach($suffix in @('Before','After')){
        if(![string]::Equals($proof.('nativeImage'+$suffix),$nodeImage,[StringComparison]::OrdinalIgnoreCase) -or $proof.('nativeExit'+$suffix) -ne 259 -or $proof.('nativeSignaled'+$suffix) -isnot [bool] -or $proof.('nativeSignaled'+$suffix) -or $null -ne $proof.('nativeFailure'+$suffix)){throw 'Initial driver held native image or liveness differs.'}
    }
    if($proof.metadataParentProcessId -ne $controllerPid -or $receipt.driverCommandLine -isnot [string] -or !$receipt.driverCommandLine -or [Text.Encoding]::UTF8.GetByteCount($receipt.driverCommandLine) -gt 8192 -or $proof.metadataCommandLine -isnot [string] -or ![string]::Equals($proof.metadataCommandLine,$receipt.driverCommandLine,[StringComparison]::Ordinal)){throw 'Initial driver metadata parent or exact created command differs.'}
    if($null -eq $proof.metadataImage){return 'held-native-suspended-wmi-null'}
    if($proof.metadataImage -isnot [string] -or ![string]::Equals($proof.metadataImage,$nodeImage,[StringComparison]::OrdinalIgnoreCase)){throw 'Initial driver non-null metadata image differs.'}
    return 'held-native-and-wmi-image'
}
