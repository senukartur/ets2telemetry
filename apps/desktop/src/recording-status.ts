// The recording status of the telemetry service (ET-015c, G2-G6). The service derives it with `deriveRecordingStatus`, a
// pure, ordered rule set over the state of its database, protocol v1 ingestion, ACK pipeline and trip recorder, and posts
// it to main on its parent port through `RecordingStatusPublisher`, which coalesces changes. Main validates every report
// with `parseRecordingHealth` before it reaches AppState.health.recording, never derives the status itself, and adds the
// committed losses of every service process with `addLosses`. Fixed enums and counts only. Renderer-safe: type imports
// only. See docs/telemetry-service-v1.md#recording-status-et-015c.
import type {RecordingCode, RecordingHealth, RecordingLosses, RecordingState, RecordingTarget, RecordingTrip, SourceSelection} from '../../../packages/contracts/src';
import type {RecordingCompleteness, StorageErrorCode} from '../../../packages/storage/src/api';
import type {TripView} from '../../../packages/telemetry-core/src/index';
import type {SinkErrorCode} from './durable-sink';
import type {HistoryState} from './history-storage';
import type {DeliveryFailureCode} from './v1-durable-delivery';
import type {V1SourceState} from './v1-ingestion';

/** Compile-time equality of two types. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
// The contract's closed code set equals the sink codes and the pipeline's own failure codes; its trip phase and
// completeness equal the reducer's. A new code or phase fails to compile here until the contract lists it.
const CODES_MATCH: Same<RecordingCode, SinkErrorCode | DeliveryFailureCode> = true;
const PHASES_MATCH: Same<RecordingTrip['phase'], TripView['phase']> = true;
const COMPLETENESS_MATCH: Same<RecordingTrip['completeness'], RecordingCompleteness | null> = true;
void CODES_MATCH; void PHASES_MATCH; void COMPLETENESS_MATCH;

/** Every RecordingCode once; the record type makes a missing or extra code a compile error. */
const CODE_TABLE: Readonly<Record<RecordingCode, true>> = {
  DATABASE_LOCKED: true, PERMISSION_DENIED: true, DISK_FULL: true, IO_ERROR: true, DATABASE_CORRUPT: true, CONSTRAINT_VIOLATION: true, INVALID_INPUT: true,
  UNKNOWN_SESSION: true, UNKNOWN_TRIP: true, SESSION_CONFLICT: true, VALUE_OUT_OF_RANGE: true, STORAGE_CLOSED: true, STORAGE_BUSY: true, WORKER_FAILED: true,
  TIMEOUT: true, DATA_PATH_INVALID: true, DATABASE_UNRECOGNIZED: true, SCHEMA_NEWER: true, PURPOSE_MISMATCH: true, DURABILITY_UNVERIFIED: true, BACKUP_FAILED: true,
  MIGRATION_FAILED: true, INTERNAL: true, TRIP_ORDER_VIOLATION: true, TRIP_COVERAGE_MISMATCH: true, TRIP_UNKNOWN_SESSION: true, BACKLOG_FULL: true,
  COVERAGE_MISMATCH: true, ACK_AHEAD_OF_STORAGE: true
};
/** The closed set of codes a recording status may carry (G2). */
export const RECORDING_CODES: readonly RecordingCode[] = Object.freeze(Object.keys(CODE_TABLE) as RecordingCode[]);
const RECORDING_STATES: readonly RecordingState[] = ['opening', 'waiting', 'recording', 'paused', 'interrupted', 'retrying', 'not-recorded-source', 'live-only', 'stopped'];
const TARGETS: readonly RecordingTarget[] = ['history', 'synthetic', 'replay'];
const PHASES: readonly RecordingTrip['phase'][] = ['idle', 'active', 'awaiting-outcome', 'reload-check'];
const COMPLETENESS: readonly RecordingTrip['completeness'][] = ['unknown', 'partial', 'complete', null];
const LOSS_KEYS = ['lostEvents', 'eventLoss', 'notConnected', 'sampleLoss', 'restoreLoss', 'droppedSamples'] as const satisfies readonly (keyof RecordingLosses)[];

export const ZERO_LOSSES: Readonly<RecordingLosses> = Object.freeze({lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0});
export const isRecordingCode = (value: unknown): value is RecordingCode => typeof value === 'string' && Object.hasOwn(CODE_TABLE, value);
/** `a + b`, saturating at Number.MAX_SAFE_INTEGER. Both are non-negative safe integers. */
export const saturatingAdd = (a: number, b: number): number => Math.min(Number.MAX_SAFE_INTEGER, a + b);
/**
 * G6: the totals of an earlier service process (`base`) and the latest report of the current one, field by field,
 * saturating at Number.MAX_SAFE_INTEGER. Main folds each service process into its base when that process fails, exits
 * or restarts, so the totals count since ETS2Telemetry started.
 */
