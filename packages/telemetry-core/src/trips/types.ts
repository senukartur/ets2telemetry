// Trip reducer inputs, state and results (ET-014). Everything is plain data: uint64 values stay decimal strings, and
// the state survives structured cloning and JSON. Effects use the storage TripEffect contract, imported as types only
// from packages/storage/src/api.ts (T2); see docs/trips.md.
import type {Available, Currency, GameMode, Money, ServerMessage, Uint64} from '../../../contracts/src/protocol-v1';
import type {RecordingCompleteness, TripEffect, TripOutcome, CloseReason} from '../../../storage/src/api';
import type {StepSample} from '../derived';
import type {GameTimeWindow, ReadingPoint, RunClock, TransferMark, TripAccounting} from './accounting';

export type {RecordingCompleteness, TripEffect};
/** Equals storage's MAX_EFFECTS (tests/unit/trip-reducer.test.ts checks it): the most effects one commit may carry. */
export const MAX_EFFECTS = 16;
/** T18: at most this many annotations per commit; the rest wait, in order, for later commits of the same game. */
export const MAX_ANNOTATIONS_PER_COMMIT = 8;

export type TripGame = 'ets2' | 'ats';
export type WelcomeMessage = Extract<ServerMessage, {kind: 'welcome'}>;
export type CheckpointMessage = Extract<ServerMessage, {kind: 'checkpoint'}>;
export type EventMessage = Extract<ServerMessage, {kind: 'event'}>;
export type GapMessage = Extract<ServerMessage, {kind: 'gap'}>;
export type GameModeEvidence = Pick<GameMode, 'mode' | 'method' | 'confidence'>;

/**
 * A stored open trip of the welcome's game, supplied at a session input for a session the reducer does not know yet
 * (a cold start, ET-015a). A trip of another plugin session is closed with reason `restart` (T11). A trip of the same
 * session resumes, partial, because the consumer was not running for part of it: active, or awaiting its outcome. `jobKey` is
 * `jobKey()` of the trip's stored job configuration; null when it cannot be rebuilt, so no later job matches it.
 * `lastObservedUtcMs` is the label of the trip session's last stored item, the lower bound of a restart close.
 * `observedDistanceM` is the trip's stored observed distance when it is available; a resumed trip accumulates from it.
 * `awaitingOutcome` is true when the trip's job was cleared before the stop: the session's last stored `job.configured`
 * or `job.cleared` event after the trip's opening event (`openedEventSeq`, which can follow the job configuration, for
 * example for a reload trip) is a `job.cleared`. The trip then resumes awaiting its outcome and counts no distance.
 */
export interface TripSeed {
  tripUuid: string; pluginSessionId: string; game: TripGame; jobKey: string | null;
  startedUtcMs: number; recordingCompleteness: RecordingCompleteness; lastObservedUtcMs?: number; observedDistanceM?: number; awaitingOutcome?: boolean;
}

/**
 * One reducer input. `event` and `gap` are commit carriers: their effects go into the storage commit of that message.
 * `coveredThrough` is the session's committed coverage read right before that commit (docs/storage.md, caller rule);
 * for `session` it is the coverage that upsertSession returned. `receivedUtcMs` is the consumer's UTC label at receipt,
 * used only when the session has no earlier label. `reading` is one normalized state of the current connection (the
 * checkpoint's and each snapshot's), in stream order with the events; `utcMs` is its capture UTC label. Readings are
 * not commit carriers: what they decide waits for the game's next carrier (T16, T17).
 */
export type TripInput =
  | {kind: 'session'; welcome: WelcomeMessage; coveredThrough: Uint64; openTrips: TripSeed[]}
  | {kind: 'checkpoint'; message: CheckpointMessage}
  | {kind: 'event'; message: EventMessage; coveredThrough: Uint64; receivedUtcMs: number}
  | {kind: 'gap'; message: GapMessage; coveredThrough: Uint64; receivedUtcMs: number}
  | {kind: 'reading'; sample: StepSample & {utcMs?: number}}
  | {kind: 'disconnected'};

/**
 * `ORDER_VIOLATION`: an eventSeq or gap start beyond the next expected eventSeq. `COVERAGE_MISMATCH`: the caller's
 * committed coverage differs from what the reducer has processed. `UNKNOWN_SESSION`: an item or checkpoint of a session
 * that is not the current connection's session. All three fail closed: the state is unchanged.
 */
export type TripErrorCode = 'ORDER_VIOLATION' | 'COVERAGE_MISMATCH' | 'UNKNOWN_SESSION';
export type TripStepResult = {ok: true; state: TripState; effects: TripEffect[]} | {ok: false; code: TripErrorCode};

/** Phases of an open trip. With no open trip the game slot is idle. */
export type TripPhase = 'active' | 'awaiting-outcome' | 'reload-check';
/**
 * Whether the session is inside a load: `loading` from the session start until its first `simulation.started` (O1),
 * and again after `timers.restart` until the next start. A `gameTime.regression` never starts a load, because it
 * follows the start of the load it ends (O10): it leaves the state unchanged, or sets `running` when it occurred while
 * running. `unknown` after a gap or when the reducer joins a session that already has committed events.
 */
export type LoadState = 'loading' | 'running' | 'unknown';

/** Exact sums of raw money by currency (status, code and source), never converted or netted. */
export interface MoneyTally {currency: Currency; sdkType: Money['sdkType']; total: string; count: number}
export interface MoneyTotals {byCurrency: MoneyTally[]; unavailable: number}

