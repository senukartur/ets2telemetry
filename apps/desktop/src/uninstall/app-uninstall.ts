import type {AppUninstallResult, UninstallBlockCode, UninstallFailureCode} from '../../../../packages/contracts/src';
import {uninstallOtherTarget} from '../../../../packages/contracts/src/uninstall';
import type {RunningCheck} from '../plugin-setup/plugin-installer';
import type {PluginGame} from '../plugin-setup/steam-discovery';
import {cancelDeferral, type CancelFileSystem} from './deferral';
import {runUninstall, wipeEverything, type UninstallFileSystem, type UninstallPorts, type UninstallResult} from './engine';
import type {FolderNote} from './plugin-cleanup';
import type {UninstallRoots} from './roots';

// The in-app uninstall (ET-018 PR-4, plan U8; docs/uninstall.md, "In-app uninstall"). The order:
//
// 1. The roots (U3): a portable or development copy answers `not-installed` before any dialog.
// 2. A native confirmation owned by the dashboard, with Cancel as the default; declining changes nothing.
// 3. The engine's read-only preflight on the install registry (scope `preflight`): a running game or TruckersMP, a
//    read-only or unrecognized file, a link, a failed listing or a registry problem answers `blocked` with target ids and
//    fixed codes, and nothing changes.
// 4. Silent plugin setup is suspended and its run in flight settles; then the intent is written and the plugins are
//    removed (scope `plugins`). A removal that fails now (a game started meanwhile, a lock) removes the intent, resumes
//    setup and keeps the data. It answers `blocked` when no plugin file was removed yet, so nothing changed; otherwise
//    `interrupted` with the number removed: setup, resumed, installs the plugin again in every folder it manages while
//    that game is closed.
// 5. `started`: main runs the explicit exit with reason `uninstall` (service stop, idle, plugin setup aborted), then
//    calls finishAfterExit, which wipes the data within what is left before the 12 s failsafe (at most 5 s, keeping 1 s
//    for the handover), and hands over to Windows' uninstall.
//
// Nothing here returns or logs a path.

/** The preflight and the plugin removal each get at most this long; the running-game check inside has its own 3 s. */
export const APP_UNINSTALL_STEP_BUDGET_MS = 10_000;
/** The data wipe after the exit, at most. */
export const APP_UNINSTALL_WIPE_BUDGET_MS = 5000;
/** Main ends an uninstall exit that has not reached its result dialog after this long, with exit code 1. */
export const APP_UNINSTALL_FAILSAFE_MS = 12_000;
/** What the wipe leaves before the failsafe for the result dialog to open and the handover to start. */
export const APP_UNINSTALL_HANDOVER_MARGIN_MS = 1000;

/**
 * The wipe's budget at `now` for a failsafe due at `failsafeAt` (same monotonic clock): what is left before it, less the
 * handover margin, at most APP_UNINSTALL_WIPE_BUDGET_MS and at least 0. With 0 the wipe deletes nothing; Windows'
 * uninstall, started by the handover, then finishes it from the intent.
 */
export function uninstallWipeBudget(failsafeAt: number, now: number): number {
  const left = failsafeAt - now - APP_UNINSTALL_HANDOVER_MARGIN_MS;
  return Number.isFinite(left) ? Math.max(0, Math.min(APP_UNINSTALL_WIPE_BUDGET_MS, left)) : 0;
}

export interface AppUninstallSetup {
  /** Pauses silent plugin setup and resolves once its run in flight and its registry writes have settled. */
  suspend(): Promise<void>;
  /** Lifts the pause; setup reads the registry again and runs. */
  resume(): void;
  /** The listed target id of a game folder, or undefined when the folder is not listed. */
  targetIdFor(game: PluginGame, root: string): string | undefined;
}
export interface AppUninstallPorts {
  resolveRoots(): Promise<UninstallRoots>;
  /** The native confirmation; true only for an explicit "Uninstall". */
  confirm(): Promise<boolean>;
  readonly fs: UninstallFileSystem & CancelFileSystem;
  readonly checkRunning: RunningCheck;
  /** The bundle's own and earlier released plugin hashes. */
  readKnown(): Promise<readonly string[]>;
  readonly setup: AppUninstallSetup;
  /** Monotonic milliseconds. */
  clock(): number;
  readonly delay?: (milliseconds: number) => Promise<void>;
  readonly now?: () => Date;
  /** Fixed codes and counts only. */
  log(event: string, facts: Record<string, string | number | boolean | null>): void;
  /** Starts `<installRoot>\Update.exe --uninstall` detached; true once the process has started. */
  startWindowsUninstall(installRoot: string): Promise<boolean>;
  /** ET-031: Removes the per-user autostart login item before handover. */
  readonly removeLoginItem?: (installRoot: string) => Promise<boolean> | boolean | void;
  /** The engine; tests replace it to inject failures. */
  readonly runUninstall?: (ports: UninstallPorts) => Promise<UninstallResult>;
}

