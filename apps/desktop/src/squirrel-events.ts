import {mkdirSync} from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import {ICON_RESOURCE_DIRECTORY, INSTALLED_ICON_FILE, MAX_ICON_BYTES, registerInstalledIcon, regExeUninstallEntry, type InstalledIconResult,
  type UninstallEntryRegistry} from './installed-app-icon';
import {nodeExecFile, runFixedProgram, systemRoot} from './plugin-setup/fixed-program';
import {checkRunningGames, listProcessSessions} from './plugin-setup/game-processes';
import {pluginBundleDirectory, readPluginBundle} from './plugin-setup/plugin-bundle';
import type {RunningCheck} from './plugin-setup/plugin-installer';
import {cancelDeferral, writeDeferralReadme, type CancelFileSystem, type CancelOutcome} from './uninstall/deferral';
import {RUNNING_CHECK_BUDGET_MS, runUninstall, type UninstallCode, type UninstallFileSystem, type UninstallPorts, type UninstallResult} from './uninstall/engine';
import {armExecutor, disarmExecutor, EXECUTOR_FILE, EXECUTOR_RESOURCE_DIRECTORY, MAX_EXECUTOR_BYTES, REG_TIMEOUT_MS, regExeRunOnce, type ExecutorState,
  type RunOnceRegistry} from './uninstall/executor';
import {resolveUninstallRoots, type UninstallRoots, type UninstallRootsRefusal} from './uninstall/roots';

// The Squirrel.Windows event handler (ET-018 U2, U6; docs/app-lifecycle.md, "Squirrel events"; docs/uninstall.md). It
// replaces electron-squirrel-startup and runs before anything else in main: before the diagnostic profile override, the
// logs, the settings, plugin setup and the telemetry service. Squirrel starts the installed executable with exactly one
// event and the package version:
//
// - `--squirrel-install` and `--squirrel-updated` create the shortcuts through `Update.exe --createShortcut` (skipped in a
//   test install unless its test file asks for them) and cancel a pending uninstall deferral, with its RunOnce
//   registration. Beside the shortcuts, they place the bundled product icon at `<install root>\app.ico` and set this
//   product's DisplayIcon to the versioned executable's icon 0 (ET-045g, owner decision D3; installed-app-icon.ts), so
//   Windows Settings shows the product icon instead of the Electron atom Squirrel would download. They never delete data.
// - `--squirrel-obsolete` (the previous version after an update) quits. It never deletes anything.
// - `--squirrel-uninstall` closes a running instance through the single-instance lock, then runs the uninstall engine
//   within a global 8 s deadline, inside Squirrel's 10 s hook budget. Before the engine deletes anything it copies the
//   deferred-cleanup executor and registers it under RunOnce (ET-018 PR-5, U7); only a complete run removes the
//   registration, last. It writes one bounded receipt into %TEMP% with fixed codes and counts, never a path, and exits
//   0 (complete), 3 (deferred) or 4 (refused).
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
/** The uninstall hook waits for other processes of this executable to end, polled this often, until its engine deadline. */
export const PROCESS_POLL_MS = 200;
/** `Update.exe --createShortcut` gets at most this long; Squirrel waits 15 s for the install and updated hooks. */
export const SHORTCUT_TIMEOUT_MS = 10_000;
/** `Update.exe --removeShortcut` runs beside the cleanup and gets at most this long. */
export const REMOVE_SHORTCUT_TIMEOUT_MS = 4000;
/** The shortest time a registry call of the uninstall hook gets, even when the engine deadline is close or past. */
export const REG_FLOOR_MS = 500;
export const RECEIPT_PREFIX = 'ETS2Telemetry-uninstall-';
export const RECEIPT_FORMAT = 'ets2telemetry.uninstall-receipt';
export const EXIT_CODES: Readonly<Record<UninstallResult['outcome'], number>> = Object.freeze({complete: 0, deferred: 3, refused: 4});
const EXECUTABLE_NAME = /^[A-Za-z0-9._ -]{1,64}\.exe$/i;

