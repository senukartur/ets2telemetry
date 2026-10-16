// Replays an ET-005b protocol v1 simulator run through the ET-014 trip reducer the way the ET-015a caller will
// (docs/trips.md, caller contract), into an in-memory first-insert storage model written from docs/storage.md (OD-9 trip
// effects). It is a test adapter: it opens no database and writes no history. The model follows the scripted client of
// each connection: a commit the client does not make is not made here either, and the reducer state is then kept (T3).
import type {EventRecord, ServerMessage} from '../../packages/contracts/src/protocol-v1';
import type {CompletenessInterval, SampleAppendResult, SampleInput} from '../../packages/storage/src/api';
import {initialTripState, jobKey, normalizeV1State, stepTrip, type TripEffect, type TripInput, type TripSeed, type TripState} from '../../packages/telemetry-core/src/index';
import type {ReplayResult} from '../../tools/telemetry-simulator/src/v1/replay';

/** The simulator's UTC label origin (docs/simulator-v1.md, clocks); the consumer's receipt label uses it too. */
const UTC_BASE_MS = 1_800_000_000_000;
type Of<K extends ServerMessage['kind']> = Extract<ServerMessage, {kind: K}>;
const NOT_OBSERVED = {available: false as const, reason: 'not-observed' as const};

export interface StoredTrip {
  tripUuid: string; pluginSessionId: string; game: 'ets2' | 'ats'; gameMode: {mode: string; method: string; confidence: string}; gameModeAmbiguous: boolean;
  jobConfigurationEventSeq: string; truckConfigurationEventSeq: string | null; trailerConfigurationEventSeqs: string[]; openedEventSeq: string;
  outcome: 'open' | 'delivered' | 'cancelled' | 'none'; outcomeEventSeq: string | null; closeReason: string | null;
  recordingCompleteness: string; startedUtcMs: number; endedUtcMs: number | null;
  observedDistanceM: {available: true; value: number} | {available: false; reason: string};
  /** S-1 (ET-016 PR-6): litres, persisted like observed distance. */
  fuelUsedL: {available: true; value: number} | {available: false; reason: string};
}
export interface StoredAttribution {pluginSessionId: string; eventSeq: string; tripUuid: string | null; attribution: string}
export type StoredInterval = CompletenessInterval & {pluginSessionId: string};
export type StoredSample = SampleInput & {pluginSessionId: string};

/**
 * Rows keyed UNIQUE(plugin_session_id, event_seq) with contiguous coverage per session. Effects are applied only when
 * an event or gap is inserted for the first time; a duplicate event or a covered gap stores nothing. Every rule of
 * docs/storage.md "Trip effects" that the reducer could break is checked and throws. ET-015b: sample rows of a known
 * session, with docs/storage.md's `uniqueSeconds` rule and the sample trip-reference rule.
 */
export class TripStorageModel {
  private coverage = new Map<string, {game: 'ets2' | 'ats'; through: bigint; lastUtcMs: number | null}>();
  private jobs = new Map<string, Extract<EventRecord, {type: 'job.configured'}>>();
  /** The last job.configured or job.cleared event per session, to tell whether an open trip's job was cleared. */
  private lastJobEvent = new Map<string, {type: string; eventSeq: bigint}>();
  private trucks = new Set<string>();
  private trailers = new Set<string>();
  readonly trips: StoredTrip[] = [];
  readonly attributions: StoredAttribution[] = [];
  readonly intervals: StoredInterval[] = [];
  readonly samples: StoredSample[] = [];
  readonly statuses = {committed: 0, duplicate: 0, covered: 0};

