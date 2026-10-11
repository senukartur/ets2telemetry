[CmdletBinding()]
[Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingBrokenHashAlgorithms', '', Justification = 'Squirrel RELEASES entries identify packages by SHA1; SHA256 is checked as well where a pin exists.')]
param(
    [switch]$Run,[ValidateSet('none','normal','linger')][string]$Control='none',
    [string]$Manifest,[string]$ManifestSha256,[string]$Setup,[string]$SetupSha256,
    [string]$Feed,[string]$FixtureNugetSha256,[string]$FeedReleasesSha256,
    [string]$Node,[string]$NodeSha256,[string]$PlaywrightEntry,
    [string]$ObserverAssembly,[string]$ObserverAssemblySha256,
    [string]$ObserverBuildReceipt,[string]$ObserverBuildReceiptSha256,[string]$ObserverSourceSha256,
    [string]$OutDirectory
)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Assert-UninstallResidue.ps1')
if(!$Run){@{run=$false;steps=@('install','repair','smoke-0.1.0','update','smoke-0.1.1','uninstall');globalSeconds=300;stepSeconds=@(45,45,30,45,30,30);preconditions='No product install, registration, product shortcut or data directory; preserve all existing user files.';control=$Control;applicationLaunched=$false}|ConvertTo-Json;return}
$clock=[Diagnostics.Stopwatch]::StartNew();$report=[ordered]@{passed=$false;failure=$null;startedUtc=[datetime]::UtcNow.ToString('o');control=$Control;steps=@();globalSeconds=300;synthetic=$true;automaticHookExitCodesClaimed=$false;originalFilesPreserved=$false;originalShortcutsPreserved=$false;ownedDataRemoved=$false}
$saved=@{};$steps=[Collections.Generic.List[object]]::new();$ownedDatabase=$false;$prepared=$false
$ownedFiles=[Collections.Generic.List[object]]::new();$ownedDirectories=[Collections.Generic.List[string]]::new();$sentinelId=[guid]::NewGuid().ToString('N')
$binaryRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ETS2TelemetryDesktop'
$userRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ETS2Telemetry'
$dataDirectory=Join-Path $userRoot 'data';$database=Join-Path $dataDirectory 'telemetry.sqlite'
$report.binaryRoot=$binaryRoot;$report.syntheticDatabase=$database
function Budget {if($clock.Elapsed.TotalSeconds -ge 300){throw 'Native total300s deadline exhausted.'}}
function Seal([string]$path,[string]$digest){
    if(!$path -or ![IO.Path]::IsPathRooted($path) -or $digest -notmatch '^[0-9a-fA-F]{64}$'){throw 'Absolute path and reviewed SHA256 required.'}
    $item=Get-Item -LiteralPath $path;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or (Get-FileHash -LiteralPath $item.FullName).Hash -ne $digest){throw ('Input preimage mismatch: '+$path)}
    $item.FullName
}
function Json([string]$path,[int]$maximum){$item=Get-Item -LiteralPath $path;if($item.Length -gt $maximum){throw 'JSON size bound exceeded.'};Get-Content -LiteralPath $path -Raw|ConvertFrom-Json}
function Inventory([string]$root){
    $rows=@();if(Test-Path -LiteralPath $root){foreach($item in Get-ChildItem -LiteralPath $root -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'User preimage reparse point prohibited.'};if(!$item.PSIsContainer){$rows+=,@{path=$item.FullName;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName).Hash}}}};@($rows|Sort-Object {$_.path})
}
function Assert-Inventory($before){foreach($row in $before){$item=Get-Item -LiteralPath $row.path;if($item.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $row.path).Hash -ne $row.sha256){throw ('User preimage changed: '+$row.path)}}}
function Registration {
    $rows=@();foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view);try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\ETS2TelemetryDesktop');if($key){try{$rows+=,@{version=$key.GetValue('DisplayVersion');root=$key.GetValue('InstallLocation');uninstall=$key.GetValue('UninstallString')}}finally{$key.Dispose()}}}finally{$base.Dispose()}};@($rows)
}
function Shortcuts {
    $rows=@();$shell=New-Object -ComObject WScript.Shell
    try{foreach($location in $shortcutLocations){if(Test-Path -LiteralPath $location.path){foreach($item in Get-ChildItem -LiteralPath $location.path -Filter '*.lnk' -Recurse -File){$link=$shell.CreateShortcut($item.FullName);try{$rows+=,@{path=$item.FullName;kind=$location.kind;target=$link.TargetPath;arguments=$link.Arguments;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $item.FullName).Hash}}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)|Out-Null}}}}}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)|Out-Null};@($rows)
}
function Product-Links { @(Shortcuts|Where-Object {$_.target -and [IO.Path]::GetFullPath($_.target).StartsWith($binaryRoot+'\',[StringComparison]::OrdinalIgnoreCase)}) }
function Assert-Preserved {
    Assert-Inventory $preimage;Assert-Inventory $shortcutPreimage
    # Only the explicitly owned synthetic database may be new under the existing data root.
    $known=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase);foreach($row in $preimage){$null=$known.Add($row.path)}
    foreach($row in $ownedFiles){$null=$known.Add($row.path);if((Get-FileHash -LiteralPath $row.path).Hash -ne $row.sha256 -or (Get-Item -LiteralPath $row.path).Length -ne $row.bytes){throw ('Owned sentinel changed: '+$row.path)}}
    if($ownedDatabase){$null=$known.Add($database)}
    foreach($row in Inventory $userRoot){if(!$known.Contains($row.path)){throw ('Unexpected user file created: '+$row.path)}}
    $report.originalFilesPreserved=$true;$report.originalShortcutsPreserved=$true
}
function Assert-Installed([string]$version){
    Budget;$appDirectory=Join-Path $binaryRoot ('app-'+$version);$expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($row in $projection.runtimeFiles){if($row.path -ne 'ETS2TelemetryDesktop_ExecutionStub.exe'){$null=$expected.Add($row.path)}}
    foreach($item in Get-ChildItem -LiteralPath $appDirectory -Recurse -Force){if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed reparse point prohibited.'};if(!$item.PSIsContainer){$relative=$item.FullName.Substring($appDirectory.Length+1).Replace('\','/');if(!$expected.Contains($relative) -and ($relative -notmatch '^Squirrel-UpdateSelf(?:\.[1-9])?\.log$' -or $item.Length -gt 4194304)){throw ('Unexpected installed file: '+$relative)}}}
    foreach($row in $projection.runtimeFiles){Budget;$filename=if($row.path -eq 'ETS2TelemetryDesktop_ExecutionStub.exe'){Join-Path $binaryRoot 'ETS2TelemetryDesktop.exe'}else{Join-Path $appDirectory $row.path};$item=Get-Item -LiteralPath $filename;if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $filename).Hash -ne $row.sha256){throw ('Installed runtime hash differs: '+$row.path)}}
    $squirrel=@($projection.runtimeFiles|Where-Object {$_.path -eq 'Squirrel.exe'});if($squirrel.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $binaryRoot 'Update.exe')).Hash -ne $squirrel[0].sha256){throw 'Root updater preimage differs.'}
    $registrations=@(Registration);if(!$registrations.Count){throw 'Uninstall registration absent.'};foreach($row in $registrations){if($row.version -ne $version -or $row.root -ne $binaryRoot -or $row.uninstall -notlike ('*'+$binaryRoot+'\Update.exe*--uninstall*')){throw 'Unexpected uninstall registration.'}}
    $links=@(Product-Links);foreach($kind in @('desktop','start-menu')){if(!@($links|Where-Object {$_.kind -eq $kind}).Count){throw ('Product shortcut missing: '+$kind)}};foreach($link in $links){if(!(Test-Path -LiteralPath $link.target -PathType Leaf)){throw 'Shortcut target absent.'}}
    $lines=@((Get-Content -LiteralPath (Join-Path $binaryRoot 'packages/RELEASES') -Raw).Trim() -split '\r?\n'|Where-Object {$_});$pattern='^([a-fA-F0-9]{40}) (ETS2TelemetryDesktop-'+[regex]::Escape($version)+'-full\.nupkg) ([0-9]+)$'
    if($lines.Count -ne 1 -or $lines[0] -notmatch $pattern){throw 'Selected RELEASES version differs.'};$sha1=$Matches[1];$name=$Matches[2];$bytes=[long]$Matches[3];$nuget=Get-Item -LiteralPath (Join-Path (Join-Path $binaryRoot 'packages') $name);$sha256=if($version -eq '0.1.0'){$projection.originalNugetSha256}else{$projection.fixtureNugetSha256}
    if($nuget.Length -ne $bytes -or (Get-FileHash -LiteralPath $nuget.FullName -Algorithm SHA1).Hash -ne $sha1 -or (Get-FileHash -LiteralPath $nuget.FullName).Hash -ne $sha256){throw 'Selected NuGet bytes differ.'}
    Assert-Preserved;@{version=$version;runtimeFilesVerified=@($projection.runtimeFiles).Count;registration=$registrations;shortcuts=$links;selectedNuget=$name;syntheticFixture=$version -eq '0.1.1';applicationVersion='0.1.0'}
}
function Save-Logs([string]$destination){
    $rows=@();$total=0;foreach($root in @($binaryRoot,(Join-Path $OutDirectory 'scratch'),(Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'SquirrelTemp'))){if(!(Test-Path -LiteralPath $root)){continue};foreach($item in Get-ChildItem -LiteralPath $root -Recurse -Filter 'Squirrel*.log' -File){
        $total+=$item.Length;if($rows.Count -ge 32 -or $item.Length -gt 4194304 -or $total -gt 16777216 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Squirrel log retention bounds exceeded.'}
        $target=Join-Path $destination ('squirrel-'+$rows.Count+'.log');Copy-Item -LiteralPath $item.FullName -Destination $target;$rows+=,@{source=$item.FullName;retained=$target;bytes=$item.Length;sha256=(Get-FileHash -LiteralPath $target).Hash;automaticHookExitCodeProven=$false}
    }};$rows
}
try{
    if(!$OutDirectory -or ![IO.Path]::IsPathRooted($OutDirectory) -or (Test-Path -LiteralPath $OutDirectory)){throw 'Fresh absolute evidence directory required.'}
    $Manifest=Seal $Manifest $ManifestSha256;$Node=Seal $Node $NodeSha256;$ObserverAssembly=Seal $ObserverAssembly $ObserverAssemblySha256;$ObserverBuildReceipt=Seal $ObserverBuildReceipt $ObserverBuildReceiptSha256
    $projection=Json $Manifest 1048576;$build=Json $ObserverBuildReceipt 16384
    if($build.sourceSha256 -ne $ObserverSourceSha256 -or $build.assemblySha256 -ne $ObserverAssemblySha256 -or $build.assemblyBytes -ne (Get-Item -LiteralPath $ObserverAssembly).Length -or $build.exitCode -ne 0 -or $build.compilerSha256 -ne '46809206887326d2d24db1eff1f3064de972c3451abe766b49111450a5e08e00' -or $build.compilerSignature -ne 'Valid Microsoft Corporation'){throw 'Reviewed observer build mapping differs.'}
    if(!@($projection.runtimeFiles).Count -or $projection.applicationVersion -ne '0.1.0' -or $projection.fixtureVersion -ne '0.1.1' -or $projection.fixtureOnly -ne $true){throw 'Invalid frozen runtime projection.'}
    if(![IO.Path]::IsPathRooted($PlaywrightEntry) -or !(Test-Path -LiteralPath $PlaywrightEntry -PathType Leaf)){throw 'Pinned Playwright entry required.'}
    $playwrightPackage=Json (Join-Path (Split-Path -Parent $PlaywrightEntry) 'package.json') 16384;if($playwrightPackage.version -ne '1.64.0'){throw 'Pinned Playwright version differs.'}
    $watchdog=Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'scripts/watchdog/BoundedProcess.cs';$null=Seal $watchdog 'B66CBA7247D71D97C669B072923723EF2BB139FFA88684895A1B1E739341A8B8';Add-Type -TypeDefinition (Get-Content -LiteralPath $watchdog -Raw)
    $shortcutLocations=@(@{kind='desktop';path=[Environment]::GetFolderPath('DesktopDirectory')},@{kind='start-menu';path=[Environment]::GetFolderPath('Programs')});$preimage=@(Inventory $userRoot);$shortcutPreimage=@(Shortcuts)
    if($Control -eq 'none'){
        $Setup=Seal $Setup $SetupSha256;if($SetupSha256 -ne $projection.setupSha256 -or $FixtureNugetSha256 -ne $projection.fixtureNugetSha256){throw 'Maker/feed projection preimage differs.'}
        $null=Seal (Join-Path $Feed 'ETS2TelemetryDesktop-0.1.1-full.nupkg') $FixtureNugetSha256;$null=Seal (Join-Path $Feed 'RELEASES') $FeedReleasesSha256
        if((Test-Path -LiteralPath $binaryRoot) -or @(Registration).Count -or (Test-Path -LiteralPath $dataDirectory) -or @(Product-Links).Count -or @($shortcutPreimage|Where-Object {[IO.Path]::GetFileName($_.path) -eq 'ETS2Telemetry Desktop.lnk'}).Count){throw 'Existing product install, data or product shortcut; no runtime mutation permitted.'}
    }
    New-Item -ItemType Directory -Path $OutDirectory|Out-Null;$prepared=$true
    $preimage|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $OutDirectory 'user-preimage.json') -Encoding UTF8;$shortcutPreimage|ConvertTo-Json -Depth 6|Set-Content -LiteralPath (Join-Path $OutDirectory 'shortcut-preimage.json') -Encoding UTF8
    foreach($name in @('TEMP','TMP','APPDATA','SQUIRREL_TEMP','ETS2TELEMETRY_PROFILE_DIR','ETS2TELEMETRY_DIAGNOSTIC_DIR')){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')};Remove-Item Env:SQUIRREL_TEMP -ErrorAction SilentlyContinue
    if($Control -eq 'none'){
        New-Item -ItemType Directory -Path $dataDirectory|Out-Null;$ownedDatabase=$true;$ownedDirectories.Add($dataDirectory)
        foreach($kind in @('settings','logs','backups','plugins')){
            $folder=Join-Path $userRoot $kind;if(!(Test-Path -LiteralPath $folder)){New-Item -ItemType Directory -Path $folder|Out-Null;$ownedDirectories.Add($folder)}
            $filename=Join-Path $folder ('et001-preservation-'+$sentinelId+'.json');if(Test-Path -LiteralPath $filename){throw 'Owned sentinel collision.'}
            [IO.File]::WriteAllText($filename,('{"synthetic":true,"scope":"et001-'+$kind+'","value":42}'),[Text.UTF8Encoding]::new($false))
            $ownedFiles.Add(@{path=$filename;bytes=(Get-Item -LiteralPath $filename).Length;sha256=(Get-FileHash -LiteralPath $filename).Hash;synthetic=$true;kind=$kind})
        };$report['preservationSentinels']=$ownedFiles.ToArray()
    }
    $definitions=if($Control -eq 'none'){@(@{name='install';version='0.1.0';seconds=45},@{name='repair';version='0.1.0';seconds=45},@{name='smoke';version='0.1.0';seconds=30},@{name='update';version='0.1.1';seconds=45},@{name='smoke';version='0.1.1';seconds=30},@{name='uninstall';version='0.1.1';seconds=30})}else{@(@{name=if($Control -eq 'normal'){'control'}else{'linger'};version='0.1.0';seconds=5})}
    $index=0
    foreach($definition in $definitions){
        Budget;$index++;$milliseconds=[int][math]::Min($definition.seconds*1000,[math]::Floor((300-$clock.Elapsed.TotalSeconds)*1000)-5000);if($milliseconds -lt $definition.seconds*1000){throw 'Insufficient original total budget for next bounded step.'}
        $directory=Join-Path $OutDirectory ('step-'+$index+'-'+$definition.name+'-'+$definition.version);$scratch=Join-Path $OutDirectory ('scratch/step-'+$index)
        foreach($path in @($directory,(Join-Path $directory 'diagnostics'),(Join-Path $scratch 'cwd'),(Join-Path $scratch 'temp'),(Join-Path $scratch 'profile'),(Join-Path $scratch 'roaming'))){New-Item -ItemType Directory -Path $path|Out-Null}
        $env:TEMP=Join-Path $scratch 'temp';$env:TMP=$env:TEMP;$env:APPDATA=Join-Path $scratch 'roaming';$env:ETS2TELEMETRY_PROFILE_DIR=Join-Path $scratch 'profile';$env:ETS2TELEMETRY_DIAGNOSTIC_DIR=Join-Path $directory 'diagnostics'
        $config=@{step=$definition.name;version=$definition.version;budgetMilliseconds=$milliseconds;directory=$directory;cwd=(Join-Path $scratch 'cwd');node=$Node;driver=(Join-Path $PSScriptRoot 'native-smoke.mjs');playwrightEntry=$PlaywrightEntry;setup=$Setup;feed=$Feed;updater=(Join-Path $binaryRoot 'Update.exe');executable=(Join-Path $binaryRoot ('app-'+$definition.version+'/ETS2TelemetryDesktop.exe'));database=$database;preimage=(Join-Path $OutDirectory 'sqlite-preimage.json');diagnostics=$env:ETS2TELEMETRY_DIAGNOSTIC_DIR;observerAssembly=$ObserverAssembly;observerAssemblySha256=$ObserverAssemblySha256}
        $configFile=Join-Path $directory 'config.json';$config|ConvertTo-Json|Set-Content -LiteralPath $configFile -Encoding UTF8
        $jobDirectory=Join-Path $directory 'job';$ps=Join-Path ([Environment]::SystemDirectory) 'WindowsPowerShell/v1.0/powershell.exe'
        $code=[ETS2Telemetry.Diagnostics.BoundedProcess]::Run($ps,@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'native-installer-step.ps1'),'-ConfigFile',$configFile),$directory,$jobDirectory,$milliseconds)
        $step=[ordered]@{name=$definition.name;version=$definition.version;jobExitCode=$code;budgetMilliseconds=$milliseconds;rootProof=$null;postconditions=$null};$steps.Add($step);$report.steps=$steps.ToArray()
        $resultPath=Join-Path $directory 'step-result.json';if(Test-Path -LiteralPath $resultPath){$step.rootProof=Json $resultPath 65536}
        $step['squirrelLogs']=@(Save-Logs $directory)
        if($Control -eq 'linger'){
            if($code -notin @(124,125) -or !$step.rootProof -or $step.rootProof.passed -or $step.rootProof.childrenNaturallyDrained -or @($step.rootProof.primary).Count -ne 1 -or !$step.rootProof.primary[0].stdout -or !(Select-String -LiteralPath $step.rootProof.primary[0].stdout -SimpleMatch 'ET001_NATIVE_LINGER_REACHED' -Quiet)){throw 'Lingering child did not produce bounded rejection with actual marker.'}
            $step.postconditions=@{expectedBoundedRejection=$true;actualChildMarker=$true};continue
        }
        if($code -ne 0 -or !$step.rootProof -or $step.rootProof.passed -ne $true -or $step.rootProof.childrenNaturallyDrained -ne $true -or @($step.rootProof.primary|Where-Object {$_.exitCode -ne 0 -or $_.streamsDrained -ne $true}).Count){throw 'Native bounded primary/root/drain proof failed.'}
        if($Control -eq 'none'){
            $databasePreimage=Json (Join-Path $OutDirectory 'sqlite-preimage.json') 8192;if($databasePreimage.path -ne $database -or $databasePreimage.synthetic -ne $true -or (Get-FileHash -LiteralPath $database).Hash -ne $databasePreimage.sha256){throw 'Synthetic database preservation proof failed.'}
            if($definition.name -eq 'uninstall'){
                $squirrel=@($projection.runtimeFiles|Where-Object {$_.path -ieq 'squirrel.exe'});if($squirrel.Count -ne 1){throw 'Ambiguous sealed vendor helper.'}
                $step.postconditions=Assert-UninstallResidue -BinaryRoot $binaryRoot -Version $definition.version -Squirrel $squirrel[0] -Registration @(Registration) -ProductShortcuts @(Product-Links)
                Assert-Preserved;$step.postconditions['syntheticDataPreserved']=$true;$report['vendorCleanupPending']=$true
            }else{$step.postconditions=Assert-Installed $definition.version}
        }
    }
    Assert-Preserved
    if($ownedDatabase){
        if(@(Get-ChildItem -LiteralPath $dataDirectory -Force).Count -ne 1 -or !(Test-Path -LiteralPath $database -PathType Leaf)){throw 'Synthetic cleanup ownership changed.'}
        Remove-Item -LiteralPath $database;$ownedDatabase=$false
        foreach($row in $ownedFiles){Remove-Item -LiteralPath $row.path};$ownedFiles.Clear()
        foreach($folder in $ownedDirectories){if(@(Get-ChildItem -LiteralPath $folder -Force).Count){throw 'Owned directory contains unexpected files; leave intact.'};Remove-Item -LiteralPath $folder};$report.ownedDataRemoved=$true
    }
    Assert-Preserved;$report.passed=$true
}catch{$report.failure=$_.Exception.ToString()}
finally{foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')};$report.elapsedSeconds=$clock.Elapsed.TotalSeconds;$report.finishedUtc=[datetime]::UtcNow.ToString('o');if($prepared){$report|ConvertTo-Json -Depth 18|Set-Content -LiteralPath (Join-Path $OutDirectory 'native-result.json') -Encoding UTF8};$report|ConvertTo-Json -Depth 18}
if(!$report.passed){exit 1}
