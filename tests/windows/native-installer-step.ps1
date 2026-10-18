# A single directly created PowerShell root inside the unchanged watchdog Job.
[CmdletBinding()]param([switch]$Run,[string]$ConfigFile)
# Retired by ET-018 PR-1 (October 18, 2026), with Invoke-NativeInstallerAcceptance.ps1: its steps install into and
# uninstall from the real %LOCALAPPDATA% roots. Without -Run it only reports its plan; -Run always refuses. Installer
# checks now run in a marked test root (scripts/installer/Invoke-InstallerLifecycle.ps1, docs/installer-testing.md).
if(!$Run){@{run=$false;retired='RETIRED_ET018_REAL_ROOTS';steps=@('install','repair','update','smoke','uninstall','control','linger');configFile=[bool]$ConfigFile;applicationLaunched=$false}|ConvertTo-Json;return}
throw 'RETIRED_ET018_REAL_ROOTS: this step used the real LocalAppData roots; use scripts/installer/Invoke-InstallerLifecycle.ps1 (docs/installer-testing.md).'
# The body below is kept unchanged as the record of the ET-001 procedure; it is unreachable.
$ErrorActionPreference='Stop';$clock=[Diagnostics.Stopwatch]::StartNew();$console=[IntPtr]::Zero
$proof=[ordered]@{passed=$false;failure=$null;rootPid=$PID;scope=$null;console=$null;primary=@();finalPids=@();childrenNaturallyDrained=$false}
function Read-BoundedJson([string]$filename){$stream=[IO.File]::OpenRead($filename);try{$buffer=New-Object byte[] 16385;$count=0;while($count -lt $buffer.Length){$n=$stream.Read($buffer,$count,$buffer.Length-$count);if(!$n){break};$count+=$n};if($count -gt 16384){throw 'Configuration exceeds16KiB.'};[Text.Encoding]::UTF8.GetString($buffer,0,$count).TrimStart([char]0xfeff)|ConvertFrom-Json}finally{$stream.Dispose()}}
function Quote-Arg([string]$value){if($value -match '[\x00\r\n]'){throw 'Invalid argument.'};'"'+[regex]::Replace([regex]::Replace($value,'(\\*)"','$1$1\"'),'(\\+)$','$1$1')+'"'}
function Budget {if($clock.ElapsedMilliseconds -ge $config.budgetMilliseconds-800){throw 'Step completion deadline reached.'}}
function Members {$snapshot=[InstallerJobView]::ReadPids();if($snapshot.AssignedCount -ne $snapshot.ListedCount -or $snapshot.ListedCount -lt 1 -or $snapshot.ListedCount -gt 16){throw 'Incoherent bounded Job snapshot.'};@($snapshot.Pids)}
function Wait-Children {
    while($true){Budget;$pids=@(Members);$others=@($pids|Where-Object {$_ -ne $PID -and (!$proof.console -or $_ -ne $proof.console.pid)});if(!$others.Count){
        if(!($pids -contains $PID)){throw 'Root missing from Job.'}
        if($console -ne [IntPtr]::Zero -and ([InstallerJobView]::Signaled($console) -or [InstallerJobView]::ExitCode($console) -ne 259)){throw 'Root console exited unexpectedly.'}
        $proof.finalPids=$pids;$proof.childrenNaturallyDrained=$true;return
    };Start-Sleep -Milliseconds 20}
}
function Child([string]$exe,[string[]]$arguments){
    $proof.childrenNaturallyDrained=$false;$proof.finalPids=@()
    Budget;$info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$exe;$info.Arguments=(@($arguments|ForEach-Object {Quote-Arg $_}) -join ' ');$info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.WorkingDirectory=$config.cwd
    $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
    $child=[Diagnostics.Process]::new();$child.StartInfo=$info;$row=[ordered]@{executable=$exe;arguments=$arguments;pid=$null;exitCode=$null;stdout=$null;stderr=$null;streamsDrained=$false;truncated=@{stdout=$false;stderr=$false}};$proof.primary+=,$row
    try{
        if(!$child.Start()){throw 'Child start failed.'};$row.pid=$child.Id;$child.StandardInput.Close()
        $streams=@($child.StandardOutput,$child.StandardError);$buffers=@((New-Object char[] 4096),(New-Object char[] 4096));$texts=@([Text.StringBuilder]::new(),[Text.StringBuilder]::new());$done=@($false,$false);$tasks=@($streams[0].ReadAsync($buffers[0],0,4096),$streams[1].ReadAsync($buffers[1],0,4096))
        while(!$child.HasExited -or !$done[0] -or !$done[1]){
            Budget;for($i=0;$i -lt 2;$i++){if(!$done[$i] -and $tasks[$i].IsCompleted){$n=$tasks[$i].GetAwaiter().GetResult();if(!$n){$done[$i]=$true}else{$keep=[math]::Min($n,262144-$texts[$i].Length);if($keep -gt 0){$null=$texts[$i].Append($buffers[$i],0,$keep)};if($keep -ne $n){$row.truncated[@('stdout','stderr')[$i]]=$true};$tasks[$i]=$streams[$i].ReadAsync($buffers[$i],0,4096)}}};Start-Sleep -Milliseconds 10
        }
        $child.WaitForExit();$row.exitCode=$child.ExitCode;$row.streamsDrained=$true
        foreach($i in 0,1){$name=@('stdout','stderr')[$i];$filename=Join-Path $config.directory ('child-'+$proof.primary.Count+'-'+$name+'.log');[IO.File]::WriteAllText($filename,$texts[$i].ToString(),[Text.UTF8Encoding]::new($false));$row[$name]=$filename}
        if($row.exitCode -ne 0){throw ('Primary exit was '+$row.exitCode)};Wait-Children
    }finally{
        # Retain already-read output even when the original deadline rejects a child.
        if($texts){foreach($i in 0,1){$name=@('stdout','stderr')[$i];$filename=Join-Path $config.directory ('child-'+$proof.primary.Count+'-'+$name+'.log');[IO.File]::WriteAllText($filename,$texts[$i].ToString(),[Text.UTF8Encoding]::new($false));$row[$name]=$filename}}
        $child.Dispose()
    }
}
try{
    $config=Read-BoundedJson $ConfigFile
    if((Get-FileHash -LiteralPath $config.observerAssembly).Hash -ne $config.observerAssemblySha256){throw 'Observer assembly preimage mismatch.'}
    $null=[Reflection.Assembly]::LoadFrom($config.observerAssembly);$proof.scope=[InstallerJobView]::AuthoritativeScope()
    $initial=@(Members);$extra=@($initial|Where-Object {$_ -ne $PID});if($extra.Count -gt 1){throw 'Unexpected initial Job members.'}
    if($extra.Count){
        $console=[InstallerJobView]::Hold($extra[0]);if($console -eq [IntPtr]::Zero){throw 'Cannot retain root console.'};$image=[InstallerJobView]::Image($console);$expected=Join-Path ([Environment]::SystemDirectory) 'conhost.exe'
        $metadata=Get-CimInstance Win32_Process -Filter ('ProcessId='+$extra[0]) -OperationTimeoutSec 1
        if($image -ne $expected -or $metadata.ExecutablePath -ne $expected -or $metadata.ParentProcessId -ne $PID -or $metadata.CommandLine -ine ('\??\'+$expected+' 0x4') -or [InstallerJobView]::Signaled($console) -or [InstallerJobView]::ExitCode($console) -ne 259){throw 'Root console provenance failed.'}
        $proof.console=@{pid=$extra[0];nativeImage=$image;parent=$metadata.ParentProcessId;command=$metadata.CommandLine;held=$true};Wait-Children
    }
    if($config.step -in @('control','linger')){Child $config.node @($config.driver,$config.step,$ConfigFile);if($config.step -eq 'control' -and !(Select-String -LiteralPath $proof.primary[0].stdout -SimpleMatch 'ET001_NATIVE_CHILD_REACHED' -Quiet)){throw 'Control marker missing.'}}
    else{
        if($config.step -eq 'install'){Child $config.node @($config.driver,'prepare',$ConfigFile)}
        if($config.step -in @('install','repair')){Child $config.setup @('--silent')}
        elseif($config.step -eq 'update'){Child $config.updater @('--update',$config.feed)}
        elseif($config.step -eq 'uninstall'){
            Child $config.executable @('--squirrel-uninstall',$config.version)
            if(@(Get-ChildItem -LiteralPath $config.diagnostics -Force).Count -or @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'ets2telemetry-probe-*').Count){throw 'Direct uninstall hook started application.'}
            Child $config.updater @('--uninstall','--silent')
        }
        elseif($config.step -eq 'smoke'){Child $config.node @($config.driver,'smoke',$ConfigFile)}else{throw 'Unknown step.'}
        if($config.step -in @('install','repair','update')){
            if(@(Get-ChildItem -LiteralPath $config.diagnostics -Force).Count -or @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'ets2telemetry-probe-*').Count){throw 'Automatic installer lifecycle started application.'}
            $hook=if($config.step -eq 'update'){'--squirrel-updated'}else{'--squirrel-install'}
            Child $config.executable @($hook,$config.version)
            if(@(Get-ChildItem -LiteralPath $config.diagnostics -Force).Count -or @(Get-ChildItem -LiteralPath $env:TEMP -Filter 'ets2telemetry-probe-*').Count){throw 'Direct hook regression started application.'}
            $proof['directHookRegression']=@{argument=$hook;version=$config.version;exitCode=0;automaticDispatchExitCodeClaimed=$false}
        }
        Child $config.node @($config.driver,'verify',$ConfigFile)
    }
    Wait-Children;$proof.passed=$true
}catch{$proof.failure=$_.Exception.ToString();try{$proof['failurePids']=@(Members)}catch{$proof['failureSnapshotError']=$_.Exception.ToString()}}
finally{if($config){$proof.elapsedMilliseconds=$clock.ElapsedMilliseconds;$proof|ConvertTo-Json -Depth 12|Set-Content -LiteralPath (Join-Path $config.directory 'step-result.json') -Encoding UTF8};if($console -ne [IntPtr]::Zero){[InstallerJobView]::Release($console)}}
if(!$proof.passed){exit 1};exit 0
