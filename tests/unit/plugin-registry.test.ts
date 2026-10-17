import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AtomicFileSystem} from '../../apps/desktop/src/plugin-setup/atomic-json-file';
import {EMPTY_PLUGIN_REGISTRY, MAX_PLUGIN_REGISTRY_BYTES, parsePluginRegistry, PluginRegistry, PluginRegistryError, serializePluginRegistry,
  type InstallRecord, type PendingIntent, type PluginRegistryDocument} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-015 (ET-017 P9): the plugin install registry setup.json. Real temporary folders under the guarded root; failures
// are injected by wrapping the guarded file operations. Expected bytes are written by hand from the v1 format.

let guard: GuardedRoot;
let directory: string;
let events: {event: string; facts?: unknown}[];
let delays: number[];
// 2026-10-17T08:30:15.250Z is the clock of every record and quarantine below.
const now = () => new Date(Date.UTC(2026, 9, 17, 8, 30, 15, 250));
const HASH_A = 'a'.repeat(64), HASH_B = 'b'.repeat(64);
const ROOT = 'C:\\Games\\Euro Truck Simulator 2';
const TEMP = 'C:\\Games\\Euro Truck Simulator 2\\bin\\win_x64\\plugins\\ets2telemetry-plugin.dll.0123456789abcdef.tmp';
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), {code});

beforeEach(async () => {
  guard = await guardedTempRoot();
  directory = path.join(guard.root, 'ETS2Telemetry', 'plugins');
  events = []; delays = [];
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const guardedFs = () => guard.fs as unknown as AtomicFileSystem;
const load = (fs: AtomicFileSystem = guardedFs()) => PluginRegistry.load(directory, {fs, now, log: (event, _detail, facts) => events.push({event, facts}),
  delay: milliseconds => {delays.push(milliseconds); return Promise.resolve();}});
const file = (name = 'setup.json') => path.join(directory, name);
async function seed(content: string | Uint8Array, name = 'setup.json') {
  await fsp.mkdir(directory, {recursive: true});
  await fsp.writeFile(file(name), content);
}
const list = async () => (await fsp.readdir(directory)).sort();

const INSTALL: InstallRecord = {game: 'ets2', root: ROOT, source: 'steam', sha256: HASH_A, appVersion: '0.1.0', installedUtc: '2026-10-17T08:30:15.250Z',
  createdPluginsDirectory: true};
const PENDING: PendingIntent = {op: 'update', game: 'ets2', root: ROOT, source: 'steam', temp: TEMP, fromSha256: HASH_A, toSha256: HASH_B, appVersion: '0.2.0',
  createdPluginsDirectory: false, startedUtc: '2026-10-17T08:30:15.250Z'};
const FULL: PluginRegistryDocument = {
  ...EMPTY_PLUGIN_REGISTRY,
  games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: true, manualRoot: 'D:\\ATS'}},
  installs: [INSTALL], pending: [PENDING],
  lastFailure: {'ats:manual': {code: 'PERMISSION_DENIED', step: 'temp', utc: '2026-10-17T08:30:15.250Z'}}
};
const FULL_TEXT = [
  '{',
  '  "format": "ets2telemetry.plugin-setup",',
  '  "version": 1,',
  '  "games": {',
  '    "ets2": {',
  '      "excluded": false,',
  '      "manualRoot": null',
  '    },',
  '    "ats": {',
  '      "excluded": true,',
  '      "manualRoot": "D:\\\\ATS"',
  '    }',
  '  },',
  '  "installs": [',
  '    {',
  '      "game": "ets2",',
  '      "root": "C:\\\\Games\\\\Euro Truck Simulator 2",',
  `      "source": "steam",`,
  `      "sha256": "${HASH_A}",`,
  '      "appVersion": "0.1.0",',
  '      "installedUtc": "2026-10-17T08:30:15.250Z",',
  '      "createdPluginsDirectory": true',
  '    }',
  '  ],',
  '  "pending": [',
  '    {',
  '      "op": "update",',
  '      "game": "ets2",',
  '      "root": "C:\\\\Games\\\\Euro Truck Simulator 2",',
  '      "source": "steam",',
  '      "temp": "C:\\\\Games\\\\Euro Truck Simulator 2\\\\bin\\\\win_x64\\\\plugins\\\\ets2telemetry-plugin.dll.0123456789abcdef.tmp",',
  `      "fromSha256": "${HASH_A}",`,
  `      "toSha256": "${HASH_B}",`,
  '      "appVersion": "0.2.0",',
  '      "createdPluginsDirectory": false,',
  '      "startedUtc": "2026-10-17T08:30:15.250Z"',
  '    }',
  '  ],',
  '  "lastFailure": {',
  '    "ats:manual": {',
  '      "code": "PERMISSION_DENIED",',
  '      "step": "temp",',
  '      "utc": "2026-10-17T08:30:15.250Z"',
  '    }',
  '  }',
  '}',
  ''
].join('\n');
const EMPTY_TEXT = '{\n  "format": "ets2telemetry.plugin-setup",\n  "version": 1,\n  "games": {\n    "ets2": {\n      "excluded": false,\n      "manualRoot": null\n    },\n' +
  '    "ats": {\n      "excluded": false,\n      "manualRoot": null\n    }\n  },\n  "installs": [],\n  "pending": [],\n  "lastFailure": {}\n}\n';

