// The trip recorder of protocol v1 ingestion (ET-015a, R2): a DurableSink that owns the ET-014 TripState and commits
// each event or gap together with its trip effects in one storage transaction, so the ACK pipeline acknowledges an item
// only after its effects are stored. DurableDelivery stays the only FIFO and runs one command at a time; the recorder
// steps the reducer when an item reaches the head of that FIFO and follows the caller contract in docs/trips.md:
// coverage is read right before each commit, and the stepped state is adopted only when storage reports `committed`,
// `duplicate`, `covered` or `conflict` (T3). Readings (the checkpoint's and each snapshot's state) arrive through the
// same FIFO and are adopted at once. ET-015b: after each reading the recorder samples it at one row per source second
// and holds the rows until DurableDelivery's `samples` op writes them. Node-safe: it talks to storage only through the
// StorageClient interface. See docs/telemetry-service-v1.md.
import type {RecordingLosses, RecordingTrip} from '../../../packages/contracts/src';
import type {Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CommitResult, CompletenessKind, SampleAppendResult, TripEffect} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
import {
  initialSamplerState, initialTripState, normalizeV1State, sampleReading, stepTrip, tripView, type SamplerState, type TripErrorCode, type TripGame, type TripInput,
  type TripState, type TripView
} from '../../../packages/telemetry-core/src/index';
import type {CommitContext, CoverageMessage, DurableSink, ReadingMessage, RecorderErrorCode, SampleSink, SinkError, SinkResult, WelcomeMessage} from './durable-sink';
import {saturatingAdd} from './recording-status';
import {SampleBuffer} from './sample-buffer';
import {readTripSeeds} from './trip-seeds';

/** The recorder's sink codes and their E7 class live in durable-sink.ts, so the ingestion chain never loads the reducer. */
export {RECORDER_FAILURE_CLASS, type RecorderErrorCode} from './durable-sink';

/** The storage commands the recorder uses: the durable path, the restore-loss marker, the cold-start reads and the samples. */
export type TripRecorderClient = Pick<StorageClient, 'upsertSession' | 'committedThrough' | 'commitEvent' | 'commitGap' | 'recordCompleteness' | 'listTrips' | 'getEvent' |
  'listEvents' | 'appendSamples'>;

const RECORDER_CODE: Readonly<Record<TripErrorCode, RecorderErrorCode>> = {
  ORDER_VIOLATION: 'TRIP_ORDER_VIOLATION', COVERAGE_MISMATCH: 'TRIP_COVERAGE_MISMATCH', UNKNOWN_SESSION: 'TRIP_UNKNOWN_SESSION'
};
const RECORDER_MESSAGE = 'The trip recorder refused an input that breaks the caller contract.';
const refused = (code: RecorderErrorCode): {ok: false; error: SinkError} => ({ok: false, error: {code, retryable: false, message: RECORDER_MESSAGE}});
/** Commit statuses after which the stepped state is adopted (T3, R16). */
const ADOPT = new Set<CommitResult['status']>(['committed', 'duplicate', 'covered', 'conflict']);
/** ET-015c (G6): the completeness interval kinds the recording status counts, with the counter of each. */
const COUNTED: Partial<Record<CompletenessKind, 'eventLoss' | 'notConnected' | 'sampleLoss' | 'restoreLoss'>> = {
  'event-loss': 'eventLoss', 'not-connected': 'notConnected', 'sample-loss': 'sampleLoss', 'restore-loss': 'restoreLoss'
};
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
/** ET-015c: `onChange` is called after every change the recording status may show: trip state, losses or dropped samples. */
export interface TripRecorderOptions {onChange?: () => void}

/** The reducer reading of a checkpoint or snapshot: its normalized state, source identity, capture time and UTC label. */
function reading(message: ReadingMessage): TripInput {
  const utc = message.data.state.captureUtcUnixMs, source = message.source;
  return {kind: 'reading', sample: {
    source: {game: source.game, origin: source.origin, pluginSessionId: source.pluginSessionId, processInstanceId: source.processInstanceId},
    capture: {clockId: message.capture.clockId, monotonicNs: message.capture.monotonicNs}, state: normalizeV1State(message.data.state, message.data.status),
    ...(utc.available ? {utcMs: Number(utc.value)} : {})
  }};
}

