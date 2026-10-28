import path from 'node:path';
import type {UpdateFailure, UpdateRefusal, UpdateView} from '../../../../packages/contracts/src/app-state';
import type {ChannelIdentity} from '../channel';
import type {DiagnosticFacts} from '../diagnostics';
import type {FixedProgramResult} from '../plugin-setup/fixed-program';
import type {RunningGames} from '../plugin-setup/game-processes';
import type {UpdateContext, UpdateContextResult} from './update-context';
import {clearUpdates, downloadPackage, type UpdateFileSystem} from './update-download';
import {checkFeed, type FeedResult, type FeedTimers, type FetchPort} from './update-feed';
import type {UpdateManifest} from './update-manifest';
import {UNSUPPORTED_UPDATE} from './update-view';

// The in-app update controller in main (ET-055 UP2, UP3, UP6–UP9; docs/app-lifecycle.md, "In-app updates"). The view
// is a pure reducer (reduceUpdate); the controller runs the effects through ports, so it is testable without Electron:
//
//   scheduled or manual check -> checking -> feed -> verified manifest -> available (or idle)
//   click -> running-game check -> downloading (verified) -> installing (Update.exe --update) -> running-game check
//         -> restarting -> the explicit exit with reason `update` -> the restart helper (main) -> exit
//
// Checks start 15 s after start() and then every 6 h; their failures stay silent (the view stays or becomes idle and only
// `lastCheck` says `failed`). Nothing downloads before the user's click. A click is refused while a game or TruckersMP
// runs or the listing fails (fail closed), while the exit runs, and while an uninstall or this update's own check runs.
// When the exit begins (retire) a check or download stops and the download's `.partial` is removed; a running
// `Update.exe --update` is never interrupted.

export const FIRST_CHECK_DELAY_MS = 15_000;
export const CHECK_INTERVAL_MS = 6 * 60 * 60_000;
/** A manual check within this long of the previous check's start does nothing (bounds the REST rate limit, UP6). */
export const MANUAL_CHECK_MIN_INTERVAL_MS = 10_000;
/** The apply's deadline (UP3). */
export const APPLY_TIMEOUT_MS = 180_000;

export type UpdateEvent =
  | {readonly type: 'supported'}
  | {readonly type: 'check-started'}
  | {readonly type: 'check-finished'; readonly outcome: 'up-to-date' | 'available' | 'failed'; readonly version?: string; readonly failure?: UpdateFailure; readonly atUtcMs: number}
  | {readonly type: 'refused'; readonly code: UpdateRefusal}
  | {readonly type: 'download-started'}
  | {readonly type: 'progress'; readonly percent: number}
  | {readonly type: 'installing'}
  | {readonly type: 'ready'}
  | {readonly type: 'restarting'}
  | {readonly type: 'failed'; readonly failure: UpdateFailure}
  | {readonly type: 'aborted'};

/** States from which the offered update can be clicked; a background check keeps them. */
const OFFERED = new Set<UpdateView['state']>(['available', 'refused', 'failed']);

/** The update view after `event`; an event that does not apply to the current state leaves it unchanged. */
export function reduceUpdate(view: UpdateView, event: UpdateEvent): UpdateView {
  const state = view.state;
  switch (event.type) {
    case 'supported':
      return state === 'unsupported' ? {...UNSUPPORTED_UPDATE, state: 'idle'} : view;
    case 'check-started':
      return state === 'idle' ? {...view, state: 'checking'} : view;
    case 'check-finished': {
      if (state === 'unsupported') return view;
      const lastCheck = {outcome: event.outcome, failure: event.outcome === 'failed' ? event.failure ?? 'OFFLINE' : null, atUtcMs: event.atUtcMs};
      const offered = event.outcome === 'available' ? event.version : undefined;
      if (state === 'checking') return offered !== undefined ? {...view, state: 'available', available: offered, lastCheck} : {...view, state: 'idle', lastCheck};
      if (OFFERED.has(state)) {
        if (event.outcome === 'up-to-date') return {...UNSUPPORTED_UPDATE, state: 'idle', lastCheck};
        if (offered !== undefined && offered !== view.available) return {...view, state: 'available', available: offered, refusal: null, failure: null, lastCheck};
      }
      return {...view, lastCheck};
    }
    case 'refused':
      if (OFFERED.has(state)) return {...view, state: 'refused', refusal: event.code, failure: null};
      return state === 'ready' ? {...view, refusal: event.code} : view;
    case 'download-started':
      return OFFERED.has(state) ? {...view, state: 'downloading', progress: 0, refusal: null, failure: null} : view;
    case 'progress': {
      const progress = Math.max(0, Math.min(100, Math.floor(event.percent)));
      return state === 'downloading' && progress !== view.progress ? {...view, progress} : view;
    }
    case 'installing':
      return state === 'downloading' ? {...view, state: 'installing', progress: null} : view;
    case 'ready':
      return state === 'installing' ? {...view, state: 'ready', refusal: null} : view;
    case 'restarting':
      return state === 'installing' || state === 'ready' ? {...view, state: 'restarting', refusal: null} : view;
    case 'failed':
      return state === 'downloading' || state === 'installing' ? {...view, state: 'failed', progress: null, failure: event.failure} : view;
    case 'aborted':
      return state === 'downloading' ? {...view, state: 'available', progress: null} : view;
  }
}

