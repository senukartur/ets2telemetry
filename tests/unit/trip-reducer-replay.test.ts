// ET-014 PR-1 replay and property checks. A rebuilt state equals the running one; redelivery changes nothing; seeded
// random streams never break the storage effect rules of docs/storage.md (at most 16 effects, closed trips stay
// closed, outcomes only from their own events, one attribution per gameplay event, same-game references). The model
// below is written from docs/storage.md and docs/trips.md, not from the reducer.
import {describe, expect, it} from 'vitest';
import {GAMEPLAY_EVENT_TYPES, type EventRecord, type LossCounts} from '../../packages/contracts/src/protocol-v1';
import {dueAttach, initialTripState, jobKey, stepTrip, type EventMessage, type GapMessage, type TripEffect, type TripInput, type TripSeed, type TripState} from '../../packages/telemetry-core/src/index';
import {
  ATS_A, BASE_UTC, ETS2_A, ETS2_B, Script, cargoMarketJob, carrier, job, otherJob, r, sessionInput, trailer, truck
} from '../shared/trip-messages';

/** A seeded pseudo-random generator (mulberry32). */
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const paused = {simulation: 'paused'} as const;

/** One recorded run: every input as fed (with its coverage), the state before each input and each input's effects. */
interface Recording {inputs: TripInput[]; states: TripState[]; effects: TripEffect[][]; final: TripState}
function record(steps: (EventMessage | GapMessage | TripInput)[]): Recording {
  let state = initialTripState();
  const out: Recording = {inputs: [], states: [], effects: [], final: state};
  for (const step of steps) {
    const input = 'version' in step ? carrier(state, step) : step;
    const result = stepTrip(state, input);
    if (!result.ok) throw new Error(`Unexpected ${result.code}`);
    out.inputs.push(input); out.states.push(state); out.effects.push(result.effects);
    state = result.state;
  }
  out.final = state;
  return out;
}
function fold(inputs: TripInput[], state = initialTripState()): {state: TripState; effects: TripEffect[][]} {
  const effects: TripEffect[][] = [];
  for (const input of inputs) {
    const result = stepTrip(state, input);
    if (!result.ok) throw new Error(`Unexpected ${result.code}`);
    effects.push(result.effects); state = result.state;
  }
  return {state, effects};
}

/** A long mixed stream over two plugin sessions of ETS2 and one of ATS: deliveries, a cancellation, a save load, gaps, a reconnect and a restart. */
function mixedStream() {
  const a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 500_000}), t = new Script(ATS_A, 'ats', {utcMs: BASE_UTC + 300_000});
  const steps: (EventMessage | GapMessage | TripInput)[] = [sessionInput(a.welcome()),
    a.event(r.truckConfigured(), paused), a.event(r.trailerConfigured(), paused), a.event(r.timersRestart(), paused), a.event(r.started()),
    a.event(r.fined()), a.event(r.paused(), paused), a.event(r.jobConfigured(), paused), a.event(r.started()), a.event(r.toll()),
    a.event(r.paused(), paused), a.event(r.delivered(), paused), a.event(r.jobCleared(), paused),
    a.event(r.jobConfigured(cargoMarketJob(false)), paused), a.event(r.started()), a.event(r.fined()), a.event(r.paused(), paused),
    a.event(r.jobConfigured(cargoMarketJob(true)), paused), a.event(r.started()), a.event(r.paused(), paused), a.event(r.jobCleared(), paused),
    a.event(r.truckCleared(), paused), a.event(r.jobConfigured(cargoMarketJob(true)), paused), a.event(r.truckConfigured(), paused), a.event(r.started()),
    a.event(r.regression('12345', '12000')), a.gap(3), a.event(r.ferry(), paused), a.event(r.started()),
    {kind: 'disconnected'}, sessionInput(t.welcome()), t.event(r.started()), t.event(r.paused(), paused), t.event(r.jobConfigured(otherJob()), paused),
    t.event(r.started()), t.event(r.fined()), {kind: 'disconnected'}];
  // The ETS2 session reconnects at its processed point, then the plugin restarts with a new session.
  // ET-016 PR-7 (J9): the gap closed the trip, so the reconnection's checkpoint job opens a late-attach trip at once.
  steps.push(sessionInput(a.welcome(), (a.next - 1n).toString()), {kind: 'checkpoint', message: a.checkpoint(job())}, {kind: 'attach', receivedUtcMs: BASE_UTC}, a.event(r.paused(), paused),
    a.event(r.jobConfigured(), paused), a.event(r.started()), a.event(r.truckConfigured(truck({licensePlate: {available: true, value: 'SYN 0009'}}))),
    {kind: 'disconnected'}, sessionInput(b.welcome()), b.event(r.jobConfigured(), paused), b.event(r.timersRestart(), paused), b.event(r.started()),
    b.event(r.paused(), paused), b.event(r.jobCleared(), paused), b.event(r.trailerConfigured(trailer(0)), paused), b.event(r.cancelled(), paused));
  return {steps, last: b};
}

