import {createHash} from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginSetupView} from '../../packages/contracts/src';
import type {RunningGames} from '../../apps/desktop/src/plugin-setup/game-processes';
import type {PluginSetupDecision} from '../../apps/desktop/src/plugin-setup/mode';
import type {InstallerFileSystem, RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {PluginRegistry} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {LAUNCH_DELAY_MS, MAX_LOCKED_RETRIES, POLL_INTERVAL_MS, PluginSetup, PluginSetupError, RUN_TIMEOUT_MS, type PluginSetupPorts} from '../../apps/desktop/src/plugin-setup/plugin-setup';
import type {PluginBundleResult} from '../../apps/desktop/src/plugin-setup/plugin-bundle';
import {fakeSteam, type FakeSteam} from '../shared/fake-steam';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-015 (ET-017 P13, P14, P15, P16): the setup orchestrator in main, in the test-root mode against fake Steam and game
// folders under the guarded temporary root, with a fake running-game lister and controlled timers. Expected views, logs
// and timings are written by hand from P13–P16. The guarded file system must record no refused path in any case.

let guard: GuardedRoot;
let steam: FakeSteam;
let running: RunningGames;
let lister: ReturnType<typeof vi.fn<RunningCheck>>;
let events: {event: string; facts?: unknown}[];
let views: PluginSetupView[];
let readSteamRoot: ReturnType<typeof vi.fn<PluginSetupPorts['readSteamRoot']>>;
let bundleResult: PluginBundleResult;
let fs: InstallerFileSystem;
let ets2Root: string;
let atsRoot: string;
let outside: GuardedRoot | undefined;
const UTC = '2026-10-17T08:30:15.250Z';
const BUNDLE = Buffer.from('bundled plugin 0.2.0 '.repeat(200));
const SHA = createHash('sha256').update(BUNDLE).digest('hex');
const BUNDLED_VIEW = {version: '0.2.0', sha256Prefix: SHA.slice(0, 12)};
const NOT_RUNNING: RunningGames = {ets2: false, ats: false, client: false};

beforeEach(async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  guard = await guardedTempRoot('ets2telemetry-plugin-setup-');
  steam = await fakeSteam(guard.root);
  const libraryB = await steam.library('LibraryB');
  await steam.libraryFolders([steam.steam, libraryB]);
  ets2Root = await steam.install(steam.steam, 'ets2');
  atsRoot = await steam.install(libraryB, 'ats');
  running = {...NOT_RUNNING};
  lister = vi.fn<RunningCheck>(() => Promise.resolve({ok: true, running: {...running}}));
  events = []; views = []; outside = undefined;
  readSteamRoot = vi.fn(() => Promise.reject(new Error('the test-root mode must not read the Steam registry')));
  bundleResult = {ok: true, bundle: {bytes: BUNDLE, sha256: SHA, appVersion: '0.2.0', known: [], file: path.join(guard.root, 'bundle', 'ets2telemetry-plugin.dll')}};
  fs = guard.fs;
});
afterEach(async () => {
  vi.useRealTimers();
  const violations = [...guard.violations, ...(outside?.violations ?? [])];
  await guard.dispose();
  await outside?.dispose();
  expect(violations).toEqual([]);
});

