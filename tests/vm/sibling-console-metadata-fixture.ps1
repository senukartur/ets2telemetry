# Fixed harmless metadata fixture; no production observer DLL or native Job query.
function Save-FixtureUnexpectedMembers($directory,[int[]]$knownPids){
    $clock=[Diagnostics.Stopwatch]::StartNew();$held=[Collections.Generic.List[Diagnostics.Process]]::new();$rows=[Collections.Generic.List[object]]::new()
    $proof=[ordered]@{rawPids=@();knownPids=$knownPids;unexpected=@();failure=$null;elapsedMilliseconds=0;queryStartCutoffMilliseconds=1000;operationTimeoutSeconds=1}
    try{
        $file=Join-Path $directory 'job/controller-members.json'
        if((Get-Item -LiteralPath $file).Length -gt 8192){throw 'Fixture broker exceeds 8 KiB.'}
        $members=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;$raw=@($members.pids|ForEach-Object {[int]$_});$proof.rawPids=$raw
        if($raw.Count -lt 2 -or $raw.Count -gt 16 -or @($raw|Select-Object -Unique).Count -ne $raw.Count){throw 'Fixture broker PID set is invalid.'}
        foreach($number in $raw|Where-Object {$_ -notin $knownPids}){
            $row=[ordered]@{pid=$number;nativeImage=$null;nativeSignaledBefore=$null;nativeSignaledAfter=$null;nativeExitCode=$null;nativeFailure=$null;metadataImage=$null;parentProcessId=$null;commandLine=$null;metadataFailure='Not queried: one exact-PID query maximum.'}
            $rows.Add($row)
            try{$process=[Diagnostics.Process]::GetProcessById($number);$held.Add($process);$null=$process.Handle;$row.nativeImage=$process.MainModule.FileName;if($row.nativeImage.Length -gt 1024){$row.nativeImage=$row.nativeImage.Substring(0,1024)};$row.nativeSignaledBefore=$process.WaitForExit(0);if($row.nativeSignaledBefore){$row.nativeExitCode=$process.ExitCode}}catch{$row.nativeFailure=$_.Exception.Message}
        }
        if($rows.Count -and $clock.ElapsedMilliseconds -lt 1000){
            $row=$rows[0]
            try{$metadata=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$row.pid) -OperationTimeoutSec 1;if(!$metadata){throw 'Exact fixture PID metadata missing.'};$row.metadataImage=[string]$metadata.ExecutablePath;$row.parentProcessId=[int]$metadata.ParentProcessId;$row.commandLine=[string]$metadata.CommandLine;foreach($key in @('metadataImage','commandLine')){if($row[$key].Length -gt 1024){$row[$key]=$row[$key].Substring(0,1024)}};$row.metadataFailure=$null}catch{$row.metadataFailure=$_.Exception.Message}
        }
        foreach($process in $held){$row=@($rows|Where-Object {$_.pid -eq $process.Id})[0];try{$row.nativeSignaledAfter=$process.WaitForExit(0);if($row.nativeSignaledAfter){$row.nativeExitCode=$process.ExitCode}}catch{$row.nativeFailure=$_.Exception.Message}}
    }catch{$proof.failure=$_.Exception.Message}
    finally{
        foreach($process in $held){$process.Dispose()}
        $proof.unexpected=$rows.ToArray();$proof.elapsedMilliseconds=$clock.Elapsed.TotalMilliseconds
        $proof|ConvertTo-Json -Depth 5 -Compress|Set-Content -LiteralPath (Join-Path $directory 'fixture-member-diagnostics.json') -Encoding UTF8
    }
    return $proof
}
function Get-FixtureConsole($directory){
    $clock=[Diagnostics.Stopwatch]::StartNew();$members=$null
    do{
        $file=Join-Path $directory 'job/controller-members.json'
        if(Test-Path -LiteralPath $file){$members=Get-Content -LiteralPath $file -Raw|ConvertFrom-Json;$extra=@($members.pids|Where-Object {$_ -ne $DriverPid -and $_ -ne $PID});if($extra.Count){break}}
        Start-Sleep -Milliseconds 10
    }while($clock.ElapsedMilliseconds -lt 250)
    if(!$members){throw 'Owned fixture member receipt missing.'}
    if(!$extra.Count){return $null}
    if($extra.Count -ne 1){throw 'Fixture console candidate count differs.'}
    $candidate=[Diagnostics.Process]::GetProcessById([int]$extra[0]);$null=$candidate.Handle
    try{
        $metadata=Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = '+$extra[0]) -OperationTimeoutSec 1
        if($metadata.ExecutablePath -ine 'C:\Windows\System32\conhost.exe' -or $metadata.ParentProcessId -ne $PID -or $candidate.HasExited){throw 'Fixture own console metadata differs.'}
        return [ordered]@{pid=[int]$extra[0];nativeImage=$metadata.ExecutablePath;metadataImage=$metadata.ExecutablePath;parentProcessId=[int]$metadata.ParentProcessId;commandLine=$metadata.CommandLine;nativeExitBefore=259;nativeExitAfter=259;nativeSignaledBefore=$candidate.WaitForExit(0);nativeSignaledAfter=$candidate.WaitForExit(0);nativeImageFailure=$null;nativeExitFailure=$null;metadataFailure=$null;queryElapsedMilliseconds=$clock.Elapsed.TotalMilliseconds;fixtureMetadata=$true}
    }finally{$candidate.Dispose()}
}
