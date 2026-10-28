import {mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {UpdateView} from '../../packages/contracts/src/app-state';
import {CHANNEL_IDENTITIES, type ReleaseChannel} from '../../apps/desktop/src/channel';
import type {FixedProgramResult} from '../../apps/desktop/src/plugin-setup/fixed-program';
import {CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, INCOMPLETE_REMOVAL_DEADLINE_MS, MANUAL_CHECK_MIN_INTERVAL_MS, reduceUpdate, UpdateController, type RunningCheck, type UpdatePorts} from '../../apps/desktop/src/updater/update-controller';
import type {UpdateContextResult} from '../../apps/desktop/src/updater/update-context';
import {DOWNLOAD_STALL_MS, type UpdateFileSystem} from '../../apps/desktop/src/updater/update-download';
import {GITHUB_ORIGINS} from '../../apps/desktop/src/updater/update-feed';
import {parseUpdateView, UNSUPPORTED_UPDATE} from '../../apps/desktop/src/updater/update-view';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {API_LIST, chunkedBody, GITHUB, listedRelease, manifestObject, packageBytes, routedFetch, signManifest, testKey, type PackageFixture, type Route} from '../shared/update-fixtures';

// ET-055 UP2, UP3, UP6–UP8 (REG-019, unit part): the update controller with fake feed, Update.exe and running-game ports,
// a fake clock (Vitest's timers) and a guarded temporary data root. Every expected state is written by hand.

const KEY = testKey('controller');
const NONE: RunningCheck = {ok: true, running: {ets2: false, ats: false, client: false}};
const EPOCH = Date.UTC(2026, 9, 28, 12, 0, 0);
let guard: GuardedRoot;
let installRoot: string, dataRoot: string;
beforeEach(async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']}); vi.setSystemTime(EPOCH);
  guard = await guardedTempRoot('ets2telemetry-update-controller-');
  installRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2TelemetryDesktop');
  dataRoot = path.win32.join(guard.root, 'LocalAppData', 'ETS2Telemetry');
});
afterEach(async () => {
  vi.useRealTimers();
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

/** Lets real file-system work and the promise chains run; Vitest fakes only setTimeout, clearTimeout and Date here. */
async function flush(rounds = 30): Promise<void> {for (let index = 0; index < rounds; index++) await new Promise(resolve => setImmediate(resolve));}
/**
 * Waits for an observable state without advancing the fake clock. Real file-system work runs on the thread pool and needs
 * many event-loop turns, so the wait is bounded by real time (performance.now is not faked), not by a turn count.
 */
async function until(predicate: () => boolean, limitMs = 10_000): Promise<void> {
  const start = performance.now();
  while (!predicate() && performance.now() - start < limitMs) await new Promise(resolve => setImmediate(resolve));
  expect(predicate()).toBe(true);
}

interface Harness {
  controller: UpdateController;
  views: UpdateView[];
  log: ReturnType<typeof vi.fn>;
  requestExit: ReturnType<typeof vi.fn>;
  runUpdate: ReturnType<typeof vi.fn<(updateExe: string, folder: string) => Promise<FixedProgramResult>>>;
  checkRunning: ReturnType<typeof vi.fn<() => Promise<RunningCheck>>>;
  fetch: ReturnType<typeof routedFetch>;
  state: {exiting: boolean; uninstalling: boolean};
  /** What the updates folder held when Update.exe ran. */
  applied: {files: string[]; releases: string}[];
}
interface Options {
  channel?: ReleaseChannel; currentVersion?: string; routes?: Record<string, Route>; context?: UpdateContextResult; fs?: UpdateFileSystem;
  apply?: (updateExe: string, folder: string) => Promise<FixedProgramResult>;
  /** The running images the R1 cleanup sees; none by default. */
  processImages?: () => Promise<readonly string[] | undefined>;
}

function harness(options: Options = {}): Harness {
  const channel = options.channel ?? 'production';
  const fetch = routedFetch(options.routes ?? {});
  const views: UpdateView[] = [], applied: Harness['applied'] = [];
  const state = {exiting: false, uninstalling: false};
  const fs: UpdateFileSystem = options.fs ?? guard.fs;
  const runUpdate = vi.fn(options.apply ?? (async (_updateExe: string, folder: string): Promise<FixedProgramResult> => {
    applied.push({files: (await readdir(folder)).sort(), releases: await readFile(path.win32.join(folder, 'RELEASES'), 'utf8')});
    return {ok: true, stdout: Buffer.alloc(0)};
  }));
  const checkRunning = vi.fn(() => Promise.resolve(NONE));
  const ports: UpdatePorts = {
    resolveContext: () => Promise.resolve(options.context ?? {ok: true, context: {installRoot, dataRoot, executableName: 'ETS2TelemetryDesktop.exe', runningDirectory: path.win32.join(installRoot, 'app-0.1.1'), origins: GITHUB_ORIGINS, keys: [KEY.publicKey], mode: 'production'}}),
    fetch, fs, runUpdate, checkRunning,
    install: {realpath: target => guard.fs.realpath(target), readFile: target => guard.fs.readFile(target), processImages: options.processImages ?? (() => Promise.resolve([]))},
    clock: {now: () => Date.now() - EPOCH, utcNow: () => Date.now(), setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)}
  };
  const log = vi.fn(), requestExit = vi.fn();
  const controller: UpdateController = new UpdateController({identity: CHANNEL_IDENTITIES[channel], currentVersion: options.currentVersion ?? (channel === 'staging' ? '0.2.0-stg.000041' : '0.1.1'),
    ports, log, requestExit, exiting: () => state.exiting, uninstalling: () => state.uninstalling,
    changed: () => {
      // Every pushed view must pass the validator main and the preload apply.
      expect(parseUpdateView(controller.view), JSON.stringify(controller.view)).toEqual(controller.view);
      views.push(controller.view);
    }});
  return {controller, views, log, requestExit, runUpdate, checkRunning, fetch, state, applied};
}
const LATEST = `${GITHUB}/releases/latest/download`;
const PACKAGE_URL = `${GITHUB}/releases/download/v0.2.0/ETS2TelemetryDesktop-0.2.0-full.nupkg`;
function productionRoutes(pkg: PackageFixture, extra: Record<string, Route> = {}, version = '0.2.0'): Record<string, Route> {
  const signed = signManifest(manifestObject('production', version, pkg, KEY.keyId), KEY);
  return {[`${LATEST}/update-manifest.json`]: {body: signed.bytes}, [`${LATEST}/update-manifest.json.sig`]: {body: signed.signature},
    [PACKAGE_URL]: {stream: () => chunkedBody(pkg.bytes)}, ...extra};
}
/** Starts the controller and runs the first scheduled check to its end. */
async function startAndCheck(h: Harness): Promise<void> {
  await started(h);
  await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS);
  await until(() => h.controller.view.lastCheck !== null);
}
/** Starts the controller and waits until the stale-download removal finished and the first check is scheduled. */
async function started(h: Harness): Promise<void> {
  h.controller.start();
  await until(() => vi.getTimerCount() > 0);
}
const PKG = packageBytes(200_000);
const AVAILABLE_CHECK = {outcome: 'available', failure: null, atUtcMs: EPOCH + FIRST_CHECK_DELAY_MS};

