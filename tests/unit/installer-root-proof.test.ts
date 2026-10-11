import {describe,expect,it} from 'vitest';
import {validateRootSet,validateConsoleExit} from '../vm/installer-root-proof.mjs';
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
  const exit=()=>({driverPid:10,observerPid:11,controllerPid:12,signaled:true,exitCode:0,consolePid:13,consoleExitCode:0,consoleSignaled:true});
  it('requires actual signaled observer and console exits 0 from the bound controller',()=>expect(()=>validateConsoleExit(exit(),consoleProof(),10,11,12)).not.toThrow());
  it.each([{controllerPid:99},{driverPid:99},{observerPid:99},{signaled:false},{exitCode:124},{consolePid:14},{consoleExitCode:9},{consoleSignaled:false},{consoleExitCode:undefined}])('rejects missing or changed actual exit attestation %j',change=>expect(()=>validateConsoleExit({...exit(),...change},consoleProof(),10,11,12)).toThrow());
  it('rejects absent attestation',()=>expect(()=>validateConsoleExit({},consoleProof(),10,11,12)).toThrow());
});
