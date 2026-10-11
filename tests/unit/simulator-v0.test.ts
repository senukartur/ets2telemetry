import {readFileSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {builtinModules} from 'node:module';
import net from 'node:net';
import {describe,it,expect} from 'vitest';
import {FrameDecoder,encodeFrame,PROTOCOL_V0,type ServerMessage} from '../../packages/contracts/src/protocol-v0';
import {replay,seededId,validateScenario,type Scenario,type Reading} from '../../tools/telemetry-simulator/src/scenario';
import {SnapshotProbe} from '../../tools/telemetry-simulator/src/consumer';
import {faultBytes,type Fault} from '../../tools/telemetry-simulator/src/faults';
import {startPipe,consumePipe} from '../../tools/telemetry-simulator/src/pipe';
import {readFixtureFile,MAX_FIXTURE_BYTES} from '../../tools/telemetry-simulator/src/fixture-file';

const fixture=JSON.parse(readFileSync('tests/fixtures/simulator-v0/reconnect.json','utf8')) as Scenario;
const expected=JSON.parse(readFileSync('tests/fixtures/simulator-v0/reconnect.expected.json','utf8')) as {messages:unknown[];freshness:Array<{receivedAtMs:number;observeAtMs:number;stale:boolean}>};
function summary(bytes:ReturnType<typeof replay>) {
  const probe=new SnapshotProbe();let connection=0;
  return bytes.map(e=>{
    if(connection!==e.connection){if(connection)probe.end();probe.connect();connection=e.connection;}
    probe.push(e.frame,e.atMs);
    const m=e.message,base={connection:e.connection,atMs:e.atMs,kind:m.kind,seq:m.seq};
    if(m.kind==='welcome'||m.kind==='diagnostic')return base;
    const result=probe.applied.at(-1)!.result!;
    return {...base,speed:m.data.state.speed.available?m.data.state.speed.value:null,fuel:m.data.state.fuel.available?m.data.state.fuel.value:null,simulation:m.data.state.simulation,revision:m.data.state.configuration.revision,coalesced:m.data.continuity.coalescedSnapshots,offline:m.data.continuity.offlineTransitions,hydration:result.hydration,skipped:result.skippedSequences};
  });
}
describe('synthetic v0 replay',()=>{
  it('matches independent ordered expectations, retains only checkpoint after offline changes',()=>expect(summary(replay(fixture))).toEqual(expected.messages));
  it('repeats identical bytes under fixed seed and controlled time without mutating input',()=>{
    const before=JSON.stringify(fixture);expect(replay(fixture)).toEqual(replay(fixture));expect(JSON.stringify(fixture)).toBe(before);
  });
  it('counts semantic configuration transitions independently of job object key order',()=>{
    const job:Reading['job']={available:true,value:{cargoId:'synthetic-cargo',destinationCityId:'synthetic-city',plannedDistance:{available:true,value:0,unit:'m'},expectedIncome:{rawValue:'0',currency:{status:'unknown'}}}};
    const reordered:Reading['job']={value:{expectedIncome:{currency:{status:'unknown'},rawValue:'0'},plannedDistance:{unit:'m',value:0,available:true},destinationCityId:'synthetic-city',cargoId:'synthetic-cargo'},available:true};
    const reading:Reading={atMs:0,speedMps:0,fuelL:0,simulation:'running',revision:'1',truck:'synthetic-truck',gameMinute:'0',job};
    const e=replay({...fixture,steps:[{action:'reading',reading},{action:'reading',reading:{...reading,atMs:1,job:reordered}},{action:'connect',atMs:2}]});
    const checkpoint=e[1].message;if(checkpoint.kind!=='checkpoint')throw new Error('checkpoint');expect(checkpoint.data.continuity).toEqual({coalescedSnapshots:'1',lostObservations:'0',offlineTransitions:'1'});
  });
  it.each(['root','step','reading'])('rejects an oversized undeclared property at %s before retaining the scenario',level=>{
    const s=structuredClone(fixture) as unknown as Record<string,unknown>;const steps=s.steps as Array<Record<string,unknown>>;
    const target=level==='root'?s:level==='step'?steps[0]:steps[0].reading as Record<string,unknown>;
    target.unused='x'.repeat(3*1024*1024);expect(()=>validateScenario(s)).toThrow();
  });
  it('rejects unknown wire-nested job and diagnostic fields',()=>{
    const job={available:true,value:{cargoId:'synthetic',destinationCityId:'synthetic',plannedDistance:{available:true,value:0,unit:'m',unused:'extra'},expectedIncome:{rawValue:'0',currency:{status:'unknown'}}}};
    const s=structuredClone(fixture) as unknown as {steps:Array<{reading?:Record<string,unknown>}>};s.steps[0].reading!.job=job;expect(()=>validateScenario(s)).toThrow();
    expect(()=>validateScenario({...fixture,steps:[{action:'diagnostic',atMs:0,observations:[{channel:'synthetic',sdkType:'string',unit:'raw',value:{available:true,value:'synthetic',unused:'extra'}}]}]})).toThrow();
  });
  it('normalizes declared arrays without retaining unused metadata or caller aliases',()=>{
    const s=structuredClone(fixture);Object.assign(s.steps,{unused:'x'.repeat(3*1024*1024)});const normalized=validateScenario(s);
    expect(Object.hasOwn(normalized.steps,'unused')).toBe(false);expect(normalized.steps).not.toBe(s.steps);
    const observations=[{channel:'synthetic',sdkType:'string' as const,unit:'raw',value:{available:true as const,value:'synthetic'}}];Object.assign(observations,{unused:'x'.repeat(3*1024*1024)});
    const diagnostic=validateScenario({...fixture,steps:[{action:'diagnostic',atMs:0,observations}]}).steps[0];if(diagnostic.action!=='diagnostic')throw new Error('diagnostic');expect(Object.hasOwn(diagnostic.observations,'unused')).toBe(false);
  });
  it('seed controls all project identities; changing seed preserves values and times',()=>{
    const a=replay(fixture),b=replay({...fixture,seed:'another-seed'});
    expect(a[0].message.source.pluginSessionId).not.toBe(b[0].message.source.pluginSessionId);
    expect(a[0].message.capture.clockId).not.toBe(b[0].message.capture.clockId);
    expect(seededId(fixture.seed,'session')).toMatch(/^[0-9a-f-]{36}$/);
    expect(summary(a)).toEqual(summary(b));
  });
  it('keeps exact game time, UTC/capture domains and units including unavailable versus zero',()=>{
    const messages=replay(fixture).map(e=>e.message);const m=messages[1];if(m.kind!=='checkpoint')throw new Error('checkpoint');
    expect(m.capture.monotonicNs).toBe('100000000');expect(m.data.state.captureUtcUnixMs).toEqual({available:true,value:'1800000000100'});
    expect(m.data.state.gameTime).toEqual({available:true,value:'9007199254740993',unit:'min',clockId:seededId(fixture.seed,'game-clock')});
    expect(m.data.state.averageConsumption).toEqual({available:true,value:30,unit:'L/100km'});
    const last=messages.at(-1)!;if(last.kind!=='snapshot')throw new Error('snapshot');
    expect(last.data.state.speed).toEqual({available:false,reason:'not-observed',unit:'m/s'});expect(last.data.state.fuel).toEqual({available:true,value:0,unit:'L'});
    expect(last.data.state.window).toEqual({available:false,reason:'not-supported'});
    expect(last.data.continuity.lostObservations).toBe('0');
    expect(last.data.state.gameTime.clockId).toBe(seededId(fixture.seed,'game-clock-1'));
  });
  it('labels source synthetic, offers no durable recording or copied diagnostics by default',()=>{
    for(const e of replay(fixture))expect(e.message.source.origin).toBe('synthetic');
    expect(replay(fixture)[0].message.data).toEqual({diagnostics:false,durableRecording:false});
    expect(()=>validateScenario({...fixture,origin:'game'})).toThrow();
    const p=new SnapshotProbe();p.connect();const welcome=structuredClone(replay(fixture)[0].message);welcome.source.origin='game';expect(()=>p.push(encodeFrame(welcome),0)).toThrow('Synthetic');expect(p.stale(0)).toBe(true);
  });
  it('counts disabled/offline copied diagnostics and emits them only with explicit opt-in',()=>{
    const observations=[{channel:'synthetic-only.copied',sdkType:'string' as const,value:{available:true as const,value:'SYNTHETIC DIAGNOSTIC'},unit:'raw'}];
    const s:Scenario={id:'synthetic-diagnostics',origin:'synthetic',game:'ets2',seed:'diagnostic',diagnostics:true,steps:[{action:'diagnostic',atMs:0,observations},{action:'connect',atMs:1},{action:'diagnostic',atMs:2,observations}]};
    const e=replay(s),probe=new SnapshotProbe(true);probe.connect();for(const m of e)probe.push(m.frame,m.atMs);
    expect(e[0].message.data).toEqual({diagnostics:true,durableRecording:false});expect(e[2].message.kind).toBe('diagnostic');
    expect(e[2].message.data).toEqual({copied:true,observations,continuity:{coalescedSnapshots:'0',lostObservations:'1',offlineTransitions:'0'}});
    const disabled=replay({...s,diagnostics:false});expect(disabled).toHaveLength(2);expect(disabled[1].message.kind==='checkpoint'&&disabled[1].message.data.continuity.lostObservations).toBe('1');
    const declined=new SnapshotProbe();declined.connect();expect(()=>declined.push(e[0].frame,1)).toThrow();
  });
  it('supports both synthetic game identities and hydrates a copied job without a terminal outcome',()=>{
    const job:Reading['job']={available:true,value:{cargoId:'synthetic-cargo',destinationCityId:'synthetic-city',plannedDistance:{available:true,value:123000,unit:'m'},expectedIncome:{rawValue:'18446744073709551615',currency:{status:'unknown'}}}};
    const s=structuredClone(fixture);for(const step of s.steps)if(step.action==='reading'&&step.reading.revision==='1')step.reading.job=job;
    const e=replay({...s,game:'ats'});expect(e[0].message.source.game).toBe('ats');const m=e[1].message;if(m.kind!=='checkpoint')throw new Error('checkpoint');expect(m.data.state.configuration.job).toEqual(job);expect(e.every(e=>['welcome','checkpoint','snapshot'].includes(e.message.kind))).toBe(true);
  });
  it('maps nonfinite/out-of-range synthetic channels to explicitly invalid availability',()=>{
    const s:Scenario={...fixture,steps:[{action:'connect',atMs:0},{action:'reading',reading:{atMs:1,speedMps:Infinity,fuelL:-1,simulation:'running',revision:'0',truck:null,gameMinute:'0'}}]};
    const m=replay(s)[2].message;if(m.kind!=='snapshot')throw new Error('snapshot');expect(m.data.state.speed).toEqual({available:false,reason:'invalid',unit:'m/s'});expect(m.data.state.fuel).toEqual({available:false,reason:'invalid',unit:'L'});
  });
  it.each([-1,1.1,86_400_001])('rejects unsafe fixture time %s',atMs=>expect(()=>replay({...fixture,steps:[{action:'connect',atMs}]})).toThrow());
  it('rejects backwards clocks and invalid connection lifecycle',()=>{
    expect(()=>replay({...fixture,steps:[{action:'connect',atMs:10},{action:'disconnect',atMs:9}]})).toThrow();
    expect(()=>replay({...fixture,steps:[{action:'connect',atMs:0},{action:'connect',atMs:0}]})).toThrow();
    expect(()=>replay({...fixture,steps:[{action:'disconnect',atMs:0}]})).toThrow();
  });
  it('unchanged values remain fresh with a new source boundary; timeouts and disconnect become stale',()=>{
    const emissions=replay(fixture),p=new SnapshotProbe();p.connect();
    for(const e of emissions.filter(e=>e.connection===1))p.push(e.frame,e.atMs);
    for(const e of expected.freshness.slice(0,2))expect(p.stale(e.observeAtMs)).toBe(e.stale);
    p.end();expect(p.stale(200)).toBe(true);
    p.connect();for(const e of emissions.filter(e=>e.connection===2))p.push(e.frame,e.atMs);expect(p.stale(400)).toBe(false);
    expect(()=>p.stale(399)).toThrow('backwards');
  });
  it('a new connection is stale/unhydrated through welcome and cannot reset the receive clock',()=>{
    const e=replay(fixture),p=new SnapshotProbe();p.connect();p.push(e[0].frame,100);p.push(e[1].frame,100);expect(p.stale(100)).toBe(false);p.end();p.connect();expect(p.state).toBeUndefined();expect(p.stale(100)).toBe(true);expect(()=>p.push(e[4].frame,99)).toThrow('receive boundary');p.push(e[4].frame,350);expect(p.stale(350)).toBe(true);expect(p.state).toBeUndefined();p.push(e[5].frame,350);expect(p.stale(350)).toBe(false);
  });
  it('split header/payload and coalesced frames preserve every byte and identity',()=>{
    const emissions=replay(fixture).filter(e=>e.connection===1);const all=Buffer.concat(emissions.map(e=>Buffer.from(e.frame)));
    for(const chunks of [[all],Array.from(all,b=>Uint8Array.of(b)),[all.subarray(0,2),all.subarray(2,11),all.subarray(11)]]){
      const decoder=new FrameDecoder(),messages:unknown[]=[];for(const chunk of chunks)decoder.push(chunk,m=>messages.push(m));decoder.end();expect(messages).toEqual(emissions.map(e=>e.message));
    }
  });
  it.each(['malformed-json','oversized','missing-field','partial-eof','duplicate','wrong-unit'] as Fault[])('fails closed for %s and reconnects with a new guard',fault=>{
    const emissions=replay(fixture),p=new SnapshotProbe();p.connect();p.push(emissions[0].frame,100);p.push(emissions[1].frame,100);
    expect(()=>{p.push(faultBytes(fault,emissions[2].message),150);p.end();}).toThrow();expect(p.stale(150)).toBe(true);
    p.connect();p.push(emissions[4].frame,350);p.push(emissions[5].frame,350);expect(p.applied.at(-1)!.result?.hydration).toBe(true);
  });
  it('rejects stale sequence, changed identity and backwards producer capture',()=>{
    for(const mutate of [(m:ReturnType<typeof replay>[number]['message'])=>{m.seq='2';},(m:ReturnType<typeof replay>[number]['message'])=>{m.source.processId=99;},(m:ReturnType<typeof replay>[number]['message'])=>{m.capture.monotonicNs='0';}]) {
      const e=replay(fixture),p=new SnapshotProbe();p.connect();p.push(e[0].frame,100);p.push(e[1].frame,100);const bad=structuredClone(e[2].message);mutate(bad);expect(()=>p.push(encodeFrame(bad),150)).toThrow();
    }
  });
});

describe('fixture filesystem boundary',()=>{
  it('accepts exactly the byte cap and rejects overflow/invalid UTF-8 while closing the handle',()=>{
    const directory=mkdtempSync(join(tmpdir(),'ETS2Telemetry-SYNTHETIC-TEST-fixture-'));
    try {
      const path=join(directory,'fixture.json'),bytes=Buffer.from(JSON.stringify(fixture)),bounded=Buffer.alloc(MAX_FIXTURE_BYTES,0x20);bytes.copy(bounded);writeFileSync(path,bounded);
      expect(readFixtureFile(path)).toEqual(fixture);writeFileSync(path,Buffer.concat([bounded,Buffer.from(' ')]));expect(()=>readFixtureFile(path)).toThrow('exceeds 2 MiB');
      writeFileSync(path,Buffer.from([0xff]));expect(()=>readFixtureFile(path)).toThrow();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('rejects a fixture that grows beyond 2 MiB between metadata/open and the actual byte read',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'ETS2Telemetry-SYNTHETIC-TEST-fixture-'));
    try {
      const path=join(directory,'fixture.json'),preload=join(directory,'grow.cjs'),marker=join(directory,'grew.txt');writeFileSync(path,JSON.stringify(fixture));
      // Bundle the current source in an owned temporary directory, so the fast
      // suite never depends on a prior root build or a cached CLI artifact.
      const {build}=await import('vite');const bundle=join(directory,'bundle');
      await build({configFile:false,logLevel:'silent',build:{outDir:bundle,emptyOutDir:true,lib:{entry:resolve('tools/telemetry-simulator/src/cli.ts'),formats:['cjs'],fileName:()=> 'cli.cjs'},rollupOptions:{external:[...builtinModules,...builtinModules.map(x=>`node:${x}`)]}}});
      // An actual filesystem mutation at a deterministic boundary, not mocked read bytes.
      writeFileSync(preload,`const fs=require('node:fs');const path=process.env.SIMULATOR_FIXTURE;let grown=false;function grow(p){if(!grown&&String(p)===path){grown=true;fs.appendFileSync(path,' '.repeat(3*1024*1024));fs.writeFileSync(process.env.SIMULATOR_GROWTH_MARKER,'actual-file-grew');}}const stat=fs.statSync;fs.statSync=function(p,...args){const result=stat.call(this,p,...args);grow(p);return result;};const open=fs.openSync;fs.openSync=function(p,...args){const result=open.call(this,p,...args);grow(p);return result;};`);
      const result=spawnSync(process.execPath,['--require',preload,join(bundle,'cli.cjs'),'replay',path],{env:{...process.env,SIMULATOR_FIXTURE:path,SIMULATOR_GROWTH_MARKER:marker},encoding:'utf8',timeout:5000,maxBuffer:65536,windowsHide:true});
      expect(result.error).toBeUndefined();expect(readFileSync(marker,'utf8')).toBe('actual-file-grew');expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toContain('exceeds 2 MiB');
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
});
describe('isolated actual Windows pipe boundary',()=>{
  it('speaks real v0 hello/welcome/checkpoint/snapshot across reconnect with real cadence',async()=>{
    const emissions=replay(fixture),run=await startPipe(emissions,{realtime:true});
    try {const result=await consumePipe(run.endpoint,2);await run.closed;expect(result.probe.applied.map(e=>e.message)).toEqual(emissions.map(e=>e.message));expect(result.probe.stale(5000)).toBe(true);expect(result.arrivalsMs[2]-result.arrivalsMs[1]).toBeGreaterThanOrEqual(20);expect(result.arrivalsMs.at(-1)!).toBeLessThan(4000);}finally{await run.stop();}
  });
  it('does not accept a production endpoint',async()=>await expect(consumePipe('\\\\.\\pipe\\ETS2Telemetry-ets2-v0-real',1)).rejects.toThrow('synthetic endpoint'));
  it('rejects clean EOF before checkpoint hydration rather than accepting an incomplete handshake',async()=>{
    const run=await startPipe([replay(fixture)[0]]);
    try{await expect(consumePipe(run.endpoint,1)).rejects.toThrow(/hydration|clean EOF/);await run.closed;}finally{await run.stop();}
  });
  it('uses a fresh guard for each of ten back-to-back pipe connections',async()=>{
    const s:Scenario={...fixture,steps:Array.from({length:10},(_,i)=>[{action:'connect' as const,atMs:i},{action:'disconnect' as const,atMs:i}]).flat()};
    const emissions=replay(s),run=await startPipe(emissions);
    try{const result=await consumePipe(run.endpoint,10);await run.closed;expect(result.probe.applied.filter(m=>m.result?.hydration)).toHaveLength(10);expect(result.probe.applied.map(e=>e.message)).toEqual(emissions.map(e=>e.message));}finally{await run.stop();}
  });
  it('bounds app-absent lifetime and retires its owned endpoint',async()=>{
    const run=await startPipe(replay(fixture),{timeoutMs:80,writeTimeoutMs:40});await expect(run.closed).rejects.toThrow('deadline');
    await new Promise<void>((resolve,reject)=>{const client=net.connect(run.endpoint);client.once('error',()=>resolve());client.once('connect',()=>{client.destroy();reject(new Error('Endpoint still alive'));});});
  });
  it('cancels a waiting client and closes handles',async()=>{
    const controller=new AbortController(),run=await startPipe(replay(fixture),{signal:controller.signal});const socket=net.connect(run.endpoint);
    try{await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});const clientClosed=new Promise<void>((resolve,reject)=>{const deadline=setTimeout(()=>reject(new Error('Client close timeout')),500);socket.once('close',()=>{clearTimeout(deadline);resolve();});});controller.abort();await run.closed;await clientClosed;expect(socket.destroyed).toBe(true);}finally{socket.destroy();await run.stop();}
  });
  it('bounds a non-reading connected client without a history/event queue',async()=>{
    const initial=replay(fixture).filter(e=>e.connection===1);const snapshot=initial[2];
    const welcome=initial[0].message;if(welcome.kind!=='welcome')throw new Error('welcome');welcome.data.diagnostics=true;initial[0].frame=encodeFrame(welcome);
    const large=initial.concat(Array.from({length:400},(_,i)=>{
      const message:ServerMessage={...snapshot.message,kind:'diagnostic',seq:(6+i).toString(),capture:{...snapshot.message.capture,monotonicNs:(BigInt(201+i)*1_000_000n).toString()},data:{copied:true,observations:Array.from({length:32},(_,j)=>({channel:`synthetic.${j}`,sdkType:'string',value:{available:true,value:'x'.repeat(1024)},unit:'raw'})),continuity:{coalescedSnapshots:'1',lostObservations:'0',offlineTransitions:'2'}}};
      return {...snapshot,message,atMs:201+i,frame:encodeFrame(message)};
    }));
    const run=await startPipe(large,{timeoutMs:500,writeTimeoutMs:80});const socket=net.connect(run.endpoint);
    try {await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.pause();socket.write(encodeFrame({version:PROTOCOL_V0,kind:'hello',data:{clientInstanceId:seededId('slow-reader','client'),minMinor:0,maxMinor:0,diagnostics:true}}));await expect(run.closed).rejects.toThrow(/deadline/);}finally{socket.destroy();await run.stop().catch(()=>{});}
  });
  it('fails closed for malformed actual pipe hello and prevents data emission',async()=>{
    const run=await startPipe(replay(fixture)),socket=net.connect(run.endpoint);let received=0;
    try{socket.on('data',chunk=>{received+=chunk.length;});await new Promise<void>((resolve,reject)=>{socket.once('connect',resolve);socket.once('error',reject);});socket.write(faultBytes('malformed-json',replay(fixture)[0].message));await expect(run.closed).rejects.toThrow();expect(received).toBe(0);}finally{socket.destroy();await run.stop().catch(()=>{});}
  });
});
