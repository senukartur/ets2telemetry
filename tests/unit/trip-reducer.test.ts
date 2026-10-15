// ET-014 PR-1: the trip lifecycle and completeness reducer, one table row at a time. Every expected effect is written
// by hand from docs/trips.md, the T1–T20 decisions in concept.md and the CAP-01 observations O1–O11
// (docs/validation/cap-01a.md); none is copied from reducer output. Each case names its evidence basis: an O number for
// a synthetic sequence shaped after that text observation, concept-2026-10-13/14 for an owner decision, or
// synthetic-inference for a sequence never observed in a real game. Trip UUIDs come from an independent node:crypto
// implementation of the T4 derivation. In gap-free scripts eventSeq n carries the UTC label BASE_UTC + n × 1,000 ms.
import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {MAX_EFFECTS as STORAGE_MAX_EFFECTS} from '../../packages/storage/src/api';
import {
  MAX_ANNOTATIONS_PER_COMMIT, MAX_EFFECTS, initialTripState, jobKey, stepTrip, tripView, type EventMessage, type GapMessage, type TripEffect, type TripInput, type TripSeed, type TripState
} from '../../packages/telemetry-core/src/index';
import {
  ATS_A, BASE_UTC, ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, RECEIVED_UTC, Script, cargoMarketJob, carrier, job, otherJob, r, run, sessionInput, trailer, truck, type Step
} from '../shared/trip-messages';

const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const UNKNOWN_MODE = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const BURST_REFS = {truckConfiguration: {eventSeq: '1'}, trailerConfigurations: [{eventSeq: '2'}]};
const at = (seconds: number) => BASE_UTC + seconds * 1_000;
const open = (tripUuid: string, startedUtcMs: number, extra: Partial<Extract<TripEffect, {kind: 'trip.open'}>> = {}): TripEffect =>
  ({kind: 'trip.open', tripUuid, game: 'ets2', gameMode: UNKNOWN_MODE, jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs, ...extra});
const close = (tripUuid: string, outcome: 'delivered' | 'cancelled' | 'none', closeReason: string, recordingCompleteness: string, endedUtcMs: number): TripEffect =>
  ({kind: 'trip.close', tripUuid, outcome, closeReason, ...(outcome !== 'none' ? {outcomeEvent: 'this-event'} : {}), recordingCompleteness, endedUtcMs} as TripEffect);
const attr = (tripUuid: string | null, attribution: 'trip' | 'trip-before-loaded' | 'free-driving' | 'ambiguous'): TripEffect => ({kind: 'event.attribute', tripUuid, attribution});
const cause = (tripUuid: string | null, kind: 'discontinuity' | 'not-connected' | 'event-loss', detail: Record<string, unknown>): TripEffect =>
  ({kind: 'completeness.add', interval: {tripUuid, kind, detail}});
const partial = (tripUuid: string): TripEffect => ({kind: 'trip.update', tripUuid, set: {recordingCompleteness: 'partial'}});
const zeroCauses = {offline: '0', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'};

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
const paused = {simulation: 'paused'} as const;
/** O1: the start burst of a session: truck and trailer configuration, timers.restart, then simulation.started (eventSeq 1–4). */
const burst = (s: Script): Row[] => [[s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)], [s.event(r.timersRestart(), paused)], [s.event(r.started())]];
/** The start burst, then a job accepted while paused (O2) at eventSeq 6 and the next start at eventSeq 7. */
function acceptedJob(s: Script, configured = job()): {rows: Row[]; trip: string} {
  const trip = uuid(s.session, '6');
  return {trip, rows: [[sessionInput(s.welcome())], ...burst(s), [s.event(r.paused(), paused)],
    [s.event(r.jobConfigured(configured), paused), [open(trip, at(6), BURST_REFS)]], [s.event(r.started())]]};
}

describe('ET-014 constants', () => {
  it('uses the storage commit bound (T18)', () => {
    expect(MAX_EFFECTS).toBe(STORAGE_MAX_EFFECTS);
    expect(MAX_ANNOTATIONS_PER_COMMIT).toBe(8);
  });
});

