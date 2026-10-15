// The pure trip lifecycle and completeness reducer (ET-014 PR-1). It turns committed protocol v1 events and gaps,
// session changes and checkpoint hydration into storage TripEffect lists. It is deterministic and never mutates its
// inputs; the caller adopts the returned state only after storage reports the commit (T3). Rules, evidence and the
// caller contract are in docs/trips.md; readings accounting (T16, T17, PR-2) builds on accounting.ts.
import type {Available, EventRecord, Money, Uint64} from '../../../contracts/src/protocol-v1';
import type {CompletenessInterval} from '../../../storage/src/api';
import type {StepSample} from '../derived';
import {
  accumulate, advanceGameTime, classifyStep, distanceUpdate, isFastAdvance, isReadingHole, jumpLabel, newAccounting, odometerDeltaM, readingPoint, startRunClock, switchRunClock,
  type GameTimeJump, type ReadingPoint, type ReadingStep
} from './accounting';
import {canonicalJson, jobKey, tripUuidFor} from './identity';
import {
  MAX_ANNOTATIONS_PER_COMMIT, MAX_EFFECTS, type ClosedTrip, type ContinuationCandidate, type EventMessage, type GameModeEvidence, type GameSlot, type GapMessage,
  type MoneyTotals, type OpenTrip, type RecordingCompleteness, type SessionState, type TripEffect, type TripGame, type TripInput, type TripSeed, type TripState,
  type TripStepResult, type WelcomeMessage, type CheckpointMessage
} from './types';

const TRAILER_SLOTS = 10;
const emptySlot = (): GameSlot => ({sessionId: null, trip: null, lastClosed: null, continuation: null, pending: [], pendingAnnotations: []});
const emptyMoney = (): MoneyTotals => ({byCurrency: [], unavailable: 0});

/** The state before any input: no connection, no session and every game idle. */
export function initialTripState(): TripState {
  return {version: 1, connection: null, sessions: {}, games: {ets2: emptySlot(), ats: emptySlot()}};
}

/**
 * Applies one input. Effects are non-empty only for `event` and `gap` inputs that carry new coverage; they belong in
 * that message's storage commit. Other inputs only change state, and any effects they decide (a restart close, a
 * not-connected interval) wait in the game's queue for its next commit carrier. A duplicate item (eventSeq at or below
 * the processed point) returns the same state object and no effects.
 */
export function stepTrip(state: TripState, input: TripInput): TripStepResult {
  switch (input.kind) {
    case 'session': return stepSession(state, input.welcome, input.coveredThrough, input.openTrips);
    case 'checkpoint': return stepCheckpoint(state, input.message);
    case 'event': return stepEvent(state, input.message, input.coveredThrough, input.receivedUtcMs);
    case 'gap': return stepGap(state, input.message, input.coveredThrough, input.receivedUtcMs);
    case 'reading': return stepReading(state, input.sample);
    case 'disconnected': return stepDisconnected(state);
  }
}

const has = (sessions: TripState['sessions'], id: string) => Object.hasOwn(sessions, id);
const modeOf = (mode: GameModeEvidence): GameModeEvidence => ({mode: mode.mode, method: mode.method, confidence: mode.confidence});
const sameMode = (a: GameModeEvidence, b: GameModeEvidence) => a.mode === b.mode && a.method === b.method && a.confidence === b.confidence;
const plain = <T>(input: Available<T> & {unit?: string}): Available<T> => input.available ? {available: true, value: input.value} : {available: false, reason: input.reason};
/** A UTC label in safe-integer milliseconds, or null when the wire value is unavailable or too large for a label. */
function utcOf(input: Available<Uint64>): number | null {
  if (!input.available) return null;
  const n = Number(input.value);
  return Number.isSafeInteger(n) ? n : null;
}
/** The value key of a truck or trailer configuration record: equal keys are an identical re-send. */
const valueKey = (record: Extract<EventRecord, {type: 'truck.configured' | 'trailer.configured'}>) => canonicalJson(record);
/** A shallow copy without the given keys. */
function omit<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key))) as Omit<T, K>;
}

function freshSession(welcome: WelcomeMessage, coveredThrough: Uint64): SessionState {
  return {
    pluginSessionId: welcome.source.pluginSessionId, game: welcome.source.game, processedThrough: coveredThrough,
    // A session first seen at coverage 0 starts with the load burst of O1; joining later, the load state is unknown.
    load: coveredThrough === '0' ? 'loading' : 'unknown', gameMode: modeOf(welcome.data.gameMode), clockId: welcome.capture.clockId,
    lastUtcMs: null, lastMonotonicNs: null, truck: null, trailers: new Array<null>(TRAILER_SLOTS).fill(null), untrackedJob: null, attachedFromEventSeq: null, disconnected: null,
    lastReading: null, connectionSinceNs: null, lastTransfer: null, runClock: null, gameTimeWindow: null, jumpEpisode: null, bridge: null
  };
}
function seedTrip(seed: TripSeed): OpenTrip {
  return {
    tripUuid: seed.tripUuid, pluginSessionId: seed.pluginSessionId, jobKey: seed.jobKey, jobEventSeq: null, phase: seed.awaitingOutcome === true ? 'awaiting-outcome' : 'active', reloadEventSeq: null, loadCheck: null,
    completeness: seed.recordingCompleteness, gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false,
    startedUtcMs: seed.startedUtcMs, startedMonotonicNs: null, clockId: null, market: null, cargoLoaded: null, truckKey: null,
    trailerKeys: new Array<null>(TRAILER_SLOTS).fill(null), plannedDistance: null, expectedIncome: null,
    fines: emptyMoney(), finesBeforeLoaded: emptyMoney(), tolls: emptyMoney(), transfers: emptyMoney(), accounting: newAccounting(seed.observedDistanceM ?? null)
  };
}
function closedFrom(trip: OpenTrip, close: Pick<ClosedTrip, 'outcome' | 'closeReason' | 'endedUtcMs' | 'endedMonotonicNs' | 'completeness'>,
  extra: Partial<Pick<ClosedTrip, 'revenue' | 'penalty' | 'deliveredDistance'>> = {}): ClosedTrip {
  const rest = omit(trip, ['phase', 'reloadEventSeq', 'loadCheck']);
  return {...rest, ...close, revenue: extra.revenue ?? null, penalty: extra.penalty ?? null, deliveredDistance: extra.deliveredDistance ?? null};
}
/** An annotation (T13): recorded as a discontinuity interval that never downgrades completeness. */
function annotation(tripUuid: string, detail: Record<string, unknown>): TripEffect {
  return {kind: 'completeness.add', interval: {tripUuid, kind: 'discontinuity', detail: {annotation: true, ...detail}}};
}
/**
 * Queues annotations; consecutive ones of the same trip, cause and label merge into one with a count (T18). The first
 * keeps its values; the merged one adds the last position (`lastAtEventSeq`, or `lastAtMonotonicNs` for a reading).
 * A refuel never merges: each one is a separate episode with its own litres.
 */
