import {createHash} from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {PluginSetupView} from '../../packages/contracts/src';
import type {RunningGames} from '../../apps/desktop/src/plugin-setup/game-processes';
import {TEST_ROOT_MARKER, type PluginSetupDecision} from '../../apps/desktop/src/plugin-setup/mode';
import type {InstallerFileSystem, RunningCheck} from '../../apps/desktop/src/plugin-setup/plugin-installer';
import {PluginRegistry} from '../../apps/desktop/src/plugin-setup/plugin-registry';
import {LAUNCH_DELAY_MS, MAX_LOCKED_RETRIES, POLL_INTERVAL_MS, PluginSetup, PluginSetupError, RUN_TIMEOUT_MS, type PluginSetupPorts} from '../../apps/desktop/src/plugin-setup/plugin-setup';
import type {PluginBundleResult} from '../../apps/desktop/src/plugin-setup/plugin-bundle';
import {fakeSteam, type FakeSteam} from '../shared/fake-steam';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-015 (ET-017 P13, P14, P15, P16): the setup orchestrator in main, in the test-root mode against fake Steam and game
// folders under the guarded temporary root, with a fake running-game lister and controlled timers. Expected views, logs
// and timings are written by hand from P13–P16. The guarded file system must record no refused path in any case.

const UTC = '2026-10-17T08:30:15.250Z';
const BUNDLE = Buffer.from('bundled plugin 0.2.0 '.repeat(200));
const SHA = createHash('sha256').update(BUNDLE).digest('hex');
const BUNDLED_VIEW = {version: '0.2.0', sha256Prefix: SHA.slice(0, 12)};
const NOT_RUNNING: RunningGames = {ets2: false, ats: false, client: false};

// Only setTimeout is faked; setImmediate stays real, so these helpers can wait for real file I/O between checks.
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
/** A hang guard for waiting on real file I/O, not a bound on how fast setup runs. */
const IO_WAIT_GUARD_MS = 20_000;
/** A hang guard for an aborted run to finish its current folder across real I/O at teardown, not a bound on its speed. */
const RUN_SETTLE_GUARD_MS = IO_WAIT_GUARD_MS;
/** The teardown hook's timeout: the settle guard, then as long again to remove the temporary roots, so the guard fires first. */
const TEARDOWN_TIMEOUT_MS = 2 * RUN_SETTLE_GUARD_MS;

/**
 * Everything one case owns: its guarded root, fake Steam folders, lister, logs, views, bundle result, file system and
 * every PluginSetup it creates. A case takes it once, at its start, and the closures it hands to PluginSetup capture
 * this object, never module state. A case that outlives its timeout therefore writes only into its own harness, and
 * after teardown its clock, spy and setup calls through the harness throw, so it cannot advance or patch the timers of
 * the case that runs next.
 */
class CaseHarness {
  readonly events: {event: string; facts?: unknown}[] = [];
  readonly views: PluginSetupView[] = [];
  readonly lister = vi.fn<RunningCheck>(() => Promise.resolve({ok: true, running: {...this.running}}));
  readonly readSteamRoot = vi.fn<PluginSetupPorts['readSteamRoot']>(() => Promise.reject(new Error('the test-root mode must not read the Steam registry')));
  running: RunningGames = {...NOT_RUNNING};
  bundleResult: PluginBundleResult;
  fs: InstallerFileSystem;
  outside: GuardedRoot | undefined;
  private readonly setups: PluginSetup[] = [];
  private readonly spies: {mockRestore(): void}[] = [];
  private ended = false;

  private constructor(readonly guard: GuardedRoot, readonly steam: FakeSteam, readonly ets2Root: string, readonly atsRoot: string) {
    this.bundleResult = {ok: true, bundle: {bytes: BUNDLE, sha256: SHA, appVersion: '0.2.0', known: [], file: path.join(guard.root, 'bundle', 'ets2telemetry-plugin.dll')}};
    this.fs = guard.fs;
  }

  static async create(): Promise<CaseHarness> {
    const guard = await guardedTempRoot('ets2telemetry-plugin-setup-');
    try {
      const steam = await fakeSteam(guard.root);
      const libraryB = await steam.library('LibraryB');
      await steam.libraryFolders([steam.steam, libraryB]);
      const ets2Root = await steam.install(steam.steam, 'ets2');
      const atsRoot = await steam.install(libraryB, 'ats');
      // The test root's marker: without it the test-root mode turns itself off.
      await fsp.writeFile(path.join(guard.root, TEST_ROOT_MARKER), 'fake root for plugin setup tests');
      return new CaseHarness(guard, steam, ets2Root, atsRoot);
    } catch (error) {
      await guard.dispose();
      throw error;
    }
  }

  decision(): PluginSetupDecision {
    this.live();
    return {mode: 'test-root', root: this.guard.root};
  }
  registryDirectory(): string {
    this.live();
    return path.join(this.guard.root, 'LocalAppData', 'ETS2Telemetry', 'plugins');
  }
  create(overrides: Partial<PluginSetupPorts> = {}, mode: PluginSetupDecision = this.decision()): PluginSetup {
    this.live();
    const setup: PluginSetup = new PluginSetup({decision: mode, log: (event, _detail, facts) => this.events.push({event, facts}),
      changed: () => this.views.push(setup.view()), ports: mode.mode === 'disabled' ? undefined : this.ports(overrides)});
    this.setups.push(setup);
    return setup;
  }
  /** Advances this case's fake clock; refused once the case has ended, so a late case cannot move the next case's clock. */
  async advance(milliseconds: number): Promise<void> {
    this.live();
    await vi.advanceTimersByTimeAsync(milliseconds);
  }
  async launch(setup: PluginSetup): Promise<void> {
    setup.start();
    await this.advance(LAUNCH_DELAY_MS);
    await settled(setup);
  }
  /** A setTimeout spy that teardown restores before the real timers return. */
  spyOnSetTimeout() {
    this.live();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    this.spies.push(spy);
    return spy;
  }
  /** Refused once the case has ended: a late restore would put this case's fake setTimeout back over the next case's. */
  restoreSpies(): void {
    this.live();
    for (const spy of this.spies.splice(0)) spy.mockRestore();
  }
  runs(): number {
    return this.views.filter((view, index) => view.running && !(this.views[index - 1]?.running)).length;
  }
  logged(name: string): {event: string; facts?: unknown}[] {
    return this.events.filter(entry => entry.event === name);
  }

