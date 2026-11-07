import {randomUUID} from 'node:crypto';
import type {ProfileObservation} from '../../../packages/telemetry-core/src/trips/continuation';
import {compatibleContinuation} from '../../../packages/telemetry-core/src/trips/continuation';
import type {ProfileObserverStatus} from './profile-observation';
import {truckKey} from '../../../packages/telemetry-core/src/derived';
import {classifyStep} from '../../../packages/telemetry-core/src/trips/accounting';
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
import type {HardModeDiagnostic, HardModeDetails, HardModeObservation} from '../../../packages/contracts/src/hard-mode';
import {hardModeDiagnostic, unknownHardMode} from '../../../packages/telemetry-core/src/hard-mode';
import type {RecordingLosses, RecordingTrip} from '../../../packages/contracts/src';
import type {JobConfiguration, Uint64} from '../../../packages/contracts/src/protocol-v1';
import type {AttachInput, CapturedEndpoint, CapturedRunning, CommitResult, CompletenessKind, SampleAppendResult, SampleInput, TripEffect} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
import {
  dueAttach, initialSamplerState, initialTripState, normalizeV1State, sampleReading, stepTrip, tripView, type SamplerState, type TripErrorCode, type TripGame, type TripInput,
  type TripState, type TripView
} from '../../../packages/telemetry-core/src/index';
import type {AttachSink, AttachStatus, CommitContext, CoverageMessage, HardModeCapture, HardModeCheckTarget, DurableSink, ReadingMessage, RecorderErrorCode, SampleSink, SinkError, SinkResult, WelcomeMessage} from './durable-sink';
import {saturatingAdd} from './recording-status';
import {SampleBuffer} from './sample-buffer';
import {readTripSeeds} from './trip-seeds';

/** The recorder's sink codes and their E7 class live in durable-sink.ts, so the ingestion chain never loads the reducer. */
export {RECORDER_FAILURE_CLASS, type RecorderErrorCode} from './durable-sink';

/** The storage commands the recorder uses: the durable path, the restore-loss marker, the cold-start reads and the samples. */
export type TripRecorderClient = Pick<StorageClient, 'upsertSession' | 'committedThrough' | 'commitEvent' | 'commitGap' | 'recordCompleteness' | 'listTrips' | 'getEvent' |
  'listEvents' | 'appendSamples' | 'openAttachedTrip'> & Partial<Pick<StorageClient, 'observeHardMode' | 'getTrip' | 'journalTrip'>>;

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
export interface TripRecorderOptions {onChange?: () => void; profileEvidence?: () => ProfileObservation | undefined; profileStatus?: () => ProfileObserverStatus; hardModeEvidence?: () => HardModeObservation; onHardModeTrip?: (details: HardModeDetails | null) => void}
const newerCheck = (previous: string | undefined, check: NonNullable<HardModeObservation['check']>) => {
  const [producer, sequence] = previous?.split(':') ?? [];
  return producer !== check.producer || Number(sequence) < check.sequence;
};
interface PendingHardMode {game: TripGame; value: HardModeObservation; fresh: boolean; diagnostics?: HardModeDiagnostic[]}
interface TrustedPredecessor {
  token: object; profile: ProfileObservation; tripUuid: string; job: JobConfiguration; referenceNs: string; qualifiedObservationNs: string; suspended: boolean;
  previous: NonNullable<SampleInput['recording']>['previous']; boundary: NonNullable<SampleInput['recording']>['previous']; running: CapturedRunning | undefined;
}