  committedThrough(session: string): string { return (this.coverage.get(session)?.through ?? 0n).toString(); }
  /** Stores a session at its welcome, as upsertSession does, so samples may name it before its first commit. */
  openSession(session: string, game: 'ets2' | 'ats'): void {
    const known = this.coverage.get(session);
    if (known === undefined) this.coverage.set(session, {game, through: 0n, lastUtcMs: null});
    else if (known.game !== game) throw new Error('Session game changed');
  }
  /**
   * appendSamples (docs/storage.md, ET-015b H6): every row must name a stored trip of the session's game or none; with
   * `uniqueSeconds` a row whose source second floor(monotonicNs / 1e9) is at or below the last accepted second of its
   * clock (seeded with the session's latest stored row) is skipped.
   */
  appendSamples(session: string, rows: SampleInput[], options: {uniqueSeconds?: boolean} = {}): SampleAppendResult {
    const known = this.coverage.get(session);
    if (known === undefined) throw new Error(`Samples of unknown session ${session}`);
    for (const row of rows) {
      if (row.tripUuid === null || row.tripUuid === undefined) continue;
      const trip = this.trips.find(t => t.tripUuid === row.tripUuid);
      if (trip === undefined || trip.game !== known.game) throw new Error(`Sample names trip ${row.tripUuid} that is not of this session's game`);
    }
    const last = new Map<string, bigint>(), latest = this.samples.filter(s => s.pluginSessionId === session).at(-1);
    if (options.uniqueSeconds && latest) last.set(latest.sourceClockId, BigInt(latest.monotonicNs) / 1_000_000_000n);
    let appended = 0;
    for (const row of rows) {
      const second = BigInt(row.monotonicNs) / 1_000_000_000n, previous = last.get(row.sourceClockId);
      if (options.uniqueSeconds && previous !== undefined && second <= previous) continue;
      if (options.uniqueSeconds) last.set(row.sourceClockId, second);
      this.samples.push({pluginSessionId: session, ...structuredClone(row)});
      appended++;
    }
    return {appended, skipped: rows.length - appended};
  }
  /** The stored open trips of a game, as a cold start reads them (TripSeed). */
  /** An open trip whose session's last stored job event, after the trip opened, is a clear: it awaits its outcome. */
  private cleared(t: StoredTrip): boolean {
    const last = this.lastJobEvent.get(t.pluginSessionId);
    return last !== undefined && last.type === 'job.cleared' && last.eventSeq > BigInt(t.openedEventSeq);
  }
  seeds(game: 'ets2' | 'ats'): TripSeed[] {
    return this.trips.filter(t => t.outcome === 'open' && t.game === game).map(t => {
      const job = this.jobs.get(`${t.pluginSessionId}:${t.jobConfigurationEventSeq}`), last = this.coverage.get(t.pluginSessionId)?.lastUtcMs ?? null;
      return {tripUuid: t.tripUuid, pluginSessionId: t.pluginSessionId, game: t.game, jobKey: job === undefined ? null : jobKey(job), startedUtcMs: t.startedUtcMs,
        recordingCompleteness: t.recordingCompleteness as TripSeed['recordingCompleteness'], ...(last !== null ? {lastObservedUtcMs: last} : {}),
        ...(t.observedDistanceM.available ? {observedDistanceM: t.observedDistanceM.value} : {}), ...(t.fuelUsedL.available ? {fuelUsedL: t.fuelUsedL.value} : {}),
        ...(this.cleared(t) ? {awaitingOutcome: true} : {})};
    });
  }
  private session(m: Of<'event'> | Of<'gap'>) {
    let s = this.coverage.get(m.source.pluginSessionId);
    if (s === undefined) { s = {game: m.source.game, through: 0n, lastUtcMs: null}; this.coverage.set(m.source.pluginSessionId, s); }
    return s;
  }
  commitEvent(m: Of<'event'>, effects: TripEffect[]): 'committed' | 'duplicate' {
    const s = this.session(m), seq = BigInt(m.data.eventSeq);
    if (seq <= s.through) {
      if (effects.length) throw new Error(`Effects supplied for duplicate event ${seq}`);
      this.statuses.duplicate++; return 'duplicate';
    }
    if (seq !== s.through + 1n) throw new Error(`Non-contiguous event ${seq}`);
    const key = `${m.source.pluginSessionId}:${m.data.eventSeq}`, record = m.data.record;
    if (record.type === 'job.configured') this.jobs.set(key, record);
    if (record.type === 'job.configured' || record.type === 'job.cleared') this.lastJobEvent.set(m.source.pluginSessionId, {type: record.type, eventSeq: seq});
    if (record.type === 'truck.configured') this.trucks.add(key);
    if (record.type === 'trailer.configured') this.trailers.add(key);
    this.apply(m, effects);
    s.through = seq;
    if (m.data.occurred.utcUnixMs.available) s.lastUtcMs = Number(m.data.occurred.utcUnixMs.value);
    this.statuses.committed++; return 'committed';
  }
  commitGap(m: Of<'gap'>, effects: TripEffect[]): 'committed' | 'covered' {
    const s = this.session(m), first = BigInt(m.data.firstEventSeq), last = BigInt(m.data.lastEventSeq);
    if (last <= s.through) {
      if (effects.length) throw new Error(`Effects supplied for covered gap ${first}-${last}`);
      this.statuses.covered++; return 'covered';
    }
    if (first > s.through + 1n) throw new Error(`Non-contiguous gap ${first}-${last}`);
    this.apply(m, effects);
    s.through = last; this.statuses.committed++; return 'committed';
  }
  private trip(m: Of<'event'> | Of<'gap'>, uuid: string | null | undefined): StoredTrip | undefined {
    if (uuid === null || uuid === undefined) return undefined;
    const trip = this.trips.find(t => t.tripUuid === uuid);
    if (trip === undefined) throw new Error(`Unknown trip ${uuid}`);
    if (trip.game !== m.source.game) throw new Error('Trip reference of another game');
    return trip;
  }
  private apply(m: Of<'event'> | Of<'gap'>, effects: TripEffect[]) {
    if (effects.length > 16) throw new Error('More than 16 effects in one commit');
    const session = m.source.pluginSessionId, event = m.kind === 'event' ? m : null, here = event?.data.eventSeq;
    const ref = (r: 'this-event' | {eventSeq: string}, known: {has(key: string): boolean}, type: string): string => {
      if (r === 'this-event') { if (event?.data.record.type !== type) throw new Error(`this-event is not ${type}`); return here!; }
      if (!known.has(`${session}:${r.eventSeq}`)) throw new Error(`No ${type} at ${r.eventSeq} in this session`);
      return r.eventSeq;
    };
    for (const effect of effects) {
      switch (effect.kind) {
        case 'trip.open': {
          if (event === null || this.trips.some(t => t.tripUuid === effect.tripUuid) || effect.game !== m.source.game) throw new Error('Invalid trip.open');
          this.trips.push({tripUuid: effect.tripUuid, pluginSessionId: session, game: effect.game, gameMode: {...effect.gameMode}, gameModeAmbiguous: effect.gameModeAmbiguous ?? false,
            jobConfigurationEventSeq: ref(effect.jobConfiguration, this.jobs, 'job.configured'),
            truckConfigurationEventSeq: effect.truckConfiguration === undefined ? null : ref(effect.truckConfiguration, this.trucks, 'truck.configured'),
            trailerConfigurationEventSeqs: (effect.trailerConfigurations ?? []).map(r => ref(r, this.trailers, 'trailer.configured')), openedEventSeq: here!,
            outcome: 'open', outcomeEventSeq: null, closeReason: null, recordingCompleteness: effect.recordingCompleteness, startedUtcMs: effect.startedUtcMs, endedUtcMs: null,
            observedDistanceM: NOT_OBSERVED, fuelUsedL: NOT_OBSERVED});
          break;
        }
        case 'trip.update': {
          const trip = this.trip(m, effect.tripUuid)!, set = effect.set;
          const allowed = trip.outcome === 'open' ? ['recordingCompleteness', 'gameModeAmbiguous', 'observedDistanceM', 'fuelUsedL', 'truckConfiguration', 'trailerConfigurations']
            : ['recordingCompleteness', 'observedDistanceM', 'fuelUsedL'];
          if (Object.keys(set).some(key => !allowed.includes(key))) throw new Error(`trip.update of ${Object.keys(set).join(',')} on a ${trip.outcome} trip`);
          if (set.recordingCompleteness !== undefined) trip.recordingCompleteness = set.recordingCompleteness;
          if (set.gameModeAmbiguous !== undefined) trip.gameModeAmbiguous = set.gameModeAmbiguous;
          if (set.observedDistanceM !== undefined) {
            if (set.observedDistanceM.available && !(Number.isFinite(set.observedDistanceM.value) && set.observedDistanceM.value >= 0)) throw new Error('Invalid observed distance');
            trip.observedDistanceM = structuredClone(set.observedDistanceM);
          }
          if (set.fuelUsedL !== undefined) {
            if (set.fuelUsedL.available && !(Number.isFinite(set.fuelUsedL.value) && set.fuelUsedL.value >= 0)) throw new Error('Invalid fuel used');
            trip.fuelUsedL = structuredClone(set.fuelUsedL);
          }
          if (set.truckConfiguration !== undefined) trip.truckConfigurationEventSeq = ref(set.truckConfiguration, this.trucks, 'truck.configured');
          for (const r of set.trailerConfigurations ?? []) trip.trailerConfigurationEventSeqs.push(ref(r, this.trailers, 'trailer.configured'));
          break;
        }
        case 'trip.close': {
          const trip = this.trip(m, effect.tripUuid)!;
          if (trip.outcome !== 'open') throw new Error(`Trip ${trip.tripUuid} closed twice`);
          if (effect.outcome !== 'none') {
            if (event?.data.record.type !== (effect.outcome === 'delivered' ? 'job.delivered' : 'job.cancelled') || effect.outcomeEvent !== 'this-event') throw new Error('Outcome without its event');
            trip.outcomeEventSeq = here!;
          }
          if (effect.endedUtcMs < trip.startedUtcMs) throw new Error('ended_utc_ms below started_utc_ms');
          Object.assign(trip, {outcome: effect.outcome, closeReason: effect.closeReason, recordingCompleteness: effect.recordingCompleteness, endedUtcMs: effect.endedUtcMs});
          break;
        }
        case 'event.attribute':
          if (event === null || this.attributions.some(a => a.pluginSessionId === session && a.eventSeq === here)) throw new Error('Invalid event.attribute');
          if ((effect.tripUuid === null) !== (effect.attribution === 'free-driving' || effect.attribution === 'ambiguous')) throw new Error('Attribution and trip disagree');
          this.trip(m, effect.tripUuid);
          this.attributions.push({pluginSessionId: session, eventSeq: here!, tripUuid: effect.tripUuid, attribution: effect.attribution});
          break;
        case 'completeness.add': {
          const i = effect.interval;
          this.trip(m, i.tripUuid);
          if ((i.startMonotonicNs !== undefined || i.endMonotonicNs !== undefined) && i.sourceClockId !== m.capture.clockId) throw new Error('Interval bounds outside the committing session clock');
          if (i.startMonotonicNs !== undefined && i.endMonotonicNs !== undefined && BigInt(i.endMonotonicNs) < BigInt(i.startMonotonicNs)) throw new Error('Interval ends before it starts');
          if (i.startUtcMs !== undefined && i.endUtcMs !== undefined && i.endUtcMs < i.startUtcMs) throw new Error('Interval UTC ends before it starts');
          this.intervals.push({pluginSessionId: session, ...structuredClone(i)});
          break;
        }
      }
    }
    const open = this.trips.filter(t => t.outcome === 'open' && t.game === m.source.game);
    if (open.length > 1) throw new Error('Two open trips of one game');
  }
}