  /**
   * Teardown, while this case's fake timers are still installed: refuses further harness calls, aborts every setup
   * through its exit API and waits, under RUN_SETTLE_GUARD_MS, until none has a run or registry write in flight. An
   * aborted run can still wait on a fake retry delay, so the case's own pending timers are fired one at a time.
   */
  async end(): Promise<void> {
    this.ended = true;
    for (const setup of this.setups) setup.abort();
    const deadline = performance.now() + RUN_SETTLE_GUARD_MS;
    for (let pending = this.pending(); pending; pending = this.pending()) {
      let done = false;
      void pending.then(() => {done = true;});
      while (!done) {
        if (performance.now() >= deadline) throw new Error(`An aborted plugin setup run did not settle within RUN_SETTLE_GUARD_MS (${RUN_SETTLE_GUARD_MS} ms)`);
        await tick();
        if (!done && vi.isFakeTimers() && vi.getTimerCount() > 0) await vi.advanceTimersToNextTimerAsync();
      }
    }
  }
  /** Removes the temporary roots and returns every refused path; call after end() and after the real timers return. */
  async dispose(): Promise<string[]> {
    this.ended = true;
    const violations = [...this.guard.violations, ...(this.outside?.violations ?? [])];
    await this.guard.dispose();
    await this.outside?.dispose();
    return violations;
  }

  private pending(): Promise<unknown> | undefined {
    const work = this.setups.map(setup => setup.idle()).filter(idle => idle !== undefined);
    return work.length ? Promise.all(work) : undefined;
  }
  private live(): void {
    if (this.ended) throw new Error('This case has ended: its harness was torn down, so it may not touch timers, spies or setups');
  }
  private ports(overrides: Partial<PluginSetupPorts>): PluginSetupPorts {
    return {
      fs: this.fs, registryFs: this.guard.fs, readBundle: () => Promise.resolve(this.bundleResult),
      loadRegistry: (directory, registryFs) => PluginRegistry.load(directory, {fs: registryFs, now: () => new Date(UTC), log: (event, _detail, facts) => this.events.push({event, facts})}),
      readSteamRoot: this.readSteamRoot, checkRunning: this.lister, registryDirectory: undefined, dataRoot: undefined, installDirectory: undefined, randomHex: () => '0123456789abcdef',
      ...overrides
    };
  }
}

// The harness of the case now running. A case takes it once, with harness() at its start. Both hooks bump
// `generation`, so a beforeEach that outlives its own timeout disposes the harness it built instead of publishing it.
let current: CaseHarness | undefined;
let generation = 0;
function harness(): CaseHarness {
  if (!current) throw new Error('No harness: this case\'s beforeEach did not finish');
  return current;
}

beforeEach(async () => {
  const mine = ++generation;
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const made = await CaseHarness.create();
  if (mine !== generation) {await made.dispose(); return;}
  current = made;
});
afterEach(async () => {
  generation++;
  const h = current;
  current = undefined;
  try {
    await h?.end();
  } finally {
    // Spies first: restoring a setTimeout spy after the real timers return would put this case's fake clock back.
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
  if (h) expect(await h.dispose()).toEqual([]);
}, TEARDOWN_TIMEOUT_MS);

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
const dll = (root: string) => path.join(root, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll');
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);
const target = (id: string, state: string, overrides: Record<string, unknown> = {}) => ({id, source: id.split(':')[1], ordinal: Number(id.split(':')[2]), state,
  reason: null, installed: state === 'installed' ? BUNDLED_VIEW : null, lastFailure: null, ...overrides});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}

describe('launch run', () => {
  it('starts 2 s after start on an unreferenced timer that startup never awaits, and installs into both games', async () => {
    const h = harness();
    const setTimeoutSpy = h.spyOnSetTimeout();
    const setup = h.create();
    expect(setup.start()).toBeUndefined();
    const timer = setTimeoutSpy.mock.results.at(-1)!.value as {hasRef(): boolean};
    expect(setTimeoutSpy.mock.lastCall?.[1]).toBe(LAUNCH_DELAY_MS);
    expect(timer.hasRef()).toBe(false);
    expect(setup.idle()).toBeUndefined();
    await h.advance(LAUNCH_DELAY_MS - 1);
    expect(setup.idle()).toBeUndefined();
    expect(h.lister).not.toHaveBeenCalled();
    await h.advance(1);
    expect(setup.idle()).toBeDefined();
    expect(setup.view().running).toBe(true);
    await settled(setup);
    h.restoreSpies();
    expect(setup.view()).toEqual({mode: 'test-root', bundled: BUNDLED_VIEW, running: false, games: {
      ets2: {excluded: false, discovery: 'found', manualFolder: 'none', targets: [target('ets2:steam:0', 'installed')], unlistedFolders: 0},
      ats: {excluded: false, discovery: 'found', manualFolder: 'none', targets: [target('ats:steam:0', 'installed')], unlistedFolders: 0}
    }});
    expect(await fsp.readFile(dll(h.ets2Root))).toEqual(BUNDLE);
    expect(await fsp.readFile(dll(h.atsRoot))).toEqual(BUNDLE);
    // The test-root mode never reads the Steam registry; its install registry lies inside the root.
    expect(h.readSteamRoot).not.toHaveBeenCalled();
    expect(await exists(path.join(h.registryDirectory(), 'setup.json'))).toBe(true);
    // Nothing waits: no poll and no further run.
    expect(vi.getTimerCount()).toBe(0);
    expect(h.runs()).toBe(1);
  });

  it('starts only once, and not at all after the exit began before the launch delay', async () => {
    const h = harness();
    const setup = h.create();
    setup.start(); setup.start();
    expect(vi.getTimerCount()).toBe(1);
    setup.abort();
    expect(vi.getTimerCount()).toBe(0);
    await h.advance(LAUNCH_DELAY_MS * 2);
    expect(h.lister).not.toHaveBeenCalled();
    expect(await exists(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    await expect(setup.retry()).rejects.toThrow(PluginSetupError);
  });
});

describe('single flight', () => {
  it('coalesces every trigger during a run into one follow-up run', async () => {
    const h = harness();
    const gate = deferred<void>();
    let calls = 0;
    h.lister.mockImplementation(async () => {if (calls++ === 0) await gate.promise; return {ok: true, running: {...h.running}};});
    const setup = h.create();
    const first = setup.retry();
    await until(() => h.lister.mock.calls.length === 1);
    // A folder seen for the first time is `working` until its first result.
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'working')]);
    const second = setup.retry(), third = setup.retry();
    const excluded = setup.setExcluded('ats', true);
    gate.resolve();
    await Promise.all([first, second, third, excluded]);
    await settled(setup);
    expect(h.runs()).toBe(2);
    expect(setup.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'excluded')]});
    expect(await exists(dll(h.atsRoot))).toBe(false);
  });
});