export interface UpdateClock extends FeedTimers {
  /** Monotonic milliseconds. */
  now(): number;
  /** UTC epoch milliseconds, only as the label of the last check. */
  utcNow(): number;
}
export type RunningCheck = {readonly ok: true; readonly running: RunningGames} | {readonly ok: false};
export interface UpdatePorts {
  /** Whether this launch checks, and its install, data root, feed and keys (update-context.ts). */
  resolveContext(): Promise<UpdateContextResult>;
  readonly fetch: FetchPort;
  readonly fs: UpdateFileSystem;
  /** Runs `Update.exe --update <folder>` with fixed arguments under the 180 s deadline; never aborted by the exit. */
  runUpdate(updateExe: string, folder: string): Promise<FixedProgramResult>;
  /** The running-game listing (ETS2, ATS, `truckersmp*`). */
  checkRunning(): Promise<RunningCheck>;
  readonly clock: UpdateClock;
}
export interface UpdateControllerOptions {
  readonly identity: ChannelIdentity;
  /** This build's application version. */
  readonly currentVersion: string;
  readonly ports: UpdatePorts;
  log(event: string, facts?: DiagnosticFacts): void;
  /** The view changed. */
  changed(): void;
  /** True once any exit has begun. */
  exiting(): boolean;
  /** True while the in-app uninstall runs or is prepared. */
  uninstalling(): boolean;
  /** Requests the explicit exit with reason `update`. */
  requestExit(): void;
}

const runningRefusal = (check: RunningCheck): UpdateRefusal | undefined =>
  !check.ok ? 'GAME_CHECK_FAILED' : check.running.ets2 || check.running.ats || check.running.client ? 'GAME_RUNNING' : undefined;

/** See the file comment. One instance per application run. */
export class UpdateController {
  private current: UpdateView = UNSUPPORTED_UPDATE;
  private context: UpdateContext | undefined;
  private offer: {readonly manifest: UpdateManifest; readonly packageUrl: string} | undefined;
  private started = false;
  private retired = false;
  private timer: unknown;
  private checkAbort: AbortController | undefined;
  private checkStartedAt = -Infinity;
  private clicking = false;
  private operation: Promise<void> | undefined;
  private downloadAbort: AbortController | undefined;
  constructor(private readonly options: UpdateControllerOptions) {}

  get view(): UpdateView {return this.current;}
  /** The restart helper's target, only while the controller has requested its exit (`restarting`). */
  get restartTarget(): {readonly installRoot: string; readonly executableName: string} | undefined {
    return this.current.state === 'restarting' && this.context ? {installRoot: this.context.installRoot, executableName: this.context.executableName} : undefined;
  }

