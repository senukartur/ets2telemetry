// Portable test driver; the PowerShell parent retains the whole Job until child drain.
import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
const [mode,configFile]=process.argv.slice(2);
const result={mode,passed:false,failure:null};
let config;
const failure=e=>({name:e?.name,message:String(e?.message??e),stack:e?.stack});
async function within(promise,milliseconds){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CLOSE_TIMEOUT')),milliseconds);})]);}finally{clearTimeout(timer);}}
async function database(prepare=false){
  const {DatabaseSync}=await import('node:sqlite');
  if(prepare){const db=new DatabaseSync(config.database);try{db.exec('CREATE TABLE et001_preservation(value INTEGER NOT NULL, synthetic INTEGER NOT NULL); INSERT INTO et001_preservation VALUES(42,1)');}finally{db.close();}
    const bytes=await readFile(config.database);await writeFile(config.preimage,JSON.stringify({path:config.database,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),synthetic:true},null,2));}
  const db=new DatabaseSync(config.database,{readOnly:true});try{assert.deepEqual({...db.prepare('SELECT value,synthetic FROM et001_preservation').get()},{value:42,synthetic:1});assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');}finally{db.close();}
  const preimage=JSON.parse(await readFile(config.preimage,'utf8'));const bytes=await readFile(config.database);assert.equal(bytes.length,preimage.bytes);assert.equal(createHash('sha256').update(bytes).digest('hex'),preimage.sha256);
  result.sqlite={value:42,synthetic:1,integrity:'ok',preimageUnchanged:true};
}
async function smoke(){
  const {_electron:electron}=await import(pathToFileURL(config.playwrightEntry).href);
  let app,error;
  try{
    app=await electron.launch({executablePath:config.executable,cwd:config.cwd,env:{...process.env},timeout:12000});
    const launcher=app.process();result.launcherPid=launcher.pid;
    const window=await app.firstWindow({timeout:10000});
    await window.getByText('Telemetry service ready; isolated storage probe verified',{exact:true}).waitFor({state:'visible',timeout:10000});
    result.security=await app.evaluate(({BrowserWindow})=>{const windows=BrowserWindow.getAllWindows();const p=windows[0].webContents.getLastWebPreferences();return {windows:windows.length,sandbox:p.sandbox,isolation:p.contextIsolation,node:p.nodeIntegration};});
    assert.deepEqual(result.security,{windows:1,sandbox:true,isolation:true,node:false});
    result.bridge=await window.evaluate(async()=>({require:typeof globalThis.require,process:typeof globalThis.process,keys:Object.keys(globalThis.desktop),frozen:Object.isFrozen(globalThis.desktop),status:await globalThis.desktop.getStatus()}));
    assert.deepEqual(result.bridge,{require:'undefined',process:'undefined',keys:['getStatus','selectSource','subscribeLive','getAppState','subscribeAppState','exitApplication','setUnitProfile','setOverlayLayout','setOverlaySections','beginOverlayEdit','setOverlayEditScale','resetOverlayEditPlacement','finishOverlayEdit','listJournalTrips','getJournalTrip','listJournalEvents','listJournalIntervals','listJournalSamples'],frozen:true,status:{service:'ready',storage:'verified',synthetic:true}});
    result.identity=await app.evaluate(({app})=>({executable:process.execPath,version:app.getVersion(),packaged:app.isPackaged}));
    assert.equal(path.resolve(result.identity.executable).toLowerCase(),path.resolve(config.executable).toLowerCase());assert.equal(result.identity.version,'0.1.0');assert.equal(result.identity.packaged,true);
    result.probeBefore=(await readdir(process.env.TEMP)).filter(x=>x.startsWith('ets2telemetry-probe-'));assert.equal(result.probeBefore.length,1);
    await window.screenshot({path:path.join(config.directory,'ready.png')});
  }catch(e){error=e;}
  finally{if(app){const launcher=app.process();const started=performance.now();try{await within(app.close(),8000);result.closeMilliseconds=performance.now()-started;result.launcherExit=launcher.exitCode;result.launcherSignal=launcher.signalCode;assert.equal(launcher.exitCode,0);assert.equal(launcher.signalCode,null);}catch(e){error??=e;}}}
  if(error)throw error;
  result.probeAfter=(await readdir(process.env.TEMP)).filter(x=>x.startsWith('ets2telemetry-probe-'));assert.deepEqual(result.probeAfter,[]);
  const logs=async d=>(await readFile(path.join(d,'startup.jsonl'),'utf8')).trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
  result.mainEvents=await logs(config.diagnostics);result.serviceEvents=await logs(path.join(config.diagnostics,'service'));
  for(const name of ['APP_EXIT','SERVICE_EXIT']){const rows=result.mainEvents.filter(x=>x.event===name);assert.equal(rows.length,1);assert.equal(rows[0].detail.code,0);}
  assert.ok(result.serviceEvents.some(x=>x.event==='STORAGE_VERIFIED'));assert.ok(result.serviceEvents.some(x=>x.event==='SERVICE_REPORT'&&x.detail?.type==='stopped'));
  assert.ok(![...result.mainEvents,...result.serviceEvents].some(x=>/FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(x.event)));
}
try{
  assert.equal(process.platform,'win32');assert.equal(process.versions.node,'24.19.0');
  const raw=await readFile(configFile);assert.ok(raw.length<=16384);config=JSON.parse(raw.toString('utf8').replace(/^\uFEFF/,''));
  assert.ok(['prepare','verify','smoke','control','linger'].includes(mode));
  if(mode==='control'){process.stdout.write('ET001_NATIVE_CHILD_REACHED\n');result.marker=true;}
  else if(mode==='linger'){process.stdout.write('ET001_NATIVE_LINGER_REACHED\n');await new Promise(resolve=>setTimeout(resolve,30000));}
  else{await database(mode==='prepare');if(mode==='smoke')await smoke();}
  result.passed=true;
}catch(e){result.failure=failure(e);}
finally{if(config)await writeFile(path.join(config.directory,`${mode}-result.json`),JSON.stringify(result,null,2)+'\n');}
process.exitCode=result.passed?0:1;
