import {randomUUID} from 'node:crypto';
import {ProfileVerificationError, ProfileSettingsUnavailableError, UnchangedVerificationError, type ProfileDiagnosticCode, type TimedHardModeObservation} from './reader';
import type {HardModeDiagnosticCode, HardModeObservation, HardModeStatus, HardModeVerification, HardModeVerificationReason, HardModeVerificationResult} from '../../../../packages/contracts/src/hard-mode';
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
/** The reader's failure codes as the fixed reasons the page may show; the codes themselves stay in the service. */
const FAILURE_REASONS: Partial<Record<ProfileDiagnosticCode, HardModeVerificationReason>> = {
  PROFILE_SOURCE_UNPROVEN: 'game-process', PROFILE_PROCESS_QUERY_FAILED: 'game-process', PROFILE_PROCESS_QUERY_DEADLINE: 'game-process', PROFILE_PROCESS_QUERY_INVALID: 'game-process',
  PROFILE_PROCESS_UNPROVEN: 'game-process', PROFILE_PROCESS_CHANGED: 'game-process', PROFILE_LOG_GENERATION: 'game-log', PROFILE_LOG_CHANGED: 'game-log',
  PROFILE_SELECTION_UNPROVEN: 'profile-selection', PROFILE_LOCATION_UNPROVEN: 'profile-files', PROFILE_SETTINGS_UNAVAILABLE: 'settings-read',
  PROFILE_DEADLINE: 'timeout', PROFILE_CANCELLED: 'timeout', PROFILE_EPOCH_RETIRED: 'timeout', PROFILE_PROBE_PENDING: 'timeout', PROFILE_PROBE_EXPIRED: 'timeout', PROFILE_PROOF_EXPIRED: 'timeout'
};
/**
 * ET-112d: whether the current observation comes from a verified profile. No game is waiting, never unverified; a bound
 * observation is verified whatever its rules say; a source or settings transition is still checking; otherwise the
 * profile could not be verified, for the reason of the last failed read.
 */