function queueAnnotations(slot: GameSlot, annotations: TripEffect[]) {
  for (const effect of annotations) {
    const last = slot.pendingAnnotations.at(-1);
    if (last?.kind === 'completeness.add' && effect.kind === 'completeness.add' && last.interval.tripUuid === effect.interval.tripUuid &&
      last.interval.detail?.cause === effect.interval.detail?.cause && last.interval.detail?.label === effect.interval.detail?.label && effect.interval.detail?.cause !== 'refuel') {
      const detail = last.interval.detail!, next = effect.interval.detail!;
      last.interval.detail = {...detail, count: (typeof detail.count === 'number' ? detail.count : 1) + 1,
        ...(next.atMonotonicNs !== undefined ? {lastAtMonotonicNs: next.atMonotonicNs} : {lastAtEventSeq: next.atEventSeq})};
    } else slot.pendingAnnotations.push(effect);
  }
}
/**
 * The effects of one commit carrier (T18): queued lifecycle effects first, then the carrier's own effects, then at most
 * eight annotations, never more than MAX_EFFECTS in total. The carrier's own effects always fit (at most six by
 * construction: a distance update and a close, then an open with three cause intervals) because they may reference
 * `this-event`; queued effects never do, so they can wait.
 */
function assemble(slot: GameSlot, own: TripEffect[], annotations: TripEffect[]): TripEffect[] {
  if (own.length > MAX_EFFECTS) throw new Error('Trip reducer invariant: too many effects for one event');
  const lifecycle = slot.pending.splice(0, MAX_EFFECTS - own.length);
  queueAnnotations(slot, annotations);
  const notes = slot.pendingAnnotations.splice(0, Math.min(MAX_ANNOTATIONS_PER_COMMIT, MAX_EFFECTS - own.length - lifecycle.length));
  return [...lifecycle, ...own, ...notes];
}

interface Carrier {
  state: TripState; session: SessionState; slot: GameSlot; game: TripGame;
  own: TripEffect[]; annotations: TripEffect[];
  /** UTC label (T15): occurred.utcUnixMs, else the session's last label, else the receipt time. */
  label: number; monotonicNs: Uint64 | null; eventSeq: Uint64 | null; simulation: 'running' | 'paused' | 'unavailable' | null;
}

/** Closes the open trip of the carrier's game. A non-outcome close is always partial; an outcome close is complete only after a clean window (T13). */
function closeTrip(c: Carrier, outcome: ClosedTrip['outcome'], closeReason: ClosedTrip['closeReason'], extra: Partial<Pick<ClosedTrip, 'revenue' | 'penalty' | 'deliveredDistance'>> = {}) {
  const trip = c.slot.trip!;
  // The observed distance is persisted before every close (T16).
  const distance = distanceUpdate(trip.tripUuid, trip.accounting);
  if (distance !== null) c.own.push(distance);
  let ended = c.label;
  // UTC is a label and can be set back; the schema requires ended >= started, so clamp and annotate (T15).
  if (ended < trip.startedUtcMs) {
    c.annotations.push(annotation(trip.tripUuid, {cause: 'utc-label-jump', labelUtcMs: ended, clampedToUtcMs: trip.startedUtcMs, atEventSeq: c.eventSeq}));
    ended = trip.startedUtcMs;
  }
  const completeness: RecordingCompleteness = outcome !== 'none' && trip.completeness === 'unknown' ? 'complete' : 'partial';
  c.own.push({kind: 'trip.close', tripUuid: trip.tripUuid, outcome, closeReason, ...(outcome !== 'none' ? {outcomeEvent: 'this-event' as const} : {}),
    recordingCompleteness: completeness, endedUtcMs: ended});
  const endedMonotonicNs = trip.clockId !== null && trip.clockId === c.session.clockId ? c.monotonicNs ?? c.session.lastMonotonicNs : null;
  c.slot.lastClosed = closedFrom(trip, {outcome, closeReason, endedUtcMs: ended, endedMonotonicNs, completeness}, extra);
  c.slot.continuation = outcome === 'none' ? {tripUuid: trip.tripUuid, jobKey: trip.jobKey, cause: closeReason} : null;
  c.slot.trip = null;
}