/** A reducer reading from a checkpoint or snapshot: the normalized state with its source identity and capture time. */
function reading(m: Of<'checkpoint'> | Of<'snapshot'>): TripInput {
  const utc = m.data.state.captureUtcUnixMs;
  return {kind: 'reading', sample: {source: {game: m.source.game, origin: m.source.origin, pluginSessionId: m.source.pluginSessionId, processInstanceId: m.source.processInstanceId},
    capture: {clockId: m.capture.clockId, monotonicNs: m.capture.monotonicNs}, state: normalizeV1State(m.data.state, m.data.status), ...(utc.available ? {utcMs: Number(utc.value)} : {})}};
}
function adopt(state: TripState, input: TripInput): TripState {
  const result = stepTrip(state, input);
  if (!result.ok) throw new Error(`Trip reducer refused ${input.kind}: ${result.code}`);
  if (result.effects.length) throw new Error(`Effects from a non-carrier input ${input.kind}`);
  return result.state;
}

export interface TripReplay {
  state: TripState; storage: TripStorageModel;
  /** Readings fed, carriers stepped, and consumer process starts (the first one and one after each client crash). */
  readings: number; carriers: number; consumerStarts: number;
}
/**
 * Feeds the transcript's server messages in order: `session` at each welcome (with the stored open trips after a
 * consumer start), `checkpoint` and then its state as a reading, each snapshot as a reading, and each event or gap as a
 * carrier with the storage coverage read right before the commit. A connection that ends normally ends with
 * `disconnected`; a client crash loses the reducer state, as a process crash would. A carrier the scripted client does
 * not commit (`none`, or the `failAt` item) is not committed: the old state is kept and nothing more of that connection,
 * reading or carrier, is fed, because durable delivery closes the connection on a failed commit (ET-006b).
 */