describe('job lifecycle', () => {
  it('1. normal delivery: pause, delivery while paused, then the clear (REG-001) [O1, O2, O5, O6, O8]', () => {
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    const state = play([
      [sessionInput(s.welcome())], ...burst(s), [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(), paused), [open(t, at(6), BURST_REFS)]],
      // O2: the burst re-sends identical truck and trailer configuration.
      [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)],
      [s.event(r.started())],
      [s.event(r.fined('400')), [attr(t, 'trip')]],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered('15000'), paused), [attr(t, 'trip'), close(t, 'delivered', 'outcome', 'complete', at(12))]],
      [s.event(r.jobCleared(), paused)]
    ]);
    const view = tripView(state, 'ets2');
    expect(view).toMatchObject({phase: 'idle', untrackedJob: false, current: null, lastClosed: {
      tripUuid: t, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete', startedUtcMs: at(6), endedUtcMs: at(12),
      // Opened at eventSeq 6 and closed at eventSeq 12 of a 1 s source clock: 6 s of real time.
      realDurationNs: '6000000000',
      plannedDistance: {state: 'value', value: {kind: 'planned', meters: 152000}},
      expectedIncome: {state: 'value', value: {kind: 'expected-income', raw: '12345', sdkType: 'u64', currency: {basis: 'unknown'}}},
      revenue: {state: 'value', value: {kind: 'revenue', raw: '15000', sdkType: 's64', currency: {basis: 'sdk-documented', code: 'EUR'}}},
      penalty: {state: 'missing', reason: 'not-observed'},
      deliveredDistance: {state: 'value', value: {kind: 'game-delivered', meters: 151250.5}},
      fines: {totals: [{kind: 'fine', raw: '400', count: 1, sdkType: 's64'}], unavailable: 0}
    }});
  });
  it('2. cancellation: the clear, identical truck/trailer re-sends, then job.cancelled (REG-004) [O7]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows,
      [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)],
      [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)],
      [s.event(r.cancelled('12000'), paused), [attr(trip, 'trip'), close(trip, 'cancelled', 'outcome', 'complete', at(12))]]
    ]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({outcome: 'cancelled', penalty: {state: 'value', value: {kind: 'penalty', raw: '12000'}}, revenue: {state: 'missing'}});
  });
  it('3. a delivery after the clear still attaches when nothing lies between [concept-2026-10-13]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)],
      [s.event(r.delivered(), paused), [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(10))]]]);
  });
  it('4. a cleared job never yields an outcome; it closes at the next boundary (REG-004) [concept-2026-10-13]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), next = uuid(ETS2_A, '13');
    play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.started())],
      // The window closed at the clear: a fine afterwards is free driving.
      [s.event(r.fined()), [attr(null, 'free-driving')]],
      [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(13)), open(next, at(13), BURST_REFS)]]]);
    const t = new Script(ETS2_A), second = acceptedJob(t);
    play([...second.rows, [t.event(r.paused(), paused)], [t.event(r.jobCleared(), paused)],
      [t.event(r.timersRestart(), paused), [close(second.trip, 'none', 'discontinuity', 'partial', at(10))]]]);
  });
  it('5. clear(A), configure(B), then an outcome before any start is ambiguous and B stays open (T14) [concept-2026-10-13, synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), b = uuid(ETS2_A, '10');
    const state = play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(10)), open(b, at(10), BURST_REFS)]],
      [s.event(r.delivered(), paused), [attr(null, 'ambiguous')]],
      [s.event(r.started())], [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(b, 'trip'), close(b, 'delivered', 'outcome', 'complete', at(14))]]]);
    expect(tripView(state, 'ets2').lastClosed?.tripUuid).toBe(b);
  });
  it('12. cargo-market job: fines before pickup are trip-before-loaded; the pickup re-send is the same job [O3, concept-2026-10-13]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s, cargoMarketJob(false));
    const state = play([...rows,
      [s.event(r.fined('150')), [attr(trip, 'trip-before-loaded')]],
      [s.event(r.toll('35')), [attr(trip, 'trip-before-loaded')]],
      [s.event(r.paused(), paused)],
      // Pickup: the configuration re-sent with only cargoLoaded changed, with truck and trailer (O3, run 8).
      [s.event(r.jobConfigured(cargoMarketJob(true)), paused)], [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)],
      [s.event(r.started())],
      [s.event(r.fined('400')), [attr(trip, 'trip')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', current: {tripUuid: trip, recordingCompleteness: 'unknown', cargoLoaded: {state: 'value', value: true},
      finesBeforeLoaded: {totals: [{raw: '150', count: 1}]}, fines: {totals: [{raw: '400', count: 1}]}, tolls: {totals: [{raw: '35', count: 1}]}}});
  });
  it('13. quick-job replacement without a clear closes as different-job [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), b = uuid(ETS2_A, '8');
    play([...rows,
      [s.event(r.jobConfigured(otherJob())), [close(trip, 'none', 'different-job', 'partial', at(8)), open(b, at(8), BURST_REFS)]],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(b, 'trip'), close(b, 'delivered', 'outcome', 'complete', at(10))]]]);
  });
  it('17. fines and tolls outside any job are free driving [O8]', () => {
    const s = new Script(ETS2_A);
    play([[sessionInput(s.welcome())], ...burst(s), [s.event(r.fined()), [attr(null, 'free-driving')]], [s.event(r.toll()), [attr(null, 'free-driving')]]]);
  });
  it('18. ferry and train crossings inside the window belong to the trip [O11, synthetic-inference for the train]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows, [s.event(r.paused(), paused)],
      [s.event(r.ferry('677'), paused), [attr(trip, 'trip')]], [s.event(r.started())], [s.event(r.train('250')), [attr(trip, 'trip')]]]);
    expect(tripView(state, 'ets2').current?.transfers).toMatchObject({totals: [{kind: 'transfer', raw: '927', count: 2}], unavailable: 0});
  });
  it('19. a different truck updates the reference and is annotated without downgrading [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    play([...rows,
      [s.event(r.truckConfigured(truck({licensePlate: {available: true, value: 'SYN 0009'}}))),
        [{kind: 'trip.update', tripUuid: trip, set: {truckConfiguration: 'this-event'}}, cause(trip, 'discontinuity', {annotation: true, cause: 'truck-change', atEventSeq: '8'})]],
      [s.event(r.trailerConfigured(trailer(1))), [{kind: 'trip.update', tripUuid: trip, set: {trailerConfigurations: ['this-event']}}]],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(11))]]]);
  });
});

