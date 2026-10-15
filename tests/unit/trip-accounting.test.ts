// ET-014 PR-2: readings accounting (T16) and the provisional thresholds (T17), fed through the trip reducer as `reading`
// inputs between committed events. Every expected value is written by hand from docs/trips.md, the T16/T17 decisions
// and the derived.ts step rules (docs/live-telemetry-fields.md); none is copied from reducer output. Each case names its
// basis: a REG scenario, or synthetic-inference because no real trace shows these readings yet. A reading at `ms` carries
// source time 1,000,000,000,000 ns + ms × 1,000,000 on the script's capture clock and the UTC label BASE_UTC + ms. In a
// gap-free script eventSeq n carries the UTC label BASE_UTC + n × 1,000 ms and the source time
// 1,000,000,000,000 ns + n × 1,000,000,000 − 1,000,000 ns.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {decodePayload, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {
  GAME_TIME_JUMP_MINUTES, GAME_TIME_JUMP_RATE, MAX_ANNOTATIONS_PER_COMMIT, MAX_EFFECTS, MAX_PLAUSIBLE_SPEED_MPS, POSITION_JUMP_MARGIN_METERS, READING_HOLE_SECONDS, initialTripState,
  jobKey, normalizeV1State, stepTrip, tripView, type NormalizedLiveState, type TripEffect, type TripInput, type TripSeed, type TripState
} from '../../packages/telemetry-core/src/index';
import {BASE_UTC, ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, Script, job, r, run, sessionInput, type Step} from '../shared/trip-messages';

const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const at = (seconds: number) => BASE_UTC + seconds * 1_000;
const ns = (ms: number) => (1_000_000_000_000n + BigInt(ms) * 1_000_000n).toString();
const paused = {simulation: 'paused'} as const;
const UNKNOWN_MODE = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const open = (tripUuid: string, startedUtcMs: number): TripEffect =>
  ({kind: 'trip.open', tripUuid, game: 'ets2', gameMode: UNKNOWN_MODE, jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs});
const distance = (tripUuid: string, value: number): TripEffect => ({kind: 'trip.update', tripUuid, set: {observedDistanceM: {available: true, value}}});
const partial = (tripUuid: string): TripEffect => ({kind: 'trip.update', tripUuid, set: {recordingCompleteness: 'partial'}});
const attr = (tripUuid: string | null, attribution: 'trip' | 'free-driving'): TripEffect => ({kind: 'event.attribute', tripUuid, attribution});
const note = (tripUuid: string, detail: Record<string, unknown>): TripEffect => ({kind: 'completeness.add', interval: {tripUuid, kind: 'discontinuity', detail: {annotation: true, ...detail}}});
const delivered = (tripUuid: string, completeness: 'complete' | 'partial', endedUtcMs: number): TripEffect =>
  ({kind: 'trip.close', tripUuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: completeness, endedUtcMs});

const snapshot = decodePayload(new Uint8Array(readFileSync('tests/fixtures/protocol-v1/snapshot.json')), 'server') as Extract<ServerMessage, {kind: 'snapshot'}>;
/** The shared v1 snapshot fixture, normalized: running, truck SYN 0001, game clock GAME_CLOCK_1. Each case sets what it compares. */
const BASE: NormalizedLiveState = normalizeV1State(snapshot.data.state, snapshot.data.status);
const NONE = {state: 'missing', reason: 'not-observed'} as const;
const value = <T>(v: T) => ({state: 'value' as const, value: v});
interface At {
  ms: number; odometer?: number; fuel?: number; minutes?: number; clock?: string; simulation?: 'running' | 'paused';
  position?: {x: number; y: number; z: number}; plate?: string; country?: string; captureClock?: string; utc?: boolean; utcMs?: number;
}
/** One reading of script `s`'s session. Fields not given are not observed. */
function reading(s: Script, a: At): TripInput {
  const base = BASE.truck.state === 'value' ? BASE.truck.value : undefined;
  const truck = base === undefined ? BASE.truck : value({...base, ...(a.plate !== undefined ? {licensePlate: value(a.plate)} : {}),
    ...(a.country !== undefined ? {plateCountry: {id: value(a.country), name: value(a.country)}} : {})});
  const state: NormalizedLiveState = {...BASE, simulation: a.simulation ?? 'running', truck,
    odometer: a.odometer === undefined ? NONE : value({kind: 'odometer' as const, meters: a.odometer}), fuel: a.fuel === undefined ? NONE : value(a.fuel),
    gameTime: {minutes: a.minutes === undefined ? NONE : value(BigInt(a.minutes)), clockId: a.clock ?? GAME_CLOCK_1},
    worldPlacement: a.position === undefined ? NONE : value({position: a.position, orientation: {heading: 0, pitch: 0, roll: 0}})};
  return {kind: 'reading', sample: {source: {game: s.game, origin: 'synthetic', pluginSessionId: s.session, processInstanceId: `20000000${s.session.slice(8)}`},
    capture: {clockId: a.captureClock ?? s.clockId, monotonicNs: ns(a.ms)}, state, ...(a.utc === false ? {} : {utcMs: a.utcMs ?? BASE_UTC + a.ms})}};
}