describe('replay (T3)', () => {
  it('rebuilding from any prefix of the inputs and continuing equals the single run', () => {
    const {steps} = mixedStream(), single = record(steps);
    expect(single.effects.flat().length).toBeGreaterThan(20);
    for (let k = 0; k <= single.inputs.length; k++) {
      const prefix = fold(single.inputs.slice(0, k));
      if (k < single.inputs.length) expect(prefix.state, `prefix ${k}`).toEqual(single.states[k]);
      const rest = fold(single.inputs.slice(k), prefix.state);
      expect(rest.effects, `continuation from ${k}`).toEqual(single.effects.slice(k));
      expect(rest.state).toEqual(single.final);
    }
    // The state is plain data: it survives JSON unchanged.
    expect(JSON.parse(JSON.stringify(single.final))).toEqual(single.final);
  });
  it('redelivering every item of the connected session changes nothing', () => {
    const {steps, last} = mixedStream(), single = record(steps);
    const own = single.inputs.filter((input): input is Extract<TripInput, {kind: 'event' | 'gap'}> =>
      (input.kind === 'event' || input.kind === 'gap') && input.message.source.pluginSessionId === last.session);
    expect(own.length).toBeGreaterThan(5);
    for (const input of own) {
      const result = stepTrip(single.final, carrier(single.final, input.message));
      expect(result).toEqual({ok: true, state: single.final, effects: []});
      if (result.ok) expect(result.state).toBe(single.final);
    }
  });
});

