# Inert deterministic proof tests. Never loads the observer DLL or invokes native APIs.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-InstallerDriverProvenance.ps1')
$rows=[Collections.Generic.List[object]]::new()
function New-ProvenanceFixture {
    $node='C:\ETS2ET001Acceptance\tools\node.exe'
    $command='"C:\ETS2ET001Acceptance\tools\node.exe" "C:\ETS2ET001Acceptance\harness\installer-step.mjs" "install"'
    return @{node=$node;consolePid=13;members=@(10,11,13);scope=@{LimitFlags=0x2208;ActiveProcessLimit=16;JobMemoryBytes=2147483648L;CpuFlags=5;CpuRate=2500};receipt=@{driverPid=10;observerPid=11;controllerPid=12;nodeExecutable=$node;driverCommandLine=$command;atomicJobAssignment=$true;jobHandleInherited=$false;limitFlags=0x2208;processLimit=16;jobMemoryBytes=2147483648L;cpuFlags=5;cpuRate=2500;initialJobSnapshot=@{failure=$null;assignedCount=2;listedCount=2;pids=@(10,11)}};proof=[ordered]@{phase='pre-resume-suspended-driver';pid=10;nativeHandleHeld=$true;nativeImageBefore=$node;nativeImageAfter=$node;nativeExitBefore=259;nativeExitAfter=259;nativeSignaledBefore=$false;nativeSignaledAfter=$false;nativeFailureBefore=$null;nativeFailureAfter=$null;metadataCompleted=$true;metadataImage=$null;metadataParentProcessId=12;metadataCommandLine=$command;metadataFailure=$null;diagnosticFailure=$null;truncatedFields=@()}}
}
function Invoke-ProvenanceFixture($context){Assert-InstallerDriverProvenance $context.proof $context.receipt $context.members $context.scope 10 11 12 $context.node $context.consolePid}
foreach($nonnull in @($false,$true)){
    $context=New-ProvenanceFixture
    if($nonnull){$context.proof.metadataImage=$context.node.ToUpperInvariant()}
    $expected=if($nonnull){'held-native-and-wmi-image'}else{'held-native-suspended-wmi-null'}
    if((Invoke-ProvenanceFixture $context) -cne $expected){throw 'Explicit initial driver policy differs.'}
    $rows.Add(@{name=$expected;passed=$true})
}
function Reject-Provenance([string]$name,[scriptblock]$change,[string]$expected){
    $context=New-ProvenanceFixture;& $change $context
    $failure=$null
    try{$null=Invoke-ProvenanceFixture $context}catch{$failure=$_.Exception.Message}
    if($failure -cne $expected){throw ('Rejection '+$name+' expected "'+$expected+'" but got "'+$failure+'".')}
    $rows.Add(@{name=$name;passed=$true;failure=$failure})
}
$observation='Initial driver observation is incomplete or clipped.'
$native='Initial driver held native image or liveness differs.'
$metadata='Initial driver metadata parent or exact created command differs.'
$image='Initial driver non-null metadata image differs.'
$receipt='Initial driver controller receipt differs.'
$roots='Initial suspended native roots differ.'
$members='Initial driver Job membership differs.'
$limits='Initial driver Job limits differ.'
Reject-Provenance 'empty WMI image' {param($c)$c.proof.metadataImage=''} $image
Reject-Provenance 'wrong non-null WMI image' {param($c)$c.proof.metadataImage='C:\Temp\node.exe'} $image
Reject-Provenance 'missing WMI image operand' {param($c)$c.proof.Remove('metadataImage')} $observation
Reject-Provenance 'missing metadata error operand' {param($c)$c.proof.Remove('metadataFailure')} $observation
Reject-Provenance 'missing native error operand' {param($c)$c.proof.Remove('nativeFailureAfter')} $observation
Reject-Provenance 'wrong native before image' {param($c)$c.proof.nativeImageBefore='C:\Temp\node.exe'} $native
Reject-Provenance 'wrong native after image' {param($c)$c.proof.nativeImageAfter='C:\Temp\node.exe'} $native
Reject-Provenance 'native before exit' {param($c)$c.proof.nativeExitBefore=0} $native
Reject-Provenance 'native after exit' {param($c)$c.proof.nativeExitAfter=124} $native
Reject-Provenance 'native before signaled' {param($c)$c.proof.nativeSignaledBefore=$true} $native
Reject-Provenance 'native after signaled' {param($c)$c.proof.nativeSignaledAfter=$true} $native
Reject-Provenance 'missing native wait state' {param($c)$c.proof.nativeSignaledAfter=$null} $native
Reject-Provenance 'native before error' {param($c)$c.proof.nativeFailureBefore='denied'} $native
Reject-Provenance 'native after error' {param($c)$c.proof.nativeFailureAfter='vanished'} $native
Reject-Provenance 'unheld identity' {param($c)$c.proof.nativeHandleHeld=$false} $observation
Reject-Provenance 'metadata timeout' {param($c)$c.proof.metadataCompleted=$false} $observation
Reject-Provenance 'metadata error' {param($c)$c.proof.metadataFailure='timeout'} $observation
Reject-Provenance 'empty metadata error value' {param($c)$c.proof.metadataFailure=''} $observation
Reject-Provenance 'diagnostic error' {param($c)$c.proof.diagnosticFailure='write failed'} $observation
Reject-Provenance 'clipped diagnostic operand' {param($c)$c.proof.truncatedFields=@('metadataCommandLine')} $observation
Reject-Provenance 'post-resume phase' {param($c)$c.proof.phase='running-driver'} $observation
Reject-Provenance 'proof role overlap' {param($c)$c.proof.pid=11} $observation
Reject-Provenance 'wrong actual parent' {param($c)$c.proof.metadataParentProcessId=11} $metadata
Reject-Provenance 'missing actual parent' {param($c)$c.proof.metadataParentProcessId=$null} $metadata
Reject-Provenance 'missing command' {param($c)$c.proof.metadataCommandLine=$null} $metadata
Reject-Provenance 'empty command' {param($c)$c.proof.metadataCommandLine=''} $metadata
Reject-Provenance 'changed argument case' {param($c)$c.proof.metadataCommandLine=$c.proof.metadataCommandLine.Replace('install','INSTALL')} $metadata
Reject-Provenance 'different created argv' {param($c)$c.receipt.driverCommandLine+=' "extra"'} $metadata
Reject-Provenance 'overbound created argv' {param($c)$c.receipt.driverCommandLine='x'*8193;$c.proof.metadataCommandLine=$c.receipt.driverCommandLine} $metadata
Reject-Provenance 'wrong controller receipt role' {param($c)$c.receipt.controllerPid=11} $receipt
Reject-Provenance 'wrong receipt Node image' {param($c)$c.receipt.nodeExecutable='C:\Temp\node.exe'} $receipt
Reject-Provenance 'inherited Job handle' {param($c)$c.receipt.jobHandleInherited=$true} $receipt
Reject-Provenance 'unassigned root creation' {param($c)$c.receipt.atomicJobAssignment=$false} $receipt
Reject-Provenance 'partial suspended roots' {param($c)$c.receipt.initialJobSnapshot.assignedCount=1} $roots
Reject-Provenance 'suspended root snapshot error' {param($c)$c.receipt.initialJobSnapshot.failure='denied'} $roots
Reject-Provenance 'duplicate initial roots' {param($c)$c.receipt.initialJobSnapshot.pids=@(10,10)} $roots
Reject-Provenance 'missing current root' {param($c)$c.members=@(10,13)} $members
Reject-Provenance 'duplicate current root' {param($c)$c.members=@(10,10,11)} $members
Reject-Provenance 'unknown third current PID' {param($c)$c.members=@(10,11,14)} $members
Reject-Provenance 'unknown additional current PID' {param($c)$c.members=@(10,11,13,14)} $members
Reject-Provenance 'controller in current Job' {param($c)$c.members=@(10,11,12)} $members
Reject-Provenance 'changed native caps' {param($c)$c.scope.CpuRate=10000} $limits
Reject-Provenance 'changed receipt caps' {param($c)$c.receipt.limitFlags=0xa208} $limits
[ordered]@{passed=$true;nativeObserverInvoked=$false;applicationLaunched=$false;cases=$rows.ToArray()}|ConvertTo-Json -Depth 4 -Compress