describe('reduceUpdate', () => {
  const available: UpdateView = {state: 'available', available: '0.2.0', progress: null, refusal: null, failure: null, lastCheck: null};
  it('applies events only in their states', () => {
    expect(reduceUpdate(UNSUPPORTED_UPDATE, {type: 'check-started'})).toBe(UNSUPPORTED_UPDATE);
    expect(reduceUpdate(UNSUPPORTED_UPDATE, {type: 'check-finished', outcome: 'available', version: '0.2.0', atUtcMs: 1})).toBe(UNSUPPORTED_UPDATE);
    expect(reduceUpdate(UNSUPPORTED_UPDATE, {type: 'supported'})).toEqual({...UNSUPPORTED_UPDATE, state: 'idle'});
    expect(reduceUpdate(available, {type: 'progress', percent: 10})).toBe(available);
    expect(reduceUpdate(available, {type: 'installing'})).toBe(available);
    expect(reduceUpdate(available, {type: 'restarting'})).toBe(available);
    const downloading = reduceUpdate(available, {type: 'download-started'});
    expect(downloading).toEqual({...available, state: 'downloading', progress: 0});
    expect(reduceUpdate(downloading, {type: 'aborted'})).toEqual(available);
    expect(reduceUpdate(downloading, {type: 'refused', code: 'BUSY'})).toBe(downloading);
  });
  it('keeps an offer the user saw across a background check of the same version, and withdraws it when nothing is newer', () => {
    const refused = reduceUpdate(available, {type: 'refused', code: 'GAME_RUNNING'});
    expect(refused).toEqual({...available, state: 'refused', refusal: 'GAME_RUNNING'});
    expect(reduceUpdate(refused, {type: 'check-finished', outcome: 'available', version: '0.2.0', atUtcMs: 5})).toEqual({...refused, lastCheck: {outcome: 'available', failure: null, atUtcMs: 5}});
    expect(reduceUpdate(refused, {type: 'check-finished', outcome: 'available', version: '0.2.1', atUtcMs: 5}))
      .toEqual({...available, available: '0.2.1', lastCheck: {outcome: 'available', failure: null, atUtcMs: 5}});
    expect(reduceUpdate(refused, {type: 'check-finished', outcome: 'failed', failure: 'OFFLINE', atUtcMs: 5})).toEqual({...refused, lastCheck: {outcome: 'failed', failure: 'OFFLINE', atUtcMs: 5}});
    expect(reduceUpdate(refused, {type: 'check-finished', outcome: 'up-to-date', atUtcMs: 5})).toEqual({...UNSUPPORTED_UPDATE, state: 'idle', lastCheck: {outcome: 'up-to-date', failure: null, atUtcMs: 5}});
  });
});

