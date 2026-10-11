// Test-only two-root controller. Production watchdog source remains unchanged.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

namespace ETS2Telemetry.Diagnostics {
  public static class InstallerBoundedProcess {
    [StructLayout(LayoutKind.Sequential)] struct Limits {public long ProcessTime,JobTime;public uint Flags;public UIntPtr MinWorking,MaxWorking;public uint Processes;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct Io {public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes;}
    [StructLayout(LayoutKind.Sequential)] struct Extended {public Limits Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcess,PeakJob;}
    [StructLayout(LayoutKind.Sequential)] struct Cpu {public uint Flags,Rate;}
    [StructLayout(LayoutKind.Sequential)] struct Accounting {public long User,Kernel,PeriodUser,PeriodKernel;public uint Faults,Total,Active,Terminated;}
    [StructLayout(LayoutKind.Sequential)] struct Security {public int Size;public IntPtr Descriptor;public int Inherit;}
    [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup {public int Size;public string Reserved,Desktop,Title;public uint X,Y,Width,Height,CharsX,CharsY,Fill,Flags;public ushort Show,ReservedSize;public IntPtr ReservedData,Input,Output,Error;}
    [StructLayout(LayoutKind.Sequential)] struct StartupEx {public Startup Startup;public IntPtr Attributes;}
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {public IntPtr Process,Thread;public uint Pid,Tid;}
    sealed class Child {public ProcessInfo Info;public IntPtr OutRead,OutWrite,ErrRead,ErrWrite,Input;public Thread OutThread,ErrThread;public string DrainFailure;public uint? Code;}
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr security,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Extended value,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int type,ref Cpu value,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,out Accounting value,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int type,IntPtr value,uint size,IntPtr returned);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll",SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint milliseconds);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list,int count,uint flags,ref IntPtr bytes);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list,uint flags,IntPtr attribute,IntPtr value,IntPtr bytes,IntPtr previous,IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr ps,IntPtr ts,bool inherit,uint flags,IntPtr env,string cwd,ref StartupEx startup,out ProcessInfo info);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool CreatePipe(out IntPtr read,out IntPtr write,ref Security security,uint size);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle,uint mask,uint flags);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint mode,uint flags,IntPtr template);
    static void Check(bool value){if(!value)throw new Win32Exception(Marshal.GetLastWin32Error());}
    static void Close(ref IntPtr handle){if(handle!=IntPtr.Zero&&handle!=new IntPtr(-1))CloseHandle(handle);handle=IntPtr.Zero;}
    static string Quote(string value){var b=new StringBuilder("\"");int n=0;foreach(char c in value){if(c=='\\'){n++;continue;}b.Append('\\',c=='"'?n*2+1:n);b.Append(c);n=0;}b.Append('\\',n*2);return b.Append('"').ToString();}
    static void Json(string file,object value){string temporary=file+".partial";File.WriteAllText(temporary,new JavaScriptSerializer().Serialize(value)+"\n",new UTF8Encoding(false));File.Move(temporary,file);}
    static uint Active(IntPtr job){Accounting a;Check(QueryInformationJobObject(job,1,out a,(uint)Marshal.SizeOf(typeof(Accounting)),IntPtr.Zero));return a.Active;}
    static object PidSnapshot(IntPtr job){
      IntPtr buffer=IntPtr.Zero;
      try{
        int size=8+16*IntPtr.Size;buffer=Marshal.AllocHGlobal(size);
        Check(QueryInformationJobObject(job,3,buffer,(uint)size,IntPtr.Zero));
        int assigned=Marshal.ReadInt32(buffer,0),listed=Marshal.ReadInt32(buffer,4);var pids=new List<long>();
        if(listed>=0&&listed<=16)for(int i=0;i<listed;i++)pids.Add(IntPtr.Size==8?Marshal.ReadInt64(buffer,8+i*8):Marshal.ReadInt32(buffer,8+i*4));
        return new{assignedCount=assigned,listedCount=listed,pids=pids.ToArray(),utc=DateTime.UtcNow.ToString("o"),failure=(string)null};
      }catch(Exception error){return new{failure=error.ToString(),utc=DateTime.UtcNow.ToString("o")};}
      finally{if(buffer!=IntPtr.Zero)Marshal.FreeHGlobal(buffer);}
    }
    static Thread Drain(IntPtr handle,string file,Child child){var t=new Thread(()=>{try{using(var input=new FileStream(new SafeFileHandle(handle,true),FileAccess.Read))using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.Read)){var buffer=new byte[8192];int n,kept=0;while((n=input.Read(buffer,0,buffer.Length))>0){int keep=Math.Min(n,1048576-kept);if(keep>0){output.Write(buffer,0,keep);output.Flush();kept+=keep;}}}}catch(Exception error){child.DrainFailure=error.ToString();}});t.IsBackground=true;t.Start();return t;}
    static void Spawn(Child child,IntPtr job,string exe,string[] args,string cwd,string output,string name){
      var security=new Security{Size=Marshal.SizeOf(typeof(Security)),Inherit=1};
      Check(CreatePipe(out child.OutRead,out child.OutWrite,ref security,0));Check(CreatePipe(out child.ErrRead,out child.ErrWrite,ref security,0));
      Check(SetHandleInformation(child.OutRead,1,0));Check(SetHandleInformation(child.ErrRead,1,0));
      child.Input=CreateFile("NUL",0x80000000,3,ref security,3,0,IntPtr.Zero);Check(child.Input!=new IntPtr(-1));
      IntPtr size=IntPtr.Zero,list=IntPtr.Zero,jobs=IntPtr.Zero,handles=IntPtr.Zero;bool initialized=false;
      try{
        InitializeProcThreadAttributeList(IntPtr.Zero,2,0,ref size);if(size==IntPtr.Zero)throw new Win32Exception(Marshal.GetLastWin32Error());
        list=Marshal.AllocHGlobal(size);Check(InitializeProcThreadAttributeList(list,2,0,ref size));initialized=true;
        jobs=Marshal.AllocHGlobal(IntPtr.Size);Marshal.WriteIntPtr(jobs,job);
        handles=Marshal.AllocHGlobal(3*IntPtr.Size);Marshal.WriteIntPtr(handles,0,child.Input);Marshal.WriteIntPtr(handles,IntPtr.Size,child.OutWrite);Marshal.WriteIntPtr(handles,2*IntPtr.Size,child.ErrWrite);
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x0002000D),jobs,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        Check(UpdateProcThreadAttribute(list,0,new IntPtr(0x00020002),handles,new IntPtr(3*IntPtr.Size),IntPtr.Zero,IntPtr.Zero));
        var startup=new StartupEx{Startup=new Startup{Size=Marshal.SizeOf(typeof(StartupEx)),Flags=0x100|1,Show=0,Input=child.Input,Output=child.OutWrite,Error=child.ErrWrite},Attributes=list};
        var command=new StringBuilder(Quote(exe));foreach(string arg in args)command.Append(' ').Append(Quote(arg));
        // Atomic Job assignment removes the unassigned suspended-child owner-death gap.
        Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x4|0x08000000|0x00080000,IntPtr.Zero,cwd,ref startup,out child.Info));
      }finally{if(initialized)DeleteProcThreadAttributeList(list);if(list!=IntPtr.Zero)Marshal.FreeHGlobal(list);if(jobs!=IntPtr.Zero)Marshal.FreeHGlobal(jobs);if(handles!=IntPtr.Zero)Marshal.FreeHGlobal(handles);}
      Close(ref child.OutWrite);Close(ref child.ErrWrite);Close(ref child.Input);
      child.OutThread=Drain(child.OutRead,Path.Combine(output,name+"-stdout.log"),child);child.OutRead=IntPtr.Zero;
      child.ErrThread=Drain(child.ErrRead,Path.Combine(output,name+"-stderr.log"),child);child.ErrRead=IntPtr.Zero;
    }
    static bool Exited(Child child){if(child.Code.HasValue)return true;uint wait=WaitForSingleObject(child.Info.Process,0);if(wait==UInt32.MaxValue)Check(false);if(wait==258)return false;uint code;Check(GetExitCodeProcess(child.Info.Process,out code));child.Code=code;return true;}
    static bool Dispose(Child child,Stopwatch clock,int budget){Close(ref child.Info.Thread);Close(ref child.Info.Process);Close(ref child.OutRead);Close(ref child.OutWrite);Close(ref child.ErrRead);Close(ref child.ErrWrite);Close(ref child.Input);bool drained=true;foreach(var thread in new[]{child.OutThread,child.ErrThread})if(thread!=null&&!thread.Join(Math.Max(0,budget-(int)clock.ElapsedMilliseconds)))drained=false;return drained;}
    static void Deadline(Stopwatch clock,int budget){if(clock.ElapsedMilliseconds>=budget-750)throw new TimeoutException("Monotonic execution deadline exhausted before start/resume");}
    public static int Run(string node,string[] args,string observerScript,string cwd,string output,int timeoutMs){
      if(timeoutMs<1500||timeoutMs>60000||!Environment.Is64BitProcess)throw new ArgumentException("Bounded Windows x64 invocation required");
      foreach(string value in new[]{node,observerScript,cwd,output})if(!Path.IsPathRooted(value))throw new ArgumentException("Absolute paths required");
      if(Path.GetFileName(node)!="node.exe")throw new ArgumentException("Portable Node root required");
      Directory.CreateDirectory(output);var clock=Stopwatch.StartNew();IntPtr job=IntPtr.Zero;var driver=new Child();var observer=new Child();int code=126;string failure=null;object initialJobSnapshot=null,failureJobSnapshot=null;
      string proof=Directory.GetParent(output).FullName,ready=Path.Combine(proof,"observer-ready.json"),exit=Path.Combine(output,"observer-exit.json");
      try{
        if(File.Exists(ready)||File.Exists(exit))throw new InvalidOperationException("Fresh readiness/exit proof required");
        job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
        var limits=new Extended{Basic=new Limits{Flags=0x2208,Processes=16},JobMemory=new UIntPtr(2147483648UL)};Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
        var cpu=new Cpu{Flags=5,Rate=2500};Check(SetInformationJobObject(job,15,ref cpu,(uint)Marshal.SizeOf(typeof(Cpu))));
        Deadline(clock,timeoutMs);Spawn(driver,job,node,args,cwd,output,"driver");
        int owner=Process.GetCurrentProcess().Id;
        Deadline(clock,timeoutMs);Spawn(observer,job,@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",new[]{"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",observerScript,"-DriverPid",driver.Info.Pid.ToString(),"-ControllerPid",owner.ToString(),"-StopFile",Path.Combine(proof,"observer-stop.json"),"-ResultFile",Path.Combine(proof,"job-observation.json"),"-ReadyFile",ready},cwd,output,"observer");
        if(Active(job)!=2)throw new InvalidOperationException("Expected exactly two suspended assigned roots");
        initialJobSnapshot=PidSnapshot(job);
        Json(Path.Combine(output,"controller-receipt.json"),new{controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,observerScript=observerScript,nodeExecutable=node,atomicJobAssignment=true,jobHandleInherited=false,initialJobSnapshot=initialJobSnapshot,limitFlags=0x2208,processLimit=16,jobMemoryBytes=2147483648L,cpuFlags=5,cpuRate=2500,startedUtc=DateTime.UtcNow.ToString("o")});
        File.WriteAllText(Path.Combine(output,"owned-pid.txt"),driver.Info.Pid.ToString());
        Deadline(clock,timeoutMs);Check(ResumeThread(observer.Info.Thread)!=UInt32.MaxValue);
        while(!File.Exists(ready)){
          if(Exited(observer))throw new InvalidOperationException("Observer exited before readiness: "+observer.Code);
          if(clock.ElapsedMilliseconds>=Math.Min(12000,timeoutMs-750)){code=124;throw new TimeoutException("Readiness deadline");}Thread.Sleep(10);
        }
        if(Exited(observer))throw new InvalidOperationException("Observer was already exited at readiness");
        Deadline(clock,timeoutMs);Check(ResumeThread(driver.Info.Thread)!=UInt32.MaxValue);
        bool observerReceipt=false;long driverExitedAt=-1;
        while(true){
          if(Exited(observer)&&!observerReceipt){Json(exit,new{controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,exitCode=observer.Code,signaled=true,utc=DateTime.UtcNow.ToString("o")});observerReceipt=true;if(observer.Code!=0)throw new InvalidOperationException("Observer failed: "+observer.Code);}
          if(Exited(driver)){
            if(driverExitedAt<0)driverExitedAt=clock.ElapsedMilliseconds;
            if(Active(job)==0&&observerReceipt&&observer.Code.HasValue){code=unchecked((int)driver.Code.Value);break;}
            if(clock.ElapsedMilliseconds-driverExitedAt>=1000){code=125;throw new InvalidOperationException("Root exited with remaining Job members");}
          }
          if(clock.ElapsedMilliseconds>=timeoutMs-750){code=124;throw new TimeoutException("Single controller deadline");}Thread.Sleep(10);
        }
      }catch(Exception error){failure=error.ToString();if(error is TimeoutException)code=124;if(job!=IntPtr.Zero)failureJobSnapshot=PidSnapshot(job);}
      finally{
        if(job!=IntPtr.Zero){TerminateJobObject(job,(uint)(failure==null?126:code));Close(ref job);}
        foreach(var child in new[]{driver,observer})if(child.Info.Process!=IntPtr.Zero){WaitForSingleObject(child.Info.Process,(uint)Math.Max(0,Math.Min(250,timeoutMs-(int)clock.ElapsedMilliseconds)));try{Exited(child);}catch(Exception error){failure=failure??error.ToString();}}
        bool driverDrain=Dispose(driver,clock,timeoutMs);bool observerDrain=Dispose(observer,clock,timeoutMs);
        if(!driverDrain||!observerDrain||clock.ElapsedMilliseconds>timeoutMs){failure=failure??"Streams did not finish inside the single deadline";if(code==0)code=126;}
        if(driver.DrainFailure!=null||observer.DrainFailure!=null){failure=failure??("Diagnostic drain failure: "+driver.DrainFailure+" "+observer.DrainFailure);if(code==0)code=126;}
        Json(Path.Combine(output,"controller-result.json"),new{passed=failure==null&&code==0&&driver.Code==0&&observer.Code==0&&driverDrain&&observerDrain,code=code,failure=failure,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,driverExitCode=driver.Code,observerExitCode=observer.Code,initialJobSnapshot=initialJobSnapshot,failureJobSnapshot=failureJobSnapshot,driverStreamsDrained=driverDrain,observerStreamsDrained=observerDrain,elapsedMilliseconds=clock.ElapsedMilliseconds,budgetMilliseconds=timeoutMs});
      }
      return code;
    }
  }
}
