import * as fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {
  RENAME_RETRY_DELAYS_MS, SettingsBusyError, SettingsError, SettingsStore, settingsDirectory, type SettingsFileSystem, type SettingsStoreOptions
} from '../../apps/desktop/src/settings-store';
import {temporaryResources} from '../shared/resources';

// Real temporary directories; failures are injected by wrapping the real file operations.
let resources: Awaited<ReturnType<typeof temporaryResources>>;
let directory: string;
let target: string;
let events: {event: string; facts?: Record<string, unknown>}[];
let delays: number[];
const failurePattern = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
// 2026-10-15T09:41:07.123Z is the clock of every quarantine below.
const now = () => new Date(Date.UTC(2026, 9, 15, 9, 41, 7, 123));
const EXPECTED_US_ETS2 = '{\n  "format": "ets2telemetry.settings",\n  "version": 1,\n  "units": {\n    "ets2": "us-customary",\n    "ats": "us-customary"\n  }\n}\n';
const VALID_METRIC = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric","ats":"metric"}}';
const CORRUPT = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric",';

beforeEach(async () => {
  resources = await temporaryResources();
  directory = path.join(resources.directory, 'ETS2Telemetry', 'settings'); target = path.join(directory, 'settings.json');
  events = []; delays = [];
});
afterEach(async () => {await resources.dispose();});

function store(fileSystem?: SettingsFileSystem, options: SettingsStoreOptions = {}) {
  return new SettingsStore(directory, {log: (event, _detail, facts) => events.push({event, ...(facts ? {facts: {...facts}} : {})}),
    delay: milliseconds => {delays.push(milliseconds); return Promise.resolve();}, now, ...(fileSystem ? {fs: fileSystem} : {}), ...options});
}
/** The real file system with selected operations replaced. */
function wrapped(overrides: Partial<SettingsFileSystem>): SettingsFileSystem {
  return {...(fs as unknown as SettingsFileSystem), ...overrides};
}
async function seed(content: string | Uint8Array, name = 'settings.json') {
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, name), content);
}
const list = async () => (await fs.readdir(directory)).sort();
const read = (name = 'settings.json') => fs.readFile(path.join(directory, name));
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), {code});

it('resolves the directory from LOCALAPPDATA and refuses a relative or missing location', () => {
  expect(settingsDirectory('C:\\Users\\example\\AppData\\Local')).toBe('C:\\Users\\example\\AppData\\Local\\ETS2Telemetry\\settings');
  expect(settingsDirectory('relative\\AppData')).toBeUndefined();
  expect(settingsDirectory(undefined)).toBeUndefined();
  expect(settingsDirectory('')).toBeUndefined();
});

it('uses defaults without creating anything when no settings exist', async () => {
  const settings = store();
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'defaults', writable: true, saveError: null});
  expect(existsSync(path.join(resources.directory, 'ETS2Telemetry'))).toBe(false);
  await fs.mkdir(directory, {recursive: true});
  expect(await store().load()).toMatchObject({state: 'defaults'});
  expect(await list()).toEqual([]);
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}, {event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}]);
});