type Row = [Step, TripEffect[]?];
/** Plays rows in order from `state`, adopting every result, and checks each row's effects (none when omitted). */
function play(rows: Row[], state: TripState = initialTripState()): TripState {
  rows.forEach(([step, expected = []], index) => {
    const result = run(state, [step]);
    expect(result.effects[0], `row ${index}`).toEqual(expected);
    state = result.state;
  });
  return state;
}
/** A session whose simulation is running (eventSeq 1) when a job is configured (eventSeq 2): the trip opens `unknown`. */
function opened(s = new Script(ETS2_A)): {s: Script; trip: string; rows: Row[]} {
  const trip = uuid(s.session, '2');
  return {s, trip, rows: [[sessionInput(s.welcome())], [s.event(r.started())], [s.event(r.jobConfigured()), [open(trip, at(2))]]]};
}

describe('T17 thresholds', () => {
  it('are the provisional named values of docs/trips.md', () => {
    expect([GAME_TIME_JUMP_MINUTES, GAME_TIME_JUMP_RATE, POSITION_JUMP_MARGIN_METERS, READING_HOLE_SECONDS, MAX_PLAUSIBLE_SPEED_MPS]).toEqual([30, 60, 50, 5, 100]);
  });
});

describe('observed distance (T16)', () => {
  it('a road stop is a continuous 0 m step, persisted once at the next carrier (REG-001) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1000})],
      [s.event(r.fined()), [attr(trip, 'trip'), distance(trip, 0)]], [reading(s, {ms: 2000, odometer: 1000})], [s.event(r.paused(), paused)]]);
    expect(tripView(state, 'ets2').current).toMatchObject({observedDistanceM: {state: 'value', value: 0}, recordingCompleteness: 'unknown'});
  });
  it('a pause adds nothing and a paused stretch is not a reading hole (REG-002) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1025})], [reading(s, {ms: 2000, odometer: 1050})],
      [s.event(r.paused(), paused), [distance(trip, 50)]],
      [reading(s, {ms: 3000, odometer: 1050, simulation: 'paused'})], [reading(s, {ms: 9000, odometer: 1050, simulation: 'paused'})],
      [s.event(r.started())],
      [reading(s, {ms: 10_000, odometer: 1075})],
      // 50 m, 0 m and 0 m, then 25 m: 75 m. The trip stays clean, so the delivery closes it complete.
      [s.event(r.delivered()), [attr(trip, 'trip'), distance(trip, 75), delivered(trip, 'complete', at(5))]]]);
  });
  it('excludes and annotates an odometer regression and a jump (REG-008, teleport) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 990})], [reading(s, {ms: 2000, odometer: 1010})],
      // 48,990 m in 1 s is beyond 100 m/s × 1 s + 50 m: a jump such as a road-service teleport.
      [reading(s, {ms: 3000, odometer: 50_000})], [reading(s, {ms: 4000, odometer: 50_020})],
      [s.event(r.paused(), paused), [distance(trip, 40),
        note(trip, {cause: 'odometer-regressed', deltaM: -10, atMonotonicNs: ns(1000)}), note(trip, {cause: 'odometer-jump', deltaM: 48_990, atMonotonicNs: ns(3000)})]]]);
  });
  it('keeps a one-quantum 20 Hz step of a 600,000 km odometer continuous (float32 margin) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, odometer: 600_000_000})], [reading(s, {ms: 50, odometer: 600_000_062.5})], [reading(s, {ms: 100, odometer: 600_000_125})],
      [s.event(r.paused(), paused), [distance(trip, 125)]]]);
  });
  it('excludes truck, source and save-load game-clock boundaries without annotating them (REG-008) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, odometer: 1000, minutes: 5000})],
      // A different truck (its plate) and then a rotated game clock with an earlier odometer, as after a save load.
      [reading(s, {ms: 1000, odometer: 200_000, minutes: 5000, plate: 'SYN 0009'})], [reading(s, {ms: 2000, odometer: 200_010, minutes: 5000, plate: 'SYN 0009'})],
      [reading(s, {ms: 3000, odometer: 199_000, minutes: 4000, clock: GAME_CLOCK_2, plate: 'SYN 0009'})], [reading(s, {ms: 4000, odometer: 199_010, minutes: 4000, clock: GAME_CLOCK_2, plate: 'SYN 0009'})],
      // Another capture clock is another source lifetime.
      [reading(s, {ms: 5000, odometer: 199_020, minutes: 4000, clock: GAME_CLOCK_2, plate: 'SYN 0009', captureClock: '30000000-0000-4000-8000-0000000000ff'})],
      [s.event(r.paused(), paused), [distance(trip, 20)]]]);
  });
  it('counts a step only when the trip was active at both readings: not across its opening or its clear [synthetic-inference]', () => {
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    play([[sessionInput(s.welcome())], [s.event(r.started())], [reading(s, {ms: 0, odometer: 1000})],
      [s.event(r.jobConfigured()), [open(trip, at(2))]],
      [reading(s, {ms: 1000, odometer: 1100})], [reading(s, {ms: 2000, odometer: 1200})],
      [s.event(r.jobCleared(), paused), [distance(trip, 100)]],
      [reading(s, {ms: 3000, odometer: 1300, simulation: 'paused'})], [reading(s, {ms: 4000, odometer: 1400, simulation: 'paused'})],
      [s.event(r.delivered(), paused), [attr(trip, 'trip'), delivered(trip, 'complete', at(4))]]]);
  });
  it('is persisted before a close even when the last change came after the previous carrier (REG-001) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1100})],
      [s.event(r.delivered()), [attr(trip, 'trip'), distance(trip, 100), delivered(trip, 'complete', at(3))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({observedDistanceM: {state: 'value', value: 100}});
  });
  it('is persisted before a restart close of an earlier plugin session (T11) [synthetic-inference]', () => {
    const {s, trip, rows} = opened(), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000});
    play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1100})], [{kind: 'disconnected'}], [sessionInput(b.welcome())],
      [b.event(r.paused(), paused), [distance(trip, 100),
        {kind: 'trip.close', tripUuid: trip, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: at(2)}]]]);
  });
  it('a resumed trip continues from its stored distance (cold start) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), trip = uuid(ETS2_A, '2');
    const seed: TripSeed = {tripUuid: trip, pluginSessionId: ETS2_A, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: at(2), recordingCompleteness: 'unknown', observedDistanceM: 500};
    s.next = 3n;
    play([[sessionInput(s.welcome(), '2', [seed])], [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1100})],
      [s.event(r.paused(), paused), [partial(trip), {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', detail: {cause: 'consumer-restart'}}}, distance(trip, 600)]]]);
  });
});