interface OpenOptions {
  /** The job configuration event of the trip; `this-event` unless a reload check opens from its re-send (T8). */
  jobEventSeq: Uint64; jobRef: 'this-event' | {eventSeq: Uint64}; key: string;
  job: Pick<OpenTrip, 'market' | 'cargoLoaded' | 'plannedDistance' | 'expectedIncome'>;
  /** A reload-check continuation replaces the load, late-attach and continuation causes (T8). */
  reloadOf?: string; loadCheck: OpenTrip['loadCheck'];
}
/** An event replayed from the producer's retention: it happened before the current connection's checkpoint. */
const replayed = (c: Carrier) => c.eventSeq !== null && c.session.attachedFromEventSeq !== null && BigInt(c.eventSeq) < BigInt(c.session.attachedFromEventSeq);
/** The untracked job that applies to the carrier's event. A checkpoint job describes the checkpoint, so it applies only from it on. */
function untrackedFor(c: Carrier): SessionState['untrackedJob'] {
  const job = c.session.untrackedJob;
  return job !== null && job.source === 'checkpoint' && replayed(c) ? null : job;
}
/** Ends the untracked job at a clear, an outcome or a new trip, unless the event is replayed from before its checkpoint. */
function endUntracked(c: Carrier) { if (untrackedFor(c) !== null) c.session.untrackedJob = null; }
/** Opens a trip at the carrier event with its cause intervals (T9, T11, T12, T8). */
function openTrip(c: Carrier, o: OpenOptions) {
  const s = c.session, uuid = tripUuidFor(s.pluginSessionId, o.jobEventSeq);
  const causes: CompletenessInterval[] = [];
  const continuation: ContinuationCandidate | null = c.slot.continuation;
  c.slot.continuation = null;
  if (o.reloadOf !== undefined) causes.push({kind: 'discontinuity', detail: {cause: 'reload', continuationOf: o.reloadOf, decision: 'not-merged'}});
  else {
    if (s.load === 'loading') causes.push({kind: 'discontinuity', detail: {cause: 'opened-at-load'}});
    // A configuration replayed from before the checkpoint is a real start, but the consumer was not attached then and has
    // no readings for that time. A checkpoint job without its configuration event is a late attach (T9).
    const untracked = untrackedFor(c);
    if (replayed(c)) causes.push({kind: 'not-connected', detail: {cause: 'opened-before-attach'}});
    else if (untracked?.source === 'checkpoint' && untracked.key === o.key) causes.push({kind: 'not-connected', detail: {cause: 'late-attach'}});
    if (continuation !== null && continuation.jobKey !== null && continuation.jobKey === o.key) {
      causes.push({kind: 'discontinuity', detail: {cause: continuation.cause, continuationOf: continuation.tripUuid, decision: 'not-merged'}});
    }
  }
  // The untracked job is now tracked; a replayed different job leaves the later checkpoint job in place.
  if (s.untrackedJob?.key === o.key) s.untrackedJob = null; else endUntracked(c);
  const completeness: RecordingCompleteness = causes.length ? 'partial' : 'unknown';
  const trailers = s.trailers.flatMap(t => t === null ? [] : [{eventSeq: t.eventSeq}]);
  c.own.push({kind: 'trip.open', tripUuid: uuid, game: c.game, gameMode: modeOf(s.gameMode), jobConfiguration: o.jobRef,
    ...(s.truck !== null ? {truckConfiguration: {eventSeq: s.truck.eventSeq}} : {}), ...(trailers.length ? {trailerConfigurations: trailers} : {}),
    recordingCompleteness: completeness, startedUtcMs: c.label});
  for (const interval of causes) c.own.push({kind: 'completeness.add', interval: {tripUuid: uuid, ...interval, detail: {...interval.detail, atEventSeq: c.eventSeq}}});
  c.slot.trip = {
    tripUuid: uuid, pluginSessionId: s.pluginSessionId, jobKey: o.key, jobEventSeq: o.jobEventSeq, phase: 'active', reloadEventSeq: null, loadCheck: o.loadCheck,
    completeness, gameMode: modeOf(s.gameMode), gameModeAmbiguous: false, startedUtcMs: c.label, startedMonotonicNs: c.monotonicNs, clockId: s.clockId,
    ...o.job, truckKey: s.truck?.key ?? null, trailerKeys: s.trailers.map(t => t?.key ?? null),
    fines: emptyMoney(), finesBeforeLoaded: emptyMoney(), tolls: emptyMoney(), transfers: emptyMoney(), accounting: newAccounting()
  };
}
const jobFields = (record: Extract<EventRecord, {type: 'job.configured'}>): OpenOptions['job'] => ({
  market: plain(record.market), cargoLoaded: plain(record.cargoLoaded), plannedDistance: plain(record.plannedDistance), expectedIncome: plain(record.expectedIncome)
});
/** Opens a trip at a job.configured event. A job configured outside a running simulation starts in its load window. */
function openFromEvent(c: Carrier, record: Extract<EventRecord, {type: 'job.configured'}>, key: string) {
  openTrip(c, {jobEventSeq: c.eventSeq!, jobRef: 'this-event', key, job: jobFields(record), loadCheck: c.simulation === 'running' ? null : 'before-start'});
}
/** Marks the open trip partial once, with the cause interval (T13). */
function downgrade(c: Carrier, kind: CompletenessInterval['kind'], detail: Record<string, unknown>) {
  const trip = c.slot.trip!;
  if (trip.completeness !== 'partial') { c.own.push({kind: 'trip.update', tripUuid: trip.tripUuid, set: {recordingCompleteness: 'partial'}}); trip.completeness = 'partial'; }
  c.own.push({kind: 'completeness.add', interval: {tripUuid: trip.tripUuid, kind, detail: {...detail, atEventSeq: c.eventSeq}}});
}
/**
 * Resolves a reload check (T8) at a decisive event that is not a game-time regression: the old trip closes as
 * configuration-cleared and a new trip opens from the identical re-send, marked as a not-merged continuation. A timer
 * restart belongs to the same load, so the new trip keeps its load window.
 */
function resolveReload(c: Carrier, decisive: 'restart' | 'other') {
  const old = c.slot.trip!, resend = old.reloadEventSeq!;
  closeTrip(c, 'none', 'configuration-cleared');
  openTrip(c, {jobEventSeq: resend, jobRef: {eventSeq: resend}, key: old.jobKey!, reloadOf: old.tripUuid, loadCheck: decisive === 'restart' ? 'before-start' : null,
    job: {market: old.market, cargoLoaded: old.cargoLoaded, plannedDistance: old.plannedDistance, expectedIncome: old.expectedIncome}});
}
function attribute(c: Carrier, tripUuid: string | null, attribution: 'trip' | 'trip-before-loaded' | 'free-driving' | 'ambiguous') {
  c.own.push({kind: 'event.attribute', tripUuid, attribution});
}
/** T14: an event of an active cargo-market job whose cargo is known not to be loaded yet. */
const beforeLoaded = (trip: OpenTrip) => trip.market?.available === true && trip.market.value === 'cargo_market' && trip.cargoLoaded?.available === true && !trip.cargoLoaded.value;
function tally(totals: MoneyTotals, amount: Available<Money>) {
  if (!amount.available) { totals.unavailable += 1; return; }
  const money = amount.value, key = canonicalJson([money.currency, money.sdkType]);
  const entry = totals.byCurrency.find(t => canonicalJson([t.currency, t.sdkType]) === key);
  if (entry) { entry.total = (BigInt(entry.total) + BigInt(money.raw)).toString(); entry.count += 1; }
  else totals.byCurrency.push({currency: {...money.currency}, sdkType: money.sdkType, total: BigInt(money.raw).toString(), count: 1});
}

