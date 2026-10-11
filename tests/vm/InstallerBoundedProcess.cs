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
    sealed class ConsoleCustody {public IntPtr Handle;public int Pid;public string Image;public uint? Code;}
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
    [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool found);
    [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder text,ref uint length);
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
    static long[] JobPids(IntPtr job,bool allowEmpty=false){
      int size=8+16*IntPtr.Size;IntPtr memory=Marshal.AllocHGlobal(size);
      try{Check(QueryInformationJobObject(job,3,memory,(uint)size,IntPtr.Zero));int assigned=Marshal.ReadInt32(memory),listed=Marshal.ReadInt32(memory,4);if(listed<(allowEmpty?0:1)||listed>16||assigned!=listed)throw new InvalidOperationException("Incomplete authoritative PID set");var result=new long[listed];for(int i=0;i<listed;i++)result[i]=Marshal.ReadInt64(memory,8+i*8);return result;}finally{Marshal.FreeHGlobal(memory);}
    }
    static void ExpectedMembers(IntPtr job,uint driver,uint observer,int console){var actual=new HashSet<long>(JobPids(job));var expected=new HashSet<long>{driver,observer};if(console!=0)expected.Add(console);if(!actual.SetEquals(expected))throw new InvalidOperationException("Authoritative Job contains unexpected members at readiness");}
    static void PendingMembers(IntPtr job,uint driver,int lateConsole){var expected=new HashSet<long>{driver};if(lateConsole!=0)expected.Add(lateConsole);if(!new HashSet<long>(JobPids(job)).SetEquals(expected))throw new InvalidOperationException("PS completion contains unaudited remaining members");}
    static byte[] ReadFrameBytes(string file){using(var input=new FileStream(file,FileMode.Open,FileAccess.Read,FileShare.Read|FileShare.Delete)){var bytes=new byte[8193];int kept=0,n;while(kept<bytes.Length&&(n=input.Read(bytes,kept,bytes.Length-kept))>0)kept+=n;if(kept>8192)throw new InvalidOperationException("Ready/late proof exceeds 8 KiB");Array.Resize(ref bytes,kept);return bytes;}}
    static string ReadFrameText(string file){return Encoding.UTF8.GetString(ReadFrameBytes(file)).TrimStart('\ufeff');}
    static Dictionary<string,object> ReadReady(string file){return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(ReadFrameText(file));}
    static void FixtureMembers(IntPtr job,string output,uint driver,uint observer,ref string previous){string text=new JavaScriptSerializer().Serialize(new{driverPid=driver,observerPid=observer,pids=JobPids(job,true)});if(text==previous)return;string file=Path.Combine(output,"controller-members.json"),temporary=file+".partial";File.WriteAllText(temporary,text,new UTF8Encoding(false));if(File.Exists(file))File.Replace(temporary,file,null);else File.Move(temporary,file);previous=text;}
    static ConsoleCustody HoldConsole(IntPtr job,int pid,string expectedImage){
      var console=new ConsoleCustody{Pid=pid};
      try{console.Handle=OpenProcess(0x1000|0x100000,false,pid);Check(console.Handle!=IntPtr.Zero);var text=new StringBuilder(32768);uint length=(uint)text.Capacity;Check(QueryFullProcessImageName(console.Handle,0,text,ref length));console.Image=text.ToString();if(!String.Equals(console.Image,expectedImage,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Console native image differs from fixed policy");bool found;Check(IsProcessInJob(console.Handle,job,out found));if(!found)throw new InvalidOperationException("Console is outside the authoritative Job");if(WaitForSingleObject(console.Handle,0)!=258)throw new InvalidOperationException("Console is already signaled or its wait state is invalid");uint code;Check(GetExitCodeProcess(console.Handle,out code));if(code!=259)throw new InvalidOperationException("Console was already exited at readiness");return console;}catch{Close(ref console.Handle);throw;}
    }
    static bool ConsoleExited(ConsoleCustody console){if(console.Code.HasValue)return true;uint wait=WaitForSingleObject(console.Handle,0);if(wait==UInt32.MaxValue)Check(false);if(wait==258)return false;uint code;Check(GetExitCodeProcess(console.Handle,out code));console.Code=code;return true;}
    static string ConsolePolicy(int fixture){return fixture==0?"system32-conhost":fixture==1?"fixed-node-console-surrogate":"fixed-legacy-console-markers";}
    static void ConsoleDescriptor(Dictionary<string,object> entry,uint observer,string image,bool strict){
      if(Convert.ToInt32(entry["parentProcessId"])!=observer||!String.Equals((string)entry["nativeImage"],image,StringComparison.OrdinalIgnoreCase)||!String.Equals((string)entry["metadataImage"],image,StringComparison.OrdinalIgnoreCase)||Convert.ToInt32(entry["nativeExitBefore"])!=259||Convert.ToInt32(entry["nativeExitAfter"])!=259||!(entry["nativeSignaledBefore"] is bool)||!(entry["nativeSignaledAfter"] is bool)||Convert.ToBoolean(entry["nativeSignaledBefore"])||Convert.ToBoolean(entry["nativeSignaledAfter"])||entry["nativeImageFailure"]!=null||entry["nativeExitFailure"]!=null||entry["metadataFailure"]!=null)throw new InvalidOperationException("Console descriptor identity/metadata differs");
      if(strict&&!String.Equals((string)entry["commandLine"],@"\??\C:\Windows\System32\conhost.exe 0x4",StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("Console command line differs from reviewed identity");
    }
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
    public static int Run(string node,string[] args,string observerScript,string cwd,string output,int timeoutMs){return RunInternal(node,args,observerScript,cwd,output,timeoutMs,@"C:\Windows\System32\conhost.exe",0);}
    // Reflection-only fixed console regression entrypoint; never selectable by Run inputs.
    static int RunConsoleFixture(string node,string[] args,string observerScript,string cwd,string output,int timeoutMs){
      foreach(string value in new[]{node,observerScript,cwd,output,args.Length>0?args[0]:""})if(value.IndexOfAny(new[]{'"','\r','\n'})>=0)throw new ArgumentException("Fixed fixture paths cannot contain command delimiters");
      if(Path.GetFileName(observerScript)!="sibling-console-observer-fixture.ps1"||args.Length!=3||Path.GetFileName(args[0])!="sibling-console-fixture.cjs"||!new HashSet<string>{"normal","absent","outside","nonzero","live","owner-death","wrong-image"}.Contains(args[1])||timeoutMs>5000)throw new ArgumentException("Fixed harmless console fixture required");
      return RunInternal(node,args,observerScript,cwd,output,timeoutMs,node,1);
    }
    static int RunLegacyFixture(string node,string[] args,string observerScript,string cwd,string output,int timeoutMs){if(args.Length!=3||Path.GetFileName(args[0])!="sibling-fixture.cjs"||!new HashSet<string>{"normal","partial-start","deadline","nonzero","orphan","output","owner-death","late-wrong-parent","late-wrong-image","late-role-overlap","late-mutation"}.Contains(args[1])||timeoutMs>5000)throw new ArgumentException("Fixed legacy marker mode required");if(Path.GetFileName(observerScript)!="sibling-observer-fixture.ps1"&&!(args[1]=="partial-start"&&observerScript==@"C:\"+new string('x',33000)+".ps1"))throw new ArgumentException("Fixed legacy marker fixture required");return RunInternal(node,args,observerScript,cwd,output,timeoutMs,@"C:\Windows\System32\conhost.exe",2);}
    static int RunInternal(string node,string[] args,string observerScript,string cwd,string output,int timeoutMs,string expectedConsoleImage,int fixture){
      if(timeoutMs<1500||timeoutMs>60000||!Environment.Is64BitProcess)throw new ArgumentException("Bounded Windows x64 invocation required");
      foreach(string value in new[]{node,observerScript,cwd,output})if(!Path.IsPathRooted(value))throw new ArgumentException("Absolute paths required");
      if(Path.GetFileName(node)!="node.exe")throw new ArgumentException("Portable Node root required");
      Directory.CreateDirectory(output);var clock=Stopwatch.StartNew();IntPtr job=IntPtr.Zero;var driver=new Child();var observer=new Child();ConsoleCustody console=null,fixtureConsole=null,fixtureConsoleNodeHost=null,driverConsole=null;string lateBytes=null;bool jobDrained=false,cleanupJobDrained=false,cleanupRootsSignaled=false,cleanupConsolesSignaled=false;int code=126;string failure=null,cleanupFailure=null;object initialJobSnapshot=null,failureJobSnapshot=null,cleanupJobSnapshot=null;
      string proof=Directory.GetParent(output).FullName,ready=Path.Combine(proof,"observer-ready.json"),exit=Path.Combine(output,"observer-exit.json"),lateFile=Path.Combine(proof,"late-driver-console.json");
      try{
        if(File.Exists(ready)||File.Exists(exit)||File.Exists(lateFile))throw new InvalidOperationException("Fresh readiness/exit/late proof required");
        job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
        var limits=new Extended{Basic=new Limits{Flags=0x2208,Processes=16},JobMemory=new UIntPtr(2147483648UL)};Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(Extended))));
        var cpu=new Cpu{Flags=5,Rate=2500};Check(SetInformationJobObject(job,15,ref cpu,(uint)Marshal.SizeOf(typeof(Cpu))));
        Deadline(clock,timeoutMs);Spawn(driver,job,node,args,cwd,output,"driver");
        int owner=Process.GetCurrentProcess().Id;
        var observerArgs=new List<string>{"-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",observerScript,"-DriverPid",driver.Info.Pid.ToString(),"-ControllerPid",owner.ToString(),"-StopFile",Path.Combine(proof,"observer-stop.json"),"-ResultFile",Path.Combine(proof,"job-observation.json"),"-ReadyFile",ready};if(fixture==1)observerArgs.AddRange(new[]{"-NodePath",node,"-FixturePath",args[0],"-Mode",args[1]});
        Deadline(clock,timeoutMs);Spawn(observer,job,@"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",observerArgs.ToArray(),cwd,output,"observer");
        if(Active(job)!=2)throw new InvalidOperationException("Expected exactly two suspended assigned roots");
        initialJobSnapshot=PidSnapshot(job);
        Json(Path.Combine(output,"controller-receipt.json"),new{controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,observerScript=observerScript,nodeExecutable=node,consolePolicy=ConsolePolicy(fixture),atomicJobAssignment=true,jobHandleInherited=false,initialJobSnapshot=initialJobSnapshot,limitFlags=0x2208,processLimit=16,jobMemoryBytes=2147483648L,cpuFlags=5,cpuRate=2500,startedUtc=DateTime.UtcNow.ToString("o")});
        File.WriteAllText(Path.Combine(output,"owned-pid.txt"),driver.Info.Pid.ToString());
        Deadline(clock,timeoutMs);Check(ResumeThread(observer.Info.Thread)!=UInt32.MaxValue);
        string previousMembers=null;
        while(!File.Exists(ready)){
          FixtureMembers(job,output,driver.Info.Pid,observer.Info.Pid,ref previousMembers);
          if(Exited(observer))throw new InvalidOperationException("Observer exited before readiness: "+observer.Code);
          if(clock.ElapsedMilliseconds>=Math.Min(12000,timeoutMs-750)){code=124;throw new TimeoutException("Readiness deadline");}Thread.Sleep(10);
        }
        if(Exited(observer))throw new InvalidOperationException("Observer was already exited at readiness");
        var readyProof=ReadReady(ready);if(!Convert.ToBoolean(readyProof["ready"])||Convert.ToInt32(readyProof["driverPid"])!=driver.Info.Pid||Convert.ToInt32(readyProof["observerPid"])!=observer.Info.Pid||Convert.ToInt32(readyProof["controllerPid"])!=owner)throw new InvalidOperationException("Ready native root identities differ");
        object descriptor;readyProof.TryGetValue("consoleHost",out descriptor);
        if(descriptor!=null){var entry=(Dictionary<string,object>)descriptor;int consolePid=Convert.ToInt32(entry["pid"]);if(consolePid<=0||consolePid==driver.Info.Pid||consolePid==observer.Info.Pid||consolePid==owner)throw new InvalidOperationException("Console root provenance differs");ConsoleDescriptor(entry,observer.Info.Pid,expectedConsoleImage,fixture==0);console=HoldConsole(job,consolePid,expectedConsoleImage);}
        object auxiliary;readyProof.TryGetValue("fixtureConsoleHost",out auxiliary);if(auxiliary!=null){if(fixture!=1)throw new InvalidOperationException("Auxiliary console prohibited by production/legacy policy");var entry=(Dictionary<string,object>)auxiliary;int auxiliaryPid=Convert.ToInt32(entry["pid"]);if(auxiliaryPid<=0||auxiliaryPid==driver.Info.Pid||auxiliaryPid==observer.Info.Pid||auxiliaryPid==owner||(console!=null&&auxiliaryPid==console.Pid))throw new InvalidOperationException("Auxiliary console identity differs");ConsoleDescriptor(entry,observer.Info.Pid,@"C:\Windows\System32\conhost.exe",true);fixtureConsole=HoldConsole(job,auxiliaryPid,@"C:\Windows\System32\conhost.exe");}
        object nodeHost;readyProof.TryGetValue("fixtureConsoleNodeHost",out nodeHost);if(nodeHost!=null){if(fixture!=1||console==null)throw new InvalidOperationException("Surrogate console prohibited by production/legacy policy");var entry=(Dictionary<string,object>)nodeHost;int nodeHostPid=Convert.ToInt32(entry["pid"]);if(nodeHostPid<=0||nodeHostPid==driver.Info.Pid||nodeHostPid==observer.Info.Pid||nodeHostPid==owner||nodeHostPid==console.Pid||(fixtureConsole!=null&&nodeHostPid==fixtureConsole.Pid))throw new InvalidOperationException("Surrogate console identity differs");ConsoleDescriptor(entry,(uint)console.Pid,@"C:\Windows\System32\conhost.exe",true);fixtureConsoleNodeHost=HoldConsole(job,nodeHostPid,@"C:\Windows\System32\conhost.exe");}
        if(fixture!=1)ExpectedMembers(job,driver.Info.Pid,observer.Info.Pid,console==null?0:console.Pid);else{var expected=new HashSet<long>{driver.Info.Pid,observer.Info.Pid};foreach(var custody in new[]{console,fixtureConsole,fixtureConsoleNodeHost})if(custody!=null)expected.Add(custody.Pid);if(expected.Count>5||!new HashSet<long>(JobPids(job)).SetEquals(expected))throw new InvalidOperationException("Fixture contains unaudited members");}
        Json(Path.Combine(output,"console-custody.json"),new{controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,consolePolicy=ConsolePolicy(fixture),consolePid=console==null?(int?)null:console.Pid,nativeImage=console==null?null:console.Image,fixtureConsolePid=fixtureConsole==null?(int?)null:fixtureConsole.Pid,fixtureConsoleNodeHostPid=fixtureConsoleNodeHost==null?(int?)null:fixtureConsoleNodeHost.Pid,memberVerified=true});
        Deadline(clock,timeoutMs);Check(ResumeThread(driver.Info.Thread)!=UInt32.MaxValue);
        bool observerReceipt=false;long driverExitedAt=-1;
        while(true){
          if(fixture!=0&&!Exited(driver))FixtureMembers(job,output,driver.Info.Pid,observer.Info.Pid,ref previousMembers);
          if(File.Exists(lateFile)){
            byte[] raw=ReadFrameBytes(lateFile);string bytes=Convert.ToBase64String(raw);var frame=new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(raw).TrimStart('\ufeff'));
            if(lateBytes!=null&&bytes!=lateBytes)throw new InvalidOperationException("Late driver console frame mutated after native binding");
            if(lateBytes==null){if((string)frame["phase"]!="late-driver-console"||Convert.ToInt32(frame["driverPid"])!=driver.Info.Pid||Convert.ToInt32(frame["observerPid"])!=observer.Info.Pid||Convert.ToInt32(frame["controllerPid"])!=owner)throw new InvalidOperationException("Late driver console frame provenance differs");var entry=(Dictionary<string,object>)frame["consoleHost"];int number=Convert.ToInt32(entry["pid"]);if(number<=0||number==owner||number==driver.Info.Pid||number==observer.Info.Pid||(console!=null&&number==console.Pid)||(fixtureConsole!=null&&number==fixtureConsole.Pid)||(fixtureConsoleNodeHost!=null&&number==fixtureConsoleNodeHost.Pid))throw new InvalidOperationException("Late driver console overlaps another role");ConsoleDescriptor(entry,driver.Info.Pid,@"C:\Windows\System32\conhost.exe",true);driverConsole=HoldConsole(job,number,@"C:\Windows\System32\conhost.exe");lateBytes=bytes;Json(Path.Combine(output,"driver-console-custody.json"),new{controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,consolePid=driverConsole.Pid,nativeImage=driverConsole.Image,memberVerified=true,descriptor=frame});}
          }else if(lateBytes!=null)throw new InvalidOperationException("Bound late driver console frame disappeared");
          if(Exited(observer)&&!observerReceipt){if(observer.Code!=0)throw new InvalidOperationException("Observer failed: "+observer.Code);bool consoleDone=console==null||ConsoleExited(console),auxiliaryDone=fixtureConsole==null||ConsoleExited(fixtureConsole),nodeHostDone=fixtureConsoleNodeHost==null||ConsoleExited(fixtureConsoleNodeHost);if(consoleDone&&console!=null&&console.Code!=0)throw new InvalidOperationException("Console failed: "+console.Code);if(auxiliaryDone&&fixtureConsole!=null&&fixtureConsole.Code!=0)throw new InvalidOperationException("Fixture console failed: "+fixtureConsole.Code);if(nodeHostDone&&fixtureConsoleNodeHost!=null&&fixtureConsoleNodeHost.Code!=0)throw new InvalidOperationException("Surrogate console failed: "+fixtureConsoleNodeHost.Code);if(consoleDone&&auxiliaryDone&&nodeHostDone){if(Exited(driver))throw new InvalidOperationException("Driver exited before the intermediate receipt");PendingMembers(job,driver.Info.Pid,driverConsole==null?0:driverConsole.Pid);if(driverConsole!=null&&ConsoleExited(driverConsole))throw new InvalidOperationException("Late driver console exited before the intermediate pending receipt");Json(exit,new{phase="observer-exit",controllerPid=owner,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,exitCode=observer.Code,signaled=true,consolePid=console==null?(int?)null:console.Pid,consoleExitCode=console==null?(uint?)null:console.Code,consoleSignaled=console!=null,fixtureConsolePid=fixtureConsole==null?(int?)null:fixtureConsole.Pid,fixtureConsoleExitCode=fixtureConsole==null?(uint?)null:fixtureConsole.Code,fixtureConsoleSignaled=fixtureConsole!=null,fixtureConsoleNodeHostPid=fixtureConsoleNodeHost==null?(int?)null:fixtureConsoleNodeHost.Pid,fixtureConsoleNodeHostExitCode=fixtureConsoleNodeHost==null?(uint?)null:fixtureConsoleNodeHost.Code,fixtureConsoleNodeHostSignaled=fixtureConsoleNodeHost!=null,driverConsolePid=driverConsole==null?(int?)null:driverConsole.Pid,driverConsolePending=driverConsole!=null,driverConsoleSignaled=false,driverConsoleExitCode=(uint?)null,utc=DateTime.UtcNow.ToString("o")});observerReceipt=true;}}
          if(Exited(driver)){
            if(driverExitedAt<0)driverExitedAt=clock.ElapsedMilliseconds;
            bool driverConsoleDone=driverConsole==null||ConsoleExited(driverConsole);if(driverConsoleDone&&driverConsole!=null&&driverConsole.Code!=0)throw new InvalidOperationException("Late driver console failed: "+driverConsole.Code);
            if(Active(job)==0&&observerReceipt&&observer.Code.HasValue&&driverConsoleDone){jobDrained=true;code=unchecked((int)driver.Code.Value);break;}
            if(clock.ElapsedMilliseconds-driverExitedAt>=1000){code=125;throw new InvalidOperationException("Root exited with remaining Job members");}
          }
          if(clock.ElapsedMilliseconds>=timeoutMs-750){code=124;throw new TimeoutException("Single controller deadline");}Thread.Sleep(10);
        }
      }catch(Exception error){failure=error.ToString();if(error is TimeoutException)code=124;if(job!=IntPtr.Zero)failureJobSnapshot=PidSnapshot(job);}
      finally{
        try{
          if(job!=IntPtr.Zero&&(failure!=null||code!=0))Check(TerminateJobObject(job,(uint)code));
          while(clock.ElapsedMilliseconds<timeoutMs){
            cleanupRootsSignaled=true;foreach(var child in new[]{driver,observer})if(child.Info.Process!=IntPtr.Zero&&!Exited(child))cleanupRootsSignaled=false;
            cleanupConsolesSignaled=true;foreach(var custody in new[]{console,fixtureConsole,fixtureConsoleNodeHost,driverConsole})if(custody!=null&&!ConsoleExited(custody))cleanupConsolesSignaled=false;
            cleanupJobDrained=job==IntPtr.Zero||Active(job)==0;
            if(cleanupJobDrained&&cleanupRootsSignaled&&cleanupConsolesSignaled){
              if(job!=IntPtr.Zero){var pids=JobPids(job,true);if(pids.Length!=0)throw new InvalidOperationException("Cleanup Job PID snapshot is not empty");cleanupJobSnapshot=new{assignedCount=0,listedCount=0,pids=pids,utc=DateTime.UtcNow.ToString("o"),failure=(string)null};}
              if(clock.ElapsedMilliseconds>=timeoutMs)throw new TimeoutException("Cleanup snapshot exceeded the single deadline");
              break;
            }
            Thread.Sleep(Math.Max(0,Math.Min(10,timeoutMs-(int)clock.ElapsedMilliseconds)));
          }
          if(!cleanupJobDrained||!cleanupRootsSignaled||!cleanupConsolesSignaled)throw new TimeoutException("Native cleanup did not finish inside the single deadline");
        }catch(Exception error){cleanupFailure=error.ToString();failure=failure??cleanupFailure;if(code==0)code=126;}
        Close(ref job);
        foreach(var custody in new[]{console,fixtureConsole,fixtureConsoleNodeHost,driverConsole})if(custody!=null)Close(ref custody.Handle);
        bool driverDrain=Dispose(driver,clock,timeoutMs);bool observerDrain=Dispose(observer,clock,timeoutMs);
        if(!driverDrain||!observerDrain||clock.ElapsedMilliseconds>timeoutMs){failure=failure??"Streams did not finish inside the single deadline";if(code==0)code=126;}
        if(driver.DrainFailure!=null||observer.DrainFailure!=null){failure=failure??("Diagnostic drain failure: "+driver.DrainFailure+" "+observer.DrainFailure);if(code==0)code=126;}
        try{if(lateBytes!=null&&(!File.Exists(lateFile)||Convert.ToBase64String(ReadFrameBytes(lateFile))!=lateBytes))throw new InvalidOperationException("Late driver console frame changed at final completion");}catch(Exception error){failure=failure??error.ToString();if(code==0)code=126;}
        if(clock.ElapsedMilliseconds>timeoutMs){failure=failure??"Final proof exceeded the single deadline";if(code==0)code=126;}
        Json(Path.Combine(output,"controller-result.json"),new{phase="final",controllerPid=Process.GetCurrentProcess().Id,jobDrained=jobDrained,passed=failure==null&&cleanupFailure==null&&cleanupJobDrained&&cleanupRootsSignaled&&cleanupConsolesSignaled&&code==0&&jobDrained&&driver.Code==0&&observer.Code==0&&(console==null||console.Code==0)&&(fixtureConsole==null||fixtureConsole.Code==0)&&(fixtureConsoleNodeHost==null||fixtureConsoleNodeHost.Code==0)&&(driverConsole==null||driverConsole.Code==0)&&driverDrain&&observerDrain,code=code,failure=failure,driverPid=driver.Info.Pid,observerPid=observer.Info.Pid,driverExitCode=driver.Code,observerExitCode=observer.Code,consolePid=console==null?(int?)null:console.Pid,consoleExitCode=console==null?(uint?)null:console.Code,fixtureConsolePid=fixtureConsole==null?(int?)null:fixtureConsole.Pid,fixtureConsoleExitCode=fixtureConsole==null?(uint?)null:fixtureConsole.Code,fixtureConsoleNodeHostPid=fixtureConsoleNodeHost==null?(int?)null:fixtureConsoleNodeHost.Pid,fixtureConsoleNodeHostExitCode=fixtureConsoleNodeHost==null?(uint?)null:fixtureConsoleNodeHost.Code,driverConsolePid=driverConsole==null?(int?)null:driverConsole.Pid,driverConsoleExitCode=driverConsole==null?(uint?)null:driverConsole.Code,driverConsoleSignaled=driverConsole!=null&&driverConsole.Code.HasValue,initialJobSnapshot=initialJobSnapshot,failureJobSnapshot=failureJobSnapshot,cleanupJobDrained=cleanupJobDrained,cleanupRootsSignaled=cleanupRootsSignaled,cleanupConsolesSignaled=cleanupConsolesSignaled,cleanupJobSnapshot=cleanupJobSnapshot,cleanupFailure=cleanupFailure,driverStreamsDrained=driverDrain,observerStreamsDrained=observerDrain,elapsedMilliseconds=clock.ElapsedMilliseconds,budgetMilliseconds=timeoutMs});
      }
      return code;
    }
  }
}
