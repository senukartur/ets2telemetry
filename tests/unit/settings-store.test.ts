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
// ET-012a added the overlay block (format v2); ET-012b adds its placements, so every save now writes format v3
// (hand-written below). v1 and v2 files are migrated in memory and stay unchanged on disk until the first save.
// ET-052: the fifteenth section (the next mandatory break, on by default) makes the current format v11 (ET-050b took v10); the fourteen
// sections of before are OLD_ALL_ON, which every older seed below carries.
const OLD_ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
const ALL_ON = {...OLD_ALL_ON, 'mandatory-break': true};
// The ET-012a anchors at scale 1, in canonical layout order.
const PLACEMENTS = {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}};
const DEFAULT_OVERLAY = {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: ALL_ON, placements: PLACEMENTS};
type Placements = typeof PLACEMENTS;
/** The exact v3 lines of one layout's placement. */
const placementText = (layout: keyof Placements, placements: Placements, last = false) => {
  const {x, y, scale} = placements[layout];
  return [`      "${layout}": {`, `        "x": ${x},`, `        "y": ${y},`, `        "scale": ${scale}`, last ? '      }' : '      },'];
};
/** The exact v3 lines of the overlay block, closing the document. */
const overlayText = (layout: string, rpm = true, placements: Placements = PLACEMENTS, withBreak = true) => ['  "overlay": {', '    "enabled": true,', '    "backgroundOpacity": 80,', `    "layout": "${layout}",`, '    "sections": {',
  '      "speed": true,', '      "gear": true,',
  `      "rpm": ${rpm},`, '      "fuel": true,', '      "range": true,', '      "sdk-consumption": true,', '      "cargo": true,', '      "origin": true,',
  '      "destination": true,', '      "distance-driven": true,', '      "distance-remaining": true,', '      "deadline": true,', '      "expected-income": true,',
  ...(withBreak ? ['      "game-time": true,', '      "mandatory-break": true'] : ['      "game-time": true']), '    },', '    "placements": {', ...placementText('strip', placements), ...placementText('card', placements),
  ...placementText('cluster', placements), ...placementText('hud', placements, true), '    }', '  }', '}', ''].join('\n');
/** The exact v8 file (ET-045e: it changed only the version number from ET-049's v7 layout); older seeds derive from it. */
const v8Text = (ets2: string, ats: string, language = 'en', layout = 'strip', rpm = true, placements: Placements = PLACEMENTS, autostart = false) =>
  `{\n  "format": "ets2telemetry.settings",\n  "version": 8,\n  "language": "${language}",\n  "autostart": ${autostart},\n  "units": {\n    "ets2": "${ets2}",\n    "ats": "${ats}"\n  },\n` + overlayText(layout, rpm, placements, false);
// ET-050: the requirement for the current format changed to v9, which adds the per-game gear display block after the
// units; every current write below is v9 (hand-written), while older seeds are still derived from the v8 text.
// ET-050b (owner option B, October 26, 2026): the requirement changed again to v10, which changes only the version number
// and adds the crawler gear mode; every current write below is now v10, and newer-version seeds moved from 10 to 11.
const AUTO = {ets2: 'automatic', ats: 'automatic'} as const;
type Gears = {ets2: string; ats: string};
/** The exact pre-break file (ET-050b: format v10, the gear display block after the units, fourteen overlay sections). */
const v10Text = (ets2: string, ats: string, language = 'en', layout = 'strip', rpm = true, placements: Placements = PLACEMENTS, autostart = false, gears: Gears = AUTO) =>
  `{\n  "format": "ets2telemetry.settings",\n  "version": 10,\n  "language": "${language}",\n  "autostart": ${autostart},\n  "units": {\n    "ets2": "${ets2}",\n    "ats": "${ats}"\n  },\n` +
  `  "gearDisplay": {\n    "ets2": "${gears.ets2}",\n    "ats": "${gears.ats}"\n  },\n` + overlayText(layout, rpm, placements, false);
// ET-052: the requirement for the current format changed to v11 (ET-050b took v10 first), which adds the fifteenth section key
// after game time; every current write below is v11 (hand-written), while older seeds are derived from the v8 and v10 texts.
/** The exact current file (ET-052: format v11, the v10 layout plus "mandatory-break" last among the sections). */
const v11Text = (ets2: string, ats: string, language = 'en', layout = 'strip', rpm = true, placements: Placements = PLACEMENTS, autostart = false, gears: Gears = AUTO) =>
  `{\n  "format": "ets2telemetry.settings",\n  "version": 11,\n  "language": "${language}",\n  "autostart": ${autostart},\n  "units": {\n    "ets2": "${ets2}",\n    "ats": "${ats}"\n  },\n` +
  `  "gearDisplay": {\n    "ets2": "${gears.ets2}",\n    "ats": "${gears.ats}"\n  },\n` + overlayText(layout, rpm, placements, true);
// ET-050b per-gearbox modes (owner decision of October 27, 2026): the requirement for the current format changed to v12,
// which adds the per-game gearbox lists after the gear display block; every current write below is v12 (hand-written), and
// newer-version seeds moved from 12 to 13.
const NO_GEARBOXES = {ets2: [], ats: []};
/** The exact current file (format v12: the v11 layout plus empty gearbox lists after the gear display block). */
const v12Text = (ets2: string, ats: string, language = 'en', layout = 'strip', rpm = true, placements: Placements = PLACEMENTS, autostart = false, gears: Gears = AUTO) =>
  `{\n  "format": "ets2telemetry.settings",\n  "version": 12,\n  "language": "${language}",\n  "autostart": ${autostart},\n  "units": {\n    "ets2": "${ets2}",\n    "ats": "${ats}"\n  },\n` +
  `  "gearDisplay": {\n    "ets2": "${gears.ets2}",\n    "ats": "${gears.ats}"\n  },\n` +
  `  "gearboxGearDisplay": {\n    "ets2": [],\n    "ats": []\n  },\n` + overlayText(layout, rpm, placements, true);
const EXPECTED_US_ETS2 = v12Text('us-customary', 'us-customary');
const VALID_METRIC = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric","ats":"metric"}}';
const VALID_V2 = '{"format":"ets2telemetry.settings","version":2,"units":{"ets2":"metric","ats":"metric"},"overlay":{"layout":"hud","sections":' +
  JSON.stringify({...OLD_ALL_ON, rpm: false}) + '}}';
const MOVED: Placements = {...PLACEMENTS, card: {x: 0.25, y: 0.75, scale: 1.5}};
const VALID_V3 = '{"format":"ets2telemetry.settings","version":3,"units":{"ets2":"metric","ats":"metric"},"overlay":{"layout":"hud","sections":' +
  JSON.stringify({...OLD_ALL_ON, rpm: false}) + ',"placements":' + JSON.stringify(MOVED) + '}}';