describe('support and schedule', () => {
  it('an unsupported launch never fetches, schedules or touches the data root', async () => {
    for (const reason of ['unpackaged', 'not-installed', 'isolated'] as const) {
      const h = harness({context: {ok: false, reason}});
      h.controller.start(); await flush();
      await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS * 2);
      expect(h.controller.view).toEqual(UNSUPPORTED_UPDATE); expect(h.views).toEqual([]);
      expect(h.controller.check()).toEqual(UNSUPPORTED_UPDATE);
      await expect(h.controller.apply()).resolves.toEqual(UNSUPPORTED_UPDATE);
      expect(h.fetch.requests).toEqual([]); expect(vi.getTimerCount()).toBe(0);
      expect(h.log.mock.calls).toEqual(reason === 'unpackaged' ? [] : [['UPDATE_UNSUPPORTED', {reason}]]);
    }
  });
  it('removes stale downloads at start, checks 15 s after start and then every 6 h, and downloads nothing without a click', async () => {
    await guard.fs.mkdir(path.win32.join(dataRoot, 'updates', '0.1.9'), {recursive: true});
    await guard.fs.writeFile(path.win32.join(dataRoot, 'updates', '0.1.9', 'ETS2TelemetryDesktop-0.1.9-full.nupkg.partial'), 'stale');
    const h = harness({routes: productionRoutes(PKG)});
    await started(h);
    expect(h.controller.view.state).toBe('idle');
    expect(await readdir(dataRoot)).toEqual([]);
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1); await flush();
    expect(h.fetch.requests).toEqual([]);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(h.controller.view).toEqual({state: 'available', available: '0.2.0', progress: null, refusal: null, failure: null, lastCheck: AVAILABLE_CHECK});
    expect(h.views.map(view => view.state)).toEqual(['idle', 'checking', 'available']);
    expect(h.fetch.requests.map(entry => entry.url)).toEqual([`${LATEST}/update-manifest.json`, `${LATEST}/update-manifest.json.sig`]);
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS - 1); await flush();
    expect(h.fetch.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); await flush();
    expect(h.fetch.requests).toHaveLength(4);
    // A background check of the same version keeps the offer; nothing was downloaded.
    expect(h.controller.view).toMatchObject({state: 'available', available: '0.2.0', lastCheck: {outcome: 'available', atUtcMs: EPOCH + FIRST_CHECK_DELAY_MS + CHECK_INTERVAL_MS}});
    expect(h.fetch.requests.some(entry => entry.url === PACKAGE_URL)).toBe(false);
  });
  it('keeps a failed check silent: idle with a failed last check, and the next check runs on schedule', async () => {
    const h = harness({routes: {[`${LATEST}/update-manifest.json`]: {status: 429}}});
    await startAndCheck(h);
    expect(h.controller.view).toEqual({...UNSUPPORTED_UPDATE, state: 'idle', lastCheck: {outcome: 'failed', failure: 'OFFLINE', atUtcMs: EPOCH + FIRST_CHECK_DELAY_MS}});
    expect(h.log).toHaveBeenCalledWith('UPDATE_CHECK', {origin: 'scheduled', outcome: 'failed', code: 'MANIFEST_RATE_LIMITED'});
  });
  it('runs a manual check at once, at most once per 10 s, and never while a check runs', async () => {
    const h = harness({routes: {[`${LATEST}/update-manifest.json`]: 'hang'}});
    await started(h);
    expect(h.controller.check().state).toBe('checking');
    expect(h.controller.check().state).toBe('checking');
    expect(h.fetch.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(h.controller.view).toMatchObject({state: 'idle', lastCheck: {outcome: 'failed', failure: 'OFFLINE'}});
    // The scheduled check at 15 s runs; a manual one 1 s later is within 10 s of it and does nothing.
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 10_000); expect(h.fetch.requests).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000); await flush();
    expect(h.controller.check().state).toBe('checking'); expect(h.fetch.requests).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(MANUAL_CHECK_MIN_INTERVAL_MS - 1); h.controller.check(); expect(h.fetch.requests).toHaveLength(3);
  });
  it('reads the staging list and offers the highest staging release', async () => {
    const tag = 'staging-v0.2.0-stg.000043';
    const signed = signManifest(manifestObject('staging', '0.2.0-stg.000043', PKG, KEY.keyId), KEY);
    const h = harness({channel: 'staging', routes: {[API_LIST]: {body: JSON.stringify([listedRelease('staging-v0.2.0-stg.000042'), listedRelease(tag)])},
      [`${GITHUB}/releases/download/${tag}/update-manifest.json`]: {body: signed.bytes}, [`${GITHUB}/releases/download/${tag}/update-manifest.json.sig`]: {body: signed.signature}}});
    await startAndCheck(h);
    expect(h.controller.view).toMatchObject({state: 'available', available: '0.2.0-stg.000043'});
  });
});