export function replayTrips(result: Pick<ReplayResult, 'transcript' | 'connections'>): TripReplay {
  const storage = new TripStorageModel(), records = new Map(result.connections.map(c => [c.connection, c]));
  const out: TripReplay = {state: initialTripState(), storage, readings: 0, carriers: 0, consumerStarts: 1};
  let fresh = true, connection: number | null = null, stopped = false;
  const end = () => {
    if (connection === null) return;
    if (records.get(connection)!.closedBy === 'crash') { out.state = initialTripState(); fresh = true; out.consumerStarts++; }
    else out.state = adopt(out.state, {kind: 'disconnected'});
    connection = null;
  };
  for (const line of result.transcript) {
    if (line.direction !== 'server') continue;
    if (line.connection !== connection) { end(); connection = line.connection; stopped = false; }
    if (stopped) continue;
    const m = line.message as ServerMessage, record = records.get(connection)!;
    if (!record.durableRequested || record.policy === undefined) throw new Error('Trip replay needs durable scripted connections');
    switch (m.kind) {
      case 'welcome': {
        const known = Object.hasOwn(out.state.sessions, m.source.pluginSessionId);
        out.state = adopt(out.state, {kind: 'session', welcome: m, coveredThrough: storage.committedThrough(m.source.pluginSessionId), openTrips: !known && fresh ? storage.seeds(m.source.game) : []});
        fresh = false; break;
      }
      case 'checkpoint': out.state = adopt(adopt(out.state, {kind: 'checkpoint', message: m}), reading(m)); out.readings++; break;
      case 'snapshot': out.state = adopt(out.state, reading(m)); out.readings++; break;
      case 'event': case 'gap': {
        const coveredThrough = storage.committedThrough(m.source.pluginSessionId), receivedUtcMs = UTC_BASE_MS + line.atMs;
        const input: TripInput = m.kind === 'event' ? {kind: 'event', message: m, coveredThrough, receivedUtcMs} : {kind: 'gap', message: m, coveredThrough, receivedUtcMs};
        const stepped = stepTrip(out.state, input);
        if (!stepped.ok) throw new Error(`Trip reducer refused ${m.kind}: ${stepped.code}`);
        out.carriers++;
        const policy = record.policy.commit, first = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.firstEventSeq), last = BigInt(m.kind === 'event' ? m.data.eventSeq : m.data.lastEventSeq);
        if (policy.kind === 'none' || (policy.kind === 'failAt' && first <= policy.eventSeq && policy.eventSeq <= last)) { stopped = true; break; }
        if (m.kind === 'event') storage.commitEvent(m, stepped.effects); else storage.commitGap(m, stepped.effects);
        // T3: committed, duplicate and covered all adopt the stepped state.
        out.state = stepped.state;
        break;
      }
      default: break;
    }
  }
  end();
  return out;
}