/** The part of Electron's `app` that a Squirrel event process configures before it is ready. */
export interface SquirrelProcessApp {
  disableHardwareAcceleration(): void;
  readonly commandLine: {appendSwitch(name: string, value?: string): void};
}
/**
 * A Squirrel event process starts no child process (ET-018 PR-3). Squirrel deletes the install folder as soon as the
 * hook's main process exits; a windowless Electron otherwise runs a GPU process and a network-service utility process,
 * which end a moment after main and hold `v8_context_snapshot.bin`, `vk_swiftshader.dll` and `vk_swiftshader_icd.json`,
 * so Squirrel could not delete them (a hosted lifecycle run, dispatch 39102356971). With hardware acceleration off, the GPU work in
 * process and the network service in process, a scratch Electron 44.7.0 hook ran one process image instead of three.
 * Must run before the app is ready; normal launches never call it.
 */
export function prepareSquirrelProcess(app: SquirrelProcessApp): void {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('in-process-gpu');
  app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
}

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
 * something is left. `ENGINE_FAILED`: the engine itself threw; a later run finishes from the intent if the engine reached
 * it. `HOOK_FAILED`: a hook step before the engine threw (the profile, the instance lock, the known hashes); the engine
 * did not run and nothing was deleted. A step after the engine never replaces its result (see `failedStep`).
 */
export type HookCode = UninstallCode | 'RESIDUE_REMAINS' | 'ENGINE_FAILED' | 'HOOK_FAILED';
/** A hook step after the engine that threw; the receipt keeps the engine's outcome and counts and names the step. */
export type PostEngineStep = 'readme' | 'shortcuts' | 'process-wait';
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
  /** ET-018 PR-5 (U7): the deferred-cleanup executor's registration when the receipt was written. */
  readonly executor: ExecutorState;
  readonly readme: boolean;
  readonly shortcuts: ShortcutState;
  /** The first step after the engine that threw, or null; the engine's outcome and counts stand regardless. */
  readonly failedStep: PostEngineStep | null;
  /** Milliseconds from the process time origin to the hook's start (main's script), for measuring the startup cost. */
  readonly startupOffsetMs: number;
  /**
   * Other processes of this application's executable in this process's Windows session (by image name, without this
   * process and its own children) still running when the receipt was written, after waiting for them until the engine
   * deadline; null when they were not counted (the deadline had passed, or the listing failed or was cut off by it).
   */
  readonly otherProcesses: number | null;
  /** How long the hook waited for them. */
  readonly processWaitMs: number;
  /** Milliseconds from the hook's start to the receipt. */
  readonly elapsedMs: number;
}

