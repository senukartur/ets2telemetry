# Read-only observer, itself a child of the contained Node driver. Never creates/kills a process.
[CmdletBinding()]
param([Parameter(Mandatory)][int]$DriverPid, [Parameter(Mandatory)][string]$StopFile, [Parameter(Mandatory)][string]$ResultFile)
$ErrorActionPreference='Stop'
if($env:ETS2TELEMETRY_VM_JOB -ne '1'){throw 'Contained guest driver required.'}
Add-Type -AssemblyName System.Management
Add-Type -ReferencedAssemblies System.dll,System.Management.dll,System.Core.dll @'
using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class InstallerMetadata {
    public string CommandLine, ExecutablePath, Failure;
    public double ElapsedMilliseconds;
}
public sealed class InstallerJobScope {
    public uint LimitFlags, ActiveProcessLimit, CpuFlags, CpuRate;
    public ulong JobMemoryBytes;
}
public static class InstallerJobView {
    // Metadata workers never block native PID/handle polling. Four queries maximum.
    static readonly SemaphoreSlim MetadataSlots = new SemaphoreSlim(4,4);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long PerProcessTime, PerJobTime;public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;public uint ActiveProcessLimit;
        public UIntPtr Affinity;public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CpuLimits {public uint Flags,Rate;}
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool found);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder text, ref uint length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Hold(int pid) {return OpenProcess(0x1000 | 0x100000, false, pid);}
    public static string Image(IntPtr handle) {
        var text=new StringBuilder(32768);uint length=(uint)text.Capacity;
        if(!QueryFullProcessImageName(handle,0,text,ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return text.ToString();
    }
    public static long ExitCode(IntPtr handle) {uint code;if(!GetExitCodeProcess(handle,out code)) throw new Win32Exception(Marshal.GetLastWin32Error());return code;}
    public static void Release(IntPtr handle) {if(handle!=IntPtr.Zero) CloseHandle(handle);}
    public static InstallerJobScope AuthoritativeScope() {
        IntPtr limits=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimits)));
        IntPtr cpu=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CpuLimits)));
        try {
            if(!QueryInformationJobObject(IntPtr.Zero,9,limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(!QueryInformationJobObject(IntPtr.Zero,15,cpu,(uint)Marshal.SizeOf(typeof(CpuLimits)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var extended=(ExtendedLimits)Marshal.PtrToStructure(limits,typeof(ExtendedLimits));
            var rate=(CpuLimits)Marshal.PtrToStructure(cpu,typeof(CpuLimits));
            var scope=new InstallerJobScope {LimitFlags=extended.Basic.Flags,ActiveProcessLimit=extended.Basic.ActiveProcessLimit,JobMemoryBytes=extended.JobMemory.ToUInt64(),CpuFlags=rate.Flags,CpuRate=rate.Rate};
            // Reject libuv's immediate breakaway Job or any unexpected containing scope.
            if(scope.LimitFlags!=0x2208 || (scope.LimitFlags & (0x800 | 0x1000))!=0 || scope.ActiveProcessLimit!=16 || scope.JobMemoryBytes!=2147483648UL || scope.CpuFlags!=5 || scope.CpuRate!=2500)
                throw new InvalidOperationException(String.Format("Observer immediate Job does not match the authoritative nonbreakaway watchdog limits: flags=0x{0:x}, processes={1}, memory={2}, cpuFlags={3}, cpuRate={4}",scope.LimitFlags,scope.ActiveProcessLimit,scope.JobMemoryBytes,scope.CpuFlags,scope.CpuRate));
            return scope;
        }finally{Marshal.FreeHGlobal(limits);Marshal.FreeHGlobal(cpu);}
    }
    public static Task<InstallerMetadata> QueryAsync(int pid) {
        return Task.Factory.StartNew(() => {
            var result=new InstallerMetadata();var clock=Stopwatch.StartNew();
            bool acquired=MetadataSlots.Wait(3000);
            try {
                if(!acquired) throw new TimeoutException("Metadata worker queue exceeded three seconds");
                using(var process=new ManagementObject("Win32_Process.Handle='"+pid+"'")) {
                    process.Options.Timeout=TimeSpan.FromSeconds(3);
                    process.Get();
                    result.CommandLine=(string)process["CommandLine"];
                    result.ExecutablePath=(string)process["ExecutablePath"];
                }
            }catch(Exception error){result.Failure=error.ToString();}
            finally {if(acquired) MetadataSlots.Release();result.ElapsedMilliseconds=clock.Elapsed.TotalMilliseconds;}
            return result;
        });
    }
    public static int[] Pids() {
        bool found;
        if(!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out found)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!found) throw new InvalidOperationException("Observer is outside the required Job");
        int size=8+16*IntPtr.Size;
        IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            if(!QueryInformationJobObject(IntPtr.Zero,3,buffer,(uint)size,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int assigned=Marshal.ReadInt32(buffer,0), count=Marshal.ReadInt32(buffer,4);
            if(count<1 || count>16 || assigned!=count) throw new InvalidOperationException("Incomplete or unexpected Job PID count");
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
$queries=@{}
$view=[ordered]@{passed=$false;observerPid=$PID;driverPid=$DriverPid;startedUtc=[datetime]::UtcNow.ToString('o');finishedUtc=$null;failure=$null;drained=$false;finalPids=@();processes=@();jobScope=$null;metadataWorkers=4;metadataQueueSeconds=3;metadataQuerySeconds=3;metadataCompletionSeconds=8;warmupMilliseconds=$null;pollCount=0;maximumPollGapMilliseconds=0}
try {
    $initial=[InstallerJobView]::Pids()
    if($initial -notcontains $DriverPid -or $initial -notcontains $PID -or $initial.Count -ne 2){throw 'Observer must start in a fresh Job containing only itself and its driver.'}
    $view.jobScope=[InstallerJobView]::AuthoritativeScope()
    # Warm WMI before Setup starts; a cold provider cannot consume the hook interval.
    $warmup=[InstallerJobView]::QueryAsync($PID)
    if(!$warmup.Wait(5000)){throw 'Read-only metadata provider warmup exceeded five seconds.'}
    if($warmup.Result.Failure -or !$warmup.Result.CommandLine){throw 'Read-only metadata provider warmup failed.'}
    $view.warmupMilliseconds=$warmup.Result.ElapsedMilliseconds
    [ordered]@{ready=$true;observerPid=$PID;driverPid=$DriverPid;initialPids=$initial;jobScope=$view.jobScope;warmupMilliseconds=$view.warmupMilliseconds}|ConvertTo-Json -Depth 4 -Compress|Write-Output
    $deadline=[datetime]::UtcNow.AddSeconds(55)
    $pollClock=[Diagnostics.Stopwatch]::StartNew();$previousPoll=0
    do {
        $now=$pollClock.Elapsed.TotalMilliseconds
        $view.maximumPollGapMilliseconds=[math]::Max($view.maximumPollGapMilliseconds,$now-$previousPoll);$previousPoll=$now;$view.pollCount++
        $pids=[InstallerJobView]::Pids()
        if($pids -notcontains $DriverPid -or $pids -notcontains $PID){throw 'Job identity lost.'}
        foreach($ownedPid in $pids){
            if($ownedPid -eq $PID -or $ownedPid -eq $DriverPid -or !$seen.Add($ownedPid)){continue}
            if($records.Count -ge 64){throw 'Owned process observation lifetime bound exceeded.'}
            $record=[ordered]@{pid=$ownedPid;observedUtc=[datetime]::UtcNow.ToString('o');commandLine=$null;executablePath=$null;queryFailure=$null;queryElapsedMilliseconds=$null;queryStartedMilliseconds=$pollClock.Elapsed.TotalMilliseconds;exitCode=$null;exitQueryFailure=$null}
            # Capture native identity/handles immediately, before asynchronous metadata.
            $handle=[InstallerJobView]::Hold($ownedPid)
            if($handle -ne [IntPtr]::Zero){
                $handles.Add($ownedPid,$handle)
                try{$record.executablePath=[InstallerJobView]::Image($handle)}catch{$record.queryFailure=$_.Exception.Message}
                if($queries.Count -ge 16){throw 'Pending metadata query bound exceeded.'}
                $queries[$ownedPid]=[InstallerJobView]::QueryAsync($ownedPid)
            }else{$record.exitQueryFailure='Owned process exited before a read-only handle could be opened.'}
            $records.Add($record)
        }
        foreach($record in $records){
            if($queries.ContainsKey($record.pid)){
                $query=$queries[$record.pid]
                if($query.IsCompleted){
                    $metadata=$query.Result
                    $record.queryElapsedMilliseconds=$metadata.ElapsedMilliseconds
                    if($metadata.Failure){$record.queryFailure=$metadata.Failure}
                    elseif($metadata.ExecutablePath -ne $record.executablePath){$record.queryFailure='Metadata image differs from the held native process identity.'}
                    else{$record.commandLine=$metadata.CommandLine}
                    $queries.Remove($record.pid)
                }elseif($pollClock.Elapsed.TotalMilliseconds-$record.queryStartedMilliseconds -ge 8000){throw 'Read-only metadata query exceeded its eight-second completion deadline.'}
            }
            if(!$handles.ContainsKey($record.pid)){continue}
            try{
                if($null -eq $record.exitCode){$code=[InstallerJobView]::ExitCode($handles[$record.pid]);if($code -ne 259){$record.exitCode=$code}}
                # Hold identity through metadata completion; an exited PID cannot be reused.
                if($null -ne $record.exitCode -and !$queries.ContainsKey($record.pid)){[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
            }catch{$record.exitQueryFailure=$_.Exception.Message;[InstallerJobView]::Release($handles[$record.pid]);$null=$handles.Remove($record.pid)}
        }
        # Stop is requested only after the primary installer/updater has exited.
        # The PID list includes child jobs. Require natural exit and completed metadata.
        if((Test-Path -LiteralPath $StopFile) -and $pids.Count -eq 2 -and $handles.Count -eq 0 -and $queries.Count -eq 0){$view.drained=$true;$view.finalPids=$pids;break}
        Start-Sleep -Milliseconds 20
    }while([datetime]::UtcNow -lt $deadline)
    if(!$view.drained){throw 'Installer descendants did not drain within the observer deadline.'}
    $view.passed=$true
}catch{$view.failure=$_.Exception.ToString()}
finally{foreach($handle in $handles.Values){[InstallerJobView]::Release($handle)};$view.finishedUtc=[datetime]::UtcNow.ToString('o');$view.processes=$records.ToArray();$view|ConvertTo-Json -Depth 6|Set-Content -LiteralPath $ResultFile -Encoding UTF8}
if(!$view.passed){exit 1}
