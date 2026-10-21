import type {HardModeStatus} from '../../packages/contracts/src/hard-mode';
export interface HardModeProofRecord {
  lastStatus?: HardModeStatus;
  phase?: string;
  refreshRequests?: number;
  elapsedMilliseconds?: number;
}
export function waitForHardModeProof(input: {
  refresh: () => Promise<unknown>;
  read: () => Promise<HardModeStatus>;
  accept: (status: HardModeStatus) => boolean | Promise<boolean>;
  record: HardModeProofRecord;
  message: string;
  timeoutMs?: 5000 | 8000;
}): Promise<HardModeStatus>;