function onJobConfigured(c: Carrier, record: Extract<EventRecord, {type: 'job.configured'}>) {
  const key = jobKey(record), trip = c.slot.trip;
  if (trip === null) { openFromEvent(c, record, key); return; }
  if (trip.jobKey === key) {
    const loaded = plain(record.cargoLoaded);
    // The same job while active: a re-send, such as the cargo-market pickup that changes only cargoLoaded (O3).
    if (trip.phase === 'active') { trip.cargoLoaded = loaded; return; }
    // After a clear, a re-send continues the trip only when every attribute, cargoLoaded included, is identical
    // (concept.md, October 14, 2026); a reload check then decides (T8).
    if (canonicalJson(loaded) === canonicalJson(trip.cargoLoaded)) {
      if (trip.phase === 'awaiting-outcome') { trip.phase = 'reload-check'; trip.reloadEventSeq = c.eventSeq; }
      return;
    }
    // A changed cargoLoaded, such as a save from before the pickup, is a not-merged continuation. The closed trip keeps its value.
    closeTrip(c, 'none', 'configuration-cleared');
    openTrip(c, {jobEventSeq: c.eventSeq!, jobRef: 'this-event', key, job: jobFields(record), reloadOf: trip.tripUuid, loadCheck: c.simulation === 'running' ? null : 'before-start'});
    return;
  }
  // A different job closes the trip: without a clear it replaced the job, after a clear the configuration was cleared.
  closeTrip(c, 'none', trip.phase === 'active' ? 'different-job' : 'configuration-cleared');
  openFromEvent(c, record, key);
}
function onOutcome(c: Carrier, record: Extract<EventRecord, {type: 'job.delivered' | 'job.cancelled'}>) {
  const trip = c.slot.trip;
  if (trip === null) {
    // No attachable trip, or the outcome of a job that hydration showed or a gap hid, which no trip tracks (T9, T14).
    // The job has ended, so it is neither untracked nor a continuation candidate any more.
    attribute(c, null, 'ambiguous'); endUntracked(c); c.slot.continuation = null; return;
  }
  if (trip.phase === 'reload-check') {
    // An outcome right after an identical re-send may belong to either trip (T8, T14). The old trip closes and no new
    // trip opens, because the outcome ended whichever job it was.
    closeTrip(c, 'none', 'configuration-cleared'); c.slot.continuation = null; attribute(c, null, 'ambiguous'); return;
  }
  // T14: after a replaced or loaded configuration, an outcome before the first start may belong to the earlier job.
  if (trip.phase === 'active' && trip.loadCheck === 'before-start') { attribute(c, null, 'ambiguous'); return; }
  attribute(c, trip.tripUuid, trip.phase === 'active' && beforeLoaded(trip) ? 'trip-before-loaded' : 'trip');
  if (record.type === 'job.delivered') closeTrip(c, 'delivered', 'outcome', {revenue: plain(record.revenue), deliveredDistance: plain(record.distance)});
  else closeTrip(c, 'cancelled', 'outcome', {penalty: plain(record.penalty)});
}
function onGameplay(c: Carrier, record: Extract<EventRecord, {type: 'player.fined' | 'player.tollgate.paid' | 'player.use.ferry' | 'player.use.train'}>) {
  const trip = c.slot.trip;
  // Free driving only outside any active job (concept.md, October 13, 2026): a job that is known or likely active but
  // untracked makes the event ambiguous.
  if (trip === null) { attribute(c, null, untrackedFor(c) !== null ? 'ambiguous' : 'free-driving'); return; }
  if (trip.phase === 'awaiting-outcome') { attribute(c, null, 'free-driving'); return; }
  if (trip.phase === 'reload-check') { resolveReload(c, 'other'); attribute(c, null, 'ambiguous'); return; }
  const early = beforeLoaded(trip);
  attribute(c, trip.tripUuid, early ? 'trip-before-loaded' : 'trip');
  if (record.type === 'player.fined') tally(early ? trip.finesBeforeLoaded : trip.fines, record.amount);
  else if (record.type === 'player.tollgate.paid') tally(trip.tolls, record.amount);
  else tally(trip.transfers, record.amount);
}
/** timers.restart (T7, T12): closes the trip as a discontinuity unless it is the load that restored this job. */
function onTimersRestart(c: Carrier) {
  const trip = c.slot.trip;
  c.session.load = 'loading';
  if (trip === null) return;
  if (trip.phase === 'reload-check') { resolveReload(c, 'restart'); return; }
  if (trip.phase === 'active' && trip.loadCheck !== null) {
    if (trip.completeness !== 'partial') downgrade(c, 'discontinuity', {cause: 'opened-at-load'});
    trip.loadCheck = 'before-start';
    return;
  }
  closeTrip(c, 'none', 'discontinuity');
}
/** gameTime.regression (O9, O10): a save load. It continues a reload-checked or just-loaded trip as partial, else closes it. */
function onRegression(c: Carrier, record: Extract<EventRecord, {type: 'gameTime.regression'}>) {
  const trip = c.slot.trip;
  // A regression follows the start of the load it ends (O10), so it never starts a load (T12).
  if (c.simulation === 'running') c.session.load = 'running';
  if (trip === null) return;
  const detail = {cause: 'save-load', fromClockId: record.from.clockId, toClockId: record.to.clockId};
  if (trip.phase === 'reload-check') {
    trip.phase = 'active'; trip.reloadEventSeq = null; trip.loadCheck = null;
    downgrade(c, 'discontinuity', detail);
    return;
  }
  if (trip.phase === 'active' && trip.loadCheck !== null) {
    downgrade(c, 'discontinuity', detail);
    trip.loadCheck = trip.loadCheck === 'before-start' ? 'before-start' : null;
    return;
  }
  closeTrip(c, 'none', 'discontinuity');
}
function onTruck(c: Carrier, record: Extract<EventRecord, {type: 'truck.configured'}>) {
  const key = valueKey(record);
  c.session.truck = {eventSeq: c.eventSeq!, key};
  const trip = c.slot.trip;
  if (trip === null || trip.truckKey === key) return;
  c.own.push({kind: 'trip.update', tripUuid: trip.tripUuid, set: {truckConfiguration: 'this-event'}});
  // A first truck reference is not a change; a different truck is annotated and never downgrades (T13).
  if (trip.truckKey !== null) c.annotations.push(annotation(trip.tripUuid, {cause: 'truck-change', atEventSeq: c.eventSeq}));
  trip.truckKey = key;
}
function onTrailer(c: Carrier, record: Extract<EventRecord, {type: 'trailer.configured'}>) {
  const key = valueKey(record);
  c.session.trailers[record.index] = {eventSeq: c.eventSeq!, key};
  const trip = c.slot.trip;
  if (trip === null || trip.trailerKeys[record.index] === key) return;
  c.own.push({kind: 'trip.update', tripUuid: trip.tripUuid, set: {trailerConfigurations: ['this-event']}});
  trip.trailerKeys[record.index] = key;
}