/** Storage's effect rules (docs/storage.md, "Trip effects") plus the ET-014 invariants, checked against applied effects. */
class EffectModel {
  trips = new Map<string, {game: string; session: string; closed: boolean; startedUtcMs: number; jobKey: string | null; completeness: 'unknown' | 'partial'}>();
  /** Job keys of every job.configured event, and the truck and trailer configuration events, by "session:eventSeq". */
  jobEvents = new Map<string, string>();
  truckEvents = new Set<string>();
  trailerEvents = new Set<string>();
  /** The open trips of a game as a cold start would read them from storage (TripSeed). */
  seeds(game: string): TripSeed[] {
    return [...this.trips.entries()].filter(([, t]) => !t.closed && t.game === game).map(([tripUuid, t]) => ({tripUuid, pluginSessionId: t.session, game: t.game as 'ets2' | 'ats',
      jobKey: t.jobKey, startedUtcMs: t.startedUtcMs, recordingCompleteness: t.completeness}));
  }
  /** Checkpoint jobs already stored by openAttachedTrip, keyed `session:nextEventSeq`; a repeat is a storage duplicate. */
  attachKeys = new Set<string>();
  /**
   * openAttachedTrip (ET-016 PR-7, J9): queued lifecycle effects of known trips of the game (updates, closes without an
   * outcome, intervals without monotonic bounds), then one trip.open of the checkpoint job with no truck or trailer, then
   * only that trip's intervals. A repeated key applies nothing.
   */
  attach(game: 'ets2' | 'ats', request: NonNullable<ReturnType<typeof dueAttach>>, effects: TripEffect[]) {
    const key = `${request.pluginSessionId}:${request.nextEventSeq}`;
    if (this.attachKeys.has(key)) return;
    this.attachKeys.add(key);
    expect(effects.length).toBeLessThanOrEqual(16);
    const at = effects.findIndex(e => e.kind === 'trip.open'), open = effects[at];
    expect(at, 'one trip.open').toBeGreaterThanOrEqual(0);
    for (const effect of effects.slice(0, at)) {
      if (effect.kind === 'trip.close') {
        const trip = this.trips.get(effect.tripUuid)!;
        expect(trip?.game).toBe(game); expect(trip.closed).toBe(false); expect(effect.outcome).toBe('none');
        expect(effect.endedUtcMs).toBeGreaterThanOrEqual(trip.startedUtcMs);
        trip.closed = true;
      } else if (effect.kind === 'trip.update') {
        expect(this.trips.get(effect.tripUuid)?.game).toBe(game);
        expect(Object.keys(effect.set).every(name => ['recordingCompleteness', 'observedDistanceM', 'fuelUsedL'].includes(name))).toBe(true);
      } else {
        expect(effect.kind).toBe('completeness.add');
        if (effect.kind === 'completeness.add') expect(effect.interval.startMonotonicNs ?? effect.interval.endMonotonicNs).toBeUndefined();
      }
    }
    if (open.kind !== 'trip.open') return;
    expect(this.trips.has(open.tripUuid), 'a trip opens once').toBe(false);
    expect([open.game, open.jobConfiguration, open.truckConfiguration, open.trailerConfigurations, open.recordingCompleteness]).toEqual([game, 'this-event', undefined, undefined, 'partial']);
    this.trips.set(open.tripUuid, {game, session: request.pluginSessionId, closed: false, startedUtcMs: open.startedUtcMs, jobKey: jobKey(request.job), completeness: 'partial'});
    for (const effect of effects.slice(at + 1)) expect(effect.kind === 'completeness.add' && effect.interval.tripUuid === open.tripUuid).toBe(true);
    expect([...this.trips.values()].filter(t => !t.closed && t.game === game).length, 'at most one open trip per game').toBe(1);
  }
  check(message: EventMessage | GapMessage, effects: TripEffect[]) {
    const game = message.source.game, session = message.source.pluginSessionId, record = message.kind === 'event' ? message.data.record : null;
    expect(effects.length).toBeLessThanOrEqual(16);
    expect(effects.filter(e => e.kind === 'completeness.add' && e.interval.detail?.annotation === true).length).toBeLessThanOrEqual(8);
    const gameplay = record !== null && GAMEPLAY_EVENT_TYPES.includes(record.type);
    expect(effects.filter(e => e.kind === 'event.attribute').length, 'one attribution per gameplay event').toBe(gameplay ? 1 : 0);
    const here = message.kind === 'event' ? `${session}:${message.data.eventSeq}` : '';
    if (record?.type === 'job.configured') this.jobEvents.set(here, jobKey(record));
    if (record?.type === 'truck.configured') this.truckEvents.add(here);
    if (record?.type === 'trailer.configured') this.trailerEvents.add(here);
    // A configuration reference names a configuration event of the committing session (storage resolves it there).
    const configuration = (ref: 'this-event' | {eventSeq: string}, type: 'truck.configured' | 'trailer.configured') => {
      if (ref === 'this-event') expect(record?.type).toBe(type);
      else expect((type === 'truck.configured' ? this.truckEvents : this.trailerEvents).has(`${session}:${ref.eventSeq}`), `${type} reference of this session`).toBe(true);
    };
    const known = (uuid: string | null | undefined) => {
      if (uuid === null || uuid === undefined) return;
      const trip = this.trips.get(uuid);
      expect(trip, `known trip ${uuid}`).toBeDefined();
      expect(trip!.game, 'same-game reference').toBe(game);
      return trip!;
    };
    for (const effect of effects) {
      switch (effect.kind) {
        case 'trip.open': {
          expect(record, 'a trip opens only at an event').not.toBeNull();
          expect(this.trips.has(effect.tripUuid), 'a trip opens once').toBe(false);
          expect(effect.game).toBe(game);
          if (effect.jobConfiguration === 'this-event') expect(record!.type).toBe('job.configured');
          else expect(this.jobEvents.has(`${session}:${effect.jobConfiguration.eventSeq}`), 'job reference of this session').toBe(true);
          if (effect.truckConfiguration !== undefined) configuration(effect.truckConfiguration, 'truck.configured');
          for (const ref of effect.trailerConfigurations ?? []) configuration(ref, 'trailer.configured');
          const key = this.jobEvents.get(effect.jobConfiguration === 'this-event' ? here : `${session}:${effect.jobConfiguration.eventSeq}`) ?? null;
          this.trips.set(effect.tripUuid, {game, session, closed: false, startedUtcMs: effect.startedUtcMs, jobKey: key, completeness: effect.recordingCompleteness === 'partial' ? 'partial' : 'unknown'});
          break;
        }
        case 'trip.close': {
          const trip = known(effect.tripUuid)!;
          expect(trip.closed, `${effect.tripUuid} closes once`).toBe(false);
          if (effect.outcome !== 'none') {
            expect(record?.type, 'an outcome comes only from its own event').toBe(effect.outcome === 'delivered' ? 'job.delivered' : 'job.cancelled');
            expect(effect.outcomeEvent).toBe('this-event');
          } else {
            expect(effect.outcomeEvent).toBeUndefined();
            expect(effect.recordingCompleteness, 'complete only with an outcome').toBe('partial');
          }
          expect(effect.endedUtcMs).toBeGreaterThanOrEqual(trip.startedUtcMs);
          trip.closed = true;
          break;
        }
        case 'trip.update': {
          const trip = known(effect.tripUuid)!;
          // A closed trip accepts fuel used as well since ET-016 PR-6 (J8, docs/storage.md).
          if (trip.closed) expect(Object.keys(effect.set).every(key => key === 'recordingCompleteness' || key === 'observedDistanceM' || key === 'fuelUsedL')).toBe(true);
          if (effect.set.truckConfiguration !== undefined) configuration(effect.set.truckConfiguration, 'truck.configured');
          for (const ref of effect.set.trailerConfigurations ?? []) configuration(ref, 'trailer.configured');
          expect(effect.set.recordingCompleteness === undefined || effect.set.recordingCompleteness === 'partial').toBe(true);
          if (effect.set.recordingCompleteness === 'partial') trip.completeness = 'partial';
          break;
        }
        case 'event.attribute':
          expect(record).not.toBeNull();
          expect(effect.tripUuid === null).toBe(effect.attribution === 'free-driving' || effect.attribution === 'ambiguous');
          known(effect.tripUuid);
          break;
        case 'completeness.add': {
          const trip = known(effect.interval.tripUuid);
          // Source clocks are session-scoped (T11): a bounded interval names a trip of this session, or none.
          if (effect.interval.startMonotonicNs !== undefined || effect.interval.endMonotonicNs !== undefined) {
            expect(effect.interval.sourceClockId).toBe(message.capture.clockId);
            if (trip) expect(trip.session).toBe(session);
          }
          break;
        }
      }
    }
    const open = [...this.trips.values()].filter(t => !t.closed && t.game === game);
    expect(open.length, 'at most one open trip per game').toBeLessThanOrEqual(1);
  }
}