export interface OpenTrip {
  tripUuid: string; pluginSessionId: string; jobKey: string | null; jobEventSeq: Uint64 | null;
  phase: TripPhase;
  /** The identical job re-send that started a reload check (T8). */
  reloadEventSeq: Uint64 | null;
  /**
   * The load window after opening: until the first `simulation.started` (`before-start`) and for the one event right
   * after it (`after-start`). A timer restart or game-time regression inside it is the load that restored this job,
   * not a discontinuity of it (O1, O10); an outcome before the start is ambiguous (T14).
   */
  loadCheck: 'before-start' | 'after-start' | null;
  completeness: RecordingCompleteness; gameMode: GameModeEvidence; gameModeAmbiguous: boolean;
  startedUtcMs: number; startedMonotonicNs: Uint64 | null; clockId: string | null;
  market: Available<string> | null; cargoLoaded: Available<boolean> | null;
  /** Value keys of the truck and of each trailer slot the trip references, to tell a change from a re-send. */
  truckKey: string | null; trailerKeys: (string | null)[];
  plannedDistance: Available<number> | null; expectedIncome: Available<Money> | null;
  fines: MoneyTotals; finesBeforeLoaded: MoneyTotals; tolls: MoneyTotals; transfers: MoneyTotals;
  /** Observed distance, fuel used and refuels from readings (T16). */
  accounting: TripAccounting;
}
export interface ClosedTrip extends Omit<OpenTrip, 'phase' | 'reloadEventSeq' | 'loadCheck'> {
  outcome: Exclude<TripOutcome, 'open'>; closeReason: CloseReason; endedUtcMs: number; endedMonotonicNs: Uint64 | null;
  revenue: Available<Money> | null; penalty: Available<Money> | null; deliveredDistance: Available<number> | null;
}
export interface ConfigurationRef {eventSeq: Uint64; key: string}
export interface SessionState {
  pluginSessionId: string; game: TripGame; processedThrough: Uint64; load: LoadState; gameMode: GameModeEvidence;
  clockId: string | null; lastUtcMs: number | null; lastMonotonicNs: Uint64 | null;
  truck: ConfigurationRef | null; trailers: (ConfigurationRef | null)[];
  /**
   * A job that is known or likely active but that no trip tracks: a checkpoint job seen while idle (T9), or the job of
   * a trip a gap closed before its clear or outcome. Gameplay events meanwhile are ambiguous, never free driving
   * (concept.md, October 13, 2026). Cleared by `job.cleared`, an outcome or a new trip; a later checkpoint while idle
   * replaces or clears it, and a new plugin session starts with none. A checkpoint job describes the state at the
   * checkpoint, so it applies only from `attachedFromEventSeq` on: replayed events below it happened earlier.
   */
  untrackedJob: {key: string; source: 'checkpoint' | 'gap'} | null;
  /**
   * The current connection's checkpoint `nextEventSeq`. Events below it are replayed from the producer's retention: they
   * happened before the consumer attached (protocol v1 §7, §9). Null before the connection's checkpoint.
   */
  attachedFromEventSeq: Uint64 | null;
  /**
   * Where the last connection of this session ended, for the not-connected interval of an open trip; `reading` is the
   * connection's last reading, from which the interval's odometerDeltaM is measured.
   */
  disconnected: {utcMs: number | null; monotonicNs: Uint64 | null; clockId: string | null; reading: ReadingPoint | null} | null;
  /** The current connection's last reading; null before its first. Steps never bridge connections (T16). */
  lastReading: ReadingPoint | null;
  /** The source time of the current connection's first reading: waiting reading holes from before it belong to an earlier connection. */
  connectionSinceNs: string | null;
  /** The session's last ferry or train event, which labels a jump next to it a crossing (T17). */
  lastTransfer: TransferMark | null;
  /** Running simulation time since the current connection's last reading, for reading holes (T17). */
  runClock: RunClock | null;
  /** Recent game-time readings of the current connection, for game-time jumps spread over many readings (T17). */
  gameTimeWindow: GameTimeWindow | null;
  /**
   * A game-time jump still holds at the last reading: the trip it was annotated on, if any, and the reading where it last
   * grew (its annotation grows only by advances faster than the jump rate from there).
   */
  jumpEpisode: {tripUuid: string | null; lastNs: string; lastMinutes: string} | null;
  /**
   * After a reconnection with an open trip: its not-connected interval and the reading before the disconnection. The
   * connection's first reading records the odometer change in the interval while the interval still waits to be sent.
   */
  bridge: {tripUuid: string; before: ReadingPoint | null} | null;
}
/** The last trip closed without an outcome, so an identical job opened next is marked as a continuation, never merged. */
export interface ContinuationCandidate {tripUuid: string; jobKey: string | null; cause: string}
export interface GameSlot {
  sessionId: string | null; trip: OpenTrip | null; lastClosed: ClosedTrip | null; continuation: ContinuationCandidate | null;
  /** Lifecycle effects decided outside a commit carrier (session changes), in order; never `this-event` references. */
  pending: TripEffect[];
  /** Annotation effects deferred by the per-commit cap, in order. */
  pendingAnnotations: TripEffect[];
}
export interface TripState {
  version: 1;
  /** The plugin session of the current connection, or null between connections. */
  connection: string | null;
  sessions: Record<string, SessionState>;
  games: Record<TripGame, GameSlot>;
}
