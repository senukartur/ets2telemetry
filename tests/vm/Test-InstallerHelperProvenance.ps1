# Pure deterministic proof fixtures. No observer DLL, native calls, queries or applications.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-InstallerHelperProvenance.ps1')
$rows=[Collections.Generic.List[object]]::new()
function New-HelperFixture {
    $image='C:\ETS2ET001Acceptance\installer\Setup.exe'
    $record=[ordered]@{pid=20;role='installer-helper';executablePath=$image;nativeIdentityHeld=$true;nativeIdentityRetired=$false;nativeExitBefore=259;nativeSignaledBefore=$false;nativeImageAfterQuery=$image;nativeImageAfterQueryFailure=$null;nativeExitAfterQueryFailure=$null;nativeExitAfterQuery=259;nativeSignaledAfterQuery=$false;metadataCompleted=$true;metadataParentProcessId=10;metadataProviderFailure=$null;diagnosticTruncatedFields=@();metadataPolicy=$null;queryFailure=$null;exitQueryFailure=$null;exitCode=$null;nativeFinalSignaled=$false}
    $metadata=[pscustomobject]@{ExecutablePath=$null;CommandLine=($image+' --silent');ParentProcessId=10;Failure=$null}
    return @{record=$record;metadata=$metadata;records=@($record);consoles=@(13,14)}
}
function Invoke-HelperFixture($c){Assert-InstallerHelperProvenance $c.record $c.metadata $c.records 10 11 12 $c.consoles}
function Accept-Helper([string]$name,[scriptblock]$change,[string]$expected){$c=New-HelperFixture;& $change $c;$actual=Invoke-HelperFixture $c;if($actual -cne $expected){throw "Acceptance $name expected $expected but got $actual."};$rows.Add(@{name=$name;passed=$true;policy=$actual})}
function Reject-Helper([string]$name,[scriptblock]$change,[string]$expected){$c=New-HelperFixture;& $change $c;$failure=$null;try{$null=Invoke-HelperFixture $c}catch{$failure=$_.Exception.Message};if($failure -cne $expected){throw "Rejection $name expected '$expected' but got '$failure'."};$rows.Add(@{name=$name;passed=$true;failure=$failure})}
Accept-Helper 'explicit null native helper' {} 'held-native-helper-wmi-null'
Accept-Helper 'nonnull case-insensitive image' {param($c)$c.metadata.ExecutablePath=$c.record.executablePath.ToUpperInvariant()} 'held-native-helper-wmi-image'
Accept-Helper 'quoted executable with spaces and untouched args' {param($c)$c.record.executablePath='C:\Program Files\Fixture\app.exe';$c.record.nativeImageAfterQuery=$c.record.executablePath;$c.metadata.CommandLine='"C:\Program Files\Fixture\app.exe" --squirrel-install 0.1.0'} 'held-native-helper-wmi-null'
Accept-Helper 'GPU after-query exit zero not yet signaled is only provenance' {param($c)$c.record.nativeExitAfterQuery=0} 'held-native-helper-wmi-null'
Accept-Helper 'after-query signaled exit zero provenance' {param($c)$c.record.nativeExitAfterQuery=0;$c.record.nativeSignaledAfterQuery=$true} 'held-native-helper-wmi-null'
function Add-Parent($c){$parent=(New-HelperFixture).record;$parent.pid=21;$parent.metadataPolicy='held-native-helper-wmi-image';$c.record.metadataParentProcessId=21;$c.metadata.ParentProcessId=21;$c.records+=@($parent);return $parent}
Accept-Helper 'approved live parent chain reaches actual driver' {param($c)$null=Add-Parent $c} 'held-native-helper-wmi-null'
Accept-Helper 'retired continuously held parent reaches driver' {param($c)$p=Add-Parent $c;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} 'held-native-helper-wmi-null'
Accept-Helper 'pending actual held parent stays pending' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null;$p.metadataCompleted=$false} 'pending-audited-parent'
Accept-Helper 'completed parent awaits same-clock policy approval' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null} 'pending-audited-parent'
Accept-Helper 'Setup Update hook GPU ancestry with retired identities' {
    param($c)
    $p=Add-Parent $c;$p.executablePath='C:\Users\fixture\AppData\Local\ETS2TelemetryDesktop\app-0.1.0\ETS2TelemetryDesktop.exe';$p.metadataParentProcessId=22;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0
    $update=(New-HelperFixture).record;$update.pid=22;$update.metadataParentProcessId=23;$update.metadataPolicy='held-native-helper-wmi-image';$update.nativeIdentityRetired=$true;$update.nativeFinalSignaled=$true;$update.exitCode=0;$update.executablePath='C:\Users\fixture\AppData\Local\SquirrelTemp\Update.exe'
    $setup=(New-HelperFixture).record;$setup.pid=23;$setup.metadataPolicy='held-native-helper-wmi-null';$setup.nativeIdentityRetired=$true;$setup.nativeFinalSignaled=$true;$setup.exitCode=0
    $c.records+=@($update,$setup);$c.record.executablePath=$p.executablePath;$c.record.nativeImageAfterQuery=$p.executablePath;$c.metadata.CommandLine='"'+$p.executablePath+'" --type=gpu-process --gpu-preferences=fixture'
} 'held-native-helper-wmi-null'
$image='Helper non-null metadata image differs.';$native='Helper held native identity or after-query state differs.';$observed='Helper metadata observation is incomplete or clipped.';$parent='Helper parent chain is unknown, conflicted or cyclic.';$failedParent='Helper parent proof failed or belongs to another role.';$role='Helper identity duplicates or overlaps another role.';$token='Helper executable token is missing or malformed.'
Reject-Helper 'empty image' {param($c)$c.metadata.ExecutablePath=''} $image
Reject-Helper 'wrong nonnull image' {param($c)$c.metadata.ExecutablePath='C:\Temp\Setup.exe'} $image
Reject-Helper 'missing image operand' {param($c)$c.metadata.PSObject.Properties.Remove('ExecutablePath')} 'Helper metadata operands are missing.'
Reject-Helper 'missing command operand' {param($c)$c.metadata.PSObject.Properties.Remove('CommandLine')} 'Helper metadata operands are missing.'
Reject-Helper 'missing native error operand' {param($c)$c.record.Remove('nativeImageAfterQueryFailure')} 'Helper native observation operands are missing.'
Reject-Helper 'metadata query error' {param($c)$c.metadata.Failure='timeout'} $observed
Reject-Helper 'metadata empty error' {param($c)$c.metadata.Failure=''} $observed
Reject-Helper 'metadata incomplete' {param($c)$c.record.metadataCompleted=$false} $observed
Reject-Helper 'diagnostic clipped command' {param($c)$c.record.diagnosticTruncatedFields=@('metadataCommandLine')} $observed
Reject-Helper 'unheld native identity' {param($c)$c.record.nativeIdentityHeld=$false} $observed
Reject-Helper 'before native image query error' {param($c)$c.record.queryFailure='denied'} $observed
Reject-Helper 'native after image differs' {param($c)$c.record.nativeImageAfterQuery='C:\Temp\Setup.exe'} $native
Reject-Helper 'native after image error' {param($c)$c.record.nativeImageAfterQueryFailure='denied'} $native
Reject-Helper 'native after exit error' {param($c)$c.record.nativeExitAfterQueryFailure='denied'} $native
Reject-Helper 'native before not live' {param($c)$c.record.nativeExitBefore=0} $native
Reject-Helper 'native before signaled' {param($c)$c.record.nativeSignaledBefore=$true} $native
Reject-Helper 'native after failed exit' {param($c)$c.record.nativeExitAfterQuery=9} $native
Reject-Helper 'native after 259 signaled' {param($c)$c.record.nativeSignaledAfterQuery=$true} $native
Reject-Helper 'native after missing signal' {param($c)$c.record.nativeSignaledAfterQuery=$null} $native
Reject-Helper 'console cannot consume null policy' {param($c)$c.record.executablePath='C:\Windows\System32\conhost.exe'} $role
Reject-Helper 'root overlap' {param($c)$c.record.pid=11} $role
Reject-Helper 'console role overlap' {param($c)$c.record.pid=13} $role
Reject-Helper 'duplicate rebound record' {param($c)$c.records+=@($c.record)} $role
Reject-Helper 'unknown parent' {param($c)$c.metadata.ParentProcessId=90;$c.record.metadataParentProcessId=90} $parent
Reject-Helper 'observer parent' {param($c)$c.metadata.ParentProcessId=11;$c.record.metadataParentProcessId=11} $parent
Reject-Helper 'controller parent' {param($c)$c.metadata.ParentProcessId=12;$c.record.metadataParentProcessId=12} $parent
Reject-Helper 'root console parent' {param($c)$c.metadata.ParentProcessId=13;$c.record.metadataParentProcessId=13} $parent
Reject-Helper 'missing actual parent' {param($c)$c.metadata.ParentProcessId=$null;$c.record.metadataParentProcessId=$null} $parent
Reject-Helper 'self-parent cycle' {param($c)$c.metadata.ParentProcessId=20;$c.record.metadataParentProcessId=20} $parent
Reject-Helper 'two-parent cycle' {param($c)$p=Add-Parent $c;$p.metadataParentProcessId=20} $parent
Reject-Helper 'duplicate parent identity' {param($c)$p=Add-Parent $c;$c.records+=@($p)} $parent
Reject-Helper 'failed parent normal-exit proof' {param($c)$p=Add-Parent $c;$p.exitCode=9} $failedParent
Reject-Helper 'failed parent metadata' {param($c)$p=Add-Parent $c;$p.queryFailure='denied'} $failedParent
Reject-Helper 'unheld parent identity' {param($c)$p=Add-Parent $c;$p.nativeIdentityHeld=$false} $failedParent
Reject-Helper 'parent after native query error' {param($c)$p=Add-Parent $c;$p.nativeImageAfterQueryFailure='denied'} $failedParent
Reject-Helper 'retired parent lacks actual final signal' {param($c)$p=Add-Parent $c;$p.nativeIdentityRetired=$true;$p.exitCode=0} $failedParent
Reject-Helper 'console parent masquerading helper' {param($c)$p=Add-Parent $c;$p.executablePath='C:\Windows\System32\conhost.exe'} $failedParent
Reject-Helper 'parent role conflict' {param($c)$p=Add-Parent $c;$p.role='driver-console'} $failedParent
Reject-Helper 'clipped pending parent' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null;$p.diagnosticTruncatedFields=@('metadataImage')} $failedParent
Reject-Helper 'recorded parent mutation' {param($c)$c.record.metadataParentProcessId=21} 'Helper recorded parent differs from its original metadata.'
Reject-Helper 'wrong command executable' {param($c)$c.metadata.CommandLine='C:\Temp\Setup.exe --silent'} 'Helper command executable differs from its native image.'
foreach($bad in @($null,'','Setup.exe --silent',' C:\a.exe','"C:\a.exe','"C:\a.exe"tail','C:\a"b.exe','"C:\a\"b.exe"',"C:\a.exe`r`n--silent")){Reject-Helper ('malformed command '+[string]$bad) {param($c)$c.metadata.CommandLine=$bad}.GetNewClosure() $token}
function Reject-Exit([string]$name,[scriptblock]$change){$r=(New-HelperFixture).record;$r.metadataPolicy='held-native-helper-wmi-null';$r.exitCode=0;$r.nativeFinalSignaled=$true;& $change $r;$failure=$null;try{Assert-InstallerHelperExit $r}catch{$failure=$_.Exception.Message};if($failure -cne 'Helper final native signaled exit 0 proof is incomplete.'){throw "Final rejection $name differs: $failure"};$rows.Add(@{name=$name;passed=$true;failure=$failure})}
$final=(New-HelperFixture).record;$final.metadataPolicy='held-native-helper-wmi-null';$final.nativeFinalSignaled=$true;$final.exitCode=0;Assert-InstallerHelperExit $final;$rows.Add(@{name='actual final signaled zero';passed=$true})
Reject-Exit 'GPU transitional zero not final' {param($r)$r.nativeFinalSignaled=$false}
Reject-Exit 'final nonzero' {param($r)$r.exitCode=9}
Reject-Exit 'final live259' {param($r)$r.exitCode=259}
Reject-Exit 'final missing wait state' {param($r)$r.nativeFinalSignaled=$null}
Reject-Exit 'final pending parent policy' {param($r)$r.metadataPolicy='pending-audited-parent'}
Reject-Exit 'final metadata failure' {param($r)$r.queryFailure='denied'}
Reject-Exit 'final missing native error operand' {param($r)$r.Remove('exitQueryFailure')}
[ordered]@{passed=$true;nativeObserverInvoked=$false;applicationLaunched=$false;cases=$rows.ToArray()}|ConvertTo-Json -Depth 4 -Compress