export function addLosses(base: Readonly<RecordingLosses>, latest: Readonly<RecordingLosses>): RecordingLosses {
  return {lostEvents: saturatingAdd(base.lostEvents, latest.lostEvents), eventLoss: saturatingAdd(base.eventLoss, latest.eventLoss),
    notConnected: saturatingAdd(base.notConnected, latest.notConnected), sampleLoss: saturatingAdd(base.sampleLoss, latest.sampleLoss),
    restoreLoss: saturatingAdd(base.restoreLoss, latest.restoreLoss), droppedSamples: saturatingAdd(base.droppedSamples, latest.droppedSamples)};
}

/** What `deriveRecordingStatus` reads; built by the recording runtime (recording-runtime.ts). */
export interface RecordingStatusInput {
  /** Whether this service built the trip recorder: only for a recording target, or for game history once it is enabled. */
  recorder: boolean;
  target: RecordingTarget;
  /** The database and the code of its failure, if any. */
  history: {state: HistoryState; code: StorageErrorCode | null};
  /** The selections whose connections record (R3, R10). */
  durableSelections: readonly SourceSelection[];
  v1: Pick<V1SourceState, 'selection' | 'status' | 'durable'>;
  /** G9: the ACK pipeline's retry code, set by a retryable commit or sample failure and cleared by a successful write. */
  retryCode: string | null;
  /**
   * Whether the current selection was recording (durable delivery active with connected v1 data) since it was selected.
   * A connection that is not recording yet then reads `waiting`; one that was recording reads `interrupted`.
   */
  recorded: boolean;
  losses: RecordingLosses;
  trip: RecordingTrip | null;
}
/** A code the pipeline or storage reported, or INTERNAL for any code outside the closed set. */
const recordingCode = (code: string | null | undefined): RecordingCode => isRecordingCode(code) ? code : 'INTERNAL';

/**
 * G3: the recording status; the first matching rule wins.
 * 1. No trip recorder: `disabled`.
 * 2. The database is not open yet (`idle`, `opening`): `opening`.
 * 3. The database is unavailable (or closed): `stopped` with its code (G10).
 * 4. Durable delivery failed: `live-only` for ACK_AHEAD_OF_STORAGE (this plugin session), otherwise `stopped` with the code.
 * 5. The selection is not recorded: `not-recorded-source`.
 * 6. A retry code is set: `retrying` with it (G9).
 * 7. Durable delivery is active and the v1 source is connected: `recording`; paused: `paused`.
 * 8. Otherwise `interrupted` when the selection was recording since it was selected, else `waiting`.
 * `recording` thus needs all three: the database open, the durable cursor active and fresh v1 data (connected or paused
 * are the fresh v1 statuses).
 */
export function deriveRecordingStatus(input: RecordingStatusInput): RecordingHealth {
  if (!input.recorder) return {state: 'disabled'};
  const status = (state: RecordingState, code: RecordingCode | null = null): RecordingHealth =>
    ({state, target: input.target, code, losses: {...input.losses}, trip: input.trip && {...input.trip}});
  const {history, v1} = input;
  if (history.state === 'idle' || history.state === 'opening') return status('opening');
  if (history.state !== 'open') return status('stopped', recordingCode(history.code ?? 'STORAGE_CLOSED'));
  if (v1.durable.state === 'failed') return v1.durable.code === 'ACK_AHEAD_OF_STORAGE' ? status('live-only', 'ACK_AHEAD_OF_STORAGE') : status('stopped', recordingCode(v1.durable.code));
  if (!input.durableSelections.includes(v1.selection)) return status('not-recorded-source');
  if (input.retryCode !== null) return status('retrying', recordingCode(input.retryCode));
  if (v1.durable.state === 'active' && v1.status === 'connected') return status('recording');
  if (v1.durable.state === 'active' && v1.status === 'paused') return status('paused');
  return status(input.recorded ? 'interrupted' : 'waiting');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Exactly these own keys, no more and no fewer. */
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function parseLosses(value: unknown): RecordingLosses | undefined {
  if (!isRecord(value) || !exactKeys(value, LOSS_KEYS) || !LOSS_KEYS.every(key => isCount(value[key]))) return undefined;
  return {lostEvents: value.lostEvents as number, eventLoss: value.eventLoss as number, notConnected: value.notConnected as number,
    sampleLoss: value.sampleLoss as number, restoreLoss: value.restoreLoss as number, droppedSamples: value.droppedSamples as number};
}
function parseTrip(value: unknown): RecordingTrip | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !exactKeys(value, ['phase', 'completeness', 'untrackedJob'])) return undefined;
  const {phase, completeness, untrackedJob} = value;
  if (!PHASES.includes(phase as RecordingTrip['phase']) || !COMPLETENESS.includes(completeness as RecordingTrip['completeness']) || typeof untrackedJob !== 'boolean') return undefined;
  return {phase: phase as RecordingTrip['phase'], completeness: completeness as RecordingTrip['completeness'], untrackedJob};
}
/**
 * G4: a fresh copy of a valid recording status, or undefined. Valid means exactly the keys of its variant, a known state,
 * target and trip phase, a code from RECORDING_CODES or null, and losses that are non-negative safe integers.
 */