describe('loads, restarts and continuations', () => {
  it('O1: a job in the start burst opens partial and survives the burst timers.restart (T12) [O1]', () => {
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '1');
    play([[sessionInput(s.welcome())],
      [s.event(r.jobConfigured(), paused), [open(t, at(1), {recordingCompleteness: 'partial'}), cause(t, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '1'})]],
      [s.event(r.truckConfigured(), paused), [{kind: 'trip.update', tripUuid: t, set: {truckConfiguration: 'this-event'}}]],
      [s.event(r.timersRestart(), paused)], [s.event(r.started())],
      [s.event(r.fined()), [attr(t, 'trip')]]]);
  });
  it('10. a plugin restart closes the earlier session\'s trip; the identical job is not merged (T11) [synthetic-inference]', () => {
    const a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), {rows, trip} = acceptedJob(a), next = uuid(ETS2_B, '1');
    const state = play([...rows, [a.event(r.fined()), [attr(trip, 'trip')]],
      [{kind: 'disconnected'}], [sessionInput(b.welcome())],
      // The restart close waits for the new session's first commit; its end is the old session's last label, eventSeq 8.
      [b.event(r.jobConfigured(), paused), [close(trip, 'none', 'restart', 'partial', at(8)), open(next, BASE_UTC + 101_000, {recordingCompleteness: 'partial'}),
        cause(next, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '1'}), cause(next, 'discontinuity', {cause: 'restart', continuationOf: trip, decision: 'not-merged', atEventSeq: '1'})]]]);
    // The retired session's items are refused.
    expect(stepTrip(state, carrier(state, a.event(r.fined())))).toEqual({ok: false, code: 'UNKNOWN_SESSION'});
  });
  it('11a. save load of the same job continues the trip as partial (T8) [O9, O10]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows, [s.event(r.fined()), [attr(trip, 'trip')]], [s.event(r.paused(), paused)],
      [s.event(r.jobCleared(), paused)], [s.event(r.truckCleared(), paused)], [s.event(r.trailerCleared(0), paused)],
      [s.event(r.jobConfigured(), paused)], [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)],
      [s.event(r.started())],
      [s.event(r.regression('12345', '12000')), [partial(trip), cause(trip, 'discontinuity', {cause: 'save-load', fromClockId: GAME_CLOCK_1, toClockId: GAME_CLOCK_2, atEventSeq: '17'})]],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'partial', at(19))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({tripUuid: trip, recordingCompleteness: 'partial', outcome: 'delivered'});
  });
  it('11b. save load of a different job closes the old trip and keeps the loaded one, partial (T8, T12) [O10, synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), b = uuid(ETS2_A, '12');
    const state = play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.truckCleared(), paused)], [s.event(r.trailerCleared(0), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(12)), open(b, at(12))]],
      [s.event(r.truckConfigured(), paused), [{kind: 'trip.update', tripUuid: b, set: {truckConfiguration: 'this-event'}}]],
      [s.event(r.trailerConfigured(), paused), [{kind: 'trip.update', tripUuid: b, set: {trailerConfigurations: ['this-event']}}]],
      [s.event(r.started())],
      [s.event(r.regression('12345', '12000')), [partial(b), cause(b, 'discontinuity', {cause: 'save-load', fromClockId: GAME_CLOCK_1, toClockId: GAME_CLOCK_2, atEventSeq: '16'})]],
      [s.event(r.fined()), [attr(b, 'trip')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', current: {tripUuid: b, recordingCompleteness: 'partial'}});
  });
  it('11c. save load with no job closes the trip as a discontinuity [O10, synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.truckCleared(), paused)], [s.event(r.trailerCleared(0), paused)],
      [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)], [s.event(r.started())],
      [s.event(r.regression('12345', '12000')), [close(trip, 'none', 'discontinuity', 'partial', at(15))]],
      [s.event(r.fined()), [attr(null, 'free-driving')]]]);
  });
  it('14. profile switch: the other profile\'s job opens and its timer restart makes it partial [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), b = uuid(ETS2_A, '12');
    play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.truckCleared(), paused)], [s.event(r.trailerCleared(0), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(12)), open(b, at(12))]],
      [s.event(r.truckConfigured(truck({licensePlate: {available: true, value: 'SYN 0009'}})), paused), [{kind: 'trip.update', tripUuid: b, set: {truckConfiguration: 'this-event'}}]],
      [s.event(r.timersRestart(), paused), [partial(b), cause(b, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '14'})]],
      [s.event(r.started())], [s.event(r.fined()), [attr(b, 'trip')]]]);
  });
  it('15. a mid-trip timers.restart closes the trip; the identical re-send opens a not-merged continuation [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), next = uuid(ETS2_A, '10');
    play([...rows, [s.event(r.fined()), [attr(trip, 'trip')]],
      [s.event(r.timersRestart(), paused), [close(trip, 'none', 'discontinuity', 'partial', at(9))]],
      [s.event(r.jobConfigured(), paused), [open(next, at(10), {...BURST_REFS, recordingCompleteness: 'partial'}), cause(next, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '10'}),
        cause(next, 'discontinuity', {cause: 'discontinuity', continuationOf: trip, decision: 'not-merged', atEventSeq: '10'})]]]);
  });
  it('23. a reload check resolved by a running fine closes the old trip and opens an ambiguous continuation (T8) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), next = uuid(ETS2_A, '10');
    const state = play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)],
      [s.event(r.jobConfigured(), paused)], [s.event(r.started())],
      [s.event(r.fined()), [close(trip, 'none', 'configuration-cleared', 'partial', at(12)),
        open(next, at(12), {...BURST_REFS, jobConfiguration: {eventSeq: '10'}, recordingCompleteness: 'partial'}),
        cause(next, 'discontinuity', {cause: 'reload', continuationOf: trip, decision: 'not-merged', atEventSeq: '12'}), attr(null, 'ambiguous')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', current: {tripUuid: next, recordingCompleteness: 'partial'}});
  });
  it('after a save load, the next job accepted while paused opens unknown and closes complete (T12: a regression starts no load) [O2, O10]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), next = uuid(ETS2_A, '17');
    play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.truckCleared(), paused)], [s.event(r.trailerCleared(0), paused)],
      [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)], [s.event(r.started())],
      [s.event(r.regression('12345', '12000')), [close(trip, 'none', 'discontinuity', 'partial', at(15))]],
      [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [open(next, at(17), {truckConfiguration: {eventSeq: '12'}, trailerConfigurations: [{eventSeq: '13'}]})]],
      [s.event(r.started())], [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(next, 'trip'), close(next, 'delivered', 'outcome', 'complete', at(20))]]]);
  });
  it('an outcome that resolves a reload check closes the old trip and opens none (T8, T14) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.jobConfigured(), paused)],
      [s.event(r.delivered(), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(11)), attr(null, 'ambiguous')]],
      [s.event(r.started())], [s.event(r.fined()), [attr(null, 'free-driving')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'idle', untrackedJob: false, current: null});
  });
  it('a save from before a cargo-market pickup is not continued: cargoLoaded differs (T8) [O3, O10, concept-2026-10-14]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s, cargoMarketJob(false)), next = uuid(ETS2_A, '13');
    const state = play([...rows, [s.event(r.paused(), paused)],
      // Pickup while active: the same job with cargoLoaded now true (O3).
      [s.event(r.jobConfigured(cargoMarketJob(true)), paused)], [s.event(r.started())], [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)],
      // The save restores the job from before the pickup: every attribute but cargoLoaded is identical.
      [s.event(r.jobConfigured(cargoMarketJob(false)), paused), [close(trip, 'none', 'configuration-cleared', 'partial', at(13)),
        open(next, at(13), {...BURST_REFS, recordingCompleteness: 'partial'}), cause(next, 'discontinuity', {cause: 'reload', continuationOf: trip, decision: 'not-merged', atEventSeq: '13'})]],
      [s.event(r.started())],
      [s.event(r.regression('12345', '12000')), [cause(next, 'discontinuity', {cause: 'save-load', fromClockId: GAME_CLOCK_1, toClockId: GAME_CLOCK_2, atEventSeq: '15'})]],
      [s.event(r.fined()), [attr(next, 'trip-before-loaded')]]]);
    // The closed trip keeps the value it had: loaded at the pickup.
    expect(tripView(state, 'ets2')).toMatchObject({current: {tripUuid: next, cargoLoaded: {state: 'value', value: false}}, lastClosed: {tripUuid: trip, cargoLoaded: {state: 'value', value: true}}});
  });
  it('a clear inside a reload check returns to waiting for the outcome [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows, [s.event(r.paused(), paused)], [s.event(r.jobCleared(), paused)], [s.event(r.jobConfigured(), paused)],
      [s.event(r.jobCleared(), paused)],
      [s.event(r.cancelled(), paused), [attr(trip, 'trip'), close(trip, 'cancelled', 'outcome', 'complete', at(12))]]]);
    expect(tripView(state, 'ets2').phase).toBe('idle');
  });
});