  /** Resolves the context once; a supported launch removes stale downloads and schedules the first check in 15 s. */
  start(): void {
    if (this.started || this.retired) return;
    this.started = true;
    void this.options.ports.resolveContext().then(async result => {
      if (this.retired) return;
      // A development run is the common unsupported case and logs nothing.
      if (!result.ok) {if (result.reason !== 'unpackaged') this.options.log('UPDATE_UNSUPPORTED', {reason: result.reason}); return;}
      this.context = result.context;
      this.dispatch({type: 'supported'});
      this.options.log('UPDATE_SUPPORTED', {mode: result.context.mode, channel: this.options.identity.channel});
      if (!(await clearUpdates(this.options.ports.fs, result.context.dataRoot))) this.options.log('UPDATE_STALE_NOT_REMOVED');
      if (!this.retired) this.schedule(FIRST_CHECK_DELAY_MS);
    }, () => {if (!this.retired) this.options.log('UPDATE_UNSUPPORTED', {reason: 'context-failed'});});
  }

  /** A manual check (Settings → About): runs unless a check or an update runs or one started within 10 s. */
  check(): UpdateView {
    if (this.options.ports.clock.now() - this.checkStartedAt >= MANUAL_CHECK_MIN_INTERVAL_MS) this.runCheck('manual');
    return this.current;
  }

  /** The user's click: the update in an offered state, the restart in `ready`; see the file comment. */
  async apply(): Promise<UpdateView> {
    const state = this.current.state;
    if (state !== 'ready' && (!OFFERED.has(state) || !this.offer)) return this.current;
    if (this.retired || this.options.exiting()) {this.dispatch({type: 'refused', code: 'EXITING'}); return this.current;}
    if (this.clicking) return this.current;
    if (this.options.uninstalling() || (state !== 'ready' && this.checkAbort)) {this.dispatch({type: 'refused', code: 'BUSY'}); return this.current;}
    this.clicking = true;
    let running: RunningCheck;
    try {running = await this.options.ports.checkRunning().catch((): RunningCheck => ({ok: false}));} finally {this.clicking = false;}
    if (this.retired || this.options.exiting()) {this.dispatch({type: 'refused', code: 'EXITING'}); return this.current;}
    const refusal = runningRefusal(running);
    if (refusal) {this.options.log('UPDATE_REFUSED', {code: refusal}); this.dispatch({type: 'refused', code: refusal}); return this.current;}
    if (state === 'ready') {this.restart(); return this.current;}
    const offer = this.offer;
    if (!offer || !OFFERED.has(this.current.state)) return this.current;
    this.dispatch({type: 'download-started'});
    this.options.log('UPDATE_DOWNLOAD_STARTED');
    this.operation = this.downloadAndApply(this.context!, offer).catch(() => {
      this.options.log('UPDATE_OPERATION_FAILED');
      this.dispatch({type: 'failed', failure: this.current.state === 'installing' ? 'APPLY_FAILED' : 'DOWNLOAD_FAILED'});
    }).finally(() => {this.operation = undefined;});
    return this.current;
  }

  /**
   * The exit began: no new check or click, the timer stops, a check or download is aborted (its `.partial` removed). A
   * running `Update.exe --update` is not touched. Idempotent.
   */
  retire(): void {
    if (this.retired) return;
    this.retired = true;
    if (this.timer !== undefined) this.options.ports.clock.clearTimeout(this.timer);
    this.timer = undefined;
    this.checkAbort?.abort();
    this.downloadAbort?.abort();
  }

  /** The download's cleanup in flight after retire, which the exit waits for within its idle budget; undefined when idle. */
  idle(): Promise<void> | undefined {
    return this.downloadAbort ? this.operation : undefined;
  }

  private dispatch(event: UpdateEvent): void {
    const next = reduceUpdate(this.current, event);
    if (next === this.current) return;
    this.current = next;
    this.options.changed();
  }

  private schedule(delayMs: number): void {
    this.timer = this.options.ports.clock.setTimeout(() => {
      this.timer = undefined;
      if (this.retired) return;
      this.runCheck('scheduled');
      this.schedule(CHECK_INTERVAL_MS);
    }, delayMs);
  }

