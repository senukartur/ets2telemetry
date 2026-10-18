import {RecoveryBudget} from './recovery-budget';
/** Main kills a service that has not exited this long after main posted `stop`; the service plans its exit within it. */
export const SERVICE_KILL_DEADLINE_MS = 3000;
/** Kept from the kill deadline for the `stop` message's delivery, the service's synchronous log write and its exit. */
export const SERVICE_EXIT_RESERVE_MS = 300;
/**
 * How long a stopping service may still let a log append in flight finish before its final synchronous write: the time
 * left until SERVICE_EXIT_RESERVE_MS before the kill deadline, measured from when the service received `stop`. The wait
 * therefore ends at most 2,700 ms after `stop` arrived; once that has passed it is 0 and the queue is written at once.
 */
export function stopTimeLeftMs(elapsedSinceStopMs: number): number {
  return Math.max(0, Math.round(SERVICE_KILL_DEADLINE_MS - SERVICE_EXIT_RESERVE_MS - elapsedSinceStopMs));
}
export interface SupervisedService {
  postMessage(message: {type: 'stop'}): void;
  kill(): boolean;
}

// Independent from Electron so shutdown races can be tested without launching the desktop.
export interface SupervisorRecovery {
  restart(): void;
  state(state: 'service-failed' | 'restarting'): void;
  exhausted(): void;
  /** A post-readiness service failure is being recovered by terminating the current service. */
  failure?(code: string): void;
  /** The supervisor starts stopping, orderly or fatal; called once, before the stop can finish. */
  stopping?(): void;
}
export class ServiceSupervisor {
  private service: SupervisedService | undefined;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private readySeen = false;
  /** The application has completed first readiness; later failures are recovered, not fatal. */
  private everReady = false;
  private recovering = false;
  private exited = false;
  private finished = false;
  private exitCode = 0;
  private readonly restartBudget = new RecoveryBudget();
  stopping = false;

  constructor(private readonly log: (event: string, detail?: unknown) => void,
    private readonly exit: (code: number) => void,
    private readonly recovery?: SupervisorRecovery) {}

  attach(service: SupervisedService): void {
    this.exited = false; this.readySeen = false; this.recovering = false;
    this.service = service;
    this.timers.push(setTimeout(() => this.serviceFailed('SERVICE_START_TIMEOUT'), 15000));
    this.log('SERVICE_START_REQUESTED');
  }

  ready(): boolean {
    if (this.stopping || this.readySeen || this.recovering) return false;
    this.readySeen = true; this.everReady = true;
    this.clearTimers();
    this.log('SERVICE_READY');
    return true;
  }

  /**
   * A service failure report or start timeout. Before first readiness it remains fatal, as before.
   * Afterwards, with recovery configured, the current service is terminated and its exit drives the
   * existing bounded restart; an exit that does not follow within 3000 ms is fatal.
   */
  serviceFailed(code: string, detail?: unknown): void {
    if (this.finished || this.stopping) return;
    if (!this.recovery || !this.everReady || !this.service || this.exited) {this.fail(code, detail); return;}
    if (this.recovering) return;
    this.recovering = true; this.readySeen = false;
    this.clearTimers();
    this.log(code, detail);
    this.recovery.failure?.(code);
    this.timers.push(setTimeout(() => this.fail('SERVICE_RECOVERY_TIMEOUT'), 3000));
    try {if (!this.service.kill()) this.log('SERVICE_KILL_REJECTED');}
    catch (error) {this.log('SERVICE_KILL_FAILED', error);}
  }

  fail(code: string, detail?: unknown): void {
    if (this.finished) return;
    this.exitCode = 1;
    this.log(code, detail);
    this.stop();
  }

  serviceExited(code: number): void {
    this.exited = true;
    this.log('SERVICE_EXIT', {code});
    if (!this.stopping && this.recovery) {
      this.clearTimers(); this.readySeen = false; this.recovering = false; this.recovery.state('service-failed');
      const attempt = this.restartBudget.take();
      if (attempt !== undefined) {
        const delay = attempt === 1 ? 250 : 1000;
        this.recovery.state('restarting');
        this.timers.push(setTimeout(() => {if (!this.stopping) this.recovery!.restart();}, delay));
      } else this.recovery.exhausted();
      return;
    }
    if (!this.stopping || code !== 0) this.exitCode = 1;
    this.finish();
  }

  stop(): void {
    if (this.stopping || this.finished) return;
    this.stopping = true;
    this.clearTimers();
    this.log('APP_STOP_REQUESTED');
    this.recovery?.stopping?.();
    if (!this.service || this.exited) {this.finish(); return;}
    // Arm both deadlines before IPC. A failed send/kill cannot cancel the final deadline.
    this.timers.push(setTimeout(() => {
      this.exitCode = 1;
      this.log('SERVICE_STOP_TIMEOUT');
      try {if (!this.service?.kill()) this.log('SERVICE_KILL_REJECTED');}
      catch (error) {this.log('SERVICE_KILL_FAILED', error);}
    }, SERVICE_KILL_DEADLINE_MS));
    this.timers.push(setTimeout(() => {this.exitCode = 1; this.finish();}, 5000));
    try {this.service.postMessage({type: 'stop'});}
    catch (error) {this.exitCode = 1; this.log('SERVICE_STOP_SEND_FAILED', error);}
  }

  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.stopping = true;
    this.clearTimers();
    this.log('APP_EXIT', {code: this.exitCode});
    this.exit(this.exitCode);
  }
}