describe('resumed cleared trips (fix round 1)', () => {
  it('a resumed seed whose job was cleared awaits its outcome and counts no distance [synthetic-inference]', () => {
    const s = new Script(ETS2_A, 'ets2', {utcMs: BASE_UTC + 2000}), trip = uuid(ETS2_A, '2');
    const seed: TripSeed = {tripUuid: trip, pluginSessionId: ETS2_A, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: at(2), recordingCompleteness: 'unknown',
      observedDistanceM: 500, awaitingOutcome: true};
    s.next = 3n;
    const state = play([[sessionInput(s.welcome(), '2', [seed])], [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1100})],
      // The delivery after the clear still attaches (concept.md, October 13, 2026); the free-driving 100 m are not the trip's.
      [s.event(r.delivered(), paused), [partial(trip), {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', detail: {cause: 'consumer-restart'}}},
        attr(trip, 'trip'), delivered(trip, 'partial', at(3))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({observedDistanceM: {state: 'value', value: 500}});
  });
});

describe('connection holes (T16)', () => {
  it('compares trucks by brand, model and plate for the odometer change, and always records the key (fix round 1) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const notConnected = (odometerDeltaM: number | null): TripEffect => ({kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: at(2),
      startMonotonicNs: '1001999000000', endMonotonicNs: '1002000000000', sourceClockId: s.clockId, detail: {cause: 'disconnected', odometerDeltaM}}});
    play([...rows, [reading(s, {ms: 2000, odometer: 1000})], [{kind: 'disconnected'}], [sessionInput(s.welcome(), '2')],
      // Only the plate country differs: the same truck, so the change is recorded.
      [reading(s, {ms: 60_000, odometer: 1300, country: 'elsewhere'})],
      // A connection without any reading still records the key, as null.
      [{kind: 'disconnected'}], [sessionInput(s.welcome(), '2')], [{kind: 'disconnected'}], [sessionInput(s.welcome(), '2')],
      [s.event(r.paused(), paused), [partial(trip), notConnected(300), notConnected(null), notConnected(null)]]]);
  });
  it('bridges nothing across a reconnection and records the odometer change in its not-connected interval [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1100})],
      [s.event(r.paused(), paused), [distance(trip, 100)]],
      [{kind: 'disconnected'}], [sessionInput(s.welcome(), '3')],
      // 5,000 m in 59 s would be a plausible step: only the hole keeps it out of the trip.
      [reading(s, {ms: 60_000, odometer: 6100})], [reading(s, {ms: 61_000, odometer: 6110})],
      [s.event(r.started()), [partial(trip),
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: at(3), startMonotonicNs: '1002999000000', endMonotonicNs: '1003000000000',
          sourceClockId: s.clockId, detail: {cause: 'disconnected', odometerDeltaM: 5000}}}, distance(trip, 110)]]]);
    expect(tripView(state, 'ets2').current).toMatchObject({observedDistanceM: {state: 'value', value: 110}, recordingCompleteness: 'partial'});
  });
  it('records a null odometer change when the truck changed or a reading lacks the odometer [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, odometer: 1000})], [{kind: 'disconnected'}], [sessionInput(s.welcome(), '2')],
      [reading(s, {ms: 60_000, odometer: 6100, plate: 'SYN 0009'})],
      [s.event(r.paused(), paused), [partial(trip),
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: at(2), startMonotonicNs: '1001999000000', endMonotonicNs: '1002000000000',
          sourceClockId: s.clockId, detail: {cause: 'disconnected', odometerDeltaM: null}}}]]]);
  });
});