it('loads a valid file without rewriting it', async () => {
  await seed(VALID_METRIC);
  expect(await store().load()).toEqual({units: {ets2: 'metric', ats: 'metric'}, state: 'loaded', writable: true, saveError: null});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('writes the exact v1 content, synced before the rename, and applies it only afterwards', async () => {
  const order: string[] = [];
  let settings!: SettingsStore;
  const fileSystem = wrapped({
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      if (flags !== 'wx') return handle;
      order.push('open');
      return {read: handle.read.bind(handle), writeFile: async (data, encoding) => {order.push('write'); await handle.writeFile(data, encoding);},
        sync: async () => {order.push('sync'); await handle.sync();}, close: async () => {order.push('close'); await handle.close();}};
    },
    rename: async (from, to) => {
      // Nothing is applied before the durable rename.
      expect(settings.view().units.ets2).toBe('metric'); order.push('rename'); await fs.rename(from, to);
    }
  });
  settings = store(fileSystem); await settings.load();
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded', writable: true, saveError: null});
  expect(order).toEqual(['open', 'write', 'sync', 'close', 'rename']);
  expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
  expect(await list()).toEqual(['settings.json']);
  expect(await store().load()).toEqual({units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded', writable: true, saveError: null});
  expect(events.map(row => row.event).filter(name => failurePattern.test(name))).toEqual([]);
});

it('retries a rename blocked by EPERM, EACCES or EBUSY', async () => {
  const failures = ['EPERM', 'EACCES', 'EBUSY'];
  const settings = store(wrapped({rename: async (from, to) => {const code = failures.shift(); if (code) throw errno(code); await fs.rename(from, to);}}));
  await settings.load();
  await expect(settings.setUnitProfile('ets2', 'us-customary')).resolves.toMatchObject({state: 'loaded'});
  expect(delays).toEqual([20, 40, 60]); expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
});

it('keeps the previous file and settings and removes its temporary after a persistent EPERM', async () => {
  await seed(VALID_METRIC);
  let attempts = 0;
  const settings = store(wrapped({rename: () => {attempts++; return Promise.reject(errno('EPERM'));}}));
  await settings.load();
  const failure = await settings.setUnitProfile('ets2', 'us-customary').catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SettingsError); expect((failure as SettingsError).code).toBe('SETTINGS_WRITE_FAILED');
  expect((failure as Error).message).not.toContain(resources.directory);
  expect(attempts).toBe(6); expect(delays).toEqual([...RENAME_RETRY_DELAYS_MS]); expect(delays.reduce((sum, value) => sum + value, 0)).toBe(300);
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'metric'}, state: 'loaded', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  expect(events.at(-1)).toEqual({event: 'SETTINGS_WRITE_FAILED', facts: {step: 'rename', code: 'EPERM'}});
});

it.each(['write', 'sync', 'rename'] as const)('leaves the old file valid when the save fails at %s', async step => {
  await seed(VALID_METRIC);
  const fileSystem = wrapped({
    open: async (file, flags) => {
      const handle = await fs.open(file, flags);
      if (flags !== 'wx') return handle;
      return {read: handle.read.bind(handle), close: () => handle.close(),
        writeFile: async (data, encoding) => {if (step === 'write') {await handle.writeFile(data.slice(0, 10), encoding); throw errno('ENOSPC');} await handle.writeFile(data, encoding);},
        sync: async () => {if (step === 'sync') throw errno('EIO'); await handle.sync();}};
    },
    rename: async (from, to) => {if (step === 'rename') throw errno('EIO'); await fs.rename(from, to);}
  });
  const settings = store(fileSystem); await settings.load();
  await expect(settings.setUnitProfile('ats', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
  expect(delays).toEqual([]);
  expect(await store().load()).toMatchObject({state: 'loaded', units: {ets2: 'metric', ats: 'metric'}});
});

it('keeps a corrupt file byte-identical until the first save, then quarantines it unchanged', async () => {
  await seed(CORRUPT);
  const settings = store();
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'invalid-file', writable: true, saveError: null});
  expect((await read()).toString('utf8')).toBe(CORRUPT); expect(await list()).toEqual(['settings.json']);
  await settings.setUnitProfile('ets2', 'us-customary');
  expect(await list()).toEqual(['settings.json', 'settings.rejected-20261015T094107Z.json']);
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(CORRUPT);
  expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
  // The rejected file is moved once; later saves only replace settings.json.
  await settings.setUnitProfile('ats', 'metric');
  expect(await list()).toEqual(['settings.json', 'settings.rejected-20261015T094107Z.json']);
  expect(events.map(row => row.event)).toEqual(['SETTINGS_FALLBACK', 'SETTINGS_QUARANTINED', 'SETTINGS_SAVED', 'SETTINGS_SAVED']);
  expect(events[0].facts).toEqual({state: 'invalid-file'});
  expect(events.map(row => row.event).filter(name => failurePattern.test(name))).toEqual([]);
});

it('quarantines an unsupported older file and an oversized file the same way', async () => {
  const older = '{"format":"ets2telemetry.settings","version":0,"units":{"ets2":"metric","ats":"metric"}}';
  await seed(older);
  const settings = store();
  expect(await settings.load()).toMatchObject({state: 'unsupported-older', units: {ets2: 'metric', ats: 'us-customary'}, writable: true, saveError: null});
  await settings.setUnitProfile('ets2', 'us-customary');
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(older);
  const oversized = new Uint8Array(64 * 1024 + 1).fill(0x20);
  await seed(oversized);
  const next = store(); expect(await next.load()).toMatchObject({state: 'invalid-file'});
  await next.setUnitProfile('ats', 'metric');
  expect(Buffer.compare(await read('settings.rejected-20261015T094107Z-2.json'), Buffer.from(oversized))).toBe(0);
});

it('keeps only the newest three quarantined files and leaves unrelated files alone', async () => {
  for (const name of ['settings.rejected-20261013T000000Z.json', 'settings.rejected-20261014T000000Z.json', 'settings.rejected-20261015T094107Z.json', 'settings.rejected-notes.txt'])
    await seed(name, name);
  await seed(CORRUPT);
  const settings = store(); await settings.load();
  await settings.setUnitProfile('ets2', 'us-customary');
  expect(await list()).toEqual(['settings.json', 'settings.rejected-20261014T000000Z.json', 'settings.rejected-20261015T094107Z-2.json',
    'settings.rejected-20261015T094107Z.json', 'settings.rejected-notes.txt']);
  expect((await read('settings.rejected-20261015T094107Z-2.json')).toString('utf8')).toBe(CORRUPT);
});

it('never modifies a newer-version file and refuses saves as read-only', async () => {
  const newer = '{"format":"ets2telemetry.settings","version":2,"units":{"ets2":"us-customary","ats":"metric"},"layout":{}}';
  await seed(newer);
  const settings = store();
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'newer-version', writable: false, saveError: null});
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer); expect(await list()).toEqual(['settings.json']);
  expect(settings.view()).toMatchObject({state: 'newer-version', units: {ets2: 'metric'}, saveError: 'SETTINGS_READ_ONLY'});
  expect(events.map(row => row.event)).toEqual(['SETTINGS_FALLBACK', 'SETTINGS_SAVE_REFUSED']);
});

