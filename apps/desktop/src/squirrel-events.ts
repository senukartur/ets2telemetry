import {mkdirSync} from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import {nodeExecFile, runFixedProgram} from './plugin-setup/fixed-program';
import {checkRunningGames} from './plugin-setup/game-processes';
import {pluginBundleDirectory, readPluginBundle} from './plugin-setup/plugin-bundle';
import type {RunningCheck} from './plugin-setup/plugin-installer';
import {cancelDeferral, writeDeferralReadme, type CancelFileSystem, type CancelOutcome} from './uninstall/deferral';
import {RUNNING_CHECK_BUDGET_MS, runUninstall, type UninstallCode, type UninstallFileSystem, type UninstallPorts, type UninstallResult} from './uninstall/engine';
import {resolveUninstallRoots, type UninstallRoots, type UninstallRootsRefusal} from './uninstall/roots';

// The Squirrel.Windows event handler (ET-018 U2, U6; docs/app-lifecycle.md, "Squirrel events"; docs/uninstall.md). It
// replaces electron-squirrel-startup and runs before anything else in main: before the diagnostic profile override, the
// logs, the settings, plugin setup and the telemetry service. Squirrel starts the installed executable with exactly one
// event and the package version:
//
// - `--squirrel-install` and `--squirrel-updated` create the shortcuts through `Update.exe --createShortcut` (skipped in a
//   test install unless its test file asks for them) and cancel a pending uninstall deferral. They never delete data.
// - `--squirrel-obsolete` (the previous version after an update) quits. It never deletes anything.
// - `--squirrel-uninstall` closes a running instance through the single-instance lock, then runs the uninstall engine
//   within a global 8 s deadline, inside Squirrel's 10 s hook budget. It writes one bounded receipt into %TEMP% with
//   fixed codes and counts, never a path, and exits 0 (complete), 3 (deferred) or 4 (refused).
// - `--squirrel-firstrun` alone starts the application normally. Any other argument that starts with `--squirrel` is
//   refused: the process exits 4 and changes nothing.
//
// Squirrel deletes the binaries after the uninstall hook whatever it reports, so a hook that cannot finish defers
// explicitly (docs/uninstall.md, "Deferral") instead of claiming success.

export type SquirrelEvent = 'install' | 'updated' | 'obsolete' | 'uninstall';
export type SquirrelArgs = {readonly kind: 'none'} | {readonly kind: 'invalid'} | {readonly kind: 'event'; readonly event: SquirrelEvent; readonly version: string};
const EVENTS: readonly SquirrelEvent[] = Object.freeze(['install', 'updated', 'obsolete', 'uninstall']);
const PACKAGE_VERSION = /^\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;

/**
 * The uninstall hook's global deadline. Squirrel's 10 s start when it spawns the process, so both deadlines count from the
 * process time origin (`performance.now()` is 0 there), less PROCESS_START_MARGIN_MS for the time before that origin: the
 * engine stops at min(hook start + 8 s, 8 s - margin), and the hard stop at min(hook start + 9 s, 9 s - margin).
 */
export const UNINSTALL_DEADLINE_MS = 8000;
/** A hook that is still running then writes a deferred receipt and exits, inside Squirrel's 10 s. */
export const UNINSTALL_HARD_STOP_MS = 9000;
/** Allowance for the time between Squirrel's spawn and the process time origin, which `performance.now()` cannot see. */
export const PROCESS_START_MARGIN_MS = 500;
/** A running instance gets this long to exit after the uninstall-exit request, polled every INSTANCE_POLL_MS. */
export const INSTANCE_EXIT_WAIT_MS = 6000;
export const INSTANCE_POLL_MS = 200;
/** The single-instance payload that asks a running instance to run its explicit exit with reason `uninstall`. */
export const UNINSTALL_EXIT_PAYLOAD = Object.freeze({ets2telemetry: 'uninstall-exit'} as const);
/** `Update.exe --createShortcut` gets at most this long; Squirrel waits 15 s for the install and updated hooks. */
export const SHORTCUT_TIMEOUT_MS = 10_000;
/** `Update.exe --removeShortcut` runs beside the cleanup and gets at most this long. */
export const REMOVE_SHORTCUT_TIMEOUT_MS = 4000;
export const RECEIPT_PREFIX = 'ETS2Telemetry-uninstall-';
export const RECEIPT_FORMAT = 'ets2telemetry.uninstall-receipt';
export const EXIT_CODES: Readonly<Record<UninstallResult['outcome'], number>> = Object.freeze({complete: 0, deferred: 3, refused: 4});
const EXECUTABLE_NAME = /^[A-Za-z0-9._ -]{1,64}\.exe$/i;

