import {UnchangedVerificationError, type TimedHardModeObservation} from './reader';
import type {HardModeObservation, HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {HARD_MODE_COVERAGE_NS, type HardModeServiceMessage} from './service-status';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
export const HARD_MODE_POLL_MS = 5000, HARD_MODE_DEADLINE_MS = 2000;
export interface MonitorSource {source: SourceIdentity; monotonicNs: string; clockId?: string; gameClockId?: string; boundary?: {clockId: string; probeSentClientNs: string; receivedSourceNs: string}}
/** Null/stale publications retire proof without turning an unchanged process into a new physical scan cadence. */
export function profileSourceKey(value: MonitorSource): string {
  const s = value.source;
  return JSON.stringify([s.game, s.origin, s.processId, s.windowsSessionId, s.processInstanceId, s.pluginSessionId, value.clockId, value.gameClockId]);
}
export class HardModeMonitor {
  private observation: HardModeObservation = this.unknown();
  private source: MonitorSource | null = null;
  private inFlight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private epoch = 0;
  private cadenceKey: string | undefined;
  private lastScanNs: bigint | undefined;
  private observedClientNs: bigint | undefined;
  private healthNs: bigint | undefined;
  private lastManualNs: bigint | undefined;
  private followup = false;
  private pendingProof: {value: HardModeObservation; completedClientNs: bigint; deadlineClientNs: bigint; resolve: () => void} | undefined;
  private bindProof(): void {
    const pending = this.pendingProof, current = this.source, boundary = current?.boundary;
    if (pending && this.nowNs() >= pending.deadlineClientNs) {this.retireProof(); this.publish(this.unknown()); return;}
    if (!pending || !boundary || boundary.clockId !== current?.clockId || BigInt(boundary.probeSentClientNs) <= pending.completedClientNs) return;
    this.pendingProof = undefined;
    this.expireCoverage();
    if (BigInt(boundary.receivedSourceNs) >= 18446744073709551615n) this.publish(this.unknown());
    else this.publish({...pending.value, sourceMonotonicNs: (BigInt(boundary.receivedSourceNs) + 1n).toString()}, pending.completedClientNs);
    pending.resolve();
  }
  private retireProof(): void {const pending = this.pendingProof; this.pendingProof = undefined; pending?.resolve();}
  private timer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  constructor(private readonly read: (source: SourceIdentity, monotonicNs: string, atUtcMs: number, signal: AbortSignal, force?: boolean) => Promise<HardModeObservation | TimedHardModeObservation>,
    private readonly changed: (value: HardModeObservation) => void = () => undefined, private readonly nowNs: () => bigint = () => process.hrtime.bigint(),
    private readonly requestFull: () => void = () => undefined, private readonly retain: () => boolean = () => false,
    private readonly publishHealth: () => void = () => undefined) {}
  private unknown(): HardModeObservation {return {assessment: unknownHardMode(Date.now()), binding: null, pluginSessionId: null, sourceMonotonicNs: null};}
  private publish(value: HardModeObservation, observedClientNs = this.nowNs()): void {this.observation = value; this.observedClientNs = observedClientNs; this.healthNs = this.nowNs(); this.changed(value);}
  private expired(): boolean {return this.observedClientNs === undefined || this.nowNs() < this.observedClientNs;}
  private expireCoverage(): void {if (this.observation.binding !== null && this.expired()) this.publish(this.unknown());}
  invalidate(): void {this.followup ||= this.inFlight !== undefined; this.retireProof(); this.publish(this.unknown());}
  select(next: MonitorSource | null): void {
    const before = this.source?.source, after = next?.source;
    const previousClock = this.source?.clockId, previousGameClock = this.source?.gameClockId;
    this.source = next;
    if (previousClock === next?.clockId && previousGameClock === next?.gameClockId && before?.pluginSessionId === after?.pluginSessionId && before?.processInstanceId === after?.processInstanceId && before?.processId === after?.processId && before?.windowsSessionId === after?.windowsSessionId && before?.game === after?.game && before?.origin === after?.origin) {this.bindProof(); return;}
    const key = next ? profileSourceKey(next) : undefined;
    if (key !== undefined && key !== this.cadenceKey) {this.lastScanNs = undefined; this.cadenceKey = key;}
    this.epoch++; this.followup = false; this.controller?.abort(); this.retireProof(); this.publish(this.unknown());
    const epoch = this.epoch, draining = this.inFlight;
    if (draining) void draining.finally(() => {if (epoch === this.epoch && this.source) void this.refresh();});
    else void this.refresh();
  }
  evidence(): HardModeObservation {
    if (this.expired()) return this.unknown();
    return structuredClone(this.observation);
  }
  publication(): Extract<HardModeServiceMessage, {update: 'assessment'}> {
    const age = this.healthNs === undefined ? -1n : this.nowNs() - this.healthNs;
    const remaining = age >= 0n && age < HARD_MODE_COVERAGE_NS ? HARD_MODE_COVERAGE_NS - age : 0n;
    return {type: 'hard-mode', update: 'assessment', assessment: this.evidence().assessment, remainingNs: remaining.toString()};
  }
  status(): HardModeStatus {return {assessment: this.evidence().assessment, trip: null};}
  /** Memory-only service lease: it never changes the observation's timestamp or causal watermark. */
  heartbeat(): void {this.expireCoverage(); if (this.source) {this.healthNs = this.nowNs(); this.publishHealth();}}
  private scheduleGuard(): void {
    if (!this.started) return;
    clearTimeout(this.timer);
    const remaining = !this.source || this.lastScanNs === undefined ? HARD_MODE_POLL_MS
      : Math.ceil(Number(this.lastScanNs + BigInt(HARD_MODE_POLL_MS) * 1_000_000n - this.nowNs()) / 1_000_000);
    // Attachment/manual scans need not align with service startup. An early tick must re-arm for its real due time.
    this.timer = setTimeout(() => {this.timer = undefined; void this.refresh().finally(() => this.scheduleGuard());}, Math.max(0, Math.min(HARD_MODE_POLL_MS, remaining)));
    this.timer.unref();
  }
  start(): void {
    if (!this.started) {this.started = true; this.scheduleGuard();}
    this.healthTimer ??= setInterval(() => this.heartbeat(), 1000); this.healthTimer.unref();
  }
  refresh(manual = false, followup = false): Promise<void> {
    this.expireCoverage();
    if (this.inFlight) {if (manual) this.requestFull(); return this.inFlight;}
    const current = this.source;
    if (!current || !followup && (manual ? this.lastManualNs !== undefined && this.nowNs() - this.lastManualNs < 1_000_000_000n
      : this.lastScanNs !== undefined && this.nowNs() - this.lastScanNs < BigInt(HARD_MODE_POLL_MS) * 1_000_000n)) return Promise.resolve();
    if (manual) this.lastManualNs = this.nowNs();
    this.lastScanNs = this.nowNs();
    let deadlineClientNs = this.lastScanNs + BigInt(HARD_MODE_DEADLINE_MS) * 1_000_000n;
    const epoch = this.epoch, controller = this.controller = new AbortController();
    const expire = () => {controller.abort(); if (epoch === this.epoch) {if (!this.retain()) this.publish(this.unknown()); this.retireProof();}};
    let deadline = setTimeout(expire, HARD_MODE_DEADLINE_MS);
    this.inFlight = this.read(current.source, current.monotonicNs, Date.now(), controller.signal, manual).then(result => {
      if (controller.signal.aborted || epoch !== this.epoch) return;
      const value = 'observation' in result ? result.observation : result;
      const completed = 'timing' in result ? result.timing.completedClientNs : this.nowNs();
      if ('timing' in result) {
        deadlineClientNs = result.timing.startedClientNs + BigInt(HARD_MODE_DEADLINE_MS) * 1_000_000n;
        const remaining = deadlineClientNs - this.nowNs();
        clearTimeout(deadline);
        if (remaining <= 0n || completed > this.nowNs() || completed < result.timing.startedClientNs) {expire(); return;}
        deadline = setTimeout(expire, Number(remaining) / 1_000_000);
      }
      if (!controller.signal.aborted && epoch === this.epoch) {
        if (this.observation.binding !== null && this.observation.binding === value.binding
          && JSON.stringify(this.observation.assessment.rules) === JSON.stringify(value.assessment.rules)
          && this.observation.assessment.state === value.assessment.state) {
          if (this.observation.assessment.observedUtcMs !== value.assessment.observedUtcMs) this.publish({...value, sourceMonotonicNs: this.observation.sourceMonotonicNs});
          return;
        }
        if (this.observation.binding !== null && this.observation.binding !== value.binding) this.publish(this.unknown());
        if (value.assessment.state !== 'pass') {this.publish({...value, sourceMonotonicNs: null}); return;}
        // A source receipt of a probe sent after the file read is a causal boundary, without clock-origin mapping.
        return new Promise<void>(resolve => {
          this.pendingProof = {value, completedClientNs: completed, deadlineClientNs, resolve};
          this.bindProof();
        });
      }
    }, error => {if (epoch === this.epoch && !(error instanceof UnchangedVerificationError)) this.publish(this.unknown());}).finally(() => {
      clearTimeout(deadline); this.inFlight = undefined;
      const requested = this.followup; this.followup = false;
      if (requested && !followup && epoch === this.epoch && this.source) void this.refresh(false, true);
    });
    return this.inFlight;
  }
  close(): void {this.started = false; clearTimeout(this.timer); clearInterval(this.healthTimer); this.timer = undefined; this.healthTimer = undefined; this.epoch++; this.controller?.abort(); this.retireProof(); this.publish(this.unknown());}
}
