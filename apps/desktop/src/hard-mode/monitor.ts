import type {HardModeObservation, HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
export const HARD_MODE_POLL_MS = 1000, HARD_MODE_DEADLINE_MS = 2000;
export interface MonitorSource {source: SourceIdentity; monotonicNs: string}
export class HardModeMonitor {
  private observation: HardModeObservation = this.unknown();
  private source: MonitorSource | null = null;
  private inFlight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private epoch = 0;
  private lastScan = -Infinity;
  private timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly read: (source: SourceIdentity, monotonicNs: string, atUtcMs: number, signal: AbortSignal) => Promise<HardModeObservation>,
    private readonly changed: (value: HardModeObservation) => void = () => undefined) {}
  private unknown(): HardModeObservation {return {assessment: unknownHardMode(Date.now()), binding: null, pluginSessionId: null, sourceMonotonicNs: null};}
  private publish(value: HardModeObservation): void {this.observation = value; this.changed(value);}
  select(next: MonitorSource | null): void {
    const before = this.source?.source, after = next?.source;
    this.source = next;
    if (before?.pluginSessionId === after?.pluginSessionId && before?.processInstanceId === after?.processInstanceId && before?.processId === after?.processId && before?.windowsSessionId === after?.windowsSessionId && before?.game === after?.game && before?.origin === after?.origin) return;
    this.epoch++; this.controller?.abort(); this.publish(this.unknown());
    void this.refresh();
  }
  evidence(): HardModeObservation {
    if (Date.now() - this.observation.assessment.observedUtcMs > HARD_MODE_POLL_MS + HARD_MODE_DEADLINE_MS) return this.unknown();
    return structuredClone(this.observation);
  }
  status(): HardModeStatus {return {assessment: this.evidence().assessment, trip: null};}
  start(): void {this.timer ??= setInterval(() => {void this.refresh();}, HARD_MODE_POLL_MS); this.timer.unref();}
  refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const current = this.source;
    if (!current || Date.now() - this.lastScan < HARD_MODE_POLL_MS) return Promise.resolve();
    if (this.observation.binding !== null && Date.now() - this.observation.assessment.observedUtcMs > HARD_MODE_POLL_MS + HARD_MODE_DEADLINE_MS) this.publish(this.unknown());
    this.lastScan = Date.now();
    const epoch = this.epoch, controller = this.controller = new AbortController();
    const deadline = setTimeout(() => {controller.abort(); if (epoch === this.epoch) this.publish(this.unknown());}, HARD_MODE_DEADLINE_MS);
    this.inFlight = this.read(current.source, current.monotonicNs, Date.now(), controller.signal).then(value => {
      if (!controller.signal.aborted && epoch === this.epoch) this.publish(value);
    }, () => {if (epoch === this.epoch) this.publish(this.unknown());}).finally(() => {clearTimeout(deadline); this.inFlight = undefined;});
    return this.inFlight;
  }
  close(): void {clearInterval(this.timer); this.timer = undefined; this.epoch++; this.controller?.abort(); this.publish(this.unknown());}
}
