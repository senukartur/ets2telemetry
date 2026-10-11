// Each invocation is the direct Node root of a fresh existing BoundedProcess Job.
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {readFile, readdir, mkdir, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {createHash} from 'node:crypto';
const [kit, output, guardFile, step, version, budgetText] = process.argv.slice(2);
const result={step,version,passed:false,startedUtc:new Date().toISOString(),finishedUtc:null,failure:null,
  primary:null,observer:null,smoke:null,windowsPlaywrightShellWrapper:step==='smoke'};
const errorValue=error=>({name:error?.name,message:String(error?.message??error),stack:error?.stack});
const parse=value=>JSON.parse(value.replace(/^\uFEFF/,''));
const persist=async()=>{result.finishedUtc=new Date().toISOString();await writeFile(path.join(output,'step-result.json'),JSON.stringify(result,null,2)+'\n');};
async function within(promise,milliseconds,code){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(code)),milliseconds);})]);}finally{clearTimeout(timer);}}
const budget=Number(budgetText);
const timer=setTimeout(async()=>{result.failure??=errorValue(new Error('STEP_DRIVER_DEADLINE'));try{await persist();}finally{process.exit(1);}},Math.max(1000,budget-2000));
const powershell=path.join(process.env.WINDIR,'System32/WindowsPowerShell/v1.0/powershell.exe');
const expectedJobScope={LimitFlags:0x2208,ActiveProcessLimit:16,JobMemoryBytes:2147483648,CpuFlags:5,CpuRate:2500};
let observer;
let observerClosed;
async function startObserver(){
  const stopFile=path.join(output,'observer-stop.json');
  const viewFile=path.join(output,'job-observation.json');
  // MUST be the first child spawn. Pinned libuv detached spawning skips its private
  // breakaway Job; it does not request CREATE_BREAKAWAY_FROM_JOB. Retain pipes/handle.
  observer=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(kit,'harness/Observe-InstallerJob.ps1'),'-DriverPid',String(process.pid),'-StopFile',stopFile,'-ResultFile',viewFile],{detached:true,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let text='';let errors='';
  observer.stderr.on('data',chunk=>{errors=(errors+chunk).slice(0,8192);});
  observerClosed=new Promise((resolve,reject)=>{observer.once('error',reject);observer.once('close',(code,signal)=>resolve({code,signal,stderr:errors}));});
  const ready=await within(new Promise((resolve,reject)=>{
    observer.stdout.on('data',chunk=>{text=(text+chunk).slice(0,8192);if(text.includes('\n')){try{const ready=parse(text.split(/\r?\n/)[0]);assert.equal(ready.ready,true);assert.equal(ready.observerPid,observer.pid);assert.deepEqual(ready.jobScope,expectedJobScope);resolve(ready);}catch(error){reject(error);}}});
    observer.once('error',reject);observer.once('exit',()=>reject(new Error('OBSERVER_EXIT_BEFORE_READY')));
  }),12000,'OBSERVER_START_TIMEOUT');
  result.observerLaunch={firstChild:true,detached:true,unref:false,jobScope:ready.jobScope};
  return {stopFile,viewFile};
}
async function primary(executable,args){
  result.primary={executable,args,pid:null,exitCode:null,signal:null};
  const child=spawn(executable,args,{shell:false,windowsHide:true,cwd:output,env:process.env,stdio:['ignore','inherit','inherit']});
  result.primary.pid=child.pid;
  const ended=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(exitCode,signal)=>resolve({exitCode,signal}));});
  Object.assign(result.primary,ended);
  assert.equal(ended.exitCode,0,'Primary installer/updater must exit 0');assert.equal(ended.signal,null);
}
async function smoke(executable){
  const {_electron:electron}=await import('playwright-core');
  const diagnostics=process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  result.smoke={executable,ready:false,launcherPid:null,security:null,status:null,closeMilliseconds:null,launcherExitCode:null,launcherSignal:null,closeFailure:null,probeBefore:null,probeAfter:null,mainEvents:[],serviceEvents:[]};
  const smoke=result.smoke;let application;let firstFailure;
  try{
    application=await electron.launch({executablePath:executable,cwd:output,timeout:15000,env:{...process.env}});
    smoke.launcherPid=application.process().pid;
    const window=await application.firstWindow({timeout:10000});
    await window.getByText('Telemetry service ready; isolated storage probe verified',{exact:true}).waitFor({state:'visible',timeout:10000});smoke.ready=true;
    smoke.security=await application.evaluate(({BrowserWindow})=>{const windows=BrowserWindow.getAllWindows();const p=windows[0].webContents.getLastWebPreferences();return {windows:windows.length,sandbox:p.sandbox,isolation:p.contextIsolation,node:p.nodeIntegration};});
    assert.deepEqual(smoke.security,{windows:1,sandbox:true,isolation:true,node:false});
    smoke.status=await window.evaluate(async()=>({require:typeof globalThis.require,process:typeof globalThis.process,keys:Object.keys(globalThis.desktop),frozen:Object.isFrozen(globalThis.desktop),status:await globalThis.desktop.getStatus()}));
    assert.deepEqual(smoke.status,{require:'undefined',process:'undefined',keys:['getStatus'],frozen:true,status:{service:'ready',storage:'verified',synthetic:true}});
    smoke.probeBefore=(await readdir(process.env.TEMP)).filter(name=>name.startsWith('ets2telemetry-probe-'));assert.equal(smoke.probeBefore.length,1);
    await window.screenshot({path:path.join(output,'installed-ready.png')});
    const applicationIdentity=await application.evaluate(({app})=>({executable:process.execPath,version:app.getVersion(),packaged:app.isPackaged}));
    smoke.applicationIdentity=applicationIdentity;
    assert.equal(path.resolve(applicationIdentity.executable).toLowerCase(),path.resolve(executable).toLowerCase());
    assert.deepEqual({version:applicationIdentity.version,packaged:applicationIdentity.packaged},{version:'0.1.0',packaged:true});
  }catch(error){firstFailure=error;}
  finally{if(application){const launcher=application.process();const started=performance.now();try{await within(application.close(),8000,'INSTALLED_CLOSE_TIMEOUT');smoke.closeMilliseconds=performance.now()-started;smoke.launcherExitCode=launcher.exitCode;smoke.launcherSignal=launcher.signalCode;assert.equal(smoke.launcherExitCode,0);assert.equal(smoke.launcherSignal,null);}catch(error){smoke.closeFailure=errorValue(error);firstFailure??=error;}}}
  if(firstFailure)throw firstFailure;
  smoke.probeAfter=(await readdir(process.env.TEMP)).filter(name=>name.startsWith('ets2telemetry-probe-'));assert.deepEqual(smoke.probeAfter,[]);
  const logs=async directory=>(await readFile(path.join(directory,'startup.jsonl'),'utf8')).trim().split(/\r?\n/).map(parse);
  smoke.mainEvents=await logs(diagnostics);smoke.serviceEvents=await logs(path.join(diagnostics,'service'));
  for(const event of ['SERVICE_EXIT','APP_EXIT']){const matches=smoke.mainEvents.filter(record=>record.event===event);assert.equal(matches.length,1);assert.equal(matches[0].detail?.code,0);}
  assert.ok(smoke.serviceEvents.some(record=>record.event==='STORAGE_VERIFIED'));
  assert.ok(smoke.serviceEvents.some(record=>record.event==='SERVICE_REPORT'&&record.detail?.type==='stopped'));
  assert.ok(![...smoke.mainEvents,...smoke.serviceEvents].some(record=>/FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|RENDER_PROCESS_GONE|INVALID/.test(record.event)));
}
async function preservationDatabase(){
  // Test-driver SQLite only, inside the guest Job. This is not the product schema.
  const {DatabaseSync}=await import('node:sqlite');
  const filename=path.join(process.env.LOCALAPPDATA,'ETS2Telemetry/data/telemetry.sqlite');
  if(step==='install'){
    const database=new DatabaseSync(filename);
    try{database.exec("CREATE TABLE et001_preservation (value INTEGER NOT NULL, synthetic INTEGER NOT NULL); INSERT INTO et001_preservation VALUES (42,1)");}finally{database.close();}
    const bytes=await readFile(filename);
    result.sqlitePreimage={path:filename,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),synthetic:true};
    // Seal the preimage before Setup is started, including on a later failed install.
    await writeFile(path.join(output,'sqlite-preimage.json'),JSON.stringify(result.sqlitePreimage,null,2)+'\n');
  }
  const database=new DatabaseSync(filename,{readOnly:true});
  try{
    const row=database.prepare('SELECT value,synthetic FROM et001_preservation').get();
    assert.equal(row.value,42);assert.equal(row.synthetic,1);
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    result.sqlitePreservation={readOnly:true,value:row.value,synthetic:row.synthetic,integrity:'ok'};
  }finally{database.close();}
}
try{
  assert.equal(process.platform,'win32');assert.equal(process.versions.node,'24.19.0');assert.equal(path.resolve(kit),'C:\\ETS2ET001Acceptance');
  assert.equal(process.env.ETS2TELEMETRY_VM_JOB,'1');assert.equal(process.env.ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH,'1');
  assert.ok(path.resolve(output).startsWith(path.join(kit,'evidence')+path.sep));assert.ok(budget>=10000&&budget<=60000);
  assert.equal(process.env.SQUIRREL_TEMP,undefined,'SQUIRREL_TEMP redirects the pinned installer base and must be absent');
  for(const name of ['TEMP','TMP','ETS2TELEMETRY_PROFILE_DIR'])assert.ok(path.resolve(process.env[name]).startsWith(path.join(kit,'scratch')+path.sep),`${name} must use isolated guest scratch outside exported proof`);
  const guard=parse(await readFile(guardFile,'utf8'));assert.equal(guard.vmUuid,'94674D56-D803-F4D5-9AAC-C4E91CFB475F');assert.equal(guard.labId,'9a047927-f94b-41cb-bda8-abcc7d0b76f1');assert.equal(guard.step,step);assert.equal(guard.version,version);assert.equal(guard.jobRequired,true);
  assert.ok(Date.now()-Date.parse(guard.verifiedUtc)<90000);assert.ok(Date.parse(guard.outerDeadlineUtc)-Date.now()>=budget+15000);
  assert.equal(parse(await readFile(path.join(kit,'node_modules/playwright-core/package.json'),'utf8')).version,'1.64.0');
  const binaryRoot=path.join(process.env.LOCALAPPDATA,'ETS2TelemetryDesktop');
  assert.equal(path.resolve(binaryRoot).toLowerCase(),guard.binaryRoot.toLowerCase());
  const executable=path.join(binaryRoot,`app-${version}`,'ETS2TelemetryDesktop.exe');
  await preservationDatabase();
  const observed=await startObserver();
  try{
    if(step==='install'||step==='repair')await primary(path.join(kit,'installer/Setup.exe'),['--silent']);
    else if(step==='update')await primary(path.join(binaryRoot,'Update.exe'),['--update',path.join(kit,'feed')]);
    else if(step==='uninstall')await primary(path.join(binaryRoot,'Update.exe'),['--uninstall','--silent']);
    else if(step==='smoke')await smoke(executable);
    else throw new Error('UNKNOWN_INSTALLER_STEP');
  }finally{await writeFile(observed.stopFile,'{}\n');}
  const observerExit=await observerClosed;assert.equal(observerExit.code,0);assert.equal(observerExit.signal,null);
  result.observer=parse(await readFile(observed.viewFile,'utf8'));assert.equal(result.observer.passed,true);assert.equal(result.observer.drained,true);
  assert.deepEqual(result.observer.jobScope,expectedJobScope);
  assert.deepEqual(new Set(result.observer.finalPids),new Set([process.pid,observer.pid]));
  if(step!=='smoke'){
    const event=step==='update'?'updated':step==='uninstall'?'uninstall':'install';
    const hook=result.observer.processes.find(record=>record.executablePath?.toLowerCase()===executable.toLowerCase()&&record.commandLine?.includes(`--squirrel-${event} ${version}`));
    assert.ok(hook,`Actual --squirrel-${event} ${version} command-line observation required`);
    assert.equal(hook.exitCode,0,'Actual lifecycle hook must exit 0');
    result.hook=hook;
    if(step!=='uninstall'){
      const selfUpdates=result.observer.processes.filter(record=>record.executablePath?.toLowerCase()===path.join(binaryRoot,`app-${version}`,'Squirrel.exe').toLowerCase()&&record.commandLine?.includes('--updateSelf='));
      assert.ok(selfUpdates.length>=1,'Actual Squirrel self-update helper observation required');
      for(const helper of selfUpdates)assert.equal(helper.exitCode,0,'Self-update helper must finish normally before driver exit');
      result.selfUpdates=selfUpdates;
    }
    assert.deepEqual((await readdir(process.env.TEMP)).filter(name=>name.startsWith('ets2telemetry-probe-')),[]);
    assert.deepEqual(await readdir(process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR),[],'Installer hook must not start app/service diagnostics');
  }
  result.passed=true;
}catch(error){result.failure=errorValue(error);}
finally{clearTimeout(timer);await persist();}
// Node remains alive until the observer saw all installer/helper descendants exit naturally.
process.exit(result.passed?0:1);
