import type {LiveTelemetry} from '../../../packages/contracts/src';
import {initialLive} from './live-state';

/** Main's expiry clock cannot be renewed by window-only updates or equal SDK captures. */
export class LiveFreshness {
  private current = initialLive();
  private sdkKey?: string;
  private windowKey?: string;
  private sdkExpiry = 0;
  private windowExpiry = 0;
  private sdkTimer?: ReturnType<typeof setTimeout>;
  private windowTimer?: ReturnType<typeof setTimeout>;
  constructor(private readonly publish: (live: LiveTelemetry) => void) {}
  accept(update: LiveTelemetry): void {
    this.clear(); this.current = update;
    const now = performance.now(), observation = update.observation;
    if (observation) {
      const identity = `${observation.source.pluginSessionId}|${observation.source.processInstanceId}|${observation.capture.clockId}`;
      const sdk = `${identity}|${observation.capture.monotonicNs}`;
      const window = `${identity}|${observation.windowReceivedMonotonicMs}`;
      if (sdk !== this.sdkKey) {this.sdkKey = sdk; this.sdkExpiry = now + 500;}
      if (window !== this.windowKey) {this.windowKey = window; this.windowExpiry = now + 250;}
      if (update.fresh) {
        if (now >= this.sdkExpiry) this.expireSdk();
        else this.sdkTimer = setTimeout(() => {this.sdkTimer = undefined; this.expireSdk(); this.publish(this.current);}, this.sdkExpiry - now);
      }
      if (observation.windowFresh) {
        if (now >= this.windowExpiry) this.expireWindow();
        else this.windowTimer = setTimeout(() => {this.windowTimer = undefined; this.expireWindow(); this.publish(this.current);}, this.windowExpiry - now);
      }
    }
    this.publish(this.current);
  }
  invalidate(update: LiveTelemetry): void {this.clear(); this.current = update; this.publish(update);}
  close(): void {this.clear();}
  private expireSdk(): void {this.current = {...this.current, status: 'stale', fresh: false, reason: 'Main has no recent SDK capture'};}
  private expireWindow(): void {
    if (this.current.observation) this.current = {...this.current, observation: {...this.current.observation, windowFresh: false}};
  }
  private clear(): void {clearTimeout(this.sdkTimer); clearTimeout(this.windowTimer); this.sdkTimer = this.windowTimer = undefined;}
}