describe('polling', () => {
  it('polls the running games every 15 s only while a folder waits for its game, then installs', async () => {
    const h = harness();
    h.running = {...NOT_RUNNING, ets2: true};
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'missing', {reason: 'GAME_RUNNING'})]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'installed')]);
    expect(vi.getTimerCount()).toBe(1);
    const before = h.lister.mock.calls.length;
    await h.advance(POLL_INTERVAL_MS - 1);
    expect(h.lister.mock.calls.length).toBe(before);
    await h.advance(1);
    expect(h.lister.mock.calls.length).toBe(before + 1);
    await h.advance(POLL_INTERVAL_MS);
    expect(h.lister.mock.calls.length).toBe(before + 2);
    expect(h.runs()).toBe(1);
    h.running = {...NOT_RUNNING};
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(h.runs()).toBe(2);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    const after = h.lister.mock.calls.length;
    expect(vi.getTimerCount()).toBe(0);
    await h.advance(POLL_INTERVAL_MS * 4);
    expect(h.lister.mock.calls.length).toBe(after);
  });

  it('waits for the TruckersMP client too, and does not poll for a folder it cannot change', async () => {
    const h = harness();
    h.running = {...NOT_RUNNING, client: true};
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'missing', reason: 'CLIENT_RUNNING'});
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'missing', reason: 'CLIENT_RUNNING'});
    h.running = {...NOT_RUNNING};
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'installed'});

    // An unrecognized file waits for the driver, not for a process: no poll.
    const foreign = path.join(h.guard.root, 'Foreign');
    await h.steam.gameFolder(foreign, 'ets2', {plugins: true});
    await fsp.writeFile(dll(foreign), 'someone else');
    const other = h.create();
    await other.chooseFolder('ets2', foreign);
    await settled(other);
    expect(other.view().games.ets2.targets.find(entry => entry.id === 'ets2:manual:0')).toMatchObject({state: 'blocked', reason: 'UNRECOGNIZED_FILE',
      lastFailure: 'UNRECOGNIZED_FILE'});
    other.abort(); setup.abort();
    expect(await fsp.readFile(dll(foreign), 'utf8')).toBe('someone else');
  });

  it('retries a locked file at most three times while the running games stay the same, and again when they change', async () => {
    const h = harness();
    let locked = true;
    const base = h.fs;
    h.fs = {...base, rename: (from, to) => locked && to === dll(h.ets2Root) ? Promise.reject(Object.assign(new Error('EPERM: simulated'), {code: 'EPERM'})) : base.rename(from, to)};
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'missing', reason: 'TARGET_LOCKED', lastFailure: 'TARGET_LOCKED'});
    for (let retry = 1; retry <= MAX_LOCKED_RETRIES; retry++) {
      await h.advance(POLL_INTERVAL_MS);
      await settled(setup);
      expect(h.runs()).toBe(1 + retry);
    }
    await h.advance(POLL_INTERVAL_MS * 3);
    await settled(setup);
    expect(h.runs()).toBe(1 + MAX_LOCKED_RETRIES);
    expect(vi.getTimerCount()).toBe(1);
    // The holder may have been a process that just exited: a change of the running games tries again.
    locked = false;
    h.running = {...NOT_RUNNING, ats: true};
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'installed', lastFailure: null});
    setup.abort();
  });
});