export function parseRecordingHealth(value: unknown): RecordingHealth | undefined {
  if (!isRecord(value)) return undefined;
  const state = value.state;
  if (state === 'disabled' || state === 'unknown') return exactKeys(value, ['state']) ? {state} : undefined;
  if (!RECORDING_STATES.includes(state as RecordingState) || !exactKeys(value, ['state', 'target', 'code', 'losses', 'trip'])) return undefined;
  if (!TARGETS.includes(value.target as RecordingTarget) || (value.code !== null && !isRecordingCode(value.code))) return undefined;
  const losses = parseLosses(value.losses), trip = parseTrip(value.trip);
  if (!losses || trip === undefined) return undefined;
  return {state: state as RecordingState, target: value.target as RecordingTarget, code: value.code, losses, trip};
}
/** Value equality of two statuses built by this module or by `parseRecordingHealth` (their key order is fixed). */
export const sameRecording = (left: RecordingHealth, right: RecordingHealth): boolean => JSON.stringify(left) === JSON.stringify(right);
const sameLosses = (left: RecordingHealth | undefined, right: RecordingHealth): boolean =>
  JSON.stringify(left && 'losses' in left ? left.losses : null) === JSON.stringify('losses' in right ? right.losses : null);

/** G5: at most four coarse changes per second. */
export const RECORDING_STATUS_INTERVAL_MS = 250;
export interface RecordingStatusTimers {
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Runs `callback` once the I/O callbacks of the current event loop turn ran (Node's setImmediate). */
  setImmediate(callback: () => void): unknown;
  clearImmediate(handle: unknown): void;
  now(): number;
}
const systemTimers: RecordingStatusTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setImmediate: callback => setImmediate(callback),
  clearImmediate: handle => clearImmediate(handle as ReturnType<typeof setImmediate>),
  now: () => performance.now()
};
/**
 * G5: sends the recording status when it changes. `start` sends the current status at once. A change is noted with
 * `changed`; the status is computed once the I/O callbacks of the current event loop turn and their promise jobs ran
 * (setImmediate), so changes made together, such as a session opening and its checkpoint finding the database behind
 * the plugin, give one status and no passing `recording`. A new status whose losses differ from
 * the last one sent is sent at once; any other new status is sent at most once per `intervalMs`, the latest one at the
 * end of the interval (trailing send). An unchanged status is never sent again. There is no heartbeat. `close` stops it.
 */
export class RecordingStatusPublisher {
  #last?: RecordingHealth;
  #lastSentAt = -Infinity;
  #settle: unknown;
  #trailing: unknown;
  #started = false;
  #closed = false;
  readonly #intervalMs: number;
  readonly #timers: RecordingStatusTimers;
  constructor(private readonly compute: () => RecordingHealth, private readonly send: (status: RecordingHealth) => void,
    options: {intervalMs?: number; timers?: RecordingStatusTimers} = {}) {
    this.#intervalMs = options.intervalMs ?? RECORDING_STATUS_INTERVAL_MS;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0) throw new Error('Invalid recording status interval');
    this.#timers = options.timers ?? systemTimers;
  }
  /** The last status sent. */
  get last(): RecordingHealth | undefined { return this.#last; }
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#emit(this.compute());
  }
  changed(): void {
    if (!this.#started || this.#closed || this.#settle !== undefined) return;
    this.#settle = this.#timers.setImmediate(() => { this.#settle = undefined; this.#flush(); });
  }
  close(): void {
    this.#closed = true;
    if (this.#settle !== undefined) this.#timers.clearImmediate(this.#settle);
    if (this.#trailing !== undefined) this.#timers.clearTimeout(this.#trailing);
    this.#settle = this.#trailing = undefined;
  }
  #flush(): void {
    if (this.#closed) return;
    const next = this.compute();
    if (this.#last && sameRecording(this.#last, next)) return;
    const due = this.#lastSentAt + this.#intervalMs - this.#timers.now();
    if (!sameLosses(this.#last, next) || !(due > 0)) { this.#emit(next); return; }
    this.#trailing ??= this.#timers.setTimeout(() => { this.#trailing = undefined; this.#flush(); }, due);
  }
  #emit(status: RecordingHealth): void {
    if (this.#trailing !== undefined) { this.#timers.clearTimeout(this.#trailing); this.#trailing = undefined; }
    this.#last = status; this.#lastSentAt = this.#timers.now();
    this.send(status);
  }
}
