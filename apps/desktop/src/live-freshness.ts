import type {LiveTelemetry} from '../../../packages/contracts/src';
import {initialLive} from './live-state';
import {expiredV1, liveV1Key, MAIN_V1_EXPIRED_REASON, V1_LIVE_EXPIRY_MS} from './live-v1';

/**
 * Main's expiry clock cannot be renewed by window-only updates or equal SDK captures. The protocol v1 projection has its
 * own 500 ms clock (ET-010c decision F3): neither protocol's new data renews the other's.
 */
export class LiveFreshness {
  private current = initialLive();
  private sdkKey?: string;
  private windowKey?: string;
  private v1Key?: string;
  private sdkExpiry = 0;
  private windowExpiry = 0;
  private v1Expiry = 0;
  private sdkTimer?: ReturnType<typeof setTimeout>;
  private windowTimer?: ReturnType<typeof setTimeout>;
  private v1Timer?: ReturnType<typeof setTimeout>;
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
    const v1 = liveV1Key(update.v1);
    if (v1 !== undefined) {
      if (v1 !== this.v1Key) {this.v1Key = v1; this.v1Expiry = now + V1_LIVE_EXPIRY_MS;}
      if (update.v1!.fresh) {
        if (now >= this.v1Expiry) this.expireV1();
        else this.v1Timer = setTimeout(() => {this.v1Timer = undefined; this.expireV1(); this.publish(this.current);}, this.v1Expiry - now);
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
  private expireV1(): void {
    if (this.current.v1) this.current = {...this.current, v1: expiredV1(this.current.v1, MAIN_V1_EXPIRED_REASON)};
  }
  private clear(): void {
    clearTimeout(this.sdkTimer); clearTimeout(this.windowTimer); clearTimeout(this.v1Timer); this.sdkTimer = this.windowTimer = this.v1Timer = undefined;
  }
}