const RECORDS: ((s: Script, next: () => number) => EventRecord)[] = [
  () => r.jobConfigured(), () => r.jobConfigured(otherJob()), () => r.jobConfigured(cargoMarketJob(false)), () => r.jobConfigured(cargoMarketJob(true)),
  () => r.jobCleared(), () => r.truckConfigured(), () => r.truckConfigured(truck({licensePlate: {available: true, value: 'SYN 0009'}})), () => r.truckCleared(),
  (_s, next) => r.trailerConfigured(trailer(Math.floor(next() * 2))), (_s, next) => r.trailerCleared(Math.floor(next() * 2)),
  () => r.paused(), () => r.started(), () => r.started(), () => r.timersRestart(),
  s => { const now = s.gameTime, minutes = BigInt(now.minutes); return r.regression(now.minutes, (minutes - 10n).toString(), now.clockId, `40000000-0000-4000-8000-${(minutes - 10n).toString().padStart(12, '0')}`); },
  () => r.delivered(), () => r.cancelled(), () => r.fined(), () => r.fined(), () => r.toll(), () => r.ferry(), () => r.train(),
  () => r.gameMode({mode: 'single-player', method: 'process-scan', confidence: 'weak'}), () => r.gameMode({mode: 'unknown', method: 'none', confidence: 'none'})
];
const CAUSES: (keyof LossCounts)[] = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed'];