const MIGRATED = {migratedFrom: 1};
const CORRUPT = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"metric",';

it('loads v4 without writing, durably saves visibility false, and restarts without rewriting', async () => {
  const old = v8Text('metric', 'metric').replace('"version": 8', '"version": 4').replace('    "enabled": true,\n', '');
  await seed(old); const settings = store();
  expect((await settings.load()).overlay.enabled).toBe(true); expect((await read()).toString()).toBe(old);
  expect((await settings.setOverlayEnabled(false)).overlay.enabled).toBe(false);
  const saved = await read(); expect(JSON.parse(saved.toString())).toMatchObject({version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: false}});
  const restarted = store(); expect((await restarted.load()).overlay.enabled).toBe(false);
  expect(await read()).toEqual(saved); expect(await list()).toEqual(['settings.json']);
});
it('keeps committed visibility on failure, recovers, and refuses read-only visibility writes', async () => {
  let fail = true;
  const settings = store(wrapped({rename: async (a, b) => {if (fail) throw errno('EIO'); await fs.rename(a, b);}})); await settings.load();
  await expect(settings.setOverlayEnabled(false)).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view().overlay.enabled).toBe(true); fail = false;
  expect(await settings.setOverlayEnabled(false)).toMatchObject({overlay: {enabled: false}, saveError: null});
  const newer = '{"format":"ets2telemetry.settings","version":13}'; await seed(newer); const readOnly = store(); await readOnly.load();
  await expect(readOnly.setOverlayEnabled(false)).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'}); expect((await read()).toString()).toBe(newer);
});
it('queues visibility with other settings without applying it early or exceeding the shared bound', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => {release = r;}), writing = new Promise<void>(r => {entered = r;}); let first = true;
  const settings = store(wrapped({rename: async (a, b) => {if (first) {first = false; entered(); await gate;} await fs.rename(a, b);}})); await settings.load();
  const off = settings.setOverlayEnabled(false); await writing; expect(settings.view().overlay.enabled).toBe(true);
  const rest = [settings.setAutostart(true), settings.setLanguage('ru'), settings.setOverlayLayout('hud')];
  await expect(settings.setOverlayEnabled(false)).rejects.toBeInstanceOf(SettingsBusyError); release();
  expect((await off).overlay.enabled).toBe(false); await Promise.all(rest);
  expect(settings.view()).toMatchObject({autostart: true, language: 'ru', overlay: {enabled: false, backgroundOpacity: 80, layout: 'hud'}});
});

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
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: null});
  expect(existsSync(path.join(resources.directory, 'ETS2Telemetry'))).toBe(false);
  await fs.mkdir(directory, {recursive: true});
  expect(await store().load()).toMatchObject({state: 'defaults'});
  expect(await list()).toEqual([]);
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}, {event: 'SETTINGS_LOADED', facts: {state: 'defaults'}}]);
});

it('loads a valid file without rewriting it', async () => {
  await seed(VALID_METRIC);
  expect(await store().load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('writes the exact v3 content, synced before the rename, and applies it only afterwards', async () => {
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
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  expect(order).toEqual(['open', 'write', 'sync', 'close', 'rename']);
  expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
  expect(await list()).toEqual(['settings.json']);
  expect(await store().load()).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
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
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
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
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: null});
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
  const newer = '{"format":"ets2telemetry.settings","version":13,"units":{"ets2":"us-customary","ats":"metric"},"layout":{}}';
  await seed(newer);
  const settings = store();
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'newer-version', writable: false, saveError: null});
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer); expect(await list()).toEqual(['settings.json']);
  expect(settings.view()).toMatchObject({state: 'newer-version', units: {ets2: 'metric'}, saveError: 'SETTINGS_READ_ONLY'});
  expect(events.map(row => row.event)).toEqual(['SETTINGS_FALLBACK', 'SETTINGS_SAVE_REFUSED']);
});

it('rewrites a file with fallbacks completely without quarantining it', async () => {
  await seed('{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"imperial","ats":"metric"},"extra":true}');
  const settings = store();
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded-with-fallbacks', writable: true, saveError: null});
  expect(events[0]).toEqual({event: 'SETTINGS_FALLBACK', facts: {state: 'loaded-with-fallbacks', fields: 'units.ets2', ...MIGRATED}});
  await settings.setUnitProfile('ats', 'us-customary');
  expect(await list()).toEqual(['settings.json']);
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'us-customary', 'en'));
});

it('refuses a settings directory that is a junction, without reading or writing through it', async () => {
  const elsewhere = path.join(resources.directory, 'elsewhere');
  await fs.mkdir(elsewhere); await fs.writeFile(path.join(elsewhere, 'settings.json'), VALID_METRIC);
  await fs.mkdir(path.dirname(directory), {recursive: true}); await fs.symlink(elsewhere, directory, 'junction');
  const settings = store();
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'unreadable', writable: false, saveError: null});
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
  expect(JSON.parse((await read()).toString('utf8'))).toEqual({format: 'ets2telemetry.settings', version: 12, language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY});
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
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'unavailable', writable: false, saveError: null});
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
  expect(await loading).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loading', writable: false, saveError: null});
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
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loading', writable: false, saveError: 'SETTINGS_WRITE_FAILED'});
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
/**
 * Real file operations whose `lstat` calls wait until `release()`. `settled` resolves with the bytes read once the
 * settings file opened for reading has been closed, so a test can wait for the read itself instead of sleeping.
 */
function delayedRead(overrides: Partial<SettingsFileSystem> = {}) {
  let release!: () => void, settle!: (bytesRead: number) => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const settled = new Promise<number>(resolve => {settle = resolve;});
  const base = wrapped(overrides);
  const open: SettingsFileSystem['open'] = async (target, flags) => {
    const handle = await base.open(target, flags);
    if (flags !== 'r') return handle;
    let bytesRead = 0;
    return {...handle,
      read: async (...args: Parameters<typeof handle.read>) => {const result = await handle.read(...args); bytesRead += result.bytesRead; return result;},
      close: async () => {await handle.close(); settle(bytesRead);}};
  };
  return {release, settled, fs: wrapped({lstat: async target => {await gate; return fs.lstat(target);}, ...overrides, open})};
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
const PENDING_VIEW = {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loading', writable: false, saveError: null};
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
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: null});
  expect(started[1].cleared).toBe(true);
  expect(events).toEqual([PENDING_EVENT, {event: 'SETTINGS_FALLBACK', facts: {state: 'invalid-file'}}]);
  // Applying the late result wrote nothing; the first save then quarantines the file byte-identically.
  expect((await read()).toString('utf8')).toBe(CORRUPT); expect(await list()).toEqual(['settings.json']);
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  expect(await list()).toEqual(['settings.json', 'settings.rejected-20261015T094107Z.json']);
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(CORRUPT);
  expect((await read()).toString('utf8')).toBe(EXPECTED_US_ETS2);
  expect(changed).toHaveBeenCalledOnce();
});

