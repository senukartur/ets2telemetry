import {spawn, execFileSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash} from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AtomicFileSystem} from '../../apps/desktop/src/plugin-setup/atomic-json-file';
import type {RunningGames} from '../../apps/desktop/src/plugin-setup/game-processes';
import {MAX_PLUGIN_FILE_BYTES, PluginInstaller, TARGET_RETRY_DELAYS_MS, type InstallerFileSystem, type PluginTarget, type RunningCheck,
  type VerifiedPluginBundle} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {MAX_INSTALL_RECORDS, parsePluginRegistry, PluginRegistry, type InstallRecord, type PendingIntent} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {fakeSteam, type FakeSteam} from '../shared/fake-steam';

// REG-015 (ET-017 P6, P7, P8): install, update and removal of the owned plugin DLL in fake game folders under the
// guarded temporary root. Failures are injected by wrapping the guarded file operations; the real-system cases take a
// real sharing lock from a Windows PowerShell child and a real ACL deny on the temporary plugins folder, restored
// afterwards. Expected codes and records are written by hand from P6–P8 and P16.

let guard: GuardedRoot;
let steam: FakeSteam;
let registryDirectory: string;
let delays: number[];
let events: {event: string; facts?: unknown}[];
const UTC = '2026-10-17T08:30:15.250Z';
const now = () => new Date(UTC);
const bytes = (label: string, size = 8192) => {
  const value = Buffer.alloc(size);
  for (let index = 0; index < size; index++) value[index] = (index * 31 + label.charCodeAt(index % label.length)) & 0xff;
  return value;
};
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const BUNDLE = bytes('bundle 0.2.0'), OLD = bytes('released 0.1.0'), LOCAL = bytes('local build'), FOREIGN = bytes('someone else');
const bundle: VerifiedPluginBundle = {bytes: BUNDLE, sha256: sha(BUNDLE), appVersion: '0.2.0', known: [{appVersion: '0.1.0', sha256: sha(OLD)}]};
const errno = (code: string) => Object.assign(new Error(`${code}: simulated`), {code});
const notRunning: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: false}});
const runningWith = (running: Partial<RunningGames>): RunningCheck => () => Promise.resolve({ok: true, running: {ets2: false, ats: false, client: false, ...running}});

beforeEach(async () => {
  guard = await guardedTempRoot();
  steam = await fakeSteam(guard.root);
  registryDirectory = path.join(guard.root, 'ETS2Telemetry', 'plugins');
  delays = []; events = [];
});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const guarded = () => guard.fs as unknown as InstallerFileSystem;
const loadRegistry = (fs: AtomicFileSystem = guard.fs) => PluginRegistry.load(registryDirectory, {fs, now,
  delay: milliseconds => {delays.push(milliseconds); return Promise.resolve();}});
interface Setup {target: PluginTarget; plugins: string; dll: string}
/** A fake ETS2 root; `content` is the target file's bytes, if any. */
async function game(options: {plugins?: boolean; content?: Uint8Array; name?: string} = {}): Promise<Setup> {
  const root = await steam.gameFolder(path.win32.join(guard.root, 'Games', options.name ?? 'ETS2'), 'ets2', {plugins: options.plugins ?? options.content !== undefined});
  const plugins = path.win32.join(root, 'bin', 'win_x64', 'plugins'), dll = path.win32.join(plugins, 'ets2telemetry-plugin.dll');
  if (options.content) await fsp.writeFile(dll, options.content);
  return {target: {game: 'ets2', source: 'steam', root}, plugins, dll};
}
function installer(registry: PluginRegistry, options: {fs?: InstallerFileSystem; checkRunning?: RunningCheck; hex?: string} = {}) {
  return new PluginInstaller(bundle, {fs: options.fs ?? guarded(), registry, checkRunning: options.checkRunning ?? notRunning,
    delay: milliseconds => {delays.push(milliseconds); return Promise.resolve();}, randomHex: () => options.hex ?? '0123456789abcdef',
    log: (event, _detail, facts) => events.push({event, facts})});
}
const registryOnDisk = async () => {
  const parsed = parsePluginRegistry(await fsp.readFile(path.join(registryDirectory, 'setup.json')));
  if (parsed.state !== 'loaded') throw new Error(`registry ${parsed.state}`);
  return parsed.document;
};
const list = async (directory: string) => (await fsp.readdir(directory)).sort();
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);
const record = (setup: Setup, overrides: Partial<InstallRecord> = {}): InstallRecord => ({game: 'ets2', root: setup.target.root, source: 'steam',
  sha256: bundle.sha256, appVersion: '0.2.0', installedUtc: UTC, createdPluginsDirectory: false, ...overrides});

type Call = {op: string; target: string; flags?: string; to?: string};
type Hook = (call: Call) => void | Promise<void>;
/** The guarded file system with every call recorded and passed to `before` and `after`; a hook may throw to inject. */
function instrument(base: InstallerFileSystem, before: Hook = () => undefined, after: Hook = () => undefined) {
  const calls: Call[] = [];
  const run = async <T>(call: Call, real: () => Promise<T>): Promise<T> => {
    calls.push(call);
    await before(call);
    const result = await real();
    await after(call);
    return result;
  };
  const fs: InstallerFileSystem = {
    lstat: (target, options) => run({op: 'lstat', target}, () => base.lstat(target, options)),
    stat: (target, options) => run({op: 'stat', target}, () => base.stat(target, options)),
    realpath: target => run({op: 'realpath', target}, () => base.realpath(target)),
    readdir: target => run({op: 'readdir', target}, () => base.readdir(target)),
    mkdir: target => run({op: 'mkdir', target}, () => base.mkdir(target)),
    rmdir: target => run({op: 'rmdir', target}, () => base.rmdir(target)),
    unlink: target => run({op: 'unlink', target}, () => base.unlink(target)),
    rename: (from, to) => run({op: 'rename', target: from, to}, () => base.rename(from, to)),
    open: async (target, flags) => {
      const handle = await run({op: 'open', target, flags}, () => base.open(target, flags));
      return {
        stat: options => handle.stat(options),
        read: (buffer, offset, length, position) => run({op: 'read', target}, () => handle.read(buffer, offset, length, position)),
        write: (buffer, offset, length, position) => run({op: 'write', target}, () => handle.write(buffer, offset, length, position)),
        sync: () => run({op: 'sync', target}, () => handle.sync()),
        close: () => run({op: 'close', target}, () => handle.close())
      };
    }
  };
  return {fs, calls};
}
const MUTATIONS = new Set(['mkdir', 'rmdir', 'unlink', 'rename', 'write', 'sync']);
const mutationsOf = (calls: Call[]) => calls.filter(call => MUTATIONS.has(call.op) || (call.op === 'open' && call.flags === 'wx'));
const TEMP_NAME = 'ets2telemetry-plugin.dll.0123456789abcdef.tmp';