describe('hydration, gaps and connections', () => {
  it('16a. late attach: a checkpoint job stays untracked until an identical job.configured opens a partial trip (T9) [concept-2026-10-14, synthetic-inference]', () => {
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '23');
    let state = play([[sessionInput(s.welcome())], [{kind: 'checkpoint', message: s.checkpoint(job())}]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'idle', untrackedJob: true, current: null});
    const gap = s.gap(20, 'offline');
    state = play([
      // The consumer was absent for eventSeq 1–20 (offline): a session-level not-connected interval (T10).
      [gap, gapEffects(gap, null, '1', '20')],
      // The checkpoint showed a job: a fine meanwhile is inside a job no trip tracks, so ambiguous, never free driving
      // (concept.md, October 13, 2026; fix round 1 finding 2 changed this requirement from free-driving).
      [s.event(r.fined()), [attr(null, 'ambiguous')]], [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(), paused), [open(t, at(4), {recordingCompleteness: 'partial'}), cause(t, 'not-connected', {cause: 'late-attach', atEventSeq: '23'})]]
    ], state);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', untrackedJob: false, current: {tripUuid: t, recordingCompleteness: 'partial'}});
  });
  it('a checkpoint job applies only from the checkpoint on: replayed earlier events are ordinary stream events (T9) [synthetic-inference]', () => {
    // While the consumer was absent: the player started, got a fine while driving freely, paused and accepted job K. The
    // four events are retained, so they arrive after the checkpoint, which already shows K (protocol v1 §7, §9).
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '4');
    const retained = [s.event(r.started()), s.event(r.fined()), s.event(r.paused(), paused), s.event(r.jobConfigured(), paused)];
    const checkpoint = s.checkpoint(job(), 4);
    const state = play([[sessionInput(s.welcome())], [{kind: 'checkpoint', message: checkpoint}],
      [retained[0]], [retained[1], [attr(null, 'free-driving')]], [retained[2]],
      // K's own configuration event is replayed: a real start, but the consumer has no readings from before it attached.
      [retained[3], [open(t, at(4), {recordingCompleteness: 'partial'}), cause(t, 'not-connected', {cause: 'opened-before-attach', atEventSeq: '4'})]],
      [s.event(r.started())], [s.event(r.fined()), [attr(t, 'trip')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', untrackedJob: false, current: {tripUuid: t, recordingCompleteness: 'partial'}});
  });
  it('a replayed clear does not end a checkpoint job; live events after the checkpoint are ambiguous until a live clear (T9, T14) [synthetic-inference]', () => {
    const s = new Script(ETS2_A);
    const retained = [s.event(r.started()), s.event(r.fined()), s.event(r.jobCleared())];
    const checkpoint = s.checkpoint(job(), 3);
    play([[sessionInput(s.welcome())], [{kind: 'checkpoint', message: checkpoint}],
      [retained[0]], [retained[1], [attr(null, 'free-driving')]], [retained[2]],
      [s.event(r.fined()), [attr(null, 'ambiguous')]], [s.event(r.jobCleared())], [s.event(r.fined()), [attr(null, 'free-driving')]]]);
  });
  it('16b. the outcome of an untracked job is ambiguous (T9, T14) [synthetic-inference]', () => {
    const s = new Script(ETS2_A);
    let state = play([[sessionInput(s.welcome())], [{kind: 'checkpoint', message: s.checkpoint(job())}]]);
    const gap = s.gap(20, 'offline');
    state = play([[gap, gapEffects(gap, null, '1', '20')], [s.event(r.paused(), paused)], [s.event(r.delivered(), paused), [attr(null, 'ambiguous')]]], state);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'idle', untrackedJob: false, current: null});
  });
  it('a checkpoint never opens, closes or attributes, even with a job (T9) [concept-2026-10-14]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const state = play([...rows, [{kind: 'checkpoint', message: s.checkpoint(null)}], [{kind: 'checkpoint', message: s.checkpoint(otherJob())}]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'active', untrackedJob: false, current: {tripUuid: trip}});
  });
  it('8. a gap in an active trip closes it as partial; the later delivery is ambiguous (REG-003, T10) [concept-2026-10-13]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), gap = s.gap(2);
    play([...rows,
      // The gap carries no UTC label: the close uses the session's last label, eventSeq 7 (T15).
      [gap, [close(trip, 'none', 'gap', 'partial', at(7)), ...gapEffects(gap, trip, '8', '9')]],
      [s.event(r.paused(), paused)], [s.event(r.delivered(), paused), [attr(null, 'ambiguous')]]]);
  });
  it('after a gap closes an active trip, gameplay events are ambiguous until a clear or an outcome (T14) [concept-2026-10-13, synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), gap = s.gap(2);
    let state = play([...rows, [gap, [close(trip, 'none', 'gap', 'partial', at(7)), ...gapEffects(gap, trip, '8', '9')]]]);
    expect(tripView(state, 'ets2')).toMatchObject({phase: 'idle', untrackedJob: true});
    state = play([[s.event(r.fined()), [attr(null, 'ambiguous')]], [s.event(r.toll()), [attr(null, 'ambiguous')]], [s.event(r.paused(), paused)],
      [s.event(r.jobCleared(), paused)], [s.event(r.started())], [s.event(r.fined()), [attr(null, 'free-driving')]]], state);
    expect(tripView(state, 'ets2').untrackedJob).toBe(false);
  });
  it('after a gap, the identical job re-sent opens a gap continuation, not a late attach [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), gap = s.gap(2), next = uuid(ETS2_A, '11');
    play([...rows, [gap, [close(trip, 'none', 'gap', 'partial', at(7)), ...gapEffects(gap, trip, '8', '9')]], [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(), paused), [open(next, at(10), {...BURST_REFS, recordingCompleteness: 'partial'}),
        cause(next, 'discontinuity', {cause: 'gap', continuationOf: trip, decision: 'not-merged', atEventSeq: '11'})]]]);
  });
  it('a continuation candidate of an earlier session is relabelled restart in the new session (T11) [synthetic-inference]', () => {
    const a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), {rows, trip} = acceptedJob(a), gap = a.gap(2), next = uuid(ETS2_B, '1');
    play([...rows, [gap, [close(trip, 'none', 'gap', 'partial', at(7)), ...gapEffects(gap, trip, '8', '9')]], [{kind: 'disconnected'}], [sessionInput(b.welcome())],
      [b.event(r.jobConfigured(), paused), [open(next, BASE_UTC + 101_000, {recordingCompleteness: 'partial'}), cause(next, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '1'}),
        cause(next, 'discontinuity', {cause: 'restart', continuationOf: trip, decision: 'not-merged', atEventSeq: '1'})]]]);
  });
  it('9. an overlapping merged gap applies only its suffix beyond the processed point (T5) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), gap = s.gap(2);
    let state = play([...rows, [gap, [close(trip, 'none', 'gap', 'partial', at(7)), ...gapEffects(gap, trip, '8', '9')]]]);
    // The producer extended the retained record in place and redelivered it whole after an ACK inside it (protocol v1 §9).
    const merged = s.gapRange(8n, 11n, {queueCount: '4'});
    s.next = 12n;
    state = play([[merged, [cause(null, 'event-loss', {cause: 'gap', causes: {...zeroCauses, queueCount: '4'}, firstEventSeq: '8', lastEventSeq: '11', redelivered: false})]
      .map(effect => ({...effect, interval: {...(effect as Extract<TripEffect, {kind: 'completeness.add'}>).interval, firstEventSeq: '10', lastEventSeq: '11'}}) as TripEffect)]], state);
    for (const covered of [gap, merged]) {
      const result = stepTrip(state, carrier(state, covered));
      expect(result).toEqual({ok: true, state, effects: []});
      if (result.ok) expect(result.state).toBe(state);
    }
  });
  it.each([
    ['offline only', {offline: '3'}, 'not-connected'],
    ['retention expiry and no durable consumer', {retentionExpired: '2', noDurableConsumer: '1'}, 'not-connected'],
    ['queue overflow', {queueBytes: '3'}, 'event-loss'],
    ['offline mixed with an encoding failure', {offline: '2', encodingFailed: '1'}, 'event-loss']
  ] as const)('T10: a gap of %s is %s [synthetic-inference]', (_name, causes, kind) => {
    const s = new Script(ETS2_A), gap = s.gapRange(1n, 3n, causes);
    s.next = 4n;
    play([[sessionInput(s.welcome())], [gap, [cause(null, kind, {cause: 'gap', causes: {...zeroCauses, ...causes}, firstEventSeq: '1', lastEventSeq: '3', redelivered: false})]
      .map(effect => withBounds(effect, gap, '1', '3'))]]);
  });
  it('22. interleaved ETS2 and ATS sessions keep separate trips; a reconnection marks the gap in connection (T13) [synthetic-inference]', () => {
    const e = new Script(ETS2_A), a = new Script(ATS_A, 'ats', {utcMs: BASE_UTC + 50_000}), {rows, trip} = acceptedJob(e), atsTrip = uuid(ATS_A, '3');
    const lastEts2 = rows.at(-1)![0] as EventMessage;
    let state = play([...rows, [{kind: 'disconnected'}], [sessionInput(a.welcome())],
      [a.event(r.started())], [a.event(r.paused(), paused)],
      [a.event(r.jobConfigured(), paused), [open(atsTrip, BASE_UTC + 53_000, {game: 'ats'})]],
      [a.event(r.started())], [a.event(r.fined()), [attr(atsTrip, 'trip')]],
      [{kind: 'disconnected'}]]);
    const welcome = e.welcome();
    state = play([[sessionInput(welcome, '7')],
      [e.event(r.fined()), [partial(trip), {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: at(7),
        startMonotonicNs: (lastEts2.data.occurred.monotonicNs as {value: string}).value, endMonotonicNs: welcome.capture.monotonicNs, sourceClockId: e.clockId,
        detail: {cause: 'disconnected'}}}, attr(trip, 'trip')]]], state);
    expect(tripView(state, 'ets2').current).toMatchObject({tripUuid: trip, recordingCompleteness: 'partial'});
    expect(tripView(state, 'ats').current).toMatchObject({tripUuid: atsTrip, recordingCompleteness: 'unknown'});
  });
});

