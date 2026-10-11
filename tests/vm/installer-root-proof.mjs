import assert from 'node:assert/strict';
const image='c:\\windows\\system32\\conhost.exe';
const command='\\??\\C:\\Windows\\System32\\conhost.exe 0x4';
function validateConsole(consoleHost,parentPid,roles){
  assert.ok(consoleHost&&typeof consoleHost==='object');
  assert.ok(Number.isSafeInteger(consoleHost.pid)&&consoleHost.pid>0&&!roles.includes(consoleHost.pid));
  assert.equal(consoleHost.nativeImage?.toLowerCase(),image);assert.equal(consoleHost.metadataImage?.toLowerCase(),image);
  assert.equal(consoleHost.parentProcessId,parentPid);assert.equal(consoleHost.commandLine?.toLowerCase(),command.toLowerCase());
  assert.equal(consoleHost.nativeExitBefore,259);assert.equal(consoleHost.nativeExitAfter,259);
  assert.equal(consoleHost.nativeSignaledBefore,false);assert.equal(consoleHost.nativeSignaledAfter,false);
  for(const field of ['nativeImageFailure','nativeExitFailure','metadataFailure'])assert.equal(consoleHost[field],null);
  assert.ok(Number.isFinite(consoleHost.queryElapsedMilliseconds)&&consoleHost.queryElapsedMilliseconds>=0);
}
export function validateRootSet(pids,consoleHost,driverPid,observerPid,controllerPid){
  const roots=[driverPid,observerPid,controllerPid];
  assert.ok(roots.every(pid=>Number.isSafeInteger(pid)&&pid>0));assert.equal(new Set(roots).size,3);
  assert.ok(Array.isArray(pids)&&pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  assert.equal(new Set(pids).size,pids.length);assert.ok(pids.includes(driverPid)&&pids.includes(observerPid)&&!pids.includes(controllerPid));
  if(consoleHost===null){assert.equal(pids.length,2);return null;}
  assert.ok(consoleHost&&typeof consoleHost==='object');assert.equal(pids.length,3);
  assert.ok(Number.isSafeInteger(consoleHost.pid)&&consoleHost.pid>0&&!roots.includes(consoleHost.pid)&&pids.includes(consoleHost.pid));
  validateConsole(consoleHost,observerPid,roots);
  return consoleHost.pid;
}
export function validateLateDriverConsole(frame,consoleHost,driverPid,observerPid,controllerPid){
  assert.equal(frame.phase,'late-driver-console');assert.equal(frame.driverPid,driverPid);assert.equal(frame.observerPid,observerPid);assert.equal(frame.controllerPid,controllerPid);
  validateConsole(frame.consoleHost,driverPid,[driverPid,observerPid,controllerPid,consoleHost?.pid]);return frame.consoleHost.pid;
}
export function validateStopSet(pids,consoleHost,lateFrame,driverPid,observerPid,controllerPid){
  if(lateFrame===null)return validateRootSet(pids,consoleHost,driverPid,observerPid,controllerPid);
  const latePid=validateLateDriverConsole(lateFrame,consoleHost,driverPid,observerPid,controllerPid);
  assert.ok(Array.isArray(pids));assert.equal(pids.filter(pid=>pid===latePid).length,1);
  validateRootSet(pids.filter(pid=>pid!==latePid),consoleHost,driverPid,observerPid,controllerPid);return latePid;
}
export function validateLateBinding(bound,current,consoleHost,driverPid,observerPid,controllerPid){
  validateLateDriverConsole(current,consoleHost,driverPid,observerPid,controllerPid);assert.deepEqual(current,bound);
}
export function validateConsoleExit(receipt,consoleHost,driverPid,observerPid,controllerPid,lateFrame=null){
  assert.equal(receipt.phase,'observer-exit');
  assert.equal(receipt.driverPid,driverPid);assert.equal(receipt.observerPid,observerPid);assert.equal(receipt.controllerPid,controllerPid);
  assert.equal(receipt.signaled,true);assert.equal(receipt.exitCode,0);
  if(consoleHost===null){assert.equal(receipt.consolePid,null);assert.equal(receipt.consoleExitCode,null);assert.equal(receipt.consoleSignaled,false);}
  else{assert.equal(receipt.consolePid,consoleHost.pid);assert.equal(receipt.consoleExitCode,0);assert.equal(receipt.consoleSignaled,true);}
  const latePid=lateFrame===null?null:validateLateDriverConsole(lateFrame,consoleHost,driverPid,observerPid,controllerPid);
  assert.equal(receipt.driverConsolePid,latePid);assert.equal(receipt.driverConsolePending,latePid!==null);
  assert.equal(receipt.driverConsoleSignaled,false);assert.equal(receipt.driverConsoleExitCode,null);
}
export function validateFinalConsoleExit(receipt,lateFrame,consoleHost,driverPid,observerPid,controllerPid){
  assert.equal(receipt.phase,'final');assert.equal(receipt.driverPid,driverPid);assert.equal(receipt.observerPid,observerPid);assert.equal(receipt.controllerPid,controllerPid);
  assert.equal(receipt.passed,true);assert.equal(receipt.code,0);assert.equal(receipt.driverExitCode,0);assert.equal(receipt.observerExitCode,0);
  assert.equal(receipt.jobDrained,true);assert.equal(receipt.driverStreamsDrained,true);assert.equal(receipt.observerStreamsDrained,true);
  assert.equal(receipt.consolePid,consoleHost?.pid??null);assert.equal(receipt.consoleExitCode,consoleHost===null?null:0);
  const latePid=lateFrame===null?null:validateLateDriverConsole(lateFrame,consoleHost,driverPid,observerPid,controllerPid);
  assert.equal(receipt.driverConsolePid,latePid);assert.equal(receipt.driverConsoleSignaled,latePid!==null);assert.equal(receipt.driverConsoleExitCode,latePid===null?null:0);
}
export function validateInstallerRoles(records,step,version,executable,selfUpdateExecutable){
  assert.ok(Array.isArray(records));assert.equal(new Set(records.map(record=>record.pid)).size,records.length,'Installer member identities must be unique');
  const fullyProven=record=>record.role==='installer-helper'&&['held-native-helper-wmi-null','held-native-helper-wmi-image','held-native-helper-wmi-advisory-mismatch'].includes(record.metadataPolicy)&&record.metadataCompleted===true&&record.nativeIdentityHeld===true&&record.nativeIdentityRetired===true&&record.nativeFinalSignaled===true&&record.exitCode===0&&record.queryFailure===null&&record.exitQueryFailure===null&&record.metadataProviderFailure===null&&record.metadataFailureStage===null&&record.metadataManagementErrorCode===null&&record.metadataRequestedProcessId===record.pid&&record.metadataProcessId===record.pid&&record.metadataHandle===String(record.pid)&&record.metadataClassName?.toLowerCase()==='win32_process'&&[`win32_process.handle="${record.pid}"`,`win32_process.handle='${record.pid}'`].includes(record.metadataObjectPath?.toLowerCase())&&record.metadataCommandLine===record.commandLine&&Number.isSafeInteger(record.parentProcessId)&&record.parentProcessId>0&&record.metadataParentProcessId===record.parentProcessId&&Array.isArray(record.diagnosticTruncatedFields)&&record.diagnosticTruncatedFields.length===0;
  if(step==='smoke')return {hook:null,selfUpdates:[]};
  assert.ok(['install','repair','update','uninstall'].includes(step));
  const event=step==='update'?'updated':step==='uninstall'?'uninstall':'install';
  const hook=records.find(record=>fullyProven(record)&&record.executablePath?.toLowerCase()===executable.toLowerCase()&&record.commandLine?.includes(`--squirrel-${event} ${version}`));
  assert.ok(hook,`Actual fully proved --squirrel-${event} ${version} command-line observation required`);
  const selfUpdates=records.filter(record=>fullyProven(record)&&record.executablePath?.toLowerCase()===selfUpdateExecutable.toLowerCase()&&record.commandLine?.includes('--updateSelf='));
  if(step!=='uninstall')assert.ok(selfUpdates.length>=1,'Actual fully proved Squirrel self-update helper observation required');
  return {hook,selfUpdates};
}