describe('lifecycle', () => {
  it('installs into a game without a plugins folder, creates the folder once and records it', async () => {
    const setup = await game();
    const registry = await loadRegistry();
    expect(await installer(registry).ensureInstalled(setup.target)).toEqual({op: 'install', outcome: 'installed', reason: null, step: null, errno: null, loadsAfterRestart: false});
    expect(await fsp.readFile(setup.dll)).toEqual(BUNDLE);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
    expect((await registryOnDisk()).installs).toEqual([record(setup, {createdPluginsDirectory: true})]);
    expect((await registryOnDisk()).pending).toEqual([]);
  });

  it('does nothing for a current owned file: no write in the game folder and no registry write', async () => {
    const setup = await game();
    const registry = await loadRegistry();
    await installer(registry).ensureInstalled(setup.target);
    const before = await fsp.stat(path.join(registryDirectory, 'setup.json'));
    const dllBefore = await fsp.stat(setup.dll);
    const probe = instrument(guarded());
    expect((await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).outcome).toBe('unchanged');
    expect(mutationsOf(probe.calls)).toEqual([]);
    expect((await fsp.stat(path.join(registryDirectory, 'setup.json'))).mtimeMs).toBe(before.mtimeMs);
    expect((await fsp.stat(setup.dll)).mtimeMs).toBe(dllBefore.mtimeMs);
  });

  it('updates an owned older file through a verified temporary file and keeps the created-folder flag', async () => {
    const setup = await game({content: OLD});
    const registry = await loadRegistry();
    await registry.update(document => ({...document, installs: [record(setup, {sha256: sha(OLD), appVersion: '0.1.0', createdPluginsDirectory: true})]}));
    const probe = instrument(guarded());
    expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'updated', reason: null});
    expect(await fsp.readFile(setup.dll)).toEqual(BUNDLE);
    expect((await registryOnDisk()).installs).toEqual([record(setup, {createdPluginsDirectory: true})]);
    const temp = path.win32.join(setup.plugins, TEMP_NAME);
    expect(mutationsOf(probe.calls).map(call => [call.op, call.target, call.to ?? null])).toEqual([
      ['open', temp, null], ['write', temp, null], ['sync', temp, null], ['rename', temp, setup.dll]
    ]);
  });

  it('removes the owned file on exclusion and the plugins folder only because this application created it', async () => {
    const setup = await game();
    const registry = await loadRegistry();
    await installer(registry).ensureInstalled(setup.target);
    expect(await installer(registry).remove(setup.target)).toEqual({op: 'remove', outcome: 'removed', reason: null, step: null, errno: null, loadsAfterRestart: false});
    expect(await exists(setup.plugins)).toBe(false);
    expect(await registryOnDisk()).toMatchObject({installs: [], pending: []});
    expect((await installer(registry).remove(setup.target)).outcome).toBe('absent');
  });

  it('keeps a plugins folder it did not create, and one it created that holds another file', async () => {
    const existing = await game({plugins: true});
    const registry = await loadRegistry();
    await installer(registry).ensureInstalled(existing.target);
    expect((await installer(registry).remove(existing.target)).outcome).toBe('removed');
    expect(await list(existing.plugins)).toEqual([]);
    const created = await game({name: 'ETS2 copy'});
    await installer(registry).ensureInstalled(created.target);
    await fsp.writeFile(path.win32.join(created.plugins, 'other.dll'), 'other');
    expect((await installer(registry).remove(created.target)).outcome).toBe('removed');
    expect(await list(created.plugins)).toEqual(['other.dll']);
  });

  it('adopts a manual copy of the bundled file without writing into the game folder', async () => {
    const setup = await game({content: BUNDLE});
    const registry = await loadRegistry();
    const probe = instrument(guarded());
    expect((await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).outcome).toBe('adopted');
    expect(mutationsOf(probe.calls)).toEqual([]);
    expect((await registryOnDisk()).installs).toEqual([record(setup, {source: 'adopted'})]);
  });

  it('reports that a game started during the install loads the plugin after a restart', async () => {
    const setup = await game();
    const answers = [false, true];
    const check: RunningCheck = () => Promise.resolve({ok: true, running: {ets2: answers.shift() ?? true, ats: false, client: false}});
    expect(await installer(await loadRegistry(), {checkRunning: check}).ensureInstalled(setup.target)).toMatchObject({outcome: 'installed', loadsAfterRestart: true});
  });
});

describe('unrelated files', () => {
  const UNRELATED: Record<string, string> = {
    'other.dll': 'another plugin', 'notes.txt': 'notes', 'ets2telemetry-plugin.dll.bak': 'backup',
    'ets2telemetry-plugin.dll.ABCDEF0123456789.tmp': 'uppercase id', 'ets2telemetry-plugin.dll.0123456789abcde.tmp': 'fifteen digits',
    'ets2telemetry-plugin.dll.0123456789abcdef0.tmp': 'seventeen digits', 'ets2telemetry-plugin.dll.fedcba9876543210.tmp.keep': 'suffix',
    'other.dll.fedcba9876543210.tmp': 'another prefix', 'x.tmp': 'foreign temporary'
  };
  it('leaves every other file byte-identical with its mtime through install, update and removal, and removes only an exact stale temporary file', async () => {
    const setup = await game({content: OLD});
    const old = new Date(Date.UTC(2025, 0, 2, 3, 4, 5));
    for (const [name, content] of Object.entries(UNRELATED)) {
      await fsp.writeFile(path.win32.join(setup.plugins, name), content);
      await fsp.utimes(path.win32.join(setup.plugins, name), old, old);
    }
    await fsp.writeFile(path.win32.join(setup.plugins, 'ets2telemetry-plugin.dll.fedcba9876543210.tmp'), 'stale');
    const registry = await loadRegistry();
    expect((await installer(registry).ensureInstalled(setup.target)).outcome).toBe('updated');
    expect((await installer(registry).remove(setup.target)).outcome).toBe('removed');
    expect((await installer(registry).ensureInstalled(setup.target)).outcome).toBe('installed');
    expect(await list(setup.plugins)).toEqual([...Object.keys(UNRELATED), 'ets2telemetry-plugin.dll'].sort());
    for (const [name, content] of Object.entries(UNRELATED)) {
      const target = path.win32.join(setup.plugins, name);
      expect([name, await fsp.readFile(target, 'utf8'), (await fsp.stat(target)).mtimeMs]).toEqual([name, content, old.getTime()]);
    }
  });
});