it.each([
  {name: 'a valid file', content: VALID_METRIC, view: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true}, event: {event: 'SETTINGS_LOADED', facts: {state: 'loaded', ...MIGRATED}}},
  {name: 'a file with fallbacks', content: '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"us-customary","ats":"imperial"}}',
    view: {language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded-with-fallbacks', writable: true}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'loaded-with-fallbacks', fields: 'units.ats', ...MIGRATED}}},
  {name: 'an unsupported older file', content: '{"format":"ets2telemetry.settings","units":{"ets2":"us-customary","ats":"metric"}}',
    view: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'unsupported-older', writable: true}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'unsupported-older'}}},
  {name: 'a newer-version file', content: '{"format":"ets2telemetry.settings","version":13,"units":{"ets2":"us-customary","ats":"metric"}}',
    view: {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'newer-version', writable: false}, event: {event: 'SETTINGS_FALLBACK', facts: {state: 'newer-version'}}}
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
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  expect(await settings.setUnitProfile('ats', 'metric')).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  expect((await read('settings.rejected-20261015T094107Z.json')).toString('utf8')).toBe(CORRUPT);
});

it('keeps a late read error read-only', async () => {
  await seed(VALID_METRIC);
  const gated = delayedRead({open: async (file, flags) => {if (flags === 'r') throw errno('EIO'); return fs.open(file, flags);}});
  const {settings, started, changed} = await loadPastBudget(gated.fs);
  gated.release();
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(started[1].cleared).toBe(true);
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'unreadable', writable: false, saveError: null});
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
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'unreadable', writable: false, saveError: null});
  expect(events).toEqual([PENDING_EVENT, {event: 'SETTINGS_FALLBACK', facts: {state: 'unreadable', reason: 'load-limit'}}]);
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  // The read finishing after the limit changes nothing and is not reported again.
  const seen = events.length;
  gated.release();
  // The late read completes (the whole file is read and closed); anything it would change happens before setImmediate.
  expect(await gated.settled).toBe(Buffer.byteLength(VALID_METRIC));
  await new Promise(resolve => setImmediate(resolve));
  expect(changed).toHaveBeenCalledOnce();
  expect(settings.view()).toMatchObject({state: 'unreadable', writable: false, units: {ets2: 'metric', ats: 'us-customary'}});
  expect(events).toHaveLength(seen); expect(settings.knownAutostartIntent).toBeUndefined();
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
  // The late read completes; it neither applies nor triggers the refused save. Checked in memory first (no save work
  // pending, the read-limit state kept), so a late read that applied or queued a save fails here deterministically.
  expect(await gated.settled).toBe(Buffer.byteLength(VALID_METRIC));
  await new Promise(resolve => setImmediate(resolve));
  expect(settings.idle()).toBeUndefined();
  expect(settings.view()).toMatchObject({state: 'unreadable', writable: false});
  expect((await read()).toString('utf8')).toBe(VALID_METRIC); expect(await list()).toEqual(['settings.json']);
});

it('reports a failed save in the view and clears it with the next successful save', async () => {
  let failing = true;
  const settings = store(wrapped({rename: async (from, to) => {if (failing) throw errno('EIO'); await fs.rename(from, to);}}));
  await settings.load();
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  failing = false;
  expect(await settings.setUnitProfile('ets2', 'us-customary')).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
});

// ET-012a: the overlay block (format v2, since ET-012b written as v3).
it('keeps a v1 file byte-identical at startup and writes v3 with its units on the first overlay save', async () => {
  const v1 = '{"format":"ets2telemetry.settings","version":1,"units":{"ets2":"us-customary","ats":"metric"}}';
  await seed(v1);
  const settings = store();
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 1}}]);
  expect((await read()).toString('utf8')).toBe(v1); expect(await list()).toEqual(['settings.json']);
  expect(await settings.setOverlayLayout('card')).toEqual({language: 'en', autostart: false, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'card', sections: ALL_ON, placements: PLACEMENTS},
    state: 'loaded', writable: true, saveError: null});
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'metric', 'en', 'card'));
  // A migrated file is not quarantined: it was valid.
  expect(await list()).toEqual(['settings.json']);
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {overlayLayout: 'card'}});
});

// ET-012b (REG-017): settings format v3 with the overlay placements.
it('keeps a v2 file byte-identical at startup with default placements, and rewrites it as v3 on the first save', async () => {
  await seed(VALID_V2);
  const settings = store();
  expect(await settings.load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: {...ALL_ON, rpm: false}, placements: PLACEMENTS},
    state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 2}}]);
  expect((await read()).toString('utf8')).toBe(VALID_V2); expect(await list()).toEqual(['settings.json']);
  await settings.setUnitProfile('ets2', 'us-customary');
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'metric', 'en', 'hud', false));
  expect(await list()).toEqual(['settings.json']);
});

it('loads a v3 file with its placements and reports migration to v4', async () => {
  await seed(VALID_V3);
  expect(await store().load()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: {...ALL_ON, rpm: false}, placements: MOVED},
    state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 3}}]);
  expect((await read()).toString('utf8')).toBe(VALID_V3);
});

it('saves one layout placement as exact v3 bytes, applied only after the rename, with the layout and scale as facts', async () => {
  await seed(VALID_V3);
  // The rename checks that nothing was applied before it; `settings` is assigned before any save runs.
  const settings: SettingsStore = store(wrapped({rename: async (from, to) => {expect(settings.view().overlay.placements.strip).toEqual(PLACEMENTS.strip); await fs.rename(from, to);}}));
  await settings.load();
  const view = await settings.setOverlayPlacement('strip', {x: 0.123456, y: 1, scale: 1.25});
  const saved = {...MOVED, strip: {x: 0.1235, y: 1, scale: 1.25}};
  expect(view).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: {...ALL_ON, rpm: false}, placements: saved},
    state: 'loaded', writable: true, saveError: null});
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'metric', 'en', 'hud', false, saved));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {overlayPlacement: 'strip', overlayScale: 1.25}});
  expect(await store().load()).toMatchObject({state: 'loaded', overlay: {placements: saved}});
});