describe('loading', () => {
  it('starts empty without creating anything when neither the folder nor the file exists', async () => {
    const registry = await load();
    expect([registry.state, registry.writable]).toEqual(['empty', true]);
    expect(registry.document).toEqual(EMPTY_PLUGIN_REGISTRY);
    await expect(fsp.stat(directory)).rejects.toMatchObject({code: 'ENOENT'});
  });

  it('refuses a missing or relative location as unavailable', async () => {
    for (const location of [undefined, 'relative\\plugins']) {
      const registry = await PluginRegistry.load(location, {fs: guardedFs()});
      expect([registry.state, registry.writable]).toEqual(['unavailable', false]);
      await expect(registry.update(document => document)).rejects.toMatchObject({code: 'REGISTRY_UNAVAILABLE'});
    }
  });

  it('reads the exact v1 bytes back into the same document, and accepts a byte order mark', async () => {
    await seed(FULL_TEXT);
    const registry = await load();
    expect([registry.state, registry.writable]).toEqual(['loaded', true]);
    expect(registry.document).toEqual(FULL);
    expect(Object.isFrozen(registry.document.installs[0])).toBe(true);
    expect(parsePluginRegistry(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FULL_TEXT)]))).toEqual({state: 'loaded', document: FULL});
  });

  it('treats a junction folder and a folder in place of the file as unreadable and read-only', async () => {
    const real = path.join(guard.root, 'elsewhere');
    await fsp.mkdir(real, {recursive: true});
    await fsp.writeFile(path.join(real, 'setup.json'), EMPTY_TEXT);
    await fsp.mkdir(path.dirname(directory), {recursive: true});
    await fsp.symlink(real, directory, 'junction');
    const linked = await load();
    expect([linked.state, linked.writable]).toEqual(['unreadable', false]);
    await expect(linked.update(document => document)).rejects.toBeInstanceOf(PluginRegistryError);
    expect(await fsp.readFile(path.join(real, 'setup.json'), 'utf8')).toBe(EMPTY_TEXT);
    await fsp.unlink(directory);
    await fsp.mkdir(file(), {recursive: true});
    expect((await load()).state).toBe('unreadable');
  });
});

/** A parsed document loosely typed, so a case can break any part of it. */
interface LooseDocument {
  [key: string]: unknown;
  games: Record<string, Record<string, unknown>>;
  installs: Record<string, unknown>[];
  pending: Record<string, unknown>[];
  lastFailure: Record<string, Record<string, unknown>>;
}

