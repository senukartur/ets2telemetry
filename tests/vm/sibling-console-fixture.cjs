// Fixed harmless console surrogate and driver. No application or native observer.
const fs=require('node:fs');const path=require('node:path');
const [mode,directory,behavior]=process.argv.slice(2);
if(mode==='surrogate'){
  fs.writeFileSync(path.join(directory,'surrogate-marker.json'),JSON.stringify({pid:process.pid,parentPid:process.ppid}));
  setInterval(()=>{if(!['live','owner-death'].includes(behavior)&&fs.existsSync(path.join(directory,'surrogate-stop.json')))process.exit(behavior==='nonzero'?9:0);},10);
}else{
  if(!['normal','absent','outside','nonzero','live','owner-death','wrong-image'].includes(mode))throw new Error('Fixed fixture mode required');
  fs.writeFileSync(path.join(directory,'driver-marker.json'),JSON.stringify({pid:process.pid,marker:'CONSOLE_DRIVER_REACHED'}));
  if(mode!=='owner-death')fs.writeFileSync(path.join(directory,'observer-stop.json'),'{}');
  setInterval(()=>{const file=path.join(directory,'job/observer-exit.json');if(fs.existsSync(file)){const receipt=JSON.parse(fs.readFileSync(file,'utf8'));const auxiliaryZero=(!receipt.fixtureConsolePid||(receipt.fixtureConsoleSignaled&&receipt.fixtureConsoleExitCode===0))&&(!receipt.fixtureConsoleNodeHostPid||(receipt.fixtureConsoleNodeHostSignaled&&receipt.fixtureConsoleNodeHostExitCode===0));process.exit(receipt.phase==='observer-exit'&&receipt.signaled&&receipt.exitCode===0&&receipt.consoleSignaled&&receipt.consoleExitCode===0&&auxiliaryZero&&receipt.driverConsolePid&&receipt.driverConsolePending&&receipt.driverConsoleSignaled===false&&receipt.driverConsoleExitCode===null?0:1);}},10);
}
