import type {DiagnosticFacts} from './diagnostics';

/** Every path to an orderly exit. Closing the main window is deliberately not one of them. */
export type ExitReason = 'tray' | 'renderer' | 'app-quit' | 'session-end' | 'uninstall';
export const EXIT_REASONS: readonly ExitReason[] = Object.freeze(['tray', 'renderer', 'app-quit', 'session-end', 'uninstall']);
/** An in-flight durable write (ET-011b settings) may delay the final exit by at most this long. */
export const EXIT_IDLE_BUDGET_MS = 1000;

/**
 * The one second-instance payload that is not a request to show the dashboard: the Squirrel uninstall hook asks the running
 * instance to run its explicit exit with reason `uninstall` (ET-018 U6). Only a plain object with exactly this key and
 * value matches; anything else, including an extra key, only shows the dashboard.
 */
export function isUninstallExitPayload(data: unknown): boolean {
  if (typeof data !== 'object' || data === null || Array.isArray(data) || Object.getPrototypeOf(data) !== Object.prototype) return false;
  const keys = Object.keys(data);
  return keys.length === 1 && keys[0] === 'ets2telemetry' && (data as Record<string, unknown>).ets2telemetry === 'uninstall-exit';
}

export type DashboardPresence = 'none' | 'minimized' | 'visible';
export type SecondInstanceAction = 'ignored-exiting' | 'ignored-starting' | 'restored' | 'focused' | 'created';
/**
 * Decides how the running instance answers a second launch. The second process's arguments, working
 * directory and data are never read. Before first readiness there is no window to show yet.
 */
export function secondInstanceAction(state: {exiting: boolean; started: boolean; dashboard: DashboardPresence}): SecondInstanceAction {
  if (state.exiting) return 'ignored-exiting';
  if (!state.started) return 'ignored-starting';
  if (state.dashboard === 'minimized') return 'restored';
  return state.dashboard === 'visible' ? 'focused' : 'created';
}

export interface ExitHooks {
  log(event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  /** Retire live consumers, hide the overlay and show the exiting state; runs once per request. */
  begin(reason: ExitReason): void;
  /** Starts the supervised service stop; its completion calls `finish`. */
  stopService(): void;
  /** Work that must settle before exit, such as an in-flight settings write; undefined when idle. */
  idle?(): Promise<void> | undefined;
  destroyTray(): void;
  exit(code: number): void;
}
export interface ExitTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
const systemTimers: ExitTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * One idempotent exit for the tray, the renderer, app.quit() and Windows session end. The service stop
 * and any pending idle work run in parallel; the process exits after the supervisor finishes and the
 * idle work settles or its 1000 ms budget expires. The tray icon is removed before the process exits.
 */
export class ExitCoordinator {
  private requested?: ExitReason;
  private idleWork?: Promise<void>;
  private idleTimer: unknown;
  private idleDone = true;
  private finishing = false;
  private aborted = false;
  private exitCode?: number;
  constructor(private readonly hooks: ExitHooks, private readonly timers: ExitTimers = systemTimers) {}

  /** True once any exit has started, including a fatal stop that is still running. */
  get exiting(): boolean {return this.requested !== undefined || this.aborted || this.finishing;}

  /**
   * A fatal stop that did not come through `request`: from now on the application is exiting, so nothing
   * reopens or keeps a window. Logs no exit request and calls no hook; returns whether it newly started exiting.
   */
  abort(): boolean {
    if (this.exiting) return false;
    this.aborted = true;
    return true;
  }
  get reason(): ExitReason | undefined {return this.requested;}

  request(reason: ExitReason): boolean {
    if (this.exiting) return false;
    this.requested = reason;
    this.hooks.log('APP_EXIT_REQUESTED', undefined, {reason});
    this.hooks.begin(reason);
    const work = this.hooks.idle?.();
    if (work) {
      this.idleDone = false;
      this.idleWork = work.then(() => undefined, () => undefined);
      this.idleTimer = this.timers.setTimeout(() => this.idleSettled(), EXIT_IDLE_BUDGET_MS);
      void this.idleWork.then(() => this.idleSettled());
    }
    this.hooks.stopService();
    return true;
  }

  /** The supervisor's final exit. Waits only for still-pending idle work, within its budget. */
  finish(code: number): void {
    if (this.exitCode !== undefined) return;
    this.finishing = true; this.exitCode = code;
    if (this.idleDone) this.complete();
  }

  private idleSettled(): void {
    if (this.idleDone) return;
    this.idleDone = true;
    if (this.idleTimer !== undefined) this.timers.clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    if (this.exitCode !== undefined) this.complete();
  }

  private complete(): void {
    try {this.hooks.destroyTray();} catch (error) {this.hooks.log('TRAY_DESTROY_REJECTED', String(error));}
    this.hooks.exit(this.exitCode!);
  }
}