describe('fuel (T16)', () => {
  it('excludes refuels, reports them per episode and keeps small increases out of refuels (REG-008) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000, fuel: 400})], [reading(s, {ms: 1000, odometer: 1000, fuel: 399.5})],
      // +0.0078125 L is within FUEL_NOISE_LITERS (0.01): not a refuel.
      [reading(s, {ms: 2000, odometer: 1000, fuel: 399.5078125})],
      // One refuel episode over two steps, then consumption, then a second episode.
      [reading(s, {ms: 3000, odometer: 1000, fuel: 450})], [reading(s, {ms: 4000, odometer: 1000, fuel: 500})], [reading(s, {ms: 5000, odometer: 1000, fuel: 499})],
      [reading(s, {ms: 6000, odometer: 1000, fuel: 520})],
      [s.event(r.paused(), paused), [distance(trip, 0),
        note(trip, {cause: 'refuel', addedLiters: 100.4921875, atMonotonicNs: ns(3000), lastAtMonotonicNs: ns(4000)}),
        note(trip, {cause: 'refuel', addedLiters: 21, atMonotonicNs: ns(6000)})]]]);
    // Consumed 0.5 + 1 L minus the 0.0078125 L increase; refuels 50.4921875 + 50 + 21 L in two episodes.
    expect(tripView(state, 'ets2').current).toMatchObject({fuelUsedL: {state: 'value', value: 1.4921875}, refuelledL: 121.4921875, refuels: 2});
  });
  it('marks a refuel episode that continues after its annotation was sent (fix round 1) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 2000, fuel: 400})], [reading(s, {ms: 3000, fuel: 450})],
      [s.event(r.paused(), {...paused, advanceMs: 1100}), [note(trip, {cause: 'refuel', addedLiters: 50, atMonotonicNs: ns(3000)})]],
      [reading(s, {ms: 4000, fuel: 500, simulation: 'paused'})],
      [s.event(r.started(), {advanceMs: 1000}), [note(trip, {cause: 'refuel', addedLiters: 50, atMonotonicNs: ns(4000), continues: true})]]]);
  });
  it('reports fuel used as not observed before a continuous fuel step [synthetic-inference]', () => {
    const {s, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1000, fuel: 300})]]);
    expect(tripView(state, 'ets2').current).toMatchObject({fuelUsedL: {state: 'missing', reason: 'not-observed'}, refuelledL: 0, refuels: 0});
  });
});

