import type {ProfileObservation} from '../../../packages/telemetry-core/src/trips/continuation';
import type {MonitorSource} from './hard-mode/monitor';
import type {HardModeReader} from './hard-mode/reader';

/** A private file proof becomes usable only after a later probe receipt in the same source clock. */
export class ProfileObserver {
  private source: (MonitorSource & {gameClockId?:string}) | null = null;
  private epoch = 0;
  private controller: AbortController | undefined;
  private pending: {proof: ProfileObservation; completedNs: bigint} | undefined;
  private proof: {value: ProfileObservation; atNs: bigint} | undefined;
  private inFlight = false;
  private work: Promise<void> | undefined;
  private lastScan = -1n;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly reader: () => HardModeReader | undefined, private readonly nowNs = () => process.hrtime.bigint()) {}
  select(source: (MonitorSource & {gameClockId?:string}) | null): void {
    const before = this.source;
    this.source = source;
    if (before?.source.pluginSessionId !== source?.source.pluginSessionId || before?.source.processInstanceId !== source?.source.processInstanceId || before?.clockId !== source?.clockId || before?.gameClockId !== source?.gameClockId) {
      this.epoch++; this.controller?.abort(); this.pending = undefined; this.proof = undefined;
    }
    const boundary = source?.boundary, pending = this.pending;
    if (pending && boundary && source?.clockId === boundary.clockId && BigInt(boundary.probeSentClientNs) > pending.completedNs) {
      this.pending = undefined;
      if (BigInt(boundary.receivedSourceNs) < 18_446_744_073_709_551_615n) this.proof = {
        value: {...pending.proof, afterMonotonicNs: (BigInt(boundary.receivedSourceNs) + 1n).toString()}, atNs: pending.completedNs};
    }
    void this.refresh();
  }
  evidence(): ProfileObservation | undefined {
    const proof = this.proof;
    return proof && this.nowNs() >= proof.atNs && this.nowNs() - proof.atNs <= 3_000_000_000n ? structuredClone(proof.value) : undefined;
  }
  refresh(): Promise<void> {return this.work ??= this.scan().finally(()=>{this.work=undefined;});}
  private async scan(): Promise<void> {
    const reader = this.reader(), source = this.source, now = this.nowNs();
    if (!reader || !source?.clockId || this.inFlight || this.lastScan >= 0n && now - this.lastScan < 1_000_000_000n) return;
    this.lastScan = now; this.inFlight = true;
    const epoch = this.epoch, controller = this.controller = new AbortController();
    const deadline = setTimeout(() => {controller.abort(); if (epoch === this.epoch) {this.proof = undefined; this.pending = undefined;}}, 2000);
    try {
      const value = await reader.resolveProfile(source.source, Date.now(), controller.signal);
      if (!controller.signal.aborted && epoch === this.epoch) {
        if (this.proof?.value.binding !== value.binding) this.proof = undefined;
        this.pending = {proof: {version: 1, scope: value.scope, binding: value.binding, game: source.source.game,
          pluginSessionId: source.source.pluginSessionId, processInstanceId: source.source.processInstanceId, sourceClockId: source.clockId,
          afterMonotonicNs: source.monotonicNs, loadGeneration: value.profile.generation}, completedNs: this.nowNs()};
      }
    } catch {if (epoch === this.epoch) {this.proof = undefined; this.pending = undefined;}}
    finally {clearTimeout(deadline); this.inFlight = false;}
  }
  start(): void {this.timer ??= setInterval(() => {void this.refresh();}, 1000); this.timer.unref();}
  close(): void {clearInterval(this.timer); this.timer = undefined; this.select(null);}
}