const decision = (): PluginSetupDecision => ({mode: 'test-root', root: guard.root});
const registryDirectory = () => path.join(guard.root, 'LocalAppData', 'ETS2Telemetry', 'plugins');
function ports(overrides: Partial<PluginSetupPorts> = {}): PluginSetupPorts {
  return {
    fs, readBundle: () => Promise.resolve(bundleResult),
    loadRegistry: directory => PluginRegistry.load(directory, {fs: guard.fs, now: () => new Date(UTC), log: (event, _detail, facts) => events.push({event, facts})}),
    readSteamRoot, checkRunning: lister, registryDirectory: undefined, dataRoot: undefined, installDirectory: undefined, randomHex: () => '0123456789abcdef',
    ...overrides
  };
}
function create(overrides: Partial<PluginSetupPorts> = {}, mode: PluginSetupDecision = decision()): PluginSetup {
  const setup: PluginSetup = new PluginSetup({decision: mode, log: (event, _detail, facts) => events.push({event, facts}), changed: () => views.push(setup.view()),
    ports: mode.mode === 'disabled' ? undefined : ports(overrides)});
  return setup;
}
// Only setTimeout is faked; setImmediate stays real, so these helpers can wait for real file I/O between checks.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** A hang guard for waiting on real file I/O, not a bound on how fast setup runs. */
const IO_WAIT_GUARD_MS = 20_000;
/** Waits, across real I/O, until `condition` holds; `performance.now()` is not faked. */
async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + IO_WAIT_GUARD_MS;
  while (!condition() && performance.now() < deadline) await tick();
  expect(condition()).toBe(true);
}
/** Waits until no run is in flight, including a coalesced follow-up or one a poll just triggered. */
async function settled(setup: PluginSetup): Promise<void> {
  for (let turn = 0; turn < 3; turn++) {
    await tick();
    for (let work = setup.idle(); work; work = setup.idle()) {await work; turn = 0;}
  }
}
async function launch(setup: PluginSetup): Promise<void> {
  setup.start();
  await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS);
  await settled(setup);
}
const dll = (root: string) => path.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll');
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);
const runs = () => views.filter((view, index) => view.running && !(views[index - 1]?.running)).length;
const logged = (name: string) => events.filter(entry => entry.event === name);
const target = (id: string, state: string, overrides: Record<string, unknown> = {}) => ({id, source: id.split(':')[1], ordinal: Number(id.split(':')[2]), state,
  reason: null, installed: state === 'installed' ? BUNDLED_VIEW : null, lastFailure: null, ...overrides});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

describe('launch run', () => {
  it('starts 2 s after start on an unreferenced timer that startup never awaits, and installs into both games', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setup = create();
    expect(setup.start()).toBeUndefined();
    const timer = setTimeoutSpy.mock.results.at(-1)!.value as {hasRef(): boolean};
    expect(setTimeoutSpy.mock.lastCall?.[1]).toBe(LAUNCH_DELAY_MS);
    expect(timer.hasRef()).toBe(false);
    expect(setup.idle()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS - 1);
    expect(setup.idle()).toBeUndefined();
    expect(lister).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(setup.idle()).toBeDefined();
    expect(setup.view().running).toBe(true);
    await settled(setup);
    setTimeoutSpy.mockRestore();
    expect(setup.view()).toEqual({mode: 'test-root', bundled: BUNDLED_VIEW, running: false, games: {
      ets2: {excluded: false, discovery: 'found', manualFolder: 'none', targets: [target('ets2:steam:0', 'installed')]},
      ats: {excluded: false, discovery: 'found', manualFolder: 'none', targets: [target('ats:steam:0', 'installed')]}
    }});
    expect(await fsp.readFile(dll(ets2Root))).toEqual(BUNDLE);
    expect(await fsp.readFile(dll(atsRoot))).toEqual(BUNDLE);
    // The test-root mode never reads the Steam registry; its install registry lies inside the root.
    expect(readSteamRoot).not.toHaveBeenCalled();
    expect(await exists(path.join(registryDirectory(), 'setup.json'))).toBe(true);
    // Nothing waits: no poll and no further run.
    expect(vi.getTimerCount()).toBe(0);
    expect(runs()).toBe(1);
  });

  it('starts only once, and not at all after the exit began before the launch delay', async () => {
    const setup = create();
    setup.start(); setup.start();
    expect(vi.getTimerCount()).toBe(1);
    setup.abort();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS * 2);
    expect(lister).not.toHaveBeenCalled();
    expect(await exists(path.join(ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    await expect(setup.retry()).rejects.toThrow(PluginSetupError);
  });
});

describe('single flight', () => {
  it('coalesces every trigger during a run into one follow-up run', async () => {
    const gate = deferred<void>();
    let calls = 0;
    lister.mockImplementation(async () => {if (calls++ === 0) await gate.promise; return {ok: true, running: {...running}};});
    const setup = create();
    const first = setup.retry();
    await until(() => lister.mock.calls.length === 1);
    // A folder seen for the first time is `working` until its first result.
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'working')]);
    const second = setup.retry(), third = setup.retry();
    const excluded = setup.setExcluded('ats', true);
    gate.resolve();
    await Promise.all([first, second, third, excluded]);
    await settled(setup);
    expect(runs()).toBe(2);
    expect(setup.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'excluded')]});
    expect(await exists(dll(atsRoot))).toBe(false);
  });
});