it('rewrites a file with fallbacks completely without quarantining it', async () => {
  await seed('{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"imperial","ats":"metric"},"extra":true}');
  const settings = store();
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'metric'}, state: 'loaded-with-fallbacks', writable: true, saveError: null});
  expect(events[0]).toEqual({event: 'SETTINGS_FALLBACK', facts: {state: 'loaded-with-fallbacks', fields: 'units.ets2'}});
  await settings.setUnitProfile('ats', 'us-customary');
  expect(await list()).toEqual(['settings.json']);
  expect((await read()).toString('utf8')).toBe('{\n  "format": "ets2telemetry.settings",\n  "version": 1,\n  "units": {\n    "ets2": "metric",\n    "ats": "us-customary"\n  }\n}\n');
});

it('refuses a settings directory that is a junction, without reading or writing through it', async () => {
  const elsewhere = path.join(resources.directory, 'elsewhere');
  await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, 'settings.json'), VALID_METRIC);
  await fs.mkdir(path.dirname(directory), {recursive: true}); await fs.symlink(elsewhere, directory, 'junction');
  const settings = store();
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'unreadable', writable: false, saveError: null});
  expect(events[0]).toEqual({event: 'SETTINGS_FALLBACK', facts: {state: 'unreadable', reason: 'reparse-point'}});
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(await fs.readdir(elsewhere)).toEqual(['settings.json']); expect((await fs.readFile(path.join(elsewhere, 'settings.json'), 'utf8')).toString()).toBe(VALID_METRIC);
});

it('refuses a settings file that is a symbolic link without opening it', async () => {
  await seed(VALID_METRIC);
  const open = vi.fn((file: string, flags: 'r' | 'wx') => fs.open(file, flags));
  const fileSystem = wrapped({open,
    lstat: async file => {const stats = await fs.lstat(file); return file === target ? Object.assign(Object.create(stats) as typeof stats, {isSymbolicLink: () => true, isFile: () => false}) : stats;}});
  const settings = store(fileSystem);
  expect(await settings.load()).toMatchObject({state: 'unreadable', writable: false, saveError: null});
  expect(open).not.toHaveBeenCalled();
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC);
});

it('removes only stale temporaries of its own pattern, and only when saving', async () => {
  const stale = 'settings.json.4242.0f8fad5b-d9cb-469f-a165-70867728950e.tmp';
  const unrelated = ['settings.json.bak', 'settings.json.4242.not-a-uuid.tmp', 'settings.json.x.0f8fad5b-d9cb-469f-a165-70867728950e.tmp', 'other.tmp'];
  for (const name of [stale, ...unrelated]) await seed('partial', name);
  await seed(VALID_METRIC);
  const settings = store(); await settings.load();
  expect(await list()).toEqual([...unrelated, stale, 'settings.json'].sort());
  await settings.setUnitProfile('ets2', 'us-customary');
  expect(await list()).toEqual([...unrelated, 'settings.json'].sort());
});

