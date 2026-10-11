# Guest-only lifecycle. Root owns the outer VM watchdog, transport, export and snapshot restoration.
[CmdletBinding()]
param([switch]$Run,[string]$ExpectedManifestSha256,[string]$ExpectedPackageSha256,[string]$ExpectedAsarSha256,[string]$OuterDeadlineUtc)
$ErrorActionPreference='Stop'
$kit='C:\ETS2ET001Acceptance'
if(!$Run){[ordered]@{run=$false;applicationLaunched=$false;globalGuestSeconds=160;minimumOuterRemainingSeconds=185;steps=@('install','repair','smoke-0.1.0','update','smoke-0.1.1','uninstall');action='Guest only: verified installer kit, explicit reviewed hashes, pristine per-user roots and already armed outer VM deadline required.'}|ConvertTo-Json;return}
$identity=Get-CimInstance Win32_ComputerSystemProduct;$computer=Get-CimInstance Win32_ComputerSystem
if($identity.UUID -ne '94674D56-D803-F4D5-9AAC-C4E91CFB475F' -or $computer.Manufacturer -notmatch '^VMware' -or $computer.Model -notmatch 'VMware'){throw 'Wrong machine; guest-only installer acceptance.'}
if((Get-Content -LiteralPath 'C:\ETS2VMwareLab\guest-marker.txt' -Raw).Trim() -ne '9a047927-f94b-41cb-bda8-abcc7d0b76f1'){throw 'Wrong baseline marker.'}
if([IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent)).TrimEnd('\') -ne $kit){throw 'Wrong acceptance kit root.'}
$clock=[Diagnostics.Stopwatch]::StartNew()
$runId=[guid]::NewGuid().ToString('N')
$runDirectory=Join-Path $kit ('evidence/'+$runId)
$scratchDirectory=Join-Path $kit ('scratch/'+$runId)
$report=[ordered]@{schemaVersion=1;kind='et001-installer';startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;passed=$false;failure=$null;vmUuid=$identity.UUID;manifestSha256=$ExpectedManifestSha256;packageSha256=$ExpectedPackageSha256;asarSha256=$ExpectedAsarSha256;outerDeadlineUtc=$OuterDeadlineUtc;globalBudgetSeconds=160;elapsedSeconds=$null;runDirectory=$runDirectory;binaryRoot=$null;dataRoot=$null;sentinels=@();steps=@();fixtureOnly=$true;applicationVersion='0.1.0';fixtureVersion='0.1.1';limits=@{maxStepSeconds=45;maxProcesses=16;jobMemoryBytes=2147483648;systemCpuPercent=25;retainedBytesPerStream=1048576}}
$saved=@{};$steps=[Collections.Generic.List[object]]::new();$sentinels=[Collections.Generic.List[object]]::new()
$report['scratchDirectory']=$scratchDirectory
function Assert-Budget {if($clock.Elapsed.TotalSeconds -ge 160){throw 'Guest global 160-second budget exhausted.'};if(([datetime]$OuterDeadlineUtc).ToUniversalTime().Subtract([datetime]::UtcNow).TotalSeconds -lt 15){throw 'Insufficient outer deadline for export/shutdown.'}}
function Read-Registration {
    $items=[Collections.Generic.List[object]]::new()
    foreach($view in @([Microsoft.Win32.RegistryView]::Registry64,[Microsoft.Win32.RegistryView]::Registry32)){
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
        try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\ETS2TelemetryDesktop');if($key){try{$items.Add([ordered]@{view=$view.ToString();displayName=$key.GetValue('DisplayName');displayVersion=$key.GetValue('DisplayVersion');installLocation=$key.GetValue('InstallLocation');uninstallString=$key.GetValue('UninstallString');quietUninstallString=$key.GetValue('QuietUninstallString')})}finally{$key.Dispose()}}}finally{$base.Dispose()}
    }
    return $items.ToArray()
}
function Read-Shortcuts {
    $shell=New-Object -ComObject WScript.Shell;$items=[Collections.Generic.List[object]]::new()
    try{
        foreach($location in @(@{kind='desktop';path=[Environment]::GetFolderPath('DesktopDirectory')},@{kind='start-menu';path=[Environment]::GetFolderPath('Programs')})){
            if(!(Test-Path -LiteralPath $location.path)){continue}
            foreach($file in Get-ChildItem -LiteralPath $location.path -Recurse -Filter '*.lnk' -File -ErrorAction Stop){
                $link=$shell.CreateShortcut($file.FullName)
                try{if($link.TargetPath -and [IO.Path]::GetFullPath($link.TargetPath).StartsWith($report.binaryRoot+'\',[StringComparison]::OrdinalIgnoreCase)){$items.Add([ordered]@{kind=$location.kind;path=$file.FullName;target=$link.TargetPath;arguments=$link.Arguments;workingDirectory=$link.WorkingDirectory})}}finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)|Out-Null}
            }
        }
    }finally{[Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)|Out-Null}
    return $items.ToArray()
}
function Assert-Sentinels {
    foreach($sentinel in $sentinels){$file=Get-Item -LiteralPath $sentinel.path;if($file.Attributes -band [IO.FileAttributes]::ReparsePoint -or $file.Length -ne $sentinel.bytes -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne $sentinel.sha256){throw ('Preserved data sentinel changed: '+$sentinel.path)}}
}
function Assert-Installed([string]$version){
    $appDirectory=Join-Path $report.binaryRoot ('app-'+$version)
    foreach($root in @($report.binaryRoot,$appDirectory)){if((Get-Item -LiteralPath $root).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed runtime root reparse point prohibited.'}}
    $expectedAppFiles=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($row in $manifest.runtimeFiles){if($row.path -ne 'ETS2TelemetryDesktop_ExecutionStub.exe'){$null=$expectedAppFiles.Add($row.path)}}
    foreach($item in Get-ChildItem -LiteralPath $appDirectory -Recurse -Force){
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Installed runtime reparse point prohibited.'}
        if(!$item.PSIsContainer){
            $relative=$item.FullName.Substring($appDirectory.Length+1).Replace('\','/')
            # The pinned updater writes these diagnostics beside app-X/Squirrel.exe.
            $generatedLog=$relative -match '^Squirrel-UpdateSelf(?:\.[1-9])?\.log$'
            if(!$expectedAppFiles.Contains($relative) -and (!$generatedLog -or $item.Length -gt 4194304)){throw ('Unexpected installed runtime file: '+$relative)}
        }
    }
    foreach($row in $manifest.runtimeFiles){
        # Squirrel extracts execution stubs into the binary root, with the real app's basename.
        $filename=if($row.path -eq 'ETS2TelemetryDesktop_ExecutionStub.exe'){Join-Path $report.binaryRoot 'ETS2TelemetryDesktop.exe'}else{Join-Path $appDirectory $row.path}
        $file=Get-Item -LiteralPath $filename
        if($file.PSIsContainer -or $file.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne $row.sha256){throw ('Installed runtime preimage mismatch: '+$row.path)}
    }
    $registration=@(Read-Registration)
    if(!$registration.Count){throw 'Uninstall registration is missing.'}
    foreach($entry in $registration){if($entry.displayVersion -ne $version -or $entry.installLocation -ne $report.binaryRoot -or $entry.uninstallString -notlike ('*'+$report.binaryRoot+'\Update.exe*--uninstall*')){throw 'Unexpected uninstall registration.'}}
    $shortcuts=@(Read-Shortcuts)
    if(!@($shortcuts|Where-Object {$_.kind -eq 'desktop'}).Count -or !@($shortcuts|Where-Object {$_.kind -eq 'start-menu'}).Count){throw 'Desktop and Start Menu shortcuts are required.'}
    foreach($shortcut in $shortcuts){if(!(Test-Path -LiteralPath $shortcut.target -PathType Leaf)){throw 'Shortcut target missing.'}}
    if(!(Test-Path -LiteralPath (Join-Path $report.binaryRoot 'Update.exe') -PathType Leaf)){throw 'Installed updater missing.'}
    $squirrel=@($manifest.runtimeFiles|Where-Object {$_.path -eq 'Squirrel.exe'})
    if($squirrel.Count -ne 1 -or (Get-FileHash -LiteralPath (Join-Path $report.binaryRoot 'Update.exe')).Hash -ne $squirrel[0].sha256){throw 'Installed root updater differs from reviewed Squirrel runtime.'}
    $releaseLines=@((Get-Content -LiteralPath (Join-Path $report.binaryRoot 'packages/RELEASES') -Raw).Trim() -split '\r?\n'|Where-Object {$_})
    $pattern='^([a-fA-F0-9]{40}) (ETS2TelemetryDesktop-'+[regex]::Escape($version)+'-full\.nupkg) ([0-9]+)$'
    if($releaseLines.Count -ne 1 -or $releaseLines[0] -notmatch $pattern){throw 'Installed RELEASES must select only the exact accepted version.'}
    $releaseSha1=$Matches[1];$releaseName=$Matches[2];$releaseBytes=[long]$Matches[3]
    $releaseFile=Get-Item -LiteralPath (Join-Path (Join-Path $report.binaryRoot 'packages') $releaseName)
    $releaseSha256=if($version -eq '0.1.0'){$manifest.originalNugetSha256}else{$manifest.fixtureNugetSha256}
    if($releaseFile.Length -ne $releaseBytes -or (Get-FileHash -LiteralPath $releaseFile.FullName -Algorithm SHA1).Hash -ne $releaseSha1 -or (Get-FileHash -LiteralPath $releaseFile.FullName).Hash -ne $releaseSha256){throw 'Installed selected NuGet preimage mismatch.'}
    Assert-Sentinels
    return [ordered]@{version=$version;runtimeFilesVerified=@($manifest.runtimeFiles).Count;exactAppRuntimeSetVerified=$true;rootUpdaterHashVerified=$true;selectedRelease=$releaseName;selectedReleaseSha256=$releaseSha256;registration=$registration;shortcuts=$shortcuts;dataSentinelsPreserved=$true}
}
function Save-SquirrelLogs([string]$destination){
    $counter=0;$bytes=0;$map=[Collections.Generic.List[object]]::new();$seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($root in @($report.binaryRoot,$env:TEMP,(Join-Path $env:LOCALAPPDATA 'SquirrelTemp'))){
        if(!(Test-Path -LiteralPath $root)){continue}
        foreach($file in Get-ChildItem -LiteralPath $root -Recurse -Filter 'Squirrel*.log' -File -ErrorAction Stop){
            if(!$seen.Add($file.FullName)){continue}
            $counter++;$bytes+=$file.Length
            if($counter -gt 32 -or $file.Length -gt 4194304 -or $bytes -gt 16777216 -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Squirrel log evidence bounds exceeded.'}
            $target=Join-Path $destination ('squirrel-'+$counter+'.log');Copy-Item -LiteralPath $file.FullName -Destination $target
            $map.Add([ordered]@{source=$file.FullName;exported=$target;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $target).Hash.ToLowerInvariant()})
        }
    }
    $map.ToArray()|ConvertTo-Json -Depth 4|Set-Content -LiteralPath (Join-Path $destination 'squirrel-log-map.json') -Encoding UTF8
}
try{
    foreach($hash in @($ExpectedManifestSha256,$ExpectedPackageSha256,$ExpectedAsarSha256)){if($hash -notmatch '^[a-fA-F0-9]{64}$'){throw 'Explicit reviewed hashes required.'}}
    if(!$OuterDeadlineUtc -or ([datetime]$OuterDeadlineUtc).ToUniversalTime().Subtract([datetime]::UtcNow).TotalSeconds -lt 185){throw 'At least 185 seconds must remain on the independently armed outer watchdog.'}
    $manifestPath=Join-Path $kit 'kit-manifest.json'
    if((Get-FileHash -LiteralPath $manifestPath).Hash -ne $ExpectedManifestSha256){throw 'Installer manifest hash mismatch.'}
    $manifest=Get-Content -LiteralPath $manifestPath -Raw|ConvertFrom-Json
    if($manifest.schemaVersion -ne 1 -or $manifest.kind -ne 'et001-installer' -or $manifest.guestRoot -ne $kit -or $manifest.guestUuid -ne $identity.UUID -or $manifest.labId -ne '9a047927-f94b-41cb-bda8-abcc7d0b76f1' -or $manifest.nodeVersion -ne '24.19.0' -or $manifest.playwrightCoreVersion -ne '1.64.0' -or $manifest.packageSha256 -ne $ExpectedPackageSha256 -or $manifest.asarSha256 -ne $ExpectedAsarSha256 -or $manifest.fixtureOnly -ne $true -or $manifest.applicationVersion -ne '0.1.0' -or $manifest.fixtureVersion -ne '0.1.1'){throw 'Unexpected installer kit identity.'}
    $expected=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($row in $manifest.files){if(!$row.path -or $row.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or !$expected.Add($row.path)){throw 'Invalid manifest path.'};$file=Get-Item -LiteralPath (Join-Path $kit $row.path);if($file.PSIsContainer -or $file.Length -ne $row.bytes -or (Get-FileHash -LiteralPath $file.FullName).Hash -ne $row.sha256){throw ('Kit preimage mismatch: '+$row.path)}}
    foreach($file in Get-ChildItem -LiteralPath $kit -Recurse -Force){if($file.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Kit reparse points prohibited.'};if(!$file.PSIsContainer){$relative=$file.FullName.Substring($kit.Length+1).Replace('\','/');if($relative -ne 'kit-manifest.json' -and !$expected.Contains($relative)){throw ('Unexpected initial kit file: '+$relative)}}}
    $runtimeNames=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach($row in $manifest.runtimeFiles){if(!$row.path -or $row.path -match '(^/|\\|:|(^|/)\.\.?(/|$))' -or !$runtimeNames.Add($row.path) -or $row.sha256 -notmatch '^[a-fA-F0-9]{64}$'){throw 'Invalid runtime projection manifest.'}}
    if(!$runtimeNames.Contains('ETS2TelemetryDesktop.exe') -or !$runtimeNames.Contains('resources/app.asar') -or @($manifest.runtimeFiles|Where-Object {$_.path -eq 'resources/app.asar' -and $_.sha256 -eq $ExpectedAsarSha256}).Count -ne 1){throw 'Frozen critical runtime projection missing.'}
    if((Get-FileHash -LiteralPath (Join-Path $kit 'installer/Setup.exe')).Hash -ne $manifest.setupSha256 -or (Get-FileHash -LiteralPath (Join-Path $kit 'feed/ETS2TelemetryDesktop-0.1.1-full.nupkg')).Hash -ne $manifest.fixtureNugetSha256){throw 'Reviewed maker/feed identity mismatch.'}
    if($manifest.controllerSourceSha256 -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $kit 'tools/InstallerBoundedProcess.cs')).Hash -ne $manifest.controllerSourceSha256){throw 'Reviewed two-root controller source identity mismatch.'}
    foreach($pair in @(@{file='tools/InstallerJobView.cs';hash=$manifest.observerSourceSha256},@{file='tools/InstallerJobView.dll';hash=$manifest.observerAssemblySha256},@{file='tools/observer-build-receipt.json';hash=$manifest.observerBuildReceiptSha256})){
        if($pair.hash -notmatch '^[a-fA-F0-9]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $kit $pair.file)).Hash -ne $pair.hash){throw 'Sealed observer source/library/receipt identity mismatch.'}
    }
    $observerBuild=Get-Content -LiteralPath (Join-Path $kit 'tools/observer-build-receipt.json') -Raw|ConvertFrom-Json
    if($observerBuild.kind -ne 'et001-installer-observer-build' -or $observerBuild.sourceSha256 -ne $manifest.observerSourceSha256 -or $observerBuild.assemblySha256 -ne $manifest.observerAssemblySha256 -or $observerBuild.exitCode -ne 0 -or $observerBuild.assemblyLoaded -ne $false -or $observerBuild.nativeObserverInvoked -ne $false){throw 'Observer inert-build receipt differs from sealed manifest.'}
    $local=[Environment]::GetFolderPath('LocalApplicationData')
    if($local -ne $env:LOCALAPPDATA -or $local -notmatch '^C:\\Users\\ets2lab\\AppData\\Local$'){throw 'Actual disposable per-user LocalApplicationData required.'}
    $report.binaryRoot=Join-Path $local 'ETS2TelemetryDesktop';$report.dataRoot=Join-Path $local 'ETS2Telemetry'
    if((Test-Path -LiteralPath $report.binaryRoot) -or (Test-Path -LiteralPath $report.dataRoot) -or @(Read-Registration).Count -or @(Read-Shortcuts).Count){throw 'Pristine guest precondition failed; no installation permitted.'}
    if(Get-Process -Name ETS2TelemetryDesktop -ErrorAction SilentlyContinue){throw 'Existing app instance; no installation permitted.'}
    New-Item -ItemType Directory -Path $runDirectory,$scratchDirectory|Out-Null
    foreach($relative in @('data/history-preservation.et001.json','settings/synthetic-settings.json','logs/synthetic-archive.et001.jsonl','backups/synthetic-backup.et001.bin','plugins/synthetic-metadata.et001.json')){
        $filename=Join-Path $report.dataRoot $relative;New-Item -ItemType Directory -Path (Split-Path $filename -Parent) -Force|Out-Null
        [ordered]@{synthetic=$true;purpose='ET-001 installer preservation sentinel, not real history or a schema fixture';id=[guid]::NewGuid().ToString('N')}|ConvertTo-Json|Set-Content -LiteralPath $filename -Encoding UTF8
        $file=Get-Item -LiteralPath $filename;$sentinels.Add([ordered]@{path=$filename;bytes=$file.Length;sha256=(Get-FileHash -LiteralPath $filename).Hash.ToLowerInvariant()})
    }
    $report.sentinels=$sentinels.ToArray()
    foreach($name in @('TEMP','TMP','SQUIRREL_TEMP','ETS2TELEMETRY_PROFILE_DIR','ETS2TELEMETRY_DIAGNOSTIC_DIR','ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH','ETS2TELEMETRY_VM_JOB','NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE')){$saved[$name]=[Environment]::GetEnvironmentVariable($name,'Process')}
    $env:ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH='1';$env:ETS2TELEMETRY_VM_JOB='1'
    # Pinned Setup treats SQUIRREL_TEMP as the installation base, not merely scratch.
    # Clear it so the actual per-user install uses LOCALAPPDATA; preserve its preimage above.
    foreach($name in @('NODE_OPTIONS','NODE_PATH','ELECTRON_RUN_AS_NODE','SQUIRREL_TEMP')){[Environment]::SetEnvironmentVariable($name,$null,'Process')}
    Add-Type -Path (Join-Path $kit 'tools/InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
    $definitions=@(@{name='install';version='0.1.0';seconds=45},@{name='repair';version='0.1.0';seconds=45},@{name='smoke';version='0.1.0';seconds=30},@{name='update';version='0.1.1';seconds=45},@{name='smoke';version='0.1.1';seconds=30},@{name='uninstall';version='0.1.1';seconds=30})
    $index=0
    foreach($definition in $definitions){
        Assert-Budget;$index++
        $remaining=[math]::Floor((160-$clock.Elapsed.TotalSeconds)*1000)-5000
        $milliseconds=[int][math]::Min($definition.seconds*1000,$remaining)
        if($milliseconds -lt 10000){throw 'Insufficient shared guest budget for next bounded step.'}
        $directory=Join-Path $runDirectory ('step-'+$index+'-'+$definition.name+'-'+$definition.version);New-Item -ItemType Directory -Path $directory|Out-Null
        $scratchStep=Join-Path $scratchDirectory ('step-'+$index+'-'+$definition.name+'-'+$definition.version)
        foreach($name in @('temp','profile')){New-Item -ItemType Directory -Path (Join-Path $scratchStep $name)|Out-Null}
        New-Item -ItemType Directory -Path (Join-Path $directory 'diagnostics')|Out-Null
        $env:TEMP=Join-Path $scratchStep 'temp';$env:TMP=$env:TEMP;$env:ETS2TELEMETRY_PROFILE_DIR=Join-Path $scratchStep 'profile';$env:ETS2TELEMETRY_DIAGNOSTIC_DIR=Join-Path $directory 'diagnostics'
        $guard=[ordered]@{verifiedUtc=[datetime]::UtcNow.ToString('o');vmUuid=$identity.UUID;labId=$manifest.labId;manifestSha256=$ExpectedManifestSha256;binaryRoot=$report.binaryRoot;step=$definition.name;version=$definition.version;outerDeadlineUtc=$OuterDeadlineUtc;jobRequired=$true}
        $guardPath=Join-Path $directory 'step-guard.json';$guard|ConvertTo-Json|Set-Content -LiteralPath $guardPath -Encoding UTF8
        $step=[ordered]@{index=$index;name=$definition.name;version=$definition.version;directory=$directory;jobBudgetMilliseconds=$milliseconds;jobExitCode=$null;controller=$null;driver=$null;postconditions=$null};$steps.Add($step)
        $code=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess]::Run((Join-Path $kit 'tools/node.exe'),@((Join-Path $kit 'harness/installer-step.mjs'),$kit,$directory,$guardPath,$definition.name,$definition.version,[string]$milliseconds),(Join-Path $kit 'harness/Observe-InstallerJob.ps1'),$directory,(Join-Path $directory 'job'),$milliseconds)
        $step.jobExitCode=$code
        $controllerPath=Join-Path $directory 'job/controller-result.json'
        if(Test-Path -LiteralPath $controllerPath){$step.controller=Get-Content -LiteralPath $controllerPath -Raw|ConvertFrom-Json}
        $resultPath=Join-Path $directory 'step-result.json'
        if(Test-Path -LiteralPath $resultPath){$step.driver=Get-Content -LiteralPath $resultPath -Raw|ConvertFrom-Json}
        if($definition.name -eq 'install'){
            $preimagePath=Join-Path $directory 'sqlite-preimage.json'
            if(Test-Path -LiteralPath $preimagePath){
                $preimage=Get-Content -LiteralPath $preimagePath -Raw|ConvertFrom-Json
                if($preimage.path -ne (Join-Path $report.dataRoot 'data/telemetry.sqlite') -or $preimage.synthetic -ne $true -or $preimage.sha256 -notmatch '^[a-fA-F0-9]{64}$' -or $preimage.bytes -lt 512){throw 'Invalid contained SQLite preservation preimage.'}
                $sentinels.Add($preimage);$report.sentinels=$sentinels.ToArray()
            }
        }
        Save-SquirrelLogs $directory
        if($code -ne 0 -or !$step.driver -or $step.driver.passed -ne $true -or !$step.controller -or $step.controller.passed -ne $true -or $step.controller.driverExitCode -ne 0 -or $step.controller.observerExitCode -ne 0 -or $step.controller.driverStreamsDrained -ne $true -or $step.controller.observerStreamsDrained -ne $true -or $step.controller.elapsedMilliseconds -gt $milliseconds){throw ('Installer step failed: '+$definition.name+'; Job exit '+$code)}
        if($sentinels.Count -ne 6 -or $step.driver.sqlitePreservation.integrity -ne 'ok' -or $step.driver.sqlitePreservation.value -ne 42 -or $step.driver.sqlitePreservation.synthetic -ne 1){throw 'Incomplete synthetic data/SQLite preservation proof.'}
        Assert-Budget
        if($definition.name -ne 'uninstall'){$step.postconditions=Assert-Installed $definition.version}
        else{
            if(@(Read-Registration).Count -or @(Read-Shortcuts).Count){throw 'Uninstall registration/shortcuts remain.'}
            $remainingExecutables=if(Test-Path -LiteralPath $report.binaryRoot){@(Get-ChildItem -LiteralPath $report.binaryRoot -Recurse -Filter 'ETS2TelemetryDesktop*.exe' -File -ErrorAction Stop)}else{@()}
            if($remainingExecutables.Count){throw 'Application executable remains after uninstall.'}
            if(Test-Path -LiteralPath $report.binaryRoot){if(!(Test-Path -LiteralPath (Join-Path $report.binaryRoot '.dead') -PathType Leaf)){throw 'Retained Squirrel root must be marked .dead.'}}
            Assert-Sentinels;$step.postconditions=@{applicationExecutablesRemoved=$true;registrationRemoved=$true;shortcutsRemoved=$true;dataSentinelsPreserved=$true;binaryRootRetained=(Test-Path -LiteralPath $report.binaryRoot)}
        }
        $step|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $directory 'step-proof.json') -Encoding UTF8
    }
    Assert-Budget
    if($steps.Count -ne 6 -or @($steps|Where-Object {$_.jobExitCode -ne 0 -or $_.driver.passed -ne $true}).Count){throw 'Incomplete installer lifecycle.'}
    $report.passed=$true
}catch{$report.failure=$_.Exception.ToString()}
finally{
    foreach($name in $saved.Keys){[Environment]::SetEnvironmentVariable($name,$saved[$name],'Process')}
    $report.finishedUtc=[datetime]::UtcNow.ToString('o');$report.elapsedSeconds=$clock.Elapsed.TotalSeconds;$report.steps=$steps.ToArray()
    if(!(Test-Path -LiteralPath $runDirectory)){New-Item -ItemType Directory -Path $runDirectory|Out-Null}
    $report|ConvertTo-Json -Depth 15|Set-Content -LiteralPath (Join-Path $runDirectory 'guest-result.json') -Encoding UTF8
    [ordered]@{runDirectory=$runDirectory;passed=$report.passed;kind=$report.kind;finishedUtc=$report.finishedUtc}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $kit 'evidence/latest.json') -Encoding UTF8
    $report|ConvertTo-Json -Depth 15
}
if(!$report.passed){exit 1}