  private runCheck(origin: 'scheduled' | 'manual'): void {
    const context = this.context, state = this.current.state;
    if (!context || this.retired || this.options.exiting() || this.checkAbort || this.clicking || this.operation) return;
    if (state !== 'idle' && !OFFERED.has(state)) return;
    const abort = this.checkAbort = new AbortController();
    this.checkStartedAt = this.options.ports.clock.now();
    this.dispatch({type: 'check-started'});
    const {fetch, clock} = this.options.ports;
    void checkFeed({fetch, origins: context.origins, identity: this.options.identity, keys: context.keys, currentVersion: this.options.currentVersion, timers: clock, signal: abort.signal})
      .catch((): FeedResult => ({outcome: 'failed', failure: 'MANIFEST_INVALID', code: 'CHECK_FAILED'}))
      .then(result => {
        if (this.checkAbort === abort) this.checkAbort = undefined;
        if (result.outcome === 'aborted' || this.retired) return;
        const atUtcMs = Math.max(0, Math.trunc(clock.utcNow()));
        this.options.log('UPDATE_CHECK', {origin, outcome: result.outcome, code: 'code' in result ? result.code : null});
        if (result.outcome === 'available') {
          // A newer offer replaces the earlier one; the same version keeps the state the user saw.
          if (this.current.available !== result.manifest.appVersion || !this.offer) this.offer = {manifest: result.manifest, packageUrl: result.packageUrl};
          this.dispatch({type: 'check-finished', outcome: 'available', version: result.manifest.appVersion, atUtcMs});
        } else if (result.outcome === 'up-to-date') {
          this.offer = undefined;
          this.dispatch({type: 'check-finished', outcome: 'up-to-date', atUtcMs});
        } else this.dispatch({type: 'check-finished', outcome: 'failed', failure: result.failure, atUtcMs});
      });
  }

  private async downloadAndApply(context: UpdateContext, offer: {readonly manifest: UpdateManifest; readonly packageUrl: string}): Promise<void> {
    const {ports} = this.options;
    const abort = this.downloadAbort = new AbortController();
    if (this.retired) abort.abort();
    const download = await downloadPackage({fetch: ports.fetch, fs: ports.fs, timers: ports.clock, dataRoot: context.dataRoot, manifest: offer.manifest,
      packageUrl: offer.packageUrl, signal: abort.signal, progress: percent => this.dispatch({type: 'progress', percent})});
    this.downloadAbort = undefined;
    if (!download.ok) {
      this.options.log(download.failure === 'ABORTED' ? 'UPDATE_DOWNLOAD_ABORTED' : 'UPDATE_DOWNLOAD_FAILED', {code: download.code});
      this.dispatch(download.failure === 'ABORTED' ? {type: 'aborted'} : {type: 'failed', failure: download.failure});
      return;
    }
    // The exit began after the download finished: nothing is installed, and nothing stays in `updates`.
    if (this.retired || this.options.exiting()) {
      await clearUpdates(ports.fs, context.dataRoot);
      this.options.log('UPDATE_DOWNLOAD_ABORTED', {code: 'EXITING'});
      this.dispatch({type: 'aborted'});
      return;
    }
    this.dispatch({type: 'installing'});
    this.options.log('UPDATE_APPLY_STARTED');
    const applied = await ports.runUpdate(path.win32.join(context.installRoot, 'Update.exe'), download.folder).catch((): FixedProgramResult => ({ok: false, failure: 'failed'}));
    if (!(await clearUpdates(ports.fs, context.dataRoot))) this.options.log('UPDATE_FOLDER_NOT_REMOVED');
    if (!applied.ok) {
      const failure: UpdateFailure = applied.failure === 'timeout' ? 'APPLY_TIMEOUT' : 'APPLY_FAILED';
      this.options.log('UPDATE_APPLY_FAILED', {code: failure, reason: applied.failure});
      this.dispatch({type: 'failed', failure});
      return;
    }
    this.offer = undefined;
    this.options.log('UPDATE_APPLIED', {version: offer.manifest.appVersion});
    // The games are checked again before the restart; a game that started meanwhile, a failed listing or an exit that
    // began during the apply leaves the update ready for the next start.
    const running = this.retired || this.options.exiting() ? undefined : await ports.checkRunning().catch((): RunningCheck => ({ok: false}));
    if (!running || runningRefusal(running) || this.retired || this.options.exiting()) {
      this.options.log('UPDATE_READY', {code: running ? runningRefusal(running) ?? 'EXITING' : 'EXITING'});
      this.dispatch({type: 'ready'});
      return;
    }
    this.restart();
  }

  private restart(): void {
    this.dispatch({type: 'restarting'});
    this.options.log('UPDATE_RESTART_REQUESTED');
    this.options.requestExit();
  }
}