// ET-045e (decision Z5, owner decision D1 option b, REG-017; ET-049 took v7 first): a v7 file is read with every
// placement number unchanged and stays byte-identical at startup; the first save writes v8 with the same numbers, which
// now mean the rebased settings.
const OWNER_PLACEMENTS: Placements = {strip: {x: 0.8485, y: 1, scale: 0.5}, card: {x: 1, y: 0, scale: 2}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1.5}};
it('keeps a v7 file byte-identical at startup and writes v8 with the same placement numbers on the first save', async () => {
  const v7 = v8Text('metric', 'us-customary', 'ru', 'strip', true, OWNER_PLACEMENTS, true).replace('"version": 8', '"version": 7');
  await seed(v7);
  const settings = store();
  expect(await settings.load()).toEqual({language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...DEFAULT_OVERLAY, placements: OWNER_PLACEMENTS},
    state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 7}}]);
  expect((await read()).toString('utf8')).toBe(v7); expect(await list()).toEqual(['settings.json']);
  await settings.setUnitProfile('ats', 'metric');
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'metric', 'ru', 'strip', true, OWNER_PLACEMENTS, true));
  expect(await list()).toEqual(['settings.json']);
  expect(await store().load()).toMatchObject({state: 'loaded', overlay: {placements: OWNER_PLACEMENTS}});
});

// ET-052 (MB11, owner decision D2, REG-017): a v10 file is read with the next mandatory break on and every other saved choice
// kept, stays byte-identical at startup, and the first save writes v11 with the break last among the sections.
it('keeps a v10 file byte-identical at startup, loads it with the break on, and writes v11 on the first save', async () => {
  const v10 = v10Text('metric', 'us-customary', 'ru', 'card', false, OWNER_PLACEMENTS, true, {ets2: 'manual', ats: 'automatic'});
  await seed(v10);
  const settings = store();
  expect(await settings.load()).toEqual({language: 'ru', autostart: true, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'manual', ats: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {...DEFAULT_OVERLAY, layout: 'card', sections: {...ALL_ON, rpm: false}, placements: OWNER_PLACEMENTS}, state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 10}}]);
  expect((await read()).toString('utf8')).toBe(v10); expect(await list()).toEqual(['settings.json']);
  await settings.setUnitProfile('ats', 'metric');
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'metric', 'ru', 'card', false, OWNER_PLACEMENTS, true, {ets2: 'manual', ats: 'automatic'}));
  expect(await list()).toEqual(['settings.json']);
  // The restart reads the written v12 without a migration and without writing.
  const written = await read(), restarted = store();
  expect(await restarted.load()).toMatchObject({state: 'loaded', overlay: {sections: {...ALL_ON, rpm: false}}});
  expect(events.at(-1)).toEqual({event: 'SETTINGS_LOADED', facts: {state: 'loaded'}});
  expect(await read()).toEqual(written);
});
it('reads a version 13 file as read-only newer-version and never modifies it', async () => {
  const newer = '{"format":"ets2telemetry.settings","version":13,"overlay":{"sections":{}}}';
  await seed(newer); const settings = store(); await settings.load();
  expect(settings.view()).toMatchObject({state: 'newer-version', writable: false, overlay: DEFAULT_OVERLAY});
  await expect(settings.setOverlaySections(ALL_ON)).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer);
});

it('saves and reloads a placement at the 300% maximum', async () => {
  await seed(VALID_V3);
  const settings = store(); await settings.load();
  const saved = {...MOVED, hud: {x: 0, y: 0, scale: 3}};
  expect(await settings.setOverlayPlacement('hud', {x: 0, y: 0, scale: 3})).toMatchObject({overlay: {placements: saved}, saveError: null});
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'metric', 'en', 'hud', false, saved));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {overlayPlacement: 'hud', overlayScale: 3}});
  expect(await store().load()).toMatchObject({state: 'loaded', overlay: {placements: saved}});
});

it('keeps the previous placement when a placement save fails and refuses it while read-only', async () => {
  await seed(VALID_V3);
  const settings = store(wrapped({rename: () => Promise.reject(errno('EIO'))}));
  await settings.load();
  await expect(settings.setOverlayPlacement('card', {x: 0, y: 0, scale: 2})).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toMatchObject({overlay: {placements: MOVED}, saveError: 'SETTINGS_WRITE_FAILED'});
  expect((await read()).toString('utf8')).toBe(VALID_V3); expect(await list()).toEqual(['settings.json']);
  const newer = '{"format":"ets2telemetry.settings","version":13,"overlay":{"placements":{}}}';
  await seed(newer);
  const readOnly = store(); await readOnly.load();
  await expect(readOnly.setOverlayPlacement('card', {x: 0, y: 0, scale: 2})).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer); expect(readOnly.view().overlay.placements).toEqual(PLACEMENTS);
  const gated = delayedRead();
  const pending = await loadPastBudget(gated.fs);
  await expect(pending.settings.setOverlayPlacement('hud', {x: 0, y: 0, scale: 1})).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  gated.release();
  await vi.waitFor(() => expect(pending.changed).toHaveBeenCalledOnce());
});

it('serializes placement saves with unit and overlay saves in one queue and one four-request bound', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const settings = store(wrapped({rename: async (from, to) => {await gate; await fs.rename(from, to);}}));
  await settings.load();
  const accepted = [settings.setOverlayPlacement('card', {x: 0.25, y: 0.75, scale: 1.5}), settings.setUnitProfile('ets2', 'us-customary'),
    settings.setOverlaySections({...ALL_ON, rpm: false}), settings.setOverlayPlacement('strip', {x: 0, y: 0, scale: 0.5})];
  await expect(settings.setOverlayPlacement('hud', {x: 0, y: 0, scale: 1})).rejects.toBeInstanceOf(SettingsBusyError);
  release(); await Promise.all(accepted);
  const saved = {...MOVED, strip: {x: 0, y: 0, scale: 0.5}};
  expect(settings.view()).toMatchObject({units: {ets2: 'us-customary', ats: 'us-customary'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: {...ALL_ON, rpm: false}, placements: saved}});
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'us-customary', 'en', 'strip', false, saved));
  expect(events.filter(row => row.event === 'SETTINGS_SAVED').map(row => row.facts)).toEqual([
    {overlayPlacement: 'card', overlayScale: 1.5}, {game: 'ets2', profile: 'us-customary'}, {overlaySections: 14}, {overlayPlacement: 'strip', overlayScale: 0.5}]);
});

it('saves overlay sections as exact v3 bytes, applied only after the rename, with the enabled count as its fact', async () => {
  // The rename checks that nothing was applied before it; `settings` is assigned before any save runs.
  const settings: SettingsStore = store(wrapped({rename: async (from, to) => {expect(settings.view().overlay.sections.rpm).toBe(true); await fs.rename(from, to);}}));
  await settings.load();
  const view = await settings.setOverlaySections({...ALL_ON, rpm: false});
  expect(view.overlay).toEqual({enabled: true, backgroundOpacity: 80, layout: 'strip', sections: {...ALL_ON, rpm: false}, placements: PLACEMENTS});
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'us-customary', 'en', 'strip', false));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {overlaySections: 14}});
  expect(await store().load()).toMatchObject({state: 'loaded', overlay: {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: {...ALL_ON, rpm: false}}});
});