describe('time and game mode', () => {
  it('20. a UTC label set back is clamped at the trip start and annotated, without downgrading (T15) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), back = BASE_UTC - 3_600_000;
    play([...rows, [s.event(r.paused(), {simulation: 'paused', utcMs: back})],
      [s.event(r.delivered(), {simulation: 'paused', utcMs: back + 1_000}), [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(6)),
        cause(trip, 'discontinuity', {annotation: true, cause: 'utc-label-jump', labelUtcMs: back + 1_000, clampedToUtcMs: at(6), atEventSeq: '9'})]]]);
  });
  it('an unavailable UTC label falls back to the last label of the session (T15) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    play([[sessionInput(s.welcome())], ...burst(s), [s.event(r.paused(), paused)],
      [s.event(r.jobConfigured(), {simulation: 'paused', utcMs: null}), [open(t, at(5), BURST_REFS)]]]);
  });
  it('21. a game-mode change marks the open trip ambiguous once; later trips take the new mode [concept-2026-10-13]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s), next = uuid(ETS2_A, '13');
    play([...rows,
      [s.event(r.gameMode({mode: 'truckersmp', method: 'module-scan', confidence: 'strong', module: 'synthetic-multiplayer-module.dll'})),
        [{kind: 'trip.update', tripUuid: trip, set: {gameModeAmbiguous: true}}]],
      [s.event(r.gameMode({mode: 'single-player', method: 'process-scan', confidence: 'weak'}))],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(11))]],
      [s.event(r.jobCleared(), paused)],
      [s.event(r.jobConfigured(otherJob()), paused), [open(next, at(13), {...BURST_REFS, gameMode: {mode: 'single-player', method: 'process-scan', confidence: 'weak'}})]]]);
  });
});

