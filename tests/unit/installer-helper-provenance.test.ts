import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
it('runs the actual pure helper trust rule including driver ancestry and final native exit boundaries',()=>{
  const fixture=fileURLToPath(new URL('../vm/Test-InstallerHelperProvenance.ps1',import.meta.url));
  const result=JSON.parse(execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture],{encoding:'utf8',timeout:10000,maxBuffer:65536}));
  expect(result.passed).toBe(true);expect(result.nativeObserverInvoked).toBe(false);expect(result.applicationLaunched).toBe(false);
  expect(result.cases.every((row:{passed:boolean})=>row.passed)).toBe(true);
  expect(result.cases.map((row:{name:string})=>row.name)).toEqual(expect.arrayContaining(['explicit null native helper','empty image','console cannot consume null policy','two-parent cycle','duplicate rebound record','unknown parent','retired continuously held parent reaches driver','GPU transitional zero not final','actual final signaled zero','wrong returned PID','wrong object path key','raw ntdll mismatch is advisory with full native and parent proof','advisory mismatch with lost native image','terminal signaled zero skips image without inventing match','GPU retained image error and terminal same-handle zero','transitional zero unsignaled image error','terminal successful differing image always fails','actual diagnostic preserves terminal image error and absent after path']));
  expect(result.cases.find((row:{name:string})=>row.name==='raw ntdll mismatch is advisory with full native and parent proof')).toMatchObject({policy:'held-native-helper-wmi-advisory-mismatch',rawMetadataImage:'C:\\WINDOWS\\SYSTEM32\\ntdll.dll',imageObservation:'advisory-mismatch'});
});