function carrierFor(draft: TripState, session: SessionState, label: number, monotonicNs: Uint64 | null, eventSeq: Uint64 | null, simulation: Carrier['simulation']): Carrier {
  return {state: draft, session, slot: draft.games[session.game], game: session.game, own: [], annotations: [], label, monotonicNs, eventSeq, simulation};
}
/** Shared checks of a commit carrier: the current connection's session, then exact coverage (T5). */
function carrierSession(state: TripState, source: {pluginSessionId: string; game: TripGame}, coveredThrough: Uint64): SessionState | 'UNKNOWN_SESSION' | 'COVERAGE_MISMATCH' {
  const id = source.pluginSessionId;
  if (state.connection !== id || !has(state.sessions, id) || state.sessions[id].game !== source.game) return 'UNKNOWN_SESSION';
  return coveredThrough === state.sessions[id].processedThrough ? state.sessions[id] : 'COVERAGE_MISMATCH';
}

function stepEvent(state: TripState, message: EventMessage, coveredThrough: Uint64, receivedUtcMs: number): TripStepResult {
  const checked = carrierSession(state, message.source, coveredThrough);
  if (typeof checked === 'string') return {ok: false, code: checked};
  const seq = BigInt(message.data.eventSeq), processed = BigInt(checked.processedThrough);
  if (seq <= processed) return {ok: true, state, effects: []};
  if (seq !== processed + 1n) return {ok: false, code: 'ORDER_VIOLATION'};
  const draft = structuredClone(state), session = draft.sessions[checked.pluginSessionId], {occurred, record} = message.data;
  const label = utcOf(occurred.utcUnixMs) ?? session.lastUtcMs ?? receivedUtcMs;
  const c = carrierFor(draft, session, label, occurred.monotonicNs.available ? occurred.monotonicNs.value : null, message.data.eventSeq, occurred.simulation);
  // The one event right after the first start may still be the load's regression (O10); any other event ends the window.
  if (c.slot.trip?.loadCheck === 'after-start' && record.type !== 'gameTime.regression') c.slot.trip.loadCheck = null;
  switch (record.type) {
    case 'job.configured': onJobConfigured(c, record); break;
    case 'job.cleared':
      endUntracked(c);
      // T7: the trip waits for an outcome. A clear inside a reload check undoes the re-send and waits again.
      if (c.slot.trip !== null) {
        const trip = c.slot.trip;
        trip.phase = 'awaiting-outcome'; trip.reloadEventSeq = null;
        // T16: the trip stops being active, so the next step is not counted even if it becomes active again before it.
        if (trip.accounting.lastReading === 'active') trip.accounting.lastReading = 'open';
      }
      break;
    case 'job.delivered': case 'job.cancelled': onOutcome(c, record); break;
    case 'player.use.ferry': case 'player.use.train':
      // T17: a game-time or position jump next to a transfer, by source time, is labelled a crossing.
      if (c.monotonicNs !== null) session.lastTransfer = {clockId: message.capture.clockId, monotonicNs: c.monotonicNs};
      onGameplay(c, record); break;
    case 'player.fined': case 'player.tollgate.paid': onGameplay(c, record); break;
    case 'truck.configured': onTruck(c, record); break;
    case 'truck.cleared': session.truck = null; break;
    case 'trailer.configured': onTrailer(c, record); break;
    case 'trailer.cleared': session.trailers[record.index] = null; break;
    case 'simulation.started':
      session.load = 'running';
      if (c.slot.trip?.loadCheck === 'before-start') c.slot.trip.loadCheck = 'after-start';
      break;
    case 'simulation.paused': break;
    case 'timers.restart': onTimersRestart(c); break;
    case 'gameTime.regression': onRegression(c, record); break;
    case 'source.gameMode': {
      session.gameMode = modeOf(record);
      const trip = c.slot.trip;
      // concept.md, October 13, 2026: a contradicting mode is kept as evidence and marks the trip ambiguous.
      if (trip !== null && !trip.gameModeAmbiguous && !sameMode(trip.gameMode, session.gameMode)) {
        c.own.push({kind: 'trip.update', tripUuid: trip.tripUuid, set: {gameModeAmbiguous: true}}); trip.gameModeAmbiguous = true;
      }
      break;
    }
  }
  session.processedThrough = message.data.eventSeq; session.lastUtcMs = label; session.clockId = message.capture.clockId;
  if (c.monotonicNs !== null) session.lastMonotonicNs = c.monotonicNs;
  // T17: each live event's simulation state splits the running time since the last reading. A replayed event happened
  // before the connection's first reading.
  if (session.runClock !== null && c.monotonicNs !== null && !replayed(c)) session.runClock = switchRunClock(session.runClock, message.capture.clockId, c.monotonicNs, occurred.simulation);
  flushDistance(c);
  return {ok: true, state: draft, effects: assemble(c.slot, c.own, c.annotations)};
}
/** T16: every commit carrier persists the open trip's observed distance when it changed. */
function flushDistance(c: Carrier) {
  const trip = c.slot.trip, update = trip === null ? null : distanceUpdate(trip.tripUuid, trip.accounting);
  if (update !== null) c.own.push(update);
}