describe('strict v1 parsing', () => {
  const valid = JSON.parse(FULL_TEXT) as Record<string, unknown>;
  const variant = (change: (value: LooseDocument) => void) => {
    const copy = JSON.parse(FULL_TEXT) as LooseDocument;
    change(copy);
    return Buffer.from(JSON.stringify(copy));
  };
  it.each([
    ['not JSON', Buffer.from('{"format":')],
    ['not UTF-8', Buffer.from([0x7b, 0xff, 0x7d])],
    ['an array', Buffer.from('[]')],
    ['another format', variant(value => {value.format = 'ets2telemetry.settings';})],
    ['version 0', variant(value => {value.version = 0;})],
    ['a string version', variant(value => {value.version = '1';})],
    ['a fractional version', variant(value => {value.version = 1.5;})],
    ['an extra top-level key', variant(value => {value.extra = true;})],
    ['a missing top-level key', variant(value => {Reflect.deleteProperty(value, 'lastFailure');})],
    ['a third game', variant(value => {value.games.eut = {excluded: false, manualRoot: null};})],
    ['a relative manual root', variant(value => {value.games.ets2.manualRoot = 'Games\\ETS2';})],
    ['a UNC manual root', variant(value => {value.games.ets2.manualRoot = '\\\\server\\share\\ETS2';})],
    ['a non-boolean exclusion', variant(value => {value.games.ats.excluded = 'yes';})],
    ['an install with an extra key', variant(value => {value.installs[0].path = 'x';})],
    ['an install with an uppercase hash', variant(value => {value.installs[0].sha256 = 'A'.repeat(64);})],
    ['an install with an unknown source', variant(value => {value.installs[0].source = 'registry';})],
    ['an install with an unnormalized root', variant(value => {value.installs[0].root = 'C:\\Games\\..\\Games\\ETS2';})],
    ['an install with an invalid version', variant(value => {value.installs[0].appVersion = 'v1';})],
    ['an install with an invalid time', variant(value => {value.installs[0].installedUtc = '2026-10-17 08:30:15';})],
    ['two installs for one root in different case', variant(value => {value.installs.push({...value.installs[0], root: ROOT.toUpperCase()});})],
    ['a pending temp outside the root\'s plugins folder', variant(value => {value.pending[0].temp = 'C:\\Games\\ets2telemetry-plugin.dll.0123456789abcdef.tmp';})],
    ['a pending temp with another name', variant(value => {value.pending[0].temp = TEMP.replace('0123456789abcdef', '0123456789ABCDEF');})],
    ['a pending update without a source hash', variant(value => {value.pending[0].fromSha256 = null;})],
    ['a pending install with a source hash', variant(value => {value.pending[0].op = 'install';})],
    ['a pending removal with a temp', variant(value => {Object.assign(value.pending[0], {op: 'remove', toSha256: null, appVersion: null});})],
    ['a pending adopted source', variant(value => {value.pending[0].source = 'adopted';})],
    ['an unknown failure code', variant(value => {value.lastFailure['ats:manual'].code = 'ACCESS_DENIED';})],
    ['a failure key with an adopted source', variant(value => {value.lastFailure['ats:adopted'] = value.lastFailure['ats:manual'];})],
    ['a __proto__ key', Buffer.from(FULL_TEXT.replace('"format":', '"__proto__": {},\n  "format":'))]
  ])('refuses %s as an invalid file', (_name, bytes) => {
    expect(parsePluginRegistry(bytes)).toEqual({state: 'invalid-file'});
  });

  it('keeps the bounds: 16 installs and 16 pending intents, 256 KiB', () => {
    const installs = Array.from({length: 16}, (_, index) => ({...INSTALL, root: `C:\\Games\\Copy ${index}`}));
    const pending = Array.from({length: 16}, (_, index) => ({...PENDING, startedUtc: `2026-10-17T08:30:${String(index).padStart(2, '0')}.000Z`}));
    const atBound = serializePluginRegistry({...FULL, installs, pending});
    expect(parsePluginRegistry(Buffer.from(atBound)).state).toBe('loaded');
    expect(parsePluginRegistry(Buffer.from(serializePluginRegistry({...FULL, installs: [...installs, {...INSTALL, root: 'C:\\Games\\Copy 16'}]}))).state).toBe('invalid-file');
    expect(parsePluginRegistry(Buffer.from(serializePluginRegistry({...FULL, pending: [...pending, PENDING]}))).state).toBe('invalid-file');
    const padded = (size: number) => Buffer.concat([Buffer.from(EMPTY_TEXT), Buffer.alloc(size - Buffer.byteLength(EMPTY_TEXT), 0x20)]);
    expect(parsePluginRegistry(padded(MAX_PLUGIN_REGISTRY_BYTES)).state).toBe('loaded');
    expect(parsePluginRegistry(padded(MAX_PLUGIN_REGISTRY_BYTES + 1)).state).toBe('invalid-file');
    expect(valid.version).toBe(1);
  });
});

