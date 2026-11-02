import type {ProfileObservation} from '../../../packages/telemetry-core/src/trips/continuation';
import type {MonitorSource} from './hard-mode/monitor';
import {ProfileVerificationError, type HardModeReader} from './hard-mode/reader';
import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v1';

/** A private file proof becomes usable only after a later probe receipt in the same source clock. */
export class ProfileObserver {
  private source: (MonitorSource & {gameClockId?:string}) | null = null;
  private epoch = 0;
  private controller: AbortController | undefined;
  private pending: {proof: ProfileObservation; completedNs: bigint; expiresNs: bigint} | undefined;
  private proof: {value: ProfileObservation; atNs: bigint} | undefined;
  private inFlight = false;
  private work: Promise<void> | undefined;
  private lastScan = -1n;
  private timer: ReturnType<typeof setInterval> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly reader: () => HardModeReader | undefined, private readonly nowNs = () => process.hrtime.bigint(), private readonly automatic = true) {}
  select(source: (MonitorSource & {gameClockId?:string}) | null): void {
    const before = this.source;
    this.source = source;
    if (before?.source.game !== source?.source.game || before?.source.origin !== source?.source.origin || before?.source.processId !== source?.source.processId || before?.source.windowsSessionId !== source?.source.windowsSessionId || before?.source.pluginSessionId !== source?.source.pluginSessionId || before?.source.processInstanceId !== source?.source.processInstanceId || before?.clockId !== source?.clockId || before?.gameClockId !== source?.gameClockId) {
      this.epoch++; this.controller?.abort(); clearTimeout(this.deadline); this.pending = undefined; this.proof = undefined;
    }
    if (this.pending && this.nowNs() >= this.pending.expiresNs) this.pending = undefined;
    const boundary = source?.boundary, pending = this.pending;
    if (pending && boundary && source?.clockId === boundary.clockId && BigInt(boundary.probeSentClientNs) > pending.completedNs) {
      this.pending = undefined; clearTimeout(this.deadline);
      if (BigInt(boundary.receivedSourceNs) < 18_446_744_073_709_551_615n) this.proof = {
        value: {...pending.proof, afterMonotonicNs: (BigInt(boundary.receivedSourceNs) + 1n).toString()}, atNs: pending.completedNs};
    }
    if (this.automatic) void this.refresh();
  }
  evidence(): ProfileObservation | undefined {
    const proof = this.proof;
    return proof && this.nowNs() >= proof.atNs && this.nowNs() - proof.atNs <= 3_000_000_000n ? structuredClone(proof.value) : undefined;
  }
  refresh(): Promise<void> {return this.work ??= this.scan().finally(()=>{this.work=undefined;});}
  /** The monitor's sole cadence also invalidates old proof when a later shared verification fails. */
  readSettings(reader: HardModeReader, source: SourceIdentity, ns: string, atUtcMs: number, signal: AbortSignal) {
    const epoch = this.epoch;
    void this.refresh();
    return reader.readTimed(source, ns, atUtcMs, signal, binding => {
      if (epoch === this.epoch && (this.pending && this.pending.proof.binding !== binding || this.proof && this.proof.value.binding !== binding)) {
        clearTimeout(this.deadline); this.pending = undefined; this.proof = undefined;
      }
    }).catch(error => {
      if (epoch === this.epoch && error instanceof ProfileVerificationError) {
        this.controller?.abort(); clearTimeout(this.deadline); this.pending = undefined; this.proof = undefined;
      }
      throw error;
    });
  }
  private async scan(): Promise<void> {
    const reader = this.reader(), source = this.source, now = this.nowNs();
    if (this.pending && now < this.pending.expiresNs) return;
    this.pending = undefined;
    if (!reader || !source?.clockId || this.inFlight || this.lastScan >= 0n && now - this.lastScan < 1_000_000_000n) return;
    this.lastScan = now; this.inFlight = true;
    const epoch = this.epoch, controller = this.controller = new AbortController();
    const expire = () => {controller.abort(); if (epoch === this.epoch) {this.proof = undefined; this.pending = undefined;}};
    clearTimeout(this.deadline); this.deadline = setTimeout(expire, 2000);
    try {
      const value = await reader.resolveProfile(source.source, Date.now(), controller.signal);
      if (controller.signal.aborted || epoch !== this.epoch) return;
      const now = this.nowNs(), timing = value.timing;
      const remaining = 2_000_000_000n - (now - timing.startedClientNs);
      if (remaining <= 0n || timing.completedClientNs > now || timing.completedClientNs < timing.startedClientNs) {expire(); return;}
      clearTimeout(this.deadline); this.deadline = setTimeout(expire, Number(remaining) / 1_000_000);
      if (!controller.signal.aborted && epoch === this.epoch) {
        if (this.proof?.value.binding !== value.binding) this.proof = undefined;
        this.pending = {proof: {version: 1, scope: value.scope, binding: value.binding, game: source.source.game,
          pluginSessionId: source.source.pluginSessionId, processInstanceId: source.source.processInstanceId, sourceClockId: source.clockId,
          afterMonotonicNs: source.monotonicNs, loadGeneration: value.profile.generation}, completedNs: timing.completedClientNs, expiresNs: timing.startedClientNs + 2_000_000_000n};
      }
    } catch {if (epoch === this.epoch) {this.proof = undefined; this.pending = undefined;}}
    finally {if (!this.pending) clearTimeout(this.deadline); this.inFlight = false;}
  }
  start(): void {if (!this.automatic) return; this.timer ??= setInterval(() => {void this.refresh();}, 1000); this.timer.unref();}
  close(): void {clearInterval(this.timer); this.timer = undefined; this.select(null);}
}
