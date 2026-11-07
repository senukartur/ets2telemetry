import {inspectGameProcess} from '../../apps/desktop/src/hard-mode/process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {BigIntStats} from 'node:fs';
import {mkdtemp, mkdir, open, rm, writeFile, rename, utimes, symlink, appendFile, realpath, stat, opendir} from 'node:fs/promises';
import {ProfileLogParser, ProfileLogTail} from '../../apps/desktop/src/hard-mode/log-tail';
import path from 'node:path';
import os from 'node:os';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hardModeFixtureOptions} from '../../apps/desktop/src/hard-mode/fixture';
import {HardModeReader, FileEvidenceError, ProfileSuperseded, UnchangedVerificationError, coalesceProfileDiagnostics, type ProfileDiagnostic, profileFromLog, readStableFile} from '../../apps/desktop/src/hard-mode/reader';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import {hardModeView} from '../../apps/desktop/src/hard-mode/view';
import {ProfileObserver} from '../../apps/desktop/src/profile-observation';
import type {HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {advanceHardModeV2, newHardModeDetails, qualifiesHardMode, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
const source: SourceIdentity = {game: 'ets2', origin: 'game', processId: 123, windowsSessionId: 1, processInstanceId: '10000000-0000-4000-8000-000000000001', pluginSessionId: '20000000-0000-4000-8000-000000000001'};
const name = 'Synthetic Профиль', id = Buffer.from(name).toString('hex').toUpperCase();
const created = new Date(2026, 9, 21, 12, 0, 0).getTime();
const header = '************ : log created on : Wednesday October 21 2026 @ 12:00:00\n';
const selection = `00:00:01.000 : New profile selected: '${name}'\n`;
const save = (storage: 'home' | 'steam' = 'home') => `00:00:02.000 : Loading save. Type: 0, path: <MEMFILE><UFS>/${storage}/profiles/${id}/save/autosave/game.sii\n`;
let root: string, game: string, profile: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ets2-hard-mode-'))); game = path.join(root, 'Documents', 'Euro Truck Simulator 2'); profile = path.join(game, 'profiles', id);
  await mkdir(profile, {recursive: true});
  await writeFile(path.join(game, 'game.log.txt'), header + selection + save());
  await writeFile(path.join(game, 'config.cfg'), 'uset g_traffic "1.0"');
  await writeFile(path.join(profile, 'config_local.cfg'), 'uset g_brake_intensity "0.75"');
  await writeFile(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG);
});
afterEach(async () => {vi.useRealTimers(); await rm(root, {recursive: true, force: true});});
const processFacts = () => Promise.resolve({pid: source.processId, createdUtcMs: created, executable: 'C:\\Synthetic\\eurotrucks2.exe', commandLine: 'eurotrucks2.exe'});
const reader = () => new HardModeReader({documents: path.join(root, 'Documents'), process: processFacts});
const read = (r = reader()) => r.read(source, '100', created + 10000, new AbortController().signal);
/** Establish a metadata-visible edit independently of host timestamp granularity or an unfinished sibling byte read. */
async function writeSettingsChange(filename: string, text: string) {
  const before=await stat(filename,{bigint:true}),first=new Date('2026-10-22T12:00:00Z');
  await writeFile(filename,text);
  const timestamp=before.mtimeNs===BigInt(first.getTime())*1_000_000n?new Date('2026-10-23T12:00:00Z'):first;
  await utimes(filename,timestamp,timestamp);
  const after=await stat(filename,{bigint:true});expect(after.mtimeNs).not.toBe(before.mtimeNs);
  return {before,after};
}
function gate<T = void>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
const unknownObservation=():HardModeObservation=>({assessment:unknownHardMode(0),binding:null,pluginSessionId:null,sourceMonotonicNs:null});
function nativeFrame(value: unknown): Buffer {
  const bytes=value instanceof Buffer?value:Buffer.from(JSON.stringify(value)),prefix=Buffer.alloc(4);prefix.writeUInt32LE(bytes.length);
  return Buffer.concat([prefix,bytes]);
}
function nativeInspection(game: 'ets2' | 'ats' = 'ets2') {
  const peer={...source,game},target={source:peer,processCreationTime:(BigInt(created)*10000n+116444736000000000n+9999n).toString(),userTag:'a'.repeat(64)};
  const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
  const launch=vi.fn(()=>child) as unknown as typeof import('node:child_process').spawn,controller=new AbortController(),diagnostics:ProfileDiagnostic[]=[];
  let settled=false;
  const work=inspectGameProcess(peer,controller.signal,value=>diagnostics.push(value),{executable:'C:\\Synthetic\\client.exe',target},launch).then(value=>{settled=true;return value;});
  const receipt={type:'profile-process',schemaVersion:1,target,executable:`C:\\Synthetic\\${game==='ets2'?'eurotrucks2':'amtrucks'}.exe`,homeDirectory:null as string|null};
  return {child,controller,diagnostics,target,receipt,work,settled:()=>settled};
}
describe('ET-026 isolated reader (REG-008/010/011)', () => {
  it.each([[0.25, 50, 'pass'], [0.255, 51, 'fail'], [0.26, 52, 'fail'], [0.5, 100, 'fail']] as const)('reads owner-observed stability raw %s as %s%% with state %s', async (raw, percent, state) => {
    const config = HARD_MODE_CONFIG.replace(/g_(truck|trailer)_stability "[^"]+"/g, (_, id: string) => `g_${id}_stability "${raw}"`);
    await writeFile(path.join(profile, 'config.cfg'), config);
    const {assessment} = await read(); expect(assessment.state).toBe(state);
    for (const id of ['truck', 'trailer']) {
      expect(assessment.rules.find(rule => rule.id === id)).toMatchObject({state, values: [raw]});
      expect(hardModeView({assessment, trip: null}, created + 10000).rows.find(rule => rule.id === id)).toMatchObject({detected: `${percent}% (${raw})`, required: '≤ 50% (0.25)'});
    }
    expect(assessment.rules[7]).toMatchObject({state: 'pass', values: [1, 2]});
  });
  it.each(['admitted','cleared','settings-first','superseded'] as const)('revokes discovery provenance while a sibling drains with %s settings admission',async mode=>{
    vi.useFakeTimers();let now=0n,hold=false,clearHold=false;const completed=gate(),entered=gate(),release=gate(),hintEntered=gate(),hintRelease=gate(),globalObserved=gate(),clearEntered=gate(),clearRelease=gate();
    const parent=path.dirname(profile),global=path.join(game,'config.cfg'),r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      file:async(filename,limit,signal)=>{if(clearHold&&filename===path.join(profile,'config_local.cfg')){clearEntered.resolve();await clearRelease.promise;}return readStableFile(filename,limit,signal);},
      metadata:{realpath:async filename=>{if(hold&&filename===path.join(profile,'config_local.cfg')){entered.resolve();await release.promise;}return realpath(filename);},stat:async filename=>{
        const value=await stat(filename,{bigint:true});if(hold&&filename===parent){hintEntered.resolve();await hintRelease.promise;}if(hold&&filename===global)globalObserved.resolve();return value;
      }}}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const proof=observer.evidence(),token=observer.status().token;
      if(mode==='cleared'){
        await writeFile(global,'uset g_traffic "2"');clearHold=true;const cancelled=new AbortController();
        const clearing=r.readTimed(source,'2',created+10000,cancelled.signal,undefined,true).catch(error=>error);await clearEntered.promise;
        expect(m.evidence().assessment.state).toBe('unknown');cancelled.abort(new ProfileSuperseded('Settings scan superseded'));clearHold=false;clearRelease.resolve();await clearing;await r.drain();
        expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);
      }
      if(mode==='settings-first')await writeFile(global,'uset g_traffic "2"');
      await utimes(parent,new Date('2026-10-23T12:00:00Z'),new Date('2026-10-23T12:00:00Z'));now=5_000_000_000n;hold=true;
      const controller=new AbortController();pending=mode==='superseded'?r.readTimed(source,'3',created+10000,controller.signal,undefined,true).catch(error=>error):m.refresh(true);
      await entered.promise;await hintEntered.promise;await globalObserved.promise;await Promise.resolve();await Promise.resolve();
      expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);if(mode==='settings-first')expect(m.evidence().assessment.state).toBe('unknown');
      if(mode==='superseded')controller.abort(new ProfileSuperseded('Same-generation hint'));
      hintRelease.resolve();await Promise.resolve();await Promise.resolve();expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);expect(m.evidence().assessment.state).toBe('unknown');
      let drained=false;void r.drain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
    }finally{m.close();observer.close();release.resolve();hintRelease.resolve();clearRelease.resolve();await pending;await r.drain();}
  });
  it.each([1n,1_000_000n].flatMap(offset=>['profile-first','monitor-only'].flatMap(order=>[false,true].flatMap(changed=>[false,true].map(watchdog=>({offset,order,changed,watchdog}))))) )('classifies an early subscriber deadline without revoking fresh profile guards: $offset/$order/$changed/$watchdog',async({offset,order,changed,watchdog})=>{
    vi.useFakeTimers();let now=0n,skew=false,hold=false,completed=gate();const entered=gate(),release=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>{if(skew){skew=false;now+=offset;}return now;},file:async(filename,limit,signal)=>{
      if(hold&&filename===path.join(profile,'config_local.cfg')){entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);
    }}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<void>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const proof=observer.evidence(),token=observer.status().token;
      now=5_000_000_000n;if(order==='monitor-only')await observer.refresh();
      if(changed){
        const {before,after}=await writeSettingsChange(path.join(profile,'config.cfg'),HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));
        expect(after.size).toBe(before.size);
      }
      hold=true;skew=true;completed=gate();if(order==='profile-first')void observer.refresh();pending=m.refresh(true);await entered.promise;
      // Optional reads start only after metadata guards; establish withdrawal before racing their deadline.
      expect(m.evidence().assessment.state).toBe(changed?'unknown':'pass');
      now+=2_000_000_000n-offset;await vi.advanceTimersByTimeAsync(2000);await completed.promise;
      expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);expect(m.evidence().assessment.state).toBe(changed?'unknown':'pass');
      if(watchdog){now+=5_001_000_000n;await vi.advanceTimersByTimeAsync(5001);expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);expect(m.evidence().assessment.state).toBe('unknown');}
      release.resolve();await pending;await r.drain();
      if(watchdog){expect(observer.evidence()).toBeUndefined();expect(m.evidence().assessment.state).toBe('unknown');}
      else{expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);expect(m.evidence().assessment.state).toBe(changed?'unknown':'pass');}
    }finally{m.close();observer.close();release.resolve();await pending;await r.drain();}
  });
  it.each(['file','missing','directory-hint','missing-to-present','superseded'] as const)('withdraws each partial %s tuple according to its independent evidence role',async mode=>{
    vi.useFakeTimers();let now=0n,hold=false;const completed=gate(),entered=gate(),release=gate(),observed=gate(),tupleRelease=gate();
    const target=mode==='directory-hint'?path.join(game,'profiles'):mode==='missing-to-present'?path.join(game,'steam_profiles'):path.join(profile,'config.cfg');
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,metadata:{
      realpath:async filename=>{if(hold&&filename===path.join(game,'config.cfg')){entered.resolve();await release.promise;}try{return await realpath(filename);}catch(error){if(hold&&filename===target)observed.resolve();throw error;}},
      stat:async filename=>{const value=await stat(filename,{bigint:true});if(hold&&filename===target){observed.resolve();if(mode==='superseded')await tupleRelease.promise;}return value;}}});
    const observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<unknown>|undefined,replacement:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const proof=observer.evidence(),token=observer.status().token;
      if(mode==='missing')await rm(target);else if(mode==='missing-to-present')await mkdir(target);else{if(mode!=='directory-hint')await writeFile(target,HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));const changed=new Date('2026-10-22T12:00:00Z');await utimes(target,changed,changed);}
      now=5_000_000_000n;hold=true;pending=mode==='superseded'?observer.boundary():m.refresh(true);await entered.promise;await observed.promise;
      if(mode==='superseded'){expect(m.evidence().assessment.state).toBe('pass');replacement=observer.boundary();tupleRelease.resolve();}
      await Promise.resolve();await Promise.resolve();
      expect(m.evidence().assessment.state).toBe('unknown');
      // Enumeration-parent changes retire profile provenance; unrelated/settings tuples preserve it.
      if(mode==='directory-hint'){expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);}
      else{expect(observer.status().token).toBe(token);if(mode!=='superseded')expect(observer.evidence()).toEqual(proof);}
      let drained=false;void r.drain().then(()=>{drained=true;});await Promise.resolve();expect(drained).toBe(false);
    }finally{m.close();observer.close();release.resolve();tupleRelease.resolve();await pending;await replacement;await r.drain();}
  });
  it.each(['compliant','generic-EIO','generic-message','retired','superseded'] as const)('handles partial optional byte evidence as %s while retaining physical ownership',async mode=>{
    vi.useFakeTimers();let now=0n,hold=false,readDone=gate();const entered=gate(),release=gate(),observed=gate(),byteRelease=gate(),snapshots=new Map<string,BigIntStats>(),changes:HardModeObservation[]=[];
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,metadata:{realpath,stat:async filename=>{
      if(hold&&snapshots.has(filename))return snapshots.get(filename)!;const value=await stat(filename,{bigint:true});snapshots.set(filename,value);return value;
    }},file:async(filename,limit,signal)=>{
      if(hold&&filename===path.join(profile,'config_local.cfg')){entered.resolve();await release.promise;}
      if(hold&&filename===path.join(profile,'config.cfg')){
        if(mode==='generic-EIO'||mode==='generic-message'){observed.resolve();throw Object.assign(new Error(mode==='generic-message'?'Changing file':'Injected I/O failure'),{code:'EIO'});}
        const value=await readStableFile(filename,limit,signal);observed.resolve();if(mode==='retired'||mode==='superseded')await byteRelease.promise;return value;
      }return readStableFile(filename,limit,signal);
    }}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>readDone.resolve()),value=>changes.push(value),()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await readDone.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const proof=observer.evidence(),token=observer.status().token;
      if(!mode.startsWith('generic'))await writeFile(path.join(profile,'config.cfg'),HARD_MODE_CONFIG+'\n# independently observed edit\n');
      now=5_000_000_000n;hold=true;readDone=gate();const signal=new AbortController();
      pending=mode==='superseded'?r.readTimed(source,'3',created+10000,signal.signal,undefined,true).catch(error=>error):m.refresh(true);
      await entered.promise;await observed.promise;
      if(mode==='retired'){
        m.close();observer.close();const count=changes.length,retiredToken=observer.status().token;byteRelease.resolve();release.resolve();await pending;await r.drain();expect(changes).toHaveLength(count);expect(observer.status().token).toBe(retiredToken);
      }else{
        if(mode==='superseded'){signal.abort(new ProfileSuperseded('Shared byte read superseded'));byteRelease.resolve();}
        await Promise.resolve();await Promise.resolve();expect(m.evidence().assessment.state).toBe(mode.startsWith('generic')?'pass':'unknown');expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);
        if(mode==='compliant'){
          release.resolve();await readDone.promise;await r.drain();expect(m.evidence().assessment.state).toBe('unknown');now++;
          const later={...current,boundary:{clockId:'clock',probeSentClientNs:now.toString(),receivedSourceNs:'3'}};observer.select(later);m.select(later);await pending;
          expect(m.evidence().assessment.state).toBe('pass');expect(m.evidence().sourceMonotonicNs).toBe('4');
        }else if(mode.startsWith('generic')){release.resolve();await pending;expect(m.evidence().assessment.state).toBe('pass');}
      }
    }finally{m.close();observer.close();release.resolve();byteRelease.resolve();await pending;await r.drain();}
  });
  it.each(['monitor-first','physical-first','profile-first'] as const)('retains only profile proof through an optional byte deadline with %s cancellation order',async order=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;let hold=false;const entered=gate(),release=gate(),completed=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:now,file:async(filename,limit,signal)=>{
      if(hold&&filename===path.join(profile,'config_local.cfg')){entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);
    }}),observer=new ProfileObserver(()=>r,now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<unknown>|undefined,raw:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();await vi.advanceTimersByTimeAsync(1);
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:now().toString(),receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const proof=observer.evidence(),token=observer.status().token;
      await vi.advanceTimersByTimeAsync(4999);await writeSettingsChange(path.join(profile,'config.cfg'),HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));hold=true;
      if(order==='physical-first')raw=r.readTimed(source,'3',created+10000,new AbortController().signal,undefined,true).catch(error=>error);
      if(order==='profile-first')void observer.refresh();pending=m.refresh(true);await entered.promise;
      expect(m.evidence().assessment.state).toBe('unknown');expect(r.canRetain()).toBe(false);expect(r.canRetainProfile()).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);await raw;expect(observer.evidence()).toEqual(proof);expect(observer.status().token).toBe(token);expect(m.evidence().assessment.state).toBe('unknown');
      await vi.advanceTimersByTimeAsync(5000);expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
    }finally{m.close();observer.close();release.resolve();await pending;await r.drain();}
  });
  it('marks only its own stable-file evidence rejections with a private type',async()=>{
    const signal=new AbortController().signal,target=path.join(profile,'config.cfg');
    await writeFile(target,Buffer.from([0xc3,0x28]));await expect(readStableFile(target,256*1024,signal)).rejects.toBeInstanceOf(FileEvidenceError);
    await writeFile(target,'x'.repeat(256*1024+1));await expect(readStableFile(target,256*1024,signal)).rejects.toMatchObject({constructor:FileEvidenceError,message:'Unbounded file'});
    const alias=path.join(root,'aliased-settings');await symlink(profile,alias,'junction');await expect(readStableFile(path.join(alias,'config.cfg'),256*1024,signal)).rejects.toMatchObject({constructor:FileEvidenceError,message:'Redirected file'});
  });
  it('discards fulfilled retired metadata before comparisons can publish another invalidation',async()=>{
    vi.useFakeTimers();let now=0n,hold=false;const entered=gate(),release=gate(),completed=gate(),changes:HardModeObservation[]=[],paths:Promise<unknown>[]=[],stats:Promise<unknown>[]=[];
    const global=path.join(game,'config.cfg'),r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      metadata:{realpath:filename=>{const value=realpath(filename);if(hold)paths.push(value);return value;},stat:async filename=>{
        if(hold&&filename===global){entered.resolve();await release.promise;return stat(filename,{bigint:true});}
        const value=stat(filename,{bigint:true});if(hold)stats.push(value);return value;
      }}}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),value=>changes.push(value),()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<void>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();
      now=5_000_000_000n;hold=true;pending=m.refresh(true);await entered.promise;await Promise.allSettled(paths);await Promise.allSettled(stats);
      m.close();observer.close();const count=changes.length,token=observer.status().token;
      await rename(global,global+'.old');await writeFile(global,'uset g_traffic "2"');release.resolve();await pending;await r.drain();
      expect(changes).toHaveLength(count);expect(observer.status().token).toBe(token);expect(r.guardEligible()).toBe(false);
    }finally{m.close();observer.close();release.resolve();await pending;await r.drain();}
  });
  it.each(['admitted','cleared','superseded'] as const)('revokes an observed directory replacement while a metadata sibling is held and baseline is %s',async mode=>{
    vi.useFakeTimers();let now=0n,holdMetadata=false,holdLocation=false;const completed=gate(),globalEntered=gate(),globalRelease=gate(),identityEntered=gate(),identityRelease=gate(),identityPathRelease=gate(),locationEntered=gate(),locationRelease=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      profileDirectory:async parent=>{if(holdLocation){locationEntered.resolve();await locationRelease.promise;}return opendir(parent);},
      // Keep descendant lookups behind the same gate so Windows has no in-flight child lookup during the rename.
      metadata:{realpath:async filename=>{if(holdMetadata&&filename===path.join(game,'config.cfg')){globalEntered.resolve();await globalRelease.promise;}if(holdMetadata&&mode==='cleared'&&(filename===profile||filename.startsWith(profile+path.sep)))await identityPathRelease.promise;return realpath(filename);},
        stat:async filename=>{const value=await stat(filename,{bigint:true});if(holdMetadata&&mode==='superseded'&&filename===path.dirname(profile))await identityRelease.promise;if(holdMetadata&&filename===profile){identityEntered.resolve();if(mode==='superseded')await identityRelease.promise;}return value;}}});
    const observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<unknown>|undefined,replacement:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const token=observer.status().token,original=observer.evidence();
      now=5_000_000_000n;
      if(mode==='cleared'){
        await rename(path.join(game,'config.cfg'),path.join(game,'config.old'));await writeFile(path.join(game,'config.cfg'),'uset g_traffic "1"');holdLocation=true;
        pending=m.refresh(true);await locationEntered.promise;expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);
      }
      const replace=async()=>{await rename(profile,profile+'.old');await mkdir(profile);await writeFile(path.join(profile,'config.cfg'),HARD_MODE_CONFIG);await writeFile(path.join(profile,'config_local.cfg'),'uset g_brake_intensity "0.75"');};
      if(mode!=='cleared')await replace();
      holdMetadata=true;
      if(mode==='cleared'){holdLocation=false;locationRelease.resolve();}
      else pending=mode==='superseded'?observer.boundary():m.refresh(true);
      await globalEntered.promise;if(mode==='cleared'){await replace();identityPathRelease.resolve();}await identityEntered.promise;
      if(mode==='superseded'){replacement=observer.boundary();expect(observer.status().token).toBe(token);identityRelease.resolve();}
      // The adapter's resolved stat continues before this microtask barrier; the unrelated realpath is still held.
      await Promise.resolve();await Promise.resolve();
      expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);expect(m.evidence().assessment.state).toBe('unknown');
    }finally{m.close();observer.close();globalRelease.resolve();identityRelease.resolve();identityPathRelease.resolve();locationRelease.resolve();await pending;await replacement;await r.drain();}
  });
  it.each(['realpath','stat','retired-error'] as const)('retains physical metadata ownership after independent failure while %s remains held',async stage=>{
    vi.useFakeTimers();let now=0n,hold=false,logReads=0,globalStats=0,completed=gate();const entered=gate(),release=gate();
    const global=path.join(game,'config.cfg'),local=path.join(profile,'config_local.cfg'),inspect=vi.fn(async(s:SourceIdentity)=>({...await processFacts(),pid:s.processId}));
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,
      file:async(filename,limit,signal)=>{if(filename.endsWith('game.log.txt'))logReads++;return readStableFile(filename,limit,signal);},
      metadata:{realpath:async filename=>{if(hold&&filename===global&&stage!=='stat'){entered.resolve();await release.promise;if(stage==='retired-error')throw new Error('Retired metadata failed');}return realpath(filename);},
        stat:async filename=>{if(hold&&filename===global){globalStats++;if(stage==='stat'){entered.resolve();await release.promise;}}if(hold&&filename===local){await entered.promise;throw new Error('Independent metadata failed');}return stat(filename,{bigint:true});}}});
    const observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<void>|undefined,drain:Promise<void>|undefined,latest:Promise<unknown>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const token=observer.status().token;
      now=5_000_000_000n;hold=true;completed=gate();pending=m.refresh(true);await entered.promise;await completed.promise;
      expect(m.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
      expect(m.refresh(true)).toBe(pending);expect(m.refresh()).toBe(pending);
      let drained=false;drain=r.drain().then(()=>{drained=true;});const reads=logReads;
      const first=r.read({...source,processId:456},'1',created+10000,new AbortController().signal).catch(error=>error);
      latest=r.read({...source,processId:789},'1',created+10000,new AbortController().signal).catch(error=>error);await first;
      expect(drained).toBe(false);expect(logReads).toBe(reads);expect(inspect).toHaveBeenCalledOnce();
      m.close();observer.close();const retiredToken=observer.status().token;release.resolve();await drain;await pending;await latest;
      expect(observer.status().token).toBe(retiredToken);expect(m.evidence().assessment.state).toBe('unknown');if(stage!=='stat')expect(globalStats).toBe(0);
    }finally{m.close();observer.close();release.resolve();await drain;await pending;await latest;}
  });
  it.each(['superseded','guard-error','deadline','log-change','profile-change'] as const)('distinguishes same-source supersession from a required %s failure',async mode=>{
    vi.useFakeTimers();let now=0n,hold=false,held=false;const entered=gate(),release=gate(),completed=gate();
    const changes:HardModeObservation[]=[],r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      file:async(filename,limit,signal)=>{
        if(hold&&!held&&filename.endsWith('game.log.txt')){held=true;entered.resolve();await release.promise;if(mode==='guard-error')throw new Error('Independent guard failed');}
        return readStableFile(filename,limit,signal);
      }});
    const observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).finally(()=>completed.resolve()),value=>changes.push(value),()=>now);
    r.onInvalidate(()=>m.invalidate());const current={source,clockId:'clock',monotonicNs:'1'};
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();
      expect(m.evidence().assessment.state).toBe('pass');const baseline=changes.length,token=observer.status().token;
      hold=true;void observer.boundary();await entered.promise;const replacement=observer.boundary();
      expect(observer.evidence()).toBeUndefined();expect(observer.status()).toEqual({phase:'pending',token});
      if(mode==='deadline'){
        for(let hint=1;hint<=3;hint++){now=BigInt(hint)*500_000_000n;await vi.advanceTimersByTimeAsync(500);void observer.boundary();}
        now=2_000_000_002n;await vi.advanceTimersByTimeAsync(500);
      }
      if(mode==='log-change')await writeFile(path.join(game,'game.log.txt'),header+selection);
      if(mode==='profile-change')await writeFile(path.join(game,'game.log.txt'),header+selection+save()+selection+save());
      release.resolve();await replacement;
      if(mode==='superseded'){
        now=2n;observer.select({...bound,boundary:{clockId:'clock',probeSentClientNs:'2',receivedSourceNs:'3'}});
        expect(observer.status()).toEqual({phase:'admitted',token});expect(changes.slice(baseline)).toEqual([]);expect(m.evidence().assessment.state).toBe('pass');
      }else{expect(changes.slice(baseline).some(value=>value.assessment.state==='unknown')).toBe(true);expect(observer.status().token).not.toBe(token);}
    }finally{release.resolve();m.close();observer.close();await r.drain();}
  });
  it('allows the initial settings consumer to inspect the process after a pre-snapshot checkpoint tail guard',async()=>{
    vi.useFakeTimers();let now=0n;const completed=gate(),inspect=vi.fn(processFacts);
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now}),observer=new ProfileObserver(()=>r,()=>now,false);
    const m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).finally(()=>completed.resolve()),undefined,()=>now);
    const current={source,clockId:'clock',monotonicNs:'1'};
    try{
      void observer.boundary();observer.select(current);m.select(current);await completed.promise;
      expect(inspect).toHaveBeenCalledOnce();await observer.refresh();now=1n;
      const next={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(next);m.select(next);await m.refresh();
      expect(m.evidence().assessment.state).toBe('pass');expect(observer.evidence()).toBeDefined();
    }finally{m.close();observer.close();}
  });
  it('does not let a standalone cold tail guard launch inspection or occupy the full verification slot',async()=>{
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect}),signal=new AbortController().signal;
    const tail=r.resolveProfile(source,created+10000,signal,true);
    await expect(tail).rejects.toThrow('unavailable for tail guard');expect(inspect).not.toHaveBeenCalled();
    expect((await read(r)).assessment.state).toBe('pass');
    expect((await r.resolveProfile(source,created+10000,signal,true)).binding).toMatch(/^[a-f0-9]{64}$/);expect(inspect).toHaveBeenCalledOnce();
  });
  it('does not let a cached older boundary cancel queued full verification while a retired process drains',async()=>{
    const entered=gate(),release=gate();let active=0,maximum=0;
    const inspect=vi.fn(async(s:SourceIdentity)=>{maximum=Math.max(maximum,++active);try{if(s.processId===456){entered.resolve();await release.promise;}return {...await processFacts(),pid:s.processId};}finally{active--;}});
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect}),signal=new AbortController().signal;
    await read(r);const retired=r.read({...source,processId:456},'1',created+10000,signal),failed=expect(retired).rejects.toThrow();await entered.promise;
    const queued=r.read({...source,processId:789},'1',created+10000,signal);
    try{
      await expect(r.resolveProfile(source,created+10000,signal,true)).rejects.toThrow('unavailable for tail guard');
      release.resolve();await failed;expect((await queued).assessment.state).toBe('pass');expect(inspect).toHaveBeenCalledTimes(3);expect(maximum).toBe(1);
    }finally{release.resolve();await queued.catch(()=>undefined);}
  });
  it('reads settings initially, on change and at sixty seconds, with one successful inspection per lifetime',async()=>{
    let now=0n,configReads=0;
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,
      file:async(filename,limit,signal)=>{if(!filename.endsWith('game.log.txt'))configReads++;return readStableFile(filename,limit,signal);}});
    expect((await read(r)).assessment.state).toBe('pass');expect(configReads).toBe(3);
    for(let second=1;second<60;second++){now=BigInt(second)*1_000_000_000n;await appendFile(path.join(game,'game.log.txt'),'Unrelated append\n');expect((await read(r)).assessment.state).toBe('pass');}
    expect(configReads).toBe(3);expect(inspect).toHaveBeenCalledOnce();
    now=60_000_000_000n;await read(r);expect(configReads).toBe(6);
    await writeSettingsChange(path.join(profile,'config.cfg'),HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));
    expect((await read(r)).assessment.state).toBe('fail');expect(configReads).toBe(9);expect(inspect).toHaveBeenCalledOnce();
  });
  it('uses positioned incremental reads through split UTF-8/lines and a log growing beyond four MiB',async()=>{
    const reads:{offset:number;bytes:number}[]=[],tail=new ProfileLogTail((offset,bytes)=>reads.push({offset,bytes})),signal=new AbortController().signal;
    const filename=path.join(game,'game.log.txt'),initial=await tail.read(filename,signal),prefix=Buffer.byteLength(header+selection+save());
    expect(initial.profile).toMatchObject({profile:id,generation:2});
    await tail.read(filename,signal);expect(reads).toEqual([{offset:0,bytes:prefix}]);
    const unicode=Buffer.from('Unrelated Привет\n'),split=unicode.indexOf(Buffer.from('П'))+1;
    await appendFile(filename,unicode.subarray(0,split));expect((await tail.read(filename,signal)).profile).toEqual(initial.profile);
    await appendFile(filename,unicode.subarray(split));expect((await tail.read(filename,signal)).profile).toEqual(initial.profile);
    const chunk=('x'.repeat(8190)+'\n').repeat(32);
    for(let n=0;n<17;n++){await appendFile(filename,chunk);expect((await tail.read(filename,signal)).profile).toEqual(initial.profile);}
    expect(reads.reduce((sum,read)=>sum+read.bytes,0)).toBe(prefix+unicode.length+Buffer.byteLength(chunk)*17);
    expect(reads.slice(1).every(read=>read.offset>=prefix&&read.bytes<=64*1024)).toBe(true);
    await appendFile(filename,selection);expect((await tail.read(filename,signal)).profile).toBeNull();
    await appendFile(filename,save());expect((await tail.read(filename,signal)).profile).toMatchObject({generation:4});
    await rename(filename,filename+'.old');await writeFile(filename,header+selection+save());await expect(tail.read(filename,signal)).rejects.toThrow('replaced');
    expect((await tail.read(filename,signal)).profile).toMatchObject({generation:2});
    await writeFile(filename,header);await expect(tail.read(filename,signal)).rejects.toThrow('truncated');
    const parser=new ProfileLogParser();expect(()=>parser.push(Buffer.alloc(8193,120))).toThrow('line');
    await writeFile(filename,'x'.repeat(4*1024*1024+1));await expect(new ProfileLogTail().read(filename,signal)).rejects.toThrow('catch-up');
  });
  it('retries failed inspection at 5/15/30/60 seconds, caps starts across lifetimes and caches recovery',async()=>{
    let now=0n,recover=false;const inspect=vi.fn(()=>recover?processFacts():Promise.resolve(null));
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now});
    const attempt=()=>read(r).catch(()=>undefined);
    await attempt();expect(inspect).toHaveBeenCalledTimes(1);
    for(const [before,due,count] of [[4,5,2],[19,20,3],[49,50,4],[109,110,5]] as const){now=BigInt(before)*1_000_000_000n;await attempt();expect(inspect).toHaveBeenCalledTimes(count-1);now=BigInt(due)*1_000_000_000n;await attempt();expect(inspect).toHaveBeenCalledTimes(count);}
    for(let index=0;index<3;index++)await r.read({...source,processId:200+index},'1',created+10000,new AbortController().signal).catch(()=>undefined);
    now=170_000_000_000n;await attempt();expect(inspect).toHaveBeenCalledTimes(8);
    now=300_000_000_000n;recover=true;expect((await read(r)).assessment.state).toBe('pass');expect(inspect).toHaveBeenCalledTimes(9);
    now=400_000_000_000n;expect((await read(r)).assessment.state).toBe('pass');expect(inspect).toHaveBeenCalledTimes(9);
  });
  it('manual refresh bypasses the automatic guard interval, coalesces and starts at most once per second',async()=>{
    let now=0n;const {evaluateHardMode,parseHardModeConfig}=await import('../../packages/telemetry-core/src/hard-mode');
    const result={assessment:evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),1000,'fixture'),binding:'a'.repeat(64),pluginSessionId:source.pluginSessionId,sourceMonotonicNs:'1'};
    let finish!:()=>void;const full=vi.fn(),scan=vi.fn((_s:SourceIdentity,_ns:string,_at:number,_signal:AbortSignal,force?:boolean)=>scan.mock.calls.length===1?Promise.resolve(result):new Promise<HardModeObservation>(done=>{expect(force).toBe(true);finish=()=>done(result);}));
    const m=new HardModeMonitor(scan,undefined,()=>now,full),current={source,clockId:'clock',monotonicNs:'1'};
    m.select(current);await Promise.resolve();now=1n;m.select({...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}});await m.refresh();
    now=100_000_000n;const a=m.refresh(true),b=m.refresh(true);expect(a).toBe(b);expect(full).toHaveBeenCalledOnce();expect(scan).toHaveBeenCalledTimes(2);finish();await a;
    now=900_000_000n;await m.refresh(true);expect(scan).toHaveBeenCalledTimes(2);
    now=1_100_000_000n;const c=m.refresh(true);expect(scan).toHaveBeenCalledTimes(3);finish();await c;m.close();
  });
  it('latches one manual full read after a cached reconnect has drained but awaits causal binding',async()=>{
    let now=0n,configReads=0,active=0,maximum=0,completed=gate();
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,
      file:async(filename,limit,signal)=>{maximum=Math.max(maximum,++active);try{if(!filename.endsWith('game.log.txt'))configReads++;return await readStableFile(filename,limit,signal);}finally{active--;}}});
    const observer=new ProfileObserver(()=>r,()=>now,false),scan=vi.fn((s:SourceIdentity,ns:string,at:number,signal:AbortSignal,force?:boolean)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()));
    const m=new HardModeMonitor(scan,undefined,()=>now,()=>r.requestFull(),undefined,undefined,()=>r.drain()),current={source,clockId:'clock',monotonicNs:'1'};
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();await r.drain();
      expect(m.evidence().assessment.state).toBe('pass');expect(configReads).toBe(3);
      now=5_000_000_000n;observer.select(null);m.select(null);completed=gate();observer.select(current);m.select(current);
      await completed.promise;await observer.refresh();await r.drain();expect(configReads).toBe(3);
      const pending=m.refresh(true);expect(m.refresh(true)).toBe(pending);expect(m.refresh(true)).toBe(pending);
      expect(scan).toHaveBeenCalledTimes(2);now++;
      const rebound={...current,boundary:{clockId:'clock',probeSentClientNs:now.toString(),receivedSourceNs:'3'}};observer.select(rebound);m.select(rebound);
      await pending;await r.drain();expect(configReads).toBe(6);expect(scan).toHaveBeenCalledTimes(3);expect(scan.mock.calls[2][4]).toBe(true);
      expect(inspect).toHaveBeenCalledOnce();expect(maximum).toBe(3);expect(m.evidence().assessment.state).toBe('pass');
    }finally{m.close();observer.close();await r.drain();}
  });
  it('requires a later causal probe for a changed profile found by the latched manual follow-up',async()=>{
    let now=0n,configReads=0,completed=gate();const forcedDone=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      file:async(filename,limit,signal)=>{if(!filename.endsWith('game.log.txt'))configReads++;return readStableFile(filename,limit,signal);}}),observer=new ProfileObserver(()=>r,()=>now,false);
    const scan=vi.fn((s:SourceIdentity,ns:string,at:number,signal:AbortSignal,force?:boolean)=>observer.readSettings(r,s,ns,at,signal,force).then(value=>{completed.resolve();if(force)forcedDone.resolve();return value;}));
    const m=new HardModeMonitor(scan,undefined,()=>now,()=>r.requestFull(),()=>r.canRetain(),undefined,()=>r.drain()),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const initial={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(initial);m.select(initial);await m.refresh();
      expect(m.evidence().assessment.state).toBe('pass');const original=m.evidence().binding;
      now=5_000_000_000n;observer.select(null);m.select(null);completed=gate();observer.select(current);m.select(current);await completed.promise;await observer.refresh();await r.drain();
      const pending=m.refresh(true);await appendFile(path.join(game,'game.log.txt'),selection+save());now++;
      const oldProbe={...current,boundary:{clockId:'clock',probeSentClientNs:now.toString(),receivedSourceNs:'3'}};observer.select(oldProbe);m.select(oldProbe);
      await forcedDone.promise;await r.drain();await observer.refresh();expect(configReads).toBe(6);expect(m.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();
      now++;const later={...current,boundary:{clockId:'clock',probeSentClientNs:now.toString(),receivedSourceNs:'4'}};observer.select(later);m.select(later);await pending;
      expect(m.evidence().assessment.state).toBe('pass');expect(m.evidence().binding).not.toBe(original);expect(m.evidence().sourceMonotonicNs).toBe('5');expect(scan).toHaveBeenCalledTimes(3);
    }finally{m.close();observer.close();await r.drain();}
  });
  it('drains the physical reader before one forced follow-up and joins clicks throughout forced work',async()=>{
    const finished=gate(),physical=gate(),forcedEntered=gate(),forced=gate<HardModeObservation>();let now=0n;
    const result=unknownObservation();
    const scan=vi.fn((_s:SourceIdentity,_ns:string,_at:number,_signal:AbortSignal,force?:boolean)=>{if(scan.mock.calls.length===1){finished.resolve();return Promise.resolve(result);}expect(force).toBe(true);forcedEntered.resolve();return forced.promise;});
    const drain=vi.fn(()=>drain.mock.calls.length===1?physical.promise:Promise.resolve()),m=new HardModeMonitor(scan,undefined,()=>now,undefined,undefined,undefined,drain);
    try{
      m.select({source,clockId:'clock',monotonicNs:'1'});await finished.promise;
      const pending=m.refresh(true);expect(m.refresh(true)).toBe(pending);await Promise.resolve();expect(scan).toHaveBeenCalledOnce();
      now=100n;physical.resolve();await physical.promise;
      await forcedEntered.promise;
      expect(m.refresh(true)).not.toBeUndefined();expect(m.refresh(true)).toBe(m.refresh(true));expect(scan).toHaveBeenCalledTimes(2);
      forced.resolve(result);await pending;expect(scan).toHaveBeenCalledTimes(2);expect(drain).toHaveBeenCalledTimes(2);
    }finally{physical.resolve();forced.resolve(result);m.close();}
  });
  it('coalesces cooldown clicks into one nonresetting timer and preserves the one-second start limit',async()=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const scan=vi.fn<ConstructorParameters<typeof HardModeMonitor>[0]>(()=>Promise.resolve(unknownObservation()));
    const m=new HardModeMonitor(scan,undefined,now);
    try{
      m.select({source,clockId:'clock',monotonicNs:'1'});await m.refresh();await vi.advanceTimersByTimeAsync(100);await m.refresh(true);
      expect(scan).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(400);await m.refresh(true);await m.refresh(true);expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(400);await m.refresh(true);expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(199);expect(scan).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);expect(scan).toHaveBeenCalledTimes(3);expect(scan.mock.calls[2]).toHaveLength(5);expect(vi.getTimerCount()).toBe(0);
    }finally{m.close();expect(vi.getTimerCount()).toBe(0);}
  });
  it.each(['close','detach','replace'] as const)('retires manual cooldown intent on %s',async ending=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const scan=vi.fn(()=>Promise.resolve(unknownObservation())),m=new HardModeMonitor(scan,undefined,now);
    m.select({source,clockId:'clock',monotonicNs:'1'});await m.refresh();await m.refresh(true);await vi.advanceTimersByTimeAsync(100);await m.refresh(true);
    expect(vi.getTimerCount()).toBe(1);
    if(ending==='close')m.close();else m.select(ending==='detach'?null:{source:{...source,processId:456},clockId:'other-clock',monotonicNs:'1'});
    await m.refresh();const count=scan.mock.calls.length;await vi.advanceTimersByTimeAsync(2000);expect(scan).toHaveBeenCalledTimes(count);expect(vi.getTimerCount()).toBe(0);m.close();
  });
  it.each(['close','detach','replace'] as const)('retires queued manual intent while the old physical operation drains on %s',async ending=>{
    const physical=gate(),entered=gate(),result=unknownObservation();
    const scan=vi.fn<ConstructorParameters<typeof HardModeMonitor>[0]>(()=>{entered.resolve();return Promise.resolve(result);}),drain=vi.fn(()=>drain.mock.calls.length===1?physical.promise:Promise.resolve()),m=new HardModeMonitor(scan,undefined,()=>0n,undefined,undefined,undefined,drain);
    try{
      m.select({source,clockId:'clock',monotonicNs:'1'});await entered.promise;const pending=m.refresh(true);
      if(ending==='close')m.close();else m.select(ending==='detach'?null:{source:{...source,processId:456},clockId:'other-clock',monotonicNs:'1'});
      expect(scan).toHaveBeenCalledOnce();physical.resolve();await pending;await m.refresh();
      expect(scan).toHaveBeenCalledTimes(ending==='replace'?2:1);expect(scan.mock.calls.every(call=>call[4]!==true)).toBe(true);
    }finally{physical.resolve();m.close();}
  });
  it('accepts new-epoch manual intent while a retired forced operation still owns physical drain',async()=>{
    const physical=gate(),forcedEntered=gate();let now=0n;
    const scan=vi.fn((_s:SourceIdentity,_ns:string,_at:number,_signal:AbortSignal,force?:boolean)=>{if(force)forcedEntered.resolve();return Promise.resolve(unknownObservation());});
    const drain=vi.fn(()=>drain.mock.calls.length===2?physical.promise:Promise.resolve()),m=new HardModeMonitor(scan,undefined,()=>now,undefined,undefined,undefined,drain);
    try{
      m.select({source,clockId:'clock',monotonicNs:'1'});await m.refresh();now=1_000_000_000n;const retired=m.refresh(true);await forcedEntered.promise;
      m.select({source:{...source,processId:456},clockId:'new-clock',monotonicNs:'1'});now=2_000_000_000n;void m.refresh(true);expect(scan).toHaveBeenCalledTimes(2);
      physical.resolve();await retired;await m.refresh();expect(scan).toHaveBeenCalledTimes(3);expect(scan.mock.calls[2][0].processId).toBe(456);expect(scan.mock.calls[2][4]).toBe(true);
    }finally{physical.resolve();m.close();}
  });
  it('detects changes five seconds after attachment between timer ticks while memory health performs no reads or audit writes',async()=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const {evaluateHardMode,parseHardModeConfig}=await import('../../packages/telemetry-core/src/hard-mode');
    let config=HARD_MODE_CONFIG;
    const audit=vi.fn(),health=vi.fn(),scan=vi.fn(()=>Promise.resolve({assessment:evaluateHardMode(parseHardModeConfig(config),Date.now(),'fixture'),binding:'a'.repeat(64),pluginSessionId:source.pluginSessionId,sourceMonotonicNs:'1'}));
    const m=new HardModeMonitor(scan,audit,now,undefined,undefined,health),current={source,clockId:'clock',monotonicNs:'1'};
    m.start();await vi.advanceTimersByTimeAsync(10);m.select(current);await Promise.resolve();await vi.advanceTimersByTimeAsync(1);m.select({...current,boundary:{clockId:'clock',probeSentClientNs:now().toString(),receivedSourceNs:'2'}});await m.refresh();
    const before=audit.mock.calls.length;config=HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"');
    await vi.advanceTimersByTimeAsync(4998);expect(scan).toHaveBeenCalledOnce();expect(audit).toHaveBeenCalledTimes(before);expect(health).toHaveBeenCalledTimes(5);expect(m.evidence().assessment.state).toBe('pass');
    await vi.advanceTimersByTimeAsync(1);expect(scan).toHaveBeenCalledTimes(2);expect(m.evidence().assessment.state).toBe('fail');m.close();
  });
  it('waits for a held guard to drain without busy rearming and does not resurrect timers after close',async()=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n,held=gate<HardModeObservation>();
    const scan=vi.fn(()=>held.promise),m=new HardModeMonitor(scan,undefined,now);
    m.start();await vi.advanceTimersByTimeAsync(10);m.select({source,clockId:'clock',monotonicNs:'1'});const work=m.refresh();
    await vi.advanceTimersByTimeAsync(15000);expect(scan).toHaveBeenCalledOnce();
    m.close();expect(vi.getTimerCount()).toBe(0);held.resolve(m.evidence());await work;await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);expect(scan).toHaveBeenCalledOnce();
  });
  it.each(['timeout','failed','invalid'] as const)('reports only a fixed process-query code for %s',async kind=>{
    vi.useFakeTimers();
    const diagnostics:ProfileDiagnostic[]=[];
    const child=Object.assign(new EventEmitter(),{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:vi.fn()});
    const launch=vi.fn((_file:unknown,args:unknown,options:unknown)=>{expect(args).toEqual(['--inspect-profile-process']);expect(options).toMatchObject({windowsHide:true,stdio:'pipe'});return child;}) as unknown as typeof import('node:child_process').spawn;
    const target={source,processCreationTime:(BigInt(created)*10000n+116444736000000000n).toString(),userTag:'a'.repeat(64)};
    let settled=false;const work=inspectGameProcess(source,new AbortController().signal,value=>diagnostics.push(value),{executable:'C:/Synthetic/client.exe',target},launch).then(value=>{settled=true;return value;});
    if(kind==='timeout'){await vi.advanceTimersByTimeAsync(2000);expect(child.kill).toHaveBeenCalledOnce();expect(settled).toBe(false);}
    if(kind==='invalid')child.stdout.write(Buffer.from([1,0,0,0,0]));
    child.emit('close',kind==='invalid'?0:1);
    expect(await work).toBeNull();
    expect(diagnostics).toEqual([{code:kind==='timeout'?'PROFILE_PROCESS_QUERY_DEADLINE':kind==='failed'?'PROFILE_PROCESS_QUERY_FAILED':'PROFILE_PROCESS_QUERY_INVALID'}]);
  });
  it.each((['ets2','ats'] as const).flatMap(game=>[null,'C:\\Synthetic Профиль\\Дом'].map(homeDirectory=>({game,homeDirectory}))))('accepts a fragmented $game receipt with home $homeDirectory only after child close',async({game,homeDirectory})=>{
    const h=nativeInspection(game),receipt={...h.receipt,homeDirectory},bytes=nativeFrame(receipt);
    try{
      const request=h.child.stdin.read() as Buffer;
      expect(request.readUInt32LE()).toBe(request.length-4);expect(JSON.parse(request.subarray(4).toString('utf8'))).toEqual(h.target);
      const split=homeDirectory?bytes.indexOf(Buffer.from('П'))+1:11;
      for(const chunk of [bytes.subarray(0,1),bytes.subarray(1,3),bytes.subarray(3,split),bytes.subarray(split,bytes.length-1),bytes.subarray(-1)])h.child.stdout.write(chunk);
      h.child.stdout.end();h.child.emit('exit',0);await Promise.resolve();expect(h.settled()).toBe(false);
      h.child.emit('close',0);
      expect(await h.work).toEqual({pid:source.processId,createdUtcMs:created,executable:receipt.executable,homeDirectory});expect(h.diagnostics).toEqual([]);expect(h.child.kill).not.toHaveBeenCalled();
    }finally{h.child.emit('close',0);await h.work;}
  });
  it.each(['abort','deadline','kill'] as const)('keeps ownership after %s until actual native child close',async ending=>{
    vi.useFakeTimers();const h=nativeInspection();
    try{
      h.child.stdout.write(nativeFrame(h.receipt));
      if(ending==='abort')h.controller.abort();else if(ending==='deadline')await vi.advanceTimersByTimeAsync(2000);else h.child.kill();
      h.child.emit('exit',0);await Promise.resolve();expect(h.settled()).toBe(false);expect(h.child.kill).toHaveBeenCalledOnce();
      h.child.emit('close',0);const result=await h.work;
      if(ending==='kill'){expect(result).toMatchObject({pid:source.processId});expect(h.diagnostics).toEqual([]);}
      else{expect(result).toBeNull();expect(h.diagnostics).toEqual([{code:ending==='abort'?'PROFILE_CANCELLED':'PROFILE_PROCESS_QUERY_DEADLINE'}]);}
      expect(vi.getTimerCount()).toBe(0);
    }finally{h.child.emit('close',0);await h.work;}
  });
  it.each(['target-process','target-session','target-instance','target-plugin','target-game','target-origin','target-created','target-user','target-extra','target-missing','source-extra','source-missing',
    'missing-key','extra-key','wrong-type','wrong-version','relative-executable','wrong-executable','long-executable','relative-home','empty-home','wrong-home','long-home',
    'invalid-utf8','invalid-json','zero-length','oversize-length','oversize-output','short-prefix','short-payload','trailing-bytes','non-bytes'] as const)('rejects %s receipt without exposing output or settling before close',async kind=>{
    const h=nativeInspection(),receipt:Record<string,unknown>=structuredClone(h.receipt),target=receipt.target as Record<string,unknown>,peer=target.source as Record<string,unknown>;
    let frame:Buffer;
    switch(kind){
      case 'target-process':peer.processId=456;break;
      case 'target-session':peer.windowsSessionId=2;break;
      case 'target-instance':peer.processInstanceId='10000000-0000-4000-8000-000000000002';break;
      case 'target-plugin':peer.pluginSessionId='20000000-0000-4000-8000-000000000002';break;
      case 'target-game':peer.game='ats';break;
      case 'target-origin':peer.origin='replay';break;
      case 'target-created':target.processCreationTime=(BigInt(h.target.processCreationTime)+1n).toString();break;
      case 'target-user':target.userTag='b'.repeat(64);break;
      case 'target-extra':target.extra=true;break;
      case 'target-missing':delete target.userTag;break;
      case 'source-extra':peer.extra=true;break;
      case 'source-missing':delete peer.pluginSessionId;break;
      case 'missing-key':delete receipt.homeDirectory;break;
      case 'extra-key':receipt.commandLine='private fixture text';break;
      case 'wrong-type':receipt.type='other';break;
      case 'wrong-version':receipt.schemaVersion=2;break;
      case 'relative-executable':receipt.executable='eurotrucks2.exe';break;
      case 'wrong-executable':receipt.executable='C:\\Synthetic\\amtrucks.exe';break;
      case 'long-executable':receipt.executable='C:\\'+'x'.repeat(8192)+'\\eurotrucks2.exe';break;
      case 'relative-home':receipt.homeDirectory='relative';break;
      case 'empty-home':receipt.homeDirectory='';break;
      case 'wrong-home':receipt.homeDirectory=42;break;
      case 'long-home':receipt.homeDirectory='C:\\'+'x'.repeat(4096);break;
    }
    frame=nativeFrame(receipt);
    switch(kind){
      case 'invalid-utf8':frame=nativeFrame(Buffer.from([0xc3,0x28]));break;
      case 'invalid-json':frame=nativeFrame(Buffer.from('{private fixture text'));break;
      case 'zero-length':frame=Buffer.alloc(4);break;
      case 'oversize-length':frame=Buffer.alloc(4);frame.writeUInt32LE(16385);break;
      case 'oversize-output':frame=Buffer.alloc(16389);break;
      case 'short-prefix':frame=frame.subarray(0,3);break;
      case 'short-payload':frame=frame.subarray(0,frame.length-1);break;
      case 'trailing-bytes':frame=Buffer.concat([frame,Buffer.from([0])]);break;
    }
    try{
      h.child.stderr.write('private fixture stderr');
      if(kind==='non-bytes')h.child.stdout.emit('data','private fixture text');else h.child.stdout.write(frame);
      h.child.emit('exit',0);await Promise.resolve();expect(h.settled()).toBe(false);
      h.child.emit('close',0);expect(await h.work).toBeNull();expect(h.diagnostics).toEqual([{code:'PROFILE_PROCESS_QUERY_INVALID'}]);
    }finally{h.child.emit('close',0);await h.work;}
  });
  it('drains a held old process read, rejects late proof after close, and verifies again after full reader restart',async()=>{
    vi.useFakeTimers();let now=0n,active=0,maximum=0,calls=0,entered=gate(),release=gate(),done=gate();
    const inspect=vi.fn(async(s:SourceIdentity)=>{maximum=Math.max(maximum,++active);const call=++calls;
      try{if(call===1||call===3){entered.resolve();await release.promise;}return {...await processFacts(),pid:s.processId,createdUtcMs:created+(s.processId===123?0:s.processId===456?1000:2000)};}finally{active--;}});
    const options={documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now};let r=new HardModeReader(options),observer=new ProfileObserver(()=>r,()=>now,false);
    let m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{done.resolve();return value;}),undefined,()=>now);
    const initial={source,clockId:'old-clock',monotonicNs:'1'};observer.select(initial);m.select(initial);const old=m.refresh();await entered.promise;
    now=100_000_000n;await rename(path.join(game,'game.log.txt'),path.join(game,'held-old.log'));await writeFile(path.join(game,'game.log.txt'),header.replace('12:00:00','12:00:01')+selection+save());
    const next={source:{...source,processId:456,processInstanceId:'10000000-0000-4000-8000-000000000002',pluginSessionId:'20000000-0000-4000-8000-000000000002'},clockId:'new-clock',monotonicNs:'1'};
    observer.select(next);m.select(next);await old;release.resolve();await done.promise;await observer.refresh();now++;
    const bound={...next,boundary:{clockId:next.clockId,probeSentClientNs:now.toString(),receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();
    expect(observer.evidence()?.pluginSessionId).toBe(next.source.pluginSessionId);expect(calls).toBe(2);expect(maximum).toBe(1);
    now=200_000_000n;entered=gate();release=gate();done=gate();await rename(path.join(game,'game.log.txt'),path.join(game,'second-old.log'));await writeFile(path.join(game,'game.log.txt'),header.replace('12:00:00','12:00:02')+selection+save());
    const third={...next,source:{...next.source,processId:789,pluginSessionId:'20000000-0000-4000-8000-000000000003'},clockId:'third-clock'};
    observer.select(third);m.select(third);const closing=m.refresh();await entered.promise;m.close();observer.close();release.resolve();await closing;
    expect(observer.evidence()).toBeUndefined();expect(m.evidence().assessment.state).toBe('unknown');
    r=new HardModeReader(options);observer=new ProfileObserver(()=>r,()=>now,false);done=gate();
    m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{done.resolve();return value;}),undefined,()=>now);
    observer.select(third);m.select(third);const restarted=m.refresh();await done.promise;await observer.refresh();now++;
    const fresh={...third,boundary:{clockId:third.clockId,probeSentClientNs:now.toString(),receivedSourceNs:'3'}};observer.select(fresh);m.select(fresh);await restarted;
    expect(observer.evidence()?.pluginSessionId).toBe(third.source.pluginSessionId);expect(m.evidence().assessment.state).toBe('pass');expect(calls).toBe(4);expect(maximum).toBe(1);m.close();observer.close();
  });
  it('reports bounded private rejection transitions anew for every epoch and retains unchanged admitted proof',async()=>{
    vi.useFakeTimers();let now=0n;const output:(ProfileDiagnostic & {count:number;epoch:number})[]=[],diagnostic=coalesceProfileDiagnostics(value=>output.push(value));
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,diagnostic});
    const observer=new ProfileObserver(()=>r,()=>now,false,diagnostic),current={source,clockId:'clock',monotonicNs:'1'};
    observer.select(current);await observer.refresh();now=1n;observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}});
    expect(observer.evidence()).toBeDefined();now=3_000_000_001n;expect(observer.evidence()).toBeDefined();expect(output.at(-1)?.code).toBe('PROFILE_ADMITTED');
    for(let n=0;n<2;n++){
      diagnostic({code:'PROFILE_EPOCH_RETIRED'});
      diagnostic({code:'PROFILE_SELECTION_UNPROVEN'});diagnostic({code:'PROFILE_SELECTION_UNPROVEN'});diagnostic({code:'PROFILE_SELECTION_UNPROVEN'});
    }
    expect(output.filter(v=>v.code==='PROFILE_SELECTION_UNPROVEN' && v.count===1)).toHaveLength(2);
    for(const value of output){expect(Object.keys(value).every(key=>['code','count','epoch','durationMs'].includes(key))).toBe(true);expect(value.code).toMatch(/^PROFILE_[A-Z_]+$/);}
    expect(JSON.stringify(output)).not.toContain(name);expect(JSON.stringify(output)).not.toContain(id);expect(JSON.stringify(output)).not.toContain(root);
    observer.close();
  });
  it('does not multiply physical scans on fresh/stale/null oscillation of the same lifetime and recovers after loading',async()=>{
    vi.useFakeTimers();let now=0n,done=gate();
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now});
    const observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{done.resolve();return value;},error=>{done.resolve();throw error;}),undefined,()=>now);
    const current={source,clockId:'clock',monotonicNs:'1'};observer.select(current);m.select(current);const initial=m.refresh();await done.promise;await observer.refresh();
    now=1n;const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await initial;
    for(let n=1;n<=9;n++){now=BigInt(n)*100_000_000n;observer.select(null);m.select(null);observer.select(current);m.select(current);await m.refresh();await observer.refresh();}
    expect(inspect).toHaveBeenCalledTimes(1);expect(observer.evidence()).toBeUndefined();
    await writeFile(path.join(game,'game.log.txt'),header+selection+save()+'New profile selected: '+JSON.stringify(name)+'\n');
    now=5_000_000_000n;done=gate();const loading=m.refresh();await done.promise;await loading;await observer.refresh();expect(observer.evidence()).toBeUndefined();
    await writeFile(path.join(game,'game.log.txt'),header+selection+save()+'New profile selected: '+JSON.stringify(name)+'\n'+save());
    now=10_000_000_000n;done=gate();const ready=m.refresh();await done.promise;await observer.refresh();now++;
    const next={...current,boundary:{clockId:'clock',probeSentClientNs:now.toString(),receivedSourceNs:'3'}};observer.select(next);m.select(next);await ready;
    expect(observer.evidence()).toBeDefined();expect(m.evidence().assessment.state).toBe('pass');expect(inspect).toHaveBeenCalledTimes(1);
    m.close();observer.close();
  });
  it('starts a fresh process epoch while the previous process is still waiting for its causal probe', async () => {
    vi.useFakeTimers(); let now = 0n, currentCreated = created;
    const inspect = vi.fn(async (s: SourceIdentity) => ({...await processFacts(), pid: s.processId, createdUtcMs: currentCreated}));
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect, nowNs: () => now});
    const observer = new ProfileObserver(() => r, () => now, false);
    let readDone = gate(), readFailure: unknown;
    const monitor = new HardModeMonitor((s, ns, at, signal) => observer.readSettings(r, s, ns, at, signal).then(value => {readDone.resolve(); return value;}, error => {readFailure = error; readDone.resolve(); throw error;}), undefined, () => now);
    const initial = {source, clockId: 'first-clock', monotonicNs: '1'};
    observer.select(initial); monitor.select(initial); const old = monitor.refresh();
    await readDone.promise; await observer.refresh(); expect(inspect).toHaveBeenCalledTimes(1);
    now = 100_000_000n; currentCreated = created + 1000;
    await rename(path.join(game, 'game.log.txt'), path.join(game, 'previous.log.txt'));
    await writeFile(path.join(game, 'game.log.txt'), header.replace('12:00:00', '12:00:01') + selection + save());
    const next = {source: {...source, processId: 456, processInstanceId: '10000000-0000-4000-8000-000000000002', pluginSessionId: '20000000-0000-4000-8000-000000000002'}, clockId: 'second-clock', monotonicNs: '1'};
    readDone = gate(); observer.select(next); monitor.select(next); await old;
    // A new process has its own scan cadence; the preceding process's pending probe must not consume it.
    const current = monitor.refresh(); await readDone.promise; await observer.refresh();
    expect(readFailure).toBeUndefined(); expect(inspect).toHaveBeenCalledTimes(2);
    now += 1n;
    const bound = {...next, monotonicNs: '2', boundary: {clockId: next.clockId, probeSentClientNs: now.toString(), receivedSourceNs: '2'}};
    observer.select(bound); monitor.select(bound); await current;
    expect(observer.evidence()?.pluginSessionId).toBe(next.source.pluginSessionId);
    expect(monitor.evidence().pluginSessionId).toBe(next.source.pluginSessionId);
    monitor.close(); observer.close();
  });
  it('shares one successful process inspection across consumers and later scans', async () => {
    const inspect = vi.fn(processFacts), r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect});
    const [settings, identity] = await Promise.all([read(r), r.resolveProfile(source, created + 10000, new AbortController().signal)]);
    expect(settings.assessment.state).toBe('pass'); expect(settings.binding).toBe(identity.binding);
    expect(inspect).toHaveBeenCalledTimes(1);
    await read(r); expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('serializes growing-log reads and retains actual truncation detection', async () => {
    const captured = gate(), release = gate(); let reads = 0;
    const inspect = vi.fn(processFacts), r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect,
      file: async (file, limit, signal) => {
        const value = await readStableFile(file, limit, signal);
        if (file.endsWith('game.log.txt') && ++reads === 1) {captured.resolve(); await release.promise;}
        return value;
      }});
    const a = read(r); await captured.promise;
    await writeFile(path.join(game, 'game.log.txt'), header + selection + save() + 'Ordinary game log append\n');
    const b = r.resolveProfile(source, created + 10000, new AbortController().signal); release.resolve();
    expect((await a).binding).toBe((await b).binding); expect(inspect).toHaveBeenCalledTimes(1);
    await writeFile(path.join(game, 'game.log.txt'), header + selection + save());
    await expect(read(r)).rejects.toThrow('truncated');
  });
  it.each(['missing','encoding','parse','assessment'] as const)('keeps verified profile identity when settings are %s', async failure => {
    if(failure==='missing')await rm(path.join(profile, 'config.cfg'));
    if(failure==='encoding')await writeFile(path.join(profile,'config.cfg'),Buffer.from([0xff]));
    if(failure==='parse')await writeFile(path.join(profile,'config.cfg'),'uset g_fatigue "unsupported-value"');
    if(failure==='assessment')await writeFile(path.join(profile,'config.cfg'),HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));
    const inspect = vi.fn(processFacts), r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect});
    const [settings, identity] = await Promise.allSettled([read(r), r.resolveProfile(source, created + 10000, new AbortController().signal)]);
    if(failure==='missing'||failure==='encoding')expect(settings.status).toBe('rejected');
    else {expect(settings.status).toBe('fulfilled');if(settings.status==='fulfilled')expect(settings.value.assessment.state).toBe(failure==='parse'?'unknown':'fail');}
    expect(identity.status).toBe('fulfilled');
    if (identity.status === 'fulfilled') expect(identity.value.scope).toMatch(/^[0-9a-f]{64}$/);
    expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('cancels one consumer independently and aborts physical work when the last consumer leaves', async () => {
    const entered = gate(), release = gate(); let physicalSignal!: AbortSignal;
    const inspect = vi.fn(async (_source: SourceIdentity, signal: AbortSignal) => {physicalSignal = signal; entered.resolve(); await release.promise; return processFacts();});
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect});
    const a = new AbortController(), b = new AbortController();
    const first = r.read(source, '1', created + 10000, a.signal), firstFailure = expect(first).rejects.toThrow();
    await entered.promise;
    const second = r.resolveProfile(source, created + 10000, b.signal);
    a.abort(); await firstFailure; expect(physicalSignal.aborted).toBe(false);
    const secondFailure = expect(second).rejects.toThrow(); b.abort(); await secondFailure;
    expect(physicalSignal.aborted).toBe(true); release.resolve(); expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('retains the surviving profile consumer and shares the original timing with a late join', async () => {
    const entered = gate(), release = gate(); let now = 0n;
    const inspect = vi.fn(async () => {if (inspect.mock.calls.length === 1) {entered.resolve(); await release.promise;} return processFacts();});
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect, nowNs: () => now});
    const cancelled = new AbortController(), a = r.read(source, '1', created + 10000, cancelled.signal), failed = expect(a).rejects.toThrow();
    await entered.promise; now = 1_500_000_000n;
    const b = r.resolveProfile(source, created + 10000, new AbortController().signal);
    cancelled.abort(); await failed; now = 1_600_000_000n; release.resolve();
    expect((await b).timing).toEqual({startedClientNs: 0n, completedClientNs: now}); expect(inspect).toHaveBeenCalledTimes(1);
  });
  it('retires the old source and bounds pending work until the physical reader has drained', async () => {
    const entered = gate(), release = gate(); let active = 0, maximum = 0;
    const inspect = vi.fn(async (s: SourceIdentity) => {
      maximum = Math.max(maximum, ++active);
      if (inspect.mock.calls.length === 1) {entered.resolve(); await release.promise;}
      active--; return {...await processFacts(), pid: s.processId};
    });
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect});
    const old = read(r), oldFailure = expect(old).rejects.toThrow(); await entered.promise;
    const skipped = r.resolveProfile({...source, processId: 124}, created + 10000, new AbortController().signal), skippedFailure = expect(skipped).rejects.toThrow();
    const latest = r.resolveProfile({...source, processId: 125}, created + 10000, new AbortController().signal);
    await oldFailure; await skippedFailure; expect(inspect).toHaveBeenCalledTimes(1); release.resolve();
    expect((await latest).binding).toMatch(/^[0-9a-f]{64}$/); expect(maximum).toBe(1); expect(inspect).toHaveBeenCalledTimes(2);
  });
  it('shares one production cadence without giving a late consumer a new bind deadline or proof age', async () => {
    vi.useFakeTimers(); let now = 0n;
    const entered = gate(), release = gate(), completed = gate();
    const inspect = vi.fn(async () => {if (inspect.mock.calls.length === 1) {entered.resolve(); await release.promise;} return processFacts();});
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect, nowNs: () => now});
    const observer = new ProfileObserver(() => r, () => now, false);
    observer.select({source, clockId: 'clock', monotonicNs: '1'}); observer.start(); expect(inspect).not.toHaveBeenCalled();
    const original = read(r); await entered.promise; now = 1_500_000_000n;
    const m = new HardModeMonitor((s, ns, at, signal) => {
      return observer.readSettings(r,s,ns,at,signal).then(value => {completed.resolve(); return value;});
    }, undefined, () => now);
    m.select({source, clockId: 'clock', monotonicNs: '1'}); now = 1_600_000_000n; release.resolve();
    await original; await completed.promise; await observer.refresh();
    const bound = {source, clockId: 'clock', monotonicNs: '2', boundary: {clockId: 'clock', probeSentClientNs: '1600000001', receivedSourceNs: '2'}};
    now = 1_900_000_000n; observer.select(bound); m.select(bound); await m.refresh();
    expect(observer.evidence()?.afterMonotonicNs).toBe('3'); expect(m.evidence().sourceMonotonicNs).toBe('3'); expect(inspect).toHaveBeenCalledTimes(1);
    now = 4_600_000_001n; expect(observer.evidence()).toBeDefined(); expect(m.evidence().assessment.state).toBe('pass');
    m.close(); observer.close();
  });
  it('rejects a causal reply after the original shared deadline even before timer callbacks run', async () => {
    vi.useFakeTimers(); let now = 0n;
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: processFacts, nowNs: () => now});
    const value = await r.readTimed(source, '1', created + 10000, new AbortController().signal);
    const observer = new ProfileObserver(() => r, () => now, false);
    observer.select({source, clockId: 'clock', monotonicNs: '1'}); await observer.refresh();
    now = 1_500_000_000n;
    const m = new HardModeMonitor(() => Promise.resolve(value), undefined, () => now);
    m.select({source, clockId: 'clock', monotonicNs: '1'}); await Promise.resolve();
    now = 2_000_000_001n;
    const late = {source, clockId: 'clock', monotonicNs: '2', boundary: {clockId: 'clock', probeSentClientNs: '1900000000', receivedSourceNs: '2'}};
    observer.select(late); m.select(late); await m.refresh();
    expect(observer.evidence()).toBeUndefined(); expect(m.evidence().assessment.state).toBe('unknown');
    m.close(); observer.close();
  });
  it.each(['deadline','physical-first','early-subscriber-deadline','consumer-cancel'] as const)('retains unchanged proof across %s without extending the shared physical deadline',async ending=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const entered=gate(),release=gate();let periodic=false,completed=gate();
    const inspect=vi.fn(processFacts),r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:now,
      file:async(filename,limit,signal)=>{if(periodic&&filename===path.join(profile,'config.cfg')){entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);}});
    const observer=new ProfileObserver(()=>r,now,false),m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{completed.resolve();return value;}),undefined,now,undefined,()=>r.canRetain(),undefined,undefined,{eligible:()=>r.guardEligible(),select:()=>undefined,deadline:s=>r.deadline(s)});
    // The observer owns source retirement here; closing only the monitor remains an independent consumer cancellation.
    const current={source,clockId:'clock',monotonicNs:'1'};
    try {
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();
      await vi.advanceTimersByTimeAsync(1);
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:now().toString(),receivedSourceNs:'10'}};
      observer.select(bound);m.select(bound);await m.refresh();expect(m.evidence().assessment.state).toBe('pass');
      // Keep required guards progressing before the minute byte verification; an unobserved minute now revokes proof.
      for(let second=5;second<60;second+=5){await vi.advanceTimersByTimeAsync(5000);await r.resolveProfile(source,created+10000,new AbortController().signal,true);}
      await vi.advanceTimersByTimeAsync(5000);periodic=true;completed=gate();
      const raw=new AbortController();let rawWork:Promise<unknown>|undefined;
      if(ending==='physical-first'||ending==='early-subscriber-deadline'){
        rawWork=r.read(source,'1',created+10000,raw.signal).catch(error=>error);await entered.promise;await vi.advanceTimersByTimeAsync(100);
      }
      const pending=m.refresh();await entered.promise;
      if(ending==='consumer-cancel')m.close();
      await vi.advanceTimersByTimeAsync(2000);await pending;await rawWork;
      expect(m.evidence().assessment.state).toBe(ending==='consumer-cancel'?'unknown':'pass');
      expect(observer.evidence()).toBeDefined();expect(inspect).toHaveBeenCalledOnce();
    } finally {release.resolve();m.close();observer.close();}
  });
  it.each(['optional-bytes','required-guards'] as const)('counts a scheduled deadline using only independently eligible evidence: %s',async blocked=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const entered=gate(),release=gate(),completed=gate(),scheduledCheck=gate(),publications:HardModeObservation[]=[];let hold=false,lastReadError:unknown;
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:now,
      metadata:{realpath:async filename=>{if(hold&&blocked==='required-guards'){entered.resolve();await release.promise;}return realpath(filename);},stat:filename=>stat(filename,{bigint:true})},
      file:async(filename,limit,signal)=>{if(hold&&blocked==='optional-bytes'&&filename===path.join(profile,'config.cfg')){entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);}});
    const observer=new ProfileObserver(()=>r,now,false),m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal)
      .catch(error=>{lastReadError=error;throw error;}).finally(()=>completed.resolve()),value=>{publications.push(value);if(value.check?.sequence===2)scheduledCheck.resolve();},now,undefined,()=>r.canRetain(),undefined,undefined,
      {eligible:()=>r.guardEligible(),select:()=>undefined,deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate((_profileChanged,diagnostic)=>m.invalidate(diagnostic));let pending:Promise<void>|undefined;
    try {
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();await vi.advanceTimersByTimeAsync(1);
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:now().toString(),receivedSourceNs:'10'}};
      observer.select(bound);m.select(bound);await m.refresh();expect(publications.filter(value=>value.check).map(value=>value.assessment.state)).toEqual(['pass']);
      // Keep the real required guards advancing until the scheduled minute byte reread, without running monitor checks.
      for(let second=5;second<60;second+=5){await vi.advanceTimersByTimeAsync(5000);await r.resolveProfile(source,created+10000,new AbortController().signal,true);}
      await vi.advanceTimersByTimeAsync(5000);hold=true;pending=m.refresh();await entered.promise;await vi.advanceTimersByTimeAsync(2000);
      if(blocked==='required-guards') {expect(m.evidence().assessment.state).toBe('unknown');release.resolve();}
      await scheduledCheck.promise;
      const checks=publications.filter(value=>value.check);
      expect(checks.map(value=>value.assessment.state)).toEqual(['pass',blocked==='optional-bytes'?'pass':'unknown']);
      expect(checks.map(value=>value.check!.sequence)).toEqual([1,2]);
      expect(r.canRetain()).toBe(blocked==='optional-bytes');
      if(blocked==='optional-bytes') {expect(lastReadError).toBeInstanceOf(UnchangedVerificationError);expect(checks[1].binding).toBe(checks[0].binding);}
      else {expect(lastReadError).not.toBeInstanceOf(UnchangedVerificationError);expect(checks[1]).toMatchObject({binding:null,diagnostic:'guard-deadline'});}
    } finally {release.resolve();m.close();observer.close();await pending;await r.drain();}
  });
  it.each(['hard-mode','profile','status','retention'] as const)('expires the shared required guard synchronously through %s before delayed timer callbacks',async first=>{
    vi.useFakeTimers();let now=0n,hold=false;const entered=gate(),release=gate(),completed=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now,
      file:async(filename,limit,signal)=>{if(hold&&filename===path.join(profile,'config.cfg')){entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);}}),observer=new ProfileObserver(()=>r,()=>now,false);
    const m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<void>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();
      const token=observer.status().token;now=5_000_000_000n;hold=true;pending=m.refresh(true);await entered.promise;
      now=11_999_999_999n;expect(m.evidence().assessment.state).toBe('pass');expect(observer.evidence()).toBeDefined();expect(r.canRetain()).toBe(true);
      now=12_000_000_000n;
      if(first==='hard-mode')expect(m.evidence().assessment.state).toBe('unknown');
      else if(first==='profile')expect(observer.evidence()).toBeUndefined();
      else if(first==='status')expect(observer.status().phase).toBe('unavailable');
      else expect(r.canRetain()).toBe(false);
      expect(m.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);expect(r.guardEligible()).toBe(false);
      m.close();observer.close();release.resolve();await pending;expect(r.guardEligible()).toBe(false);
    }finally{m.close();observer.close();release.resolve();await pending;}
  });
  it('retains proof when failed optional settings verification drains and subsequent five-second guards succeed',async()=>{
    vi.useFakeTimers();let now=0n,fail=false,configs=0;const completed=gate(),inspect=vi.fn(processFacts);
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,file:async(filename,limit,signal)=>{
      if(!filename.endsWith('game.log.txt'))configs++;if(fail&&filename===path.join(profile,'config.cfg'))throw new Error('Optional settings unavailable');return readStableFile(filename,limit,signal);
    }}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal,force)=>observer.readSettings(r,s,ns,at,signal,force).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const token=observer.status().token;
      for(let second=5;second<=90;second+=5){now=BigInt(second)*1_000_000_000n;fail=second>=60;await m.refresh();await r.drain();expect(m.evidence().assessment.state).toBe('pass');expect(observer.status()).toEqual({phase:'admitted',token});expect(observer.evidence()).toBeDefined();}
      expect(configs).toBe(6);expect(inspect).toHaveBeenCalledOnce();
    }finally{m.close();observer.close();await r.drain();}
  });
  it.each(['source','clock','close'] as const)('fences a late guard and clears its watchdog on %s retirement without discarding process success',async ending=>{
    vi.useFakeTimers();let now=0n,hold=false,held=false;const entered=gate(),release=gate(),completed=gate(),inspect=vi.fn(processFacts);
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:()=>now,file:async(filename,limit,signal)=>{
      if(hold&&!held&&filename.endsWith('game.log.txt')){held=true;entered.resolve();await release.promise;}return readStableFile(filename,limit,signal);
    }}),observer=new ProfileObserver(()=>r,()=>now,false),m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).finally(()=>completed.resolve()),undefined,()=>now,undefined,()=>r.canRetain(),undefined,()=>r.drain(),
      {eligible:()=>r.guardEligible(),select:key=>r.selectGuardSource(key),deadline:s=>r.deadline(s)}),current={source,clockId:'clock',monotonicNs:'1'};
    r.onInvalidate(()=>m.invalidate());let pending:Promise<void>|undefined;
    try{
      observer.select(current);m.select(current);await completed.promise;await observer.refresh();now=1n;
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}};observer.select(bound);m.select(bound);await m.refresh();const token=observer.status().token;
      now=5_000_000_000n;hold=true;pending=m.refresh();await entered.promise;
      if(ending==='close'){m.close();observer.close();}else{
        const next=ending==='clock'?{...current,clockId:'new-clock'}:{...current,source:{...source,pluginSessionId:'20000000-0000-4000-8000-000000000002'}};
        observer.select(next);m.select(next);
      }
      expect(r.guardEligible()).toBe(false);expect(observer.status().token).not.toBe(token);expect(m.evidence().assessment.state).toBe('unknown');
      m.close();observer.close();release.resolve();await pending;await r.drain();expect(r.guardEligible()).toBe(false);expect(vi.getTimerCount()).toBe(0);
      hold=false;expect((await read(r)).assessment.state).toBe('pass');expect(inspect).toHaveBeenCalledOnce();expect(m.evidence().assessment.state).toBe('unknown');
    }finally{m.close();observer.close();release.resolve();await pending;await r.drain();r.selectGuardSource('cleanup');r.selectGuardSource(undefined);}
  });
  it.each(['process','log','profile'].flatMap(failure=>[false,true].map(profileBound=>({failure,profileBound}))))('invalidates both consumers on shared $failure failure (profile bound=$profileBound)',async({failure,profileBound})=>{
    let now=0n,wrongProcess=false;
    const r=new HardModeReader({documents:path.join(root,'Documents'),nowNs:()=>now,processLifetime:()=>wrongProcess?undefined:'verified-lifetime',process:processFacts});
    const observer=new ProfileObserver(()=>r,()=>now,false),completed=gate();
    const m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{completed.resolve();return value;}),undefined,()=>now);
    const current={source,clockId:'clock',monotonicNs:'1'};
    observer.select(current);m.select(current);await completed.promise;await observer.refresh();
    now=100n;const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'100',receivedSourceNs:'10'}};
    // Hard Mode is bound; the independent profile result is still waiting for its probe.
    m.select(bound);await m.refresh();expect(m.evidence().assessment.state).toBe('pass');
    if(profileBound){observer.select(bound);expect(observer.evidence()).toBeDefined();}
    now=5_000_000_000n;
    if(failure==='process')wrongProcess=true;
    if(failure==='log')await writeFile(path.join(game,'game.log.txt'),header+selection+save()+'New profile selected: Other\n');
    if(failure==='profile'){await rename(profile,profile+'-old');await mkdir(profile);}
    await m.refresh();
    expect(m.evidence().assessment.state).toBe('unknown');
    observer.select({...bound,boundary:{...bound.boundary,probeSentClientNs:(now+1n).toString()}});
    expect(observer.evidence()).toBeUndefined();m.close();observer.close();
  });
  it('keeps bound profile proof on settings-only failure and clears it on a subsequent shared failure',async()=>{
    let now=0n;
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now});
    const observer=new ProfileObserver(()=>r,()=>now,false),current={source,clockId:'clock',monotonicNs:'1'};
    observer.select(current);await observer.readSettings(r,source,'1',created+10000,new AbortController().signal);await observer.refresh();
    now=100n;observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'100',receivedSourceNs:'10'}});
    const scope=observer.evidence()!.scope;
    now=1_000_000_000n;await rm(path.join(profile,'config.cfg'));
    await expect(observer.readSettings(r,source,'2',created+10000,new AbortController().signal)).rejects.toThrow();await observer.refresh();
    expect(observer.evidence()?.scope).toBe(scope);
    now=2_000_000_000n;await writeFile(path.join(game,'game.log.txt'),header+selection);
    await expect(observer.readSettings(r,source,'3',created+10000,new AbortController().signal)).rejects.toThrow();
    expect(observer.evidence()).toBeUndefined();observer.close();
  });
  it.each([false,true])('retires an older pending profile on a verified load change even when settings fail=%s',async missing=>{
    let now=0n,completed=gate(),awaitUnknown=false;const invalidated=gate();
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:processFacts,nowNs:()=>now});
    const observer=new ProfileObserver(()=>r,()=>now,false),current={source,clockId:'clock',monotonicNs:'1'};
    const m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).finally(()=>completed.resolve()),
      value=>{if(awaitUnknown&&value.assessment.state==='unknown')invalidated.resolve();},()=>now);
    observer.select(current);m.select(current);await completed.promise;await observer.refresh();
    now=100n;const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'100',receivedSourceNs:'10'}};
    m.select(bound);await m.refresh();expect(m.evidence().assessment.state).toBe('pass');
    now=5_000_000_000n;await writeFile(path.join(game,'game.log.txt'),header+selection+save()+save());
    if(missing)await rm(path.join(profile,'config.cfg'));
    completed=gate();awaitUnknown=true;const work=m.refresh();await invalidated.promise;
    expect(m.evidence().assessment.state).toBe('unknown');
    const later={...bound,boundary:{...bound.boundary,probeSentClientNs:(now+1n).toString()}};
    observer.select(later);expect(observer.evidence()).toMatchObject({loadGeneration:3,afterMonotonicNs:'11'});m.select(later);await work;
    expect(m.evidence().assessment.state).toBe(missing?'unknown':'pass');m.close();observer.close();
  });
  it('binds UTF-8 selected profile to latest save and uses the three files, not stale log uset values', async () => {
    await writeFile(path.join(game, 'game.log.txt'), header + 'uset g_fatigue "0"\n' + selection + save());
    const a = await read(); expect(a.assessment.state).toBe('pass'); expect(a.assessment.source).toBe('local');
    expect(JSON.stringify(a)).not.toContain(name); expect(JSON.stringify(a)).not.toContain(root); expect(a.binding).toMatch(/^[0-9a-f]{64}$/);
  });
  it('uses the matching ATS root/executable in an isolated layout', async () => {
    const ats = path.join(root, 'Documents', 'American Truck Simulator'); await rename(game, ats);
    const r = new HardModeReader({documents: path.join(root, 'Documents'), process: async () => ({...(await processFacts()), executable: 'C:/Synthetic/amtrucks.exe'})});
    expect((await r.read({...source, game: 'ats'}, '100', created + 10000, new AbortController().signal)).assessment.state).toBe('pass');
  });
  it('reads shared-open log files through Node/libuv while another writer holds the file', async () => {
    const file = await open(path.join(game, 'game.log.txt'), 'a');
    try {expect((await read()).assessment.state).toBe('pass');} finally {await file.close();}
  });
  it.each(['identical-rewrite','unrelated-setting','save-directory'] as const)('reverifies %s without permanently rejecting a passing v2 trip', async trigger => {
    const r = reader(), initial = await read(r);
    let audit = {...newHardModeDetails(initial.assessment, initial.binding), passingChecks: 1};
    r.onInvalidate(profileChanged => {audit = advanceHardModeV2(audit, {assessment: unknownHardMode(created + 10001), binding: null, pluginSessionId: null, sourceMonotonicNs: null,
      diagnostic: profileChanged ? 'profile-verification' : 'settings-changing'});});
    if (trigger === 'save-directory') await mkdir(path.join(profile,'save','synthetic-save'), {recursive:true});
    else await writeSettingsChange(path.join(profile,'config.cfg'), HARD_MODE_CONFIG + (trigger === 'unrelated-setting' ? '\nuset r_vsync "0"' : ''));
    const verified = await read(r); audit = advanceHardModeV2(audit, verified);
    expect(verified.assessment.state).toBe('pass'); expect(verified.binding).toBe(initial.binding);
    expect(audit.firstLoss).toBeNull(); expect(qualifiesHardMode(audit)).toBe(true);
    expect(audit.latestDiagnostic).not.toBeNull();
    await writeSettingsChange(path.join(profile,'config.cfg'), HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));
    expect((await read(r)).assessment.rules[3]).toMatchObject({state:'fail',values:[0]});
  });
  it('uses file bytes on unchanged hashes/changed mtimes and detects live persisted changes', async () => {
    const r = reader(); expect((await read(r)).assessment.state).toBe('pass');
    await writeSettingsChange(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG); expect((await read(r)).assessment.state).toBe('pass');
    await writeSettingsChange(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
    expect((await read(r)).assessment.rules[3]).toMatchObject({values: [0], state: 'fail'});
  });
  it('supports the unique Cloud layout and rejects multiple matching accounts', async () => {
    const steam = path.join(root, 'Steam'), remote = path.join(steam, 'userdata', '100', '227300', 'remote', 'profiles', id);
    const local = path.join(game, 'steam_profiles', id); await mkdir(remote, {recursive: true}); await mkdir(local, {recursive: true});
    await writeFile(path.join(remote, 'config.cfg'), HARD_MODE_CONFIG); await writeFile(path.join(local, 'config_local.cfg'), 'uset g_brake_intensity "0.75"');
    await writeFile(path.join(game, 'game.log.txt'), header + selection + save('steam'));
    const r = new HardModeReader({documents: path.join(root, 'Documents'), steamRoot: steam, process: processFacts});
    expect((await read(r)).assessment.source).toBe('cloud');
    const duplicate = path.join(steam, 'userdata', '101', '227300', 'remote', 'profiles', id); await mkdir(duplicate, {recursive: true}); await writeFile(path.join(duplicate, 'config.cfg'), HARD_MODE_CONFIG);
    await expect(read(r)).rejects.toThrow('ambiguous');
  });
  it('recovers a stable Cloud watch set after rejecting an account added between traversal and metadata',async()=>{
    const steam=path.join(root,'Steam'),userdata=path.join(steam,'userdata'),parent=path.join(userdata,'101','227300','remote','profiles');
    const remote=path.join(userdata,'100','227300','remote','profiles',id),local=path.join(game,'steam_profiles',id);
    await mkdir(remote,{recursive:true});await mkdir(local,{recursive:true});await writeFile(path.join(remote,'config.cfg'),HARD_MODE_CONFIG);
    await writeFile(path.join(local,'config_local.cfg'),'uset g_brake_intensity "0.75"');await writeFile(path.join(game,'game.log.txt'),header+selection+save('steam'));
    let inserting=false,phase=0;
    const r=new HardModeReader({documents:path.join(root,'Documents'),steamRoot:steam,process:processFacts,metadata:{realpath:async filename=>{
      if(inserting&&filename===userdata&&++phase===2){await mkdir(parent,{recursive:true});await utimes(userdata,new Date('2026-10-22T12:00:00Z'),new Date('2026-10-22T12:00:00Z'));}return realpath(filename);
    },stat:filename=>stat(filename,{bigint:true})}});
    await read(r);inserting=true;await expect(r.read(source,'101',created+10000,new AbortController().signal,true)).rejects.toThrow('discovery containers changed');
    inserting=false;const recovered=await read(r);expect(recovered.assessment.state).toBe('pass');
    const stable=await r.read(source,'102',created+10000,new AbortController().signal,true);expect(stable.binding).toBe(recovered.binding);expect(stable.assessment.state).toBe('pass');
    await mkdir(path.join(parent,id));await writeFile(path.join(parent,id,'config.cfg'),HARD_MODE_CONFIG);await utimes(parent,new Date('2026-10-23T12:00:00Z'),new Date('2026-10-23T12:00:00Z'));
    await expect(r.resolveProfile(source,created+10000,new AbortController().signal,true)).rejects.toThrow('ambiguous');
  });
  it('does not let an old Cloud type override a later local save, or an old save survive a new selection', () => {
    expect(profileFromLog(selection + 'Profile type: PC_steam_cloud\n' + save('steam') + selection + save())).toMatchObject({storage: 'local', profile: id});
    expect(profileFromLog(selection + save() + 'New profile selected: Other\n')).toBeNull();
    expect(profileFromLog(selection + save().replace(id, '4142'))).toBeNull();
    expect(profileFromLog(selection + save() + 'Loading save. path: invalid\n')).toBeNull();
  });
  it('refuses stale generations, mismatched process, replay sources, missing files and replacement/truncation', async () => {
    await expect(reader().read({...source, origin: 'replay'}, '1', created + 10000, new AbortController().signal)).rejects.toThrow();
    const wrong = new HardModeReader({documents: path.join(root, 'Documents'), process: async () => ({...(await processFacts()), pid: 456})}); await expect(read(wrong)).rejects.toThrow();
    const r = reader(); await read(r); await writeFile(path.join(game, 'game.log.txt'), header + selection); await expect(read(r)).rejects.toThrow();
    await writeFile(path.join(game, 'game.log.txt'), header.replace('12:00:00', '11:00:00') + selection + save()); await expect(read()).rejects.toThrow();
    await writeFile(path.join(game, 'game.log.txt'), header + selection + save());
    await rename(path.join(profile, 'config.cfg'), path.join(profile, 'old.cfg')); await expect(read()).rejects.toThrow();
    await writeFile(path.join(profile, 'config.cfg'), 'x'.repeat(256 * 1024 + 1)); await expect(read()).rejects.toThrow();
  });
  it('honestly refuses a redirected file rather than following it into another root', async () => {
    const link = path.join(root, 'redirected-profile'); await symlink(profile, link, 'junction');
    await expect(readStableFile(path.join(link, 'config.cfg'), 256 * 1024, new AbortController().signal)).rejects.toThrow('Redirected file');
    const documents = path.join(root, 'redirected-documents'); await symlink(path.join(root, 'Documents'), documents, 'junction');
    const redirected = new HardModeReader({documents, process: processFacts}); expect((await read(redirected)).assessment.state).toBe('pass');
    const r = reader(); await read(r); await rename(path.join(game, 'game.log.txt'), path.join(game, 'old.log.txt'));
    await writeFile(path.join(game, 'game.log.txt'), header + selection + save()); await expect(read(r)).rejects.toThrow('replaced');
  });
  it('canonicalizes an isolated ancestor alias before deriving exact file callback gates',async()=>{
    const alias=path.join(root,'fixture-ancestor-alias');await symlink(path.join(root,'Documents'),alias,'junction');
    const aliasedLog=path.join(alias,'Euro Truck Simulator 2','game.log.txt'),signal=new AbortController().signal;
    expect(await realpath(aliasedLog)).toBe(path.join(game,'game.log.txt'));
    await expect(new ProfileLogTail().read(aliasedLog,signal)).rejects.toThrow('Redirected file');
    const entered=gate(),release=gate(),canonicalRoot=await realpath(alias),expected=path.join(canonicalRoot,'Euro Truck Simulator 2','config.cfg');
    let gated=false;
    const r=new HardModeReader({documents:alias,process:processFacts,file:async(filename,limit,readSignal)=>{
      if(filename===expected){gated=true;entered.resolve();await release.promise;}return readStableFile(filename,limit,readSignal);
    }}),work=read(r);
    try{await entered.promise;expect(gated).toBe(true);expect(expected).not.toBe(path.join(alias,'Euro Truck Simulator 2','config.cfg'));release.resolve();expect((await work).assessment.state).toBe('pass');}
    finally{release.resolve();await work.catch(()=>undefined);await r.drain();}
  });
  it('gates fixture roots on smoke flag, explicit synthetic target and absolute isolated LOCALAPPDATA', () => {
    const env = {LOCALAPPDATA: root, ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_HARD_MODE_FIXTURE: '1', ETS2TELEMETRY_RECORDING: 'synthetic:smoke'};
    expect(hardModeFixtureOptions(env)?.documents).toBe(path.join(root, 'ETS2Telemetry', 'synthetic', 'hard-mode-fixture', 'Documents'));
    expect(hardModeFixtureOptions({...env, ETS2TELEMETRY_RECORDING: ''})).toBeNull();
    expect(hardModeFixtureOptions({...env, ETS2TELEMETRY_LIVE_SMOKE: ''})).toBeNull();
    expect(hardModeFixtureOptions({...env, LOCALAPPDATA: 'relative'})).toBeNull();
  });
  it('retains unchanged admitted proof between guards instead of publishing an age-based interruption', async () => {
    vi.useFakeTimers(); const changes: HardModeObservation[] = [];
    const {evaluateHardMode, parseHardModeConfig} = await import('../../packages/telemetry-core/src/hard-mode');
    const scan = () => Promise.resolve({assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'});
    const m = new HardModeMonitor(scan, value => changes.push(value));
    const bind = () => m.select({source, monotonicNs: '100', clockId: 'clock', boundary: {clockId: 'clock', probeSentClientNs: (process.hrtime.bigint() + 1n).toString(), receivedSourceNs: '200'}});
    m.select({source, monotonicNs: '100', clockId: 'clock'}); await Promise.resolve(); bind(); await m.refresh();
    expect(m.status().assessment.state).toBe('pass'); const published = changes.length;
    await vi.advanceTimersByTimeAsync(3500); const refresh = m.refresh(); await Promise.resolve(); bind(); await refresh;
    expect(changes).toHaveLength(published); expect(m.status().assessment.state).toBe('pass'); m.close();
  });
  it('requires a post-read validated same-clock probe boundary; an old/mismatched boundary cannot publish pass', async () => {
    const {evaluateHardMode, parseHardModeConfig} = await import('../../packages/telemetry-core/src/hard-mode');
    const scan = () => Promise.resolve({assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'});
    const m = new HardModeMonitor(scan, undefined, () => 100n);
    const select = (clockId: string, probeSentClientNs: string) => m.select({source, clockId: 'current', monotonicNs: '100', boundary: {clockId, probeSentClientNs, receivedSourceNs: '300'}});
    select('current', '0'); await Promise.resolve(); expect(m.status().assessment.state).toBe('unknown');
    select('current', '100'); expect(m.status().assessment.state).toBe('unknown');
    select('wrong', '101'); expect(m.status().assessment.state).toBe('unknown');
    select('current', '101'); await m.refresh();
    expect(m.evidence()).toMatchObject({assessment: {state: 'pass'}, sourceMonotonicNs: '301'}); m.close();
  });
  it('expires a completed passing read without a causal reply within the unchanged deadline', async () => {
    vi.useFakeTimers(); const {evaluateHardMode, parseHardModeConfig} = await import('../../packages/telemetry-core/src/hard-mode');
    const changed = vi.fn<(value: HardModeObservation) => void>(), m = new HardModeMonitor(() => Promise.resolve({assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'}), changed);
    m.select({source, monotonicNs: '100', clockId: 'clock'}); await Promise.resolve();
    expect(m.status().assessment.state).toBe('unknown'); const pending = m.refresh(); await vi.advanceTimersByTimeAsync(2001); await pending;
    expect(changed.mock.calls.every(([value]) => value.assessment.state === 'unknown')).toBe(true); m.close();
  });
  it('renews only the memory publication lease while retaining the original causal proof through UTC rollback',async()=>{
    let mono=0n;const changes:HardModeObservation[]=[];
    const {evaluateHardMode,parseHardModeConfig}=await import('../../packages/telemetry-core/src/hard-mode');
    const scan=vi.fn(()=>Promise.resolve({assessment:evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),1000,'fixture'),binding:'a'.repeat(64),pluginSessionId:source.pluginSessionId,sourceMonotonicNs:'100'}));
    const m=new HardModeMonitor(scan,value=>changes.push(value),()=>mono);
    m.select({source,monotonicNs:'100',clockId:'clock'});await Promise.resolve();mono=1n;
    m.select({source,monotonicNs:'100',clockId:'clock',boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'200'}});await m.refresh();
    const admitted=m.evidence(),utc=vi.spyOn(Date,'now').mockReturnValue(1);
    mono=60_000_000_000n;expect(m.publication().remainingNs).toBe('0');expect(m.evidence()).toEqual(admitted);
    m.heartbeat();expect(m.publication()).toMatchObject({assessment:admitted.assessment,remainingNs:'3000000000'});
    expect(m.evidence()).toEqual(admitted);expect(scan).toHaveBeenCalledOnce();
    m.invalidate();m.heartbeat();expect(m.evidence().assessment.state).toBe('unknown');
    expect(changes.at(-1)?.assessment.state).toBe('unknown');utc.mockRestore();m.close();
  });
  it('coalesces refresh, enforces the deadline and never starts a second outstanding read', async () => {
    vi.useFakeTimers(); let finish!: (v: HardModeObservation) => void; const callback = vi.fn();
    const scan = vi.fn(() => new Promise<HardModeObservation>(resolve => {finish = resolve;}));
    const m = new HardModeMonitor(scan, callback); m.select({source, monotonicNs: '100'});
    void m.refresh(); void m.refresh(); expect(scan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2001); expect(m.status().assessment.state).toBe('unknown'); void m.refresh(); expect(scan).toHaveBeenCalledTimes(1);
    finish({assessment: m.status().assessment, binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'});
    await vi.advanceTimersByTimeAsync(0); m.close();
  });
});