describe('ownership', () => {
  it('never writes, renames or removes an unrecognized file with the plugin\'s name', async () => {
    const setup = await game({content: FOREIGN});
    const before = await fsp.stat(setup.dll);
    const registry = await loadRegistry();
    for (const operation of ['ensureInstalled', 'remove'] as const) {
      const probe = instrument(guarded());
      expect(await installer(registry, {fs: probe.fs})[operation](setup.target)).toMatchObject({outcome: 'blocked', reason: 'UNRECOGNIZED_FILE', step: 'classify'});
      expect(mutationsOf(probe.calls)).toEqual([]);
    }
    expect(await fsp.readFile(setup.dll)).toEqual(FOREIGN);
    expect((await fsp.stat(setup.dll)).mtimeMs).toBe(before.mtimeMs);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
    expect((await registryOnDisk()).failures).toEqual([{game: 'ets2', root: setup.target.root, code: 'UNRECOGNIZED_FILE', step: 'classify', utc: UTC}]);
  });

  it('treats a file over 16 MiB, a folder and a junction with the plugin\'s name as unrecognized without reading them', async () => {
    const large = await game({plugins: true});
    await fsp.writeFile(large.dll, Buffer.alloc(MAX_PLUGIN_FILE_BYTES + 1));
    const folder = await game({plugins: true, name: 'folder'});
    await fsp.mkdir(folder.dll);
    const linked = await game({plugins: true, name: 'linked'});
    await fsp.symlink(path.win32.join(guard.root, 'Games'), linked.dll, 'junction');
    for (const setup of [large, folder, linked]) {
      const probe = instrument(guarded());
      expect((await installer(await loadRegistry(), {fs: probe.fs}).ensureInstalled(setup.target)).reason).toBe('UNRECOGNIZED_FILE');
      expect(probe.calls.filter(call => call.op === 'open')).toEqual([]);
      expect(mutationsOf(probe.calls)).toEqual([]);
    }
    expect((await fsp.stat(large.dll)).size).toBe(MAX_PLUGIN_FILE_BYTES + 1);
  });

  it('recognizes the bundled, a known and this root\'s registry hash', async () => {
    const registry = await loadRegistry();
    const bundled = await game({content: BUNDLE, name: 'bundled'});
    const known = await game({content: OLD, name: 'known'});
    const local = await game({content: LOCAL, name: 'local'});
    await registry.update(document => ({...document, installs: [record(local, {sha256: sha(LOCAL), appVersion: '0.1.0'})]}));
    expect(await installer(registry).inspect(bundled.target)).toEqual({state: 'owned', sha256: bundle.sha256, version: '0.2.0', current: true});
    expect(await installer(registry).inspect(known.target)).toMatchObject({state: 'owned', sha256: sha(OLD), version: '0.1.0', current: false});
    expect(await installer(registry).inspect(local.target)).toMatchObject({state: 'owned', sha256: sha(LOCAL), version: '0.1.0', current: false});
    for (const setup of [known, local]) {
      expect((await installer(registry).ensureInstalled(setup.target)).outcome).toBe('updated');
      expect(await fsp.readFile(setup.dll)).toEqual(BUNDLE);
    }
  });

  it('does not accept a registry hash recorded for a different root', async () => {
    const registry = await loadRegistry();
    const recorded = await game({content: LOCAL, name: 'recorded'});
    const other = await game({content: LOCAL, name: 'other'});
    await registry.update(document => ({...document, installs: [record(recorded, {sha256: sha(LOCAL), appVersion: '0.1.0'})]}));
    expect(await installer(registry).ensureInstalled(other.target)).toMatchObject({outcome: 'blocked', reason: 'UNRECOGNIZED_FILE'});
    expect(await installer(registry).remove(other.target)).toMatchObject({outcome: 'blocked', reason: 'UNRECOGNIZED_FILE'});
    expect(await fsp.readFile(other.dll)).toEqual(LOCAL);
  });
});

