# Plan by default. Explicit -Run executes fixed harmless console custody controls only.
[CmdletBinding()]
param([switch]$Run,[string]$NodePath,[string]$OutputDirectory,[ValidateSet('all','normal','absent','outside','nonzero','live','owner-death','wrong-image')][string]$Case='all')
$ErrorActionPreference='Stop'
if(!$Run){[ordered]@{run=$false;applicationLaunched=$false;productionObserverExecuted=$false;jobMilliseconds=5000;cases=@('normal','absent','outside','nonzero','live','owner-death','wrong-image');action='Review exact source and fixed surrogate policy before root -Run with pinned Node and a fresh ignored proof directory.'}|ConvertTo-Json;return}
if(!$NodePath -or ![IO.Path]::IsPathRooted($NodePath) -or (Get-Item -LiteralPath $NodePath).Name -cne 'node.exe' -or !$OutputDirectory -or ![IO.Path]::IsPathRooted($OutputDirectory) -or (Test-Path -LiteralPath $OutputDirectory)){throw 'Pinned Node and fresh absolute proof paths required.'}
New-Item -ItemType Directory -Path $OutputDirectory|Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
$entry=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess].GetMethod('RunConsoleFixture',[Reflection.BindingFlags]'NonPublic,Static')
$quote=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess].GetMethod('Quote',[Reflection.BindingFlags]'NonPublic,Static')
function Assert($condition,$message){if(!$condition){throw $message}}
function Hold([int]$number){$process=[Diagnostics.Process]::GetProcessById($number);$null=$process.Handle;return $process}
$rows=[Collections.Generic.List[object]]::new();$sentinel=$null;$owner=$null;$diagnosticHandles=[Collections.Generic.List[Diagnostics.Process]]::new();$saved=$env:ETS2TELEMETRY_CONSOLE_OUTSIDE_PID
try{
    $unrelated=Join-Path $OutputDirectory 'unrelated';New-Item -ItemType Directory -Path $unrelated|Out-Null
    $arguments=(@((Join-Path $PSScriptRoot 'sibling-fixture.cjs'),'leaf',$unrelated)|ForEach-Object {$quote.Invoke($null,@([string]$_))}) -join ' '
    $sentinel=Start-Process -FilePath $NodePath -ArgumentList $arguments -WindowStyle Hidden -PassThru;$null=$sentinel.Handle;$env:ETS2TELEMETRY_CONSOLE_OUTSIDE_PID=[string]$sentinel.Id
    $modes=if($Case -eq 'all'){@('normal','absent','outside','nonzero','live','owner-death','wrong-image')}else{@($Case)}
    foreach($mode in $modes){
        $directory=Join-Path $OutputDirectory $mode;New-Item -ItemType Directory -Path $directory|Out-Null
        if($mode -in @('owner-death','live')){
            $arguments=(@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'sibling-console-owner-fixture.ps1'),'-NodePath',$NodePath,'-OutputDirectory',$directory,'-Mode',$mode)|ForEach-Object {$quote.Invoke($null,@([string]$_))}) -join ' '
            $owner=Start-Process -FilePath 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe' -ArgumentList $arguments -WindowStyle Hidden -PassThru;$null=$owner.Handle;$clock=[Diagnostics.Stopwatch]::StartNew()
            while(!(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))){if($owner.HasExited -or $clock.ElapsedMilliseconds -ge 6500){throw 'Fixed owner-death roots did not start.'};Start-Sleep -Milliseconds 10}
            $receipt=Get-Content -LiteralPath (Join-Path $directory 'job/controller-receipt.json') -Raw|ConvertFrom-Json;$custody=Get-Content -LiteralPath (Join-Path $directory 'job/console-custody.json') -Raw|ConvertFrom-Json
            $held=@(@($receipt.driverPid,$receipt.observerPid,$custody.consolePid,$custody.fixtureConsolePid,$custody.fixtureConsoleNodeHostPid)|Where-Object {$_}|ForEach-Object {Hold $_})
            if($mode -eq 'live'){
                $driver=@($held|Where-Object {$_.Id -eq $receipt.driverPid})[0];$queryClock=[Diagnostics.Stopwatch]::StartNew();$children=[Collections.Generic.List[object]]::new()
                $diagnostic=[ordered]@{driverPid=$driver.Id;driverStartUtc=$driver.StartTime.ToUniversalTime().ToString('o');driverSignaledBefore=$driver.WaitForExit(0);driverSignaledAfter=$null;operationTimeoutSeconds=1;maximumChildren=16;children=@();failure=$null;elapsedMilliseconds=0;capturedPidsInFailureSnapshot=@()}
                try{
                    if($diagnostic.driverSignaledBefore){throw 'Held driver exited before child metadata query.'}
                    $metadataRows=@(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId = '+$driver.Id) -OperationTimeoutSec 1)
                    if($metadataRows.Count -gt 16){throw 'Driver child query exceeds the Job process bound.'}
                    foreach($metadata in $metadataRows){
                        $row=[ordered]@{pid=[int]$metadata.ProcessId;parentProcessId=[int]$metadata.ParentProcessId;metadataImage=[string]$metadata.ExecutablePath;commandLine=[string]$metadata.CommandLine;commandLineTruncated=$false;metadataStartUtc=$null;nativeImage=$null;nativeStartUtc=$null;creationDeltaMilliseconds=$null;nativeSignaledBefore=$null;nativeSignaledAfter=$null;identityBound=$false;failure=$null}
                        $children.Add($row)
                        try{
                            if($row.metadataImage.Length -gt 1024){throw 'Driver child metadata image exceeds 1 KiB.'}
                            if($row.commandLine.Length -gt 1024){$row.commandLine=$row.commandLine.Substring(0,1024);$row.commandLineTruncated=$true}
                            $process=Hold $row.pid;$diagnosticHandles.Add($process);$held+=,$process
                            $row.nativeSignaledBefore=$process.WaitForExit(0);$row.nativeImage=$process.MainModule.FileName;$nativeStart=$process.StartTime.ToUniversalTime();$metadataStart=([DateTime]$metadata.CreationDate).ToUniversalTime()
                            $row.nativeStartUtc=$nativeStart.ToString('o');$row.metadataStartUtc=$metadataStart.ToString('o');$row.creationDeltaMilliseconds=[Math]::Abs(($nativeStart-$metadataStart).TotalMilliseconds);$row.nativeSignaledAfter=$process.WaitForExit(0)
                            if($row.nativeImage.Length -gt 1024){throw 'Driver child native image exceeds 1 KiB.'}
                            if($row.parentProcessId -ne $driver.Id -or $row.nativeImage -ine $row.metadataImage -or $row.creationDeltaMilliseconds -gt 1 -or $row.nativeSignaledBefore -or $row.nativeSignaledAfter){throw 'Held driver child image, creation time, parent or liveness differs from metadata.'}
                            $row.identityBound=$true
                        }catch{$row.failure=$_.Exception.Message;foreach($key in @('metadataImage','nativeImage','commandLine','failure')){if($row[$key] -and $row[$key].Length -gt 1024){$row[$key]=$row[$key].Substring(0,1024)}}}
                    }
                }catch{$diagnostic.failure=$_.Exception.Message;if($diagnostic.failure.Length -gt 1024){$diagnostic.failure=$diagnostic.failure.Substring(0,1024)}}
                $diagnostic.driverSignaledAfter=$driver.WaitForExit(0);$diagnostic.children=$children.ToArray();$diagnostic.elapsedMilliseconds=$queryClock.Elapsed.TotalMilliseconds
                $diagnosticFile=Join-Path $directory 'driver-child-diagnostics.json';$diagnostic|ConvertTo-Json -Depth 5 -Compress|Set-Content -LiteralPath ($diagnosticFile+'.partial') -Encoding UTF8;Move-Item -LiteralPath ($diagnosticFile+'.partial') -Destination $diagnosticFile
                '{}'|Set-Content -LiteralPath (Join-Path $directory 'fixture-release.json') -Encoding UTF8
            }
            if($mode -eq 'owner-death'){$owner.Kill()};Assert ($owner.WaitForExit(6500)) 'Owner did not exit.';foreach($process in $held){Assert ($process.WaitForExit(1000)) 'Owned root/console survived owner death/deadline.';$process.Dispose()}
            if($mode -eq 'owner-death'){Assert (!(Test-Path -LiteralPath (Join-Path $directory 'job/controller-result.json'))) 'Killed owner must not report normal completion.'}
            else{$proof=Get-Content -LiteralPath (Join-Path $directory 'job/controller-result.json') -Raw|ConvertFrom-Json;Assert ($owner.ExitCode -eq 124 -and $proof.consoleExitCode -eq 124 -and $proof.observerExitCode -eq 0 -and (!$custody.fixtureConsoleNodeHostPid -or ($proof.fixtureConsoleNodeHostPid -eq $custody.fixtureConsoleNodeHostPid -and $null -ne $proof.fixtureConsoleNodeHostExitCode -and $proof.fixtureConsoleNodeHostExitCode -ne 259)) -and $proof.driverStreamsDrained -and $proof.observerStreamsDrained -and $proof.elapsedMilliseconds -le 5000 -and !(Test-Path -LiteralPath (Join-Path $directory 'job/observer-exit.json'))) 'Live console must fail after actual PowerShell exit inside the original drained deadline.'}
            if($mode -eq 'live'){
                $diagnostic.capturedPidsInFailureSnapshot=@($diagnostic.children|ForEach-Object {[ordered]@{pid=$_.pid;presentInFailureSnapshot=$proof.failureJobSnapshot.pids -contains $_.pid;identityBound=$_.identityBound}})
                $diagnostic|ConvertTo-Json -Depth 5 -Compress|Set-Content -LiteralPath ($diagnosticFile+'.completed') -Encoding UTF8
                Assert (!$diagnostic.failure -and !$diagnostic.driverSignaledBefore -and !$diagnostic.driverSignaledAfter -and @($diagnostic.children|Where-Object {!$_.identityBound}).Count -eq 0) 'Driver child diagnostic failed to bind held identities.'
            }
            $owner.Dispose();$owner=$null;$rows.Add([ordered]@{case=$mode;passed=$true;heldProcessesStopped=$true;controller=if($mode -eq 'live'){$proof}else{$null}});continue
        }
        $invocation=[object[]]@([string]$NodePath,[string[]]@([string](Join-Path $PSScriptRoot 'sibling-console-fixture.cjs'),[string]$mode,[string]$directory),[string](Join-Path $PSScriptRoot 'sibling-console-observer-fixture.ps1'),[string]$directory,[string](Join-Path $directory 'job'),[int]5000)
        $code=$entry.Invoke($null,$invocation)
        $proof=Get-Content -LiteralPath (Join-Path $directory 'job/controller-result.json') -Raw|ConvertFrom-Json
        Assert ($proof.driverStreamsDrained -and $proof.observerStreamsDrained -and $proof.elapsedMilliseconds -le 5000) 'All four streams and cleanup must finish within the original deadline.'
        Assert ((Get-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Raw|ConvertFrom-Json).marker -eq 'CONSOLE_POWERSHELL_REACHED') 'Actual observer execution marker missing.'
        if($mode -eq 'normal'){
            Assert ($code -eq 0 -and $proof.passed -and $proof.consoleExitCode -eq 0 -and $proof.driverExitCode -eq 0 -and $proof.observerExitCode -eq 0) 'Actual roots and held surrogate must exit 0.'
            Assert ((Get-Content -LiteralPath (Join-Path $directory 'driver-marker.json') -Raw|ConvertFrom-Json).marker -eq 'CONSOLE_DRIVER_REACHED') 'Driver marker missing.'
            $exit=Get-Content -LiteralPath (Join-Path $directory 'job/observer-exit.json') -Raw|ConvertFrom-Json;Assert ($exit.consoleSignaled -and $exit.consoleExitCode -eq 0 -and (!$exit.fixtureConsolePid -or ($exit.fixtureConsoleSignaled -and $exit.fixtureConsoleExitCode -eq 0 -and $proof.fixtureConsoleExitCode -eq 0)) -and (!$exit.fixtureConsoleNodeHostPid -or ($exit.fixtureConsoleNodeHostSignaled -and $exit.fixtureConsoleNodeHostExitCode -eq 0 -and $proof.fixtureConsoleNodeHostExitCode -eq 0))) 'Native console exit receipt missing.'
        }elseif($mode -eq 'live'){Assert ($code -eq 124 -and $proof.consoleExitCode -eq 124) 'Live console must fail the unchanged deadline and be contained.'}
        elseif($mode -eq 'nonzero'){Assert ($code -eq 126 -and $proof.consoleExitCode -eq 9 -and $proof.observerExitCode -eq 0) 'Nonzero console must fail after PowerShell exit without publishing a success receipt.'}
        else{Assert ($code -eq 126 -and !(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))) 'Invalid console must fail before driver resume.'}
        if($mode -ne 'normal'){Assert (!(Test-Path -LiteralPath (Join-Path $directory 'job/observer-exit.json'))) 'Invalid/nonzero/live console published success.'}
        $marker=Get-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Raw|ConvertFrom-Json
        $owned=@($proof.driverPid,$proof.observerPid,$proof.consolePid,$proof.fixtureConsolePid,$proof.fixtureConsoleNodeHostPid,$marker.surrogatePid)+@($proof.failureJobSnapshot.pids)
        if(Test-Path -LiteralPath (Join-Path $directory 'surrogate-marker.json')){$owned+=@((Get-Content -LiteralPath (Join-Path $directory 'surrogate-marker.json') -Raw|ConvertFrom-Json).pid)}
        foreach($number in $owned|Where-Object {$_ -and $_ -ne $sentinel.Id}|Select-Object -Unique){Assert (!(Get-Process -Id $number -ErrorAction SilentlyContinue)) 'Owned process remains after bounded result.'}
        $rows.Add([ordered]@{case=$mode;passed=$true;controller=$proof})
    }
    Assert (!$sentinel.HasExited) 'Unrelated sentinel was affected.'
    [ordered]@{passed=$true;applicationLaunched=$false;productionObserverExecuted=$false;cases=$rows.ToArray();unrelatedSentinelPreserved=$true}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $OutputDirectory 'console-regression.json') -Encoding UTF8
}finally{[Environment]::SetEnvironmentVariable('ETS2TELEMETRY_CONSOLE_OUTSIDE_PID',$saved,'Process');if($owner -and !$owner.HasExited){$owner.Kill();$null=$owner.WaitForExit(1000)};if($sentinel -and !$sentinel.HasExited){$sentinel.Kill();$null=$sentinel.WaitForExit(1000)};foreach($process in $diagnosticHandles){$process.Dispose()}}