describe('reading holes (T17)', () => {
  it('marks the trip partial for 5 s or more between running readings, and never for coalesced readings closer together [synthetic-inference]', () => {
    // Event times follow the readings here: the script's clock stands at 2,000 ms after the opening, and each event's
    // source time is its clock minus 1 ms, so `advanceMs` places it.
    const {s, trip, rows} = opened();
    const hole = (fromMs: number, toMs: number): TripEffect => ({kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss', startUtcMs: BASE_UTC + fromMs,
      endUtcMs: BASE_UTC + toMs, startMonotonicNs: ns(fromMs), endMonotonicNs: ns(toMs), sourceClockId: s.clockId, detail: {cause: 'reading-hole'}}});
    const state = play([...rows, [reading(s, {ms: 2000, odometer: 1000})],
      // Coalesced snapshots: 1.5 s and 4.999 s apart while running are not holes.
      [reading(s, {ms: 3500, odometer: 1000})], [reading(s, {ms: 8499, odometer: 1100})],
      [s.event(r.fined(), {advanceMs: 6600}), [attr(trip, 'trip'), distance(trip, 100)]],
      // Exactly 5 s of running time: a hole, although a running event lies inside. The odometer step across it is still
      // continuous (500 m ≤ 550 m).
      [reading(s, {ms: 13_499, odometer: 1600})],
      // Paused 1 s into the next 6.5 s, and started 1 ms before the following reading: neither stretch is a hole.
      [s.event(r.paused(), {...paused, advanceMs: 5900}), [partial(trip), hole(8499, 13_499), distance(trip, 600)]],
      [reading(s, {ms: 20_000, odometer: 1600, simulation: 'paused'})],
      [s.event(r.started(), {advanceMs: 11_500})], [reading(s, {ms: 26_000, odometer: 1600})], [reading(s, {ms: 30_000, odometer: 1700})],
      // Fix round 1: about 10 s of driving and then a pause is a hole, although the later reading is paused.
      [s.event(r.paused(), {...paused, advanceMs: 14_000}), [distance(trip, 700)]],
      [reading(s, {ms: 41_000, odometer: 1700, simulation: 'paused'})],
      [s.event(r.started(), {advanceMs: 3000}), [hole(30_000, 41_000)]],
      [s.event(r.delivered()), [attr(trip, 'trip'), delivered(trip, 'partial', at(44))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({recordingCompleteness: 'partial', observedDistanceM: {state: 'value', value: 700}});
  });
  it('extends a hole that starts where the waiting one ended, and bounds the waiting holes of a trip [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const interval = (fromMs: number, toMs: number, detail: Record<string, unknown>): TripEffect => ({kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss',
      startUtcMs: BASE_UTC + fromMs, endUtcMs: BASE_UTC + toMs, startMonotonicNs: ns(fromMs), endMonotonicNs: ns(toMs), sourceClockId: s.clockId, detail: {cause: 'reading-hole', ...detail}}});
    // Ten running readings 6 s apart: nine contiguous holes wait as one interval.
    const contiguous = Array.from({length: 10}, (_, i): Row => [reading(s, {ms: 2000 + i * 6000})]);
    let state = play([...rows, ...contiguous, [s.event(r.paused(), {...paused, advanceMs: 55_000}), [partial(trip), interval(2000, 56_000, {holes: 9})]]]);
    // Five holes separated by readings 1 s later: four wait apart, and the fifth extends the fourth over the reading between them.
    const separated: Row[] = [[reading(s, {ms: 60_000, simulation: 'paused'})]];
    for (let i = 0; i < 5; i++) separated.push([reading(s, {ms: 61_000 + i * 7000})], [reading(s, {ms: 67_000 + i * 7000})]);
    state = play([[s.event(r.started(), {advanceMs: 4000})], ...separated, [s.event(r.paused(), {...paused, advanceMs: 41_000}),
      [interval(61_000, 67_000, {}), interval(68_000, 74_000, {}), interval(75_000, 81_000, {}), interval(82_000, 95_000, {holes: 2, includesReadings: true})]]], state);
    expect(tripView(state, 'ets2').current?.recordingCompleteness).toBe('partial');
  });
  it('treats a UTC label that is not a non-negative safe integer as absent (no UTC bounds) [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 2000, utcMs: 2 ** 53})], [reading(s, {ms: 8000})], [reading(s, {ms: 9000, utcMs: -1})], [reading(s, {ms: 15_000})],
      [s.event(r.paused(), {...paused, advanceMs: 13_100}), [partial(trip),
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss', startMonotonicNs: ns(2000), endMonotonicNs: ns(8000), sourceClockId: s.clockId, detail: {cause: 'reading-hole'}}},
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss', startMonotonicNs: ns(9000), endMonotonicNs: ns(15_000), sourceClockId: s.clockId, detail: {cause: 'reading-hole'}}}]]]);
  });
});