describe('refusals before any change', () => {
  it.each<[string, RunningCheck, string]>([
    ['the game running', runningWith({ets2: true}), 'GAME_RUNNING'],
    ['a TruckersMP client running', runningWith({client: true}), 'CLIENT_RUNNING'],
    ['a failed running check', () => Promise.resolve({ok: false, code: 'RUNNING_CHECK_FAILED'}), 'RUNNING_CHECK_FAILED'],
    ['a running check that throws', () => Promise.reject(new Error('spawn failed')), 'RUNNING_CHECK_FAILED']
  ])('%s causes no file operation at all', async (_name, check, reason) => {
    const setup = await game({content: OLD});
    const registry = await loadRegistry();
    for (const operation of ['ensureInstalled', 'remove'] as const) {
      const probe = instrument(guarded());
      expect(await installer(registry, {fs: probe.fs, checkRunning: check})[operation](setup.target)).toMatchObject({outcome: 'blocked', reason, step: 'process'});
      expect(probe.calls).toEqual([]);
    }
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
    expect(await exists(path.join(registryDirectory, 'setup.json'))).toBe(false);
  });

  it('lets the other game run', async () => {
    const setup = await game();
    expect((await installer(await loadRegistry(), {checkRunning: runningWith({ats: true})}).ensureInstalled(setup.target)).outcome).toBe('installed');
  });

  it('refuses every change with a newer registry and touches no game folder', async () => {
    const setup = await game({content: OLD});
    await fsp.mkdir(registryDirectory, {recursive: true});
    await fsp.writeFile(path.join(registryDirectory, 'setup.json'), '{"format":"ets2telemetry.plugin-setup","version":2}');
    const probe = instrument(guarded());
    const registry = await loadRegistry();
    expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({reason: 'REGISTRY_UNAVAILABLE', step: 'registry'});
    expect(await installer(registry, {fs: probe.fs}).remove(setup.target)).toMatchObject({reason: 'REGISTRY_UNAVAILABLE', step: 'registry'});
    expect(probe.calls).toEqual([]);
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
  });

  it('writes the pending intent durably before the temporary file exists, and touches nothing when that write fails', async () => {
    const setup = await game();
    const seen: unknown[] = [];
    const probe = instrument(guarded(), async call => {
      if (call.op === 'open' && call.flags === 'wx') seen.push((await registryOnDisk()).pending);
    });
    await installer(await loadRegistry(), {fs: probe.fs}).ensureInstalled(setup.target);
    expect(seen).toEqual([[{op: 'install', game: 'ets2', root: setup.target.root, source: 'steam', temp: path.win32.join(setup.plugins, TEMP_NAME), fromSha256: null,
      toSha256: bundle.sha256, appVersion: '0.2.0', createdPluginsDirectory: true, startedUtc: UTC}]]);

    const fresh = await game({name: 'fresh'});
    const failing: AtomicFileSystem = {...(guard.fs as unknown as AtomicFileSystem), open: (target, flags) => flags === 'wx' ? Promise.reject(errno('EACCES')) : guard.fs.open(target, flags)};
    const probe2 = instrument(guarded());
    const registry = await loadRegistry(failing);
    expect(await installer(registry, {fs: probe2.fs}).ensureInstalled(fresh.target)).toMatchObject({outcome: 'blocked', reason: 'REGISTRY_UNAVAILABLE', step: 'pending'});
    expect(mutationsOf(probe2.calls)).toEqual([]);
    expect(await exists(fresh.plugins)).toBe(false);
  });

  it('refuses a read-only target and never clears its attribute', async () => {
    const setup = await game({content: OLD});
    await fsp.chmod(setup.dll, 0o444);
    try {
      const registry = await loadRegistry();
      for (const operation of ['ensureInstalled', 'remove'] as const) {
        const probe = instrument(guarded());
        expect(await installer(registry, {fs: probe.fs})[operation](setup.target)).toMatchObject({outcome: 'blocked', reason: 'READ_ONLY_FILE', step: 'read-only'});
        expect(mutationsOf(probe.calls)).toEqual([]);
      }
      expect(await fsp.readFile(setup.dll)).toEqual(OLD);
      expect((await fsp.stat(setup.dll)).mode & 0o200).toBe(0);
    } finally {await fsp.chmod(setup.dll, 0o666);}
  });
});