/**
 * Strict parsing of the arguments after the executable (and, unpackaged, after the application path). `none` when no
 * argument starts with `--squirrel` or the only argument is `--squirrel-firstrun`; an event only for exactly
 * `--squirrel-<event> <version>`; `invalid` for anything else that mentions Squirrel.
 */
export function parseSquirrelArgs(args: readonly string[]): SquirrelArgs {
  if (!args.some(arg => /^--squirrel/i.test(arg))) return {kind: 'none'};
  if (args.length === 1 && args[0] === '--squirrel-firstrun') return {kind: 'none'};
  if (args.length !== 2 || !PACKAGE_VERSION.test(args[1])) return {kind: 'invalid'};
  const event = EVENTS.find(candidate => args[0] === `--squirrel-${candidate}`);
  return event ? {kind: 'event', event, version: args[1]} : {kind: 'invalid'};
}

export type InstanceState = 'none' | 'exited' | 'running';
/**
 * The receipt's primary reason: the engine's, or one of the hook's own. `RESIDUE_REMAINS`: the engine said complete but
 * something is left. `ENGINE_FAILED`: the engine or the hook threw; nothing after the failure ran, and a later run
 * finishes from the intent if the engine reached it.
 */
export type HookCode = UninstallCode | 'RESIDUE_REMAINS' | 'ENGINE_FAILED';
export type ShortcutState = 'created' | 'removed' | 'skipped' | 'failed';
/** The %TEMP% receipt of one uninstall hook: fixed codes, counts and names of allowlisted entries only, never a path. */
export interface UninstallReceipt {
  readonly format: typeof RECEIPT_FORMAT;
  readonly version: 1;
  readonly createdUtc: string;
  readonly appVersion: string;
  readonly outcome: UninstallResult['outcome'];
  readonly code: HookCode | null;
  readonly mode: 'production' | 'test-root' | null;
  readonly instance: InstanceState | 'not-checked';
  readonly plugins: UninstallResult['plugins'];
  readonly data: UninstallResult['data'];
  readonly roaming: UninstallResult['roaming'];
  readonly readme: boolean;
  readonly shortcuts: ShortcutState;
  /** Milliseconds from the process time origin to the hook's start (main's script), for measuring the startup cost. */
  readonly startupOffsetMs: number;
  /** Milliseconds from the hook's start to the receipt. */
  readonly elapsedMs: number;
}

/** What the handler needs from Electron, the file system and Windows; tests inject every one of them. */
export interface SquirrelPorts {
  readonly appVersion: string;
  /** The executable's file name, for `Update.exe --createShortcut=<name>`. */
  readonly executableName: string;
  resolveRoots(): Promise<UninstallRoots>;
  /** Test root only: points userData at the test file's profile folder before the lock is requested; false on failure. */
  useProfile(profileDir: string): boolean;
  /** app.requestSingleInstanceLock(UNINSTALL_EXIT_PAYLOAD): true when this process now holds the lock. */
  requestInstanceLock(): boolean;
  /** Runs `<installRoot>\Update.exe` with fixed arguments; true when it exited 0 within the timeout. */
  runUpdate(installRoot: string, args: readonly string[], timeoutMs: number): Promise<boolean>;
  readonly fs: UninstallFileSystem & CancelFileSystem;
  readonly checkRunning: RunningCheck;
  /** The bundle's own and earlier released plugin hashes; empty when the bundle cannot be read. */
  readKnown(): Promise<readonly string[]>;
  /** Production only (O7): releases the lock, then removes Electron's Roaming userData; true when it is gone. */
  readonly removeRoamingUserData?: () => Promise<boolean>;
  writeReceipt(name: string, content: string): Promise<boolean>;
  /** Monotonic milliseconds since the process time origin (`performance.now()` in production). */
  clock(): number;
  delay(milliseconds: number): Promise<void>;
  /** Resolves once after `milliseconds`; the hard stop's own timer, separate from `delay` so tests can hold it. */
  hardStop(milliseconds: number): Promise<void>;
  now(): Date;
  /** The engine; tests replace it to observe which events run it. */
  readonly runUninstall?: (ports: UninstallPorts) => Promise<UninstallResult>;
}

const EMPTY_PLUGINS: UninstallResult['plugins'] = {removed: 0, absent: 0, unrecognized: 0, notes: [], blocked: []};
const EMPTY_DATA: UninstallResult['data'] = {removed: 0, kept: 0, failed: [], rootRemoved: false};
const exists = (fs: SquirrelPorts['fs'], target: string) => fs.lstat(target).then(() => true, () => false);
const receiptStamp = (date: Date) => date.toISOString().replace(/[-:.]/g, '');