describe('game-time and position jumps (T17)', () => {
  it('judges a single game-time step on its own rate at the thresholds [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    // Paused readings, so the long real-time steps are not reading holes.
    const clock = (ms: number, minutes: number) => reading(s, {ms, minutes, simulation: 'paused'});
    play([...rows, [clock(2000, 1000)],
      // 30 game minutes in 29 s: above 60 per real minute.
      [clock(31_000, 1030)],
      // 69 minutes in 69 s (more than the 60 s window back) is exactly 60 per real minute, and 29 minutes in 1 s is below
      // 30 minutes: neither is a jump.
      [clock(100_000, 1099)], [clock(101_000, 1128)],
      [s.event(r.paused(), {...paused, advanceMs: 100_100}), [note(trip, {cause: 'game-time-jump', label: 'possible-sleep', fromMinutes: '1000', toMinutes: '1030', atMonotonicNs: ns(31_000)})]]]);
  });
  it('finds a ferry-like advance spread over 1 Hz readings and grows one annotation (fix round 1) [O11 shape, synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    // A ferry event (source time 1,999 ms), then 61 paused readings 1 s apart advancing 1.5 game minutes per real second
    // (minutes 1000 + floor(1.5 k)): every step is 1 or 2 minutes, so no single step is a jump.
    const readings = Array.from({length: 61}, (_, k): Row => [reading(s, {ms: 2000 + k * 1000, minutes: 1000 + Math.floor(1.5 * k), simulation: 'paused'})]);
    play([...rows, [s.event(r.ferry(), {...paused, advanceMs: 0}), [attr(trip, 'trip')]], ...readings,
      // From the first reading, 30 minutes in 20 s at k = 20: a jump, labelled a crossing by the ferry before it. It then
      // grows by every faster-than-60-per-minute advance since its last growth (each even k), up to 1090 at k = 60.
      [s.event(r.paused(), {...paused, advanceMs: 61_000}), [note(trip, {cause: 'game-time-jump', label: 'crossing', fromMinutes: '1000', toMinutes: '1090',
        atMonotonicNs: ns(22_000), lastAtMonotonicNs: ns(62_000)})]]]);
  });
  it('labels a jump a crossing next to a transfer, with a reading between them, and not 300 s later (fix round 1) [O11 shape, synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const clock = (ms: number, minutes: number) => reading(s, {ms, minutes, simulation: 'paused'});
    play([...rows, [s.event(r.ferry(), {...paused, advanceMs: 0}), [attr(trip, 'trip')]],
      // A snapshot after the ferry shows no jump yet; the jump follows at the next one.
      [clock(2000, 1000)], [clock(3000, 1001)], [clock(4000, 1600)],
      // Normal advance inside the window keeps the jump but does not grow it.
      [clock(5000, 1601)],
      [s.event(r.paused(), {...paused, advanceMs: 4000}), [note(trip, {cause: 'game-time-jump', label: 'crossing', fromMinutes: '1001', toMinutes: '1600', atMonotonicNs: ns(4000)})]],
      // 304 s after the ferry a sleep-like jump is a possible sleep.
      [clock(306_000, 1602)], [clock(307_000, 1700)],
      [s.event(r.paused(), {...paused, advanceMs: 302_000}), [note(trip, {cause: 'game-time-jump', label: 'possible-sleep', fromMinutes: '1602', toMinutes: '1700', atMonotonicNs: ns(307_000)})]]]);
  });
  it('flags a position jump beyond the plausible speed, labelled by a train between the readings [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    play([...rows, [reading(s, {ms: 0, position: {x: 0, y: 0, z: 0}})], [reading(s, {ms: 1000, position: {x: 150, y: 0, z: 0}})],
      [reading(s, {ms: 2000, position: {x: 150, y: 0, z: 200}})],
      [s.event(r.train(), paused), [attr(trip, 'trip'), note(trip, {cause: 'position-jump', label: 'possible-teleport', meters: 200, atMonotonicNs: ns(2000)})]],
      [reading(s, {ms: 3000, position: {x: 10_150, y: 0, z: 200}})],
      [s.event(r.paused(), paused), [note(trip, {cause: 'position-jump', label: 'crossing', meters: 10_000, atMonotonicNs: ns(3000)})]]]);
  });
  it('adds no effect for readings without an open trip [synthetic-inference]', () => {
    const s = new Script(ETS2_A);
    play([[sessionInput(s.welcome())], [reading(s, {ms: 0, odometer: 1000, fuel: 100, minutes: 1000})], [reading(s, {ms: 1000, odometer: 900, fuel: 500, minutes: 2000})],
      [s.event(r.fined()), [attr(null, 'free-driving')]]]);
  });
});