describe('seeded random streams (T18, REG-005)', () => {
  it('never exceed 16 effects, never close a trip twice and never give an outcome without its event', () => {
    const seeded = {resumed: 0, restarted: 0, attached: 0};
    for (let seed = 1; seed <= 150; seed++) {
      const next = random(seed), model = new EffectModel();
      let state = initialTripState(), sessionCounter = 0;
      const newScript = (game: 'ets2' | 'ats') => new Script(`10000000-0000-4000-8000-${(++sessionCounter).toString(16).padStart(12, '0')}`, game, {utcMs: BASE_UTC + sessionCounter * 1_000_000});
      const scripts = {ets2: newScript('ets2'), ats: newScript('ats')}, sent: Record<string, (EventMessage | GapMessage)[]> = {};
      let game: 'ets2' | 'ats' = 'ets2';
      const step = (input: TripInput) => {
        const result = stepTrip(state, input);
        expect(result.ok, `seed ${seed}: ${result.ok ? '' : result.code}`).toBe(true);
        if (!result.ok) return;
        if (input.kind === 'event' || input.kind === 'gap') model.check(input.message, result.effects);
        else expect(result.effects).toEqual([]);
        state = result.state;
        // J9: a due late-attach trip opens right after the checkpoint or commit that made it due, as DurableDelivery does.
        const due = dueAttach(state);
        if (due !== null) {
          const attached = stepTrip(state, {kind: 'attach', receivedUtcMs: BASE_UTC});
          expect(attached.ok, `seed ${seed}: attach`).toBe(true);
          if (!attached.ok) return;
          model.attach(game, due, attached.effects); seeded.attached += 1;
          state = attached.state;
        }
      };
      // Committed coverage per session, as storage would report it after a service restart.
      const covered: Record<string, string> = {};
      const send = (message: EventMessage | GapMessage) => {
        const id = message.source.pluginSessionId;
        (sent[id] ??= []).push(message); step(carrier(state, message)); covered[id] = state.sessions[id].processedThrough;
      };
      // A session the reducer does not know gets the stored coverage and the stored open trips of its game (TripSeed).
      const connect = () => {
        const s = scripts[game], known = Object.hasOwn(state.sessions, s.session), seeds = known ? [] : model.seeds(game);
        for (const x of seeds) seeded[x.pluginSessionId === s.session ? 'resumed' : 'restarted'] += 1;
        step(sessionInput(s.welcome(), known ? state.sessions[s.session].processedThrough : covered[s.session] ?? '0', seeds));
      };
      connect();
      for (let i = 0; i < 120; i++) {
        const roll = next(), s = scripts[game];
        if (roll < 0.72) {
          const make = RECORDS[Math.floor(next() * RECORDS.length)], record = make(s, next);
          const back = next() < 0.03;
          send(s.event(record, {simulation: next() < 0.5 ? 'paused' : 'running', ...(back ? {utcMs: BASE_UTC - 10_000_000} : {})}));
        } else if (roll < 0.78) send(s.gap(1 + Math.floor(next() * 3), CAUSES[Math.floor(next() * CAUSES.length)]));
        else if (roll < 0.83) step({kind: 'checkpoint', message: s.checkpoint(next() < 0.5 ? job() : null)});
        else if (roll < 0.88) { step({kind: 'disconnected'}); connect(); }
        else if (roll < 0.91) { step({kind: 'disconnected'}); game = game === 'ets2' ? 'ats' : 'ets2'; connect(); }
        else if (roll < 0.93) { step({kind: 'disconnected'}); scripts[game] = newScript(game); connect(); }
        else if (roll < 0.95) {
          // A service restart: the reducer state is lost, so stored open trips come back as seeds (same-session resume
          // or restart close); with a plugin restart half of the time.
          state = initialTripState();
          if (next() < 0.5) scripts[game] = newScript(game);
          connect();
        } else {
          const history = sent[s.session] ?? [];
          if (history.length) {
            const again = history[Math.floor(next() * history.length)], result = stepTrip(state, carrier(state, again));
            expect(result).toEqual({ok: true, state, effects: []});
          }
        }
      }
      expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    }
    // The streams exercise both cold-start seed paths.
    expect(seeded.resumed).toBeGreaterThan(5);
    expect(seeded.restarted).toBeGreaterThan(5);
    expect(seeded.attached).toBeGreaterThan(5);
  });
});