describe('delivery semantics (T3, T5)', () => {
  it('6. duplicate and redelivered events and gaps change nothing (REG-005) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const delivered = s.event(r.delivered(), paused), gap = s.gap(2);
    const state = play([...rows, [delivered, [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(8))]],
      [gap, gapEffects(gap, null, '9', '10')]]);
    for (const [step] of [...rows.slice(1), [delivered], [gap]] as Row[]) {
      const result = stepTrip(state, carrier(state, step as EventMessage | GapMessage));
      expect(result).toEqual({ok: true, state, effects: []});
      if (result.ok) expect(result.state).toBe(state);
    }
  });
  it('7. crash before commit: the kept state yields identical effects; crash after commit: redelivery is a duplicate (REG-006 domain) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), {rows, trip} = acceptedJob(s);
    const before = deepFreeze(play(rows)), message = deepFreeze(s.event(r.delivered(), paused));
    const first = stepTrip(before, carrier(before, message));
    // The commit failed: the caller keeps `before` and steps the redelivered event again.
    const retry = stepTrip(before, carrier(before, message));
    expect(retry).toEqual(first);
    expect(first).toMatchObject({ok: true, effects: [attr(trip, 'trip'), close(trip, 'delivered', 'outcome', 'complete', at(8))]});
    if (!first.ok) throw new Error('unreachable');
    // The commit succeeded and the state was adopted; the producer redelivers after a lost ACK.
    expect(stepTrip(first.state, carrier(first.state, message))).toEqual({ok: true, state: first.state, effects: []});
  });
  it('24. order, coverage and session errors fail closed and leave the state unchanged (T5) [synthetic-inference]', () => {
    const s = new Script(ETS2_A), other = new Script(ETS2_B);
    const state = deepFreeze(play([[sessionInput(s.welcome())], [s.event(r.truckConfigured(), paused)], [s.event(r.trailerConfigured(), paused)]]));
    const snapshot = structuredClone(state);
    const third = s.event(r.paused(), paused), fourth = s.event(r.paused(), paused);
    const cases: [TripInput, string][] = [
      [carrier(state, fourth), 'ORDER_VIOLATION'],
      [carrier(state, s.gapRange(4n, 5n, {queueCount: '2'})), 'ORDER_VIOLATION'],
      [{kind: 'event', message: third, coveredThrough: '1', receivedUtcMs: RECEIVED_UTC}, 'COVERAGE_MISMATCH'],
      [{kind: 'gap', message: s.gapRange(3n, 3n, {queueCount: '1'}), coveredThrough: '0', receivedUtcMs: RECEIVED_UTC}, 'COVERAGE_MISMATCH'],
      [sessionInput(s.welcome(), '5'), 'COVERAGE_MISMATCH'],
      [carrier(state, other.event(r.paused(), paused)), 'UNKNOWN_SESSION'],
      [{kind: 'checkpoint', message: other.checkpoint(null)}, 'UNKNOWN_SESSION']
    ];
    for (const [input, code] of cases) expect(stepTrip(state, input), code).toEqual({ok: false, code});
    const gone = run(state, [{kind: 'disconnected'}]).state;
    expect(stepTrip(gone, carrier(gone, third))).toEqual({ok: false, code: 'UNKNOWN_SESSION'});
    expect(state).toEqual(snapshot);
    expect(stepTrip(state, {kind: 'reading', sample: {source: {game: 'ets2', origin: 'synthetic', pluginSessionId: ETS2_A, processInstanceId: ETS2_A},
      capture: {clockId: s.clockId, monotonicNs: '1'}, state: {} as never}})).toEqual({ok: true, state, effects: []});
  });
});

