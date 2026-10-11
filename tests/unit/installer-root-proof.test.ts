import {describe,expect,it} from 'vitest';
import {validateRootSet,validateConsoleExit,validateLateDriverConsole,validateStopSet,validateLateBinding,validateFinalConsoleExit} from '../vm/installer-root-proof.mjs';
const consoleProof=()=>({pid:13,nativeImage:'C:\\Windows\\System32\\conhost.exe',metadataImage:'C:\\WINDOWS\\system32\\conhost.exe',parentProcessId:11,commandLine:'\\??\\C:\\WINDOWS\\system32\\conhost.exe 0x4',nativeExitBefore:259,nativeExitAfter:259,nativeSignaledBefore:false,nativeSignaledAfter:false,nativeImageFailure:null,nativeExitFailure:null,metadataFailure:null,queryElapsedMilliseconds:351});
describe('installer observer console trust boundary',()=>{
  it('accepts the two native roots without a console descriptor',()=>expect(validateRootSet([10,11],null,10,11,12)).toBeNull());
  it('accounts for one live observer-owned System32 console without hiding its PID',()=>expect(validateRootSet([10,11,13],consoleProof(),10,11,12)).toBe(13));
  it.each([[10],[10,13],[10,11,13,14],[10,11,13,13],[10,11,12]].map(pids=>({pids})))('rejects missing, extra, duplicate or controller members $pids',({pids})=>expect(()=>validateRootSet(pids,consoleProof(),10,11,12)).toThrow());
  it.each([
    {pid:10},{pid:14},{nativeImage:'C:\\Temp\\conhost.exe'},{metadataImage:'C:\\Temp\\conhost.exe'},
    {parentProcessId:12},{commandLine:'\\??\\C:\\Windows\\System32\\conhost.exe 0x5'},
    {nativeExitBefore:0},{nativeExitAfter:0},{nativeSignaledBefore:true},{nativeSignaledAfter:true},
    {nativeImageFailure:'denied'},{nativeExitFailure:'vanished'},{metadataFailure:'timeout'},
    {queryElapsedMilliseconds:NaN}
  ])('rejects a console proof with changed custody %j',change=>expect(()=>validateRootSet([10,11,13],{...consoleProof(),...change},10,11,12)).toThrow());
  it('rejects an unobserved third PID',()=>expect(()=>validateRootSet([10,11,13],null,10,11,12)).toThrow());
  const exit=()=>({phase:'observer-exit',driverPid:10,observerPid:11,controllerPid:12,signaled:true,exitCode:0,consolePid:13,consoleExitCode:0,consoleSignaled:true,driverConsolePid:null,driverConsolePending:false,driverConsoleSignaled:false,driverConsoleExitCode:null});
  it('requires actual signaled observer and console exits 0 from the bound controller',()=>expect(()=>validateConsoleExit(exit(),consoleProof(),10,11,12)).not.toThrow());
  it.each([{controllerPid:99},{driverPid:99},{observerPid:99},{signaled:false},{exitCode:124},{consolePid:14},{consoleExitCode:9},{consoleSignaled:false},{consoleExitCode:undefined}])('rejects missing or changed actual exit attestation %j',change=>expect(()=>validateConsoleExit({...exit(),...change},consoleProof(),10,11,12)).toThrow());
  it('rejects absent attestation',()=>expect(()=>validateConsoleExit({},consoleProof(),10,11,12)).toThrow());
});
describe('late driver console completion order',()=>{
  const late=()=>({phase:'late-driver-console',driverPid:10,observerPid:11,controllerPid:12,consoleHost:{...consoleProof(),pid:14,parentProcessId:10}});
  const intermediate=()=>({phase:'observer-exit',driverPid:10,observerPid:11,controllerPid:12,signaled:true,exitCode:0,consolePid:13,consoleExitCode:0,consoleSignaled:true,driverConsolePid:14,driverConsolePending:true,driverConsoleSignaled:false,driverConsoleExitCode:null});
  const final=()=>({phase:'final',driverPid:10,observerPid:11,controllerPid:12,passed:true,code:0,driverExitCode:0,observerExitCode:0,consolePid:13,consoleExitCode:0,jobDrained:true,driverStreamsDrained:true,observerStreamsDrained:true,driverConsolePid:14,driverConsoleSignaled:true,driverConsoleExitCode:0});
  it('accepts a held driver-parent role only after initial readiness',()=>{
    expect(validateLateDriverConsole(late(),consoleProof(),10,11,12)).toBe(14);
    expect(()=>validateRootSet([10,11,13,14],consoleProof(),10,11,12)).toThrow();
    expect(validateStopSet([10,11,13,14],consoleProof(),late(),10,11,12)).toBe(14);
  });
  it.each([{pid:13},{pid:10},{parentProcessId:11},{nativeImage:'C:\\Temp\\conhost.exe'},{metadataImage:'C:\\Temp\\conhost.exe'},{commandLine:'conhost.exe'},{nativeSignaledBefore:true},{nativeSignaledAfter:true},{nativeExitAfter:0},{metadataFailure:'timeout'}])('rejects late identity mismatch %j',change=>expect(()=>validateLateDriverConsole({...late(),consoleHost:{...late().consoleHost,...change}},consoleProof(),10,11,12)).toThrow());
  it.each([[10,11,13],[10,11,13,14,15],[10,11,13,14,14]])('rejects missing, extra or duplicate Stop roles %j',(...pids)=>expect(()=>validateStopSet(pids,consoleProof(),late(),10,11,12)).toThrow());
  it('rejects mutated late proof after native binding',()=>expect(()=>validateLateBinding(late(),{...late(),consoleHost:{...late().consoleHost,queryElapsedMilliseconds:352}},consoleProof(),10,11,12)).toThrow());
  it('permits Node exit from PS-only proof while its console remains pending',()=>expect(()=>validateConsoleExit(intermediate(),consoleProof(),10,11,12,late())).not.toThrow());
  it.each([{phase:'final'},{driverConsolePid:15},{driverConsolePending:false},{driverConsoleSignaled:true},{driverConsoleExitCode:0},{driverConsoleExitCode:undefined}])('rejects premature or missing intermediate attestation %j',change=>expect(()=>validateConsoleExit({...intermediate(),...change},consoleProof(),10,11,12,late())).toThrow());
  it('requires distinct final native console 0 and complete drain',()=>expect(()=>validateFinalConsoleExit(final(),late(),consoleProof(),10,11,12)).not.toThrow());
  it('does not accept intermediate proof as final acceptance',()=>expect(()=>validateFinalConsoleExit(intermediate(),late(),consoleProof(),10,11,12)).toThrow());
  it.each([{driverConsoleExitCode:9},{driverConsoleExitCode:259},{driverConsoleExitCode:undefined},{driverConsoleSignaled:false},{driverConsolePid:15},{driverExitCode:1},{observerExitCode:1},{consoleExitCode:9},{consolePid:15},{jobDrained:false},{driverStreamsDrained:false},{observerStreamsDrained:false}])('rejects live, failed or incomplete final attestation %j',change=>expect(()=>validateFinalConsoleExit({...final(),...change},late(),consoleProof(),10,11,12)).toThrow());
  it('accepts explicitly attested absence and rejects inferred missing fields',()=>{
    const absent={...intermediate(),consolePid:null,consoleExitCode:null,consoleSignaled:false,driverConsolePid:null,driverConsolePending:false};
    expect(()=>validateConsoleExit(absent,null,10,11,12,null)).not.toThrow();
    expect(()=>validateConsoleExit({...absent,driverConsolePid:undefined},null,10,11,12,null)).toThrow();
  });
});