/**
 * R2: steps the reducer at the head of the DurableDelivery FIFO and commits each item with its effects.
 *
 * - `openSession` (R6, R15): stores the session, reads the game's stored open trips as cold-start seeds the first time
 *   the reducer has no session of that game, steps `disconnected` when the reducer still has a connection, then steps
 *   `session` with the stored coverage.
 * - `commit`: reads `committedThrough()`, steps the event or gap, commits it with the effects and adopts the stepped
 *   state on `committed`, `duplicate`, `covered` or `conflict`. On a failed commit the state is kept, so the redelivered
 *   item is stepped again from it: no effect of an earlier commit is lost or repeated, and effects queued by the
 *   reconnection (such as its not-connected interval) may be added (R7). A gap whose `previouslyCoveredThrough` differs
 *   from the coverage read before the commit, or is missing, is not adopted and fails with TRIP_COVERAGE_MISMATCH.
 *   This is detection after the commit, not prevention: the gap row and its effects are already stored. The failure
 *   stops durable delivery (no ACK, live-only), and a later cold start seeds from those rows. Under the single-writer
 *   rule it should never happen.
 * - `observe` (R5): a checkpoint steps `checkpoint` and then its state as a reading; a snapshot steps a reading. Then
 *   (ET-015b, H2) the adopted reading goes through `sampleReading` with the trip view of its game, and a sampled row
 *   joins the pending SampleBuffer.
 * - `restoreLoss` (R9): one session-level `restore-loss` interval for the eventSeq range the producer released beyond
 *   storage, recorded with `ifAbsent` so a service restart in the same plugin session adds no second row.
 * - `samples` (ET-015b): the pending rows for DurableDelivery. `write` stores one session's ended loss intervals (every
 *   one at the final write) and then its rows with `appendSamples(…, {uniqueSeconds: true})` (H6); each part leaves the
 *   buffer only once stored.
 * - `view(game)` (R17): the read-only trip view, for ET-015b.
 * - `losses()` and `tripSummary(game)` (ET-015c, G6): what the recording status shows. Losses count only what storage
 *   committed: for a gap committed as new (`committed`), the eventSeq range it newly covers, lastEventSeq minus
 *   previouslyCoveredThrough; the `completeness.add` intervals of `committed` commits by kind; each sample-loss
 *   interval `samples.write` stored; each restore loss recorded, with its range; and the rows the pending sample bound
 *   dropped. A `duplicate`, `covered` or `conflict` result adds nothing, since its effects were stored before or never.
 *
 * A reducer `ok: false` result becomes a RecorderErrorCode and changes no state.
 */
export class TripRecorderSink implements DurableSink {
  private state: TripState = initialTripState();
  private sampler: SamplerState = initialSamplerState();
  private readonly buffer = new SampleBuffer();
  private lostEvents = 0n;
  private readonly counts = {eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0};
  readonly samples: SampleSink = {
    pending: () => ({rows: this.buffer.rowCount, losses: this.buffer.lossCount}),
    write: (maxRows, final) => this.writeSamples(maxRows, final),
    discard: () => this.buffer.discard(),
    dropped: () => this.buffer.dropped
  };
  constructor(private readonly client: TripRecorderClient, private readonly options: TripRecorderOptions = {}) {}

  async openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>> {
    const stored = await this.client.upsertSession({message: welcome});
    if (!stored.ok) return stored;
    const coveredThrough = stored.value.committedThroughEventSeq, game = welcome.source.game;
    // R15: the stored open trips are read only while the reducer knows no session of this game; later welcomes rely on
    // the reducer's own memory, which already never closes a trip twice.
    let openTrips: Extract<TripInput, {kind: 'session'}>['openTrips'] = [];
    if (this.state.games[game].sessionId === null) {
      const seeds = await readTripSeeds(this.client, game);
      if (!seeds.ok) return seeds;
      openTrips = seeds.value;
    }
    let next = this.state;
    // R6: the previous connection ends here. Its interval comes from the session's last item and reading, not from when
    // this input is stepped, and its queued work preceded this welcome in the FIFO.
    if (next.connection !== null) {
      const disconnected = stepTrip(next, {kind: 'disconnected'});
      if (!disconnected.ok) return refused(RECORDER_CODE[disconnected.code]);
      next = disconnected.state;
    }
    const session = stepTrip(next, {kind: 'session', welcome, coveredThrough, openTrips});
    if (!session.ok) return refused(RECORDER_CODE[session.code]);
    this.state = session.state;
    this.options.onChange?.();
    return {ok: true, value: {committedThroughEventSeq: coveredThrough}};
  }

  async commit(message: CoverageMessage, context: CommitContext): Promise<SinkResult<CommitResult>> {
    // The storage caller rule: read the coverage right before committing; the single writer keeps it until the commit.
    const covered = await this.client.committedThrough(message.source.pluginSessionId);
    if (!covered.ok) return covered;
    const coveredThrough = covered.value, receivedUtcMs = context.receivedUtcMs;
    const stepped = stepTrip(this.state, message.kind === 'event' ? {kind: 'event', message, coveredThrough, receivedUtcMs} : {kind: 'gap', message, coveredThrough, receivedUtcMs});
    if (!stepped.ok) return refused(RECORDER_CODE[stepped.code]);
    const input = stepped.effects.length ? {message, effects: stepped.effects} : {message};
    const result = message.kind === 'event' ? await this.client.commitEvent(input) : await this.client.commitGap(input);
    if (!result.ok || !ADOPT.has(result.value.status)) return result;
    // R7: the gap's effects describe only (coveredThrough, lastEventSeq]; another starting point means they were wrong.
    if (message.kind === 'gap' && result.value.previouslyCoveredThrough !== coveredThrough) return refused('TRIP_COVERAGE_MISMATCH');
    this.state = stepped.state;
    // G6: only a new row stored its effects; a gap covers (previouslyCoveredThrough, lastEventSeq] anew.
    if (result.value.status === 'committed') {
      this.countIntervals(stepped.effects);
      if (message.kind === 'gap') this.addLostEvents(BigInt(message.data.lastEventSeq) - BigInt(coveredThrough));
    }
    this.options.onChange?.();
    return result;
  }

