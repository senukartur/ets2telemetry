import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {expect,it} from 'vitest';
it('runs the actual pure PowerShell initial-driver trust rule with deterministic negatives',()=>{
  const fixture=fileURLToPath(new URL('../vm/Test-InstallerDriverProvenance.ps1',import.meta.url));
  const result=JSON.parse(execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fixture],{encoding:'utf8',timeout:10000,maxBuffer:65536}));
  expect(result.passed).toBe(true);expect(result.nativeObserverInvoked).toBe(false);expect(result.applicationLaunched).toBe(false);
  expect(result.cases.every((row:{passed:boolean})=>row.passed)).toBe(true);
  expect(result.cases.map((row:{name:string})=>row.name)).toEqual(expect.arrayContaining(['held-native-suspended-wmi-null','held-native-and-wmi-image','empty WMI image','wrong non-null WMI image','changed argument case','metadata timeout','missing WMI image operand']));
});
