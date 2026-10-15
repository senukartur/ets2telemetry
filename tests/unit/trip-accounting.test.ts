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
  position?: {x: number; y: number; z: number}; plate?: string; captureClock?: string; utc?: boolean;
}
/** One reading of script `s`'s session. Fields not given are not observed. */
function reading(s: Script, a: At): TripInput {
  const truck = a.plate === undefined ? BASE.truck : BASE.truck.state === 'value' ? value({...BASE.truck.value, licensePlate: value(a.plate)}) : BASE.truck;
  const state: NormalizedLiveState = {...BASE, simulation: a.simulation ?? 'running', truck,
    odometer: a.odometer === undefined ? NONE : value({kind: 'odometer' as const, meters: a.odometer}), fuel: a.fuel === undefined ? NONE : value(a.fuel),
    gameTime: {minutes: a.minutes === undefined ? NONE : value(BigInt(a.minutes)), clockId: a.clock ?? GAME_CLOCK_1},
    worldPlacement: a.position === undefined ? NONE : value({position: a.position, orientation: {heading: 0, pitch: 0, roll: 0}})};
  return {kind: 'reading', sample: {source: {game: s.game, origin: 'synthetic', pluginSessionId: s.session, processInstanceId: `20000000${s.session.slice(8)}`},
    capture: {clockId: a.captureClock ?? s.clockId, monotonicNs: ns(a.ms)}, state, ...(a.utc === false ? {} : {utcMs: BASE_UTC + a.ms})}};
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

describe('connection holes (T16)', () => {
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
  it('reports fuel used as not observed before a continuous fuel step [synthetic-inference]', () => {
    const {s, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})], [reading(s, {ms: 1000, odometer: 1000, fuel: 300})]]);
    expect(tripView(state, 'ets2').current).toMatchObject({fuelUsedL: {state: 'missing', reason: 'not-observed'}, refuelledL: 0, refuels: 0});
  });
});

describe('reading holes (T17)', () => {
  it('marks the trip partial for 5 s or more between running readings, and never for coalesced readings closer together [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    const state = play([...rows, [reading(s, {ms: 0, odometer: 1000})],
      // Coalesced snapshots: 1.5 s and 4.999 s apart while running are not holes.
      [reading(s, {ms: 1500, odometer: 1000})], [reading(s, {ms: 6499, odometer: 1100})],
      [s.event(r.fined()), [attr(trip, 'trip'), distance(trip, 100)]],
      // Exactly 5 s while running at both ends: a hole. The odometer step across it is still continuous (500 m ≤ 550 m).
      [reading(s, {ms: 11_499, odometer: 1600})],
      [reading(s, {ms: 20_000, odometer: 1600, simulation: 'paused'})], [reading(s, {ms: 26_000, odometer: 1600})],
      [s.event(r.started()), [partial(trip),
        {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'sample-loss', startUtcMs: BASE_UTC + 6499, endUtcMs: BASE_UTC + 11_499,
          startMonotonicNs: ns(6499), endMonotonicNs: ns(11_499), sourceClockId: s.clockId, detail: {cause: 'reading-hole'}}}, distance(trip, 600)]],
      [s.event(r.delivered()), [attr(trip, 'trip'), delivered(trip, 'partial', at(5))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({recordingCompleteness: 'partial', observedDistanceM: {state: 'value', value: 600}});
  });
});

describe('game-time and position jumps (T17)', () => {
  it('labels a forward game-time jump a crossing only with a ferry or train between its readings [synthetic-inference]', () => {
    const {s, trip, rows} = opened();
    // Paused readings, so the long real-time steps are not reading holes.
    const clock = (ms: number, minutes: number) => reading(s, {ms, minutes, simulation: 'paused'});
    play([...rows, [clock(0, 1000)],
      // 30 game minutes in 29 s: above 60 per real minute.
      [clock(29_000, 1030)],
      // 30 minutes in 30 s is exactly 60 per real minute, and 29 minutes in 1 s is below 30 minutes: neither is a jump.
      [clock(59_000, 1060)], [clock(60_000, 1089)],
      [s.event(r.ferry(), paused), [attr(trip, 'trip'), note(trip, {cause: 'game-time-jump', label: 'possible-sleep', fromMinutes: '1000', toMinutes: '1030', atMonotonicNs: ns(29_000)})]],
      [clock(61_000, 1489)], [clock(62_000, 1490)],
      [s.event(r.paused(), paused), [note(trip, {cause: 'game-time-jump', label: 'crossing', fromMinutes: '1089', toMinutes: '1489', atMonotonicNs: ns(61_000)})]]]);
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