it('serializes concurrent saves and applies them in request order', async () => {
  let active = 0, maximum = 0;
  const settings = store(wrapped({
    open: async (file, flags) => {if (flags === 'wx') {active++; maximum = Math.max(maximum, active);} return fs.open(file, flags);},
    rename: async (from, to) => {await new Promise(resolve => setImmediate(resolve)); await fs.rename(from, to); active--;}
  }));
  await settings.load();
  const results = await Promise.all([settings.setUnitProfile('ets2', 'us-customary'), settings.setUnitProfile('ats', 'metric'), settings.setUnitProfile('ets2', 'metric')]);
  expect(results.map(view => view.units)).toEqual([{ets2: 'us-customary', ats: 'us-customary'}, {ets2: 'us-customary', ats: 'metric'}, {ets2: 'metric', ats: 'metric'}]);
  expect(maximum).toBe(1);
  expect(JSON.parse((await read()).toString('utf8'))).toEqual({format: 'ets2telemetry.settings', version: 1, units: {ets2: 'metric', ats: 'metric'}});
});

it('bounds outstanding saves to four and reports idle work until they settle', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const settings = store(wrapped({rename: async (from, to) => {await gate; await fs.rename(from, to);}}));
  await settings.load();
  expect(settings.idle()).toBeUndefined();
  const accepted = [settings.setUnitProfile('ets2', 'us-customary'), settings.setUnitProfile('ats', 'metric'), settings.setUnitProfile('ets2', 'metric'), settings.setUnitProfile('ats', 'us-customary')];
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toBeInstanceOf(SettingsBusyError);
  const idle = settings.idle(); expect(idle).toBeInstanceOf(Promise);
  let settled = false; void idle!.then(() => {settled = true;});
  await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
  release(); await Promise.all(accepted); await idle;
  expect(settled).toBe(true); expect(settings.idle()).toBeUndefined();
  expect(settings.view().units).toEqual({ets2: 'metric', ats: 'us-customary'});
});

it('is read-only with defaults when there is no valid settings location', async () => {
  const settings = new SettingsStore(undefined, {log: (event, _detail, facts) => events.push({event, ...(facts ? {facts: {...facts}} : {})})});
  expect(await settings.load()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'unavailable', writable: false, saveError: null});
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(events[0]).toEqual({event: 'SETTINGS_FALLBACK', facts: {state: 'unavailable'}});
});

// Changed on October 15, 2026 (clean late read): an expired budget now returns the pending `loading` state instead of
// `unreadable`; only the 30 s read limit makes a read that never settles `unreadable` (see the cases below).
it('returns a pending read-only state when loading exceeds its 1000 ms budget', async () => {
  const timers: {callback: () => void; milliseconds: number}[] = [];
  const settings = store(wrapped({lstat: () => new Promise(() => undefined)}), {timers: {
    setTimeout: (callback, milliseconds) => {timers.push({callback, milliseconds}); return timers.length;}, clearTimeout: () => undefined}});
  const loading = settings.load();
  await new Promise(resolve => setImmediate(resolve));
  expect(timers.map(timer => timer.milliseconds)).toEqual([1000]);
  timers[0].callback();
  expect(await loading).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'loading', writable: false, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget'}}]);
});

// Fix round 1.
it('refuses saves at once and stays idle after the load budget expired with a read that never settles', async () => {
  const timers: {callback: () => void}[] = [];
  const settings = store(wrapped({lstat: () => new Promise(() => undefined)}), {timers: {
    setTimeout: callback => {timers.push({callback}); return timers.length;}, clearTimeout: () => undefined}});
  const loading = settings.load();
  await new Promise(resolve => setImmediate(resolve));
  timers[0].callback(); await loading;
  const outcome = await Promise.race([settings.setUnitProfile('ets2', 'us-customary').then(() => 'resolved', (error: unknown) => error),
    new Promise(resolve => setTimeout(() => resolve('still pending after 100 ms'), 100))]);
  expect(outcome).toBeInstanceOf(SettingsError); expect((outcome as SettingsError).code).toBe('SETTINGS_WRITE_FAILED');
  expect(settings.idle()).toBeUndefined();
  // `loading` since the clean late read (October 15, 2026); it was `unreadable` when the budget ended the read.
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'loading', writable: false, saveError: 'SETTINGS_WRITE_FAILED'});
  // Further requests are refused too, never queued toward the four-request bound.
  for (let attempt = 0; attempt < 5; attempt++) await expect(settings.setUnitProfile('ats', 'metric')).rejects.toBeInstanceOf(SettingsError);
});