export function hardModeVerificationResult(hasSource: boolean, observation: HardModeObservation, failure?: ProfileDiagnosticCode): HardModeVerificationResult {
  if (!hasSource) return {state: 'waiting', reason: 'no-game'};
  if (observation.binding !== null || observation.assessment.state !== 'unknown') return {state: 'verified', reason: null};
  const diagnostic = observation.diagnostic;
  if (diagnostic === 'session-transition' || diagnostic === 'settings-changing' || diagnostic === 'source-changed') return {state: 'waiting', reason: 'checking'};
  if (diagnostic === 'guard-deadline') return {state: 'unverified', reason: 'timeout'};
  const reason = failure === undefined ? undefined : FAILURE_REASONS[failure];
  return {state: 'unverified', reason: reason ?? (diagnostic === 'settings-unavailable' ? 'settings-read' : 'timeout')};
}
export class HardModeMonitor {
  private readonly producer = randomUUID();
  private sequence = 0;
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
  private manualPending = false;
  private forced = false;
  private activeEpoch = 0;
  private manualTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private followup = false;
  /** The last failed read's code, cleared by any read that completes; it never leaves the service. */
  private failure: ProfileDiagnosticCode | undefined;
  private manualChecking = false;
  private lastCheck: HardModeVerification['lastCheck'] = null;
  private pendingProof: {value: HardModeObservation; completedClientNs: bigint; deadlineClientNs: bigint; resolve: () => void; publish: (value: HardModeObservation, at: bigint) => void} | undefined;
  private bindProof(): void {
    if (this.guard && !this.guard.eligible()) {this.retireProof(); return;}
    const pending = this.pendingProof, current = this.source, boundary = current?.boundary;
    if (pending && this.nowNs() >= pending.deadlineClientNs) {pending.publish(this.unknown('guard-deadline'), this.nowNs()); this.retireProof(); return;}
    if (!pending || !boundary || boundary.clockId !== current?.clockId || BigInt(boundary.probeSentClientNs) <= pending.completedClientNs) return;
    this.pendingProof = undefined;
    this.expireCoverage();
    if (BigInt(boundary.receivedSourceNs) >= 18446744073709551615n) this.publish(this.unknown());
    else pending.publish({...pending.value, sourceMonotonicNs: (BigInt(boundary.receivedSourceNs) + 1n).toString()}, pending.completedClientNs);
    pending.resolve();
  }
  private retireProof(): void {const pending = this.pendingProof; this.pendingProof = undefined; pending?.resolve();}
  private timer: ReturnType<typeof setTimeout> | undefined;
  private healthTimer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  constructor(private readonly read: (source: SourceIdentity, monotonicNs: string, atUtcMs: number, signal: AbortSignal, force?: boolean) => Promise<HardModeObservation | TimedHardModeObservation>,
    private readonly changed: (value: HardModeObservation) => void = () => undefined, private readonly nowNs: () => bigint = () => process.hrtime.bigint(),
    private readonly requestFull: () => void = () => undefined, private readonly retain: () => boolean = () => false,
    private readonly publishHealth: () => void = () => undefined, private readonly drain: () => Promise<void> = () => Promise.resolve(),
    private readonly guard?: {eligible: () => boolean; select: (key: string | undefined) => void; deadline?: (source: SourceIdentity) => Error | undefined}) {}
  private unknown(diagnostic: HardModeDiagnosticCode = 'profile-verification'): HardModeObservation {return {diagnostic, assessment: unknownHardMode(Date.now()), binding: null, pluginSessionId: null, sourceMonotonicNs: null};}
  private publish(value: HardModeObservation, observedClientNs = this.nowNs()): void {this.observation = value; this.observedClientNs = observedClientNs; this.healthNs = this.nowNs(); this.changed(value);}
  private expired(): boolean {return this.observedClientNs === undefined || this.nowNs() < this.observedClientNs;}
  private expireCoverage(): void {
    if (this.guard && !this.guard.eligible()) {
      this.retireProof();
      if (this.observation.binding !== null || this.observation.assessment.state !== 'unknown') this.publish(this.unknown());
    }
    if (this.observation.binding !== null && this.expired()) this.publish(this.unknown());
  }
  invalidate(diagnostic: HardModeDiagnosticCode = 'settings-changing'): void {this.followup ||= this.inFlight !== undefined; this.retireProof(); this.publish(this.unknown(diagnostic));}
  select(next: MonitorSource | null): void {
    if (this.closed) return;
    this.guard?.select(next ? profileSourceKey(next) : undefined);
    const before = this.source?.source, after = next?.source;
    const previousClock = this.source?.clockId, previousGameClock = this.source?.gameClockId;
    this.source = next;
    if (previousClock === next?.clockId && previousGameClock === next?.gameClockId && before?.pluginSessionId === after?.pluginSessionId && before?.processInstanceId === after?.processInstanceId && before?.processId === after?.processId && before?.windowsSessionId === after?.windowsSessionId && before?.game === after?.game && before?.origin === after?.origin) {this.bindProof(); return;}
    const key = next ? profileSourceKey(next) : undefined;
    if (key !== undefined && key !== this.cadenceKey) {this.lastScanNs = undefined; this.cadenceKey = key;}
    this.epoch++; this.followup = false; this.manualPending = false; clearTimeout(this.manualTimer); this.manualTimer = undefined;
    // A source change ends a manual check without a result; the new source has no failed read yet.
    this.manualChecking = false; this.failure = undefined;
    this.controller?.abort(); this.retireProof(); this.publish(this.unknown('session-transition'));
    const epoch = this.epoch, draining = this.inFlight;
    if (draining) void draining.finally(() => {if (epoch === this.epoch && this.source) void this.refresh(this.manualPending);});
    else void this.refresh();
  }
  evidence(): HardModeObservation {
    this.expireCoverage();
    if (this.expired()) return this.unknown();
    return structuredClone(this.observation);
  }
  private verification(evidence: HardModeObservation): HardModeVerification {
    return {...hardModeVerificationResult(this.source !== null, evidence, this.failure), checking: this.manualChecking, lastCheck: this.lastCheck && {...this.lastCheck}};
  }
  publication(): Extract<HardModeServiceMessage, {update: 'assessment'}> {
    const age = this.healthNs === undefined ? -1n : this.nowNs() - this.healthNs;
    const remaining = age >= 0n && age < HARD_MODE_COVERAGE_NS ? HARD_MODE_COVERAGE_NS - age : 0n;
    const evidence = this.evidence();
    return {type: 'hard-mode', update: 'assessment', assessment: evidence.assessment, verification: this.verification(evidence), remainingNs: remaining.toString()};
  }
  status(): HardModeStatus {const evidence = this.evidence(); return {assessment: evidence.assessment, trip: null, verification: this.verification(evidence)};}
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
    if (this.closed) return Promise.resolve();
    this.expireCoverage();
    // A manual check shows its progress at once; without a game it completes at once as waiting for one.
    if (manual && !this.source) {this.lastCheck = {atUtcMs: Date.now(), state: 'waiting', reason: 'no-game'}; this.manualChecking = false; this.publishHealth();}
    else if (manual && !this.manualChecking) {this.manualChecking = true; this.publishHealth();}
    if (this.inFlight) {if (manual && (!this.forced || this.activeEpoch !== this.epoch)) this.manualPending = true; return this.inFlight;}
    const current = this.source;
    if (!current) return Promise.resolve();
    if (manual && this.lastManualNs !== undefined && this.nowNs() - this.lastManualNs < 1_000_000_000n) {
      this.manualPending = true;
      if (!this.manualTimer) {
        const epoch = this.epoch, remaining = this.lastManualNs + 1_000_000_000n - this.nowNs();
        this.manualTimer = setTimeout(() => {this.manualTimer = undefined; if (epoch === this.epoch && this.manualPending) void this.refresh(true);}, Math.ceil(Number(remaining) / 1_000_000));
        this.manualTimer.unref();
      }
      return Promise.resolve();
    }
    if (!manual && !followup && this.lastScanNs !== undefined && this.nowNs() - this.lastScanNs < BigInt(HARD_MODE_POLL_MS) * 1_000_000n) return Promise.resolve();
    if (manual) {this.lastManualNs = this.nowNs(); this.manualPending = false; clearTimeout(this.manualTimer); this.manualTimer = undefined; this.requestFull();}
    this.forced = manual;
    const startedNs = this.nowNs();
    if (!manual && !followup) this.lastScanNs = startedNs;
    let counted = false;
    const complete = (value: HardModeObservation, at = this.nowNs()) => {
      const plain = {...value}; delete plain.check;
      if (!manual && !followup && !counted) {counted = true; this.publish({...plain, pluginSessionId: plain.pluginSessionId ?? current.source.pluginSessionId, check: {producer: this.producer, sequence: ++this.sequence}}, at);}
      else this.publish(plain, at);
    };
    let deadlineClientNs = startedNs + BigInt(HARD_MODE_DEADLINE_MS) * 1_000_000n;
    const epoch = this.epoch, controller = this.controller = new AbortController();
    this.activeEpoch = epoch;
    const expire = () => {controller.abort(this.guard?.deadline?.(current.source)); if (epoch === this.epoch) {if (!this.retain()) complete(this.unknown('guard-deadline')); this.retireProof();}};
    let deadline = setTimeout(expire, HARD_MODE_DEADLINE_MS);
    this.inFlight = this.read(current.source, current.monotonicNs, Date.now(), controller.signal, manual).then(result => {
      if (controller.signal.aborted || epoch !== this.epoch || this.guard && !this.guard.eligible()) return;
      this.failure = undefined;
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
          complete({...value, sourceMonotonicNs: this.observation.sourceMonotonicNs});
          return;
        }
        if (this.observation.binding !== null && this.observation.binding !== value.binding) this.publish(this.unknown());
        if (value.assessment.state !== 'pass') {complete({...value, sourceMonotonicNs: null}); return;}
        // A source receipt of a probe sent after the file read is a causal boundary, without clock-origin mapping.
        return new Promise<void>(resolve => {
          this.pendingProof = {value, completedClientNs: completed, deadlineClientNs, resolve, publish: complete};
          this.bindProof();
        });
      }
    }, error => {if (epoch !== this.epoch) return;
      this.failure = error instanceof ProfileVerificationError && !(error instanceof UnchangedVerificationError) ? error.code : undefined;
      if (error instanceof UnchangedVerificationError) {complete(this.observation); return;}
      complete(this.unknown(error instanceof ProfileVerificationError && error.code === 'PROFILE_DEADLINE' ? 'guard-deadline' : error instanceof ProfileSettingsUnavailableError || !(error instanceof ProfileVerificationError) ? 'settings-unavailable' : 'profile-verification'));
    }).finally(async () => {
      clearTimeout(deadline);
      // Cancellation/read completion can precede physical close. Manual intent owns a new full operation after drain,
      // even when the previous reader already settled before its monitor's causal probe arrived.
      await this.drain();
      this.inFlight = undefined; this.forced = false;
      const requested = this.followup; this.followup = false;
      // A manual check ends with its own result unless another manual run follows it; manual runs never count a check.
      if (manual && epoch === this.epoch && !this.manualPending && !this.closed) {
        this.lastCheck = {atUtcMs: Date.now(), ...hardModeVerificationResult(this.source !== null, this.evidence(), this.failure)};
        this.manualChecking = false; this.publishHealth();
      }
      if (epoch === this.epoch && this.source && !this.closed) {
        if (this.manualPending) return this.refresh(true, true);
        if (requested && !followup && !manual) return this.refresh(false, true);
      }
    });
    return this.inFlight;
  }
  close(): void {this.closed = true; this.guard?.select(undefined); this.started = false; clearTimeout(this.timer); clearTimeout(this.manualTimer); clearInterval(this.healthTimer); this.timer = undefined; this.manualTimer = undefined; this.healthTimer = undefined; this.manualPending = false; this.manualChecking = false; this.epoch++; this.controller?.abort(); this.retireProof(); this.publish(this.unknown('session-transition'));}
}