/** Every loss cause is the consumer's absence (offline, no durable consumer, retention expiry): not connected; else event loss (T10). */
function gapKind(message: GapMessage): 'not-connected' | 'event-loss' {
  const causes = message.data.causes;
  return causes.queueCount === '0' && causes.queueBytes === '0' && causes.encodingFailed === '0' ? 'not-connected' : 'event-loss';
}
function stepGap(state: TripState, message: GapMessage, coveredThrough: Uint64, receivedUtcMs: number): TripStepResult {
  const checked = carrierSession(state, message.source, coveredThrough);
  if (typeof checked === 'string') return {ok: false, code: checked};
  const first = BigInt(message.data.firstEventSeq), last = BigInt(message.data.lastEventSeq), processed = BigInt(checked.processedThrough);
  // Only the suffix beyond the processed point is new (storage's previouslyCoveredThrough rule).
  if (last <= processed) return {ok: true, state, effects: []};
  if (first > processed + 1n) return {ok: false, code: 'ORDER_VIOLATION'};
  const draft = structuredClone(state), session = draft.sessions[checked.pluginSessionId], suffixFirst = processed + 1n;
  const c = carrierFor(draft, session, session.lastUtcMs ?? receivedUtcMs, null, null, null);
  const d = message.data, whole = first === suffixFirst;
  // Monotonic bounds describe the whole record, so they are kept only when the suffix is the whole record.
  const bounds = whole ? {
    ...(d.firstLostMonotonicNs.available ? {startMonotonicNs: d.firstLostMonotonicNs.value} : {}),
    ...(d.lastLostMonotonicNs.available ? {endMonotonicNs: d.lastLostMonotonicNs.value} : {}),
    sourceClockId: message.capture.clockId
  } : {};
  const closing = c.slot.trip, tripUuid = closing?.tripUuid ?? null;
  if (closing !== null) {
    closeTrip(c, 'none', 'gap');
    // The job was not cleared before the gap, so it is likely still active: untracked until a clear or an outcome.
    if (closing.phase !== 'awaiting-outcome' && closing.jobKey !== null) session.untrackedJob = {key: closing.jobKey, source: 'gap'};
  }
  c.own.push({kind: 'completeness.add', interval: {tripUuid, kind: gapKind(message), firstEventSeq: suffixFirst.toString(), lastEventSeq: d.lastEventSeq, ...bounds,
    detail: {cause: 'gap', causes: {...d.causes}, firstEventSeq: d.firstEventSeq, lastEventSeq: d.lastEventSeq, redelivered: d.redelivered}}});
  // Events inside the gap are unknown: a hidden start, restart or regression leaves the load state unknown.
  session.load = 'unknown';
  session.processedThrough = d.lastEventSeq; session.lastUtcMs = c.label; session.clockId = message.capture.clockId;
  flushDistance(c);
  return {ok: true, state: draft, effects: assemble(c.slot, c.own, c.annotations)};
}

/** Queues a restart close of a trip of an earlier session (T11), at its last observed label as a lower bound (T15). */
function restartClose(slot: GameSlot, trip: OpenTrip, lastUtcMs: number | null) {
  // The observed distance is persisted before every close (T16).
  const distance = distanceUpdate(trip.tripUuid, trip.accounting);
  if (distance !== null) slot.pending.push(distance);
  let ended = lastUtcMs ?? trip.startedUtcMs;
  if (ended < trip.startedUtcMs) {
    slot.pendingAnnotations.push(annotation(trip.tripUuid, {cause: 'utc-label-jump', labelUtcMs: ended, clampedToUtcMs: trip.startedUtcMs, atEventSeq: null}));
    ended = trip.startedUtcMs;
  }
  slot.pending.push({kind: 'trip.close', tripUuid: trip.tripUuid, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: ended});
  slot.lastClosed = closedFrom(trip, {outcome: 'none', closeReason: 'restart', endedUtcMs: ended, endedMonotonicNs: null, completeness: 'partial'});
  slot.continuation = {tripUuid: trip.tripUuid, jobKey: trip.jobKey, cause: 'restart'};
}
function withoutBounds(effect: Extract<TripEffect, {kind: 'completeness.add'}>): TripEffect {
  return {kind: 'completeness.add', interval: omit(effect.interval, ['startMonotonicNs', 'endMonotonicNs', 'sourceClockId'])};
}
/** Queues a partial downgrade and a not-connected interval for an open trip outside a commit carrier. */
function queueNotConnected(slot: GameSlot, trip: OpenTrip, interval: Omit<CompletenessInterval, 'tripUuid' | 'kind'>) {
  queueDowngrade(slot, trip, {kind: 'not-connected', ...interval});
}

function stepSession(state: TripState, welcome: WelcomeMessage, coveredThrough: Uint64, seeds: TripSeed[]): TripStepResult {
  const id = welcome.source.pluginSessionId, game = welcome.source.game;
  if (has(state.sessions, id)) {
    // A reconnection within a known session: the caller's coverage must equal the processed point (T3, T5).
    const known = state.sessions[id];
    if (known.game !== game) return {ok: false, code: 'UNKNOWN_SESSION'};
    if (coveredThrough !== known.processedThrough) return {ok: false, code: 'COVERAGE_MISMATCH'};
    const draft = structuredClone(state), session = draft.sessions[id], slot = draft.games[game], gone = session.disconnected;
    draft.connection = id; session.disconnected = null;
    if (gone !== null && slot.trip !== null && slot.trip.pluginSessionId === id) {
      // The consumer was not connected for part of the trip; nothing is bridged across that interval (T13).
      const sameClock = gone.clockId !== null && gone.clockId === welcome.capture.clockId && gone.monotonicNs !== null;
      const end = welcome.capture.monotonicNs;
      queueNotConnected(slot, slot.trip, {
        ...(gone.utcMs !== null ? {startUtcMs: gone.utcMs} : {}),
        ...(sameClock ? {startMonotonicNs: gone.monotonicNs!, ...(BigInt(end) >= BigInt(gone.monotonicNs!) ? {endMonotonicNs: end} : {}), sourceClockId: gone.clockId!} : {}),
        detail: {cause: 'disconnected', odometerDeltaM: null}
      });
      // Nothing is bridged across the hole (T16); the first reading of this connection records the odometer change.
      session.bridge = {tripUuid: slot.trip.tripUuid, before: gone.reading};
    }
    return {ok: true, state: draft, effects: []};
  }
  const draft = structuredClone(state), slot = draft.games[game];
  // A continuation candidate of the earlier session now lies across a plugin restart, whatever closed its trip (T11).
  if (slot.continuation !== null) slot.continuation = {...slot.continuation, cause: 'restart'};
  // An earlier plugin session of this game has ended: its open trip closes at the new session's first carrier (T11).
  const previous = slot.trip !== null && has(draft.sessions, slot.trip.pluginSessionId) ? draft.sessions[slot.trip.pluginSessionId] : null;
  if (slot.trip !== null) { restartClose(slot, slot.trip, previous?.lastUtcMs ?? null); slot.trip = null; }
  for (const other of Object.keys(draft.sessions)) if (draft.sessions[other].game === game) delete draft.sessions[other];
  // Storage scopes source clocks to the committing session, so a queued interval of an earlier session drops its
  // monotonic bounds before a carrier of this session commits it (T11).
  slot.pending = slot.pending.map(effect => effect.kind === 'completeness.add' && effect.interval.sourceClockId !== undefined ? withoutBounds(effect) : effect);
  const session = freshSession(welcome, coveredThrough);
  draft.sessions[id] = session; draft.connection = id; slot.sessionId = id;
  // Trips this reducer already closed (their close may still be queued) are never closed again.
  const closed = new Set(slot.pending.flatMap(effect => effect.kind === 'trip.close' ? [effect.tripUuid] : []));
  if (slot.lastClosed !== null) closed.add(slot.lastClosed.tripUuid);
  for (const seed of seeds) {
    if (seed.game !== game || closed.has(seed.tripUuid)) continue;
    closed.add(seed.tripUuid);
    if (seed.pluginSessionId !== id) { restartClose(slot, seedTrip(seed), seed.lastObservedUtcMs ?? null); continue; }
    if (slot.trip !== null) {
      // Storage holds a second open trip of this session: never two open trips per game, so it closes as a discontinuity.
      slot.pending.push({kind: 'trip.close', tripUuid: seed.tripUuid, outcome: 'none', closeReason: 'discontinuity', recordingCompleteness: 'partial',
        endedUtcMs: Math.max(seed.lastObservedUtcMs ?? seed.startedUtcMs, seed.startedUtcMs)});
      continue;
    }
    // A cold start inside the trip's own session: it resumes, partial, because the consumer was not running (T13).
    slot.trip = seedTrip(seed);
    if (seed.lastObservedUtcMs !== undefined) session.lastUtcMs = seed.lastObservedUtcMs;
    queueNotConnected(slot, slot.trip, {detail: {cause: 'consumer-restart'}});
  }
  return {ok: true, state: draft, effects: []};
}

