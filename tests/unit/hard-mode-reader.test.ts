import {mkdtemp, mkdir, open, rm, writeFile, rename, utimes, symlink} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {hardModeFixtureOptions} from '../../apps/desktop/src/hard-mode/fixture';
import {HardModeReader, profileFromLog, readStableFile} from '../../apps/desktop/src/hard-mode/reader';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
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
describe('ET-026 isolated reader (REG-008/010/011)', () => {
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