/** What the exit's wipe needs, kept in main between `started` and the exit; it never reaches a renderer. */
export interface PreparedUninstall {
  readonly dataRoot: string;
  readonly installRoot: string;
  readonly notes: readonly {readonly game: PluginGame; readonly note: FolderNote}[];
  readonly removed: number;
  readonly unrecognized: number;
}
/** The result of the data wipe after the exit, for the result dialog. */
export interface FinishedUninstall {
  readonly data: UninstallResult['data'];
  readonly notes: PreparedUninstall['notes'];
  readonly removed: number;
  readonly unrecognized: number;
}

const ROOTS_FAILURES = new Set<UninstallFailureCode>(['ROOT_MISMATCH', 'LAYOUT_INVALID', 'DATA_ROOT_LINKED', 'TEST_ROOT_INVALID']);

export class AppUninstall {
  private busy = false;
  private preparedUninstall: PreparedUninstall | undefined;
  constructor(private readonly ports: AppUninstallPorts) {}

  /** Set once the plugins are removed and the exit may wipe the data; undefined before and after a refused run. */
  get prepared(): PreparedUninstall | undefined {return this.preparedUninstall;}
  /** True while a run is in progress or once one started the exit (ET-055: the in-app update is refused meanwhile). */
  get inProgress(): boolean {return this.busy || this.preparedUninstall !== undefined;}

  /** Runs steps 1 to 4; see the file comment. One run at a time; after `started` every further call is BUSY. */
  async run(): Promise<AppUninstallResult> {
    if (this.busy || this.preparedUninstall) return {outcome: 'failed', code: 'BUSY'};
    this.busy = true;
    try {return await this.steps();} finally {this.busy = false;}
  }

  private async steps(): Promise<AppUninstallResult> {
    const {ports} = this;
    const roots = await ports.resolveRoots().catch((): UninstallRoots => ({ok: false, code: 'NOT_INSTALLED'}));
    if (!roots.ok) {
      ports.log('APP_UNINSTALL', {outcome: roots.code === 'NOT_INSTALLED' ? 'not-installed' : 'failed', code: roots.code});
      return roots.code === 'NOT_INSTALLED' ? {outcome: 'not-installed'} : {outcome: 'failed', code: ROOTS_FAILURES.has(roots.code) ? roots.code : 'LAYOUT_INVALID'};
    }
    let confirmed: boolean;
    try {confirmed = await ports.confirm();} catch {return this.finish({outcome: 'failed', code: 'DIALOG_FAILED'});}
    if (!confirmed) return this.finish({outcome: 'cancelled'});

    const known = await ports.readKnown().catch((): readonly string[] => []);
    const engine = ports.runUninstall ?? runUninstall;
    const base = (scope: 'preflight' | 'plugins'): UninstallPorts => ({roots, fs: ports.fs, checkRunning: ports.checkRunning, known, clock: () => ports.clock(),
      deadline: ports.clock() + APP_UNINSTALL_STEP_BUDGET_MS, scope, ...(ports.delay ? {delay: ports.delay} : {}), ...(ports.now ? {now: ports.now} : {}),
      describeFolder: folder => ports.setup.targetIdFor(folder.game, folder.root) ?? uninstallOtherTarget(folder.game),
      log: (event, facts) => ports.log(event, facts)});

    // 3. The read-only preflight.
    let preflight: UninstallResult;
    try {preflight = await engine(base('preflight'));} catch {return this.finish({outcome: 'failed', code: 'ENGINE_FAILED'});}
    if (preflight.outcome === 'refused') return this.finish({outcome: 'failed', code: preflight.code === 'INTENT_FAILED' ? 'INTENT_FAILED' : 'LAYOUT_INVALID'});
    if (preflight.outcome === 'deferred') return this.finish(blockedResult(preflight));

    // 4. Setup paused, then the intent and the plugin removal.
    await ports.setup.suspend();
    let removal: UninstallResult;
    try {removal = await engine(base('plugins'));} catch {
      await this.abandon(roots.dataRoot);
      return this.finish({outcome: 'failed', code: 'ENGINE_FAILED'});
    }
    if (removal.outcome === 'refused') {
      await this.abandon(roots.dataRoot);
      return this.finish({outcome: 'failed', code: removal.code === 'INTENT_FAILED' ? 'INTENT_FAILED' : 'LAYOUT_INVALID'});
    }
    if (removal.outcome === 'deferred') {
      // A removal raced (a game started, a lock): no data is touched, the intent goes and setup, resumed, reinstalls the
      // plugin where this run already removed it. Only a run that removed nothing may say that nothing changed.
      await this.abandon(roots.dataRoot);
      const blocked = blockedResult(removal);
      return this.finish(removal.plugins.removed > 0 && blocked.outcome === 'blocked'
        ? {outcome: 'interrupted', code: blocked.code, removed: removal.plugins.removed, blocked: blocked.blocked} : blocked);
    }
    this.preparedUninstall = {dataRoot: roots.dataRoot, installRoot: roots.installRoot, notes: removal.plugins.notes, removed: removal.plugins.removed,
      unrecognized: removal.plugins.unrecognized};
    return this.finish({outcome: 'started'});
  }