describe('writing', () => {
  it('writes the exact v1 bytes and applies the change only after the rename', async () => {
    const registry = await load();
    const result = await registry.update(() => FULL);
    expect(await fsp.readFile(file(), 'utf8')).toBe(FULL_TEXT);
    expect(result).toEqual(FULL);
    expect(registry.document).toEqual(FULL);
    expect(registry.state).toBe('loaded');
    expect(await list()).toEqual(['setup.json']);
  });

  it('refuses a change beyond the bounds and leaves the file and the document as they were', async () => {
    await seed(EMPTY_TEXT);
    const registry = await load();
    const installs = Array.from({length: 17}, (_, index) => ({...INSTALL, root: `C:\\Games\\Copy ${index}`}));
    await expect(registry.update(document => ({...document, installs}))).rejects.toMatchObject({code: 'REGISTRY_UNAVAILABLE', step: 'bounds'});
    expect(await fsp.readFile(file(), 'utf8')).toBe(EMPTY_TEXT);
    expect(registry.document).toEqual(EMPTY_PLUGIN_REGISTRY);
  });

  it('serializes changes so that each one sees the previous one', async () => {
    const registry = await load();
    await Promise.all([
      registry.update(document => ({...document, installs: [...document.installs, INSTALL]})),
      registry.update(document => ({...document, games: {...document.games, ats: {excluded: true, manualRoot: null}}}))
    ]);
    expect(registry.document.installs).toEqual([INSTALL]);
    expect(registry.document.games.ats.excluded).toBe(true);
    expect(parsePluginRegistry(await fsp.readFile(file()))).toEqual({state: 'loaded', document: registry.document});
  });

  it('removes only its own stale temporary files', async () => {
    const own = 'setup.json.4242.0f8fad5b-d9cb-469f-a165-70867728950e.tmp';
    const foreign = ['setup.json.bak', 'setup.json.1.tmp', 'setup.json.x.0f8fad5b-d9cb-469f-a165-70867728950e.tmp', 'other.json.4242.0f8fad5b-d9cb-469f-a165-70867728950e.tmp'];
    for (const name of [own, ...foreign]) await seed('leftover', name);
    await (await load()).update(document => document);
    expect(await list()).toEqual([...foreign, 'setup.json'].sort());
  });

  it('quarantines an invalid file byte-identically on the first write only, keeping the newest three', async () => {
    const corrupt = '{"format":"ets2telemetry.plugin-setup","version":1,';
    await seed(corrupt);
    for (const stamp of ['20261001T000000Z', '20261002T000000Z', '20261003T000000Z']) await seed(`old ${stamp}`, `setup.rejected-${stamp}.json`);
    const registry = await load();
    expect([registry.state, registry.writable]).toEqual(['invalid-file', true]);
    expect(registry.document).toEqual(EMPTY_PLUGIN_REGISTRY);
    expect(await fsp.readFile(file(), 'utf8')).toBe(corrupt);
    await registry.update(document => document);
    expect(await list()).toEqual(['setup.json', 'setup.rejected-20261002T000000Z.json', 'setup.rejected-20261003T000000Z.json', 'setup.rejected-20261017T083015Z.json']);
    expect(await fsp.readFile(file('setup.rejected-20261017T083015Z.json'), 'utf8')).toBe(corrupt);
    expect(await fsp.readFile(file(), 'utf8')).toBe(EMPTY_TEXT);
    expect(events).toEqual([{event: 'PLUGIN_REGISTRY_QUARANTINED', facts: {state: 'invalid-file'}}]);
    await registry.update(document => ({...document, installs: [INSTALL]}));
    expect((await list()).filter(name => name.startsWith('setup.rejected-'))).toHaveLength(3);
    expect(events).toHaveLength(1);
  });

  it('keeps a newer version untouched and read-only', async () => {
    const newer = '{"format":"ets2telemetry.plugin-setup","version":2,"anything":true}';
    await seed(newer);
    const registry = await load();
    expect([registry.state, registry.writable]).toEqual(['newer-version', false]);
    await expect(registry.update(document => document)).rejects.toMatchObject({code: 'REGISTRY_UNAVAILABLE', step: 'newer-version'});
    expect(await fsp.readFile(file(), 'utf8')).toBe(newer);
    expect(await list()).toEqual(['setup.json']);
  });

  it('retries a briefly held rename on EPERM, EACCES and EBUSY within 300 ms', async () => {
    let failures = ['EPERM', 'EACCES', 'EBUSY'];
    const fs: AtomicFileSystem = {...guardedFs(), rename: async (from, to) => {
      const code = failures.shift();
      if (code) throw errno(code);
      return guardedFs().rename(from, to);
    }};
    await (await load(fs)).update(() => FULL);
    expect(delays).toEqual([20, 40, 60]);
    expect(await fsp.readFile(file(), 'utf8')).toBe(FULL_TEXT);
    failures = [];
  });

  type Fault = 'wx' | 'write' | 'sync' | 'rename';
  it.each<[Fault, string]>([['wx', 'temporary'], ['write', 'write'], ['sync', 'sync'], ['rename', 'rename']])('a failure at %s leaves the old file intact and no temporary file', async (fault, step) => {
    await seed(EMPTY_TEXT);
    const base = guardedFs();
    const fs: AtomicFileSystem = {
      ...base,
      open: async (target, flags) => {
        if (flags === 'wx' && fault === 'wx') throw errno('ENOSPC');
        const handle = await base.open(target, flags);
        if (flags !== 'wx') return handle;
        return {
          read: handle.read.bind(handle), close: handle.close.bind(handle),
          writeFile: async (data, encoding) => {
            if (fault === 'write') {await handle.writeFile(data.slice(0, 10), encoding); throw errno('ENOSPC');}
            return handle.writeFile(data, encoding);
          },
          sync: async () => {if (fault === 'sync') throw errno('EIO'); return handle.sync();}
        };
      },
      rename: async (from, to) => {if (fault === 'rename') throw errno('EACCES'); return base.rename(from, to);}
    };
    const registry = await load(fs);
    await expect(registry.update(() => FULL)).rejects.toMatchObject({code: 'REGISTRY_UNAVAILABLE', step});
    expect(await fsp.readFile(file(), 'utf8')).toBe(EMPTY_TEXT);
    expect(await list()).toEqual(['setup.json']);
    expect(registry.document).toEqual(EMPTY_PLUGIN_REGISTRY);
    expect(delays).toEqual(fault === 'rename' ? [20, 40, 60, 80, 100] : []);
  });
});
