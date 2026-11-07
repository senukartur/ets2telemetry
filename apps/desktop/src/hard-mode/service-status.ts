// Private service/main metadata. Renderer IPC continues to expose only HardModeStatus.
import {isHardModeAssessment, isHardModeDetails, type HardModeAssessment, type HardModeDetails, type HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
export const HARD_MODE_COVERAGE_NS = 3_000_000_000n;
/** The longest single wait of the lease timer; an early fire re-arms it for the rest of the lease. */
const LEASE_TIMER_MAX_MS = 3000;
export type HardModeServiceMessage = {type: 'hard-mode'; update: 'assessment'; assessment: HardModeAssessment; remainingNs: string}
  | {type: 'hard-mode'; update: 'trip'; trip: HardModeDetails | null};
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');
/**
 * Relative lifetime crosses the private boundary; clock origins and UTC labels never do. ET-070: one unref'd timer
 * follows the accepted lease on main's monotonic clock and calls `expired` once when it ends, so the overlay turns to
 * not active without waiting for a telemetry frame. A renewal re-arms it; invalidation and retirement cancel it.
 */
export class HardModeServiceCache {
  private assessment: HardModeAssessment = unknownHardMode(Date.now());
  private trip: HardModeDetails | null = null;
  private expiresNs: bigint | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly nowNs: () => bigint = () => process.hrtime.bigint(), private readonly expired: () => void = () => {}) {}
  accept(message: unknown): void {
    if (exact(message, ['type', 'update', 'assessment', 'remainingNs']) && message.type === 'hard-mode' && message.update === 'assessment'
      && isHardModeAssessment(message.assessment) && typeof message.remainingNs === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(message.remainingNs)
      && BigInt(message.remainingNs) <= HARD_MODE_COVERAGE_NS) {
      this.assessment = structuredClone(message.assessment); this.expiresNs = this.nowNs() + BigInt(message.remainingNs); this.arm(); return;
    }
    if (exact(message, ['type', 'update', 'trip']) && message.type === 'hard-mode' && message.update === 'trip' && (message.trip === null || isHardModeDetails(message.trip))) {
      this.trip = structuredClone(message.trip); return;
    }
    this.invalidate();
  }
  private remainingNs(): bigint {return this.expiresNs === undefined ? 0n : this.expiresNs - this.nowNs();}
  /** One timer for the rest of the lease, at most LEASE_TIMER_MAX_MS; a zero or out-of-range lease expires on the next turn. */
  private arm(): void {
    clearTimeout(this.timer);
    const remaining = this.remainingNs(), valid = remaining > 0n && remaining <= HARD_MODE_COVERAGE_NS;
    const delay = valid ? Math.min(Number((remaining + 999_999n) / 1_000_000n), LEASE_TIMER_MAX_MS) : 0;
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }
  private fire(): void {
    this.timer = undefined;
    const remaining = this.remainingNs();
    if (remaining > 0n && remaining <= HARD_MODE_COVERAGE_NS) {this.arm(); return;}
    this.expired();
  }
  private clear(): void {clearTimeout(this.timer); this.timer = undefined;}
  private invalidate(): void {this.clear(); this.expiresNs = undefined; this.assessment = unknownHardMode(Date.now());}
  retire(): void {this.invalidate(); this.trip = null;}
  status(ready: boolean): HardModeStatus {
    const remaining = this.remainingNs();
    return {assessment: ready && remaining > 0n && remaining <= HARD_MODE_COVERAGE_NS ? this.assessment : unknownHardMode(Date.now()), trip: this.trip};
  }
}