describe('cold start (TripSeed) and effect bounds (T11, T18)', () => {
  const seed = (tripUuid: string, overrides: Partial<TripSeed> = {}): TripSeed => ({tripUuid, pluginSessionId: ETS2_A, game: 'ets2', jobKey: jobKey(job()),
    startedUtcMs: at(6), recordingCompleteness: 'unknown', lastObservedUtcMs: at(9), ...overrides});
  it('closes a stored open trip of an earlier session as restart and marks the identical job as a continuation [synthetic-inference]', () => {
    const b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), stored = uuid(ETS2_A, '6'), next = uuid(ETS2_B, '2');
    play([[sessionInput(b.welcome(), '0', [seed(stored), seed(uuid(ATS_A, '1'), {game: 'ats', pluginSessionId: ATS_A})])],
      [b.event(r.truckConfigured(), paused), [close(stored, 'none', 'restart', 'partial', at(9))]],
      [b.event(r.jobConfigured(), paused), [open(next, BASE_UTC + 102_000, {truckConfiguration: {eventSeq: '1'}, recordingCompleteness: 'partial'}),
        cause(next, 'discontinuity', {cause: 'opened-at-load', atEventSeq: '2'}), cause(next, 'discontinuity', {cause: 'restart', continuationOf: stored, decision: 'not-merged', atEventSeq: '2'})]]]);
  });
  it('a queued not-connected interval of an earlier session drops its monotonic bounds before a later session commits it (T11) [synthetic-inference]', () => {
    const a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), {rows, trip} = acceptedJob(a);
    play([...rows, [{kind: 'disconnected'}], [sessionInput(a.welcome(), '7')], [{kind: 'disconnected'}], [sessionInput(b.welcome())],
      [b.event(r.truckConfigured(), paused), [partial(trip), {kind: 'completeness.add', interval: {tripUuid: trip, kind: 'not-connected', startUtcMs: at(7), detail: {cause: 'disconnected'}}},
        close(trip, 'none', 'restart', 'partial', at(7))]]]);
  });
  it('resumes a stored open trip of the same session as partial: the consumer was not running (T13) [synthetic-inference]', () => {
    const s = new Script(ETS2_A, 'ets2', {utcMs: at(5)}), stored = uuid(ETS2_A, '3');
    s.next = 6n;
    const state = play([[sessionInput(s.welcome(), '5', [seed(stored, {lastObservedUtcMs: at(5)})])],
      [s.event(r.fined()), [partial(stored), cause(stored, 'not-connected', {cause: 'consumer-restart'}), attr(stored, 'trip')]],
      [s.event(r.paused(), paused)],
      [s.event(r.delivered(), paused), [attr(stored, 'trip'), close(stored, 'delivered', 'outcome', 'partial', at(8))]]]);
    expect(tripView(state, 'ets2').lastClosed).toMatchObject({tripUuid: stored, outcome: 'delivered', recordingCompleteness: 'partial'});
  });
  it('never exceeds 16 effects or 8 annotations per commit; deferred effects follow in order (T18) [synthetic-inference]', () => {
    const b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000});
    // Twenty stored trips of an earlier session whose last label precedes their start: each close is clamped and annotated.
    const seeds = Array.from({length: 20}, (_, i) => seed(uuid(ETS2_A, String(100 + i)), {startedUtcMs: at(50), lastObservedUtcMs: at(40)}));
    const closes = seeds.map(x => close(x.tripUuid, 'none', 'restart', 'partial', at(50)));
    const notes = seeds.map(x => cause(x.tripUuid, 'discontinuity', {annotation: true, cause: 'utc-label-jump', labelUtcMs: at(40), clampedToUtcMs: at(50), atEventSeq: null}));
    play([[sessionInput(b.welcome(), '0', seeds)],
      [b.event(r.fined()), [...closes.slice(0, 15), attr(null, 'free-driving')]],
      [b.event(r.fined()), [...closes.slice(15), attr(null, 'free-driving'), ...notes.slice(0, 8)]],
      [b.event(r.fined()), [attr(null, 'free-driving'), ...notes.slice(8, 16)]],
      [b.event(r.fined()), [attr(null, 'free-driving'), ...notes.slice(16)]],
      [b.event(r.fined()), [attr(null, 'free-driving')]]]);
  });
});