describe('injected failures', () => {
  type Point = {name: string; match: (call: Call, setup: Setup, counts: Map<string, number>) => boolean; afterRename?: boolean};
  const temp = (setup: Setup) => path.win32.join(setup.plugins, TEMP_NAME);
  const nth = (counts: Map<string, number>, key: string, wanted: number) => {
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return next === wanted;
  };
  const POINTS: Point[] = [
    {name: 'the stale-file listing', match: (call, setup) => call.op === 'readdir' && call.target === setup.plugins},
    {name: 'the target read', match: (call, setup, counts) => call.op === 'open' && call.target === setup.dll && nth(counts, 'target-open', 1)},
    {name: 'the temporary create', match: (call, setup) => call.op === 'open' && call.flags === 'wx' && call.target === temp(setup)},
    {name: 'the temporary write', match: (call, setup) => call.op === 'write' && call.target === temp(setup)},
    {name: 'the temporary sync', match: (call, setup) => call.op === 'sync' && call.target === temp(setup)},
    {name: 'the temporary read-back', match: (call, setup) => call.op === 'open' && call.flags === 'r' && call.target === temp(setup)},
    {name: 'the rename', match: call => call.op === 'rename'},
    {name: 'the target re-read', match: (call, setup, counts) => call.op === 'open' && call.target === setup.dll && nth(counts, 'target-open', 2), afterRename: true}
  ];
  // [point, EPERM, EBUSY, ENOSPC], with the step each failure reports.
  const EXPECTED: [string, string, string, string, string][] = [
    ['the stale-file listing', 'PERMISSION_DENIED', 'IO_ERROR', 'DISK_FULL', 'cleanup'],
    ['the target read', 'PERMISSION_DENIED', 'TARGET_LOCKED', 'DISK_FULL', 'classify'],
    ['the temporary create', 'PERMISSION_DENIED', 'IO_ERROR', 'DISK_FULL', 'temp'],
    ['the temporary write', 'PERMISSION_DENIED', 'IO_ERROR', 'DISK_FULL', 'temp'],
    ['the temporary sync', 'PERMISSION_DENIED', 'IO_ERROR', 'DISK_FULL', 'temp'],
    ['the temporary read-back', 'PERMISSION_DENIED', 'IO_ERROR', 'DISK_FULL', 'verify'],
    ['the rename', 'TARGET_LOCKED', 'TARGET_LOCKED', 'DISK_FULL', 'rename'],
    ['the target re-read', 'PERMISSION_DENIED', 'TARGET_LOCKED', 'DISK_FULL', 'rehash']
  ];
  const cases = EXPECTED.flatMap(([point, eperm, ebusy, enospc, step]) => ([['EPERM', eperm], ['EBUSY', ebusy], ['ENOSPC', enospc]] as const)
    .map(([code, reason]) => [point, code, reason, step] as const));

  it.each(cases)('an update failing at %s with %s reports %s at step %s and leaves no temporary file', async (pointName, code, reason, step) => {
    const point = POINTS.find(candidate => candidate.name === pointName)!;
    const setup = await game({content: OLD});
    await fsp.writeFile(path.win32.join(setup.plugins, 'ets2telemetry-plugin.dll.fedcba9876543210.tmp'), 'stale');
    const registry = await loadRegistry();
    const counts = new Map<string, number>();
    const probe = instrument(guarded(), call => {if (point.match(call, setup, counts)) throw errno(code);});
    expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason, step, errno: code});
    expect(await fsp.readFile(setup.dll)).toEqual(point.afterRename ? BUNDLE : OLD);
    const leftovers = await list(setup.plugins);
    expect(leftovers.filter(name => name !== 'ets2telemetry-plugin.dll' && !(step === 'cleanup' && name.endsWith('fedcba9876543210.tmp')))).toEqual([]);
    const disk = await registryOnDisk();
    // Review round 1 (finding 2): once the rename has happened, the intent stays so that recovery records the install
    // from what is on disk; before, it was cleared and the install was never recorded.
    const intent: PendingIntent = {op: 'update', game: 'ets2', root: setup.target.root, source: 'steam', temp: path.win32.join(setup.plugins, TEMP_NAME),
      fromSha256: sha(OLD), toSha256: bundle.sha256, appVersion: '0.2.0', createdPluginsDirectory: false, startedUtc: UTC};
    expect(disk.pending).toEqual(point.afterRename ? [intent] : []);
    expect(disk.installs).toEqual([]);
    expect(disk.failures).toEqual([{game: 'ets2', root: setup.target.root, code: reason, step, utc: UTC}]);
    expect(delays).toEqual(step === 'rename' && code === 'EBUSY' ? TARGET_RETRY_DELAYS_MS : []);
    if (point.afterRename) {
      expect(await installer(registry).recover()).toEqual({recovered: 1, remaining: 0, reason: null});
      expect(await registryOnDisk()).toMatchObject({installs: [record(setup)], pending: []});
    }
  });

  it.each([['EPERM', 'PERMISSION_DENIED'], ['EBUSY', 'IO_ERROR'], ['ENOSPC', 'DISK_FULL']])('creating the plugins folder failing with %s reports %s and leaves no folder or intent', async (code, reason) => {
    const setup = await game();
    const probe = instrument(guarded(), call => {if (call.op === 'mkdir') throw errno(code);});
    expect(await installer(await loadRegistry(), {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason, step: 'directory'});
    expect(await exists(setup.plugins)).toBe(false);
    expect((await registryOnDisk()).pending).toEqual([]);
  });

  it.each([['EPERM', 'TARGET_LOCKED', 1], ['EBUSY', 'TARGET_LOCKED', 6], ['ENOSPC', 'DISK_FULL', 1], ['EACCES', 'PERMISSION_DENIED', 1]] as const)(
    'a removal whose unlink fails with %s reports %s after %i attempts and keeps the file', async (code, reason, attempts) => {
      const setup = await game({content: OLD});
      const registry = await loadRegistry();
      const probe = instrument(guarded(), call => {if (call.op === 'unlink' && call.target === setup.dll) throw errno(code);});
      expect(await installer(registry, {fs: probe.fs}).remove(setup.target)).toMatchObject({outcome: 'blocked', reason, step: 'unlink', errno: code});
      expect(probe.calls.filter(call => call.op === 'unlink' && call.target === setup.dll)).toHaveLength(attempts);
      expect(await fsp.readFile(setup.dll)).toEqual(OLD);
      expect((await registryOnDisk()).pending).toEqual([]);
    });

  it('retries a rename held by EBUSY within 300 ms and succeeds; EPERM is never retried', async () => {
    const setup = await game({content: OLD});
    let busy = 2;
    const probe = instrument(guarded(), call => {if (call.op === 'rename' && busy-- > 0) throw errno('EBUSY');});
    expect((await installer(await loadRegistry(), {fs: probe.fs}).ensureInstalled(setup.target)).outcome).toBe('updated');
    expect(delays).toEqual([20, 40]);
    expect(TARGET_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)).toBe(300);

    const locked = await game({content: OLD, name: 'locked'});
    delays = [];
    const perm = instrument(guarded(), call => {if (call.op === 'rename') throw errno('EPERM');});
    expect(await installer(await loadRegistry(), {fs: perm.fs}).ensureInstalled(locked.target)).toMatchObject({reason: 'TARGET_LOCKED', step: 'rename'});
    expect(perm.calls.filter(call => call.op === 'rename')).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  it('leaves no partial DLL after a short write followed by a full disk', async () => {
    const setup = await game({content: OLD});
    let writes = 0;
    const base = guarded();
    const short: InstallerFileSystem = {...base, open: async (target, flags) => {
      const handle = await base.open(target, flags);
      if (flags !== 'wx') return handle;
      return {...bind(handle), write: async (buffer, offset, length, position) => {
        if (++writes > 1) throw errno('ENOSPC');
        return handle.write(buffer, offset, Math.floor(length / 2), position);
      }};
    }};
    expect(await installer(await loadRegistry(), {fs: short}).ensureInstalled(setup.target)).toMatchObject({reason: 'DISK_FULL', step: 'temp'});
    expect(writes).toBe(2);
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
  });

  it('refuses a temporary file whose bytes differ from the bundle before the rename', async () => {
    const setup = await game({content: OLD});
    const base = guarded();
    const corrupt: InstallerFileSystem = {...base, open: async (target, flags) => {
      const handle = await base.open(target, flags);
      if (flags !== 'wx') return handle;
      return {...bind(handle), write: (buffer, offset, length, position) => {
        const copy = Buffer.from(buffer.subarray(offset, offset + length));
        copy[0] ^= 0xff;
        return handle.write(copy, 0, copy.length, position);
      }};
    }};
    const probe = instrument(corrupt);
    expect(await installer(await loadRegistry(), {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason: 'VERIFY_FAILED', step: 'verify'});
    expect(probe.calls.filter(call => call.op === 'rename')).toEqual([]);
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
  });
});

function bind(handle: Awaited<ReturnType<InstallerFileSystem['open']>>) {
  return {stat: handle.stat.bind(handle), read: handle.read.bind(handle), write: handle.write.bind(handle), sync: handle.sync.bind(handle), close: handle.close.bind(handle)};
}

describe('crash recovery', () => {
  // A crash stops every later file operation: from the crash on, each call of the first installer and its registry
  // never settles. A fresh registry and installer then recover from what is on disk only.
  type Crash = 'after step 6' | 'after step 7' | 'after step 9' | 'after step 10';
  const hang = () => new Promise<never>(() => undefined);
  function crashing(crash: Crash, setup: Setup) {
    let crashed = false;
    const temp = path.win32.join(setup.plugins, TEMP_NAME);
    let registryOpens = 0;
    const stopIfCrashed = () => crashed ? hang() : undefined;
    const before: Hook = call => {
      if (crashed) return hang();
      if (crash === 'after step 10' && call.op === 'registry-open' && ++registryOpens === 2) {crashed = true; return hang();}
      return undefined;
    };
    const after: Hook = call => {
      if (crash === 'after step 6' && call.op === 'registry-rename') crashed = true;
      if (crash === 'after step 7' && call.op === 'close' && call.target === temp) crashed = true;
      if (crash === 'after step 9' && call.op === 'rename' && call.to === setup.dll) crashed = true;
      return stopIfCrashed();
    };
    const game = instrument(guarded(), before, after);
    const base = guard.fs as unknown as AtomicFileSystem;
    const registryFs: AtomicFileSystem = {
      ...base,
      open: async (target, flags) => {
        if (flags === 'wx') await before({op: 'registry-open', target});
        else if (crashed) await hang();
        return base.open(target, flags);
      },
      rename: async (from, to) => {
        await before({op: 'registry-rename', target: from});
        await base.rename(from, to);
        await after({op: 'registry-rename', target: from});
      }
    };
    return {fs: game.fs, registryFs, crashed: () => crashed};
  }
  const untilCrashed = async (crashed: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!crashed() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  };

  // [scenario, crash, target bytes after recovery, plugins folder exists, install record after recovery]
  const CASES: [string, Crash, 'none' | 'old' | 'bundle', boolean, 'none' | 'old' | 'installed'][] = [
    ['install into a new plugins folder', 'after step 6', 'none', false, 'none'],
    ['install into a new plugins folder', 'after step 7', 'none', false, 'none'],
    ['install into a new plugins folder', 'after step 9', 'bundle', true, 'installed'],
    ['install into a new plugins folder', 'after step 10', 'bundle', true, 'installed'],
    ['update of a recorded older file', 'after step 6', 'old', true, 'old'],
    ['update of a recorded older file', 'after step 7', 'old', true, 'old'],
    ['update of a recorded older file', 'after step 9', 'bundle', true, 'installed'],
    ['update of a recorded older file', 'after step 10', 'bundle', true, 'installed']
  ];
  it.each(CASES)('%s, crashed %s, recovers to the hand-written state', async (scenario, crash, content, pluginsExist, recordAfter) => {
    const update = scenario.startsWith('update');
    const setup = await game(update ? {content: OLD} : {});
    const oldRecord = record(setup, {sha256: sha(OLD), appVersion: '0.1.0'});
    if (update) await (await loadRegistry()).update(document => ({...document, installs: [oldRecord]}));
    const crashed = crashing(crash, setup);
    const first = await loadRegistry(crashed.registryFs);
    void installer(first, {fs: crashed.fs}).ensureInstalled(setup.target);
    await untilCrashed(crashed.crashed);
    expect(crashed.crashed()).toBe(true);
    expect((await registryOnDisk()).pending).toHaveLength(1);

    const registry = await loadRegistry();
    const result = await installer(registry).recover();
    expect(result).toEqual({recovered: 1, remaining: 0, reason: null});
    expect(await exists(path.win32.join(setup.plugins, TEMP_NAME))).toBe(false);
    expect(await exists(setup.plugins)).toBe(pluginsExist);
    if (content === 'none') expect(await exists(setup.dll)).toBe(false);
    else expect(await fsp.readFile(setup.dll)).toEqual(content === 'old' ? OLD : BUNDLE);
    const disk = await registryOnDisk();
    expect(disk.pending).toEqual([]);
    expect(disk.installs).toEqual(recordAfter === 'none' ? [] : recordAfter === 'old' ? [oldRecord] : [record(setup, {createdPluginsDirectory: !update})]);
    expect(events).toEqual([{event: 'PLUGIN_RECOVERED', facts: {game: 'ets2', source: 'steam', op: update ? 'update' : 'install',
      outcome: recordAfter === 'installed' ? 'installed' : 'not-installed'}}]);
    expect((await installer(registry).ensureInstalled(setup.target)).outcome).toBe(recordAfter === 'installed' ? 'unchanged' : update ? 'updated' : 'installed');
  });

  it('keeps an intent while its game runs and recovers it once the game is closed', async () => {
    const setup = await game();
    const crashed = crashing('after step 7', setup);
    void installer(await loadRegistry(crashed.registryFs), {fs: crashed.fs}).ensureInstalled(setup.target);
    await untilCrashed(crashed.crashed);
    const registry = await loadRegistry();
    expect(await installer(registry, {checkRunning: runningWith({ets2: true})}).recover()).toEqual({recovered: 0, remaining: 1, reason: null});
    expect(await exists(path.win32.join(setup.plugins, TEMP_NAME))).toBe(true);
    expect(await installer(registry).recover()).toEqual({recovered: 1, remaining: 0, reason: null});
    expect(await exists(setup.plugins)).toBe(false);
  });
});

describe('review round 1', () => {
  const others = (count: number): InstallRecord[] => Array.from({length: count}, (_, index) => ({game: 'ats', root: `C:\\Other\\Copy ${index}`, source: 'manual',
    sha256: sha(OLD), appVersion: '0.1.0', installedUtc: UTC, createdPluginsDirectory: false}));

  it('refuses an install or adoption into a new folder when 16 folders are recorded, before any file operation', async () => {
    expect(MAX_INSTALL_RECORDS).toBe(16);
    const registry = await loadRegistry();
    await registry.update(document => ({...document, installs: others(16)}));
    for (const content of [undefined, BUNDLE]) {
      const setup = await game({name: content ? 'adopt' : 'fresh', ...(content ? {content} : {})});
      const probe = instrument(guarded());
      expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason: 'REGISTRY_UNAVAILABLE', step: 'pending'});
      expect(probe.calls).toEqual([]);
    }
    expect((await registryOnDisk()).installs).toEqual(others(16));
    expect((await registryOnDisk()).pending).toEqual([]);
    // A folder that already has a record is still updated.
    const recorded = await game({name: 'recorded', content: OLD});
    await registry.update(document => ({...document, installs: [...others(15), record(recorded, {sha256: sha(OLD), appVersion: '0.1.0'})]}));
    expect((await installer(registry).ensureInstalled(recorded.target)).outcome).toBe('updated');
  });

  it('recovers intents one at a time and never records past the install bound', async () => {
    const first = await game({name: 'first', content: BUNDLE}), second = await game({name: 'second', content: BUNDLE});
    const intent = (setup: Setup, second: number): PendingIntent => ({op: 'install', game: 'ets2', root: setup.target.root, source: 'steam',
      temp: path.win32.join(setup.plugins, TEMP_NAME), fromSha256: null, toSha256: bundle.sha256, appVersion: '0.2.0', createdPluginsDirectory: false,
      startedUtc: `2026-10-17T08:30:${second}.000Z`});
    const registry = await loadRegistry();
    await registry.update(document => ({...document, installs: others(15), pending: [intent(first, 10), intent(second, 11)]}));
    expect(await installer(registry).recover()).toEqual({recovered: 2, remaining: 0, reason: null});
    const disk = await registryOnDisk();
    expect(disk.installs).toEqual([...others(15), record(first)]);
    expect(disk.pending).toEqual([]);
    expect(events.map(entry => entry.facts)).toEqual([{game: 'ets2', source: 'steam', op: 'install', outcome: 'installed'},
      {game: 'ets2', source: 'steam', op: 'install', outcome: 'unrecorded'}]);
    expect(await fsp.readFile(second.dll)).toEqual(BUNDLE);
  });

  it('keeps the intent after a rename whose re-read failed, so recovery records the install with the created folder', async () => {
    const setup = await game();
    const registry = await loadRegistry();
    let opens = 0;
    const probe = instrument(guarded(), call => {if (call.op === 'open' && call.target === setup.dll && ++opens === 1) throw errno('EBUSY');});
    expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({reason: 'TARGET_LOCKED', step: 'rehash'});
    expect((await registryOnDisk()).pending).toMatchObject([{op: 'install', createdPluginsDirectory: true}]);
    const fresh = await loadRegistry();
    expect(await installer(fresh).recover()).toEqual({recovered: 1, remaining: 0, reason: null});
    expect(await registryOnDisk()).toMatchObject({installs: [record(setup, {createdPluginsDirectory: true})], pending: []});
    expect((await installer(fresh).remove(setup.target)).outcome).toBe('removed');
    expect(await exists(setup.plugins)).toBe(false);
  });

  it('keeps an intent whose target cannot be read during recovery, and one whose layout became linked, without removing its temporary file', async () => {
    const setup = await game();
    const registry = await loadRegistry();
    const temp = path.win32.join(setup.plugins, TEMP_NAME);
    const pending: PendingIntent = {op: 'install', game: 'ets2', root: setup.target.root, source: 'steam', temp, fromSha256: null, toSha256: bundle.sha256,
      appVersion: '0.2.0', createdPluginsDirectory: true, startedUtc: UTC};
    await fsp.mkdir(setup.plugins);
    await fsp.writeFile(setup.dll, BUNDLE);
    await registry.update(document => ({...document, pending: [pending]}));
    const locked = instrument(guarded(), call => {if (call.op === 'open' && call.target === setup.dll) throw errno('EBUSY');});
    expect(await installer(registry, {fs: locked.fs}).recover()).toEqual({recovered: 0, remaining: 1, reason: 'TARGET_LOCKED'});
    expect((await registryOnDisk()).pending).toEqual([pending]);

    // The plugins folder moved behind a junction: recovery must not reach the temporary file through it.
    const moved = path.win32.join(guard.root, 'moved-plugins');
    await fsp.rename(setup.plugins, moved);
    await fsp.writeFile(path.win32.join(moved, TEMP_NAME), 'partial');
    await fsp.symlink(moved, setup.plugins, 'junction');
    const probe = instrument(guarded());
    expect(await installer(registry, {fs: probe.fs}).recover()).toEqual({recovered: 0, remaining: 1, reason: 'LINKED_FOLDER'});
    expect(mutationsOf(probe.calls)).toEqual([]);
    expect(await fsp.readFile(path.win32.join(moved, TEMP_NAME), 'utf8')).toBe('partial');
    expect((await registryOnDisk()).pending).toEqual([pending]);
    await fsp.unlink(setup.plugins);
    await fsp.rename(moved, setup.plugins);
    expect(await installer(registry).recover()).toEqual({recovered: 1, remaining: 0, reason: null});
    expect(await exists(temp)).toBe(false);
    expect((await registryOnDisk()).installs).toEqual([record(setup, {createdPluginsDirectory: true})]);
  });

  it('records createdPluginsDirectory false durably when another process created the folder first', async () => {
    const setup = await game();
    const seen: unknown[] = [];
    const probe = instrument(guarded(), async call => {
      if (call.op === 'mkdir') {await fsp.mkdir(call.target); throw errno('EEXIST');}
      if (call.op === 'open' && call.flags === 'wx') seen.push((await registryOnDisk()).pending.map(intent => intent.createdPluginsDirectory));
    });
    const registry = await loadRegistry();
    expect((await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).outcome).toBe('installed');
    expect(seen).toEqual([[false]]);
    expect((await registryOnDisk()).installs).toEqual([record(setup)]);
    expect((await installer(registry).remove(setup.target)).outcome).toBe('removed');
    expect(await list(setup.plugins)).toEqual([]);
  });

  it('keeps failures per root: two Steam roots of one game never clear each other, and unchanged runs write nothing', async () => {
    const blocked = await game({name: 'Library A', content: FOREIGN});
    const installed = await game({name: 'Library B'});
    let writes = 0;
    const base = guard.fs as unknown as AtomicFileSystem;
    const counting: AtomicFileSystem = {...base, rename: async (from, to) => {writes++; return base.rename(from, to);}};
    const registry = await loadRegistry(counting);
    const run = async () => [(await installer(registry).ensureInstalled(blocked.target)).reason, (await installer(registry).ensureInstalled(installed.target)).outcome];
    expect(await run()).toEqual(['UNRECOGNIZED_FILE', 'installed']);
    const before = writes;
    const bytes = await fsp.readFile(path.join(registryDirectory, 'setup.json'));
    expect(await run()).toEqual(['UNRECOGNIZED_FILE', 'unchanged']);
    expect(await run()).toEqual(['UNRECOGNIZED_FILE', 'unchanged']);
    expect(writes).toBe(before);
    expect(await fsp.readFile(path.join(registryDirectory, 'setup.json'))).toEqual(bytes);
    expect((await registryOnDisk()).failures).toEqual([{game: 'ets2', root: blocked.target.root, code: 'UNRECOGNIZED_FILE', step: 'classify', utc: UTC}]);
  });

  it('writes the removal intent durably before the unlink, and removes nothing when that write fails', async () => {
    const setup = await game({content: OLD});
    const seen: unknown[] = [];
    const probe = instrument(guarded(), async call => {
      if (call.op === 'unlink' && call.target === setup.dll) seen.push((await registryOnDisk()).pending);
    });
    expect((await installer(await loadRegistry(), {fs: probe.fs}).remove(setup.target)).outcome).toBe('removed');
    expect(seen).toEqual([[{op: 'remove', game: 'ets2', root: setup.target.root, source: 'steam', temp: null, fromSha256: sha(OLD), toSha256: null,
      appVersion: null, createdPluginsDirectory: false, startedUtc: UTC}]]);

    const kept = await game({content: OLD, name: 'kept'});
    const failing: AtomicFileSystem = {...(guard.fs as unknown as AtomicFileSystem), open: (target, flags) => flags === 'wx' ? Promise.reject(errno('EACCES')) : guard.fs.open(target, flags)};
    const probe2 = instrument(guarded());
    expect(await installer(await loadRegistry(failing), {fs: probe2.fs}).remove(kept.target)).toMatchObject({outcome: 'blocked', reason: 'REGISTRY_UNAVAILABLE', step: 'pending'});
    expect(mutationsOf(probe2.calls)).toEqual([]);
    expect(await fsp.readFile(kept.dll)).toEqual(OLD);
  });
});

