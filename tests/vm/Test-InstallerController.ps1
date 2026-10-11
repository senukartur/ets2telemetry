# Plan by default; explicit -Run executes only reviewed fixed console fixtures.
[CmdletBinding()]
param([switch]$Run,[string]$NodePath,[string]$OutputDirectory,[ValidateSet('all','normal','partial-start','deadline','nonzero','orphan','output','owner-death')][string]$Case='all')
$ErrorActionPreference='Stop'
if(!$Run){[ordered]@{run=$false;applicationLaunched=$false;productionObserverExecuted=$false;jobMilliseconds=5000;cases=@('normal','partial-start','deadline','nonzero','orphan','output','owner-death');action='Coordinator reviews exact sources before explicit -Run with pinned Node and fresh isolated proof directory.'}|ConvertTo-Json;return}
if(!$NodePath -or ![IO.Path]::IsPathRooted($NodePath) -or (Get-Item -LiteralPath $NodePath).Name -cne 'node.exe'){throw 'Reviewed absolute Node path required.'}
if(!$OutputDirectory -or ![IO.Path]::IsPathRooted($OutputDirectory) -or (Test-Path -LiteralPath $OutputDirectory)){throw 'Fresh absolute proof directory required.'}
$root=[IO.Path]::GetFullPath($OutputDirectory);New-Item -ItemType Directory -Path $root|Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'InstallerBoundedProcess.cs') -ReferencedAssemblies System.dll,System.Core.dll,System.Web.Extensions.dll
function Assert($condition,$message){if(!$condition){throw $message}}
function Capture-Process([int]$number){$process=[Diagnostics.Process]::GetProcessById($number);$null=$process.Handle;return $process}
function Assert-Gone($process){Assert ($process.WaitForExit(1000)) ('Owned fixture remains: '+$process.Id)}
$cases=if($Case -eq 'all'){@('normal','partial-start','deadline','nonzero','orphan','output','owner-death')}else{@($Case)}
$rows=[Collections.Generic.List[object]]::new();$savedMode=$env:ETS2TELEMETRY_SIBLING_FIXTURE;$sentinel=$null;$owner=$null
try{
    $sentinelDirectory=Join-Path $root 'unrelated';New-Item -ItemType Directory -Path $sentinelDirectory|Out-Null
    $fixture=Join-Path $PSScriptRoot 'sibling-fixture.cjs'
    $quote=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess].GetMethod('Quote',[Reflection.BindingFlags]'NonPublic,Static')
    $sentinelArgs=(@($fixture,'leaf',$sentinelDirectory)|ForEach-Object {$quote.Invoke($null,@([string]$_))}) -join ' '
    $sentinel=Start-Process -FilePath $NodePath -ArgumentList $sentinelArgs -WindowStyle Hidden -PassThru;$null=$sentinel.Handle
    foreach($mode in $cases){
        $directory=Join-Path $root $mode;New-Item -ItemType Directory -Path $directory|Out-Null
        $env:ETS2TELEMETRY_SIBLING_FIXTURE=$mode;$held=[Collections.Generic.List[Diagnostics.Process]]::new()
        if($mode -in @('owner-death','deadline')){
            $shell='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
            $ownerArgs=(@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',(Join-Path $PSScriptRoot 'sibling-owner-fixture.ps1'),'-NodePath',$NodePath,'-OutputDirectory',$directory,'-Mode',$mode)|ForEach-Object {$quote.Invoke($null,@([string]$_))}) -join ' '
            $owner=Start-Process -FilePath $shell -ArgumentList $ownerArgs -WindowStyle Hidden -PassThru;$null=$owner.Handle
            $startup=[Diagnostics.Stopwatch]::StartNew()
            while(!(Test-Path -LiteralPath (Join-Path $directory 'driver-child.json'))){if($owner.HasExited -or $startup.ElapsedMilliseconds -ge 6500){throw 'Fixed hanging sibling fixture did not start.'};Start-Sleep -Milliseconds 10}
            $receipt=Get-Content -LiteralPath (Join-Path $directory 'job/controller-receipt.json') -Raw|ConvertFrom-Json
            foreach($number in @($receipt.driverPid,$receipt.observerPid,(Get-Content -LiteralPath (Join-Path $directory 'driver-child.json') -Raw|ConvertFrom-Json).pid)){$held.Add((Capture-Process $number))}
            if($mode -eq 'owner-death'){$owner.Kill()}
            Assert ($owner.WaitForExit(6500)) 'Fixture owner failed to stop.'
            foreach($process in $held){Assert-Gone $process;$process.Dispose()}
            if($mode -eq 'deadline'){Assert ($owner.ExitCode -eq 124) 'Deadline must report 124.'}else{Assert (!(Test-Path -LiteralPath (Join-Path $directory 'job/controller-result.json'))) 'Killed owner unexpectedly reported normal completion.'}
            $owner.Dispose();$owner=$null;$rows.Add([ordered]@{case=$mode;passed=$true;heldProcessesStopped=$true});continue
        }
        $script=Join-Path $PSScriptRoot 'sibling-observer-fixture.ps1'
        # Force actual second CreateProcess failure after the first root is assigned.
        if($mode -eq 'partial-start'){$script='C:\'+('x'*33000)+'.ps1'}
        $code=[ETS2Telemetry.Diagnostics.InstallerBoundedProcess]::Run($NodePath,[string[]]@($fixture,$mode,$directory),$script,$directory,(Join-Path $directory 'job'),5000)
        $proof=Get-Content -LiteralPath (Join-Path $directory 'job/controller-result.json') -Raw|ConvertFrom-Json
        if($mode -ne 'partial-start'){
            Assert (!$proof.initialJobSnapshot.failure -and $proof.initialJobSnapshot.assignedCount -eq 2 -and $proof.initialJobSnapshot.listedCount -eq 2) 'Suspended-root diagnostic counts differ.'
            Assert ($proof.initialJobSnapshot.pids.Count -eq 2 -and $proof.initialJobSnapshot.pids -contains $proof.driverPid -and $proof.initialJobSnapshot.pids -contains $proof.observerPid) 'Suspended-root diagnostic identities differ.'
        }else{
            Assert (!$proof.failureJobSnapshot.failure -and $proof.failureJobSnapshot.assignedCount -eq 1 -and $proof.failureJobSnapshot.listedCount -eq 1 -and $proof.failureJobSnapshot.pids -contains $proof.driverPid) 'Partial-start diagnostic must retain its assigned suspended root.'
        }
        if($mode -in @('normal','output')){
            Assert ($code -eq 0 -and $proof.passed -and $proof.driverExitCode -eq 0 -and $proof.observerExitCode -eq 0) 'Two normal roots require actual exits 0.'
            Assert ((Get-Content -LiteralPath (Join-Path $directory 'driver-marker.json') -Raw|ConvertFrom-Json).marker -eq 'SIBLING_NODE_REACHED') 'Node marker missing.'
            Assert ((Get-Content -LiteralPath (Join-Path $directory 'observer-marker.json') -Raw|ConvertFrom-Json).marker -eq 'SIBLING_POWERSHELL_REACHED') 'PowerShell marker missing.'
            if($mode -eq 'output'){Assert ((Get-Item -LiteralPath (Join-Path $directory 'job/driver-stdout.log')).Length -eq 1048576) 'Driver output cap mismatch.';Assert ((Get-Item -LiteralPath (Join-Path $directory 'job/observer-stdout.log')).Length -eq 1048576) 'Observer output cap mismatch.'}
        }elseif($mode -eq 'partial-start'){
            Assert ($code -eq 126 -and $proof.driverExitCode -eq 126 -and $proof.observerPid -eq 0) 'Partial second spawn must clean suspended root.'
            Assert (!(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))) 'Suspended driver unexpectedly executed.'
        }elseif($mode -eq 'nonzero'){
            Assert ($code -eq 126 -and $proof.observerExitCode -eq 9) 'Nonzero observer must fail before driver resumes.'
            Assert (!(Test-Path -LiteralPath (Join-Path $directory 'driver-marker.json'))) 'Driver resumed despite failed readiness.'
        }elseif($mode -eq 'orphan'){
            Assert ($code -eq 125 -and $proof.driverExitCode -eq 0) 'Root exit with live observer/descendant must fail 125.'
            Assert ($proof.observerExitCode -eq 125) 'Orphan observer was not terminated by its Job.'
        }
        $rows.Add([ordered]@{case=$mode;passed=$true;code=$code;controller=$proof})
    }
    Assert (!$sentinel.HasExited) 'Unrelated sentinel was affected.'
    [ordered]@{passed=$true;applicationLaunched=$false;productionObserverExecuted=$false;cases=$rows.ToArray();unrelatedSentinelPreserved=$true}|ConvertTo-Json -Depth 8|Set-Content -LiteralPath (Join-Path $root 'controller-regression.json') -Encoding UTF8
}finally{
    [Environment]::SetEnvironmentVariable('ETS2TELEMETRY_SIBLING_FIXTURE',$savedMode,'Process')
    if($owner -and !$owner.HasExited){$owner.Kill();$null=$owner.WaitForExit(1000)}
    if($sentinel -and !$sentinel.HasExited){$sentinel.Kill();$null=$sentinel.WaitForExit(1000)}
    if($owner){$owner.Dispose()};if($sentinel){$sentinel.Dispose()}
}