  observe(message: ReadingMessage, context: CommitContext): SinkResult<undefined> {
    let next = this.state;
    if (message.kind === 'checkpoint') {
      const hydrated = stepTrip(next, {kind: 'checkpoint', message});
      if (!hydrated.ok) return refused(RECORDER_CODE[hydrated.code]);
      next = hydrated.state;
    }
    const read = stepTrip(next, reading(message));
    if (!read.ok) return refused(RECORDER_CODE[read.code]);
    this.state = read.state;
    // H2, H7: the sample sees the trip state that the commits before it in the FIFO left, and this reading.
    const sampled = sampleReading(this.sampler, {message, receivedUtcMs: context.receivedUtcMs, view: tripView(this.state, message.source.game)});
    this.sampler = sampled.state;
    if (sampled.row) this.buffer.push(message.source.pluginSessionId, sampled.row);
    this.options.onChange?.();
    return {ok: true, value: undefined};
  }

  /**
   * The `samples` write: one plugin session's ended loss intervals (every one with `final`), then at most `maxRows` of
   * its rows (H8, H9).
   */
  private async writeSamples(maxRows: number, final = false): Promise<SinkResult<SampleAppendResult>> {
    const batch = this.buffer.nextBatch(maxRows, final);
    if (!batch) return {ok: true, value: {appended: 0, skipped: 0}};
    for (const loss of batch.losses) {
      const recorded = await this.client.recordCompleteness(batch.pluginSessionId, loss);
      if (!recorded.ok) return recorded;
      this.buffer.commitLoss(loss);
      this.counts.sampleLoss = saturatingAdd(this.counts.sampleLoss, 1);
      this.options.onChange?.();
    }
    if (batch.rows.length === 0) return {ok: true, value: {appended: 0, skipped: 0}};
    const result = await this.client.appendSamples(batch.pluginSessionId, [...batch.rows], {uniqueSeconds: true});
    if (result.ok) this.buffer.commit(batch);
    return result;
  }

  async restoreLoss(pluginSessionId: string, storedThroughEventSeq: Uint64, ackedThroughEventSeq: Uint64): Promise<SinkResult<undefined>> {
    const result = await this.client.recordCompleteness(pluginSessionId, {
      kind: 'restore-loss', firstEventSeq: (BigInt(storedThroughEventSeq) + 1n).toString(), lastEventSeq: ackedThroughEventSeq,
      detail: {cause: 'ack-ahead-of-storage', storedThroughEventSeq, ackedThroughEventSeq}
    }, {ifAbsent: true});
    if (result.ok) {
      // G6: each recorded restore loss and its range (storedThrough, ackedThrough]. `ifAbsent` reports no difference, so
      // a later service in the same plugin session counts it again although storage keeps one row.
      this.counts.restoreLoss = saturatingAdd(this.counts.restoreLoss, 1);
      this.addLostEvents(BigInt(ackedThroughEventSeq) - BigInt(storedThroughEventSeq));
      this.options.onChange?.();
    }
    return result;
  }

  /** R17: the read-only trip view of one game from the adopted state. */
  view(game: TripGame): TripView { return tripView(this.state, game); }

  /** ET-015c (G2): the phase, the open trip's completeness and the untracked-job flag of one game, from the adopted state. */
  tripSummary(game: TripGame): RecordingTrip {
    const view = this.view(game);
    return {phase: view.phase, completeness: view.current?.recordingCompleteness ?? null, untrackedJob: view.untrackedJob};
  }

  /** ET-015c (G6): the committed losses of this recorder's lifetime, saturating at Number.MAX_SAFE_INTEGER. */
  losses(): RecordingLosses {
    return {lostEvents: Number(this.lostEvents > MAX_SAFE ? MAX_SAFE : this.lostEvents), ...this.counts, droppedSamples: this.buffer.dropped};
  }

  private countIntervals(effects: readonly TripEffect[]): void {
    for (const effect of effects) {
      const counter = effect.kind === 'completeness.add' ? COUNTED[effect.interval.kind] : undefined;
      if (counter) this.counts[counter] = saturatingAdd(this.counts[counter], 1);
    }
  }
  private addLostEvents(count: bigint): void {
    if (count <= 0n) return;
    this.lostEvents += count;
    if (this.lostEvents > MAX_SAFE) this.lostEvents = MAX_SAFE;
  }
}