it('keeps the previous overlay settings in use when an overlay save fails', async () => {
  await seed(VALID_V2);
  const settings = store(wrapped({rename: () => Promise.reject(errno('EIO'))}));
  await settings.load();
  await expect(settings.setOverlayLayout('cluster')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  await expect(settings.setOverlaySections(ALL_ON)).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toEqual({language: 'en', autostart: false, units: {ets2: 'metric', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: {...ALL_ON, rpm: false}, placements: PLACEMENTS},
    state: 'loaded', writable: true, saveError: 'SETTINGS_WRITE_FAILED'});
  expect((await read()).toString('utf8')).toBe(VALID_V2); expect(await list()).toEqual(['settings.json']);
});

it('refuses overlay saves for a newer-version file and while the startup read is pending', async () => {
  const newer = '{"format":"ets2telemetry.settings","version":13,"overlay":{"layout":"card"}}';
  await seed(newer);
  const settings = store(); await settings.load();
  await expect(settings.setOverlayLayout('card')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  await expect(settings.setOverlaySections(ALL_ON)).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer); expect(settings.view().overlay).toEqual(DEFAULT_OVERLAY);
  const gated = delayedRead();
  const pending = await loadPastBudget(gated.fs);
  await expect(pending.settings.setOverlayLayout('hud')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  await expect(pending.settings.setOverlaySections(ALL_ON)).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(pending.settings.idle()).toBeUndefined();
  gated.release();
  await vi.waitFor(() => expect(pending.changed).toHaveBeenCalledOnce());
});

it('serializes unit and overlay saves in one queue so that every change survives', async () => {
  let active = 0, maximum = 0;
  const settings = store(wrapped({
    open: async (file, flags) => {if (flags === 'wx') {active++; maximum = Math.max(maximum, active);} return fs.open(file, flags);},
    rename: async (from, to) => {await new Promise(resolve => setImmediate(resolve)); await fs.rename(from, to); active--;}
  }));
  await settings.load();
  const results = await Promise.all([settings.setUnitProfile('ets2', 'us-customary'), settings.setOverlayLayout('cluster'),
    settings.setOverlaySections({...ALL_ON, rpm: false}), settings.setUnitProfile('ats', 'metric')]);
  expect(maximum).toBe(1);
  expect(results.map(view => [view.units, view.overlay.layout, view.overlay.sections.rpm])).toEqual([
    [{ets2: 'us-customary', ats: 'us-customary'}, 'strip', true], [{ets2: 'us-customary', ats: 'us-customary'}, 'cluster', true],
    [{ets2: 'us-customary', ats: 'us-customary'}, 'cluster', false], [{ets2: 'us-customary', ats: 'metric'}, 'cluster', false]]);
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'metric', 'en', 'cluster', false));
  expect(events.filter(row => row.event === 'SETTINGS_SAVED').map(row => row.facts)).toEqual([
    {game: 'ets2', profile: 'us-customary'}, {overlayLayout: 'cluster'}, {overlaySections: 14}, {game: 'ats', profile: 'metric'}]);
});

it('shares the four-request bound between unit and overlay saves', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {release = resolve;});
  const settings = store(wrapped({rename: async (from, to) => {await gate; await fs.rename(from, to);}}));
  await settings.load();
  const accepted = [settings.setOverlayLayout('card'), settings.setUnitProfile('ats', 'metric'), settings.setOverlaySections(ALL_ON), settings.setOverlayLayout('hud')];
  await expect(settings.setUnitProfile('ets2', 'us-customary')).rejects.toBeInstanceOf(SettingsBusyError);
  await expect(settings.setOverlayLayout('strip')).rejects.toBeInstanceOf(SettingsBusyError);
  await expect(settings.setOverlaySections(ALL_ON)).rejects.toBeInstanceOf(SettingsBusyError);
  release(); await Promise.all(accepted);
  expect(settings.view()).toMatchObject({units: {ets2: 'metric', ats: 'metric'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'hud', sections: ALL_ON}});
});

it('saves language as exact v4 bytes, applied only after the rename, with the language as its fact', async () => {
  const settings: SettingsStore = store(wrapped({rename: async (from, to) => {expect(settings.view().language).toBe('en'); await fs.rename(from, to);}}));
  await settings.load();
  const view = await settings.setLanguage('ru');
  expect(view.language).toBe('ru');
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'us-customary', 'ru'));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {language: 'ru'}});
  expect(await store().load()).toMatchObject({state: 'loaded', language: 'ru'});
});

it('keeps the previous language in use when a language save fails and refuses it while read-only', async () => {
  const settings = store(wrapped({rename: () => Promise.reject(errno('EIO'))}));
  await settings.load();
  await expect(settings.setLanguage('ru')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toMatchObject({language: 'en', saveError: 'SETTINGS_WRITE_FAILED'});
  const newer = '{"format":"ets2telemetry.settings","version":13,"units":{"ets2":"us-customary","ats":"metric"}}';
  await seed(newer);
  const readOnly = store(); await readOnly.load();
  await expect(readOnly.setLanguage('ru')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
});

it('saves autostart as exact v8 bytes, applied only after the rename, with autostart as its fact', async () => {
  const settings = store();
  await settings.load();
  const view = await settings.setAutostart(true);
  expect(view.autostart).toBe(true);
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'us-customary', 'en', 'strip', true, PLACEMENTS, true));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {autostart: true}});
  expect(await store().load()).toMatchObject({state: 'loaded', autostart: true});
});

it('keeps the previous autostart in use when an autostart save fails and refuses it while read-only', async () => {
  const settings = store(wrapped({rename: () => Promise.reject(errno('EIO'))}));
  await settings.load();
  await expect(settings.setAutostart(true)).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view().autostart).toBe(false);

  const newer = '{"format":"ets2telemetry.settings","version":13,"units":{"ets2":"us-customary","ats":"metric"}}';
  await seed(newer);
  const readOnly = store();
  await readOnly.load();
  await expect(readOnly.setAutostart(true)).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
});

