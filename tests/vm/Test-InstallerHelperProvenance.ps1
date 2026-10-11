# Pure deterministic proof fixtures. No observer DLL, native calls, queries or applications.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-InstallerHelperProvenance.ps1')
$rows=[Collections.Generic.List[object]]::new()
function New-HelperFixture {
    $image='C:\ETS2ET001Acceptance\installer\Setup.exe'
    $record=[ordered]@{pid=20;role='installer-helper';executablePath=$image;nativeIdentityHeld=$true;nativeIdentityRetired=$false;nativeExitBefore=259;nativeSignaledBefore=$false;nativeImageAfterQuery=$image;nativeImageAfterQueryFailure=$null;nativeImageAfterQueryErrorCode=$null;nativeImageAttemptedAfterQuery=$true;nativeAfterQueryProof='live-image';nativeExitAfterQueryFailure=$null;nativeExitAfterQuery=259;nativeSignaledAfterQuery=$false;metadataCompleted=$true;metadataParentProcessId=10;metadataProviderFailure=$null;diagnosticTruncatedFields=@();metadataPolicy=$null;queryFailure=$null;exitQueryFailure=$null;exitCode=$null;nativeFinalSignaled=$false}
    $metadata=[pscustomobject]@{RequestedProcessId=20;ProcessId=[uint32]20;Handle='20';ObjectPath='Win32_Process.Handle="20"';ClassName='Win32_Process';ExecutablePath=$null;CommandLine=($image+' --silent');ParentProcessId=10;Failure=$null}
    return @{record=$record;metadata=$metadata;records=@($record);consoles=@(13,14)}
}
function Invoke-HelperFixture($c){Assert-InstallerHelperProvenance $c.record $c.metadata $c.records 10 11 12 $c.consoles}
function Accept-Helper([string]$name,[scriptblock]$change,[string]$expected){$c=New-HelperFixture;& $change $c;$before=$c.metadata|ConvertTo-Json -Compress;$actual=Invoke-HelperFixture $c;if($actual -cne $expected){throw "Acceptance $name expected $expected but got $actual."};if(($c.metadata|ConvertTo-Json -Compress) -cne $before){throw 'Helper assertion mutated original metadata.'};$rows.Add(@{name=$name;passed=$true;policy=$actual;rawMetadataImage=$c.metadata.ExecutablePath;imageObservation=(Read-InstallerHelperImageObservation $c.metadata $c.record.executablePath)})}
function Reject-Helper([string]$name,[scriptblock]$change,[string]$expected){$c=New-HelperFixture;& $change $c;$failure=$null;try{$null=Invoke-HelperFixture $c}catch{$failure=$_.Exception.Message};if($failure -cne $expected){throw "Rejection $name expected '$expected' but got '$failure'."};$rows.Add(@{name=$name;passed=$true;failure=$failure})}
Accept-Helper 'explicit null native helper' {} 'held-native-helper-wmi-null'
Accept-Helper 'nonnull case-insensitive image' {param($c)$c.metadata.ExecutablePath=$c.record.executablePath.ToUpperInvariant()} 'held-native-helper-wmi-image'
Accept-Helper 'raw ntdll mismatch is advisory with full native and parent proof' {param($c)$c.metadata.ExecutablePath='C:\WINDOWS\SYSTEM32\ntdll.dll'} 'held-native-helper-wmi-advisory-mismatch'
Accept-Helper 'arbitrary nonempty advisory image has no filename exception' {param($c)$c.metadata.ExecutablePath='C:\Temp\Other.dll'} 'held-native-helper-wmi-advisory-mismatch'
Accept-Helper 'canonical single quoted key and class case' {param($c)$c.metadata.ObjectPath="win32_process.handle='20'";$c.metadata.ClassName='WIN32_PROCESS'} 'held-native-helper-wmi-null'
Accept-Helper 'quoted executable with spaces and untouched args' {param($c)$c.record.executablePath='C:\Program Files\Fixture\app.exe';$c.record.nativeImageAfterQuery=$c.record.executablePath;$c.metadata.CommandLine='"C:\Program Files\Fixture\app.exe" --squirrel-install 0.1.0'} 'held-native-helper-wmi-null'
Accept-Helper 'GPU after-query exit zero not yet signaled is only provenance' {param($c)$c.record.nativeExitAfterQuery=0} 'held-native-helper-wmi-null'
Accept-Helper 'after-query signaled exit zero provenance' {param($c)$c.record.nativeExitAfterQuery=0;$c.record.nativeSignaledAfterQuery=$true} 'held-native-helper-wmi-null'
function Set-TerminalFixture($record){$record.nativeExitAfterQuery=0;$record.nativeSignaledAfterQuery=$true;$record.nativeImageAttemptedAfterQuery=$false;$record.nativeImageAfterQuery=$null;$record.nativeAfterQueryProof='terminal-held-identity'}
function Set-ImageRaceFixture($record){Set-TerminalFixture $record;$record.nativeImageAttemptedAfterQuery=$true;$record.nativeImageAfterQueryFailure='Retained synthetic device failure';$record.nativeImageAfterQueryErrorCode=31;$record.nativeAfterQueryProof='terminal-after-image-race'}
Accept-Helper 'terminal signaled zero skips image without inventing match' {param($c)Set-TerminalFixture $c.record} 'held-native-helper-wmi-null'
Accept-Helper 'GPU retained image error and terminal same-handle zero' {param($c)Set-ImageRaceFixture $c.record;$c.metadata.CommandLine='C:\ETS2ET001Acceptance\installer\Setup.exe --type=gpu-process'} 'held-native-helper-wmi-null'
Accept-Helper 'terminal image error without available numeric code' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeImageAfterQueryErrorCode=$null} 'held-native-helper-wmi-null'
Accept-Helper 'terminal image error has no error-code whitelist' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeImageAfterQueryErrorCode=5} 'held-native-helper-wmi-null'
function Add-Parent($c){$parent=(New-HelperFixture).record;$parent.pid=21;$parent.metadataPolicy='held-native-helper-wmi-image';$c.record.metadataParentProcessId=21;$c.metadata.ParentProcessId=21;$c.records+=@($parent);return $parent}
Accept-Helper 'approved live parent chain reaches actual driver' {param($c)$null=Add-Parent $c} 'held-native-helper-wmi-null'
Accept-Helper 'retired continuously held parent reaches driver' {param($c)$p=Add-Parent $c;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} 'held-native-helper-wmi-null'
Accept-Helper 'retired native-authority parent with advisory WMI image' {param($c)$p=Add-Parent $c;$p.metadataPolicy='held-native-helper-wmi-advisory-mismatch';$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} 'held-native-helper-wmi-null'
Accept-Helper 'retired terminal parent retains same identity with no after image' {param($c)$p=Add-Parent $c;Set-TerminalFixture $p;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} 'held-native-helper-wmi-null'
Accept-Helper 'retired image-race parent retains error with terminal proof' {param($c)$p=Add-Parent $c;Set-ImageRaceFixture $p;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} 'held-native-helper-wmi-null'
Accept-Helper 'pending actual held parent stays pending' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null;$p.metadataCompleted=$false} 'pending-audited-parent'
Accept-Helper 'completed parent awaits same-clock policy approval' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null} 'pending-audited-parent'
Accept-Helper 'Setup Update hook GPU ancestry with retired identities' {
    param($c)
    $p=Add-Parent $c;$p.executablePath='C:\Users\fixture\AppData\Local\ETS2TelemetryDesktop\app-0.1.0\ETS2TelemetryDesktop.exe';$p.nativeImageAfterQuery=$p.executablePath;$p.metadataParentProcessId=22;$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0
    $update=(New-HelperFixture).record;$update.pid=22;$update.metadataParentProcessId=23;$update.metadataPolicy='held-native-helper-wmi-image';$update.nativeIdentityRetired=$true;$update.nativeFinalSignaled=$true;$update.exitCode=0;$update.executablePath='C:\Users\fixture\AppData\Local\SquirrelTemp\Update.exe';$update.nativeImageAfterQuery=$update.executablePath
    $setup=(New-HelperFixture).record;$setup.pid=23;$setup.metadataPolicy='held-native-helper-wmi-null';$setup.nativeIdentityRetired=$true;$setup.nativeFinalSignaled=$true;$setup.exitCode=0
    $c.records+=@($update,$setup);$c.record.executablePath=$p.executablePath;$c.record.nativeImageAfterQuery=$p.executablePath;$c.metadata.CommandLine='"'+$p.executablePath+'" --type=gpu-process --gpu-preferences=fixture'
} 'held-native-helper-wmi-null'
$image='Helper advisory metadata image is empty or malformed.';$native='Helper held initial native identity or liveness differs.';$afterImage='Helper successful after-query native image differs.';$afterState='Helper after-query native state is invalid.';$afterFailure='Helper failed after-query image lacks same-handle terminal exit 0.';$observed='Helper metadata observation is incomplete or clipped.';$parent='Helper parent chain is unknown, conflicted or cyclic.';$failedParent='Helper parent proof failed or belongs to another role.';$role='Helper identity duplicates or overlaps another role.';$token='Helper executable token is missing or malformed.';$key='Helper returned WMI process key or class differs.'
Reject-Helper 'empty image' {param($c)$c.metadata.ExecutablePath=''} $image
Reject-Helper 'nonstring advisory image' {param($c)$c.metadata.ExecutablePath=42} $image
Reject-Helper 'missing returned ProcessId' {param($c)$c.metadata.PSObject.Properties.Remove('ProcessId')} 'Helper returned metadata identity operands are missing.'
Reject-Helper 'missing requested PID operand' {param($c)$c.metadata.PSObject.Properties.Remove('RequestedProcessId')} 'Helper returned metadata identity operands are missing.'
Reject-Helper 'missing returned Handle' {param($c)$c.metadata.PSObject.Properties.Remove('Handle')} 'Helper returned metadata identity operands are missing.'
Reject-Helper 'missing returned class' {param($c)$c.metadata.PSObject.Properties.Remove('ClassName')} 'Helper returned metadata identity operands are missing.'
Reject-Helper 'missing returned object path' {param($c)$c.metadata.PSObject.Properties.Remove('ObjectPath')} 'Helper returned metadata identity operands are missing.'
Reject-Helper 'wrong requested PID' {param($c)$c.metadata.RequestedProcessId=21} $key
Reject-Helper 'wrong returned PID' {param($c)$c.metadata.ProcessId=[uint32]21} $key
Reject-Helper 'null returned PID' {param($c)$c.metadata.ProcessId=$null} $key
Reject-Helper 'string returned PID' {param($c)$c.metadata.ProcessId='20'} $key
Reject-Helper 'wrong returned Handle' {param($c)$c.metadata.Handle='21'} $key
Reject-Helper 'empty returned Handle' {param($c)$c.metadata.Handle=''} $key
Reject-Helper 'nonnull malformed returned Handle' {param($c)$c.metadata.Handle=20} $key
Reject-Helper 'wrong returned object class' {param($c)$c.metadata.ClassName='Win32_Thread'} $key
Reject-Helper 'null returned object class' {param($c)$c.metadata.ClassName=$null} $key
Reject-Helper 'wrong object path PID' {param($c)$c.metadata.ObjectPath='Win32_Process.Handle="21"'} $key
Reject-Helper 'wrong object path key' {param($c)$c.metadata.ObjectPath='Win32_Process.ProcessId="20"'} $key
Reject-Helper 'wrong object path class' {param($c)$c.metadata.ObjectPath='Win32_Thread.Handle="20"'} $key
Reject-Helper 'empty returned object path' {param($c)$c.metadata.ObjectPath=''} $key
Reject-Helper 'additional object path key' {param($c)$c.metadata.ObjectPath='Win32_Process.Handle="20",Extra="1"'} $key
Reject-Helper 'missing image operand' {param($c)$c.metadata.PSObject.Properties.Remove('ExecutablePath')} 'Helper metadata operands are missing.'
Reject-Helper 'missing command operand' {param($c)$c.metadata.PSObject.Properties.Remove('CommandLine')} 'Helper metadata operands are missing.'
Reject-Helper 'missing native error operand' {param($c)$c.record.Remove('nativeImageAfterQueryFailure')} 'Helper after-query native operands are missing.'
Reject-Helper 'metadata query error' {param($c)$c.metadata.Failure='timeout'} $observed
Reject-Helper 'metadata empty error' {param($c)$c.metadata.Failure=''} $observed
Reject-Helper 'metadata incomplete' {param($c)$c.record.metadataCompleted=$false} $observed
Reject-Helper 'diagnostic clipped command' {param($c)$c.record.diagnosticTruncatedFields=@('metadataCommandLine')} $observed
Reject-Helper 'unheld native identity' {param($c)$c.record.nativeIdentityHeld=$false} $observed
Reject-Helper 'before native image query error' {param($c)$c.record.queryFailure='denied'} $observed
Reject-Helper 'native after image differs' {param($c)$c.record.nativeImageAfterQuery='C:\Temp\Setup.exe'} $afterImage
Reject-Helper 'native after image error' {param($c)$c.record.nativeImageAfterQueryFailure='denied'} $afterFailure
Reject-Helper 'native after exit error' {param($c)$c.record.nativeExitAfterQueryFailure='denied'} $afterState
Reject-Helper 'native before not live' {param($c)$c.record.nativeExitBefore=0} $native
Reject-Helper 'native before signaled' {param($c)$c.record.nativeSignaledBefore=$true} $native
Reject-Helper 'native after failed exit' {param($c)$c.record.nativeExitAfterQuery=9} $afterState
Reject-Helper 'native after 259 signaled' {param($c)$c.record.nativeSignaledAfterQuery=$true} $afterState
Reject-Helper 'native after missing signal' {param($c)$c.record.nativeSignaledAfterQuery=$null} $afterState
Reject-Helper 'terminal successful differing image always fails' {param($c)Set-TerminalFixture $c.record;$c.record.nativeImageAfterQuery='C:\Temp\Other.exe'} $afterImage
Reject-Helper 'terminal fabricated matching unqueried image' {param($c)Set-TerminalFixture $c.record;$c.record.nativeImageAfterQuery=$c.record.executablePath} 'Helper skipped after-query image without terminal exit 0.'
Reject-Helper 'live missing unqueried image' {param($c)$c.record.nativeImageAttemptedAfterQuery=$false;$c.record.nativeImageAfterQuery=$null} 'Helper skipped after-query image without terminal exit 0.'
Reject-Helper 'live attempted image error' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeExitAfterQuery=259;$c.record.nativeSignaledAfterQuery=$false} $afterFailure
Reject-Helper 'transitional zero unsignaled image error' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeSignaledAfterQuery=$false} $afterFailure
Reject-Helper 'terminal image-race nonzero' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeExitAfterQuery=9} $afterState
Reject-Helper 'terminal image-race exit query failure' {param($c)Set-ImageRaceFixture $c.record;$c.record.nativeExitAfterQueryFailure='denied'} $afterState
Reject-Helper 'terminal classification changed' {param($c)Set-TerminalFixture $c.record;$c.record.nativeAfterQueryProof='live-image'} 'Helper after-query native classification differs.'
Reject-Helper 'missing image-attempt witness' {param($c)$c.record.Remove('nativeImageAttemptedAfterQuery')} 'Helper after-query native operands are missing.'
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
Reject-Helper 'parent transitional zero image error cannot anchor child' {param($c)$p=Add-Parent $c;Set-ImageRaceFixture $p;$p.nativeSignaledAfterQuery=$false} $failedParent
Reject-Helper 'parent terminal classification mutated' {param($c)$p=Add-Parent $c;Set-TerminalFixture $p;$p.nativeAfterQueryProof='live-image'} $failedParent
Reject-Helper 'retired parent lacks actual final signal' {param($c)$p=Add-Parent $c;$p.nativeIdentityRetired=$true;$p.exitCode=0} $failedParent
Reject-Helper 'console parent masquerading helper' {param($c)$p=Add-Parent $c;$p.executablePath='C:\Windows\System32\conhost.exe'} $failedParent
Reject-Helper 'parent role conflict' {param($c)$p=Add-Parent $c;$p.role='driver-console'} $failedParent
Reject-Helper 'clipped pending parent' {param($c)$p=Add-Parent $c;$p.metadataPolicy=$null;$p.diagnosticTruncatedFields=@('metadataImage')} $failedParent
Reject-Helper 'recorded parent mutation' {param($c)$c.record.metadataParentProcessId=21} 'Helper recorded parent differs from its original metadata.'
Reject-Helper 'wrong command executable' {param($c)$c.metadata.CommandLine='C:\Temp\Setup.exe --silent'} 'Helper command executable differs from its native image.'
function Reject-Advisory([string]$name,[scriptblock]$change,[string]$expected){Reject-Helper $name {param($c)$c.metadata.ExecutablePath='C:\WINDOWS\SYSTEM32\ntdll.dll';& $change $c}.GetNewClosure() $expected}
Reject-Advisory 'advisory mismatch with wrong WMI key' {param($c)$c.metadata.ProcessId=[uint32]21} $key
Reject-Advisory 'advisory mismatch with lost command' {param($c)$c.metadata.CommandLine=$null} $token
Reject-Advisory 'advisory mismatch with wrong command token' {param($c)$c.metadata.CommandLine='C:\Temp\ntdll.dll --silent'} 'Helper command executable differs from its native image.'
Reject-Advisory 'advisory mismatch with lost native image' {param($c)$c.record.nativeImageAfterQuery=$null} $afterFailure
Reject-Advisory 'advisory mismatch with unknown parent' {param($c)$c.metadata.ParentProcessId=90;$c.record.metadataParentProcessId=90} $parent
Reject-Advisory 'advisory mismatch with query error' {param($c)$c.metadata.Failure='denied'} $observed
Reject-Advisory 'advisory mismatch with clipped key' {param($c)$c.record.diagnosticTruncatedFields=@('metadataObjectPath')} $observed
Reject-Advisory 'advisory mismatch cannot consume console role' {param($c)$c.record.executablePath='C:\Windows\System32\conhost.exe'} $role
foreach($bad in @($null,'','Setup.exe --silent',' C:\a.exe','"C:\a.exe','"C:\a.exe"tail','C:\a"b.exe','"C:\a\"b.exe"',"C:\a.exe`r`n--silent")){Reject-Helper ('malformed command '+[string]$bad) {param($c)$c.metadata.CommandLine=$bad}.GetNewClosure() $token}
function Reject-Exit([string]$name,[scriptblock]$change){$r=(New-HelperFixture).record;$r.metadataPolicy='held-native-helper-wmi-null';$r.exitCode=0;$r.nativeFinalSignaled=$true;& $change $r;$failure=$null;try{Assert-InstallerHelperExit $r}catch{$failure=$_.Exception.Message};if($failure -cne 'Helper final native signaled exit 0 proof is incomplete.'){throw "Final rejection $name differs: $failure"};$rows.Add(@{name=$name;passed=$true;failure=$failure})}
$final=(New-HelperFixture).record;$final.metadataPolicy='held-native-helper-wmi-null';$final.nativeFinalSignaled=$true;$final.exitCode=0;Assert-InstallerHelperExit $final;$rows.Add(@{name='actual final signaled zero';passed=$true})
$final.metadataPolicy='held-native-helper-wmi-advisory-mismatch';Assert-InstallerHelperExit $final;$rows.Add(@{name='advisory policy still requires final signaled zero';passed=$true})
Reject-Exit 'GPU transitional zero not final' {param($r)$r.nativeFinalSignaled=$false}
Reject-Exit 'final nonzero' {param($r)$r.exitCode=9}
Reject-Exit 'final live259' {param($r)$r.exitCode=259}
Reject-Exit 'final missing wait state' {param($r)$r.nativeFinalSignaled=$null}
Reject-Exit 'final pending parent policy' {param($r)$r.metadataPolicy='pending-audited-parent'}
Reject-Exit 'final metadata failure' {param($r)$r.queryFailure='denied'}
Reject-Exit 'final missing native error operand' {param($r)$r.Remove('exitQueryFailure')}
# Extract only the pure diagnostic-copy function, never the observer's executable body.
$parseErrors=$null;$observerAst=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'Observe-InstallerJob.ps1'),[ref]$null,[ref]$parseErrors)
if($parseErrors.Count){throw 'Observer diagnostic source failed to parse.'}
$diagnosticFunctions=@($observerAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Set-HelperMetadataDiagnostics'},$true))
if($diagnosticFunctions.Count -ne 1){throw 'One actual diagnostic-copy function required.'}
. ([scriptblock]::Create($diagnosticFunctions[0].Extent.Text))
$diagnostic=New-HelperFixture;$diagnostic.metadata.ExecutablePath='C:\WINDOWS\SYSTEM32\ntdll.dll';$before=$diagnostic.metadata|ConvertTo-Json -Compress
Set-HelperMetadataDiagnostics $diagnostic.record $diagnostic.metadata
if($diagnostic.record.metadataImageObservation -cne 'advisory-mismatch' -or $diagnostic.record.metadataImage -cne 'C:\WINDOWS\SYSTEM32\ntdll.dll' -or $diagnostic.record.metadataHandle -cne '20' -or $diagnostic.record.metadataClassName -cne 'Win32_Process' -or ($diagnostic.metadata|ConvertTo-Json -Compress) -cne $before){throw 'Actual diagnostic copy lost raw identity or mislabeled the advisory image.'}
$rows.Add(@{name='actual diagnostic retains advisory raw image and WMI key';passed=$true})
$diagnostic.metadata.ObjectPath='x'*4097;$before=$diagnostic.metadata|ConvertTo-Json -Compress
Set-HelperMetadataDiagnostics $diagnostic.record $diagnostic.metadata
if($diagnostic.record.metadataObjectPath.Length -ne 4096 -or $diagnostic.record.diagnosticTruncatedFields -notcontains 'metadataObjectPath' -or $diagnostic.metadata.ObjectPath.Length -ne 4097 -or ($diagnostic.metadata|ConvertTo-Json -Compress) -cne $before){throw 'Actual diagnostic bound mutated original metadata or failed to retain its clipping flag.'}
$failure=$null;try{$null=Invoke-HelperFixture $diagnostic}catch{$failure=$_.Exception.Message}
if($failure -cne 'Helper metadata observation is incomplete or clipped.'){throw 'Clipped diagnostic operands were not rejected by the actual helper policy.'}
$rows.Add(@{name='actual diagnostic key clipping preserves source and fails policy';passed=$true;failure=$failure})
$nativeErrorFunctions=@($observerAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-InstallerNativeErrorCode'},$true))
if($nativeErrorFunctions.Count -ne 1){throw 'One actual native-error diagnostic function required.'}
. ([scriptblock]::Create($nativeErrorFunctions[0].Extent.Text))
$syntheticError=[ComponentModel.Win32Exception]::new(31,'Synthetic fixed error, no native query')
$wrappedError=[Exception]::new('Synthetic wrapper',$syntheticError)
if((Read-InstallerNativeErrorCode $wrappedError) -ne 31 -or $null -ne (Read-InstallerNativeErrorCode ([Exception]::new('No Win32 code')))){throw 'Actual bounded native-error diagnostic lost code or invented one.'}
$rows.Add(@{name='actual inner Win32 code retained without inventing unavailable code';passed=$true})
$deepError=$syntheticError;for($depth=0;$depth -lt 8;$depth++){$deepError=[Exception]::new('Bounded synthetic wrapper',$deepError)}
if($null -ne (Read-InstallerNativeErrorCode $deepError)){throw 'Actual native-error diagnostic exceeded its eight-level bound.'}
$rows.Add(@{name='actual inner-error diagnostic has finite depth';passed=$true})
$terminalDiagnostic=New-HelperFixture;Set-ImageRaceFixture $terminalDiagnostic.record;$originalError=$terminalDiagnostic.record.nativeImageAfterQueryFailure
Set-HelperMetadataDiagnostics $terminalDiagnostic.record $terminalDiagnostic.metadata
if($terminalDiagnostic.record.nativeImageAfterQueryFailure -cne $originalError -or $terminalDiagnostic.record.nativeImageAfterQueryErrorCode -ne 31 -or $null -ne $terminalDiagnostic.record.nativeImageAfterQuery -or (Invoke-HelperFixture $terminalDiagnostic) -cne 'held-native-helper-wmi-null'){throw 'Actual diagnostic copy replaced terminal error, code or unqueried path.'}
$rows.Add(@{name='actual diagnostic preserves terminal image error and absent after path';passed=$true})
function New-TerminalFixture {
    $c=New-HelperFixture;Set-TerminalFixture $c.record
    $c.record.executablePath='C:\Users\fixture\AppData\Local\ETS2TelemetryDesktop\app-0.1.1\ETS2TelemetryDesktop.exe'
    $c.record.nativeCustody=@{snapshot=@{AssignedCount=4;ListedCount=4;Pids=@(10,11,13,20)};scope=@{LimitFlags=8712;ActiveProcessLimit=16;JobMemoryBytes=2147483648;CpuFlags=5;CpuRate=2500};exitCode=259;signaled=$false;failure=$null}
    $c.record.sealedImageSha256='a'*64;$c.record.sealedImageBytes=42;$c.record.sealedImageFailure=$null
    $c.images=@(@{path=$c.record.executablePath;sha256=('a'*64);bytes=42})
    $c.metadata=[pscustomobject]@{RequestedProcessId=20;ProcessId=$null;Handle=$null;ObjectPath=$null;ClassName=$null;ExecutablePath=$null;CommandLine=$null;ParentProcessId=0;Failure='Retained synthetic single Get NotFound';FailureStage='get';ManagementErrorCode=[int]-2147217406}
    return $c
}
function New-AccountingContextFixture([int]$index){
    $steps=@(@('install','0.1.0',45000),@('repair','0.1.0',45000),@('smoke','0.1.0',30000),@('update','0.1.1',45000),@('smoke','0.1.1',30000),@('uninstall','0.1.1',30000))
    $entry=$steps[$index-1];$directory='C:\ETS2ET001Acceptance\evidence\'+('a'*32)+'\step-'+$index+'-'+$entry[0]+'-'+$entry[1];$now=[datetime]::Parse('2026-10-11T08:00:00Z',[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AdjustToUniversal);$binary='C:\Users\fixture\AppData\Local\ETS2TelemetryDesktop'
    return @{directory=$directory;ready=($directory+'\observer-ready.json');stop=($directory+'\observer-stop.json');result=($directory+'\job-observation.json');binary=$binary;now=$now;digest=('a'*64);guard=[pscustomobject]@{manifestSha256=('a'*64);vmUuid='94674D56-D803-F4D5-9AAC-C4E91CFB475F';labId='9a047927-f94b-41cb-bda8-abcc7d0b76f1';jobRequired=$true;step=$entry[0];version=$entry[1];binaryRoot=$binary;verifiedUtc=$now.ToString('o');outerDeadlineUtc=$now.AddSeconds(200).ToString('o')};manifest=[pscustomobject]@{schemaVersion=1;kind='et001-installer';guestRoot='C:\ETS2ET001Acceptance';guestUuid='94674D56-D803-F4D5-9AAC-C4E91CFB475F';labId='9a047927-f94b-41cb-bda8-abcc7d0b76f1';fixtureOnly=$true;applicationVersion='0.1.0';fixtureVersion='0.1.1';runtimeFiles=@([pscustomobject]@{path='ETS2TelemetryDesktop.exe';sha256=('b'*64);bytes=42})};ceiling=$entry[2]}
}
function Invoke-AccountingContext($c){Assert-InstallerAccountingContext $c.guard $c.manifest $c.digest $c.directory $c.ready $c.stop $c.result $c.binary $c.now}
function New-ContextReceipt($c,[int]$budget){$quoted=@('C:\ETS2ET001Acceptance\tools\node.exe','C:\ETS2ET001Acceptance\harness\installer-step.mjs','C:\ETS2ET001Acceptance',$c.directory,($c.directory+'\step-guard.json'),$c.guard.step,$c.guard.version,[string]$budget)|ForEach-Object {'"'+$_+'"'};return [pscustomobject]@{driverPid=10;observerPid=11;controllerPid=12;driverCommandLine=($quoted -join ' ')}}
foreach($index in 1..6){
    $c=New-AccountingContextFixture $index;$context=Invoke-AccountingContext $c
    if($context.maximumMilliseconds -ne $c.ceiling -or $context.expectedImages.Count -ne $(if($index -eq 4){2}else{1})){throw 'Actual context lost exact step policy.'}
    foreach($budget in @($c.ceiling,10000,12345)){if((Assert-InstallerAccountingCommand $context (New-ContextReceipt $c $budget) 10 11 12) -ne $budget){throw 'Actual context lost exact shortened created command budget.'}}
    foreach($budget in @(($c.ceiling+1),9999)){ $failure=$null;try{$null=Assert-InstallerAccountingCommand $context (New-ContextReceipt $c $budget) 10 11 12}catch{$failure=$_.Exception.Message};if($failure -notin @('Accounting context created budget exceeds the existing step bounds.','Accounting context differs from the exact created driver command.')){throw 'Actual context accepted a changed step budget.'} }
    $rows.Add(@{name=('actual accounting context step '+$index+' exact and shortened budgets');passed=$true})
}
function Reject-Context([string]$name,[scriptblock]$change,[string]$expected){$c=New-AccountingContextFixture 4;& $change $c;$failure=$null;try{$null=Invoke-AccountingContext $c}catch{$failure=$_.Exception.Message};if($failure -cne $expected){throw "Actual context rejection $name differs: $failure"};$rows.Add(@{name=$name;passed=$true;failure=$failure})}
$contextError='Accounting context manifest, lab identity or step differs.'
Reject-Context 'actual context wrong manifest hash' {param($c)$c.digest='c'*64} $contextError
Reject-Context 'actual context wrong lab identity' {param($c)$c.guard.labId='other'} $contextError
Reject-Context 'actual context wrong manifest kind' {param($c)$c.manifest.kind='other'} $contextError
Reject-Context 'actual context wrong step version' {param($c)$c.guard.version='0.1.0'} $contextError
Reject-Context 'actual context wrong step name' {param($c)$c.guard.step='smoke'} $contextError
Reject-Context 'actual context wrong binary root' {param($c)$c.guard.binaryRoot='C:\Temp\ETS2TelemetryDesktop'} $contextError
Reject-Context 'actual context wrong directory' {param($c)$c.directory='C:\Temp\step-4-update-0.1.1'} 'Accounting context paths differ from the controlled step.'
Reject-Context 'actual context swapped ready path' {param($c)$c.ready=$c.stop} 'Accounting context paths differ from the controlled step.'
Reject-Context 'actual context expired guard' {param($c)$c.guard.verifiedUtc=$c.now.AddSeconds(-90).ToString('o')} 'Accounting context guard has expired.'
Reject-Context 'actual context malformed timestamp' {param($c)$c.guard.verifiedUtc='not a date'} 'Accounting context timestamps are malformed.'
Reject-Context 'actual context missing sealed EXE' {param($c)$c.manifest.runtimeFiles=@()} 'Accounting context has no exact sealed app image.'
Reject-Context 'actual context duplicate sealed EXE' {param($c)$c.manifest.runtimeFiles+=@($c.manifest.runtimeFiles[0])} 'Accounting context has no exact sealed app image.'
$c=New-AccountingContextFixture 4;$context=Invoke-AccountingContext $c;$receipt=New-ContextReceipt $c 45000;$receipt.driverCommandLine=$receipt.driverCommandLine.Replace('"update"','"repair"');$failure=$null;try{$null=Assert-InstallerAccountingCommand $context $receipt 10 11 12}catch{$failure=$_.Exception.Message};if($failure -cne 'Accounting context differs from the exact created driver command.'){throw 'Actual context accepted rewritten command step.'};$rows.Add(@{name='actual context exact created command wrong step rejected';passed=$true})
function Invoke-TerminalFixture($c){Assert-InstallerTerminalAccounting $c.record $c.metadata $c.records $c.images 10 11 12 $c.consoles}
function Check-Terminal([string]$name,[scriptblock]$change,[string]$expected){$c=New-TerminalFixture;& $change $c;$before=$c.metadata|ConvertTo-Json -Compress;$failure=$null;$policy=$null;try{$policy=Invoke-TerminalFixture $c}catch{$failure=$_.Exception.Message};if(($c.metadata|ConvertTo-Json -Compress) -cne $before){throw 'Terminal accounting mutated missing metadata.'};if($expected -ceq 'terminal-metadata-unresolved'){if($policy -cne $expected -or $failure){throw "Terminal acceptance $name differs: $failure"}}elseif($failure -cne $expected){throw "Terminal rejection $name differs: $failure"};$rows.Add(@{name=$name;passed=$true;policy=$policy;failure=$failure})}
Check-Terminal 'terminal NotFound counts member without invented metadata' {} 'terminal-metadata-unresolved'
$unavailable=New-TerminalFixture;$rawUnavailable=$unavailable.metadata|ConvertTo-Json -Compress;Set-HelperMetadataDiagnostics $unavailable.record $unavailable.metadata
if($unavailable.record.metadataImageObservation -cne 'unavailable-get-notfound' -or $null -ne $unavailable.record.metadataImage -or $null -ne $unavailable.record.metadataCommandLine -or ($unavailable.metadata|ConvertTo-Json -Compress) -cne $rawUnavailable){throw 'Actual diagnostic labelled failed Get as a returned null image.'};$rows.Add(@{name='actual NotFound diagnostic retains null as unavailable provider data';passed=$true})
$typed='Terminal accounting requires typed single-Get NotFound.';$partial='Terminal accounting cannot consume partial returned metadata.';$custody='Terminal accounting live Job custody is incomplete.';$membership='Terminal accounting Job membership differs.';$sealed='Terminal accounting installed image is not sealed.'
foreach($change in @(@{FailureStage='queue'},@{FailureStage='returned-fields'},@{ManagementErrorCode=[int]-2147217405},@{ManagementErrorCode=$null},@{ManagementErrorCode='-2147217406'},@{Failure=$null},@{RequestedProcessId=21})){Check-Terminal ('typed Get proof '+($change|ConvertTo-Json -Compress)) {param($c)foreach($k in $change.Keys){$c.metadata.$k=$change[$k]}}.GetNewClosure() $typed}
foreach($keyName in @('ProcessId','Handle','ObjectPath','ClassName','ExecutablePath','CommandLine')){Check-Terminal ('partial returned '+$keyName) {param($c)$c.metadata.$keyName='returned'}.GetNewClosure() $partial}
Check-Terminal 'missing typed Get operand' {param($c)$c.metadata.PSObject.Properties.Remove('FailureStage')} 'Terminal accounting typed metadata operands are missing.'
Check-Terminal 'missing Job custody' {param($c)$c.record.nativeCustody=$null} $custody
foreach($change in @(@{exitCode=0},@{signaled=$true},@{failure='native failure'})){Check-Terminal ('invalid live custody '+($change|ConvertTo-Json -Compress)) {param($c)foreach($k in $change.Keys){$c.record.nativeCustody[$k]=$change[$k]}}.GetNewClosure() $custody}
Check-Terminal 'snapshot lost held member' {param($c)$c.record.nativeCustody.snapshot.Pids=@(10,11,13,21)} $membership
Check-Terminal 'snapshot inconsistent count' {param($c)$c.record.nativeCustody.snapshot.ListedCount=3} $membership
Check-Terminal 'snapshot includes controller' {param($c)$c.record.nativeCustody.snapshot.Pids=@(10,11,12,20)} $membership
Check-Terminal 'snapshot duplicate PID' {param($c)$c.record.nativeCustody.snapshot.Pids=@(10,11,20,20)} $membership
Check-Terminal 'different Job caps' {param($c)$c.record.nativeCustody.scope.CpuRate=5000} 'Terminal accounting Job limits differ.'
foreach($change in @(@{sealedImageSha256=('b'*64)},@{sealedImageBytes=43},@{sealedImageFailure='hash failure'},@{executablePath='C:\Temp\ETS2TelemetryDesktop.exe'})){Check-Terminal ('unsealed image '+($change|ConvertTo-Json -Compress)) {param($c)foreach($k in $change.Keys){$c.record[$k]=$change[$k]}}.GetNewClosure() $sealed}
Check-Terminal 'live NotFound is not accounted' {param($c)$c.record.nativeImageAttemptedAfterQuery=$true;$c.record.nativeImageAfterQuery=$c.record.executablePath;$c.record.nativeAfterQueryProof='live-image';$c.record.nativeExitAfterQuery=259;$c.record.nativeSignaledAfterQuery=$false} 'Terminal accounting requires actual same-handle terminal exit 0.'
Check-Terminal 'transition zero unsignaled is not accounted' {param($c)$c.record.nativeImageAttemptedAfterQuery=$true;$c.record.nativeImageAfterQuery=$c.record.executablePath;$c.record.nativeAfterQueryProof='live-image';$c.record.nativeSignaledAfterQuery=$false} 'Terminal accounting requires actual same-handle terminal exit 0.'
Check-Terminal 'terminal nonzero is rejected' {param($c)$c.record.nativeExitAfterQuery=9} 'Helper after-query native state is invalid.'
Check-Terminal 'differing native image still rejected' {param($c)$c.record.nativeImageAttemptedAfterQuery=$true;$c.record.nativeImageAfterQuery='C:\Temp\Other.exe'} 'Helper successful after-query native image differs.'
Check-Terminal 'terminal accounting cannot absorb image error too' {param($c)Set-ImageRaceFixture $c.record} 'Terminal accounting native state has image errors.'
Check-Terminal 'native before not live' {param($c)$c.record.nativeExitBefore=0} 'Terminal accounting native or metadata custody is incomplete.'
Check-Terminal 'clipped failure is rejected' {param($c)$c.record.diagnosticTruncatedFields=@('metadataProviderFailure')} 'Terminal accounting native or metadata custody is incomplete.'
Check-Terminal 'unresolved cannot acquire parent' {param($c)$c.record.parentProcessId=10} 'Terminal accounting cannot invent arguments or ancestry.'
Check-Terminal 'console role cannot use terminal policy' {param($c)$c.record.role='driver-console'} 'Terminal accounting identity overlaps another role.'
Check-Terminal 'duplicate terminal identity rejected' {param($c)$c.records+=@($c.record)} 'Terminal accounting identity overlaps another role.'
$terminal=New-TerminalFixture;$terminal.record.role='terminal-metadata-unresolved';$terminal.record.metadataPolicy='terminal-metadata-unresolved';$terminal.record.nativeFinalSignaled=$true;$terminal.record.exitCode=0
Assert-InstallerHelperExit $terminal.record;$rows.Add(@{name='terminal accounting still requires final signaled zero';passed=$true})
$terminal.record.nativeFinalSignaled=$false;$failure=$null;try{Assert-InstallerHelperExit $terminal.record}catch{$failure=$_.Exception.Message};if($failure -cne 'Helper final native signaled exit 0 proof is incomplete.'){throw 'Terminal final proof accepted a transition.'};$rows.Add(@{name='terminal accounting final transition rejected';passed=$true})
Reject-Helper 'unresolved member cannot anchor parent DAG' {param($c)$p=Add-Parent $c;$p.role='terminal-metadata-unresolved';$p.metadataPolicy='terminal-metadata-unresolved';$p.nativeIdentityRetired=$true;$p.nativeFinalSignaled=$true;$p.exitCode=0} $failedParent
# Compile only the actual pure capture method and metadata DTO; no production DLL/native method.
Add-Type -AssemblyName System.Management
$librarySource=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'InstallerJobView.cs'))
$dto=[regex]::Match($librarySource,'(?s)public sealed class InstallerMetadata \{.*?\r?\n\}').Value
$capture=[regex]::Match($librarySource,'(?s)public static void CaptureMetadataFailure\(.*?\r?\n    \}').Value
if(!$dto -or !$capture){throw 'Actual pure metadata capture source missing.'}
Add-Type -TypeDefinition ('using System;using System.Management;'+$dto+'public static class PureMetadataCapture {'+$capture+'}') -ReferencedAssemblies System.Management.dll
$constructor=[Management.ManagementException].GetConstructor([Reflection.BindingFlags]'Instance,NonPublic',$null,[type[]]@([Management.ManagementStatus],[string],[Management.ManagementBaseObject]),$null)
if(!$constructor){throw 'Framework typed ManagementException constructor missing.'}
foreach($status in @([Management.ManagementStatus]::NotFound,[Management.ManagementStatus]::AccessDenied)){
    $exception=$constructor.Invoke([object[]]@($status,'Synthetic constructed exception: no WMI query',$null));$captured=[InstallerMetadata]::new();[PureMetadataCapture]::CaptureMetadataFailure($captured,$exception,'get')
    if($captured.ManagementErrorCode -ne [int]$status -or $captured.FailureStage -cne 'get' -or !$captured.Failure -or $null -ne $captured.CommandLine){throw 'Actual typed exception capture lost status or invented fields.'}
    $rows.Add(@{name=('actual typed capture '+$status);passed=$true;managementErrorCode=$captured.ManagementErrorCode})
}
$captured=[InstallerMetadata]::new();[PureMetadataCapture]::CaptureMetadataFailure($captured,[Exception]::new('Not found'),'get');if($null -ne $captured.ManagementErrorCode){throw 'Actual capture matched generic exception text.'};$rows.Add(@{name='actual typed capture rejects generic Not found text';passed=$true})
$readFunction=@($observerAst.FindAll({param($node)$node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Read-InstallerBoundedJson'},$true));if($readFunction.Count -ne 1){throw 'Actual bounded context reader missing.'};. ([scriptblock]::Create($readFunction[0].Extent.Text))
$readDirectory=Join-Path ([IO.Path]::GetTempPath()) ('et001-inert-reader-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($readDirectory)
try{$readPath=Join-Path $readDirectory 'guard.json';[IO.File]::WriteAllText($readPath,'{"value":1}',[Text.UTF8Encoding]::new($false));$read=Read-InstallerBoundedJson $readPath 11;if($read.value.value -ne 1 -or $read.sha256 -notmatch '^[a-f0-9]{64}$'){throw 'Actual bounded context reader lost bytes.'};[IO.File]::WriteAllText($readPath,('x'*12));$failure=$null;try{$null=Read-InstallerBoundedJson $readPath 11}catch{$failure=$_.Exception.Message};if($failure -cne 'Accounting context exceeds its bounded input size.'){throw 'Actual bounded context reader accepted an oversized input.'}}finally{[IO.Directory]::Delete($readDirectory,$true)}
$rows.Add(@{name='actual bounded context reader rejects before parsing oversized bytes';passed=$true})
$sealDto=[regex]::Match($librarySource,'(?s)public sealed class InstallerImageSeal \{.*?\r?\n\}').Value
$sealMethod=[regex]::Match($librarySource,'(?s)public static Task<InstallerImageSeal> SealAsync\(.*?\r?\n    \}').Value
if(!$sealDto -or !$sealMethod){throw 'Actual bounded image-seal source missing.'}
Add-Type -TypeDefinition ('using System;using System.IO;using System.Security.Cryptography;using System.Threading.Tasks;'+$sealDto+'public static class PureImageSeal {'+$sealMethod+'}')
$sealDirectory=Join-Path ([IO.Path]::GetTempPath()) ('et001-inert-seal-'+[guid]::NewGuid().ToString('N'));$null=[IO.Directory]::CreateDirectory($sealDirectory)
try{
    $sealPath=Join-Path $sealDirectory 'image.bin';[IO.File]::WriteAllBytes($sealPath,[Text.Encoding]::ASCII.GetBytes('abc'));$task=[PureImageSeal]::SealAsync($sealPath,3)
    if(!$task.Wait(2000) -or $task.Result.Failure -or $task.Result.Bytes -ne 3 -or $task.Result.Sha256 -cne 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'){throw 'Actual bounded image seal lost bytes or digest.'}
    $task=[PureImageSeal]::SealAsync($sealPath,4);if(!$task.Wait(2000) -or !$task.Result.Failure -or $null -ne $task.Result.Sha256){throw 'Actual bounded image seal accepted wrong size.'}
    [IO.File]::Delete($sealPath);$task=[PureImageSeal]::SealAsync($sealPath,3);if(!$task.Wait(2000) -or !$task.Result.Failure -or $null -ne $task.Result.Sha256){throw 'Actual bounded image seal invented an unavailable digest.'}
}finally{[IO.Directory]::Delete($sealDirectory,$true)}
$rows.Add(@{name='actual asynchronous image seal retains digest and rejects wrong or missing bytes';passed=$true})
[ordered]@{passed=$true;nativeObserverInvoked=$false;applicationLaunched=$false;cases=$rows.ToArray()}|ConvertTo-Json -Depth 4 -Compress