// Clean late read (October 15, 2026). Hosted run 38755116140 starved startup under the smoke's 25 % CPU cap: the read
// outlasted the 1000 ms budget and the session kept read-only defaults although the file was readable. A read that
// outlasts the budget is now applied when it settles, unless the 30 s read limit declared it hung first.
interface ControlledTimer {callback: () => void; milliseconds: number; cleared: boolean}
function controlledTimers() {
  const started: ControlledTimer[] = [];
  return {started, timers: {
    setTimeout: (callback: () => void, milliseconds: number) => {const timer = {callback, milliseconds, cleared: false}; started.push(timer); return timer;},
    clearTimeout: (handle: unknown) => {(handle as ControlledTimer).cleared = true;}
  }};
}
/** Real file operations whose `lstat` calls wait until `release()`. */
function delayedRead(overrides: Partial<SettingsFileSystem> = {}) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  return {release, fs: wrapped({lstat: async target => {await gate; return fs.lstat(target);}, ...overrides})};
}
/** Starts a load over a delayed read and lets its 1000 ms budget expire. */
async function loadPastBudget(fileSystem: SettingsFileSystem) {
  const {started, timers} = controlledTimers(), changed = vi.fn();
  const settings = store(fileSystem, {timers, changed});
  const loading = settings.load();
  await new Promise(resolve => setImmediate(resolve));
  expect(started.map(timer => timer.milliseconds)).toEqual([1000]);
  started[0].callback();
  const pending = await loading;
  return {settings, started, changed, pending};
}
const PENDING_VIEW = {units: {ets2: 'metric', ats: 'us-customary'}, state: 'loading', writable: false, saveError: null};
const PENDING_EVENT = {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget'}};

it('applies a corrupt file read that outlasts the load budget once it settles (hosted run 38755116140)', async () => {
  await seed(CORRUPT);
  const gated = delayedRead();
  const {settings, started, changed, pending} = await loadPastBudget(gated.fs);
  expect(pending).toEqual(PENDING_VIEW);
  expect(events).toEqual([PENDING_EVENT]);
  // The pending read is bounded by the read limit, 30 s after the load started.
  expect(started.map(timer => timer.milliseconds)).toEqual([1000, 29000]);
  gated.release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'invalid-file', writable: true, saveError: null});
  expect(started[1].cleared).toBe(true);
  expect(events).toEqual([PENDING_EVENT, {event: 'SETTINGS_FALLBACK', facts: {state: 'invalid-file'}}]);
  // Applying the late result wrote nothing; the first save then quarantines the file byte-identically.
  expect((await read()).toString('utf8')).toBe(CORRUPT); expect(await list()).toEqual(['settings.json']);
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded', writable: true, saveError: null});
  expect(await list()).toEqual(['settings.json', 'settings.rejected-20261015T094107Z.json']);
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(CORRUPT);
  expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
  expect(changed).toHaveBeenCalledOnce();
});

it.each([
  {name: 'a valid file', content: VALID_METRIC, view: {units: {ets2: 'metric', ats: 'metric'}, state: 'loaded', writable: true}, event: {event: 'SETTINGS_LOADED', facts: {state: 'loaded'}}},
  {name: 'a file with fallbacks', content: '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"us-customary","ats":"imperial"}}',
    view: {units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded-with-fallbacks', writable: true}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'loaded-with-fallbacks', fields: 'units.ats'}}},
  {name: 'an unsupported older file', content: '{"format":"ets2telemetry.settings","units":{"ets2":"us-customary","ats":"metric"}}',
    view: {units: {ets2: 'metric', ats: 'us-customary'}, state: 'unsupported-older', writable: true}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'unsupported-older'}}},
  {name: 'a newer-version file', content: '{"format":"ets2telemetry.settings","version":2,"units":{"ets2":"us-customary","ats":"metric"}}',
    view: {units: {ets2: 'metric', ats: 'us-customary'}, state: 'newer-version', writable: false}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'newer-version'}}}
])('applies a late read of $name with its own state and writability, writing nothing', async ({content, view, event}) => {
  await seed(content);
  const gated = delayedRead();
  const {settings, changed, pending} = await loadPastBudget(gated.fs);
  expect(pending).toEqual(PENDING_VIEW);
  gated.release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(settings.view()).toEqual({...view, saveError: null});
  expect(events).toEqual([PENDING_EVENT, event]);
  expect((await read()).toString('utf8')).toBe(content); expect(await list()).toEqual(['settings.json']);
  if (view.state === 'newer-version') {
    await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
    expect((await read()).toString('utf8')).toBe(content); expect(await list()).toEqual(['settings.json']);
  }
});