describe('effect bounds (T18)', () => {
  it('sends at most 8 reading annotations per carrier and defers the rest in order [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    let state = play(rows);
    // Twenty alternating regressions and jumps: consecutive annotations differ in cause, so none merge.
    const expected: TripEffect[] = [];
    let odometer = 1000;
    state = play([[reading(s, {ms: 0, odometer})]], state);
    for (let i = 1; i <= 20; i++) {
      const next = i % 2 === 1 ? odometer - 10 : odometer + 100_000;
      state = play([[reading(s, {ms: i * 1000, odometer: next})]], state);
      expected.push(note(trip, {cause: i % 2 === 1 ? 'odometer-regressed' : 'odometer-jump', deltaM: next - odometer, atMonotonicNs: ns(i * 1000)}));
      odometer = next;
    }
    const sent: TripEffect[][] = [];
    for (let k = 0; k < 3; k++) {
      const result = stepTrip(state, {kind: 'event', message: s.event(r.paused(), paused), coveredThrough: state.sessions[ETS2_A].processedThrough, receivedUtcMs: BASE_UTC});
      if (!result.ok) throw new Error(result.code);
      expect(result.effects.length).toBeLessThanOrEqual(MAX_EFFECTS);
      sent.push(result.effects); state = result.state;
    }
    expect(sent.map(effects => effects.length)).toEqual([MAX_ANNOTATIONS_PER_COMMIT, MAX_ANNOTATIONS_PER_COMMIT, 4]);
    expect(sent.flat()).toEqual(expected);
  });
});

describe('purity', () => {
  it('a state with readings is plain data, and rebuilding from any prefix equals the single run [synthetic-inference]', () => {
    const {s, rows} = opened();
    const steps: Step[] = [...rows.map(([step]) => step), reading(s, {ms: 0, odometer: 1000, fuel: 400, minutes: 1000, position: {x: 0, y: 0, z: 0}}),
      reading(s, {ms: 1000, odometer: 1020, fuel: 399, minutes: 1001, position: {x: 20, y: 0, z: 0}}), s.event(r.ferry()),
      reading(s, {ms: 7000, odometer: 1100, fuel: 450, minutes: 1400, position: {x: 9000, y: 0, z: 0}}), {kind: 'disconnected'}, sessionInput(s.welcome(), '3'),
      reading(s, {ms: 20_000, odometer: 1500}), s.event(r.delivered())];
    const inputs: TripInput[] = [], states: TripState[] = [];
    let state = initialTripState();
    for (const step of steps) {
      const input = 'version' in step ? {kind: step.kind, message: step, coveredThrough: Object.hasOwn(state.sessions, step.source.pluginSessionId) ? state.sessions[step.source.pluginSessionId].processedThrough : '0',
        receivedUtcMs: BASE_UTC} as TripInput : step;
      const result = stepTrip(state, input);
      if (!result.ok) throw new Error(result.code);
      inputs.push(input); states.push(state); state = result.state;
    }
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    for (let k = 0; k < inputs.length; k++) {
      let rebuilt = initialTripState();
      for (const input of inputs.slice(0, k)) { const result = stepTrip(rebuilt, input); if (!result.ok) throw new Error(result.code); rebuilt = result.state; }
      expect(rebuilt, `prefix ${k}`).toEqual(states[k]);
    }
  });
});