it('loads accepted v5 bytes without writing and saves v6 visibility without losing autostart or unrelated fields', async () => {
  const old = {format: 'ets2telemetry.settings', version: 5, language: 'ru', autostart: true,
    units: {ets2: 'us-customary', ats: 'metric'}, overlay: {layout: 'card', sections: {...ALL_ON, rpm: false}, placements: MOVED}};
  const bytes = JSON.stringify(old) + '\n'; await seed(bytes); const settings = store();
  expect(await settings.load()).toEqual({language: 'ru', autostart: true, units: old.units, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {...old.overlay, enabled: true, backgroundOpacity: 80}, state: 'loaded', writable: true, saveError: null});
  expect((await read()).toString()).toBe(bytes); expect(await list()).toEqual(['settings.json']);
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 5}}]);
  await settings.setOverlayEnabled(false);
  expect(JSON.parse((await read()).toString())).toEqual({...old, version: 12, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES, overlay: {...old.overlay, enabled: false, backgroundOpacity: 80, sections: {...ALL_ON, rpm: false}}});
  await settings.setLanguage('en'); await settings.setOverlayLayout('hud'); await settings.setUnitProfile('ets2', 'metric');
  expect(settings.view()).toMatchObject({autostart: true, language: 'en', overlay: {enabled: false, backgroundOpacity: 80, layout: 'hud', sections: old.overlay.sections, placements: MOVED}});
  const saved = await read(); const restarted = store();
  expect(await restarted.load()).toEqual(settings.view()); expect(await read()).toEqual(saved);
});

it.each([
  {name: 'missing file', bytes: undefined, intent: false},
  {name: 'accepted v5 true', bytes: v8Text('metric', 'metric', 'en', 'strip', true, PLACEMENTS, true).replace('"version": 8', '"version": 5'), intent: true},
  {name: 'current false', bytes: v12Text('metric', 'metric'), intent: false},
  {name: 'unrelated fallback', bytes: v12Text('invalid', 'metric', 'en', 'strip', true, PLACEMENTS, true), intent: true},
  {name: 'invalid autostart', bytes: v12Text('metric', 'metric').replace('"autostart": false', '"autostart": "false"'), intent: undefined},
  {name: 'invalid file', bytes: CORRUPT, intent: undefined},
  {name: 'unsupported older', bytes: '{"format":"ets2telemetry.settings","version":0}', intent: undefined},
  {name: 'newer version', bytes: '{"format":"ets2telemetry.settings","version":1399}', intent: undefined}
])('classifies initial autostart authority independently: $name', async ({bytes, intent}) => {
  if (bytes !== undefined) await seed(bytes);
  const settings = store(); expect(settings.knownAutostartIntent).toBeUndefined(); await settings.load();
  expect(settings.knownAutostartIntent).toBe(intent);
  if (settings.view().writable) {
    await settings.setLanguage('ru'); expect(settings.knownAutostartIntent).toBe(intent);
    await settings.setAutostart(true); expect(settings.knownAutostartIntent).toBe(intent === undefined ? undefined : true);
  }
});
it('never promotes unavailable, read-error or reparse defaults to login intent', async () => {
  await seed(VALID_METRIC);
  for (const settings of [new SettingsStore(undefined), store(wrapped({lstat: () => Promise.reject(errno('EIO'))})),
    store(wrapped({lstat: async target => {const stat = await fs.lstat(target); return {...stat, isSymbolicLink: () => true};}}))]) {
    await settings.load(); expect(settings.knownAutostartIntent).toBeUndefined();
  }
});
it('exposes only the committed known intent through a held and failed durable save', async () => {
  await seed(v12Text('metric', 'metric', 'en', 'strip', true, PLACEMENTS, true));
  let release!: () => void; const gate = new Promise<void>(resolve => {release = resolve;});
  const settings = store(wrapped({rename: async () => {await gate; throw errno('EIO');}})); await settings.load();
  const pending = settings.setAutostart(false); expect(settings.knownAutostartIntent).toBe(true);
  release(); await expect(pending).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'}); expect(settings.knownAutostartIntent).toBe(true);
});

it('loads untouched v6, commits opacity only after rename, keeps queued changes and restores it on restart', async () => {
  const old = JSON.stringify({format: 'ets2telemetry.settings', version: 6, language: 'ru', autostart: true,
    units: {ets2: 'metric', ats: 'us-customary'}, overlay: {...DEFAULT_OVERLAY, enabled: false, placements: MOVED}});
  await seed(old);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => {release = r;}), writing = new Promise<void>(r => {entered = r;}); let first = true;
  const settings = store(wrapped({rename: async (a, b) => {if (first) {first = false; entered(); await gate;} await fs.rename(a, b);}}));
  await settings.load(); expect((await read()).toString()).toBe(old);
  const save = settings.setOverlayBackgroundOpacity(40); await writing;
  expect(settings.view().overlay.backgroundOpacity).toBe(80); expect((await read()).toString()).toBe(old);
  const queue = [settings.setLanguage('en'), settings.setOverlayLayout('cluster'), settings.setOverlayBackgroundOpacity(65)];
  await expect(settings.setOverlayBackgroundOpacity(100)).rejects.toBeInstanceOf(SettingsBusyError); release();
  expect((await save).overlay.backgroundOpacity).toBe(40); await Promise.all(queue);
  expect(settings.view()).toMatchObject({autostart: true, language: 'en', overlay: {enabled: false, backgroundOpacity: 65, layout: 'cluster', placements: MOVED}});
  const bytes = await read(); expect(JSON.parse(bytes.toString()).version).toBe(12); // ET-050b per-gearbox modes: the current format is v12.
  expect((await store().load()).overlay.backgroundOpacity).toBe(65); expect(await read()).toEqual(bytes);
});
it('refuses invalid/read-only opacity and preserves the committed value on failure before recovery', async () => {
  let fail = true;
  const settings = store(wrapped({rename: async (a, b) => {if (fail) throw errno('EIO'); await fs.rename(a, b);}})); await settings.load();
  for (const value of [NaN, Infinity, 39, 101, 60.1]) await expect(settings.setOverlayBackgroundOpacity(value)).rejects.toThrow('Invalid overlay opacity request');
  await expect(settings.setOverlayBackgroundOpacity(40)).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view().overlay.backgroundOpacity).toBe(80); fail = false;
  expect(await settings.setOverlayBackgroundOpacity(100)).toMatchObject({overlay: {backgroundOpacity: 100}, saveError: null});
  const newer = '{"format":"ets2telemetry.settings","version":13}'; await seed(newer); const readOnly = store(); await readOnly.load();
  await expect(readOnly.setOverlayBackgroundOpacity(40)).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'}); expect((await read()).toString()).toBe(newer);
});