/** The completeness interval of a whole gap record: its suffix range plus the record's lost-time bounds. */
function withBounds(effect: TripEffect, gap: GapMessage, first: string, last: string): TripEffect {
  const interval = (effect as Extract<TripEffect, {kind: 'completeness.add'}>).interval, d = gap.data;
  return {kind: 'completeness.add', interval: {tripUuid: interval.tripUuid, kind: interval.kind, firstEventSeq: first, lastEventSeq: last,
    startMonotonicNs: (d.firstLostMonotonicNs as {value: string}).value, endMonotonicNs: (d.lastLostMonotonicNs as {value: string}).value, sourceClockId: gap.capture.clockId, detail: interval.detail}};
}
/** The T10 interval of a queueCount gap record taken whole, attached to `tripUuid` (null: session-level). */
function gapEffects(gap: GapMessage, tripUuid: string | null, first: string, last: string): TripEffect[] {
  const count = (BigInt(last) - BigInt(first) + 1n).toString(), offline = gap.data.causes.offline !== '0';
  return [withBounds(cause(tripUuid, offline ? 'not-connected' : 'event-loss', {cause: 'gap', causes: offline ? {...zeroCauses, offline: count} : {...zeroCauses, queueCount: count},
    firstEventSeq: first, lastEventSeq: last, redelivered: false}), gap, first, last)];
}
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); }
  return value;
}
