import {mkdtemp,mkdir,writeFile,rename,rm,utimes,stat,opendir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {HardModeReader} from '../../apps/desktop/src/hard-mode/reader';
import {ProfileObserver} from '../../apps/desktop/src/profile-observation';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';

const source: SourceIdentity={game:'ets2',origin:'game',processId:123,windowsSessionId:1,pluginSessionId:'10000000-0000-4000-8000-000000000001',processInstanceId:'20000000-0000-4000-8000-000000000001'};
const created=new Date(2026,9,21,12,0,0).getTime();
const profile=Buffer.from('Synthetic').toString('hex').toUpperCase();
const log="log created on : Wednesday October 21 2026 @ 12:00:00\nNew profile selected: Synthetic\n";
const loaded=(namespace='home')=>`${log}Loading save. /${namespace}/profiles/${profile}/save/autosave/game.sii\n`;
let root:string,game:string;
beforeEach(async()=>{root=await mkdtemp(path.join(os.tmpdir(),'et063-profile-'));game=path.join(root,'Euro Truck Simulator 2');await mkdir(path.join(game,'profiles',profile),{recursive:true});await writeFile(path.join(game,'game.log.txt'),loaded());});
afterEach(async()=>{await rm(root,{recursive:true,force:true});});
const reader=(nowNs?:()=>bigint)=>new HardModeReader({documents:root,nowNs,process:(s)=>Promise.resolve({pid:s.processId,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',commandLine:'eurotrucks2.exe'})});
const resolve=(r=reader(),s=source)=>r.resolveProfile(s,created+10000,new AbortController().signal);
describe('REG-003/008 independent verified profile identity',()=>{
  it.each(['local','cloud-local','cloud-remote'] as const)('revokes a replaced %s directory before rediscovery starts',async variant=>{
    let now=0n,hold=false,rediscoveries=0,release!:()=>void;
    const released=new Promise<void>(resolve=>{release=resolve;}),steam=path.join(root,'Steam');
    const local=path.join(game,variant==='local'?'profiles':'steam_profiles',profile),remote=path.join(steam,'userdata','100','227300','remote','profiles',profile);
    if(variant!=='local'){await mkdir(local,{recursive:true});await mkdir(remote,{recursive:true});await writeFile(path.join(game,'game.log.txt'),loaded('steam'));}
    const r=new HardModeReader({documents:root,steamRoot:steam,nowNs:()=>now,process:()=>Promise.resolve({pid:source.processId,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',homeDirectory:null}),
      profileDirectory:async parent=>{if(hold){rediscoveries++;await released;}return opendir(parent);}}),observer=new ProfileObserver(()=>r,()=>now,false),current={source,clockId:'clock',monotonicNs:'1'};
    let work:Promise<unknown>|undefined;
    try{
      observer.select(current);await observer.refresh();now=1n;observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}});
      expect(observer.evidence()).toBeDefined();const token=observer.status().token,target=variant==='cloud-remote'?remote:local;
      await rename(target,target+'.old');await mkdir(target);hold=true;
      work=resolve(r).catch(error=>error);expect(await work).toBeInstanceOf(Error);expect(rediscoveries).toBe(0);
      expect(observer.evidence()).toBeUndefined();expect(observer.status()).toMatchObject({phase:'unavailable'});expect(observer.status().token).not.toBe(token);
      // Current required guards cannot lend the old directory's proof while rediscovery is incomplete.
      expect(r.guardEligible()).toBe(true);expect(observer.evidence()).toBeUndefined();
    }finally{hold=false;release();observer.close();await work;await r.drain();}
  });
  it('suspends before a lifecycle event, coalesces cheap guards and admits only beyond a later causal receipt',async()=>{
    let now=0n,inspect=0;const r=new HardModeReader({documents:root,nowNs:()=>now,process:s=>{inspect++;return Promise.resolve({pid:s.processId,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',homeDirectory:null});}});
    const observer=new ProfileObserver(()=>r,()=>now,false),current={source,clockId:'clock',monotonicNs:'1'};
    observer.select(current);await observer.refresh();now=1n;observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'2'}});
    const first=observer.evidence();expect(first).toBeDefined();
    const reads=vi.spyOn(r,'resolveProfile');void observer.boundary();expect(observer.evidence()).toBeUndefined();void observer.boundary();const boundary=observer.boundary();
    await boundary;expect(reads).toHaveBeenCalledOnce();expect(reads.mock.calls[0][3]).toBe(true);expect(inspect).toBe(1);
    observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'1',receivedSourceNs:'3'}});expect(observer.evidence()).toBeUndefined();
    now=2n;observer.select({...current,boundary:{clockId:'clock',probeSentClientNs:'2',receivedSourceNs:'4'}});
    expect(observer.evidence()).toMatchObject({binding:first!.binding,afterMonotonicNs:'5'});expect(inspect).toBe(1);observer.close();
  });
  it('survives process/plugin/log lifetime changes without requiring any settings file or a passing assessment',async()=>{
    const r=reader(),a=await resolve(r);
    await rename(path.join(game,'game.log.txt'),path.join(game,'old.log.txt'));await writeFile(path.join(game,'game.log.txt'),loaded());
    const b=await resolve(r,{...source,processId:456,pluginSessionId:'10000000-0000-4000-8000-000000000002',processInstanceId:'20000000-0000-4000-8000-000000000002'});
    expect(a.scope).toBe(b.scope);expect(a.binding).not.toBe(b.binding);
    await expect(r.read(source,'1',created+10000,new AbortController().signal)).rejects.toThrow();
  });
  it('separates canonical roots and directory replacements, and rejects stale selected-only logs',async()=>{
    const a=await resolve();
    await rename(path.join(game,'profiles',profile),path.join(game,'profiles','old'));
    await mkdir(path.join(game,'profiles',profile));expect((await resolve()).scope).not.toBe(a.scope);
    await writeFile(path.join(game,'game.log.txt'),log);await expect(resolve()).rejects.toThrow('unproven');
  });
  it('requires exactly one matching cloud account and distinguishes its namespace',async()=>{
    const local=await resolve(),steam=path.join(root,'Steam');
    await mkdir(path.join(game,'steam_profiles',profile),{recursive:true});
    const remote=(id:string)=>path.join(steam,'userdata',id,'227300','remote','profiles',profile);
    await mkdir(remote('100'),{recursive:true});await writeFile(path.join(game,'game.log.txt'),loaded('steam'));
    const watched=path.join(steam,'userdata'),baseline=new Date('2026-10-21T12:00:00Z');
    await utimes(watched,baseline,baseline);const before=await stat(watched,{bigint:true});
    const r=new HardModeReader({documents:root,steamRoot:steam,process:()=>Promise.resolve({pid:123,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',commandLine:''})});
    expect((await resolve(r)).scope).not.toBe(local.scope);
    await mkdir(remote('101'),{recursive:true});const changed=new Date('2026-10-21T12:00:10Z');await utimes(watched,changed,changed);
    expect((await stat(watched,{bigint:true})).mtimeNs).not.toBe(before.mtimeNs);
    await expect(resolve(r)).rejects.toThrow('ambiguous');
  });
  it('does not admit proof until a later same-clock probe and retires it on a game-clock change',async()=>{
    let now=100n;
    const r=reader(()=>now),observer=new ProfileObserver(()=>r,()=>now);
    observer.select({source,clockId:'clock',monotonicNs:'100'});await observer.refresh();
    expect(observer.evidence()).toBeUndefined();
    observer.select({source,clockId:'clock',monotonicNs:'200',boundary:{clockId:'clock',probeSentClientNs:'101',receivedSourceNs:'200'}});
    expect(observer.evidence()?.afterMonotonicNs).toBe('201');
    observer.select({source,clockId:'clock',gameClockId:'restored-save',monotonicNs:'201'});expect(observer.evidence()).toBeUndefined();
    now=4_000_000_000n;expect(observer.evidence()).toBeUndefined();observer.close();
  });
  it('keeps an unbound result across the next scan tick so the next probe response can bind it',async()=>{
    let now=0n,reads=0;
    const resolved=await resolve();
    const fake={onInvalidate:()=>()=>undefined,resolveProfile:()=>{reads++;now+=1_000_000n;return Promise.resolve({...resolved,timing:{startedClientNs:now-1_000_000n,completedClientNs:now}});}} as unknown as HardModeReader;
    const observer=new ProfileObserver(()=>fake,()=>now);
    observer.select({source,clockId:'clock',monotonicNs:'1'});await observer.refresh();
    now=1_000_000_000n;await observer.refresh();expect(reads).toBe(1);
    now=1_010_000_000n;
    observer.select({source,clockId:'clock',monotonicNs:'20',boundary:{clockId:'clock',probeSentClientNs:'1000000000',receivedSourceNs:'20'}});
    expect(observer.evidence()?.afterMonotonicNs).toBe('21');observer.close();
  });
  it('expires an unbound result and discards late reads after an epoch change or close',async()=>{
    let now=0n,reads=0,finish:((value:Awaited<ReturnType<HardModeReader['resolveProfile']>>)=>void)|undefined;
    const resolved=await resolve();
    const fake={onInvalidate:()=>()=>undefined,resolveProfile:()=>{reads++;return new Promise<Awaited<ReturnType<HardModeReader['resolveProfile']>>>(r=>{finish=r;});}} as unknown as HardModeReader;
    const observer=new ProfileObserver(()=>fake,()=>now);
    observer.select({source,clockId:'clock',monotonicNs:'1'});finish!({...resolved,timing:{startedClientNs:now,completedClientNs:now}});await observer.refresh();
    now=5_000_000_001n;const expired=observer.refresh();expect(reads).toBe(2);
    observer.select({source,clockId:'changed',monotonicNs:'2'});finish!(resolved);await expired;
    expect(observer.evidence()).toBeUndefined();
    now=5_000_000_000n;const closing=observer.refresh();observer.close();finish!(resolved);await closing;
    observer.select(null);expect(observer.evidence()).toBeUndefined();
  });
  it.each(['game','origin','processId','windowsSessionId','processInstanceId','pluginSessionId','clockId','gameClockId'] as const)('retires an in-flight proof when %s changes',async field=>{
    let now=0n,signal:AbortSignal|undefined,finish!: (value:Awaited<ReturnType<HardModeReader['resolveProfile']>>)=>void;
    const resolved=await resolve(),fake={onInvalidate:()=>()=>undefined,resolveProfile:(_s:SourceIdentity,_at:number,s:AbortSignal)=>{signal=s;return new Promise<Awaited<ReturnType<HardModeReader['resolveProfile']>>>(done=>{finish=done;});}} as unknown as HardModeReader;
    const observer=new ProfileObserver(()=>fake,()=>now,false),initial={source,clockId:'clock',gameClockId:'game-clock',monotonicNs:'1'};
    observer.select(initial);const work=observer.refresh();
    const next=structuredClone(initial);
    if(field==='clockId'||field==='gameClockId')next[field]='changed';
    else if(field==='game')next.source.game='ats';
    else if(field==='origin')next.source.origin='replay';
    else if(field==='processId'||field==='windowsSessionId')next.source[field]++;
    else next.source[field]='30000000-0000-4000-8000-000000000003';
    observer.select(next);expect(signal!.aborted).toBe(true);
    finish({...resolved,timing:{startedClientNs:0n,completedClientNs:now}});await work;
    now=100n;observer.select({...next,boundary:{clockId:next.clockId,probeSentClientNs:'100',receivedSourceNs:'2'}});
    expect(observer.evidence()).toBeUndefined();observer.close();
  });
});
