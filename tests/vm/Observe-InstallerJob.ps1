# Read-only observer, itself a child of the contained Node driver. Never creates/kills a process.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$DriverPid, [Parameter(Mandatory)][string]$StopFile, [Parameter(Mandatory)][string]$ResultFile)
$ErrorActionPreference='Stop'
if($env:ETS2TELEMETRY_VM_JOB -ne '1'){throw 'Contained guest driver required.'}
Add-Type -AssemblyName System.Management
Add-Type @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class InstallerJobView {
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool found);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Hold(int pid) {return OpenProcess(0x1000 | 0x100000, false, pid);}
    public static long ExitCode(IntPtr handle) {uint code;if(!GetExitCodeProcess(handle,out code)) throw new Win32Exception(Marshal.GetLastWin32Error());return code;}
    public static void Release(IntPtr handle) {if(handle!=IntPtr.Zero) CloseHandle(handle);}
    public static int[] Pids() {
        bool found;
        if(!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out found)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!found) throw new InvalidOperationException("Observer is outside the required Job");
        int size=8+16*IntPtr.Size;
        IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            if(!QueryInformationJobObject(IntPtr.Zero,3,buffer,(uint)size,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int count=Marshal.ReadInt32(buffer,4);
            if(count<1 || count>16) throw new InvalidOperationException("Unexpected Job PID count");
            var pids=new List<int>();
            for(int i=0;i<count;i++) pids.Add(checked((int)(IntPtr.Size==8 ? Marshal.ReadInt64(buffer,8+i*8) : Marshal.ReadInt32(buffer,8+i*4))));
            return pids.ToArray();
        } finally {Marshal.FreeHGlobal(buffer);}
    }
}
'@
$seen=[Collections.Generic.HashSet[int]]::new()
$records=[Collections.Generic.List[object]]::new()
$handles=[Collections.Generic.Dictionary[int,IntPtr]]::new()
$view=[ordered]@{passed=$false;observerPid=$PID;driverPid=$DriverPid;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;failure=$null;drained=$false;finalPids=@();processes=@()}
try {
    $initial=[InstallerJobView]::Pids()
    if($initial -notcontains $DriverPid -or $initial -notcontains $PID -or $initial.Count -ne 2){throw 'Observer must start in a fresh Job containing only itself and its driver.'}
    [ordered]@{ready=$true;observerPid=$PID;driverPid=$DriverPid;initialPids=$initial}|ConvertTo-Json -Compress|Write-Output
    $deadline=[datetime]::UtcNow.AddSeconds(55)
    do {
        $pids=[InstallerJobView]::Pids()
        if($pids -notcontains $DriverPid -or $pids -notcontains $PID){throw 'Job identity lost.'}
        foreach($ownedPid in $pids){
            if($ownedPid -eq $PID -or $ownedPid -eq $DriverPid -or !$seen.Add($ownedPid)){continue}
            $record=[ordered]@{pid=$ownedPid;observedUtc=[datetime]::UtcNow.ToString('o');commandLine=$null;executablePath=$null;queryFailure=$null;exitCode=$null;exitQueryFailure=$null}
            # Held handles preserve process identity and final exit status after a fast hook exits.
            $handle=[InstallerJobView]::Hold($ownedPid)
            if($handle -ne [IntPtr]::Zero){$handles.Add($ownedPid,$handle)}else{$record.exitQueryFailure='Owned process exited before a read-only handle could be opened.'}
            try {
                $process=[Management.ManagementObject]::new("Win32_Process.Handle='$ownedPid'")
                try{$process.Get();$record.commandLine=[string]$process['CommandLine'];$record.executablePath=[string]$process['ExecutablePath']}finally{$process.Dispose()}
            } catch {$record.queryFailure=$_.Exception.Message}
            $records.Add($record)
        }
        foreach($record in $records){
            if(!$handles.ContainsKey($record.pid)){continue}
            try{
                $code=[InstallerJobView]::ExitCode($handles[$record.pid])
                if($code -ne 259){$record.exitCode=$code;[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
            }catch{$record.exitQueryFailure=$_.Exception.Message;[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
        }
        # Stop is requested only after the primary installer/updater has exited.
        # Two live Job PIDs mean Node plus this observer; helper descendants drained naturally.
        if((Test-Path -LiteralPath $StopFile) -and $pids.Count -eq 2 -and $handles.Count -eq 0){$view.drained=$true;$view.finalPids=$pids;break}
        Start-Sleep -Milliseconds 20
    }while([datetime]::UtcNow -lt $deadline)
    if(!$view.drained){throw 'Installer descendants did not drain within the observer deadline.'}
    $view.passed=$true
}catch{$view.failure=$_.Exception.ToString()}
finally{foreach($handle in $handles.Values){[InstallerJobView]::Release($handle)};$view.finishedUtc=[datetime]::UtcNow.ToString('o');$view.processes=$records.ToArray();$view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ResultFile -Encoding UTF8}
if(!$view.passed){exit 1}