describe('polling', () => {
  it('polls the running games every 15 s only while a folder waits for its game, then installs', async () => {
    running = {...NOT_RUNNING, ets2: true};
    const setup = create();
    await launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'missing', {reason: 'GAME_RUNNING'})]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'installed')]);
    expect(vi.getTimerCount()).toBe(1);
    const before = lister.mock.calls.length;
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(lister.mock.calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(lister.mock.calls.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(lister.mock.calls.length).toBe(before + 2);
    expect(runs()).toBe(1);
    running = {...NOT_RUNNING};
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await settled(setup);
    expect(runs()).toBe(2);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    const after = lister.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
    expect(lister.mock.calls.length).toBe(after);
  });

  it('waits for the TruckersMP client too, and does not poll for a folder it cannot change', async () => {
    running = {...NOT_RUNNING, client: true};
    const setup = create();
    await launch(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'missing', reason: 'CLIENT_RUNNING'});
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'missing', reason: 'CLIENT_RUNNING'});
    running = {...NOT_RUNNING};
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await settled(setup);
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'installed'});

    // An unrecognized file waits for the driver, not for a process: no poll.
    const foreign = path.join(guard.root, 'Foreign');
    await steam.gameFolder(foreign, 'ets2', {plugins: true});
    await fsp.writeFile(dll(foreign), 'someone else');
    const other = create();
    await other.chooseFolder('ets2', foreign);
    await settled(other);
    expect(other.view().games.ets2.targets.find(entry => entry.id === 'ets2:manual:0')).toMatchObject({state: 'blocked', reason: 'UNRECOGNIZED_FILE',
      lastFailure: 'UNRECOGNIZED_FILE'});
    other.abort(); setup.abort();
    expect(await fsp.readFile(dll(foreign), 'utf8')).toBe('someone else');
  });

  it('retries a locked file at most three times while the running games stay the same, and again when they change', async () => {
    let locked = true;
    const base = fs;
    fs = {...base, rename: (from, to) => locked && to === dll(ets2Root) ? Promise.reject(Object.assign(new Error('EPERM: simulated'), {code: 'EPERM'})) : base.rename(from, to)};
    const setup = create();
    await launch(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'missing', reason: 'TARGET_LOCKED', lastFailure: 'TARGET_LOCKED'});
    for (let retry = 1; retry <= MAX_LOCKED_RETRIES; retry++) {
      await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      await settled(setup);
      expect(runs()).toBe(1 + retry);
    }
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
    await settled(setup);
    expect(runs()).toBe(1 + MAX_LOCKED_RETRIES);
    expect(vi.getTimerCount()).toBe(1);
    // The holder may have been a process that just exited: a change of the running games tries again.
    locked = false;
    running = {...NOT_RUNNING, ats: true};
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await settled(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'installed', lastFailure: null});
    setup.abort();
  });
});