it('refuses a save during the pending read at once and quarantines a late invalid file only after applying it', async () => {
  await seed(CORRUPT);
  const gated = delayedRead();
  const {settings, changed} = await loadPastBudget(gated.fs);
  const outcome = await Promise.race([settings.setUnitProfile('ets2', 'us-customary').then(() => 'resolved', (error: unknown) => error),
    new Promise(resolve => setTimeout(() => resolve('still pending after 100 ms'), 100))]);
  expect(outcome).toBeInstanceOf(SettingsError); expect((outcome as SettingsError).code).toBe('SETTINGS_WRITE_FAILED');
  expect(settings.idle()).toBeUndefined();
  expect(settings.view()).toEqual({...PENDING_VIEW, saveError: 'SETTINGS_WRITE_FAILED'});
  expect(events.at(-1)).toEqual({event: 'SETTINGS_WRITE_FAILED', facts: {step: 'unavailable', state: 'loading'}});
  // Refused requests are never queued toward the four-request bound.
  for (let attempt = 0; attempt < 5; attempt++) await expect(settings.setUnitProfile('ats', 'metric')).rejects.toBeInstanceOf(SettingsError);
  gated.release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  // Nothing was written, renamed or quarantined while the read was pending.
  expect((await read()).toString('utf8')).toBe(CORRUPT); expect(await list()).toEqual(['settings.json']);
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'invalid-file', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  expect(await settings.setUnitProfile('ats', 'metric')).toEqual({units: {ets2: 'metric', ats: 'metric'}, state: 'loaded', writable: true, saveError: null});
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(CORRUPT);
});

it('keeps a late read error read-only', async () => {
  await seed(VALID_METRIC);
  const gated = delayedRead({open: async (file, flags) => {if (flags === 'r') throw errno('EIO'); return fs.open(file, flags);}});
  const {settings, started, changed} = await loadPastBudget(gated.fs);
  gated.release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(started[1].cleared).toBe(true);
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'unreadable', writable: false, saveError: null});
  expect(events).toEqual([PENDING_EVENT, {event: 'SETTINGS_FALLBACK', facts: {state: 'unreadable', reason: 'read'}}]);
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('declares a read hung at the 30 s limit, stays read-only and ignores its later result', async () => {
  await seed(VALID_METRIC);
  const gated = delayedRead();
  const {settings, started, changed} = await loadPastBudget(gated.fs);
  expect(changed).not.toHaveBeenCalled();
  started[1].callback();
  expect(changed).toHaveBeenCalledOnce();
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'unreadable', writable: false, saveError: null});
  expect(events).toEqual([PENDING_EVENT, {event: 'SETTINGS_FALLBACK', facts: {state: 'unreadable', reason: 'load-limit'}}]);
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  // The read finishing after the limit changes nothing and is not reported again.
  const seen = events.length;
  gated.release();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect(changed).toHaveBeenCalledOnce();
  expect(settings.view()).toMatchObject({state: 'unreadable', writable: false, units: {ets2: 'metric', ats: 'us-customary'}});
  expect(events).toHaveLength(seen);
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('lets a save requested before the load returned wait at most until the read limit', async () => {
  await seed(VALID_METRIC);
  const gated = delayedRead();
  const {started, timers} = controlledTimers();
  const settings = store(gated.fs, {timers});
  const loading = settings.load();
  // Requested before load() returned: it queues behind the read's outcome, as before.
  const early = settings.setUnitProfile('ets2', 'us-customary').then(() => 'resolved', (error: unknown) => error);
  await new Promise(resolve => setImmediate(resolve));
  started[0].callback(); expect(await loading).toEqual(PENDING_VIEW);
  expect(settings.idle()).toBeInstanceOf(Promise);
  started[1].callback();
  const outcome = await early;
  expect(outcome).toBeInstanceOf(SettingsError); expect((outcome as SettingsError).code).toBe('SETTINGS_WRITE_FAILED');
  expect(settings.idle()).toBeUndefined();
  gated.release();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('reports a failed save in the view and clears it with the next successful save', async () => {
  let failing = true;
  const settings = store(wrapped({rename: async (from, to) => {if (failing) throw errno('EIO'); await fs.rename(from, to);}}));
  await settings.load();
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toEqual({units: {ets2: 'metric', ats: 'us-customary'}, state: 'defaults', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  failing = false;
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded', writable: true, saveError: null});
});