describe('annotation merging and deferral (T18)', () => {
  it('merges consecutive truck-change annotations of one trip while they wait behind deferred effects', () => {
    const b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000});
    const uuidOf = (i: number) => `70000000-0000-4000-8000-${i.toString().padStart(12, '0')}`;
    // Forty stored trips of an earlier session, each with a clamped restart close: 40 closes and 40 annotations queue.
    const seeds: TripSeed[] = Array.from({length: 40}, (_, i) => ({tripUuid: uuidOf(i), pluginSessionId: ETS2_A, game: 'ets2', jobKey: null,
      startedUtcMs: BASE_UTC + 50_000, recordingCompleteness: 'unknown', lastObservedUtcMs: BASE_UTC + 40_000}));
    let state = stepOk(initialTripState(), sessionInput(b.welcome(), '0', seeds)).state;
    const trucks = [truck(), truck({licensePlate: {available: true, value: 'SYN 0009'}})];
    const counts: number[] = [];
    let lastEffects: TripEffect[] = [];
    const messages = [b.event(r.jobConfigured(), paused), ...Array.from({length: 7}, (_, i) => b.event(r.truckConfigured(trucks[i % 2]), paused))];
    for (const message of messages) {
      const result = stepOk(state, carrier(state, message));
      counts.push(result.effects.length); lastEffects = result.effects; state = result.state;
    }
    // eventSeq 1: open + opened-at-load + 14 closes; 2: first truck + 15 closes; 3: update + 11 closes + 4 notes;
    // 4–7: update + 8 notes each; 8: update + the last 4 clamp notes + one merged truck-change note.
    expect(counts).toEqual([16, 16, 16, 9, 9, 9, 9, 6]);
    expect(lastEffects.at(-1)).toEqual({kind: 'completeness.add', interval: {tripUuid: expect.any(String), kind: 'discontinuity',
      detail: {annotation: true, cause: 'truck-change', atEventSeq: '3', count: 6, lastAtEventSeq: '8'}}});
  });
});

function stepOk(state: TripState, input: TripInput) {
  const result = stepTrip(state, input);
  if (!result.ok) throw new Error(`Unexpected ${result.code}`);
  return result;
}
