// Private service/main metadata. Renderer IPC continues to expose only HardModeStatus.
import {isHardModeAssessment, isHardModeDetails, type HardModeAssessment, type HardModeDetails, type HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
export const HARD_MODE_COVERAGE_NS = 3_000_000_000n;
export type HardModeServiceMessage = {type: 'hard-mode'; update: 'assessment'; assessment: HardModeAssessment; remainingNs: string}
  | {type: 'hard-mode'; update: 'trip'; trip: HardModeDetails | null};
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.sort().join(',');
/** Relative lifetime crosses the private boundary; clock origins and UTC labels never do. */
export class HardModeServiceCache {
  private assessment: HardModeAssessment = unknownHardMode(Date.now());
  private trip: HardModeDetails | null = null;
  private expiresNs: bigint | undefined;
  constructor(private readonly nowNs: () => bigint = () => process.hrtime.bigint()) {}
  accept(message: unknown): void {
    if (exact(message, ['type', 'update', 'assessment', 'remainingNs']) && message.type === 'hard-mode' && message.update === 'assessment'
      && isHardModeAssessment(message.assessment) && typeof message.remainingNs === 'string' && /^(0|[1-9][0-9]{0,9})$/.test(message.remainingNs)
      && BigInt(message.remainingNs) <= HARD_MODE_COVERAGE_NS) {
      this.assessment = structuredClone(message.assessment); this.expiresNs = this.nowNs() + BigInt(message.remainingNs); return;
    }
    if (exact(message, ['type', 'update', 'trip']) && message.type === 'hard-mode' && message.update === 'trip' && (message.trip === null || isHardModeDetails(message.trip))) {
      this.trip = structuredClone(message.trip); return;
    }
    this.invalidate();
  }
  private invalidate(): void {this.expiresNs = undefined; this.assessment = unknownHardMode(Date.now());}
  retire(): void {this.invalidate(); this.trip = null;}
  status(ready: boolean): HardModeStatus {
    const remaining = this.expiresNs === undefined ? 0n : this.expiresNs - this.nowNs();
    return {assessment: ready && remaining > 0n && remaining <= HARD_MODE_COVERAGE_NS ? this.assessment : unknownHardMode(Date.now()), trip: this.trip};
  }
}
