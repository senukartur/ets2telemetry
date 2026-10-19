/** ET-019 PR-12b: the packaged application soak's oracle and evidence (soak-evidence.mjs). */
export interface SoakAvailable {available: true; value: number}
export interface SoakEventRow {eventSeq: string; type: string; utcMs: number}
export interface SoakTripRow {
  trip: string; openedBy: 'event'; openedEventSeq: string; jobConfigurationEventSeq: string; truckConfigurationEventSeq: string; trailerConfigurationEventSeqs: string[];
  outcome: 'delivered' | 'cancelled'; outcomeEventSeq: string; closeReason: 'outcome'; recordingCompleteness: 'complete' | 'partial';
  startedUtcMs: number; endedUtcMs: number; observedDistanceM: SoakAvailable; fuelUsedL: SoakAvailable;
}
export interface SoakAttributionRow {eventSeq: string; trip: string; attribution: string}
export interface SoakIntervalRow {trip: string; kind: string; detail: Record<string, unknown>}
export interface SoakSampleRow {second: string; trip: string | null; monotonicNs: string; utcMs: number; speedMps: number; odometerM: number}
export interface SoakLosses {lostEvents: number; eventLoss: number; notConnected: number; sampleLoss: number; restoreLoss: number; droppedSamples: number}
export interface SoakExpectation {
  minutes: number; events: SoakEventRow[]; trips: SoakTripRow[]; attributions: SoakAttributionRow[]; intervals: SoakIntervalRow[]; cycleSamples: SoakSampleRow[];
  gaps: number; coverage: string; tailFromSecond: number; connections: number; closes: string[]; losses: SoakLosses;
  counts: {events: number; trips: number; cancelled: number; partial: number; attributions: number; intervals: number; cycleSamples: number};
}
export interface SoakTail {fromSecond: number; lastSecond: number | null; samples: number; expectedLastSecond: [number, number]; problems: string[]}
export type SoakTrend =
  | {status: 'TOO_FEW_POINTS'; warmUpMs: number; points: number}
  | {status: 'MEASURED'; warmUpMs: number; points: number; fromMs: number; toMs: number; slopeBytesPerHour: number; r2: number; quarterMeansBytes: number[]};
export interface SoakSeriesKind {processes: number; workingSetBytes: number; privateBytes: number}
export interface SoakSeriesRow {elapsedMs: number; kinds?: Record<string, SoakSeriesKind>; [key: string]: unknown}
export interface SoakRange {first: number; min: number; max: number; last: number}
export interface SoakKindSummary {points: number; processes: {min: number; max: number}; privateBytes: SoakRange | null; workingSetBytes: SoakRange | null; trend: SoakTrend}
export interface SoakLogBudget {
  bytes: number; records: number; budgetBytes: number; budgetRecords: number; reached: boolean; soak: {bytes: number; records: number; ms: number};
  projected: {minutes: number; bytes: number; records: number; headroomBytes: number; headroomRecords: number; wouldReach: boolean};
}
export interface SoakGrowth {
  databaseBytes: number; samples: number; bytesPerSampleHour: number | null; measuredBytesPerSampleHour: number; ratioToMeasured: number | null;
  allowanceBytesPerSampleHour: number; ratioToAllowance: number | null;
}
export interface SoakMetric {type: string; name: string | null; serviceName: string | null; workingSetKiB: number | null; privateKiB: number | null}

export const SOAK_SCHEDULE: {
  seed: string; frameMs: number; cycleMs: number; tailMs: number; startAtMs: number;
  offsets: {job: number; toll: number; paused: number; started: number; disconnect: number; reconnect: number; outcome: number; cleared: number};
  reconnect: {every: number; at: number}; cancel: {every: number; at: number};
};
export const MEASURED_BYTES_PER_SAMPLE_HOUR: number;
export const ALLOWANCE_BYTES_PER_SAMPLE_HOUR: number;
export const LOG_BUDGET: {bytes: number; records: number; marginBytes: number};
export const LEAK_WARM_UP_MIN_MS: number;
export const LEAK_WARM_UP_FRACTION: number;
export const LEAK_MIN_POINTS: number;
export function soakSessionId(): string;
export function tripUuidOf(session: string, eventSeq: string | number): string;
export function reconnectCycles(minutes: number): number;
export function soakExpectation(minutes: number): SoakExpectation;
export function checkTail(samples: readonly {second: string; trip: string | null}[], options: {fromSecond: number; stopScenarioMs: number; minimumSeconds: number}): SoakTail;
export function listDifferences(name: string, actual: readonly unknown[], expected: readonly unknown[], limit?: number): string[];
export function leakTrend(points: readonly {elapsedMs: number; bytes: number}[], options: {plannedMs: number}): SoakTrend;
export function seriesSummary(series: readonly SoakSeriesRow[], options: {plannedMs: number}): Record<string, SoakKindSummary>;
export function summarizeSoakMetrics(metrics: readonly SoakMetric[], kindOf: (metric: SoakMetric) => string): Record<string, SoakSeriesKind>;
export function logBudget(use: {bytes: number; records: number; soakBytes: number; soakRecords: number; soakMs: number}, options?: {targetMinutes?: number}): SoakLogBudget;
export function databaseGrowth(input: {databaseBytes: number; samples: number}): SoakGrowth;