  /** Removes the intent (this path writes no README; a leftover one goes too) and lets setup run again. */
  private async abandon(dataRoot: string): Promise<void> {
    await cancelDeferral(this.ports.fs, dataRoot).catch(() => 'failed');
    this.ports.setup.resume();
  }

  private finish(result: AppUninstallResult): AppUninstallResult {
    this.ports.log('APP_UNINSTALL', {outcome: result.outcome, code: 'code' in result ? result.code : null,
      blocked: 'blocked' in result ? result.blocked.length : 0, removed: result.outcome === 'interrupted' ? result.removed : 0});
    return result;
  }

  /** Step 7 of U8, after the result dialog: starts Windows' uninstall; false when nothing was prepared or it did not start. */
  handOver(): Promise<boolean> {return handOver(this, this.ports);}

  /**
   * After the exit stopped the service and every writer: wipes the data root (every allowlisted entry, then the registry,
   * then the intent and the empty root) within `budgetMs`, at most APP_UNINSTALL_WIPE_BUDGET_MS (main passes
   * uninstallWipeBudget). Entries the budget did not reach stay, with the intent, and are reported as BUDGET_EXPIRED.
   * Undefined when nothing was prepared.
   */
  async finishAfterExit(budgetMs = APP_UNINSTALL_WIPE_BUDGET_MS): Promise<FinishedUninstall | undefined> {
    const prepared = this.preparedUninstall;
    if (!prepared) return undefined;
    const budget = Number.isFinite(budgetMs) ? Math.max(0, Math.min(APP_UNINSTALL_WIPE_BUDGET_MS, budgetMs)) : 0;
    const deadline = this.ports.clock() + budget;
    let data: UninstallResult['data'];
    try {data = await wipeEverything(this.ports.fs, prepared.dataRoot, () => this.ports.clock() >= deadline, true);} catch {
      data = {removed: 0, kept: 0, failed: [{entry: 'data', code: 'IO_ERROR'}], rootRemoved: false};
    }
    return {data, notes: prepared.notes, removed: prepared.removed, unrecognized: prepared.unrecognized};
  }
}

/** Step 7 of U8, after the result dialog: hands over to Windows' uninstall. False when nothing was prepared or it did not start. */
export async function handOver(uninstall: AppUninstall, ports: Pick<AppUninstallPorts, 'startWindowsUninstall' | 'removeLoginItem'>): Promise<boolean> {
  const prepared = uninstall.prepared;
  if (!prepared) return false;
  if (ports.removeLoginItem) {
    try {await ports.removeLoginItem(prepared.installRoot);} catch {/* best effort */}
  }
  return ports.startWindowsUninstall(prepared.installRoot).catch(() => false);
}

function blockedResult(result: UninstallResult): AppUninstallResult {
  const code = (result.code ?? 'RUNNING_CHECK_FAILED') as UninstallBlockCode;
  return {outcome: 'blocked', code, blocked: result.plugins.blocked.map(entry => ({targetId: entry.id ?? uninstallOtherTarget(entry.game),
    reason: entry.reason}))};
}