// ET-050 (REG-017): per-game gear display mode through the shared durable queue.
it('keeps a v8 file byte-identical at startup and writes exact v11 on the first gear save, applied only after the rename', async () => {
  const v8 = v8Text('us-customary', 'metric', 'ru', 'card', false, MOVED, true);
  await seed(v8);
  const settings: SettingsStore = store(wrapped({rename: async (from, to) => {expect(settings.view().gearDisplay).toEqual(AUTO); await fs.rename(from, to);}}));
  expect(await settings.load()).toEqual({language: 'ru', autostart: true, units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: AUTO, gearboxGearDisplay: NO_GEARBOXES,
    overlay: {...DEFAULT_OVERLAY, layout: 'card', sections: {...ALL_ON, rpm: false}, placements: MOVED}, state: 'loaded', writable: true, saveError: null});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 8}}]);
  expect((await read()).toString('utf8')).toBe(v8); expect(await list()).toEqual(['settings.json']);
  expect((await settings.setGearDisplay('ets2', 'manual')).gearDisplay).toEqual({ets2: 'manual', ats: 'automatic'});
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'metric', 'ru', 'card', false, MOVED, true, {ets2: 'manual', ats: 'automatic'}));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {game: 'ets2', gearDisplay: 'manual'}});
  expect(await list()).toEqual(['settings.json']);
  const restarted = store(); const saved = await read();
  expect(await restarted.load()).toEqual(settings.view()); expect(await read()).toEqual(saved);
  expect((await restarted.setGearDisplay('ats', 'manual')).gearDisplay).toEqual({ets2: 'manual', ats: 'manual'});
  expect((await restarted.setGearDisplay('ets2', 'automatic')).gearDisplay).toEqual({ets2: 'automatic', ats: 'manual'});
  expect(await store().load()).toMatchObject({state: 'loaded', gearDisplay: {ets2: 'automatic', ats: 'manual'}});
});
// ET-050b (owner option B): v10 adds the crawler mode; a v9 file keeps its modes and is rewritten only by the first save.
it('keeps a v9 file byte-identical at startup, then saves the crawler mode as exact v10 and restores it on restart', async () => {
  const v9 = v10Text('metric', 'us-customary', 'ru', 'hud', true, MOVED, false, {ets2: 'manual', ats: 'automatic'}).replace('"version": 10', '"version": 9');
  await seed(v9);
  const settings = store();
  expect(await settings.load()).toMatchObject({state: 'loaded', gearDisplay: {ets2: 'manual', ats: 'automatic'}, writable: true});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 9}}]);
  expect((await read()).toString('utf8')).toBe(v9);
  expect((await settings.setGearDisplay('ets2', 'crawler')).gearDisplay).toEqual({ets2: 'crawler', ats: 'automatic'});
  expect((await read()).toString('utf8')).toBe(v12Text('metric', 'us-customary', 'ru', 'hud', true, MOVED, false, {ets2: 'crawler', ats: 'automatic'}));
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {game: 'ets2', gearDisplay: 'crawler'}});
  expect((await settings.setGearDisplay('ats', 'crawler')).gearDisplay).toEqual({ets2: 'crawler', ats: 'crawler'});
  const saved = await read();
  expect(await store().load()).toMatchObject({state: 'loaded', gearDisplay: {ets2: 'crawler', ats: 'crawler'}}); expect(await read()).toEqual(saved);
});
it('keeps the previous gear display mode when its save fails and clears the error with the next save', async () => {
  let fail = true;
  const settings = store(wrapped({rename: async (a, b) => {if (fail) throw errno('EIO'); await fs.rename(a, b);}})); await settings.load();
  await expect(settings.setGearDisplay('ats', 'manual')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toMatchObject({gearDisplay: AUTO, saveError: 'SETTINGS_WRITE_FAILED'});
  expect(existsSync(target)).toBe(false);
  fail = false;
  expect(await settings.setGearDisplay('ats', 'manual')).toMatchObject({gearDisplay: {ets2: 'automatic', ats: 'manual'}, saveError: null});
});
it('rejects invalid gear display requests without queuing a write', async () => {
  const settings = store(); await settings.load();
  for (const [game, mode] of [['ets2', 'Manual'], ['ets2', 'Crawler'], ['ets2', 'crawler-first'], ['ets2', ''], ['truck', 'manual'], [undefined, 'manual'], ['ats', 1], ['ats', null]] as const) {
    await expect(settings.setGearDisplay(game as never, mode as never)).rejects.toThrow('Invalid gear display request');
  }
  expect(settings.idle()).toBeUndefined(); expect(existsSync(target)).toBe(false);
  expect(events.filter(row => row.event === 'SETTINGS_SAVED')).toEqual([]);
});
it('refuses gear display saves for a newer-version file and while the startup read is pending', async () => {
  const newer = '{"format":"ets2telemetry.settings","version":13,"gearDisplay":{"ets2":"manual","ats":"manual"}}';
  await seed(newer);
  const settings = store(); await settings.load();
  await expect(settings.setGearDisplay('ets2', 'manual')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer); expect(settings.view()).toMatchObject({state: 'newer-version', writable: false, gearDisplay: AUTO});
  const gated = delayedRead();
  const pending = await loadPastBudget(gated.fs);
  await expect(pending.settings.setGearDisplay('ats', 'manual')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(pending.settings.idle()).toBeUndefined();
  gated.release();
  await vi.waitFor(() => expect(pending.changed).toHaveBeenCalledOnce());
});
it('shares the queue and four-request bound with unit saves so that both changes survive', async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => {release = r;}), writing = new Promise<void>(r => {entered = r;}); let first = true;
  const settings = store(wrapped({rename: async (a, b) => {if (first) {first = false; entered(); await gate;} await fs.rename(a, b);}})); await settings.load();
  const gear = settings.setGearDisplay('ets2', 'manual'); await writing; expect(settings.view().gearDisplay).toEqual(AUTO);
  const rest = [settings.setUnitProfile('ets2', 'us-customary'), settings.setGearDisplay('ats', 'manual'), settings.setUnitProfile('ats', 'metric')];
  await expect(settings.setGearDisplay('ets2', 'automatic')).rejects.toBeInstanceOf(SettingsBusyError);
  release();
  expect((await gear).gearDisplay).toEqual({ets2: 'manual', ats: 'automatic'}); await Promise.all(rest);
  expect(settings.view()).toMatchObject({units: {ets2: 'us-customary', ats: 'metric'}, gearDisplay: {ets2: 'manual', ats: 'manual'}});
  expect((await read()).toString('utf8')).toBe(v12Text('us-customary', 'metric', 'en', 'strip', true, PLACEMENTS, false, {ets2: 'manual', ats: 'manual'}));
});

