// ET-014 PR-2: the effect shapes of readings accounting committed through the real storage core to a temporary synthetic
// database: observed-distance updates (also right before a close), a reading-hole sample-loss interval with source and
// UTC bounds, and reading annotations with numeric detail. The caller follows T3 as in trip-effects.test.ts. Expected
// rows are written by hand from docs/trips.md (T16, T17); none is read back from the reducer. Runs under
// npm run test:storage.
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {normalizeV1State, initialTripState, stepTrip, type NormalizedLiveState, type TripInput, type TripState} from '../../packages/telemetry-core/src/index';
import type {Storage} from '../../packages/storage/src/index';
import {BASE_UTC, ETS2_A, RECEIVED_UTC, Script, r, sessionInput, type Step} from '../shared/trip-messages';
import {ok, readOnly, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const at = (seconds: number) => BASE_UTC + seconds * 1_000;
const snapshot = v1('snapshot');
if (snapshot.kind !== 'snapshot') throw new Error('Harness: snapshot fixture expected');
const BASE: NormalizedLiveState = normalizeV1State(snapshot.data.state, snapshot.data.status);
const NONE = {state: 'missing', reason: 'not-observed'} as const;
/** A running reading of the script's session at `ms` (source ns 1,000,000,000,000 + ms × 1,000,000; UTC BASE_UTC + ms). */
function reading(s: Script, ms: number, odometer: number, fuel: number): TripInput {
  return {kind: 'reading', sample: {source: {game: 'ets2', origin: 'synthetic', pluginSessionId: s.session, processInstanceId: `20000000${s.session.slice(8)}`},
    capture: {clockId: s.clockId, monotonicNs: (1_000_000_000_000n + BigInt(ms) * 1_000_000n).toString()},
    state: {...BASE, simulation: 'running', odometer: {state: 'value', value: {kind: 'odometer', meters: odometer}}, fuel: {state: 'value', value: fuel},
      gameTime: {minutes: NONE, clockId: BASE.gameTime.clockId}, worldPlacement: NONE}, utcMs: BASE_UTC + ms}};
}
function drive(storage: Storage, steps: Step[], state: TripState = initialTripState()) {
  const statuses: string[] = [];
  for (const step of steps) {
    if ('version' in step) {
      const coveredThrough = ok(storage.committedThrough(step.source.pluginSessionId));
      const input: TripInput = step.kind === 'event' ? {kind: 'event', message: step, coveredThrough, receivedUtcMs: RECEIVED_UTC} : {kind: 'gap', message: step, coveredThrough, receivedUtcMs: RECEIVED_UTC};
      const result = stepTrip(state, input);
      if (!result.ok) throw new Error(`Unexpected ${result.code}`);
      statuses.push(ok(step.kind === 'event' ? storage.commitEvent({message: step, effects: result.effects}) : storage.commitGap({message: step, effects: result.effects})).status);
      state = result.state;
    } else {
      const input = step.kind === 'session' ? {...step, coveredThrough: ok(storage.upsertSession({message: step.welcome})).committedThroughEventSeq} : step;
      const result = stepTrip(state, input);
      if (!result.ok) throw new Error(`Unexpected ${result.code}`);
      state = result.state;
    }
  }
  return {state, statuses};
}

describe('ET-014 PR-2 readings accounting effects through real commits', () => {
  it('stores the observed distance, a reading-hole interval and reading annotations [synthetic-inference]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '2');
    const {statuses} = drive(storage, [sessionInput(s.welcome()), s.event(r.started()), s.event(r.jobConfigured()),
      reading(s, 0, 1000, 400), reading(s, 1000, 1100, 399),
      // 5 s while running: a hole. 50 m across it is a continuous step. Then a refuel of 52 L and an odometer jump.
      reading(s, 6000, 1150, 398), reading(s, 7000, 1150, 450), reading(s, 8000, 60_000, 450),
      s.event(r.fined()),
      reading(s, 9000, 60_100, 449),
      s.event(r.delivered())]);
    expect(statuses).toEqual(['committed', 'committed', 'committed', 'committed']);
    expect(ok(storage.listTrips()).trips.map(trip => ({tripUuid: trip.tripUuid, outcome: trip.outcome, recordingCompleteness: trip.recordingCompleteness, endedUtcMs: trip.endedUtcMs,
      observedDistanceM: trip.observedDistanceM}))).toEqual([
      // 100 + 50 m before the fine, 100 m after it; the delivery commit persists 250 m before closing the trip.
      {tripUuid: t, outcome: 'delivered', recordingCompleteness: 'partial', endedUtcMs: at(4), observedDistanceM: {available: true, value: 250}}]);
    storage.close();
    const intervals = readOnly(ws.database, db => (db.prepare(`SELECT c.kind, c.start_utc_ms AS startUtc, c.end_utc_ms AS endUtc, CAST(c.start_monotonic_ns AS INTEGER) AS startNs,
      CAST(c.end_monotonic_ns AS INTEGER) AS endNs, c.source_clock_ref IS NOT NULL AS clock, c.detail_json FROM completeness_intervals c ORDER BY c.id`).all() as {detail_json: string}[])
      .map(({detail_json, ...row}) => ({...row, detail: JSON.parse(detail_json) as unknown})));
    expect(intervals).toEqual([
      {kind: 'sample-loss', startUtc: BASE_UTC + 1000, endUtc: BASE_UTC + 6000, startNs: 1_001_000_000_000, endNs: 1_006_000_000_000, clock: 1, detail: {cause: 'reading-hole'}},
      {kind: 'discontinuity', startUtc: null, endUtc: null, startNs: null, endNs: null, clock: 0, detail: {annotation: true, cause: 'refuel', addedLiters: 52, atMonotonicNs: '1007000000000'}},
      {kind: 'discontinuity', startUtc: null, endUtc: null, startNs: null, endNs: null, clock: 0,
        detail: {annotation: true, cause: 'odometer-jump', deltaM: 58_850, atMonotonicNs: '1008000000000'}}
    ]);
  });
});
