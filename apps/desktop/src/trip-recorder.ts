// The trip recorder of protocol v1 ingestion (ET-015a, R2): a DurableSink that owns the ET-014 TripState and commits
// each event or gap together with its trip effects in one storage transaction, so the ACK pipeline acknowledges an item
// only after its effects are stored. DurableDelivery stays the only FIFO and runs one command at a time; the recorder
// steps the reducer when an item reaches the head of that FIFO and follows the caller contract in docs/trips.md:
// coverage is read right before each commit, and the stepped state is adopted only when storage reports `committed`,
// `duplicate`, `covered` or `conflict` (T3). Readings (the checkpoint's and each snapshot's state) arrive through the
// same FIFO and are adopted at once. ET-015b: after each reading the recorder samples it at one row per source second
// and holds the rows until DurableDelivery's `samples` op writes them. ET-016 PR-7 (J9): a checkpoint job seen while the
// game is idle opens a late-attach trip through DurableDelivery's `attach` op once the replayed events drained. Node-safe:
// it talks to storage only through the StorageClient interface. See docs/telemetry-service-v1.md.
import type {HardModeDetails, HardModeObservation} from '../../../packages/contracts/src/hard-mode';
import {unknownHardMode} from '../../../packages/telemetry-core/src/hard-mode';
import type {RecordingLosses, RecordingTrip} from '../../../packages/contracts/src';
import type {Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {CommitResult, CompletenessKind, SampleAppendResult, TripEffect} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
import {
  dueAttach, initialSamplerState, initialTripState, normalizeV1State, sampleReading, stepTrip, tripView, type SamplerState, type TripErrorCode, type TripGame, type TripInput,
  type TripState, type TripView
} from '../../../packages/telemetry-core/src/index';
import type {AttachSink, AttachStatus, CommitContext, CoverageMessage, HardModeCapture, DurableSink, ReadingMessage, RecorderErrorCode, SampleSink, SinkError, SinkResult, WelcomeMessage} from './durable-sink';
import {saturatingAdd} from './recording-status';
import {SampleBuffer} from './sample-buffer';
import {readTripSeeds} from './trip-seeds';

/** The recorder's sink codes and their E7 class live in durable-sink.ts, so the ingestion chain never loads the reducer. */
export {RECORDER_FAILURE_CLASS, type RecorderErrorCode} from './durable-sink';

/** The storage commands the recorder uses: the durable path, the restore-loss marker, the cold-start reads and the samples. */
export type TripRecorderClient = Pick<StorageClient, 'upsertSession' | 'committedThrough' | 'commitEvent' | 'commitGap' | 'recordCompleteness' | 'listTrips' | 'getEvent' |
  'listEvents' | 'appendSamples' | 'openAttachedTrip'> & Partial<Pick<StorageClient, 'observeHardMode' | 'getTrip'>>;

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
export interface TripRecorderOptions {onChange?: () => void; hardModeEvidence?: () => HardModeObservation; onHardModeTrip?: (details: HardModeDetails | null) => void}

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
 * - `attach` (ET-016 PR-7, J9): `due()` reports the reducer's due late-attach trip (`dueAttach`); `open()` steps `attach`,
 *   stores the trip with `openAttachedTrip` and adopts the stepped state on `committed` or `duplicate` (T3). A failure
 *   keeps the state; DurableDelivery then fails the connection like a failed commit, and the next connection's checkpoint
 *   decides again. The attach never changes coverage or produces an ACK.
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
  private readonly capturedEvidence = new Map<string, HardModeCapture>();
  private readonly pendingCaptures = new Set<HardModeCapture>();
  private evidenceKey(message: CoverageMessage): string {return `${message.source.pluginSessionId}:${message.kind}:${message.kind === 'event' ? message.data.eventSeq : message.data.firstEventSeq}`;}
  capture(message: CoverageMessage): HardModeCapture | undefined {
    if (!this.options.hardModeEvidence) return undefined;
    const captured = this.capturedEvidence.get(this.evidenceKey(message)) ?? {game: message.source.game, observation: structuredClone(this.options.hardModeEvidence()), firstUnsafe: null};
    const pending = this.pendingObservation;
    if (captured.firstUnsafe === null && pending?.game === captured.game && pending.value.assessment.state !== 'pass') captured.firstUnsafe = structuredClone(pending.value);
    if (captured.firstUnsafe === null && this.observationError) captured.firstUnsafe = {assessment: unknownHardMode(Date.now(), 'interrupted'), binding: null, pluginSessionId: null, sourceMonotonicNs: null};
    this.pendingCaptures.add(captured); return captured;
  }
  releaseCapture(captured: HardModeCapture): void {this.pendingCaptures.delete(captured);}
  private pendingObservation: {game: TripGame; value: HardModeObservation} | undefined;
  private observing = false;
  private observationWrite: Promise<void> | undefined;
  private observationError: SinkError | undefined;
  private observationBinding: string | null | undefined;
  private lastTrip: string | null = null;
  private async readHardModeTrip(game: TripGame): Promise<void> {
    if (!this.options.hardModeEvidence || !this.client.getTrip) return;
    const uuid = this.view(game).current?.tripUuid ?? this.lastTrip;
    if (!uuid) {this.options.onHardModeTrip?.(null); return;}
    this.lastTrip = uuid;
    const result = await this.client.getTrip(uuid);
    if (result.ok) this.options.onHardModeTrip?.(result.value?.hardModeDetails ?? null);
  }
  /** At most one observation command and one pending loss. A compliant refresh never replaces a pending failure. */
  observeHardMode(game: TripGame, value: HardModeObservation): void {
    if (this.observationBinding !== undefined && this.observationBinding !== value.binding && value.assessment.state === 'pass') value = {...value, assessment: unknownHardMode(value.assessment.observedUtcMs, 'source-changed')};
    this.observationBinding = value.binding;
    this.latchCaptureLoss(game, value);
    if (!this.client.observeHardMode) return;
    const pending = this.pendingObservation;
    if (!pending || pending.value.assessment.state === 'pass') this.pendingObservation = {game, value: structuredClone(value)};
    this.startObservationWrite();
  }
  private latchCaptureLoss(game: TripGame, value: HardModeObservation): void {
    for (const capture of new Set([...this.pendingCaptures, ...this.capturedEvidence.values()])) if (capture.game === game && capture.firstUnsafe === null) {
      if (value.assessment.state !== 'pass') capture.firstUnsafe = structuredClone(value);
      else if (capture.observation.binding !== value.binding) capture.firstUnsafe = {...structuredClone(value), assessment: unknownHardMode(value.assessment.observedUtcMs, 'source-changed')};
    }
  }
  private startObservationWrite(): void {
    if (this.observing || !this.pendingObservation) return;
    this.observing = true;
    this.observationWrite = (async () => {
      let attempted: {game: TripGame; value: HardModeObservation} | undefined;
      try {
        while (this.pendingObservation) {
          const next = attempted = this.pendingObservation; this.pendingObservation = undefined;
          const result = await this.client.observeHardMode!(next.game, next.value);
          if (!result.ok) {
            // A storage interruption cannot be turned back into a pass by a later refresh.
            this.observationError = result.error;
            this.pendingObservation = {game: next.game, value: next.value.assessment.state === 'pass' ? {...next.value, assessment: unknownHardMode(Date.now(), 'interrupted'), binding: null} : next.value};
            this.latchCaptureLoss(next.game, this.pendingObservation.value);
            return;
          }
          this.observationError = undefined;
          await this.readHardModeTrip(next.game);
        }
      } catch {
        if (attempted) {
          this.pendingObservation = {game: attempted.game, value: attempted.value.assessment.state === 'pass' ? {...attempted.value, assessment: unknownHardMode(Date.now(), 'interrupted'), binding: null} : attempted.value};
          this.latchCaptureLoss(attempted.game, this.pendingObservation.value);
        }
        this.observationError = {code: 'INTERNAL', retryable: false, message: 'The Hard Mode observation could not be stored.'};
      } finally {this.observing = false;}
    })();
  }
  private async flushObservations(): Promise<SinkError | undefined> {
    await this.observationWrite;
    if (this.pendingObservation) {this.startObservationWrite(); await this.observationWrite;}
    return this.observationError;
  }
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
  readonly attach: AttachSink = {
    due: () => dueAttach(this.state) !== null,
    open: context => this.openAttach(context)
  };
  constructor(private readonly client: TripRecorderClient, private readonly options: TripRecorderOptions = {}) {}

  async openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>> {
    if (this.options.hardModeEvidence && this.client.observeHardMode) {
      const lost = await this.client.observeHardMode(welcome.source.game, {assessment: unknownHardMode(Date.now(), 'interrupted'), binding: null, pluginSessionId: null, sourceMonotonicNs: null});
      if (!lost.ok) return lost;
    }
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
    const key = this.evidenceKey(message);
    const capture = this.capturedEvidence.get(key) ?? context.hardModeCapture ?? this.capture(message);
    if (capture) {this.capturedEvidence.clear(); this.capturedEvidence.set(key, capture); this.pendingCaptures.add(capture);}
    try {return await this.commitCaptured(message, context, key, capture);} finally {if (capture) this.releaseCapture(capture);}
  }
  private async commitCaptured(message: CoverageMessage, context: CommitContext, key: string, capture: HardModeCapture | undefined): Promise<SinkResult<CommitResult>> {
    const observationError = await this.flushObservations();
    if (observationError) return {ok: false, error: observationError};
    // The storage caller rule: read the coverage right before committing; the single writer keeps it until the commit.
    const covered = await this.client.committedThrough(message.source.pluginSessionId);
    if (!covered.ok) return covered;
    const coveredThrough = covered.value, receivedUtcMs = context.receivedUtcMs;
    const stepped = stepTrip(this.state, message.kind === 'event' ? {kind: 'event', message, coveredThrough, receivedUtcMs} : {kind: 'gap', message, coveredThrough, receivedUtcMs});
    if (!stepped.ok) return refused(RECORDER_CODE[stepped.code]);
    // No await between this read and posting the transaction: any earlier observed loss is part of opening/closing.
    const hardMode = capture?.observation, hardModeLoss = capture?.firstUnsafe;
    const input = {message, ...(stepped.effects.length ? {effects: stepped.effects} : {}), ...(hardMode ? {hardMode} : {}), ...(hardModeLoss ? {hardModeLoss} : {})};
    const result = message.kind === 'event' ? await this.client.commitEvent(input) : await this.client.commitGap(input);
    if (!result.ok || !ADOPT.has(result.value.status)) return result;
    // R7: the gap's effects describe only (coveredThrough, lastEventSeq]; another starting point means they were wrong.
    if (message.kind === 'gap' && result.value.previouslyCoveredThrough !== coveredThrough) return refused('TRIP_COVERAGE_MISMATCH');
    this.state = stepped.state;
    this.capturedEvidence.delete(key);
    await this.readHardModeTrip(message.source.game);
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
      const hydrated = stepTrip(next, {kind: 'checkpoint', message, receivedUtcMs: context.receivedUtcMs});
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

  /** J9: opens the due late-attach trip; `none` when nothing is due. */
  private async openAttach(context: CommitContext): Promise<SinkResult<{status: AttachStatus}>> {
    const request = dueAttach(this.state);
    if (request === null) return {ok: true, value: {status: 'none'}};
    const stepped = stepTrip(this.state, {kind: 'attach', receivedUtcMs: context.receivedUtcMs});
    if (!stepped.ok) return refused(RECORDER_CODE[stepped.code]);
    const result = await this.client.openAttachedTrip({...request, effects: stepped.effects});
    if (!result.ok) return result;
    this.state = stepped.state;
    // G6: only a new row stored the intervals.
    if (result.value.status === 'committed') this.countIntervals(stepped.effects);
    this.options.onChange?.();
    return {ok: true, value: {status: result.value.status}};
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