// ET-050b per-gearbox modes (owner decision of October 27, 2026): the owner's captured Scania R gearboxes, the GA867R 6+1
// automatic and the G38CMR 13+1 (14 forward, 8 reverse), share one model id and differ only by their gear counts.
const GA867R = {model: 'vehicle.scania.r_2016', forwardGears: 6, reverseGears: 1} as const;
const G38CMR = {model: 'vehicle.scania.r_2016', forwardGears: 14, reverseGears: 8} as const;
it('keeps a v11 file byte-identical at startup, then saves per-gearbox modes as exact v12 in canonical order and restores them', async () => {
  const v11 = v11Text('metric', 'us-customary', 'ru', 'hud', true, MOVED, false, {ets2: 'crawler', ats: 'automatic'});
  await seed(v11);
  const settings = store();
  expect(await settings.load()).toMatchObject({state: 'loaded', gearDisplay: {ets2: 'crawler', ats: 'automatic'}, gearboxGearDisplay: NO_GEARBOXES, writable: true});
  expect(events).toEqual([{event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 11}}]);
  expect((await read()).toString('utf8')).toBe(v11);
  expect((await settings.setGearboxGearDisplay('ets2', G38CMR, 'Scania R', 'crawler')).gearboxGearDisplay).toEqual({ets2: [{...G38CMR, label: 'Scania R', mode: 'crawler'}], ats: []});
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {game: 'ets2', gearboxGearDisplay: 'crawler'}});
  expect((await settings.setGearboxGearDisplay('ets2', GA867R, 'Scania R', 'automatic')).gearboxGearDisplay.ets2).toEqual([
    {...GA867R, label: 'Scania R', mode: 'automatic'}, {...G38CMR, label: 'Scania R', mode: 'crawler'}]);
  const written = JSON.parse((await read()).toString('utf8')) as Record<string, unknown>;
  expect(Object.keys(written)).toEqual(['format', 'version', 'language', 'autostart', 'units', 'gearDisplay', 'gearboxGearDisplay', 'overlay']);
  expect(written).toMatchObject({version: 12, gearDisplay: {ets2: 'crawler', ats: 'automatic'}, gearboxGearDisplay: {ets2: [
    {model: 'vehicle.scania.r_2016', forwardGears: 6, reverseGears: 1, label: 'Scania R', mode: 'automatic'},
    {model: 'vehicle.scania.r_2016', forwardGears: 14, reverseGears: 8, label: 'Scania R', mode: 'crawler'}], ats: []}});
  // A new choice for a known gearbox replaces its mode and label; null returns it to the game's mode.
  expect((await settings.setGearboxGearDisplay('ets2', GA867R, 'Scania R 2016', 'manual')).gearboxGearDisplay.ets2[0]).toEqual({...GA867R, label: 'Scania R 2016', mode: 'manual'});
  expect((await settings.setGearboxGearDisplay('ets2', G38CMR, 'Scania R', null)).gearboxGearDisplay).toEqual({ets2: [{...GA867R, label: 'Scania R 2016', mode: 'manual'}], ats: []});
  expect(events.at(-1)).toEqual({event: 'SETTINGS_SAVED', facts: {game: 'ets2', gearboxGearDisplay: 'removed'}});
  const saved = await read();
  expect(await store().load()).toEqual(settings.view()); expect(await read()).toEqual(saved);
});
it('refuses a seventeenth gearbox of a game without writing and still replaces or removes a known one', async () => {
  const settings = store(); await settings.load();
  for (let forwardGears = 1; forwardGears <= 16; forwardGears++) await settings.setGearboxGearDisplay('ats', {...GA867R, forwardGears}, 'Mack', 'manual');
  const full = await read(), view = settings.view();
  await expect(settings.setGearboxGearDisplay('ats', {...GA867R, forwardGears: 17}, 'Mack', 'manual')).rejects.toThrow('Too many gearboxes');
  expect(settings.view()).toEqual(view); expect(await read()).toEqual(full);
  // The other game has its own sixteen.
  expect((await settings.setGearboxGearDisplay('ets2', GA867R, 'Scania R', 'automatic')).gearboxGearDisplay.ets2).toHaveLength(1);
  expect((await settings.setGearboxGearDisplay('ats', {...GA867R, forwardGears: 16}, 'Mack', 'crawler')).gearboxGearDisplay.ats).toHaveLength(16);
  expect((await settings.setGearboxGearDisplay('ats', {...GA867R, forwardGears: 1}, 'Mack', null)).gearboxGearDisplay.ats).toHaveLength(15);
});
it('rejects invalid per-gearbox requests without queuing a write', async () => {
  const settings = store(); await settings.load();
  for (const [game, gearbox, label, mode] of [
    ['truck', GA867R, 'Scania R', 'manual'], ['ets2', {...GA867R, model: ''}, 'Scania R', 'manual'], ['ets2', {...GA867R, model: 'x'.repeat(129)}, 'Scania R', 'manual'],
    ['ets2', {...GA867R, forwardGears: 0}, 'Scania R', 'manual'], ['ets2', {...GA867R, reverseGears: 101}, 'Scania R', 'manual'], ['ets2', {...GA867R, forwardGears: 6.5}, 'Scania R', 'manual'],
    ['ets2', {...GA867R, label: 'Scania R'}, 'Scania R', 'manual'], ['ets2', GA867R, '', 'manual'], ['ets2', GA867R, 'L'.repeat(129), 'manual'], ['ets2', GA867R, 'Scania\tR', 'manual'],
    ['ets2', GA867R, 'Scania R', 'Manual'], ['ets2', GA867R, 'Scania R', 'game'], ['ets2', GA867R, 'Scania R', undefined], ['ets2', undefined, 'Scania R', 'manual']
  ] as const) {
    await expect(settings.setGearboxGearDisplay(game as never, gearbox as never, label, mode as never)).rejects.toThrow('Invalid gearbox gear display request');
  }
  expect(settings.idle()).toBeUndefined(); expect(existsSync(target)).toBe(false);
  expect(events.filter(row => row.event === 'SETTINGS_SAVED')).toEqual([]);
});
it('refuses per-gearbox saves for a newer-version file and keeps the previous list when a save fails', async () => {
  const newer = '{"format":"ets2telemetry.settings","version":13,"gearboxGearDisplay":{"ets2":[],"ats":[]}}';
  await seed(newer);
  const readOnly = store(); await readOnly.load();
  await expect(readOnly.setGearboxGearDisplay('ets2', GA867R, 'Scania R', 'automatic')).rejects.toMatchObject({code: 'SETTINGS_READ_ONLY'});
  expect((await read()).toString('utf8')).toBe(newer);
  await fs.rm(target);
  let fail = true;
  const settings = store(wrapped({rename: async (a, b) => {if (fail) throw errno('EIO'); await fs.rename(a, b);}})); await settings.load();
  await expect(settings.setGearboxGearDisplay('ets2', GA867R, 'Scania R', 'automatic')).rejects.toMatchObject({code: 'SETTINGS_WRITE_FAILED'});
  expect(settings.view()).toMatchObject({gearboxGearDisplay: NO_GEARBOXES, saveError: 'SETTINGS_WRITE_FAILED'});
  fail = false;
  expect(await settings.setGearboxGearDisplay('ets2', GA867R, 'Scania R', 'automatic')).toMatchObject({gearboxGearDisplay: {ets2: [{...GA867R, label: 'Scania R', mode: 'automatic'}]}, saveError: null});
});