/** Hydration only (T9): a checkpoint never opens, closes or attributes. It marks a job that no trip tracks. */
function stepCheckpoint(state: TripState, message: CheckpointMessage): TripStepResult {
  const id = message.source.pluginSessionId;
  if (state.connection !== id || !has(state.sessions, id) || state.sessions[id].game !== message.source.game) return {ok: false, code: 'UNKNOWN_SESSION'};
  const draft = structuredClone(state), session = draft.sessions[id], job = message.data.state.configuration.job;
  session.attachedFromEventSeq = message.data.status.delivery.nextEventSeq;
  if (draft.games[session.game].trip === null) session.untrackedJob = job.available ? {key: jobKey(job.value), source: 'checkpoint'} : null;
  return {ok: true, state: draft, effects: []};
}

function stepDisconnected(state: TripState): TripStepResult {
  if (state.connection === null) return {ok: true, state, effects: []};
  const draft = structuredClone(state), session = draft.sessions[draft.connection!];
  draft.connection = null;
  if (session !== undefined) {
    session.disconnected = {utcMs: session.lastUtcMs, monotonicNs: session.lastMonotonicNs, clockId: session.clockId, reading: session.lastReading};
    // The next connection starts its own readings: no step crosses a connection hole (T16).
    session.lastReading = null; session.connectionSinceNs = null; session.runClock = null; session.gameTimeWindow = null; session.jumpEpisode = null; session.bridge = null;
  }
  return {ok: true, state: draft, effects: []};
}

/** A game-time jump at a reading: a new episode, or an episode that grew by a fast advance (T17). */
type GameJump = GameTimeJump & {grows: 'new' | 'extend'};
/**
 * One reading of the current connection (T16, T17). It changes only state: distance, fuel and refuels accumulate on
 * the open trip, and annotations or a reading-hole downgrade wait for the game's next commit carrier.
 */
function stepReading(state: TripState, sample: StepSample & {utcMs?: number}): TripStepResult {
  const id = sample.source.pluginSessionId;
  if (state.connection !== id || !has(state.sessions, id) || state.sessions[id].game !== sample.source.game) return {ok: false, code: 'UNKNOWN_SESSION'};
  const draft = structuredClone(state), session = draft.sessions[id], slot = draft.games[session.game], next = readingPoint(sample), prev = session.lastReading;
  if (session.bridge !== null) { recordBridge(slot, session.bridge, next); session.bridge = null; }
  session.connectionSinceNs ??= next.capture.monotonicNs;
  // The game-time window and the running time belong to the session's readings, whatever trip is open.
  const advanced = advanceGameTime(session.gameTimeWindow, prev, next), episode = session.jumpEpisode;
  session.gameTimeWindow = advanced.window;
  // A detected jump starts an episode; while it holds, the episode grows only by fast advances (isFastAdvance).
  const jump: GameJump | null = advanced.jump === null ? null : episode === null ? {...advanced.jump, grows: 'new'}
    : isFastAdvance(episode.lastNs, episode.lastMinutes, next) ? {...advanced.jump, grows: 'extend'} : null;
  const hole = prev !== null && session.runClock !== null && isReadingHole(session.runClock, next);
  let annotated: string | null = null;
  const trip = slot.trip;
  if (trip !== null && trip.pluginSessionId === id) {
    const acc = trip.accounting;
    // A step belongs to the trip only when its earlier reading was taken while the trip was open; it counts towards
    // distance and fuel only when the trip was active at both readings.
    if (prev !== null && acc.lastReading !== 'none') {
      if (hole) queueHole(slot, trip, prev, next, session.connectionSinceNs);
      if (acc.lastReading === 'active' && trip.phase === 'active') {
        accountStep(slot, trip, session, prev, next, classifyStep(prev, next), jump);
        if (jump !== null) annotated = trip.tripUuid;
      }
    }
    acc.lastReading = trip.phase === 'active' ? 'active' : 'open';
  }
  session.jumpEpisode = advanced.jump === null ? null : jump === null ? episode
    : {tripUuid: annotated ?? (jump.grows === 'extend' ? episode?.tripUuid ?? null : null), lastNs: next.capture.monotonicNs, lastMinutes: next.gameTime.minutes!};
  session.lastReading = next; session.runClock = startRunClock(next);
  return {ok: true, state: draft, effects: []};
}
/** Records the odometer change across a connection hole in its not-connected interval, while that interval still waits. */
function recordBridge(slot: GameSlot, bridge: NonNullable<SessionState['bridge']>, next: ReadingPoint) {
  for (let i = slot.pending.length - 1; i >= 0; i--) {
    const effect = slot.pending[i];
    if (effect.kind === 'completeness.add' && effect.interval.tripUuid === bridge.tripUuid && effect.interval.detail?.cause === 'disconnected') {
      effect.interval.detail = {...effect.interval.detail, odometerDeltaM: odometerDeltaM(bridge.before, next)};
      return;
    }
  }
}
function readingNote(tripUuid: string, next: ReadingPoint, detail: Record<string, unknown>): TripEffect {
  return annotation(tripUuid, {...detail, atMonotonicNs: next.capture.monotonicNs});
}
/**
 * This trip's latest waiting annotation of `cause`, wherever it waits: the episode still growing in place. Annotations
 * leave in order, so an annotation of an earlier episode cannot still wait once a later one was sent.
 */