/**
 * Runs one parsed Squirrel event and returns the process exit code. `none` never reaches here; `invalid` returns 4 and
 * changes nothing.
 */
export async function runSquirrelEvent(args: SquirrelArgs, ports: SquirrelPorts): Promise<number> {
  if (args.kind !== 'event') return EXIT_CODES.refused;
  switch (args.event) {
    case 'obsolete': return 0;
    case 'install':
    case 'updated': await installed(ports); return 0;
    case 'uninstall': return uninstallWithHardStop(ports);
  }
}

/** install and updated: the shortcuts, then cancelling a pending deferral. Nothing is deleted but the deferral's own files. */
async function installed(ports: SquirrelPorts): Promise<{shortcuts: ShortcutState; deferral: CancelOutcome | 'not-installed'}> {
  const roots = await ports.resolveRoots().catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return {shortcuts: 'skipped', deferral: 'not-installed'};
  const shortcuts: ShortcutState = !wantsShortcuts(roots, ports) ? 'skipped'
    : await ports.runUpdate(roots.installRoot, [`--createShortcut=${ports.executableName}`], SHORTCUT_TIMEOUT_MS).then((ok): ShortcutState => ok ? 'created' : 'failed', (): ShortcutState => 'failed');
  const deferral = await cancelDeferral(ports.fs, roots.dataRoot).catch((): CancelOutcome => 'failed');
  return {shortcuts, deferral};
}

/** Production installs always manage shortcuts; a test install only when its test file sets `shortcuts: true`. */
function wantsShortcuts(roots: Extract<UninstallRoots, {ok: true}>, ports: SquirrelPorts): boolean {
  if (!EXECUTABLE_NAME.test(ports.executableName)) return false;
  return roots.mode === 'production' || roots.testFile.shortcuts;
}

/** The engine deadline and the hard stop on the clock, anchored to the process time origin (see UNINSTALL_DEADLINE_MS). */
export function hookDeadlines(started: number): {engine: number; hardStop: number} {
  return {engine: Math.min(started + UNINSTALL_DEADLINE_MS, UNINSTALL_DEADLINE_MS - PROCESS_START_MARGIN_MS),
    hardStop: Math.min(started + UNINSTALL_HARD_STOP_MS, UNINSTALL_HARD_STOP_MS - PROCESS_START_MARGIN_MS)};
}

/**
 * The uninstall hook under a hard stop: a run still going at the hard stop (a file operation that never settles) writes
 * a deferred receipt and returns 3. If the engine reached its intent, a later run finishes; otherwise nothing was
 * deleted. The run and the hard stop race for one claim: the side that claims first writes the only receipt and decides
 * the exit code, and the result resolves only after that receipt was written. The other side never resolves the race.
 */