/** What the handler needs from Electron, the file system and Windows; tests inject every one of them. */
export interface SquirrelPorts {
  readonly appVersion: string;
  /** The executable's file name, for `Update.exe --createShortcut=<name>`. */
  readonly executableName: string;
  /** ET-031: Removes the per-user autostart login item during uninstall. */
  readonly removeLoginItem?: (installRoot: string, executableName: string) => Promise<boolean> | boolean | void;
  resolveRoots(): Promise<UninstallRoots>;
  /** Test root only: points userData at the test file's profile folder before the lock is requested; false on failure. */
  useProfile(profileDir: string): boolean;
  /** app.requestSingleInstanceLock(UNINSTALL_EXIT_PAYLOAD): true when this process now holds the lock. */
  requestInstanceLock(): boolean;
  /** Runs `<installRoot>\Update.exe` with fixed arguments; true when it exited 0 within the timeout. */
  runUpdate(installRoot: string, args: readonly string[], timeoutMs: number): Promise<boolean>;
  readonly fs: UninstallFileSystem & CancelFileSystem;
  /** HKCU RunOnce through reg.exe in production; tests inject a fake (never the real RunOnce key). */
  readonly runOnce: RunOnceRegistry;
  /** The Windows folder for the registered command's absolute powershell.exe (`systemRoot(env)` in production). */
  readonly windowsDirectory: string;
  /** The packaged deferred-cleanup executor's bytes, or undefined when it cannot be read. */
  readExecutor(): Promise<Uint8Array | undefined>;
  /** ET-045g: the packaged product icon's bytes (`resources\icon\app.ico`), or undefined when it cannot be read. */
  readBundledIcon(): Promise<Uint8Array | undefined>;
  /** ET-045g: this product's uninstall entry DisplayIcon through reg.exe in production; tests inject a fake. */
  readonly uninstallEntry: UninstallEntryRegistry;
  readonly checkRunning: RunningCheck;
  /** The bundle's own and earlier released plugin hashes; empty when the bundle cannot be read. */
  readKnown(): Promise<readonly string[]>;
  /**
   * The number of other processes of this executable in this process's Windows session (see
   * UninstallReceipt.otherProcesses), or null when the listing failed or `signal` aborted it.
   */
  countOtherProcesses(signal: AbortSignal): Promise<number | null>;
  /** A signal that aborts after `milliseconds` (`AbortSignal.timeout` in production); it bounds the process wait. */
  deadlineSignal(milliseconds: number): AbortSignal;
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

/**
 * install and updated: the shortcuts and, at the same time, the Installed apps icon (ET-045g), then cancelling a pending
 * deferral and its RunOnce registration. Nothing is deleted but the deferral's own files. Squirrel waits 15 s for these
 * hooks: the shortcuts take at most SHORTCUT_TIMEOUT_MS (10 s) and the icon at most two DisplayIcon attempts of
 * REG_TIMEOUT_MS (2 s each) beside them, and the disarm at most REG_TIMEOUT_MS after both, so 12 s at worst. A failure of
 * either step changes neither the other nor the exit code.
 */
async function installed(ports: SquirrelPorts): Promise<{shortcuts: ShortcutState; icon: InstalledIconResult | 'not-run'; deferral: CancelOutcome | 'not-installed';
  executor: ExecutorState}> {
  const roots = await ports.resolveRoots().catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return {shortcuts: 'skipped', icon: 'not-run', deferral: 'not-installed', executor: 'not-run'};
  const shortcutStep: Promise<ShortcutState> = !wantsShortcuts(roots, ports) ? Promise.resolve<ShortcutState>('skipped')
    : ports.runUpdate(roots.installRoot, [`--createShortcut=${ports.executableName}`], SHORTCUT_TIMEOUT_MS).then((ok): ShortcutState => ok ? 'created' : 'failed', (): ShortcutState => 'failed');
  const iconStep = registerInstalledIcon({roots, fs: ports.fs, readBundledIcon: () => ports.readBundledIcon(), registry: ports.uninstallEntry,
    executableName: ports.executableName, timeoutMs: REG_TIMEOUT_MS, delay: milliseconds => ports.delay(milliseconds)})
    .catch((): InstalledIconResult => ({icon: 'failed', displayIcon: 'failed'}));
  const [shortcuts, icon] = await Promise.all([shortcutStep, iconStep]);
  const deferral = await cancelDeferral(ports.fs, roots.dataRoot).catch((): CancelOutcome => 'failed');
  const executor = deferral === 'none' ? 'not-run' : await disarmExecutor(roots, ports.runOnce, REG_TIMEOUT_MS).catch((): ExecutorState => 'failed');
  return {shortcuts, icon, deferral, executor};
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
  const state: HookState = {mode: null, instance: 'not-checked', shortcuts: 'skipped', claimed: false, otherProcesses: null, processWaitMs: 0, failedStep: null,
    executor: 'not-run'};
  const claim = (settled: Settled, readme: boolean): Promise<number> => {
    if (state.claimed) return new Promise<number>(() => undefined);
    state.claimed = true;
    return writeReceipt(ports, settled, state, readme, started).then(() => EXIT_CODES[settled.outcome]);
  };
  const hardStop = ports.hardStop(Math.max(0, deadlines.hardStop - started))
    .then(() => claim({outcome: 'deferred', code: 'BUDGET_EXPIRED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false));
  // Only a step before the engine can still throw here: the engine's own throw and every later step are caught inside.
  const run = uninstall(ports, state, deadlines.engine, claim)
    .catch(() => claim({outcome: 'deferred', code: 'HOOK_FAILED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false));
  return Promise.race([run, hardStop]);
}

interface HookState {mode: UninstallReceipt['mode']; instance: UninstallReceipt['instance']; shortcuts: ShortcutState; claimed: boolean;
  otherProcesses: number | null; processWaitMs: number; failedStep: PostEngineStep | null;
  /** Set as soon as the engine armed or disarmed the executor, so even a hard stop or an engine throw records it. */
  executor: ExecutorState}
type Settled = Pick<UninstallResult, 'outcome' | 'plugins' | 'data' | 'roaming'> & {code: HookCode | null};

async function uninstall(ports: SquirrelPorts, state: HookState, deadline: number, finish: (settled: Settled, readme: boolean) => Promise<number>): Promise<number> {

  // 1. The roots (U3). A refusal changes nothing.
  const roots = await ports.resolveRoots().catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return finish({outcome: 'refused', code: roots.code satisfies UninstallRootsRefusal, plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'}, false);
  state.mode = roots.mode;

  // 2. A running instance: the lock with the uninstall-exit payload, polled until it is free or the wait ends.
  const profileReady = roots.mode === 'test-root' ? ports.useProfile(roots.testFile.profileDir) : true;
  state.instance = profileReady ? await closeInstance(ports, Math.min(ports.clock() + INSTANCE_EXIT_WAIT_MS, deadline)) : 'running';
  if (ports.removeLoginItem) {
    try {await ports.removeLoginItem(roots.installRoot, ports.executableName);} catch {/* best effort */}
  }
  // The shortcuts go beside the cleanup; Squirrel does not remove them for an application that handles its events.
  const shortcuts = !wantsShortcuts(roots, ports) ? Promise.resolve<ShortcutState>('skipped')
    : ports.runUpdate(roots.installRoot, [`--removeShortcut=${ports.executableName}`], REMOVE_SHORTCUT_TIMEOUT_MS).then((ok): ShortcutState => ok ? 'removed' : 'failed', (): ShortcutState => 'failed');

  // 3. The engine, within what is left of the deadline.
  const known = await ports.readKnown().catch(() => []);
  const engine = ports.runUninstall ?? runUninstall;
  // A registry call gets REG_TIMEOUT_MS, cut to what is left before the engine deadline but never below REG_FLOOR_MS: the
  // registration matters most exactly when the run is short of time, and the hard stop still bounds the whole hook.
  const registryTimeout = () => Math.max(REG_FLOOR_MS, Math.min(REG_TIMEOUT_MS, deadline - ports.clock()));
  const armExecutorPort = async () => state.executor = await armExecutor({roots, fs: ports.fs, registry: ports.runOnce, windowsDirectory: ports.windowsDirectory, readExecutor: () => ports.readExecutor(),
    timeoutMs: registryTimeout});
  const disarmExecutorPort = async () => state.executor = await disarmExecutor(roots, ports.runOnce, registryTimeout());
  let settled: Settled;
  try {
    const result = await engine({roots, fs: ports.fs, checkRunning: ports.checkRunning, known, clock: () => ports.clock(), deadline,
      runningCheckBudgetMs: Math.max(0, Math.min(RUNNING_CHECK_BUDGET_MS, deadline - ports.clock())), now: () => ports.now(), delay: milliseconds => ports.delay(milliseconds),
      armExecutor: armExecutorPort, disarmExecutor: disarmExecutorPort,
      ...(roots.mode === 'production' && ports.removeRoamingUserData ? {removeRoamingUserData: ports.removeRoamingUserData} : {}),
      ...(state.instance === 'running' ? {deferAll: 'INSTANCE_RUNNING' as const} : {})});
    settled = settle(result, await exists(ports.fs, roots.dataRoot));
  } catch {
    // The engine threw: ENGINE_FAILED. If it reached its intent, a later run finishes from it; otherwise nothing was deleted.
    settled = {outcome: 'deferred', code: 'ENGINE_FAILED', plugins: EMPTY_PLUGINS, data: EMPTY_DATA, roaming: 'not-run'};
  }
  // The engine has settled: from here on a failing step is recorded as failedStep and never replaces its result.
  const step = async <T>(name: PostEngineStep, work: () => Promise<T>, fallback: T): Promise<T> => {
    try {return await work();} catch {state.failedStep ??= name; return fallback;}
  };
  // A deferral leaves the README beside the intent: it says whether the registered executor finishes at the next sign-in,
  // and gives the manual steps in case it cannot.
  const readme = settled.outcome === 'deferred'
    ? await step('readme', () => writeDeferralReadme(ports.fs, roots.dataRoot, settled.code, state.executor === 'registered'), false) : false;
  state.shortcuts = await step('shortcuts', () => shortcuts, 'failed');
  // Squirrel deletes the install folder right after this process exits; a process of this executable that is still
  // ending (an instance Squirrel ended, a portable copy that got the uninstall-exit request) would keep its files.
  await step('process-wait', () => waitForOtherProcesses(ports, state, deadline), undefined);
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

/** Polls the other processes of this executable until none is left or the deadline passes, and records the last count. */
async function waitForOtherProcesses(ports: SquirrelPorts, state: HookState, deadline: number): Promise<void> {
  const started = ports.clock();
  // Nothing is counted once the deadline has passed; a listing still running at the deadline is cut off, so the wait never
  // delays the receipt past it (a slow tasklist would otherwise run into the hard stop and turn the result into deferred).
  if (started >= deadline) return;
  const signal = ports.deadlineSignal(Math.max(0, deadline - started));
  for (;;) {
    state.otherProcesses = signal.aborted ? null : await ports.countOtherProcesses(signal).catch(() => null);
    if (state.otherProcesses === 0 || state.otherProcesses === null || signal.aborted || ports.clock() + PROCESS_POLL_MS > deadline) break;
    await ports.delay(PROCESS_POLL_MS);
  }
  state.processWaitMs = Math.max(0, Math.round(ports.clock() - started));
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

/** Writes the receipt; false on any failure, including one while building it, so a claim always resolves with its code. */
async function writeReceipt(ports: SquirrelPorts, settled: Settled, state: HookState, readme: boolean, started: number): Promise<boolean> {
  try {
    const now = ports.now();
    const receipt: UninstallReceipt = {format: RECEIPT_FORMAT, version: 1, createdUtc: now.toISOString(), appVersion: ports.appVersion, outcome: settled.outcome,
      code: settled.code, mode: state.mode, instance: state.instance, plugins: settled.plugins, data: settled.data, roaming: settled.roaming, executor: state.executor, readme,
      shortcuts: state.shortcuts, startupOffsetMs: Math.max(0, Math.round(started)), otherProcesses: state.otherProcesses, processWaitMs: state.processWaitMs,
      failedStep: state.failedStep, elapsedMs: Math.max(0, Math.round(ports.clock() - started))};
    return await ports.writeReceipt(`${RECEIPT_PREFIX}${receiptStamp(now)}.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  } catch {return false;}
}

/**
 * The production deadline signal. `AbortSignal.timeout` accepts only a whole number of milliseconds, while the hook's
 * clock (`performance.now()`) is fractional: a fractional delay threw RangeError ERR_OUT_OF_RANGE after the engine had
 * finished (the final-head hosted run of PR-3). The delay is rounded up, never down, so the signal never fires early.
 */
export function deadlineSignal(milliseconds: number): AbortSignal {
  return AbortSignal.timeout(Math.min(0x7fffffff, Math.max(0, Math.ceil(milliseconds))));
}

/** Electron's part of the production ports. */
export interface SquirrelApp {
  getPath(name: 'appData' | 'userData' | 'temp'): string;
  setPath(name: 'userData' | 'sessionData', value: string): void;
  requestSingleInstanceLock(additionalData?: Record<string, unknown>): boolean;
  releaseSingleInstanceLock(): void;
  getAppMetrics(): readonly {readonly pid: number}[];
  setLoginItemSettings?(settings: {openAtLogin: boolean; path?: string; args?: string[]}): void;
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
    removeLoginItem: (installRoot, executableName) => {
      try {
        app.setLoginItemSettings?.({
          openAtLogin: false,
          path: path.win32.join(installRoot, 'Update.exe'),
          args: ['--processStart', '"' + executableName + '"', '--process-start-args', '"--hidden"']
        });
        return true;
      } catch {
        return false;
      }
    },
    resolveRoots: () => resolveUninstallRoots({executable: options.executable, env, fs}),
    useProfile: profileDir => {
      try {mkdirSync(profileDir, {recursive: true}); app.setPath('userData', profileDir); app.setPath('sessionData', profileDir); return true;} catch {return false;}
    },
    requestInstanceLock: () => app.requestSingleInstanceLock({...UNINSTALL_EXIT_PAYLOAD}),
    runUpdate: async (installRoot, args, timeoutMs) => (await runFixedProgram(nodeExecFile, path.win32.join(installRoot, 'Update.exe'), args,
      {timeoutMs, maxOutputBytes: 64 * 1024})).ok,
    fs,
    runOnce: regExeRunOnce(env),
    windowsDirectory: systemRoot(env),
    // The executor Forge ships as an extra resource (resources\uninstall); armExecutor checks it is bounded ASCII text.
    readExecutor: async () => {
      const file = path.join(options.resourcesPath, EXECUTOR_RESOURCE_DIRECTORY, EXECUTOR_FILE);
      const stats = await nodeFs.lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_EXECUTOR_BYTES) return undefined;
      return nodeFs.readFile(file);
    },
    // ET-045g: the product icon Forge ships as an extra resource (resources\icon\app.ico); registerInstalledIcon checks
    // that it is an icon file.
    readBundledIcon: async () => {
      const file = path.join(options.resourcesPath, ICON_RESOURCE_DIRECTORY, INSTALLED_ICON_FILE);
      const stats = await nodeFs.lstat(file);
      if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_ICON_BYTES) return undefined;
      return nodeFs.readFile(file);
    },
    uninstallEntry: regExeUninstallEntry(env),
    checkRunning: signal => checkRunningGames({signal}),
    // Only this process's Windows session: another user's copy cannot hold this install's files open for long, and its
    // processes are never waited on (their session number is not this one).
    countOtherProcesses: async signal => {
      const listing = await listProcessSessions({signal});
      if (!listing.ok || signal.aborted) return null;
      const session = listing.rows.find(row => row.pid === process.pid)?.session ?? null;
      if (session === null) return null;
      let own: Set<number>;
      try {own = new Set([process.pid, ...app.getAppMetrics().map(metric => metric.pid)]);} catch {own = new Set([process.pid]);}
      const name = path.win32.basename(options.executable).toLowerCase();
      return listing.rows.filter(row => row.name.toLowerCase() === name && row.session === session && !own.has(row.pid)).length;
    },
    deadlineSignal,
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
 * A start of the installed application cancels a pending uninstall deferral (U7): the intent, the README and the copied
 * executor go, then the executor's RunOnce registration, and silent plugin setup takes over the plugin files again. The
 * registry is touched only when there was a deferral to cancel. Unpackaged and development launches never get here.
 */
export async function cancelDeferralOnStart(options: {executable: string; env: Readonly<Record<string, string | undefined>>; fs?: SquirrelPorts['fs'];
  runOnce?: RunOnceRegistry}): Promise<{readonly deferral: CancelOutcome | UninstallRootsRefusal; readonly executor: ExecutorState}> {
  const fs = options.fs ?? nodeFs;
  const roots = await resolveUninstallRoots({executable: options.executable, env: options.env, fs}).catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
  if (!roots.ok) return {deferral: roots.code, executor: 'not-run'};
  const deferral = await cancelDeferral(fs, roots.dataRoot).catch((): CancelOutcome => 'failed');
  if (deferral === 'none') return {deferral, executor: 'not-run'};
  const executor = await disarmExecutor(roots, options.runOnce ?? regExeRunOnce(options.env), REG_TIMEOUT_MS).catch((): ExecutorState => 'failed');
  return {deferral, executor};
}