describe('click, download and apply', () => {
  it('downloads, verifies, writes RELEASES, applies with Update.exe, checks games again and requests the update exit', async () => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    const clicked = await h.controller.apply();
    expect(clicked).toMatchObject({state: 'downloading', progress: 0, available: '0.2.0'});
    await until(() => h.controller.view.state === 'restarting');
    expect(h.checkRunning).toHaveBeenCalledTimes(2);
    const folder = path.win32.join(dataRoot, 'updates', '0.2.0');
    expect(h.runUpdate).toHaveBeenCalledExactlyOnceWith(path.win32.join(installRoot, 'Update.exe'), folder);
    expect(h.applied).toEqual([{files: ['ETS2TelemetryDesktop-0.2.0-full.nupkg', 'RELEASES'], releases: `${PKG.sha1.toUpperCase()} ETS2TelemetryDesktop-0.2.0-full.nupkg ${PKG.bytes.length}`}]);
    // The folder is gone after the apply, and the restart target is the install root.
    expect(await readdir(dataRoot)).toEqual([]);
    expect(h.controller.restartTarget).toEqual({installRoot, executableName: 'ETS2TelemetryDesktop.exe'});
    expect(h.requestExit).toHaveBeenCalledOnce();
    const states = h.views.map(view => view.state);
    expect(states.slice(states.indexOf('downloading'))).toEqual(['downloading', ...Array<string>(states.filter(state => state === 'downloading').length - 1).fill('downloading'), 'installing', 'restarting']);
    const progress = h.views.filter(view => view.state === 'downloading').map(view => view.progress!);
    expect(progress[0]).toBe(0); expect(progress.at(-1)).toBe(100);
    for (let index = 1; index < progress.length; index++) expect(progress[index]).toBeGreaterThan(progress[index - 1]);
    expect(h.fetch.requests.filter(entry => entry.url === PACKAGE_URL)).toEqual([{url: PACKAGE_URL, kind: 'binary'}]);
  });
  it.each([
    ['ETS2', {ok: true, running: {ets2: true, ats: false, client: false}}, 'GAME_RUNNING'],
    ['ATS', {ok: true, running: {ets2: false, ats: true, client: false}}, 'GAME_RUNNING'],
    ['a TruckersMP client', {ok: true, running: {ets2: false, ats: false, client: true}}, 'GAME_RUNNING'],
    ['a failed listing', {ok: false}, 'GAME_CHECK_FAILED']
  ] as const)('refuses the click while %s runs, downloads nothing and accepts it later', async (_name, running, code) => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    h.checkRunning.mockResolvedValueOnce(running);
    expect(await h.controller.apply()).toEqual({state: 'refused', available: '0.2.0', progress: null, refusal: code, failure: null, lastCheck: AVAILABLE_CHECK});
    expect(h.fetch.requests.some(entry => entry.url === PACKAGE_URL)).toBe(false);
    expect(await h.controller.apply()).toMatchObject({state: 'downloading'});
    await until(() => h.controller.view.state === 'restarting');
  });
  it('refuses the click while exiting or uninstalling, and ignores a second click while the first is checked', async () => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    h.state.uninstalling = true;
    expect(await h.controller.apply()).toMatchObject({state: 'refused', refusal: 'BUSY'});
    h.state.uninstalling = false; h.state.exiting = true;
    expect(await h.controller.apply()).toMatchObject({state: 'refused', refusal: 'EXITING'});
    expect(h.checkRunning).not.toHaveBeenCalled();
    h.state.exiting = false;
    let release!: (value: RunningCheck) => void;
    h.checkRunning.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const first = h.controller.apply();
    expect(await h.controller.apply()).toMatchObject({state: 'refused'});
    // The exit began while the games were listed: the click is refused and nothing downloads.
    h.state.exiting = true; release(NONE);
    expect(await first).toMatchObject({state: 'refused', refusal: 'EXITING'});
    expect(h.fetch.requests.some(entry => entry.url === PACKAGE_URL)).toBe(false);
  });
  it('a game that started during the apply leaves the update ready; the restart waits until no game runs', async () => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    h.checkRunning.mockResolvedValueOnce(NONE).mockResolvedValueOnce({ok: true, running: {ets2: true, ats: false, client: false}});
    await h.controller.apply();
    await until(() => h.controller.view.state === 'ready');
    expect(h.controller.view).toEqual({state: 'ready', available: '0.2.0', progress: null, refusal: null, failure: null, lastCheck: AVAILABLE_CHECK});
    expect(h.requestExit).not.toHaveBeenCalled(); expect(h.controller.restartTarget).toBeUndefined();
    // Checks do not run once the update is applied.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); await flush();
    expect(h.fetch.requests.filter(entry => entry.url.endsWith('update-manifest.json'))).toHaveLength(1);
    h.checkRunning.mockResolvedValueOnce({ok: false});
    expect(await h.controller.apply()).toMatchObject({state: 'ready', refusal: 'GAME_CHECK_FAILED'});
    expect(await h.controller.apply()).toMatchObject({state: 'restarting', refusal: null});
    expect(h.requestExit).toHaveBeenCalledOnce(); expect(h.runUpdate).toHaveBeenCalledOnce();
  });
  it.each([
    ['a changed byte', (pkg: PackageFixture) => {const bytes = Buffer.from(pkg.bytes); bytes[1000] ^= 0xff; return bytes;}, 'HASH_MISMATCH'],
    ['a short package', (pkg: PackageFixture) => pkg.bytes.subarray(0, pkg.bytes.length - 1), 'HASH_MISMATCH'],
    ['a longer package', (pkg: PackageFixture) => Buffer.concat([pkg.bytes, Buffer.from([0])]), 'HASH_MISMATCH']
  ])('refuses %s, leaves no partial file and never runs Update.exe', async (_name, served, failure) => {
    const h = harness({routes: productionRoutes(PKG, {[PACKAGE_URL]: {stream: () => chunkedBody(served(PKG))}})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view).toMatchObject({state: 'failed', failure, available: '0.2.0', progress: null});
    expect(await readdir(dataRoot)).toEqual([]);
    expect(h.runUpdate).not.toHaveBeenCalled();
    // Retry after a failure downloads again.
    h.fetch.requests.length = 0;
    await h.controller.apply();
    await until(() => h.fetch.requests.length > 0);
    expect(h.fetch.requests.map(entry => entry.url)).toEqual([PACKAGE_URL]);
  });
  it('stops a stalled download after 60 s without data and removes its partial file', async () => {
    const h = harness({routes: productionRoutes(PKG, {[PACKAGE_URL]: {stream: () => chunkedBody(PKG.bytes, 16_384, 2)}})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.progress! > 0);
    const partial = path.win32.join(dataRoot, 'updates', '0.2.0', 'ETS2TelemetryDesktop-0.2.0-full.nupkg.partial');
    expect((await guard.fs.lstat(partial)).size).toBe(32_768);
    await vi.advanceTimersByTimeAsync(DOWNLOAD_STALL_MS - 1); await flush();
    expect(h.controller.view.state).toBe('downloading');
    await vi.advanceTimersByTimeAsync(1);
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view.failure).toBe('DOWNLOAD_FAILED');
    expect(h.log).toHaveBeenCalledWith('UPDATE_DOWNLOAD_FAILED', {code: 'STALLED'});
    expect(await readdir(dataRoot)).toEqual([]);
  });
  it('an exit during the download aborts it, removes the partial file within the exit\'s idle work and installs nothing', async () => {
    const h = harness({routes: productionRoutes(PKG, {[PACKAGE_URL]: {stream: () => chunkedBody(PKG.bytes, 16_384, 1)}})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.progress! > 0);
    h.state.exiting = true; h.controller.retire();
    const idle = h.controller.idle();
    expect(idle).toBeInstanceOf(Promise);
    await idle;
    expect(h.controller.view.state).toBe('available');
    expect(await readdir(dataRoot)).toEqual([]);
    expect(h.runUpdate).not.toHaveBeenCalled(); expect(h.requestExit).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('UPDATE_DOWNLOAD_ABORTED', {code: 'ABORTED'});
    // Retired: no further check or click.
    await vi.advanceTimersByTimeAsync(CHECK_INTERVAL_MS); expect(vi.getTimerCount()).toBe(0);
    expect(await h.controller.apply()).toMatchObject({state: 'refused', refusal: 'EXITING'});
  });
  it('an exit during the apply never interrupts Update.exe and leaves the update ready', async () => {
    let finish!: (result: FixedProgramResult) => void;
    const h = harness({routes: productionRoutes(PKG), apply: () => new Promise(resolve => {finish = resolve;})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'installing');
    h.state.exiting = true; h.controller.retire();
    expect(h.controller.idle()).toBeUndefined();
    finish({ok: true, stdout: Buffer.alloc(0)});
    await until(() => h.controller.view.state === 'ready');
    expect(h.requestExit).not.toHaveBeenCalled(); expect(h.checkRunning).toHaveBeenCalledOnce();
    expect(await readdir(dataRoot)).toEqual([]);
  });
  it.each([
    ['timeout', 'APPLY_TIMEOUT'], ['failed', 'APPLY_FAILED'], ['output-too-large', 'APPLY_FAILED']
  ] as const)('an apply that ends with %s fails as %s and removes the downloaded folder', async (failure, code) => {
    const h = harness({routes: productionRoutes(PKG), apply: () => Promise.resolve({ok: false, failure})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view).toMatchObject({state: 'failed', failure: code});
    expect(await readdir(dataRoot)).toEqual([]);
    expect(h.requestExit).not.toHaveBeenCalled();
  });
  // ET-055 risk R1 (hosted run 40710991951): a killed apply left app-<target> half written, and Squirrel's stub then
  // started it and failed. The still-running application removes that folder before it reports the failure.
  it.each([['failed', 'APPLY_FAILED'], ['timeout', 'APPLY_TIMEOUT']] as const)('removes the half-written app-<target> after an apply that ends %s, before %s is shown', async (failure, code) => {
    const target = path.win32.join(installRoot, 'app-0.2.0'), current = path.win32.join(installRoot, 'app-0.1.1');
    await mkdir(path.win32.join(current, 'resources'), {recursive: true});
    const h = harness({routes: productionRoutes(PKG), apply: async () => {
      await mkdir(path.win32.join(target, 'resources'), {recursive: true});
      await writeFile(path.win32.join(target, 'ETS2TelemetryDesktop.exe'), 'MZ, cut short');
      return {ok: false, failure};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view.failure).toBe(code);
    expect((await readdir(installRoot)).sort()).toEqual(['app-0.1.1']);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_REMOVED', {result: 'removed'});
  });
  it('keeps the new folder after an apply that succeeded', async () => {
    const target = path.win32.join(installRoot, 'app-0.2.0');
    const h = harness({routes: productionRoutes(PKG), apply: async () => {
      await mkdir(target, {recursive: true});
      return {ok: true, stdout: Buffer.alloc(0)};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.requestExit.mock.calls.length === 1);
    expect(await readdir(installRoot)).toEqual(['app-0.2.0']);
    expect(h.log).not.toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_REMOVED', expect.anything());
  });
  it('asks a held folder ten times, 500 ms apart, then reports the failure and logs it as kept', async () => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    let unlinks = 0;
    const real = guard.fs as unknown as UpdateFileSystem;
    const held: UpdateFileSystem = {...real, unlink: target_ => {
      if (String(target_).toLowerCase().startsWith(target.toLowerCase())) {unlinks++; return Promise.reject(Object.assign(new Error('busy'), {code: 'EBUSY'}));}
      return real.unlink(target_);
    }};
    const h = harness({routes: productionRoutes(PKG), fs: held, apply: async () => {
      await mkdir(target, {recursive: true});
      await writeFile(path.win32.join(target, 'ETS2TelemetryDesktop.exe'), 'MZ');
      return {ok: false, failure: 'failed'};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    for (let attempt = 1; attempt < 10; attempt++) {
      await until(() => unlinks === attempt);
      await vi.advanceTimersByTimeAsync(500);
    }
    await until(() => h.controller.view.state === 'failed');
    expect(unlinks).toBe(10);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_KEPT', {result: 'failed'});
  });
  // Review of 33d60d2f: after a timeout runFixedProgram answers at once while the killed Update.exe or the hook from the
  // folder may still run; the removal waits for them, bounded, and never removes a folder Squirrel has recorded.
  it('waits until Update.exe and the processes in the folder have ended before it removes the folder', async () => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    let listings = 0;
    const processImages = () => {
      listings++;
      return Promise.resolve(listings === 1 ? [path.win32.join(installRoot, 'Update.exe')] : listings === 2 ? [path.win32.join(target, 'ETS2TelemetryDesktop.exe')] : []);
    };
    const h = harness({routes: productionRoutes(PKG), processImages, apply: async () => {
      await mkdir(target, {recursive: true});
      return {ok: false, failure: 'timeout'};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => listings === 1);
    await vi.advanceTimersByTimeAsync(500);
    await until(() => listings === 2);
    expect((await readdir(installRoot)).sort()).toEqual(['app-0.1.1', 'app-0.2.0']);
    await vi.advanceTimersByTimeAsync(500);
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view.failure).toBe('APPLY_TIMEOUT');
    expect(await readdir(installRoot)).toEqual(['app-0.1.1']);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_REMOVED', {result: 'removed'});
  });
  // Review of ebe3395b: each attempt's process listing takes time of its own; no new attempt starts once 20 s have passed.
  it('stops asking once the 20 s deadline has passed, with slow listings, and keeps the folder with the last reason', async () => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    let listings = 0;
    // Every listing takes 6 s of the controlled clock and sees Update.exe still running.
    const processImages = () => {listings++; vi.setSystemTime(Date.now() + 6000); return Promise.resolve([path.win32.join(installRoot, 'Update.exe')]);};
    const h = harness({routes: productionRoutes(PKG), processImages, apply: async () => {
      await mkdir(target, {recursive: true});
      return {ok: false, failure: 'timeout'};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    // Attempts start at 0, 6.5 and 13 s; after the third listing 19 s have passed, so a fourth would start at 19.5 s and
    // end after the deadline: it still starts, because 19.5 s is inside it, and after it (25.5 s) nothing more does.
    for (let attempt = 1; attempt <= 3; attempt++) {
      await until(() => listings === attempt);
      await vi.advanceTimersByTimeAsync(500);
    }
    await until(() => h.controller.view.state === 'failed');
    expect(listings).toBe(4);
    expect(h.controller.view.failure).toBe('APPLY_TIMEOUT');
    expect((await readdir(installRoot)).sort()).toEqual(['app-0.1.1', 'app-0.2.0']);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_KEPT', {result: 'updater-running'});
  });
  // PR #216 review: an exit during the retries must not abandon the cleanup. It ends the wait, one more attempt starts at
  // once and is the last, and the exit's idle work includes it.
  it.each([
    ['removes the folder when the updater has ended by then', [] as string[], 'removed'],
    ['keeps the folder when the updater still runs', ['Update.exe'], 'updater-running']
  ] as const)('an exit during the cleanup retries makes one immediate last attempt that the exit waits for: %s', async (_name, second, result) => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    let listings = 0;
    const processImages = () => {
      listings++;
      return Promise.resolve(listings === 1 ? [path.win32.join(installRoot, 'Update.exe')] : second.map(name => path.win32.join(installRoot, name)));
    };
    const h = harness({routes: productionRoutes(PKG), processImages, apply: async () => {
      await mkdir(target, {recursive: true});
      return {ok: false, failure: 'timeout'};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => listings === 1);
    expect(h.controller.idle()).toBeInstanceOf(Promise);
    h.state.exiting = true; h.controller.retire();
    // No timer advance: the 500 ms wait ends at retire.
    await h.controller.idle();
    expect(listings).toBe(2);
    expect(h.controller.idle()).toBeUndefined();
    expect(h.controller.view).toMatchObject({state: 'failed', failure: 'APPLY_TIMEOUT'});
    expect((await readdir(installRoot)).sort()).toEqual(result === 'removed' ? ['app-0.1.1'] : ['app-0.1.1', 'app-0.2.0']);
    expect(h.log).toHaveBeenCalledWith(result === 'removed' ? 'UPDATE_INCOMPLETE_VERSION_REMOVED' : 'UPDATE_INCOMPLETE_VERSION_KEPT', {result});
    await vi.advanceTimersByTimeAsync(INCOMPLETE_REMOVAL_DEADLINE_MS);
    expect(listings).toBe(2);
  });
  it('an exit during an attempt in flight makes exactly one more attempt, without waiting', async () => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    let listings = 0, controller: UpdateController | undefined, state: {exiting: boolean} | undefined;
    const processImages = () => {
      listings++;
      // The exit begins while the first attempt lists the processes.
      if (listings === 1) {state!.exiting = true; controller!.retire();}
      return Promise.resolve([path.win32.join(installRoot, 'Update.exe')]);
    };
    const h = harness({routes: productionRoutes(PKG), processImages, apply: async () => {
      await mkdir(target, {recursive: true});
      return {ok: false, failure: 'timeout'};
    }});
    controller = h.controller; state = h.state;
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(listings).toBe(2);
    expect((await readdir(installRoot)).sort()).toEqual(['app-0.1.1', 'app-0.2.0']);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_KEPT', {result: 'updater-running'});
    await vi.advanceTimersByTimeAsync(INCOMPLETE_REMOVAL_DEADLINE_MS);
    expect(listings).toBe(2);
  });
  it('keeps the folder of a release Squirrel has already recorded, without asking again', async () => {
    await mkdir(path.win32.join(installRoot, 'app-0.1.1'), {recursive: true});
    const target = path.win32.join(installRoot, 'app-0.2.0');
    const processImages = vi.fn(() => Promise.resolve([] as string[]));
    const h = harness({routes: productionRoutes(PKG), processImages, apply: async () => {
      await mkdir(target, {recursive: true});
      await mkdir(path.win32.join(installRoot, 'packages'), {recursive: true});
      await writeFile(path.win32.join(installRoot, 'packages', 'RELEASES'), `${'A'.repeat(40)} ETS2TelemetryDesktop-0.2.0-full.nupkg 200000\n`);
      return {ok: false, failure: 'failed'};
    }});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect((await readdir(installRoot)).sort()).toEqual(['app-0.1.1', 'app-0.2.0', 'packages']);
    expect(h.log).toHaveBeenCalledWith('UPDATE_INCOMPLETE_VERSION_KEPT', {result: 'recorded'});
    expect(processImages).not.toHaveBeenCalled();
  });
  it('reports a full disk while writing as DISK_FULL and leaves no partial file', async () => {
    const real = guard.fs as unknown as UpdateFileSystem;
    const full: UpdateFileSystem = {...real, open: async (target, flags) => {
      const handle = await real.open(target, flags);
      return {close: () => handle.close(), write: () => Promise.reject(Object.assign(new Error('no space'), {code: 'ENOSPC'}))};
    }};
    const h = harness({routes: productionRoutes(PKG), fs: full});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.view.failure).toBe('DISK_FULL');
    expect(await readdir(dataRoot)).toEqual([]);
  });
  it('a rate-limited or unreachable package download fails quietly as OFFLINE', async () => {
    for (const route of [{status: 429}, 'network-error'] as Route[]) {
      const h = harness({routes: productionRoutes(PKG, {[PACKAGE_URL]: route})});
      await startAndCheck(h);
      await h.controller.apply();
      await until(() => h.controller.view.state === 'failed');
      expect(h.controller.view.failure).toBe('OFFLINE');
      h.controller.retire();
    }
  });
});

// ET-055 review round 1: the update and the in-app uninstall exclude each other. `busy` is what main hands the uninstall;
// `uninstalling` is re-checked after every await of the click before anything is downloaded or applied.
describe('mutual exclusion with the in-app uninstall', () => {
  it('is busy exactly while downloading, installing and restarting', async () => {
    let finish!: (result: FixedProgramResult) => void;
    const h = harness({routes: productionRoutes(PKG), apply: () => new Promise(resolve => {finish = resolve;})});
    expect(h.controller.busy).toBe(false);
    await startAndCheck(h);
    expect(h.controller.view.state).toBe('available'); expect(h.controller.busy).toBe(false);
    await h.controller.apply();
    expect(h.controller.view.state).toBe('downloading'); expect(h.controller.busy).toBe(true);
    await until(() => h.controller.view.state === 'installing');
    expect(h.controller.busy).toBe(true);
    finish({ok: true, stdout: Buffer.alloc(0)});
    await until(() => h.controller.view.state === 'restarting');
    expect(h.controller.busy).toBe(true);
  });
  it('is not busy once an apply failed, so the uninstall may run', async () => {
    const h = harness({routes: productionRoutes(PKG), apply: () => Promise.resolve({ok: false, failure: 'failed'})});
    await startAndCheck(h); await h.controller.apply();
    await until(() => h.controller.view.state === 'failed');
    expect(h.controller.busy).toBe(false);
  });
  it('refuses a click whose game check straddles the start of an uninstall, and downloads nothing', async () => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    let release!: (value: RunningCheck) => void;
    h.checkRunning.mockImplementationOnce(() => new Promise(resolve => {release = resolve;}));
    const click = h.controller.apply();
    // The uninstall starts while the games are listed; the controller is not busy yet, so the uninstall may go on.
    expect(h.controller.busy).toBe(false);
    h.state.uninstalling = true; release(NONE);
    expect(await click).toEqual({state: 'refused', available: '0.2.0', progress: null, refusal: 'BUSY', failure: null, lastCheck: AVAILABLE_CHECK});
    await flush();
    expect(h.fetch.requests.some(entry => entry.url === PACKAGE_URL)).toBe(false);
    expect(h.controller.busy).toBe(false);
  });
  it('never runs Update.exe when an uninstall started during the download, and removes the download', async () => {
    const h: Harness = harness({routes: productionRoutes(PKG, {[PACKAGE_URL]: {stream: () => new ReadableStream<Uint8Array>({start(controller) {
      controller.enqueue(PKG.bytes);
      h.state.uninstalling = true;
      controller.close();
    }})}})});
    await startAndCheck(h);
    await h.controller.apply();
    await until(() => h.controller.view.state === 'refused');
    expect(h.controller.view).toMatchObject({state: 'refused', refusal: 'BUSY', available: '0.2.0'});
    expect(h.runUpdate).not.toHaveBeenCalled(); expect(h.requestExit).not.toHaveBeenCalled();
    expect(h.log).toHaveBeenCalledWith('UPDATE_DOWNLOAD_ABORTED', {code: 'UNINSTALLING'});
    expect(await readdir(dataRoot)).toEqual([]);
  });
  it('refuses a restart from ready while an uninstall runs', async () => {
    const h = harness({routes: productionRoutes(PKG)});
    await startAndCheck(h);
    h.checkRunning.mockResolvedValueOnce(NONE).mockResolvedValueOnce({ok: false});
    await h.controller.apply();
    await until(() => h.controller.view.state === 'ready');
    // Ready is not busy: the uninstall may run, and the restart then waits.
    expect(h.controller.busy).toBe(false);
    h.state.uninstalling = true;
    expect(await h.controller.apply()).toMatchObject({state: 'ready', refusal: 'BUSY'});
    expect(h.requestExit).not.toHaveBeenCalled();
  });
});