async function uninstallWithHardStop(ports: SquirrelPorts): Promise<number> {
  const started = ports.clock();
  const deadlines = hookDeadlines(started);
  const state: HookState = {mode: null, instance: 'not-checked', shortcuts: 'skipped', claimed: false};
  const claim = (settled: Settled, readme: boolean): Promise<number> => {
    if (state.claimed) return new Promise<number>(() => undefined);
    state.claimed = true;
    return writeReceipt(ports, settled, state, readme, started).then(() => EXIT_CODES[settled.outcome]);
  };
  const hardStop = ports.hardStop(Math.max(0, deadlines.hardStop - started))
    .then(() => claim({outcome: 'deferred', code: 'BUDGET_EXPIRED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false));
  const run = uninstall(ports, state, deadlines.engine, claim)
    .catch(() => claim({outcome: 'deferred', code: 'ENGINE_FAILED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false));
  return Promise.race([run, hardStop]);
}

interface HookState {mode: UninstallReceipt['mode']; instance: UninstallReceipt['instance']; shortcuts: ShortcutState; claimed: boolean}
type Settled = Pick<UninstallResult, 'outcome' | 'plugins' | 'data' | 'roaming'> & {code: HookCode | null};

async function uninstall(ports: SquirrelPorts, state: HookState, deadline: number, finish: (settled: Settled, readme: boolean) => Promise<number>): Promise<number> {

  // 1. The roots (U3). A refusal changes nothing.
  const roots = await ports.resolveRoots().catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return finish({outcome: 'refused', code: roots.code satisfies UninstallRootsRefusal, plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false);
  state.mode = roots.mode;

  // 2. A running instance: the lock with the uninstall-exit payload, polled until it is free or the wait ends.
  const profileReady = roots.mode === 'test-root' ? ports.useProfile(roots.testFile.profileDir) : true;
  state.instance = profileReady ? await closeInstance(ports, Math.min(ports.clock() + INSTANCE_EXIT_WAIT_MS, deadline)) : 'running';
  // The shortcuts go beside the cleanup; Squirrel does not remove them for an application that handles its events.
  const shortcuts = !wantsShortcuts(roots, ports) ? Promise.resolve<ShortcutState>('skipped')
    : ports.runUpdate(roots.installRoot, [`--removeShortcut=${ports.executableName}`], REMOVE_SHORTCUT_TIMEOUT_MS).then((ok): ShortcutState => ok ? 'removed' : 'failed', (): ShortcutState => 'failed');

  // 3. The engine, within what is left of the deadline.
  const known = await ports.readKnown().catch(() => []);
  const engine = ports.runUninstall ?? runUninstall;
  let settled: Settled;
  try {
    const result = await engine({roots, fs: ports.fs, checkRunning: ports.checkRunning, known, clock: () => ports.clock(), deadline,
      runningCheckBudgetMs: Math.max(0, Math.min(RUNNING_CHECK_BUDGET_MS, deadline - ports.clock())), now: () => ports.now(), delay: milliseconds => ports.delay(milliseconds),
      ...(roots.mode === 'production' && ports.removeRoamingUserData ? {removeRoamingUserData: ports.removeRoamingUserData} : {}),
      ...(state.instance === 'running' ? {deferAll: 'INSTANCE_RUNNING' as const} : {})});
    settled = settle(result, await exists(ports.fs, roots.dataRoot));
  } catch {
    // The engine threw: ENGINE_FAILED. If it reached its intent, a later run finishes from it; otherwise nothing was deleted.
    settled = {outcome: 'deferred', code: 'ENGINE_FAILED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'};
  }
  // A deferral leaves the README beside the intent (the U7 fallback until the PR-5 executor).
  const readme = settled.outcome === 'deferred' ? await writeDeferralReadme(ports.fs, roots.dataRoot, settled.code).catch(() => false) : false;
  state.shortcuts = await shortcuts;
  return finish(settled, readme);
}

/**
 * The receipt's outcome: the engine's, except that `complete` is impossible while anything remains. A complete result
 * with a blocked folder, a failed data entry, or a data root that still exists becomes deferred with RESIDUE_REMAINS.
 */
export function settle(result: UninstallResult, dataRootPresent: boolean): Settled {
  const residue = result.plugins.blocked.length > 0 || result.data.failed.length > 0 || dataRootPresent;
  if (result.outcome === 'complete' && residue) return {...result, outcome: 'deferred', code: 'RESIDUE_REMAINS', roaming: result.roaming};
  return result;
}

/** Requests the lock with the uninstall-exit payload; a running instance gets `deadline` to exit and release it. */
async function closeInstance(ports: SquirrelPorts, deadline: number): Promise<InstanceState> {
  if (ports.requestInstanceLock()) return 'none';
  while (ports.clock() < deadline) {
    await ports.delay(INSTANCE_POLL_MS);
    // Each failed request signals the running instance again; its explicit exit runs once.
    if (ports.requestInstanceLock()) return 'exited';
  }
  return 'running';
}

async function writeReceipt(ports: SquirrelPorts, settled: Settled, state: HookState, readme: boolean, started: number): Promise<boolean> {
  const now = ports.now();
  const receipt: UninstallReceipt = {format: RECEIPT_FORMAT, version: 1, createdUtc: now.toISOString(), appVersion: ports.appVersion, outcome: settled.outcome,
    code: settled.code, mode: state.mode, instance: state.instance, plugins: settled.plugins, data: settled.data, roaming: settled.roaming, readme,
    shortcuts: state.shortcuts, startupOffsetMs: Math.max(0, Math.round(started)), elapsedMs: Math.max(0, Math.round(ports.clock() - started))};
  return ports.writeReceipt(`${RECEIPT_PREFIX}${receiptStamp(now)}.json`, `${JSON.stringify(receipt, null, 2)}\n`).catch(() => false);
}

/** Electron's part of the production ports. */
export interface SquirrelApp {
  getPath(name: 'appData' | 'userData' | 'temp'): string;
  setPath(name: 'userData' | 'sessionData', value: string): void;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  releaseSingleInstanceLock(): void;
}
export const ROAMING_USER_DATA_NAME = 'ETS2Telemetry Desktop';

/** The production ports: the running executable's install, the bundled plugin manifest, tasklist and Update.exe. */
export function productionSquirrelPorts(options: {app: SquirrelApp; appVersion: string; executable: string; env: Readonly<Record<string, string | undefined>>;
  mainDirectory: string; resourcesPath: string}): SquirrelPorts {
  const {app, env} = options;
  const fs = nodeFs as unknown as SquirrelPorts['fs'];
  return {
    appVersion: options.appVersion,
    executableName: path.win32.basename(options.executable),
    resolveRoots: () => resolveUninstallRoots({executable: options.executable, env, fs}),
    useProfile: profileDir => {
      try {mkdirSync(profileDir, {recursive: true}); app.setPath('userData', profileDir); app.setPath('sessionData', profileDir); return true;} catch {return false;}
    },
    requestInstanceLock: () => app.requestSingleInstanceLock({...UNINSTALL_EXIT_PAYLOAD}),
    runUpdate: async (installRoot, args, timeoutMs) => (await runFixedProgram(nodeExecFile, path.win32.join(installRoot, 'Update.exe'), args,
      {timeoutMs, maxOutputBytes: 64 * 1024})).ok,
    fs,
    checkRunning: signal => checkRunningGames({signal}),
    readKnown: async () => {
      const read = await readPluginBundle(pluginBundleDirectory(options.mainDirectory, options.resourcesPath, true));
      return read.ok ? [read.bundle.sha256, ...read.bundle.known.map(entry => entry.sha256)] : [];
    },
    removeRoamingUserData: () => removeRoamingUserData(app, env),
    writeReceipt: async (name, content) => {
      try {await nodeFs.writeFile(path.join(app.getPath('temp'), name), content, {flag: 'wx'}); return true;} catch {return false;}
    },
    clock: () => performance.now(),
    delay: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    hardStop: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    now: () => new Date()
  };
}

/** Chromium's single-instance lock file in userData, held open while this process holds the lock. */
const SINGLETON_LOCK_FILE = 'lockfile';
/**
 * O7: removes `%APPDATA%\ETS2Telemetry Desktop` best effort, only when userData is exactly that folder and no diagnostic
 * profile override is set. A link is never followed. Everything but Chromium's lock file goes while this process still
 * holds the single-instance lock; then the lock is released and the lock file and the folder go. Between the release and
 * that last removal a new start could take the lock and recreate the folder (and its own logs in the data root): a
 * window of one or two file operations, which a start in the middle of a Windows uninstall makes unlikely.
 */
async function removeRoamingUserData(app: SquirrelApp, env: Readonly<Record<string, string | undefined>>): Promise<boolean> {
  if (env.ETS2TELEMETRY_PROFILE_DIR) return false;
  const userData = app.getPath('userData');
  if (path.win32.normalize(userData).toLowerCase() !== path.win32.join(app.getPath('appData'), ROAMING_USER_DATA_NAME).toLowerCase()) return false;
  let stats;
  try {stats = await nodeFs.lstat(userData);} catch {app.releaseSingleInstanceLock(); return true;}
  if (stats.isSymbolicLink() || !stats.isDirectory()) {app.releaseSingleInstanceLock(); return false;}
  const entries = await nodeFs.readdir(userData).catch((): string[] => []);
  for (const name of entries) {
    if (name.toLowerCase() === SINGLETON_LOCK_FILE) continue;
    // fs.rm unlinks a link or junction itself instead of entering it.
    await nodeFs.rm(path.join(userData, name), {recursive: true, force: true, maxRetries: 2, retryDelay: 100}).catch(() => undefined);
  }
  app.releaseSingleInstanceLock();
  await nodeFs.rm(userData, {recursive: true, force: true, maxRetries: 2, retryDelay: 100}).catch(() => undefined);
  return nodeFs.lstat(userData).then(() => false, () => true);
}

/**
 * A start of the installed application cancels a pending uninstall deferral (U7): the intent and the README go, and
 * silent plugin setup takes over the plugin files again. Unpackaged and development launches never get here.
 */
export async function cancelDeferralOnStart(options: {executable: string; env: Readonly<Record<string, string | undefined>>; fs?: SquirrelPorts['fs']}): Promise<CancelOutcome | UninstallRootsRefusal> {
  const fs = options.fs ?? nodeFs;
  const roots = await resolveUninstallRoots({executable: options.executable, env: options.env, fs}).catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return roots.code;
  return cancelDeferral(fs, roots.dataRoot).catch((): CancelOutcome => 'failed');
}