describe('abort', () => {
  it('aborts a run after 30 s and changes nothing more', async () => {
    const h = harness();
    h.lister.mockImplementation(signal => new Promise(resolve => signal?.addEventListener('abort', () => resolve({ok: false, code: 'RUNNING_CHECK_FAILED'}))));
    const setup = h.create();
    setup.start();
    await h.advance(LAUNCH_DELAY_MS);
    await until(() => h.lister.mock.calls.length === 1);
    await h.advance(RUN_TIMEOUT_MS - 1);
    expect(setup.idle()).toBeDefined();
    expect(h.logged('PLUGIN_SETUP_TIMEOUT')).toEqual([]);
    await h.advance(1);
    await settled(setup);
    expect(h.logged('PLUGIN_SETUP_TIMEOUT')).toEqual([{event: 'PLUGIN_SETUP_TIMEOUT', facts: {timeoutMs: 30_000}}]);
    expect(setup.view().running).toBe(false);
    // The run stopped after the first folder: the second game was never touched.
    expect(h.lister).toHaveBeenCalledTimes(1);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'blocked', reason: 'RUNNING_CHECK_FAILED'});
    expect(setup.view().games.ats.targets[0]).toMatchObject({state: 'working'});
    // Both the failed listing and the folder the run never reached are retried by the poll once a listing succeeds.
    expect(vi.getTimerCount()).toBe(1);
    expect(await exists(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(await exists(path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
  });

  it('on exit stops after the current folder, and idle settles only after its temporary file is removed', async () => {
    const h = harness();
    const renaming = deferred<void>(), release = deferred<void>();
    const base = h.fs;
    h.fs = {...base, rename: async (from, to) => {
      if (to === dll(h.ets2Root)) {renaming.resolve(); await release.promise; throw Object.assign(new Error('EPERM: simulated'), {code: 'EPERM'});}
      return base.rename(from, to);
    }};
    const setup = h.create();
    setup.start();
    await h.advance(LAUNCH_DELAY_MS);
    await renaming.promise;
    const plugins = path.join(h.ets2Root, 'bin', 'win_x64', 'plugins');
    expect(await fsp.readdir(plugins)).toEqual(['ets2telemetry-plugin.dll.0123456789abcdef.tmp']);
    setup.abort();
    const idle = setup.idle();
    expect(idle).toBeDefined();
    let done = false;
    void idle!.then(() => {done = true;});
    await h.advance(0);
    expect(done).toBe(false);
    await expect(setup.retry()).rejects.toThrow('Plugin setup has stopped');
    await expect(setup.setExcluded('ets2', true)).rejects.toThrow('Plugin setup has stopped');
    release.resolve();
    await idle;
    // The interrupted folder keeps no temporary file and no DLL; the next game's folder was never touched.
    expect(await exists(plugins)).toBe(false);
    expect(await exists(path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(setup.idle()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('logs', () => {
  it('logs the mode once and discovery, actions and the bundle only when they change', async () => {
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    await setup.retry();
    await setup.retry();
    expect(h.logged('PLUGIN_SETUP_MODE')).toEqual([{event: 'PLUGIN_SETUP_MODE', facts: {mode: 'test-root', reason: null}}]);
    expect(h.logged('PLUGIN_DISCOVERY')).toHaveLength(1);
    expect(h.logged('PLUGIN_DISCOVERY')[0].facts).toMatchObject({steam: 'found', libraries: 2, ets2: 'found', ats: 'found'});
    expect(h.logged('PLUGIN_BUNDLE')).toEqual([{event: 'PLUGIN_BUNDLE', facts: {state: 'verified'}}]);
    expect(h.logged('PLUGIN_ACTION').map(entry => entry.facts)).toEqual([
      {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null},
      {game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null},
      {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', code: null, step: null, errno: null},
      {game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'unchanged', code: null, step: null, errno: null}
    ]);
    h.running = {...NOT_RUNNING, ats: true};
    await setup.retry();
    expect(h.logged('PLUGIN_ACTION').at(-1)!.facts).toEqual({game: 'ats', source: 'steam', ordinal: 0, op: 'install', outcome: 'blocked', code: 'GAME_RUNNING', step: 'process', errno: null});
    expect(h.logged('PLUGIN_ACTION')).toHaveLength(5);
    setup.abort();
  });

  it('logs a rejected test root and the disabled mode, and the disabled mode does nothing at all', async () => {
    const h = harness();
    const setup = new PluginSetup({decision: {mode: 'disabled', reason: 'root-rejected', rejected: 'no-profile'},
      log: (event, _detail, facts) => h.events.push({event, facts}), changed: () => h.views.push(setup.view())});
    setup.start();
    expect(vi.getTimerCount()).toBe(0);
    const view = await setup.retry();
    expect(view).toEqual({mode: 'disabled', bundled: null, running: false, games: {
      ets2: {excluded: false, discovery: 'pending', manualFolder: 'none', targets: [], unlistedFolders: 0}, ats: {excluded: false, discovery: 'pending', manualFolder: 'none', targets: [], unlistedFolders: 0}}});
    expect(await setup.setExcluded('ets2', true)).toEqual(view);
    expect(await setup.chooseFolder('ets2', h.ets2Root)).toEqual({outcome: 'refused', code: 'SETUP_DISABLED'});
    expect(await setup.folderToOpen('ets2:steam:0')).toBeUndefined();
    expect(await setup.bundledFile()).toBeUndefined();
    expect(setup.idle()).toBeUndefined();
    await h.advance(LAUNCH_DELAY_MS + POLL_INTERVAL_MS);
    expect(h.events).toEqual([
      {event: 'PLUGIN_SETUP_MODE_REJECTED', facts: {reason: 'no-profile'}},
      {event: 'PLUGIN_SETUP_MODE', facts: {mode: 'disabled', reason: 'root-rejected'}}
    ]);
    expect(h.views).toEqual([]);
    expect(await exists(h.registryDirectory())).toBe(false);
    expect(await exists(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
  });
});

describe('test root', () => {
  it('ignores a library and a junction outside the root without touching them, and logs the escape', async () => {
    const h = harness();
    h.outside = await guardedTempRoot('ets2telemetry-plugin-outside-');
    const elsewhere = await fakeSteam(h.outside.root);
    const outsideLibrary = await elsewhere.library('OutsideLibrary');
    const outsideEts2 = await elsewhere.install(outsideLibrary, 'ets2');
    const junction = path.join(h.guard.root, 'JunctionLibrary');
    await fsp.symlink(outsideLibrary, junction, 'junction');
    await h.steam.libraryFolders([h.steam.steam, outsideLibrary, junction, path.join(h.guard.root, 'LibraryB')]);
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(await exists(path.join(outsideEts2, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(h.logged('PLUGIN_TEST_ROOT_ESCAPE').length).toBeGreaterThan(0);
    expect(h.logged('PLUGIN_DISCOVERY')[0].facts).toMatchObject({libraries: 2, missingLibraries: 2});
    // A folder chosen outside the root is refused before any file access and nothing is stored.
    const before = await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'));
    const escapes = h.logged('PLUGIN_TEST_ROOT_ESCAPE').length;
    expect(await setup.chooseFolder('ets2', outsideEts2)).toEqual({outcome: 'refused', code: 'FOLDER_UNSUPPORTED_PATH'});
    expect(h.logged('PLUGIN_TEST_ROOT_ESCAPE')).toHaveLength(escapes + 1);
    expect(await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'))).toEqual(before);
    // The junction inside the root that points outside is refused the same way.
    expect(await setup.chooseFolder('ets2', path.join(junction, 'steamapps', 'common', 'Euro Truck Simulator 2'))).toEqual({outcome: 'refused', code: 'FOLDER_NOT_GAME'});
    expect(h.readSteamRoot).not.toHaveBeenCalled();
    setup.abort();
  });
});

describe('view', () => {
  it('never carries a path, in the view or in a log line', async () => {
    const h = harness();
    const manual = await h.steam.gameFolder(path.join(h.guard.root, 'Manual ETS2'), 'ets2');
    const setup = h.create();
    await h.launch(setup);
    expect(await setup.chooseFolder('ets2', path.join(manual, 'bin', 'win_x64'))).toEqual({outcome: 'chosen'});
    await settled(setup);
    h.running = {...NOT_RUNNING, ats: true};
    await setup.setExcluded('ats', true);
    const text = JSON.stringify([setup.view(), ...h.views, h.events]);
    expect(text.toLowerCase()).not.toContain(h.guard.root.toLowerCase().replaceAll('\\', '\\\\'));
    expect(text).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\/);
    expect(setup.view().games.ets2.targets.map(entry => entry.id)).toEqual(['ets2:steam:0', 'ets2:manual:0']);
    expect(setup.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'blocked', {reason: 'GAME_RUNNING', installed: BUNDLED_VIEW})]});
    setup.abort();
  });
});

describe('triggers', () => {
  it('stores a chosen folder by its canonical root and installs into it; a wrong game writes nothing', async () => {
    const h = harness();
    const manual = await h.steam.gameFolder(path.join(h.guard.root, 'Manual ETS2'), 'ets2');
    const setup = h.create();
    await h.launch(setup);
    const before = await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'));
    expect(await setup.chooseFolder('ats', manual)).toEqual({outcome: 'refused', code: 'FOLDER_WRONG_GAME'});
    expect(await setup.chooseFolder('ets2', h.ets2Root)).toEqual({outcome: 'refused', code: 'FOLDER_DUPLICATE'});
    expect(await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'))).toEqual(before);
    expect(await setup.chooseFolder('ets2', path.join(manual, 'BIN', 'win_x64', 'plugins'))).toEqual({outcome: 'chosen'});
    await settled(setup);
    const stored = JSON.parse(await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'), 'utf8')) as {games: {ets2: {manualRoot: string}}};
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
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    expect(await setup.setExcluded('ats', true)).toMatchObject({games: {ats: {excluded: true, targets: [target('ats:steam:0', 'excluded')]}}});
    expect(await exists(dll(h.atsRoot))).toBe(false);
    // The plugins folder this application created is removed with the plugin.
    expect(await exists(path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'))).toBe(false);
    // A restart reads the exclusion from the registry.
    const restarted = h.create();
    await h.launch(restarted);
    expect(restarted.view().games.ats).toMatchObject({excluded: true, targets: [target('ats:steam:0', 'excluded')]});
    expect(await restarted.setExcluded('ats', false)).toMatchObject({games: {ats: {excluded: false, targets: [target('ats:steam:0', 'installed')]}}});
    expect(await fsp.readFile(dll(h.atsRoot))).toEqual(BUNDLE);
    setup.abort(); restarted.abort();
  });

  it('opens the plugins folder of a listed folder, bin\\win_x64 when it is absent, and nothing for an unknown or linked folder', async () => {
    const h = harness();
    h.running = {...NOT_RUNNING, ats: true};
    const setup = h.create();
    await h.launch(setup);
    expect(await setup.folderToOpen('ets2:steam:0')).toBe(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'));
    expect(await setup.folderToOpen('ats:steam:0')).toBe(path.join(h.atsRoot, 'bin', 'win_x64'));
    expect(await setup.folderToOpen('ats:manual:0')).toBeUndefined();
    expect(await setup.folderToOpen('ets2:steam:3')).toBeUndefined();
    const moved = path.join(h.guard.root, 'Moved');
    await fsp.mkdir(moved);
    await fsp.symlink(moved, path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'), 'junction');
    expect(await setup.folderToOpen('ats:steam:0')).toBeUndefined();
    setup.abort();
  });

  it('opens a plain plugins folder that holds an unexpected entry, and bin\\win_x64 when plugins is a file', async () => {
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    // A folder with the plugin's name: the layout is unexpected, but the plugins folder itself is a plain folder.
    await fsp.rm(dll(h.ets2Root));
    await fsp.mkdir(dll(h.ets2Root));
    expect(await setup.folderToOpen('ets2:steam:0')).toBe(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'));
    // A file in place of the plugins folder.
    await fsp.rm(path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'), {recursive: true});
    await fsp.writeFile(path.join(h.atsRoot, 'bin', 'win_x64', 'plugins'), 'not a folder');
    expect(await setup.folderToOpen('ats:steam:0')).toBe(path.join(h.atsRoot, 'bin', 'win_x64'));
    setup.abort();
  });

  it('reveals the bundled file only while it is still a plain file, checked right before', async () => {
    const h = harness();
    const setup = h.create();
    const file = path.join(h.guard.root, 'bundle', 'ets2telemetry-plugin.dll');
    expect(await setup.bundledFile()).toBeUndefined();
    await h.launch(setup);
    // Verified once, but the file is gone now.
    expect(await setup.bundledFile()).toBeUndefined();
    await fsp.mkdir(path.dirname(file));
    await fsp.writeFile(file, BUNDLE);
    expect(await setup.bundledFile()).toBe(file);
    await fsp.rm(file);
    const elsewhere = path.join(h.guard.root, 'elsewhere');
    await fsp.mkdir(elsewhere);
    await fsp.symlink(elsewhere, file, 'junction');
    expect(await setup.bundledFile()).toBeUndefined();
    await fsp.rm(file);
    await fsp.writeFile(file, BUNDLE);
    setup.abort();
    expect(await setup.bundledFile()).toBeUndefined();
  });
});

describe('failures', () => {
  it('reports an unavailable bundle on every folder without writing, and reads it again on the next run', async () => {
    const h = harness();
    h.bundleResult = {ok: false, code: 'BUNDLE_UNAVAILABLE', failure: 'plugin-hash'};
    const readBundle = vi.fn(() => Promise.resolve(h.bundleResult));
    const setup = h.create({readBundle});
    await h.launch(setup);
    expect(setup.view()).toMatchObject({bundled: null, games: {ets2: {targets: [target('ets2:steam:0', 'blocked', {reason: 'BUNDLE_UNAVAILABLE'})]},
      ats: {targets: [target('ats:steam:0', 'blocked', {reason: 'BUNDLE_UNAVAILABLE'})]}}});
    expect(await exists(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(h.logged('PLUGIN_BUNDLE')).toEqual([{event: 'PLUGIN_BUNDLE', facts: {state: 'unavailable', failure: 'plugin-hash'}}]);
    h.bundleResult = {ok: true, bundle: {bytes: BUNDLE, sha256: SHA, appVersion: '0.2.0', known: [], file: path.join(h.guard.root, 'bundle', 'ets2telemetry-plugin.dll')}};
    await setup.retry();
    await setup.retry();
    expect(readBundle).toHaveBeenCalledTimes(2);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    setup.abort();
  });

  it('treats a recovery reason as information: other folders still install', async () => {
    const h = harness();
    // An interrupted install into a folder whose `bin` became a junction stays pending with LINKED_FOLDER.
    const linkedRoot = path.join(h.guard.root, 'Linked ETS2');
    const real = await h.steam.gameFolder(path.join(h.guard.root, 'Real bin'), 'ets2');
    await fsp.mkdir(linkedRoot);
    await fsp.symlink(path.join(real, 'bin'), path.join(linkedRoot, 'bin'), 'junction');
    await fsp.mkdir(h.registryDirectory(), {recursive: true});
    const temp = path.join(linkedRoot, 'bin', 'win_x64', 'plugins', 'ets2telemetry-plugin.dll.00000000000000aa.tmp');
    await fsp.writeFile(path.join(h.registryDirectory(), 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 1,
      games: {ets2: {excluded: false, manualRoot: null}, ats: {excluded: false, manualRoot: null}}, installs: [],
      pending: [{op: 'install', game: 'ets2', root: linkedRoot, source: 'manual', temp, fromSha256: null, toSha256: SHA, appVersion: '0.2.0',
        createdPluginsDirectory: true, startedUtc: UTC}], failures: []}, null, 2) + '\n');
    const setup = h.create();
    await h.launch(setup);
    expect(h.logged('PLUGIN_RECOVERY_PENDING').map(entry => entry.facts)).toEqual([{remaining: 1, reason: 'LINKED_FOLDER'}]);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'installed')]);
    setup.abort();
  });

  it('refuses an exclusion change that cannot be stored, without a run', async () => {
    const h = harness();
    await fsp.mkdir(h.registryDirectory(), {recursive: true});
    await fsp.writeFile(path.join(h.registryDirectory(), 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 2}));
    const setup = h.create();
    await expect(setup.setExcluded('ets2', true)).rejects.toThrow('Plugin setup could not be saved');
    expect(await setup.chooseFolder('ets2', h.ets2Root)).toEqual({outcome: 'refused', code: 'REGISTRY_UNAVAILABLE'});
    expect(h.runs()).toBe(0);
    expect(h.logged('PLUGIN_REGISTRY_STATE')).toEqual([{event: 'PLUGIN_REGISTRY_STATE', facts: {state: 'newer-version'}}]);
    setup.abort();
  });
});

// PR-4 review round 1 (October 17, 2026): the findings' regression cases.
describe('review round 1', () => {
  it('does not poll for a folder that already holds the current plugin while its game runs, but polls for a pending update', async () => {
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    h.running = {...NOT_RUNNING, ets2: true};
    await setup.retry();
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(h.logged('PLUGIN_ACTION').at(-2)!.facts).toMatchObject({game: 'ets2', outcome: 'blocked', code: 'GAME_RUNNING'});
    expect(vi.getTimerCount()).toBe(0);
    setup.abort();

    // An older plugin of this application (a released hash) waits for its running game: outdated, and polled.
    const OLD = Buffer.from('released plugin 0.1.0 '.repeat(200));
    const oldSha = createHash('sha256').update(OLD).digest('hex');
    h.bundleResult = {ok: true, bundle: {bytes: BUNDLE, sha256: SHA, appVersion: '0.2.0', known: [{appVersion: '0.1.0', sha256: oldSha}],
      file: path.join(h.guard.root, 'bundle', 'ets2telemetry-plugin.dll')}};
    await fsp.writeFile(dll(h.atsRoot), OLD);
    h.running = {...NOT_RUNNING, ats: true};
    const updating = h.create();
    await h.launch(updating);
    expect(updating.view().games.ats.targets).toEqual([target('ats:steam:0', 'outdated', {reason: 'GAME_RUNNING', installed: {version: '0.1.0', sha256Prefix: oldSha.slice(0, 12)}})]);
    expect(vi.getTimerCount()).toBe(1);
    updating.abort();
  });

  /** Three more Steam libraries with ETS2, so the game has four Steam roots; returns them in library order. */
  async function fourEts2Roots(h: CaseHarness): Promise<string[]> {
    const libraries = [await h.steam.library('LibraryC'), await h.steam.library('LibraryD'), await h.steam.library('LibraryE')];
    await h.steam.libraryFolders([h.steam.steam, path.join(h.guard.root, 'LibraryB'), ...libraries]);
    return [h.ets2Root, ...await Promise.all(libraries.map(library => h.steam.install(library, 'ets2')))];
  }

  it('counts and logs a Steam root that a chosen folder leaves unlisted, and never installs into it', async () => {
    const h = harness();
    const roots = await fourEts2Roots(h);
    const manual = await h.steam.gameFolder(path.join(h.guard.root, 'Manual ETS2'), 'ets2');
    const setup = h.create();
    expect(await setup.chooseFolder('ets2', manual)).toEqual({outcome: 'chosen'});
    await settled(setup);
    expect(setup.view().games.ets2).toMatchObject({unlistedFolders: 1,
      targets: [target('ets2:steam:0', 'installed'), target('ets2:steam:1', 'installed'), target('ets2:steam:2', 'installed'), target('ets2:manual:0', 'installed')]});
    expect(setup.view().games.ats.unlistedFolders).toBe(0);
    expect(h.logged('PLUGIN_TARGETS_LIMITED')).toEqual([{event: 'PLUGIN_TARGETS_LIMITED', facts: {game: 'ets2', count: 1}}]);
    expect(await exists(path.join(roots[3], 'bin', 'win_x64', 'plugins'))).toBe(false);
    await setup.retry();
    expect(h.logged('PLUGIN_TARGETS_LIMITED')).toHaveLength(1);
    expect(JSON.stringify(setup.view())).not.toContain('Library');
    setup.abort();
  });

  it('removes the plugin from an unlisted Steam root with an install record when the game is excluded', async () => {
    const h = harness();
    const roots = await fourEts2Roots(h);
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets.map(entry => entry.state)).toEqual(['installed', 'installed', 'installed', 'installed']);
    const manual = await h.steam.gameFolder(path.join(h.guard.root, 'Manual ETS2'), 'ets2');
    expect(await setup.chooseFolder('ets2', manual)).toEqual({outcome: 'chosen'});
    await settled(setup);
    expect(setup.view().games.ets2.unlistedFolders).toBe(1);
    // Unlisted, but still holding the plugin this application installed there.
    expect(await fsp.readFile(dll(roots[3]))).toEqual(BUNDLE);
    await setup.setExcluded('ets2', true);
    for (const root of [...roots, manual]) expect(await exists(dll(root)), root).toBe(false);
    expect(h.logged('PLUGIN_ACTION').map(entry => entry.facts)).toContainEqual({game: 'ets2', source: 'steam', ordinal: 3, listed: false, op: 'remove',
      outcome: 'removed', code: null, step: null, errno: null});
    setup.abort();
  });

  it('turns the test-root mode off when the root has no marker file, before reading or writing anything', async () => {
    const h = harness();
    await fsp.rm(path.join(h.guard.root, TEST_ROOT_MARKER));
    await fsp.mkdir(path.join(h.guard.root, TEST_ROOT_MARKER));
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().mode).toBe('disabled');
    expect(setup.mode).toBe('disabled');
    expect(h.events.slice(1)).toEqual([
      {event: 'PLUGIN_SETUP_MODE_REJECTED', facts: {reason: 'no-marker'}},
      {event: 'PLUGIN_SETUP_MODE', facts: {mode: 'disabled', reason: 'root-rejected'}}
    ]);
    expect(await setup.chooseFolder('ets2', h.ets2Root)).toEqual({outcome: 'refused', code: 'SETUP_DISABLED'});
    expect((await setup.setExcluded('ets2', true)).games.ets2.excluded).toBe(false);
    expect((await setup.retry()).mode).toBe('disabled');
    expect(h.lister).not.toHaveBeenCalled();
    expect(await exists(path.join(h.guard.root, 'LocalAppData'))).toBe(false);
    expect(await exists(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('confines the install registry writes to the test root too', async () => {
    const h = harness();
    h.outside = await guardedTempRoot('ets2telemetry-plugin-outside-');
    await fsp.symlink(h.outside.root, path.join(h.guard.root, 'LocalAppData'), 'junction');
    const setup = h.create();
    await h.launch(setup);
    expect(await fsp.readdir(h.outside.root)).toEqual([]);
    expect(h.logged('PLUGIN_TEST_ROOT_ESCAPE').length).toBeGreaterThan(0);
    expect(setup.view().games.ets2.targets[0]).toMatchObject({state: 'missing', reason: 'REGISTRY_UNAVAILABLE'});
    expect(await exists(dll(h.ets2Root))).toBe(false);
    setup.abort();
  });

  it('makes the exit wait for an exclusion\'s registry write and writes nothing after it began', async () => {
    const h = harness();
    let holding = false;
    const renaming = deferred<void>(), release = deferred<void>();
    const registryFs = {...h.guard.fs, rename: async (from: string, to: string) => {
      if (holding) {renaming.resolve(); await release.promise;}
      return h.guard.fs.rename(from, to);
    }} as PluginSetupPorts['registryFs'];
    const setup = h.create({registryFs});
    await h.launch(setup);
    holding = true;
    const excluding = setup.setExcluded('ats', true);
    await renaming.promise;
    setup.abort();
    const idle = setup.idle();
    expect(idle).toBeDefined();
    let done = false;
    void idle!.then(() => {done = true;});
    await tick(); await tick();
    expect(done).toBe(false);
    release.resolve();
    await idle;
    await excluding;
    // The exclusion was stored, but no run started after the exit began: the plugin stays until the next start.
    const stored = JSON.parse(await fsp.readFile(path.join(h.registryDirectory(), 'setup.json'), 'utf8')) as {games: {ats: {excluded: boolean}}};
    expect(stored.games.ats.excluded).toBe(true);
    expect(await exists(dll(h.atsRoot))).toBe(true);
    expect(setup.idle()).toBeUndefined();
  });

  it('stores no chosen folder when the exit begins while it is validated', async () => {
    const h = harness();
    const manual = await h.steam.gameFolder(path.join(h.guard.root, 'Manual ETS2'), 'ets2');
    let setup!: PluginSetup;
    const base = h.fs;
    h.fs = {...base, realpath: async target => {
      if (target.toLowerCase().includes('manual ets2')) setup.abort();
      return base.realpath(target);
    }};
    setup = h.create();
    await expect(setup.chooseFolder('ets2', manual)).rejects.toThrow('Plugin setup has stopped');
    expect(await exists(path.join(h.registryDirectory(), 'setup.json'))).toBe(false);
  });
});

// The tasklist bound fix (October 17, 2026): a failed running-game listing must not leave the plugin uninstalled for the
// whole session. The poll retries such a folder once its own listing succeeds, and only then.
describe('failed listing', () => {
  it('retries a folder whose running check failed once the poll lists the running games again, and then stops polling', async () => {
    const h = harness();
    let failing = true;
    h.lister.mockImplementation(() => Promise.resolve(failing ? {ok: false, code: 'RUNNING_CHECK_FAILED'} : {ok: true, running: {...h.running}}));
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'missing', {reason: 'RUNNING_CHECK_FAILED'})]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'missing', {reason: 'RUNNING_CHECK_FAILED'})]);
    expect(vi.getTimerCount()).toBe(1);
    // The poll's own listing still fails: no run, the poll goes on.
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(h.runs()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    failing = false;
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(h.runs()).toBe(2);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'installed')]);
    expect(vi.getTimerCount()).toBe(0);
    setup.abort();
  });
});

describe('unfinished run', () => {
  it('retries a run that hit its 30 s limit before it reached any folder', async () => {
    const h = harness();
    let hold = true;
    const readBundle = vi.fn((signal: AbortSignal) => hold
      ? new Promise<PluginBundleResult>(resolve => signal.addEventListener('abort', () => resolve({ok: false, code: 'BUNDLE_UNAVAILABLE', failure: 'aborted'})))
      : Promise.resolve(h.bundleResult));
    const setup = h.create({readBundle});
    setup.start();
    await h.advance(LAUNCH_DELAY_MS);
    await until(() => readBundle.mock.calls.length === 1);
    await h.advance(RUN_TIMEOUT_MS);
    await settled(setup);
    expect(h.logged('PLUGIN_SETUP_TIMEOUT')).toHaveLength(1);
    expect(setup.view().games.ets2.targets).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    hold = false;
    await h.advance(POLL_INTERVAL_MS);
    await settled(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed')]);
    expect(vi.getTimerCount()).toBe(0);
    setup.abort();
  });
});

// ET-017 PR-6 (PR-4 review nit): a current plugin whose install record cannot be written shows REGISTRY_UNAVAILABLE in the
// view, not only in the log, and still arms no poll.
describe('an unsaved install record', () => {
  it('keeps REGISTRY_UNAVAILABLE on a folder that holds the current plugin while the registry is read-only', async () => {
    const h = harness();
    await fsp.mkdir(path.join(h.ets2Root, 'bin', 'win_x64', 'plugins'), {recursive: true});
    await fsp.writeFile(dll(h.ets2Root), BUNDLE);
    await fsp.mkdir(h.registryDirectory(), {recursive: true});
    await fsp.writeFile(path.join(h.registryDirectory(), 'setup.json'), JSON.stringify({format: 'ets2telemetry.plugin-setup', version: 2}));
    const setup = h.create();
    await h.launch(setup);
    expect(setup.view().games.ets2.targets).toEqual([target('ets2:steam:0', 'installed', {reason: 'REGISTRY_UNAVAILABLE'})]);
    expect(setup.view().games.ats.targets).toEqual([target('ats:steam:0', 'missing', {reason: 'REGISTRY_UNAVAILABLE'})]);
    expect(await exists(dll(h.atsRoot))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    setup.abort();
  });
});

// ET-018 PR-4 (U8 step 5): the in-app uninstall pauses setup while it removes the plugin, and lifts the pause after a
// removal that raced, so setup installs the plugin again.
describe('suspend and resume', () => {
  it('suspend waits for the run in flight, then nothing runs or writes until resume, which runs with a fresh registry', async () => {
    const h = harness();
    const gate = deferred<void>();
    let calls = 0;
    h.lister.mockImplementation(async () => {if (calls++ === 0) await gate.promise; return {ok: true, running: {...h.running}};});
    const setup = h.create();
    setup.start();
    await h.advance(LAUNCH_DELAY_MS);
    await until(() => calls === 1);
    let suspended = false;
    const suspending = setup.suspend().then(() => {suspended = true;});
    await tick();
    expect(suspended).toBe(false);
    gate.resolve();
    await suspending;
    expect(setup.idle()).toBeUndefined();
    // The aborted run stopped after its current folder; from now on nothing runs and every request is refused.
    const callsWhenSuspended = calls;
    await expect(setup.retry()).resolves.toBeDefined();
    expect(setup.idle()).toBeUndefined();
    await expect(setup.setExcluded('ats', true)).rejects.toThrow(PluginSetupError);
    await expect(setup.chooseFolder('ets2', h.ets2Root)).rejects.toThrow(PluginSetupError);
    await h.advance(60_000);
    expect(calls).toBe(callsWhenSuspended);
    // An uninstall changed the registry on disk meanwhile: resume reads it again and runs.
    await fsp.rm(path.join(h.registryDirectory(), 'setup.json'), {force: true});
    setup.resume();
    await settled(setup);
    expect(calls).toBeGreaterThan(callsWhenSuspended);
    expect(await fsp.readFile(dll(h.ets2Root))).toEqual(BUNDLE);
    setup.abort();
  });

  // ET-018 PR-4 review: the in-app uninstall's `interrupted` text promises that setup puts the plugin back.
  it('after an interrupted in-app uninstall, resume puts the plugin back where it was removed, while that game is closed', async () => {
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    expect(await fsp.readFile(dll(h.atsRoot))).toEqual(BUNDLE);
    await setup.suspend();
    // The uninstall's plugin removal cleaned ATS (its file and its install record), then ETS2 started and stopped it.
    await fsp.rm(dll(h.atsRoot));
    const registry = path.join(h.registryDirectory(), 'setup.json');
    const document = JSON.parse(await fsp.readFile(registry, 'utf8')) as {installs: {game: string}[]};
    await fsp.writeFile(registry, `${JSON.stringify({...document, installs: document.installs.filter(install => install.game !== 'ats')}, null, 2)}\n`);
    h.running = {...NOT_RUNNING, ets2: true};
    setup.resume();
    await settled(setup);
    expect(await fsp.readFile(dll(h.atsRoot))).toEqual(BUNDLE);
    expect(await fsp.readFile(dll(h.ets2Root))).toEqual(BUNDLE);
    setup.abort();
  });

  it('names a listed game folder by its target id, and nothing else', async () => {
    const h = harness();
    const setup = h.create();
    await h.launch(setup);
    expect(setup.targetIdFor('ets2', h.ets2Root)).toBe('ets2:steam:0');
    expect(setup.targetIdFor('ats', h.atsRoot.toUpperCase())).toBe('ats:steam:0');
    expect(setup.targetIdFor('ets2', h.atsRoot)).toBeUndefined();
    setup.abort();
  });
});
