using System;
using System.ComponentModel;
using System.Collections.Generic;
using System.Diagnostics;
using System.Management;
using System.IO;
using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
public sealed class InstallerMetadata {
    public string CommandLine, ExecutablePath, Failure;
    public string FailureStage;
    public int? ManagementErrorCode;
    public int RequestedProcessId;
    public object ProcessId;
    public string Handle, ObjectPath, ClassName;
    public int ParentProcessId;
    public double ElapsedMilliseconds;
}
public sealed class InstallerImageSeal {
    public long Bytes;
    public string Sha256, Failure;
}
public sealed class InstallerJobScope {
    public uint LimitFlags, ActiveProcessLimit, CpuFlags, CpuRate;
    public ulong JobMemoryBytes;
}
public sealed class InstallerJobPidSnapshot {
    public int AssignedCount, ListedCount;
    public int[] Pids;
}
public static class InstallerJobView {
    // Conditional file verification never blocks native PID polling or opens a process.
    public static Task<InstallerImageSeal> SealAsync(string path, long expectedBytes) {
        return Task.Factory.StartNew(() => {
            var result=new InstallerImageSeal();
            try {
                if(expectedBytes<=0 || expectedBytes>536870912L || (File.GetAttributes(path)&FileAttributes.ReparsePoint)!=0)throw new InvalidOperationException("Invalid bounded image seal input");
                using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read,65536,FileOptions.SequentialScan))
                using(var hash=SHA256.Create()) {
                    if(file.Length!=expectedBytes)throw new InvalidOperationException("Image seal size differs");
                    var buffer=new byte[65536];int read;
                    while((read=file.Read(buffer,0,buffer.Length))!=0){result.Bytes+=read;if(result.Bytes>expectedBytes)throw new InvalidOperationException("Image seal read exceeds expected size");hash.TransformBlock(buffer,0,read,buffer,0);}
                    if(result.Bytes!=expectedBytes)throw new InvalidOperationException("Image seal read size differs");hash.TransformFinalBlock(new byte[0],0,0);result.Sha256=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
                }
            }catch(Exception error){result.Failure=error.ToString();}
            return result;
        });
    }
    // Pure capture used by the single query catch; classifications never parse exception text.
    public static void CaptureMetadataFailure(InstallerMetadata result, Exception error, string stage) {
        result.Failure=error.ToString();result.FailureStage=stage;var management=error as ManagementException;if(management!=null)result.ManagementErrorCode=(int)management.ErrorCode;
    }
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
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr process,uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder text, ref uint length);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Hold(int pid) {return OpenProcess(0x1000 | 0x100000, false, pid);}
    public static string Image(IntPtr handle) {
        var text=new StringBuilder(32768);uint length=(uint)text.Capacity;
        if(!QueryFullProcessImageName(handle,0,text,ref length)) throw new Win32Exception(Marshal.GetLastWin32Error());
        return text.ToString();
    }
    public static long ExitCode(IntPtr handle) {uint code;if(!GetExitCodeProcess(handle,out code)) throw new Win32Exception(Marshal.GetLastWin32Error());return code;}
    public static bool Signaled(IntPtr handle) {uint state=WaitForSingleObject(handle,0);if(state==258)return false;if(state==0)return true;throw new Win32Exception(Marshal.GetLastWin32Error());}
    public static void Release(IntPtr handle) {if(handle!=IntPtr.Zero) CloseHandle(handle);}
    public static InstallerJobScope ReadScope() {
        IntPtr limits=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(ExtendedLimits)));
        IntPtr cpu=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(CpuLimits)));
        try {
            if(!QueryInformationJobObject(IntPtr.Zero,9,limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(!QueryInformationJobObject(IntPtr.Zero,15,cpu,(uint)Marshal.SizeOf(typeof(CpuLimits)),IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var extended=(ExtendedLimits)Marshal.PtrToStructure(limits,typeof(ExtendedLimits));
            var rate=(CpuLimits)Marshal.PtrToStructure(cpu,typeof(CpuLimits));
            var scope=new InstallerJobScope {LimitFlags=extended.Basic.Flags,ActiveProcessLimit=extended.Basic.ActiveProcessLimit,JobMemoryBytes=extended.JobMemory.ToUInt64(),CpuFlags=rate.Flags,CpuRate=rate.Rate};
            return scope;
        }finally{Marshal.FreeHGlobal(limits);Marshal.FreeHGlobal(cpu);}
    }
    public static InstallerJobScope AuthoritativeScope() {
            var scope=ReadScope();
            // Reject libuv's immediate breakaway Job or any unexpected containing scope.
            if(scope.LimitFlags!=0x2208 || (scope.LimitFlags & (0x800 | 0x1000))!=0 || scope.ActiveProcessLimit!=16 || scope.JobMemoryBytes!=2147483648UL || scope.CpuFlags!=5 || scope.CpuRate!=2500)
                throw new InvalidOperationException(String.Format("Observer immediate Job does not match the authoritative nonbreakaway watchdog limits: flags=0x{0:x}, processes={1}, memory={2}, cpuFlags={3}, cpuRate={4}",scope.LimitFlags,scope.ActiveProcessLimit,scope.JobMemoryBytes,scope.CpuFlags,scope.CpuRate));
            return scope;
    }
    public static Task<InstallerMetadata> QueryAsync(int pid) {
        return Task.Factory.StartNew(() => {
            var result=new InstallerMetadata {RequestedProcessId=pid};var clock=Stopwatch.StartNew();
            bool acquired=MetadataSlots.Wait(3000);string stage="queue";
            try {
                if(!acquired) throw new TimeoutException("Metadata worker queue exceeded three seconds");
                stage="construct";
                using(var process=new ManagementObject("Win32_Process.Handle='"+pid+"'")) {
                    process.Options.Timeout=TimeSpan.FromSeconds(3);
                    stage="get";
                    process.Get();
                    stage="returned-fields";
                    // Raw keys from this same returned instance; no second query or image fallback.
                    result.ProcessId=process["ProcessId"];
                    result.Handle=(string)process["Handle"];
                    result.ObjectPath=(string)process.SystemProperties["__RELPATH"].Value;
                    result.ClassName=(string)process.SystemProperties["__CLASS"].Value;
                    result.CommandLine=(string)process["CommandLine"];
                    result.ExecutablePath=(string)process["ExecutablePath"];
                    result.ParentProcessId=Convert.ToInt32(process["ParentProcessId"]);
                }
            }catch(Exception error){CaptureMetadataFailure(result,error,stage);}
            finally {if(acquired) MetadataSlots.Release();result.ElapsedMilliseconds=clock.Elapsed.TotalMilliseconds;}
            return result;
        });
    }
    public static InstallerJobPidSnapshot ReadPids() {
        bool found;
        if(!IsProcessInJob(new IntPtr(-1), IntPtr.Zero, out found)) throw new Win32Exception(Marshal.GetLastWin32Error());
        if(!found) throw new InvalidOperationException("Observer is outside the required Job");
        int size=8+16*IntPtr.Size;
        IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            if(!QueryInformationJobObject(IntPtr.Zero,3,buffer,(uint)size,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int assigned=Marshal.ReadInt32(buffer,0), count=Marshal.ReadInt32(buffer,4);
            var pids=new List<int>();
            // Retain raw counts without reading beyond the fixed sixteen-entry buffer.
            if(count>=0 && count<=16) for(int i=0;i<count;i++) pids.Add(checked((int)(IntPtr.Size==8 ? Marshal.ReadInt64(buffer,8+i*8) : Marshal.ReadInt32(buffer,8+i*4))));
            return new InstallerJobPidSnapshot {AssignedCount=assigned,ListedCount=count,Pids=pids.ToArray()};
        } finally {Marshal.FreeHGlobal(buffer);}
    }
    public static int[] ValidatePids(InstallerJobPidSnapshot snapshot) {
        if(snapshot.ListedCount<1 || snapshot.ListedCount>16 || snapshot.AssignedCount!=snapshot.ListedCount)
            throw new InvalidOperationException("Incomplete or unexpected Job PID count: assigned="+snapshot.AssignedCount+", listed="+snapshot.ListedCount);
        return snapshot.Pids;
    }
    public static int[] Pids() {return ValidatePids(ReadPids());}
}