describe('real Windows locks and permissions', () => {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  let holder: ChildProcessWithoutNullStreams | undefined;
  afterEach(async () => {
    if (holder && holder.exitCode === null) {holder.kill(); await new Promise(resolve => holder!.once('exit', resolve));}
    holder = undefined;
  });

  /** A Windows PowerShell child that opens `target` with the given sharing and holds it until its stdin closes. */
  async function holdOpen(target: string, share: 'None' | 'Read'): Promise<() => Promise<void>> {
    const script = `$f = [System.IO.File]::Open($env:ETS2TELEMETRY_TEST_LOCK, 'Open', 'Read', '${share}'); [Console]::Out.WriteLine('locked'); [Console]::Out.Flush(); ` +
      '[void][Console]::In.ReadLine(); $f.Close()';
    const child = holder = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'pipe', windowsHide: true,
      env: {...process.env, ETS2TELEMETRY_TEST_LOCK: target, PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')}
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => {output += chunk.toString('utf8');});
    const deadline = Date.now() + 30_000;
    while (!output.includes('locked')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('lock holder did not start');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return async () => {child.stdin.end('\n'); if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));};
  }

  it('reports a target held with FileShare.None as TARGET_LOCKED and changes nothing', {timeout: 60_000}, async () => {
    const setup = await game({content: OLD});
    const registry = await loadRegistry();
    const release = await holdOpen(setup.dll, 'None');
    expect(await installer(registry).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason: 'TARGET_LOCKED', step: 'classify', errno: 'EBUSY'});
    expect(await installer(registry).remove(setup.target)).toMatchObject({outcome: 'blocked', reason: 'TARGET_LOCKED', step: 'classify'});
    await release();
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
    expect((await installer(registry).ensureInstalled(setup.target)).outcome).toBe('updated');
  });

  // Windows refuses to replace a file another process holds open without delete sharing with ERROR_ACCESS_DENIED,
  // which Node reports as EPERM (measured October 17, 2026), so this lock is reported at once and never retried.
  it('reports a rename over a target held without delete sharing as TARGET_LOCKED at once and changes nothing', {timeout: 60_000}, async () => {
    const setup = await game({content: OLD});
    const registry = await loadRegistry();
    const release = await holdOpen(setup.dll, 'Read');
    const probe = instrument(guarded());
    expect(await installer(registry, {fs: probe.fs}).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason: 'TARGET_LOCKED', step: 'rename', errno: 'EPERM'});
    expect(probe.calls.filter(call => call.op === 'rename')).toHaveLength(1);
    expect(delays).toEqual([]);
    await release();
    expect(await fsp.readFile(setup.dll)).toEqual(OLD);
    expect(await list(setup.plugins)).toEqual(['ets2telemetry-plugin.dll']);
  });

  it('reports a real ACL deny on the plugins folder as PERMISSION_DENIED and restores the ACL', {timeout: 60_000}, async () => {
    const setup = await game({plugins: true});
    // Only a folder inside this test's own temporary root is ever changed.
    expect(setup.plugins.toLowerCase().startsWith(`${guard.root.toLowerCase()}\\`)).toBe(true);
    const icacls = path.win32.join(systemRoot, 'System32', 'icacls.exe');
    const whoami = execFileSync(path.win32.join(systemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], {encoding: 'utf8', windowsHide: true});
    const sid = /"(S-1-[0-9-]+)"/.exec(whoami)?.[1];
    expect(sid).toMatch(/^S-1-5-/);
    execFileSync(icacls, [setup.plugins, '/deny', `*${sid}:(WD,AD)`], {windowsHide: true, stdio: 'ignore'});
    try {
      expect(await installer(await loadRegistry()).ensureInstalled(setup.target)).toMatchObject({outcome: 'blocked', reason: 'PERMISSION_DENIED', step: 'temp', errno: 'EPERM'});
      expect(await list(setup.plugins)).toEqual([]);
    } finally {
      execFileSync(icacls, [setup.plugins, '/remove:d', `*${sid}`], {windowsHide: true, stdio: 'ignore'});
    }
    expect(execFileSync(icacls, [setup.plugins], {encoding: 'utf8', windowsHide: true})).not.toMatch(/\(DENY\)/);
    expect((await installer(await loadRegistry()).ensureInstalled(setup.target)).outcome).toBe('installed');
  });
});
