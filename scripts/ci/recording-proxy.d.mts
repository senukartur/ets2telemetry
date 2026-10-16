export interface RecordingProxyConnection {
  connection: number; heldMs: number; checkpointAckedThrough: string | null; events: {eventSeq: string; redelivered: boolean}[]; gaps: number;
  end: string | null; acks: string[]; forwardedAcks: string[]; withheldAcks: string[]; ackLatencyMs: {eventSeq: string; ms: number}[];
  closedBy: 'server' | 'client' | 'proxy' | null; decodeFailure?: boolean;
}
export interface RecordingProxyStatistics {
  attempts: number; refusedLiveOnly: number; expiredHolds: number; admissionsPending: number; held: boolean; connections: RecordingProxyConnection[];
}
export interface RecordingProxy {
  endpoint: string;
  admit(): void;
  statistics(): RecordingProxyStatistics;
  stop(): Promise<void>;
}
export const HOLD_LIMIT_MS: number;
export function startRecordingProxy(options: {upstream: string; deliveredAcks?: number[]; holdLimitMs?: number; now?: () => number}): Promise<RecordingProxy>;
