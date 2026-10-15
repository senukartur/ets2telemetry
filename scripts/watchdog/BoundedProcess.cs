using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

namespace ETS2Telemetry.Diagnostics {
  // This helper never launches anything on load. Run is called only by the explicit launcher or Node fixture tests.
  public static class BoundedProcess {
    [StructLayout(LayoutKind.Sequential)] struct Limits {
      public long PerProcessTime, PerJobTime; public uint Flags;
      public UIntPtr MinimumWorkingSet, MaximumWorkingSet; public uint ActiveProcessLimit;
      public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct Io {public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
      public Limits Basic; public Io Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CpuLimit {public uint Flags, Rate;}
    [StructLayout(LayoutKind.Sequential)] struct Accounting {
      public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
      public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
    }
    [StructLayout(LayoutKind.Sequential)] struct Security {public int Length; public IntPtr Descriptor; public int Inherit;}
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct Startup {
      public int Size; public string Reserved, Desktop, Title;
      public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;
      public ushort Show, ReservedSize; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process, Thread; public uint Pid, Tid;}
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref CpuLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting accounting, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr ps, IntPtr ts, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref Security security, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name, uint access, uint share, ref Security security, uint mode, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetSystemTimes(out long idle, out long kernel, out long user);

    // Optional evidence: cumulative Job CPU time and whole-system busy/idle time, one JSON line per wake.
    // It reads accounting only. A failed query or write ends the series and never cancels containment.
    sealed class CpuSampler : IDisposable {
      readonly IntPtr job; readonly Stopwatch elapsed; StreamWriter writer; long idleStart, busyStart;
      public CpuSampler(IntPtr job, string path, Stopwatch elapsed, uint ratePercent) {
        this.job=job; this.elapsed=elapsed;
        long idle, kernel, user;
        if (!GetSystemTimes(out idle,out kernel,out user)) return;
        idleStart=idle; busyStart=kernel+user-idle; // Kernel time includes idle time.
        try {writer=new StreamWriter(new FileStream(path,FileMode.CreateNew,FileAccess.Write,FileShare.Read),new UTF8Encoding(false));}
        catch (IOException) {return;} catch (UnauthorizedAccessException) {return;}
        // utc and elapsedMs anchor the series to the wall-clock times in application diagnostics.
        Write(String.Format(CultureInfo.InvariantCulture,"{{\"type\":\"start\",\"utc\":\"{0}\",\"elapsedMs\":{1},\"logicalProcessors\":{2},\"jobCpuRatePercent\":{3},\"intervalMs\":100}}",
          DateTime.UtcNow.ToString("o",CultureInfo.InvariantCulture),elapsed.ElapsedMilliseconds,Environment.ProcessorCount,ratePercent));
      }
      public void Sample() {
        if (writer==null) return;
        Accounting value; long idle, kernel, user;
        if (!QueryInformationJobObject(job,1,out value,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero) || !GetSystemTimes(out idle,out kernel,out user)) {Dispose(); return;}
        // Times are 100 ns units. System busy/idle are summed over all logical processors since the first line.
        Write(String.Format(CultureInfo.InvariantCulture,"{{\"elapsedMs\":{0},\"jobCpuMs\":{1:0.0},\"activeProcesses\":{2},\"systemBusyMs\":{3:0.0},\"systemIdleMs\":{4:0.0}}}",
          elapsed.ElapsedMilliseconds,(value.UserTime+value.KernelTime)/10000.0,value.ActiveProcesses,(kernel+user-idle-busyStart)/10000.0,(idle-idleStart)/10000.0));
      }
      void Write(string line) {
        try {writer.WriteLine(line); writer.Flush();}
        catch (IOException) {Dispose();} catch (UnauthorizedAccessException) {Dispose();}
      }
      public void Dispose() {
        var current=writer; writer=null;
        if (current!=null) try {current.Dispose();} catch (IOException) { /* A failed diagnostic disk does not affect containment. */ }
      }
    }

    static void Check(bool ok) {if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error());}
    static void Close(ref IntPtr handle) {if (handle != IntPtr.Zero && handle != new IntPtr(-1)) CloseHandle(handle); handle=IntPtr.Zero;}
    public static string Quote(string value) {
      var result = new StringBuilder("\""); int slashes=0;
      foreach (char c in value) {
        if (c=='\\') {slashes++; continue;}
        if (c=='"') {result.Append('\\', slashes*2+1); result.Append(c);}
        else {result.Append('\\', slashes); result.Append(c);}
        slashes=0;
      }
      result.Append('\\', slashes*2); return result.Append('"').ToString();
    }
    static Thread Drain(IntPtr handle, string filename) {
      var thread = new Thread(() => {
        try {
          using (var input = new FileStream(new SafeFileHandle(handle, true), FileAccess.Read))
          using (var output = new FileStream(filename, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
            var buffer=new byte[8192]; int count, retained=0;
            while ((count=input.Read(buffer,0,buffer.Length))>0) {
              int keep=Math.Min(count, 1024*1024-retained);
              if (keep>0) {output.Write(buffer,0,keep); output.Flush(); retained+=keep;}
            }
          }
        } catch (IOException) { /* Closed pipe or failed diagnostic disk; process deadline still applies. */ }
        catch (UnauthorizedAccessException) { /* File permissions do not cancel containment. */ }
      });
      thread.IsBackground=true; thread.Start(); return thread;
    }
    static uint Active(IntPtr job) {
      Accounting value; Check(QueryInformationJobObject(job, 1, out value, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
      return value.ActiveProcesses;
    }
    public static int Run(string executable, string[] args, string cwd, string output, int timeoutMs) {
      return Run(executable, args, cwd, output, timeoutMs, false);
    }
    // sampleCpu adds output/cpu.jsonl; limits, deadlines and cleanup are identical either way.
    public static int Run(string executable, string[] args, string cwd, string output, int timeoutMs, bool sampleCpu) {
      if (timeoutMs<100 || timeoutMs>60000) throw new ArgumentOutOfRangeException("timeoutMs");
      if (!Path.IsPathRooted(executable) || !Path.IsPathRooted(cwd) || !Path.IsPathRooted(output)) throw new ArgumentException("Absolute paths required");
      Directory.CreateDirectory(output);
      IntPtr job=IntPtr.Zero, stdoutRead=IntPtr.Zero, stdoutWrite=IntPtr.Zero, stderrRead=IntPtr.Zero, stderrWrite=IntPtr.Zero, input=IntPtr.Zero;
      ProcessInfo process=new ProcessInfo(); Thread stdout=null, stderr=null; CpuSampler sampler=null;
      try {
        job=CreateJobObject(IntPtr.Zero,null); Check(job!=IntPtr.Zero);
        var limits=new ExtendedLimits();
        limits.Basic.Flags=0x2000 | 0x8 | 0x200; // Kill on close, 16 processes, 2 GiB committed memory for the job.
        limits.Basic.ActiveProcessLimit=16; limits.JobMemory=new UIntPtr(2147483648UL);
        Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimits))));
        var cpu=new CpuLimit {Flags=0x1 | 0x4, Rate=2500}; // Hard cap at 25% of system CPU.
        Check(SetInformationJobObject(job,15,ref cpu,(uint)Marshal.SizeOf(typeof(CpuLimit))));
        var security=new Security {Length=Marshal.SizeOf(typeof(Security)), Inherit=1};
        Check(CreatePipe(out stdoutRead,out stdoutWrite,ref security,0));
        Check(CreatePipe(out stderrRead,out stderrWrite,ref security,0));
        Check(SetHandleInformation(stdoutRead,1,0)); Check(SetHandleInformation(stderrRead,1,0));
        input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero); Check(input!=new IntPtr(-1));
        var startup=new Startup {Size=Marshal.SizeOf(typeof(Startup)),Flags=0x100 | 1,Show=0,Input=input,Output=stdoutWrite,Error=stderrWrite};
        var command=new StringBuilder(Quote(executable));
        foreach (string arg in args) command.Append(' ').Append(Quote(arg));
        // No application instruction runs until containment succeeds. No breakaway flags are allowed.
        Check(CreateProcess(executable,command,IntPtr.Zero,IntPtr.Zero,true,0x4 | 0x08000000,IntPtr.Zero,cwd,ref startup,out process));
        Check(AssignProcessToJobObject(job,process.Process));
        File.WriteAllText(Path.Combine(output,"owned-pid.txt"),process.Pid.ToString());
        Close(ref stdoutWrite); Close(ref stderrWrite); Close(ref input);
        stdout=Drain(stdoutRead,Path.Combine(output,"stdout.log")); stdoutRead=IntPtr.Zero;
        stderr=Drain(stderrRead,Path.Combine(output,"stderr.log")); stderrRead=IntPtr.Zero;
        Check(ResumeThread(process.Thread)!=UInt32.MaxValue);
        var elapsed=Stopwatch.StartNew();
        if (sampleCpu) {sampler=new CpuSampler(job,Path.Combine(output,"cpu.jsonl"),elapsed,cpu.Rate/100); sampler.Sample();}
        uint wait;
        do {wait=WaitForSingleObject(process.Process,100); if (wait==UInt32.MaxValue) Check(false); if (sampler!=null) sampler.Sample();}
        while (wait==258 && elapsed.ElapsedMilliseconds<timeoutMs);
        if (wait==258) {Check(TerminateJobObject(job,124)); return 124;}
        uint code; Check(GetExitCodeProcess(process.Process,out code));
        // Root exit must not leave orphaned service/renderer processes behind.
        for (int i=0;i<10 && Active(job)>0;i++) {Thread.Sleep(100); if (sampler!=null) sampler.Sample();}
        if (Active(job)>0) {Check(TerminateJobObject(job,125)); return 125;}
        return unchecked((int)code);
      } finally {
        // Fail closed, including assignment/resume failures. Only held handles identify processes.
        if (sampler!=null) sampler.Dispose();
        if (process.Process!=IntPtr.Zero && WaitForSingleObject(process.Process,0)==258) TerminateProcess(process.Process,126);
        if (job!=IntPtr.Zero) TerminateJobObject(job,126);
        Close(ref job);
        if (process.Process!=IntPtr.Zero) WaitForSingleObject(process.Process,2000);
        Close(ref process.Thread); Close(ref process.Process);
        Close(ref stdoutRead); Close(ref stdoutWrite); Close(ref stderrRead); Close(ref stderrWrite); Close(ref input);
        if (stdout!=null) stdout.Join(1000); if (stderr!=null) stderr.Join(1000);
      }
    }
  }
}
