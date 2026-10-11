import assert from 'node:assert/strict';
const image='c:\\windows\\system32\\conhost.exe';
const command='\\??\\C:\\Windows\\System32\\conhost.exe 0x4';
export function validateRootSet(pids,consoleHost,driverPid,observerPid,controllerPid){
  const roots=[driverPid,observerPid,controllerPid];
  assert.ok(roots.every(pid=>Number.isSafeInteger(pid)&&pid>0));assert.equal(new Set(roots).size,3);
  assert.ok(Array.isArray(pids)&&pids.every(pid=>Number.isSafeInteger(pid)&&pid>0));
  assert.equal(new Set(pids).size,pids.length);assert.ok(pids.includes(driverPid)&&pids.includes(observerPid)&&!pids.includes(controllerPid));
  if(consoleHost===null){assert.equal(pids.length,2);return null;}
  assert.ok(consoleHost&&typeof consoleHost==='object');assert.equal(pids.length,3);
  assert.ok(Number.isSafeInteger(consoleHost.pid)&&consoleHost.pid>0&&!roots.includes(consoleHost.pid)&&pids.includes(consoleHost.pid));
  assert.equal(consoleHost.nativeImage?.toLowerCase(),image);assert.equal(consoleHost.metadataImage?.toLowerCase(),image);
  assert.equal(consoleHost.parentProcessId,observerPid);assert.equal(consoleHost.commandLine?.toLowerCase(),command.toLowerCase());
  assert.equal(consoleHost.nativeExitBefore,259);assert.equal(consoleHost.nativeExitAfter,259);
  assert.equal(consoleHost.nativeSignaledBefore,false);assert.equal(consoleHost.nativeSignaledAfter,false);
  for(const field of ['nativeImageFailure','nativeExitFailure','metadataFailure'])assert.equal(consoleHost[field],null);
  assert.ok(Number.isFinite(consoleHost.queryElapsedMilliseconds)&&consoleHost.queryElapsedMilliseconds>=0);
  return consoleHost.pid;
}
export function validateConsoleExit(receipt,consoleHost,driverPid,observerPid,controllerPid){
  assert.equal(receipt.driverPid,driverPid);assert.equal(receipt.observerPid,observerPid);assert.equal(receipt.controllerPid,controllerPid);
  assert.equal(receipt.signaled,true);assert.equal(receipt.exitCode,0);
  if(consoleHost===null){assert.equal(receipt.consolePid,null);assert.equal(receipt.consoleExitCode,null);assert.equal(receipt.consoleSignaled,false);}
  else{assert.equal(receipt.consolePid,consoleHost.pid);assert.equal(receipt.consoleExitCode,0);assert.equal(receipt.consoleSignaled,true);}
}