describe('abort', () => {
  it('aborts a run after 30 s and changes nothing more', async () => {
    lister.mockImplementation(signal => new Promise(resolve => signal?.addEventListener('abort', () => resolve({ok: false, code: 'RUNNING_CHECK_FAILED'}))));
    const setup = create();
    setup.start();
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS);
    await until(() => lister.mock.calls.length === 1);
    await vi.advanceTimersByTimeAsync(RUN_TIMEOUT_MS - 1);
    expect(setup.idle()).toBeDefined();
    expect(logged('PLUGIN_SETUP_TIMEOUT')).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await settled(setup);
    expect(logged('PLUGIN_SETUP_TIMEOUT')).toEqual([{event: 'PLUGIN_SETUP_TIMEOUT', facts: {timeoutMs: 30_000}}]);
    expect(setup.view().running).toBe(false);
    // The run stopped after the first folder: the second game was never touched.
    expect(lister).toHaveBeenCalledTimes(1);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'blocked', reason: 'RUNNING_CHECK_FAILED'});
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'working'});
    expect(await exists(path.join(ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(await exists(path.join(atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
  });

  it('on exit stops after the current folder, and idle settles only after its temporary file is removed', async () => {
    const renaming = deferred<void>(), release = deferred<void>();
    const base = fs;
    fs = {...base, rename: async (from, to) => {
      if (to === dll(ets2Root)) {renaming.resolve(); await release.promise; throw Object.assign(new Error('EPERM: simulated'), {code: 'EPERM'});}
      return base.rename(from, to);
    }};
    const setup = create();
    setup.start();
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS);
    await renaming.promise;
    const plugins = path.join(ets2Root, 'bin', 'win_x64', 'plugins');
    expect(await fsp.readdir(plugins)).toEqual(['ets2telemetry-plugin.dll.0123456789abcdef.tmp']);
    setup.abort();
    const idle = setup.idle();
    expect(idle).toBeDefined();
    let done = false;
    void idle!.then(() => {done = true;});
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    await expect(setup.retry()).rejects.toThrow('Plugin setup has stopped');
    await expect(setup.setExcluded('ets2', true)).rejects.toThrow('Plugin setup has stopped');
    release.resolve();
    await idle;
    // The interrupted folder keeps no temporary file and no DLL; the next game's folder was never touched.
    expect(await exists(plugins)).toBe(false);
    expect(await exists(path.join(atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(setup.idle()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('logs', () => {
  it('logs the mode once and discovery, actions and the bundle only when they change', async () => {
    const setup = create();
    await launch(setup);
    await setup.retry();
    await setup.retry();
    expect(logged('PLUGIN_SETUP_MODE')).toEqual([{event: 'PLUGIN_SETUP_MODE', facts: {mode: 'test-root', reason: null}}]);
    expect(logged('PLUGIN_DISCOVERY')).toHaveLength(1);
    expect(logged('PLUGIN_DISCOVERY')[0].facts).toMatchObject({steam: 'found', libraries: 2, ets2: 'found', ats: 'found'});
    expect(logged('PLUGIN_BUNDLE')).toEqual([{event: 'PLUGIN_BUNDLE', facts: {state: 'verified'}}]);
    expect(logged('PLUGIN_ACTION').map(entry => entry.facts)).toEqual([
      {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null},
      {game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null},
      {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', code: null, step: null, errno: null},
      {game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', code: null, step: null, errno: null}
    ]);
    running = {...NOT_RUNNING, ats: true};
    await setup.retry();
    expect(logged('PLUGIN_ACTION').at(-1)!.facts).toEqual({game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'blocked', code: 'GAME_RUNNING', step: 'process', errno: null});
    expect(logged('PLUGIN_ACTION')).toHaveLength(5);
    setup.abort();
  });

  it('logs a rejected test root and the disabled mode, and the disabled mode does nothing at all', async () => {
    const setup = new PluginSetup({decision: {mode: 'disabled', reason: 'root-rejected', rejected: 'no-profile'},
      log: (event, _detail, facts) => events.push({event, facts}), changed: () => views.push(setup.view())});
    setup.start();
    expect(vi.getTimerCount()).toBe(0);
    const view = await setup.retry();
    expect(view).toEqual({mode: 'disabled', bundled: null, running: false, games: {
      ets2: {excluded: false, discovery: 'pending', manualFolder: 'none', targets: []}, ats: {excluded: false, discovery: 'pending', manualFolder: 'none', targets: []}}});
    expect(await setup.setExcluded('ets2', true)).toEqual(view);
    expect(await setup.chooseFolder('ets2', ets2Root)).toEqual({outcome: 'refused', code: 'SETUP_DISABLED'});
    expect(await setup.folderToOpen('ets2:steam:0')).toBeUndefined();
    expect(setup.bundledFile()).toBeUndefined();
    expect(setup.idle()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(LAUNCH_DELAY_MS + POLL_INTERVAL_MS);
    expect(events).toEqual([
      {event: 'PLUGIN_SETUP_MODE_REJECTED', facts: {reason: 'no-profile'}},
      {event: 'PLUGIN_SETUP_MODE', facts: {mode: 'disabled', reason: 'root-rejected'}}
    ]);
    expect(views).toEqual([]);
    expect(await exists(registryDirectory())).toBe(false);
    expect(await exists(path.join(ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
  });
});

describe('test root', () => {
  it('ignores a library and a junction outside the root without touching them, and logs the escape', async () => {
    outside = await guardedTempRoot('ets2telemetry-plugin-outside-');
    const elsewhere = await fakeSteam(outside.root);
    const outsideLibrary = await elsewhere.library('OutsideLibrary');
    const outsideEts2 = await elsewhere.install(outsideLibrary, 'ets2');
    const junction = path.join(guard.root, 'JunctionLibrary');
    await fsp.symlink(outsideLibrary, junction, 'junction');
    await steam.libraryFolders([steam.steam, outsideLibrary, junction, path.join(guard.root, 'LibraryB')]);
    const setup = create();
    await launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(await exists(path.join(outsideEts2, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(logged('PLUGIN_TEST_ROOT_ESCAPE').length).toBeGreaterThan(0);
    expect(logged('PLUGIN_DISCOVERY')[0].facts).toMatchObject({libraries: 2, missingLibraries: 2});
    // A folder chosen outside the root is refused before any file access and nothing is stored.
    const before = await fsp.readFile(path.join(registryDirectory(), 'setup.json'));
    const escapes = logged('PLUGIN_TEST_ROOT_ESCAPE').length;
    expect(await setup.chooseFolder('ets2', outsideEts2)).toEqual({outcome: 'refused', code: 'FOLDER_UNSUPPORTED_PATH'});
    expect(logged('PLUGIN_TEST_ROOT_ESCAPE')).toHaveLength(escapes + 1);
    expect(await fsp.readFile(path.join(registryDirectory(), 'setup.json'))).toEqual(before);
    // The junction inside the root that points outside is refused the same way.
    expect(await setup.chooseFolder('ets2', path.join(junction, 'steamapps', 'common', 'Euro Truck Simulator 2'))).toEqual({outcome: 'refused', code: 'FOLDER_NOT_GAME'});
    expect(readSteamRoot).not.toHaveBeenCalled();
    setup.abort();
  });
});

describe('view', () => {
  it('never carries a path, in the view or in a log line', async () => {
    const manual = await steam.gameFolder(path.join(guard.root, 'Manual ETS2'), 'ets2');
    const setup = create();
    await launch(setup);
    expect(await setup.chooseFolder('ets2', path.join(manual, 'bin', 'win_x64'))).toEqual({outcome: 'chosen'});
    await settled(setup);
    running = {...NOT_RUNNING, ats: true};
    await setup.setExcluded('ats', true);
    const text = JSON.stringify([setup.view(), ...views, events]);
    expect(text.toLowerCase()).not.toContain(guard.root.toLowerCase().replaceAll('\\', '\\\\'));
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\/);
    expect(setup.view().games.ets2.targets.map(entry => entry.id)).toEqual(['ets2:steam:0', 'ets2:manual:0']);
    expect(setup.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'blocked', {reason: 'GAME_RUNNING', installed: BUNDLED_VIEW})]});
    setup.abort();
  });
});

describe('triggers', () => {
  it('stores a chosen folder by its canonical root and installs into it; a wrong game writes nothing', async () => {
    const manual = await steam.gameFolder(path.join(guard.root, 'Manual ETS2'), 'ets2');
    const setup = create();
    await launch(setup);
    const before = await fsp.readFile(path.join(registryDirectory(), 'setup.json'));
    expect(await setup.chooseFolder('ats', manual)).toEqual({outcome: 'refused', code: 'FOLDER_WRONG_GAME'});
    expect(await setup.chooseFolder('ets2', ets2Root)).toEqual({outcome: 'refused', code: 'FOLDER_DUPLICATE'});
    expect(await fsp.readFile(path.join(registryDirectory(), 'setup.json'))).toEqual(before);
    expect(await setup.chooseFolder('ets2', path.join(manual, 'BIN', 'win_x64', 'plugins'))).toEqual({outcome: 'chosen'});
    await settled(setup);
    const stored = JSON.parse(await fsp.readFile(path.join(registryDirectory(), 'setup.json'), 'utf8')) as {games: {ets2: {manualRoot: string}}};
    expect(stored.games.ets2.manualRoot).toBe(manual);
    expect(setup.view().games.ets2).toMatchObject({manualFolder: 'set', targets: [target('ets2:steam:0', 'installed'), target('ets2:manual:0', 'installed')]});
    expect(await fsp.readFile(dll(manual))).toEqual(BUNDLE);
    // A manual folder that disappears is invalid and no longer listed.
    await fsp.rm(manual, {recursive: true});
    await setup.retry();
    expect(setup.view().games.ets2).toMatchObject({manualFolder: 'invalid', targets: [target('ets2:steam:0', 'installed')]});
    setup.abort();
  });

  it('removes the plugin from an excluded game and installs it again when included', async () => {
    const setup = create();
    await launch(setup);
    expect(await setup.setExcluded('ats', true)).toMatchObject({games: {ats: {excluded: true, targets: [target('ats:steam:0', 'excluded')]}}});
    expect(await exists(dll(atsRoot))).toBe(false);
    // The plugins folder this application created is removed with the plugin.
    expect(await exists(path.join(atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
    // A restart reads the exclusion from the registry.
    const restarted = create();
    await launch(restarted);
    expect(restarted.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'excluded')]});
    expect(await restarted.setExcluded('ats', false)).toMatchObject({games: {ats: {excluded: false, targets: [target('ats:steam:0', 'installed')]}}});
    expect(await fsp.readFile(dll(atsRoot))).toEqual(BUNDLE);
    setup.abort(); restarted.abort();
  });

  it('opens the plugins folder of a listed folder, bin\\win_x64 when it is absent, and nothing for an unknown or linked folder', async () => {
    running = {...NOT_RUNNING, ats: true};
    const setup = create();
    await launch(setup);
    expect(await setup.folderToOpen('ets2:steam:0')).toBe(path.join(ets2Root, 'bin', 'win_x64', 'plugins'));
    expect(await setup.folderToOpen('ats:steam:0')).toBe(path.join(atsRoot, 'bin', 'win_x64'));
    expect(await setup.folderToOpen('ats:manual:0')).toBeUndefined();
    expect(await setup.folderToOpen('ets2:steam:3')).toBeUndefined();
    const moved = path.join(guard.root, 'Moved');
    await fsp.mkdir(moved);
    await fsp.symlink(moved, path.join(atsRoot, 'bin', 'win_x64', 'plugins'), 'junction');
    expect(await setup.folderToOpen('ats:steam:0')).toBeUndefined();
    expect(setup.bundledFile()).toBe(path.join(guard.root, 'bundle', 'ets2telemetry-plugin.dll'));
    setup.abort();
  });
});

describe('failures', () => {
  it('reports an unavailable bundle on every folder without writing, and reads it again on the next run', async () => {
    bundleResult = {ok: false, code: 'BUNDLE_UNAVAILABLE', failure: 'plugin-hash'};
    const readBundle = vi.fn(() => Promise.resolve(bundleResult));
    const setup = create({readBundle});
    await launch(setup);
    expect(setup.view()).toMatchObject({bundled: null, games: {ets2: {targets: [target('ets2:steam:0', 'blocked', {reason: 'BUNDLE_UNAVAILABLE'})]},
      ats: {targets: [target('ats:steam:0', 'blocked', {reason: 'BUNDLE_UNAVAILABLE'})]}}});
    expect(await exists(path.join(ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(logged('PLUGIN_BUNDLE')).toEqual([{event: 'PLUGIN_BUNDLE', facts: {state: 'unavailable', failure: 'plugin-hash'}}]);
    bundleResult = {ok: true, bundle: {bytes: BUNDLE, sha256: SHA, appVersion: '0.2.0', known: [], file: path.join(guard.root, 'bundle', 'ets2telemetry-plugin.dll')}};
    await setup.retry();
    await setup.retry();
    expect(readBundle).toHaveBeenCalledTimes(2);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    setup.abort();
  });

  it('treats a recovery reason as information: other folders still install', async () => {
    // An interrupted install into a folder whose `bin` became a junction stays pending with LINKED_FOLDER.
    const linkedRoot = path.join(guard.root, 'Linked ETS2');
    const real = await steam.gameFolder(path.join(guard.root, 'Real bin'), 'ets2');
    await fsp.mkdir(linkedRoot);
    await fsp.symlink(path.join(real, 'bin'), path.join(linkedRoot, 'bin'), 'junction');
    await fsp.mkdir(registryDirectory(), {recursive: true});
    const temp = path.join(linkedRoot, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll.00000000000000aa.tmp');
    await fsp.writeFile(path.join(registryDirectory(), 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
      games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}}, installs: [],
      pending: [{op: 'install', game: 'ets2', root: linkedRoot, source: 'manual', temp, fromSha256: null, toSha256: SHA, appVersion: '0.2.0',
        createdPluginsDirectory: true, startedUtc: UTC}], failures: []}, null, 2) + '\n');
    const setup = create();
    await launch(setup);
    expect(logged('PLUGIN_RECOVERY_PENDING').map(entry => entry.facts)).toEqual([{remaining: 1, reason: 'LINKED_FOLDER'}]);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'installed')]);
    setup.abort();
  });

  it('refuses an exclusion change that cannot be stored, without a run', async () => {
    await fsp.mkdir(registryDirectory(), {recursive: true});
    await fsp.writeFile(path.join(registryDirectory(), 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 2}));
    const setup = create();
    await expect(setup.setExcluded('ets2', true)).rejects.toThrow('Plugin setup could not be saved');
    expect(await setup.chooseFolder('ets2', ets2Root)).toEqual({outcome: 'refused', code: 'REGISTRY_UNAVAILABLE'});
    expect(runs()).toBe(0);
    expect(logged('PLUGIN_REGISTRY_STATE')).toEqual([{event: 'PLUGIN_REGISTRY_STATE', facts: {state: 'newer-version'}}]);
    setup.abort();
  });
});