function waitingNote(slot: GameSlot, tripUuid: string, cause: string): Extract<TripEffect, {kind: 'completeness.add'}> | undefined {
  for (let i = slot.pendingAnnotations.length - 1; i >= 0; i--) {
    const effect = slot.pendingAnnotations[i];
    if (effect.kind === 'completeness.add' && effect.interval.tripUuid === tripUuid && effect.interval.detail?.cause === cause) return effect;
  }
  return undefined;
}
/** Accumulates one counted step on the active trip and annotates its discontinuities (T13, T16, T17). */
function accountStep(slot: GameSlot, trip: OpenTrip, session: SessionState, prev: ReadingPoint, next: ReadingPoint, step: ReadingStep, jump: GameJump | null) {
  const {refuel} = accumulate(trip.accounting, step), notes: TripEffect[] = [];
  const odometer = step.odometer;
  if (odometer.kind === 'discontinuity' && (odometer.cause === 'odometer-regressed' || odometer.cause === 'odometer-jump') && prev.odometer.state === 'value' && next.odometer.state === 'value') {
    notes.push(readingNote(trip.tripUuid, next, {cause: odometer.cause, deltaM: next.odometer.value.meters - prev.odometer.value.meters}));
  }
  if (jump !== null) {
    // One game-time jump is one annotation while it keeps growing: its end and label follow the jump. Once the
    // annotation has been sent, a jump that still continues gets a new one marked `continues`, starting where the sent
    // one ended, so the ranges never overlap.
    const episode = session.jumpEpisode, continuing = jump.grows === 'extend' && episode?.tripUuid === trip.tripUuid;
    const from = continuing ? {ns: episode.lastNs, minutes: episode.lastMinutes} : {ns: jump.fromNs, minutes: jump.fromMinutes};
    const label = jumpLabel(session.lastTransfer, from.ns, next, 'possible-sleep');
    const waiting = continuing ? waitingNote(slot, trip.tripUuid, 'game-time-jump') : undefined;
    if (waiting !== undefined) {
      const detail = waiting.interval.detail!;
      waiting.interval.detail = {...detail, toMinutes: jump.toMinutes, lastAtMonotonicNs: next.capture.monotonicNs, ...(label === 'crossing' ? {label} : {})};
    } else notes.push(readingNote(trip.tripUuid, next, {cause: 'game-time-jump', label, fromMinutes: from.minutes, toMinutes: jump.toMinutes, ...(continuing ? {continues: true} : {})}));
  }
  if (step.positionJump !== null) {
    notes.push(readingNote(trip.tripUuid, next, {cause: 'position-jump', label: jumpLabel(session.lastTransfer, prev.capture.monotonicNs, next, 'possible-teleport'), meters: step.positionJump.meters}));
  }
  if (refuel !== null) {
    // One refuel episode is one annotation: its litres grow while the annotation still waits to be sent; an episode
    // that continues after it was sent gets a new one marked `continues`.
    const waiting = refuel.episode ? undefined : waitingNote(slot, trip.tripUuid, 'refuel');
    if (waiting !== undefined) {
      const detail = waiting.interval.detail!;
      waiting.interval.detail = {...detail, addedLiters: (detail.addedLiters as number) + refuel.addedLiters, lastAtMonotonicNs: next.capture.monotonicNs};
    } else notes.push(readingNote(trip.tripUuid, next, {cause: 'refuel', addedLiters: refuel.addedLiters, ...(refuel.episode ? {} : {continues: true})}));
  }
  queueAnnotations(slot, notes);
}
/** At most this many reading-hole intervals of one trip wait for a carrier; a further hole extends the last one. */
const MAX_WAITING_HOLES = 4;
/**
 * Queues a reading hole of the open trip (T17): it makes the trip partial with a `sample-loss` interval between the two
 * readings. A hole that starts where the last waiting one ended extends it; beyond MAX_WAITING_HOLES waiting holes, a
 * further one extends the last one too and marks that the interval now includes readings (`includesReadings`). Only
 * holes of the current connection (from `sinceNs` on) count, so no interval is ever extended across a disconnection.
 */
function queueHole(slot: GameSlot, trip: OpenTrip, prev: ReadingPoint, next: ReadingPoint, sinceNs: string | null) {
  let waiting = 0, last: Extract<TripEffect, {kind: 'completeness.add'}> | undefined;
  for (const effect of slot.pending) {
    if (effect.kind === 'completeness.add' && effect.interval.tripUuid === trip.tripUuid && effect.interval.detail?.cause === 'reading-hole' &&
      sinceNs !== null && effect.interval.startMonotonicNs !== undefined && BigInt(effect.interval.startMonotonicNs) >= BigInt(sinceNs)) { waiting += 1; last = effect; }
  }
  const contiguous = last?.interval.endMonotonicNs === prev.capture.monotonicNs;
  if (last !== undefined && last.interval.sourceClockId === next.capture.clockId && (contiguous || waiting >= MAX_WAITING_HOLES)) {
    const {startUtcMs, endUtcMs: _end, detail, ...rest} = last.interval;
    void _end;
    const utc = startUtcMs !== undefined && next.utcMs !== null && next.utcMs >= startUtcMs ? {startUtcMs, endUtcMs: next.utcMs} : {};
    last.interval = {...rest, ...utc, endMonotonicNs: next.capture.monotonicNs,
      detail: {...detail, holes: (typeof detail?.holes === 'number' ? detail.holes : 1) + 1, ...(contiguous ? {} : {includesReadings: true})}};
    return;
  }
  const utc = prev.utcMs !== null && next.utcMs !== null && next.utcMs >= prev.utcMs ? {startUtcMs: prev.utcMs, endUtcMs: next.utcMs} : {};
  queueDowngrade(slot, trip, {kind: 'sample-loss', ...utc, startMonotonicNs: prev.capture.monotonicNs, endMonotonicNs: next.capture.monotonicNs,
    sourceClockId: next.capture.clockId, detail: {cause: 'reading-hole'}});
}
/** Queues a partial downgrade and a missing or discontinuous interval for an open trip outside a commit carrier. */
function queueDowngrade(slot: GameSlot, trip: OpenTrip, interval: Omit<CompletenessInterval, 'tripUuid'>) {
  if (trip.completeness !== 'partial') { slot.pending.push({kind: 'trip.update', tripUuid: trip.tripUuid, set: {recordingCompleteness: 'partial'}}); trip.completeness = 'partial'; }
  slot.pending.push({kind: 'completeness.add', interval: {tripUuid: trip.tripUuid, ...interval}});
}
