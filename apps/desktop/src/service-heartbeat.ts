/**
 * Telemetry service liveness heartbeat monitor (ET-036).
 *
 * Tracks periodic heartbeats from the utilityProcess service child. If no message
 * is received within HEARTBEAT_TIMEOUT_MS (5,000 ms), the service is considered hung
 * or stalled and onTimeout is triggered. When a stalled service emits a message again,
 * onResume is triggered.
 */

export const HEARTBEAT_INTERVAL_MS = 1000;
export const HEARTBEAT_TIMEOUT_MS = 5000;
export const STARTUP_TIMEOUT_MS = 15000;

export interface ServiceHeartbeatMonitorOptions {
  timeoutMs?: number;
  startupTimeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (timer: unknown) => void;
  onTimeout: () => void;
  onResume?: () => void;
}

export class ServiceHeartbeatMonitor {
  readonly timeoutMs: number;
  readonly startupTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly onTimeoutCallback: () => void;
  private readonly onResumeCallback?: () => void;

  private timer: unknown = undefined;
  private _timedOut = false;
  private _active = false;
  private _hasReceivedFirstMessage = false;

  constructor(options: ServiceHeartbeatMonitorOptions) {
    this.timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.setTimer = options.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = options.clearTimeout ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.onTimeoutCallback = options.onTimeout;
    this.onResumeCallback = options.onResume;
  }

  get isTimedOut(): boolean {
    return this._timedOut;
  }

  get isActive(): boolean {
    return this._active;
  }

  /**
   * Starts monitoring liveness for an attached service child.
   * Arms with the startup deadline (15,000 ms) until the first message is received.
   */
  start(): void {
    this.stop();
    this._active = true;
    this._timedOut = false;
    this._hasReceivedFirstMessage = false;
    this.arm(this.startupTimeoutMs);
  }

  /**
   * Records receipt of any message from the monitored service child, proving event loop liveness.
   * Transitions to the steady-state deadline (5,000 ms) and fires onResume if previously timed out.
   */
  touch(): void {
    if (!this._active) return;
    this._hasReceivedFirstMessage = true;
    const wasTimedOut = this._timedOut;
    this._timedOut = false;
    this.arm(this.timeoutMs);
    if (wasTimedOut) {
      this.onResumeCallback?.();
    }
  }

  /**
   * Alias for touch().
   */
  refresh(): void {
    this.touch();
  }

  /**
   * Stops monitoring and cancels any pending timeout timers.
   */
  stop(): void {
    this._active = false;
    this._timedOut = false;
    this._hasReceivedFirstMessage = false;
    this.disarm();
  }

  private arm(delayMs: number): void {
    this.disarm();
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      if (!this._active) return;
      this._timedOut = true;
      this.onTimeoutCallback();
    }, delayMs);
  }

  private disarm(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }
}
