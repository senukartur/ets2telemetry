import {mkdtemp,mkdir,writeFile,rename,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
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
const reader=()=>new HardModeReader({documents:root,process:(s)=>Promise.resolve({pid:s.processId,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',commandLine:'eurotrucks2.exe'})});
const resolve=(r=reader(),s=source)=>r.resolveProfile(s,created+10000,new AbortController().signal);
describe('REG-003/008 independent verified profile identity',()=>{
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
    const r=new HardModeReader({documents:root,steamRoot:steam,process:()=>Promise.resolve({pid:123,createdUtcMs:created,executable:'C:/Synthetic/eurotrucks2.exe',commandLine:''})});
    expect((await resolve(r)).scope).not.toBe(local.scope);
    await mkdir(remote('101'),{recursive:true});await expect(resolve(r)).rejects.toThrow('ambiguous');
  });
  it('does not admit proof until a later same-clock probe and expires it without fresh verification',async()=>{
    let now=100n;
    const r=reader(),observer=new ProfileObserver(()=>r,()=>now);
    observer.select({source,clockId:'clock',monotonicNs:'100'});await observer.refresh();
    expect(observer.evidence()).toBeUndefined();
    observer.select({source,clockId:'clock',monotonicNs:'200',boundary:{clockId:'clock',probeSentClientNs:'101',receivedSourceNs:'200'}});
    expect(observer.evidence()?.afterMonotonicNs).toBe('201');
    observer.select({source,clockId:'clock',gameClockId:'restored-save',monotonicNs:'201'});expect(observer.evidence()).toBeUndefined();
    now=4_000_000_000n;expect(observer.evidence()).toBeUndefined();observer.close();
  });
});
