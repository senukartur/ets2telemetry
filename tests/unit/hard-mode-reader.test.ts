import {mkdtemp, mkdir, open, rm, writeFile, rename, utimes, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hardModeFixtureOptions} from '../../apps/desktop/src/hard-mode/fixture';
import {HardModeReader, profileFromLog, readStableFile} from '../../apps/desktop/src/hard-mode/reader';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import {ProfileObserver} from '../../apps/desktop/src/profile-observation';
import type {HardModeObservation} from '../../packages/contracts/src/hard-mode';
import type {SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
const source: SourceIdentity = {game: 'ets2', origin: 'game', processId: 123, windowsSessionId: 1, processInstanceId: '10000000-0000-4000-8000-000000000001', pluginSessionId: '20000000-0000-4000-8000-000000000001'};
const name = 'Synthetic Профиль', id = Buffer.from(name).toString('hex').toUpperCase();
const created = new Date(2026, 9, 21, 12, 0, 0).getTime();
const header = '************ : log created on : Wednesday October 21 2026 @ 12:00:00\n';
const selection = `00:00:01.000 : New profile selected: '${name}'\n`;
const save = (storage: 'home' | 'steam' = 'home') => `00:00:02.000 : Loading save. Type: 0, path: <MEMFILE><UFS>/${storage}/profiles/${id}/save/autosave/game.sii\n`;
let root: string, game: string, profile: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ets2-hard-mode-')); game = path.join(root, 'Documents', 'Euro Truck Simulator 2'); profile = path.join(game, 'profiles', id);
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
function gate<T = void>() {let resolve!: (value: T) => void; const promise = new Promise<T>(yes => {resolve = yes;}); return {promise, resolve};}
describe('ET-026 isolated reader (REG-008/010/011)', () => {
  it('shares exactly two process queries between overlapping settings and profile consumers, then reads fresh again', async () => {
    const inspect = vi.fn(processFacts), r = new HardModeReader({documents: path.join(root, 'Documents'), process: inspect});
    const [settings, identity] = await Promise.all([read(r), r.resolveProfile(source, created + 10000, new AbortController().signal)]);
    expect(settings.assessment.state).toBe('pass'); expect(settings.binding).toBe(identity.binding);
    expect(inspect).toHaveBeenCalledTimes(2);
    await read(r); expect(inspect).toHaveBeenCalledTimes(4);
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
    expect((await a).binding).toBe((await b).binding); expect(inspect).toHaveBeenCalledTimes(2);
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
    expect(inspect).toHaveBeenCalledTimes(2);
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
    expect((await b).timing).toEqual({startedClientNs: 0n, completedClientNs: now}); expect(inspect).toHaveBeenCalledTimes(2);
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
    expect((await latest).binding).toMatch(/^[0-9a-f]{64}$/); expect(maximum).toBe(1); expect(inspect).toHaveBeenCalledTimes(3);
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
    expect(observer.evidence()?.afterMonotonicNs).toBe('3'); expect(m.evidence().sourceMonotonicNs).toBe('3'); expect(inspect).toHaveBeenCalledTimes(2);
    now = 4_600_000_001n; expect(observer.evidence()).toBeUndefined(); expect(m.evidence().assessment.state).toBe('unknown');
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
  it.each(['deadline','physical-first','early-subscriber-deadline','consumer-cancel'] as const)('distinguishes %s when cadence offset skips the profile subscriber',async ending=>{
    vi.useFakeTimers();const start=Date.now(),now=()=>BigInt(Date.now()-start)*1_000_000n;
    const constructed=gate(),secondConstructed=gate(),firstEntered=gate(),firstRelease=gate(),completed=gate(),secondEntered=gate(),secondRelease=gate();
    const inspect=vi.fn(async()=>{
      if(inspect.mock.calls.length===1){firstEntered.resolve();await firstRelease.promise;}
      if(inspect.mock.calls.length===3){secondEntered.resolve();await secondRelease.promise;}
      return processFacts();
    });
    const r=new HardModeReader({documents:path.join(root,'Documents'),process:inspect,nowNs:now});
    const resolve=vi.spyOn(r,'resolveProfile'),observer=new ProfileObserver(()=>r,now,false);
    const rawController=new AbortController();let rawFailure:Promise<unknown>|undefined;
    let initial=true;
    const m=new HardModeMonitor(async(s,ns,at,signal)=>{
      if(initial){initial=false;await constructed.promise;}
      else if(ending==='early-subscriber-deadline')await secondConstructed.promise;
      return observer.readSettings(r,s,ns,at,signal).then(value=>{completed.resolve();return value;});
    },undefined,now);
    const current={source,clockId:'clock',monotonicNs:'1'};
    try {
      observer.select(current);m.select(current);
      await vi.advanceTimersByTimeAsync(10);constructed.resolve();await firstEntered.promise;
      await vi.advanceTimersByTimeAsync(190);firstRelease.resolve();await completed.promise;await observer.refresh();
      await vi.advanceTimersByTimeAsync(100);
      const bound={...current,boundary:{clockId:'clock',probeSentClientNs:now().toString(),receivedSourceNs:'10'}};
      observer.select(bound);m.select(bound);await m.refresh();
      expect(observer.evidence()).toBeDefined();expect(m.evidence().assessment.state).toBe('pass');
      await vi.advanceTimersByTimeAsync(700);
      if(ending==='physical-first'){
        rawFailure=expect(r.read(source,'1',created+10000,rawController.signal)).rejects.toThrow('Read deadline');
        await secondEntered.promise;await vi.advanceTimersByTimeAsync(1);
      }
      const next=m.refresh();
      if(ending==='early-subscriber-deadline'){await vi.advanceTimersByTimeAsync(1);secondConstructed.resolve();}
      await secondEntered.promise;
      // HM's cadence is due at 1000 ms; the profile's scan at 10 ms is only 990 ms old.
      expect(resolve).toHaveBeenCalledTimes(1);expect(inspect).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(ending==='early-subscriber-deadline'||ending==='physical-first'?1998:1999);expect(observer.evidence()).toBeDefined();
      if(ending!=='consumer-cancel')await vi.advanceTimersByTimeAsync(1);else m.close();
      await next;await rawFailure;expect(m.evidence().assessment.state).toBe('unknown');
      if(ending==='deadline'||ending==='physical-first')expect(observer.evidence()).toBeUndefined();else expect(observer.evidence()).toBeDefined();
    } finally {rawController.abort();secondRelease.resolve();firstRelease.resolve();constructed.resolve();secondConstructed.resolve();m.close();observer.close();}
  });
  it.each(['process','log','profile'].flatMap(failure=>[false,true].map(profileBound=>({failure,profileBound}))))('invalidates both consumers on shared $failure failure (profile bound=$profileBound)',async({failure,profileBound})=>{
    let now=0n,wrongProcess=false;
    const r=new HardModeReader({documents:path.join(root,'Documents'),nowNs:()=>now,process:async()=>({...await processFacts(),...(wrongProcess?{pid:999}:{})})});
    const observer=new ProfileObserver(()=>r,()=>now,false),completed=gate();
    const m=new HardModeMonitor((s,ns,at,signal)=>observer.readSettings(r,s,ns,at,signal).then(value=>{completed.resolve();return value;}),undefined,()=>now);
    const current={source,clockId:'clock',monotonicNs:'1'};
    observer.select(current);m.select(current);await completed.promise;await observer.refresh();
    now=100n;const bound={...current,boundary:{clockId:'clock',probeSentClientNs:'100',receivedSourceNs:'10'}};
    // Hard Mode is bound; the independent profile result is still waiting for its probe.
    m.select(bound);await m.refresh();expect(m.evidence().assessment.state).toBe('pass');
    if(profileBound){observer.select(bound);expect(observer.evidence()).toBeDefined();}
    now=1_000_000_000n;
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
    now=1_000_000_000n;await writeFile(path.join(game,'game.log.txt'),header+selection+save()+save());
    if(missing)await rm(path.join(profile,'config.cfg'));
    completed=gate();awaitUnknown=true;const work=m.refresh();await invalidated.promise;
    expect(m.evidence().assessment.state).toBe('unknown');
    const later={...bound,boundary:{...bound.boundary,probeSentClientNs:(now+1n).toString()}};
    observer.select(later);expect(observer.evidence()).toBeUndefined();m.select(later);await work;
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
  it('uses file bytes on unchanged hashes/changed mtimes and detects live persisted changes', async () => {
    const r = reader(); expect((await read(r)).assessment.state).toBe('pass');
    await utimes(path.join(profile, 'config.cfg'), new Date(), new Date()); expect((await read(r)).assessment.state).toBe('pass');
    await writeFile(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
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
  it('gates fixture roots on smoke flag, explicit synthetic target and absolute isolated LOCALAPPDATA', () => {
    const env = {LOCALAPPDATA: root, ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_HARD_MODE_FIXTURE: '1', ETS2TELEMETRY_RECORDING: 'synthetic:smoke'};
    expect(hardModeFixtureOptions(env)?.documents).toBe(path.join(root, 'ETS2Telemetry', 'synthetic', 'hard-mode-fixture', 'Documents'));
    expect(hardModeFixtureOptions({...env, ETS2TELEMETRY_RECORDING: ''})).toBeNull();
    expect(hardModeFixtureOptions({...env, ETS2TELEMETRY_LIVE_SMOKE: ''})).toBeNull();
    expect(hardModeFixtureOptions({...env, LOCALAPPDATA: 'relative'})).toBeNull();
  });
  it('publishes an observation interruption after downtime even when the next binding is identical', async () => {
    vi.useFakeTimers(); const changes: HardModeObservation[] = [];
    const {evaluateHardMode, parseHardModeConfig} = await import('../../packages/telemetry-core/src/hard-mode');
    const scan = () => Promise.resolve({assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'});
    const m = new HardModeMonitor(scan, value => changes.push(value));
    const bind = () => m.select({source, monotonicNs: '100', clockId: 'clock', boundary: {clockId: 'clock', probeSentClientNs: (process.hrtime.bigint() + 1n).toString(), receivedSourceNs: '200'}});
    m.select({source, monotonicNs: '100', clockId: 'clock'}); await Promise.resolve(); bind(); await m.refresh();
    expect(m.status().assessment.state).toBe('pass'); await vi.advanceTimersByTimeAsync(3500); const refresh = m.refresh(); await Promise.resolve(); bind(); await refresh;
    expect(changes.slice(-2).map(value => value.assessment.state)).toEqual(['unknown', 'pass']); m.close();
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
  it('expires coverage on monotonic elapsed time despite UTC rollback and never refreshes age at causal publication', async () => {
    let mono = 0n; const changes: HardModeObservation[] = [];
    const {evaluateHardMode, parseHardModeConfig} = await import('../../packages/telemetry-core/src/hard-mode');
    const scan = () => Promise.resolve({assessment: evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: source.pluginSessionId, sourceMonotonicNs: '100'});
    const m = new HardModeMonitor(scan, value => changes.push(value), () => mono);
    const bind = () => m.select({source, monotonicNs: '100', clockId: 'clock', boundary: {clockId: 'clock', probeSentClientNs: (++mono).toString(), receivedSourceNs: '200'}});
    m.select({source, monotonicNs: '100', clockId: 'clock'}); await Promise.resolve(); mono += 1_000_000_000n; bind(); await m.refresh();
    expect(m.publication()).toMatchObject({update: 'assessment', assessment: {state: 'pass'}, remainingNs: '1999999999'});
    const utc = vi.spyOn(Date, 'now').mockReturnValue(1);
    mono = 2_900_000_000n; expect(m.publication().remainingNs).toBe('100000000');
    mono = 3_500_000_000n; expect(m.publication()).toMatchObject({assessment: {state: 'unknown'}, remainingNs: '0'}); expect(m.evidence().assessment.state).toBe('unknown');
    const pending = m.refresh(); await Promise.resolve(); bind(); await pending;
    expect(changes.slice(-2).map(value => value.assessment.state)).toEqual(['unknown', 'pass']); utc.mockRestore(); m.close();
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