/** The reducer reading of a checkpoint or snapshot: its normalized state, source identity, capture time and UTC label. */
function reading(message: ReadingMessage,profile?:ProfileObservation): TripInput {
  const utc = message.data.state.captureUtcUnixMs, source = message.source;
  return {kind: 'reading',...(profile && profile.pluginSessionId===source.pluginSessionId && profile.processInstanceId===source.processInstanceId && profile.sourceClockId===message.capture.clockId && BigInt(message.capture.monotonicNs)>=BigInt(profile.afterMonotonicNs)?{profileScope:profile.scope}:{}), ...(message.kind === 'snapshot' ? {currentJob: message.data.state.configuration.job.available ? message.data.state.configuration.job.value : null} : {}), sample: {
    source: {game: source.game, origin: source.origin, pluginSessionId: source.pluginSessionId, processInstanceId: source.processInstanceId},
    capture: {clockId: message.capture.clockId, monotonicNs: message.capture.monotonicNs}, state: normalizeV1State(message.data.state, message.data.status),
    ...(utc.available ? {utcMs: Number(utc.value)} : {})
  }};
}
function capturedPoint(state: ReturnType<typeof normalizeV1State>): Pick<CapturedEndpoint,'truck'|'odometerM'|'fuelL'|'speedMps'|'gameClockId'|'gameMinutes'|'position'> {
  const truck=state.truck;
  return {truck:truck.state==='value' && truck.value.brand.id.state==='value' && truck.value.model.id.state==='value' && truck.value.licensePlate.state==='value'?truckKey(state):null,
    odometerM:state.odometer.state==='value'?state.odometer.value.meters:null,fuelL:state.fuel.state==='value'?state.fuel.value:null,
    speedMps:state.speed.state==='value'?state.speed.value:null,gameClockId:state.gameTime.clockId,
    gameMinutes:state.gameTime.minutes.state==='value'?state.gameTime.minutes.value.toString():null,
    position:state.worldPlacement.state==='value'?structuredClone(state.worldPlacement.value.position):null};
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
  private checkOwner: HardModeCapture | undefined;
  private readonly checkProducer = randomUUID();
  private checkTarget: HardModeCheckTarget | undefined;
  private seedCheckTarget(game: TripGame, session: string, tripUuid: string): void {
    if (this.checkTarget?.batch.tripUuid === tripUuid) return;
    this.checkTarget = {game, session, ready: false, batch: {tripUuid, producer: this.checkProducer, sequence: 0, passingChecks: 0, failingChecks: 0, unknownChecks: 0}};
  }
  /** Intake owns one interval until the next job/terminal boundary; no speculative reducer or check history. */
  private prepareCheckCapture(message: CoverageMessage, capture: HardModeCapture, intake: boolean): void {
    capture.pluginSessionId ??= message.source.pluginSessionId;
    if (!capture.checkBoundary && message.kind === 'event') {
      const kind = message.data.record.type;
      if (kind === 'job.configured') {
        capture.checkBoundary = 'job';
        const obs = capture.observation, check = obs.check, occurred = message.data.occurred.monotonicNs;
        capture.openingCheck = capture.fresh && check !== undefined && obs.pluginSessionId === message.source.pluginSessionId && obs.binding !== null
          && obs.sourceMonotonicNs !== null && occurred.available && BigInt(occurred.value) >= BigInt(obs.sourceMonotonicNs) && !message.data.redelivered;
        const previous = this.checkOwner?.checkTarget?.lastCheck ?? this.checkOwner?.checks?.lastCheck ?? this.checkTarget?.lastCheck;
        capture.checks = {passingChecks:0,failingChecks:0,unknownChecks:0,lastCheck:check && newerCheck(previous,check) ? `${check.producer}:${check.sequence}` : previous};
      } else if (kind === 'job.delivered' || kind === 'job.cancelled') capture.checkBoundary = 'terminal';
    }
    if (capture.checkBoundary && (intake || !this.checkOwner)) this.checkOwner = capture;
  }
  private countCheck(game: TripGame, value: HardModeObservation): void {
    if (!value.check) return;
    const owner = this.checkOwner;
    if (owner && (owner.game !== game || owner.pluginSessionId !== value.pluginSessionId || owner.checkBoundary === 'terminal')) return;
    const target = owner?.checkTarget ?? (owner ? undefined : this.checkTarget);
    const key = `${value.check.producer}:${value.check.sequence}`;
    const counter = value.binding === null ? 'unknownChecks' : value.assessment.state === 'pass' ? 'passingChecks' : value.assessment.state === 'fail' ? 'failingChecks' : 'unknownChecks';
    if (owner && !target) {
      const counts = owner.checks!;
      if (!newerCheck(counts.lastCheck, value.check)) return;
      if (counts.passingChecks + counts.failingChecks + counts.unknownChecks >= Number.MAX_SAFE_INTEGER) throw new Error('Hard Mode counter bound');
      counts.lastCheck = key; counts[counter]++; return;
    }
    if (!target || target.game !== game || target.session !== value.pluginSessionId || !newerCheck(target.lastCheck, value.check)) return;
    if (target.batch.sequence >= Number.MAX_SAFE_INTEGER) throw new Error('Hard Mode counter bound');
    target.lastCheck = key; target.batch.sequence++; target.batch[counter]++;
  }
  /** The actual reducer effect assigns the interval once: new member or supported same-job resend. */
  private handoffChecks(capture: HardModeCapture, member: string, opening: boolean): HardModeCheckTarget {
    if (capture.checkTarget?.batch.tripUuid === member) return this.checkTarget = capture.checkTarget;
    this.seedCheckTarget(capture.game, capture.pluginSessionId!, member);
    const target = this.checkTarget!, counts = capture.checks!;
    if (opening && capture.openingCheck) target.batch.passingChecks++;
    for (const key of ['passingChecks','failingChecks','unknownChecks'] as const) target.batch[key] += counts[key];
    target.batch.sequence = target.batch.passingChecks + target.batch.failingChecks + target.batch.unknownChecks;
    if (!Number.isSafeInteger(target.batch.sequence)) throw new Error('Hard Mode counter bound');
    if (counts.passingChecks + counts.failingChecks + counts.unknownChecks > 0 || opening && capture.openingCheck) target.lastCheck = counts.lastCheck;
    capture.checkTarget = target;
    return target;
  }
  private readonly capturedEvidence = new Map<string, HardModeCapture>();
  private readonly pendingCaptures = new Set<HardModeCapture>();
  private evidenceKey(message: CoverageMessage): string {return `${message.source.pluginSessionId}:${message.kind}:${message.kind === 'event' ? message.data.eventSeq : message.data.firstEventSeq}`;}
  capture(message: CoverageMessage): HardModeCapture | undefined {
    if (!this.options.hardModeEvidence) return undefined;
    let captured = this.capturedEvidence.get(this.evidenceKey(message));
    if (!captured) {
      // The provider ages proof on the monitor's monotonic clock at synchronous intake, never at commit.
      const observation = structuredClone(this.options.hardModeEvidence());
      captured = {game: message.source.game, pluginSessionId: message.source.pluginSessionId, observation, fresh: observation.assessment.state === 'pass', firstUnsafe: null};
    }
    const pending = this.pendingObservation;
    if (captured.firstUnsafe === null && pending?.game === captured.game && pending.value.assessment.state !== 'pass') captured.firstUnsafe = structuredClone(pending.value);
    if (captured.firstUnsafe === null && this.observationError) captured.firstUnsafe = {assessment: unknownHardMode(Date.now(), 'interrupted'), diagnostic: 'storage-failure', binding: null, pluginSessionId: null, sourceMonotonicNs: null};
    this.prepareCheckCapture(message, captured, true);
    this.pendingCaptures.add(captured); return captured;
  }
  releaseCapture(captured: HardModeCapture): void {
    this.pendingCaptures.delete(captured);
    if (this.checkOwner === captured && ![...this.capturedEvidence.values()].includes(captured)) this.checkOwner = undefined;
  }
  private pendingObservation: PendingHardMode | undefined;
  private observing = false;
  private observationWrite: Promise<void> | undefined;
  private observationError: SinkError | undefined;
  private observationBinding: string | null | undefined;
  private lastTrip: string | null = null;
  private async readHardModeTrip(game: TripGame): Promise<void> {
    if (!this.options.hardModeEvidence || !this.client.getTrip && !this.client.journalTrip) return;
    const uuid = this.view(game).current?.tripUuid ?? this.lastTrip;
    if (!uuid) {this.options.onHardModeTrip?.(null); return;}
    this.lastTrip = uuid;
    if (this.client.journalTrip) {
      const result = await this.client.journalTrip(uuid);
      if (result.ok) this.options.onHardModeTrip?.(result.value.trip.hardModeDetails);
      return;
    }
    const result = await this.client.getTrip!(uuid);
    if (result.ok) this.options.onHardModeTrip?.(result.value?.hardModeDetails ?? null);
  }
  /** One in-flight command and one cumulative pending batch, with bounded diagnostic endpoints. */
  observeHardMode(game: TripGame, value: HardModeObservation): void {
    // Validate positive offers against the monitor's monotonic-aged proof synchronously, before any write await.
    const current = value.assessment.state === 'pass' ? this.options.hardModeEvidence?.() : undefined;
    const fresh = value.assessment.state === 'pass' && current?.assessment.state === 'pass' && current.binding !== null
      && current.binding === value.binding && current.pluginSessionId === value.pluginSessionId && current.sourceMonotonicNs === value.sourceMonotonicNs;
    if (value.assessment.state === 'pass' && !fresh) value = {...value, assessment: unknownHardMode(value.assessment.observedUtcMs, 'interrupted')};
    const previousBinding = this.observationBinding;
    this.observationBinding = value.binding;
    this.latchCaptureLoss(game, value);
    this.countCheck(game, value);
    if (!this.client.observeHardMode) return;
    const target = this.checkTarget;
    if (target?.game === game) value = {...value, member: target.batch.tripUuid, ...(target.batch.sequence ? {batch: {...target.batch}, batchSessionId: target.session} : {})};
    const prior = this.pendingObservation, diagnostics = prior?.diagnostics ? [...prior.diagnostics] : [];
    const diagnostic = hardModeDiagnostic(value, previousBinding ?? null);
    if (diagnostic) {if (diagnostics.length === 2) diagnostics[1] = diagnostic; else diagnostics.push(diagnostic);}
    this.pendingObservation = {game, value: structuredClone(value), fresh, diagnostics};
    this.startObservationWrite();
  }
  private latchCaptureLoss(game: TripGame, value: HardModeObservation): void {
    for (const capture of new Set([...this.pendingCaptures, ...this.capturedEvidence.values()])) if (capture.game === game && capture.firstUnsafe === null) {
      if (value.assessment.state !== 'pass') capture.firstUnsafe = structuredClone(value);
      else if (capture.observation.binding !== value.binding) capture.firstUnsafe = {...structuredClone(value), assessment: unknownHardMode(value.assessment.observedUtcMs, 'source-changed')};
    }
  }
  private startObservationWrite(): void {
    if (this.observing || !this.pendingObservation || this.checkTarget?.ready === false) return;
    this.observing = true;
    this.observationWrite = (async () => {
      let attempted: PendingHardMode | undefined;
      try {
        while (this.pendingObservation) {
          const next = attempted = this.pendingObservation; this.pendingObservation = undefined;
          const result = await this.client.observeHardMode!(next.game, {...next.value, ...(next.diagnostics?.length ? {diagnostics: next.diagnostics} : {})}, next.fresh);
          if (!result.ok) {
            // Preserve cumulative totals verbatim: retry cannot drop or duplicate a designated check.
            this.observationError = result.error;
            const pending = this.pendingObservation;
            this.pendingObservation = pending ?? next;
            this.pendingObservation.value = {...this.pendingObservation.value, diagnostic: 'storage-failure'};
            const firstDiagnostic = next.diagnostics?.[0] ?? hardModeDiagnostic(next.value);
            const storageDiagnostic = hardModeDiagnostic(this.pendingObservation.value)!;
            this.pendingObservation.diagnostics = firstDiagnostic ? [firstDiagnostic, storageDiagnostic] : [storageDiagnostic];
            this.latchCaptureLoss(next.game, {...this.pendingObservation.value, assessment: unknownHardMode(Date.now(), 'interrupted'), diagnostic: 'storage-failure'});
            return;
          }
          this.observationError = undefined;
          await this.readHardModeTrip(next.game);
        }
      } catch {
        if (attempted) {
          this.pendingObservation ??= attempted;
          this.pendingObservation.value = {...this.pendingObservation.value, diagnostic: 'storage-failure'};
          const firstDiagnostic = attempted.diagnostics?.[0] ?? hardModeDiagnostic(attempted.value);
          const storageDiagnostic = hardModeDiagnostic(this.pendingObservation.value)!;
          this.pendingObservation.diagnostics = firstDiagnostic ? [firstDiagnostic, storageDiagnostic] : [storageDiagnostic];
          this.latchCaptureLoss(attempted.game, {...this.pendingObservation.value, assessment: unknownHardMode(Date.now(), 'interrupted'), diagnostic: 'storage-failure'});
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
  /** Called after intake stops, before the history worker closes, including when no samples are pending. */
  async flushHardMode(): Promise<void> {
    const error = await this.flushObservations();
    if (error) throw new Error('The Hard Mode audit could not be flushed.');
  }
  private lastReadingProfile:ProfileObservation|undefined;
  private pendingProfile: {key:string;input:AttachInput;token?:object}|undefined;
  private storedProfileKey:string|undefined;
  private boundaryPrevious: NonNullable<SampleInput['recording']>['previous'];
  private boundaryRunning: CapturedRunning | undefined;
  private lastEndpoint: CapturedEndpoint | undefined;
  private previousSample: NonNullable<SampleInput['recording']>['previous'];
  private previousSampleQualified = false;
  private trustedPredecessor: TrustedPredecessor | undefined;
  private continuity: {pluginSessionId:string;processInstanceId:string;sourceClockId:string;coalescedSnapshots:string;offlineTransitions:string}|undefined;
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
    due: () => dueAttach(this.state) !== null || this.pendingProfile!==undefined,
    open: context => this.openAttach(context)
  };
  constructor(private readonly client: TripRecorderClient, private readonly options: TripRecorderOptions = {}) {}

  async openSession(welcome: WelcomeMessage): Promise<SinkResult<{committedThroughEventSeq: Uint64}>> {
    await this.flushObservations();
    // The FIFO has adopted every preceding reading. Persist its bounded buffer before a new source can decide
    // membership against the previous source's endpoint; neither these sample writes nor the welcome produce ACKs.
    while (this.buffer.rowCount + this.buffer.lossCount > 0) {
      const flushed = await this.writeSamples(3600, true);
      if (!flushed.ok) return flushed;
    }
    this.lastReadingProfile=undefined;this.trustedPredecessor=undefined;
    this.pendingProfile=undefined;this.storedProfileKey=undefined;this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;this.lastEndpoint=undefined;this.continuity=undefined;
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
    // A retained failed head may retry in this session, but cannot own checks after another session supersedes it.
    // A newer boundary already accepted at intake remains the owner, including while its welcome was pending.
    const owner = this.checkOwner;
    if (owner && owner.pluginSessionId !== welcome.source.pluginSessionId && [...this.capturedEvidence.values()].includes(owner)) this.checkOwner = undefined;
    const resumed = this.view(game).current;
    if (resumed) {
      this.seedCheckTarget(game, this.state.games[game].trip!.pluginSessionId, resumed.tripUuid); this.checkTarget!.ready = true;
      this.observeHardMode(game, {assessment: unknownHardMode(Date.now(), 'interrupted'), diagnostic: 'session-transition', member: resumed.tripUuid,
        binding: null, pluginSessionId: welcome.source.pluginSessionId, sourceMonotonicNs: null});
    }
    else this.checkTarget = undefined;
    this.options.onChange?.();
    return {ok: true, value: {committedThroughEventSeq: coveredThrough}};
  }

  async commit(message: CoverageMessage, context: CommitContext): Promise<SinkResult<CommitResult>> {
    const key = this.evidenceKey(message);
    const capture = this.capturedEvidence.get(key) ?? context.hardModeCapture ?? this.capture(message);
    if (capture) {this.capturedEvidence.clear(); this.capturedEvidence.set(key, capture); this.pendingCaptures.add(capture);}
    if (capture) this.prepareCheckCapture(message, capture, false);
    try {return await this.commitCaptured(message, context, key, capture);} finally {if (capture) this.releaseCapture(capture);}
  }

  private async commitCaptured(message: CoverageMessage, context: CommitContext, key: string, capture: HardModeCapture | undefined): Promise<SinkResult<CommitResult>> {
    const observationError = await this.flushObservations();
    const retained = observationError && this.pendingObservation?.game === message.source.game ? this.pendingObservation : undefined;
    // The storage caller rule: read the coverage right before committing; the single writer keeps it until the commit.
    const covered = await this.client.committedThrough(message.source.pluginSessionId);
    if (!covered.ok) return covered;
    const coveredThrough = covered.value, receivedUtcMs = context.receivedUtcMs;
    const stepped = stepTrip(this.state, message.kind === 'event' ? {kind: 'event', message, coveredThrough, receivedUtcMs} : {kind: 'gap', message, coveredThrough, receivedUtcMs});
    if (!stepped.ok) return refused(RECORDER_CODE[stepped.code]);
    // No await between this read and posting the transaction: any earlier observed loss is part of opening/closing.
    const opening = stepped.effects.find(e => e.kind === 'trip.open');
    const member = opening?.kind === 'trip.open' ? opening.tripUuid : capture?.checkBoundary === 'job' ? this.view(message.source.game).current?.tripUuid : undefined;
    const target = capture?.checkBoundary === 'job' && member ? this.handoffChecks(capture, member, opening?.kind === 'trip.open') : undefined;
    if (!target && stepped.effects.some(e => e.kind === 'trip.close' && e.tripUuid === this.checkTarget?.batch.tripUuid)) this.checkTarget = undefined;
    const hardMode = capture ? {...capture.observation, ...(target && target.batch.sequence ? {member:target.batch.tripUuid,batch:{...target.batch},batchSessionId:target.session} : {})} : undefined;
    // An optional observer command cannot veto healthy recording. Its retained checkpoint instead commits atomically
    // with the next ordinary event/gap, so no check or original diagnostic disappears before ACK.
    const hardModeLoss = retained ? {...retained.value, assessment: unknownHardMode(Date.now(), 'interrupted'), diagnostic: 'storage-failure' as const,
      ...(retained.diagnostics?.length ? {diagnostics: retained.diagnostics} : {})} : capture?.firstUnsafe;
    const input = {message, ...(stepped.effects.length ? {effects: stepped.effects} : {}), ...(hardMode ? {hardMode, hardModeFresh: capture?.fresh ?? false} : {}), ...(hardModeLoss ? {hardModeLoss} : {})};
    const result = message.kind === 'event' ? await this.client.commitEvent(input) : await this.client.commitGap(input);
    if (!result.ok || !ADOPT.has(result.value.status)) return result;
    // R7: the gap's effects describe only (coveredThrough, lastEventSeq]; another starting point means they were wrong.
    if (message.kind === 'gap' && result.value.previouslyCoveredThrough !== coveredThrough) return refused('TRIP_COVERAGE_MISMATCH');
    this.state = stepped.state;
    if (retained && this.pendingObservation === retained && result.value.status === 'committed') {this.pendingObservation = undefined; this.observationError = undefined;}
    if (target) {target.ready = true; this.startObservationWrite();}
    if(message.kind==='gap' || message.kind==='event' && message.data.record.type==='gameTime.regression'
      || this.boundaryPrevious && this.boundaryPrevious.tripUuid!==this.view(message.source.game).current?.tripUuid){
      this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;this.lastEndpoint=undefined;this.pendingProfile=undefined;
    }
    if(message.kind==='gap' || message.kind==='event' && ['job.configured','job.cleared','truck.configured','truck.cleared','timers.restart','gameTime.regression','player.use.ferry','player.use.train'].includes(message.data.record.type)
      || this.trustedPredecessor && this.trustedPredecessor.tripUuid!==this.view(message.source.game).current?.tripUuid)this.trustedPredecessor=undefined;
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
    const previousReading=this.state.sessions[message.source.pluginSessionId]?.lastReading,previousGameClock=previousReading?.gameTime.clockId;
    if(message.kind==='snapshot'){
      const current={pluginSessionId:message.source.pluginSessionId,processInstanceId:message.source.processInstanceId,sourceClockId:message.capture.clockId,...message.data.continuity};
      const before=this.continuity;
      // Counters are cumulative. Update the baseline even when this reading occupies an already sampled second.
      if(before ? before.pluginSessionId!==current.pluginSessionId || before.processInstanceId!==current.processInstanceId || before.sourceClockId!==current.sourceClockId
        || before.coalescedSnapshots!==current.coalescedSnapshots || before.offlineTransitions!==current.offlineTransitions
        : current.coalescedSnapshots!=='0' || current.offlineTransitions!=='0'){this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;this.lastEndpoint=undefined;this.trustedPredecessor=undefined;}
      this.continuity=current;
    }
    if (message.kind === 'checkpoint') {
      this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;this.trustedPredecessor=undefined;
      // A running checkpoint may own a sampled endpoint; unchanged counters must preserve its next observed step.
      this.continuity={pluginSessionId:message.source.pluginSessionId,processInstanceId:message.source.processInstanceId,sourceClockId:message.capture.clockId,...message.data.continuity};
      const hydrated = stepTrip(next, {kind: 'checkpoint', message, receivedUtcMs: context.receivedUtcMs});
      if (!hydrated.ok) return refused(RECORDER_CODE[hydrated.code]);
      next = hydrated.state;
    }
    const profile=this.options.profileEvidence?.();
    const read = stepTrip(next, reading(message,profile));
    if (!read.ok) return refused(RECORDER_CODE[read.code]);
    this.state = read.state;
    this.lastReadingProfile=profile && profile.pluginSessionId===message.source.pluginSessionId && profile.processInstanceId===message.source.processInstanceId && profile.sourceClockId===message.capture.clockId && BigInt(message.capture.monotonicNs)>=BigInt(profile.afterMonotonicNs)?structuredClone(profile):undefined;
    const current=message.data.state.configuration.job,session=this.state.sessions[message.source.pluginSessionId];
    const replayDrained=session.attachedFromEventSeq!==null && BigInt(session.processedThrough)>=BigInt(session.attachedFromEventSeq)-1n;
    const view=tripView(this.state,message.source.game);
    this.pendingProfile=undefined;
    const normalizedBoundary=normalizeV1State(message.data.state,message.data.status);
    const status=this.options.profileStatus?.(),retained=this.trustedPredecessor,point=session.lastReading;
    if(retained){
      const sameProfile=this.lastReadingProfile && this.lastReadingProfile.binding===retained.profile.binding && this.lastReadingProfile.scope===retained.profile.scope
        && this.lastReadingProfile.loadGeneration===retained.profile.loadGeneration && this.lastReadingProfile.pluginSessionId===retained.profile.pluginSessionId
        && this.lastReadingProfile.processInstanceId===retained.profile.processInstanceId && this.lastReadingProfile.sourceClockId===retained.profile.sourceClockId;
      if(!status || status.phase==='unavailable' || status.token!==retained.token || !current.available || !compatibleContinuation(retained.job,current.value)
        || retained.tripUuid!==view.current?.tripUuid
        || this.lastReadingProfile && !sameProfile){this.trustedPredecessor=undefined;this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;}
      else if(retained.suspended || status.phase==='pending' || !this.lastReadingProfile){
        retained.suspended=true;
        // The accounting anchor may be older; safety always compares the actual consecutive readings.
        const step=previousReading&&point?classifyStep(previousReading,point,session.lastTransfer):undefined;
        const elapsed=BigInt(message.capture.monotonicNs)-BigInt(retained.qualifiedObservationNs);
        if(elapsed<=0n || elapsed>=5_000_000_000n || normalizedBoundary.simulation==='unavailable'
          || Object.values(capturedPoint(normalizedBoundary)).some(value=>value===null) || !step || step.boundary || step.elapsedNs===null || step.elapsedNs<=0n
          || step.odometer.kind!=='continuous' || step.positionJump!==null || step.fuel.kind!=='consumed' && step.fuel.kind!=='unchanged'){
          this.trustedPredecessor=undefined;this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;
        }else if(status.phase==='admitted' && sameProfile){
          this.previousSample=retained.previous;this.boundaryPrevious=retained.boundary;this.boundaryRunning=retained.running;
          this.previousSampleQualified=retained.previous!==undefined;
          this.trustedPredecessor=undefined; // A handoff is consumed; admitted reads must keep their newer live state.
        }
      }
    }
    if(status && !this.lastReadingProfile){this.previousSample=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;}
    // One retained witness cannot conceal an unsupported intermediate reading or an unretained refuel episode.
    const boundaryStep=this.boundaryPrevious && previousReading && session.lastReading ? classifyStep(previousReading,session.lastReading,session.lastTransfer) : null;
    if(this.boundaryPrevious && (!this.lastReadingProfile || this.boundaryPrevious.tripUuid!==view.current?.tripUuid || this.boundaryPrevious.sourceClockId!==message.capture.clockId
      || previousGameClock!==undefined && previousGameClock!==normalizedBoundary.gameTime.clockId
      || boundaryStep && (boundaryStep.boundary || boundaryStep.odometer.kind!=='continuous' || boundaryStep.positionJump!==null || boundaryStep.fuel.kind==='refuelled')
      || this.boundaryRunning && (this.boundaryRunning.profile.binding!==this.lastReadingProfile.binding || this.boundaryRunning.profile.scope!==this.lastReadingProfile.scope
        || this.boundaryRunning.gameClockId!==normalizedBoundary.gameTime.clockId))) {
      this.boundaryPrevious=undefined;this.boundaryRunning=undefined;this.trustedPredecessor=undefined;
    }
    this.lastEndpoint=this.lastReadingProfile && normalizedBoundary.simulation==='paused' ? {version:1,simulation:'paused',...capturedPoint(normalizedBoundary),
      ...(this.previousSample?{previous:this.previousSample}:this.boundaryPrevious?{previous:this.boundaryPrevious}:{}),...(this.boundaryRunning?{running:this.boundaryRunning}:{})}:undefined;
    if(replayDrained && current.available && view.current && this.lastReadingProfile){
      const key=JSON.stringify([view.current.tripUuid,this.lastReadingProfile.binding,current.value,normalizedBoundary.simulation, this.lastEndpoint ? {...this.lastEndpoint,previous:undefined,running:undefined}:null]);
      if(key!==this.storedProfileKey)this.pendingProfile={key,token:status?.phase==='admitted'?status.token:undefined,input:{pluginSessionId:message.source.pluginSessionId,
        nextEventSeq:(BigInt(session.processedThrough)+1n).toString(),job:structuredClone(current.value),effects:[],
        observeTripUuid:view.current.tripUuid,...(this.lastEndpoint?{endpoint:this.lastEndpoint}:{}),profile:this.lastReadingProfile,sourceClockId:message.capture.clockId,monotonicNs:message.capture.monotonicNs}};
    }
    // H2, H7: the sample sees the trip state that the commits before it in the FIFO left, and this reading.
    const sampled = sampleReading(this.sampler, {message, receivedUtcMs: context.receivedUtcMs, view: tripView(this.state, message.source.game)});
    this.sampler = sampled.state;
    if (sampled.row) {
      if(!replayDrained)sampled.row.tripUuid=null;
      if (current.available && replayDrained && sampled.row.tripUuid) {
        const normalized = normalizeV1State(message.data.state, message.data.status), t = normalized.truck;
        sampled.row.recording = {job: structuredClone(current.value), processInstanceId: message.source.processInstanceId,
          truck: t.state === 'value' && t.value.brand.id.state === 'value' && t.value.model.id.state === 'value' && t.value.licensePlate.state === 'value' ? truckKey(normalized) : null,
          profile: this.lastReadingProfile,...(this.previousSample?{previous:this.previousSample}:this.boundaryPrevious?{previous:this.boundaryPrevious}:{})};
      }
      this.previousSample=sampled.row.recording && sampled.row.tripUuid ? {tripUuid:sampled.row.tripUuid,sourceClockId:sampled.row.sourceClockId,monotonicNs:sampled.row.monotonicNs}:undefined;
      this.previousSampleQualified=sampled.row.recording?.profile!==undefined;
      if(!this.lastReadingProfile)this.trustedPredecessor=undefined;
      this.boundaryPrevious=undefined;this.boundaryRunning=undefined;
      this.buffer.push(message.source.pluginSessionId, sampled.row);
    }
    if(!sampled.row && normalizedBoundary.simulation==='running' && this.boundaryPrevious && this.lastReadingProfile && view.current) {
      this.boundaryRunning={...capturedPoint(normalizedBoundary),tripUuid:view.current.tripUuid,pluginSessionId:message.source.pluginSessionId,
        sourceClockId:message.capture.clockId,monotonicNs:message.capture.monotonicNs,profile:structuredClone(this.lastReadingProfile)};
    }
    if(message.data.state.simulation!=='running')this.previousSample=undefined;
    const predecessor=this.previousSample??this.boundaryPrevious;
    if(status?.phase==='admitted' && this.lastReadingProfile && current.available && view.current && point && predecessor && (!this.previousSample || this.previousSampleQualified)
      && !Object.values(capturedPoint(normalizedBoundary)).some(value=>value===null)){
      this.trustedPredecessor={token:status.token,profile:structuredClone(this.lastReadingProfile),tripUuid:view.current.tripUuid,job:structuredClone(current.value),
        suspended:false,referenceNs:predecessor.monotonicNs,qualifiedObservationNs:message.capture.monotonicNs,previous:this.previousSample,boundary:this.boundaryPrevious,running:this.boundaryRunning};
    }
    this.options.onChange?.();
    return {ok: true, value: undefined};
  }

  private rememberQualifiedEndpoint(input: AttachInput, token: object | undefined): void {
    const status=this.options.profileStatus?.();
    if(!status)return;
    const profile=input.profile,point=this.state.sessions[input.pluginSessionId]?.lastReading;
    if(!token || status.phase==='unavailable' || status.token!==token || !profile || !input.endpoint || !input.observeTripUuid
      || !point || point.capture.clockId!==input.sourceClockId || point.capture.monotonicNs!==input.monotonicNs
      || Object.values(input.endpoint).some(value=>value===null)){
      this.trustedPredecessor=undefined;this.boundaryPrevious=undefined;this.boundaryRunning=undefined;return;
    }
    // Persisted while qualified, even if a newer boundary arrived during the storage await. The token can revoke it.
    this.trustedPredecessor={token,profile:structuredClone(profile),tripUuid:input.observeTripUuid,job:structuredClone(input.job),suspended:false,
      referenceNs:input.monotonicNs,qualifiedObservationNs:input.monotonicNs,previous:undefined,boundary:this.boundaryPrevious,running:undefined};
  }

  /** J9: opens the due late-attach trip; `none` when nothing is due. */
  private async openAttach(context: CommitContext): Promise<SinkResult<{status: AttachStatus}>> {
    const request = dueAttach(this.state);
    if (request === null) {
      const pending=this.pendingProfile;
      if(!pending)return {ok:true,value:{status:'none'}};
      if (pending.input.endpoint) {
        while(this.buffer.rowCount+this.buffer.lossCount>0){const flushed=await this.writeSamples(3600,true);if(!flushed.ok)return flushed;}
      }
      const result=await this.client.openAttachedTrip(pending.input);
      if(result.ok){this.storedProfileKey=pending.key;if(pending.input.endpoint){this.boundaryPrevious={tripUuid:pending.input.observeTripUuid!,sourceClockId:pending.input.sourceClockId!,monotonicNs:pending.input.monotonicNs!};this.boundaryRunning=undefined;this.rememberQualifiedEndpoint(pending.input,pending.token);}if(this.pendingProfile===pending)this.pendingProfile=undefined;}
      return result;
    }
    const stepped = stepTrip(this.state, {kind: 'attach', receivedUtcMs: context.receivedUtcMs});
    if (!stepped.ok) return refused(RECORDER_CODE[stepped.code]);
    const session = this.state.sessions[request.pluginSessionId];
    const profile = this.lastReadingProfile;
    const result = await this.client.openAttachedTrip({...request, effects: stepped.effects, ...(profile && this.lastEndpoint ? {endpoint:this.lastEndpoint}:{}), ...(profile ? {profile, sourceClockId: session.lastReading?.capture.clockId ?? session.clockId ?? undefined, monotonicNs: session.lastReading?.capture.monotonicNs ?? session.lastMonotonicNs ?? undefined} : {})});
    if (!result.ok) return result;
    this.state = stepped.state;
    const attachedTrip = this.view(session.game).current;
    if (attachedTrip) {this.seedCheckTarget(session.game, request.pluginSessionId, attachedTrip.tripUuid); this.checkTarget!.ready = true;}
    this.pendingProfile=undefined;
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
    if (final) {const error = await this.flushObservations(); if (error) return {ok:false,error};}
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
    this.trustedPredecessor=undefined;
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
