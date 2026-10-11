# Inert temporary files exercise the actual uninstall predicate; no installer or native API.
[CmdletBinding()]param([Parameter(Mandatory)][string]$FixtureDirectory)
$ErrorActionPreference='Stop';. (Join-Path $PSScriptRoot 'Assert-UninstallResidue.ps1')
if(![IO.Path]::IsPathRooted($FixtureDirectory) -or (Test-Path -LiteralPath $FixtureDirectory)){throw 'Fresh absolute pure-fixture directory required.'}
New-Item -ItemType Directory -Path $FixtureDirectory|Out-Null
$vendor=[Text.Encoding]::UTF8.GetBytes('synthetic immutable vendor helper')
$hash=[Security.Cryptography.SHA256]::Create();try{$digest=[BitConverter]::ToString($hash.ComputeHash($vendor)).Replace('-','')}finally{$hash.Dispose()}
$seal=@{bytes=$vendor.Length;sha256=$digest};$rows=[Collections.Generic.List[object]]::new();$ordinal=0
function Case([string]$name,[string]$expected,[scriptblock]$prepare,[object[]]$registration=@(),[object[]]$links=@()){
    $script:ordinal++;$root=Join-Path $FixtureDirectory ([string]$script:ordinal+'-'+$name);New-Item -ItemType Directory -Path $root|Out-Null
    [IO.File]::WriteAllBytes((Join-Path $root '.dead'),[byte[]]@(32));& $prepare $root
    $actual=$null;$receipt=$null;try{$receipt=Assert-UninstallResidue -BinaryRoot $root -Version '0.1.1' -Squirrel $seal -Registration $registration -ProductShortcuts $links}catch{$actual=$_.Exception.Message}
    if($expected){if($actual -cne $expected){throw ('Case '+$name+' expected '+$expected+'; actual '+$actual)}}else{if($actual -or $receipt.productUninstalled -ne $true -or $receipt.vendorCleanupPending -ne $true -or $receipt.binaryRootEmpty -ne $false -or $receipt.deadMarkerVerified -ne $true){throw ('Positive case failed: '+$name)}}
    $rows.Add(@{name=$name;expected=$expected;actual=$actual;passed=$true})
}
Case 'marker-only' '' {}
Case 'sealed-helpers' '' {param($root)[IO.File]::WriteAllBytes((Join-Path $root 'Update.exe'),$vendor);$app=Join-Path $root 'app-0.1.1';New-Item -ItemType Directory -Path $app|Out-Null;[IO.File]::WriteAllBytes((Join-Path $app 'squirrel.exe'),$vendor)}
Case 'missing-marker' 'UNINSTALL_ROOT_OR_MARKER_MISSING' {param($root)Remove-Item -LiteralPath (Join-Path $root '.dead')}
Case 'bad-marker' 'UNINSTALL_MARKER_INVALID' {param($root)[IO.File]::WriteAllBytes((Join-Path $root '.dead'),[byte[]]@(33))}
Case 'oversize-marker' 'UNINSTALL_MARKER_INVALID' {param($root)[IO.File]::WriteAllBytes((Join-Path $root '.dead'),[byte[]]@(32,32))}
Case 'altered-vendor' 'UNINSTALL_VENDOR_HELPER_CHANGED' {param($root)$altered=[byte[]]$vendor.Clone();$altered[0]=88;[IO.File]::WriteAllBytes((Join-Path $root 'Update.exe'),$altered)}
Case 'unexpected-file' 'UNINSTALL_UNEXPECTED_FILE' {param($root)[IO.File]::WriteAllText((Join-Path $root 'extra.log'),'unexpected')}
Case 'application-left' 'UNINSTALL_UNEXPECTED_FILE' {param($root)[IO.File]::WriteAllBytes((Join-Path $root 'ETS2TelemetryDesktop.exe'),$vendor)}
Case 'foreign-version' 'UNINSTALL_UNEXPECTED_DIRECTORY' {param($root)$app=Join-Path $root 'app-0.1.0';New-Item -ItemType Directory -Path $app|Out-Null;[IO.File]::WriteAllBytes((Join-Path $app 'squirrel.exe'),$vendor)}
Case 'registration-left' 'UNINSTALL_REGISTRATION_REMAINS' {} @(@{version='0.1.1'})
Case 'shortcut-left' 'UNINSTALL_PRODUCT_SHORTCUT_REMAINS' {} @() @(@{path='fixed-product-shortcut'})
# A junction is an inert filesystem fixture, not an application process.
$reparseRoot=Join-Path $FixtureDirectory 'reparse-case';New-Item -ItemType Directory -Path $reparseRoot|Out-Null
$reparseTarget=Join-Path $FixtureDirectory 'reparse-target';New-Item -ItemType Directory -Path $reparseTarget|Out-Null
[IO.File]::WriteAllBytes((Join-Path $reparseRoot '.dead'),[byte[]]@(32))
$junction=Join-Path $reparseRoot 'app-0.1.1';New-Item -ItemType Junction -Path $junction -Target $reparseTarget|Out-Null
$actual=$null;try{Assert-UninstallResidue -BinaryRoot $reparseRoot -Version '0.1.1' -Squirrel $seal|Out-Null}catch{$actual=$_.Exception.Message}
if($actual -cne 'UNINSTALL_REPARSE_POINT'){throw 'Reparse fixture failed.'}
$rows.Add(@{name='reparse';expected='UNINSTALL_REPARSE_POINT';actual=$actual;passed=$true})
Remove-Item -LiteralPath $junction
$rows.ToArray()|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $FixtureDirectory 'pure-result.json') -Encoding UTF8
Write-Output ('UNINSTALL_RESIDUE_PURE_PASS '+$rows.Count)
