// ET-014 PR-1: reducer effects applied through the real storage core to a temporary synthetic database. The caller
// follows T3: it reads committedThrough() right before each commit, steps the reducer, commits the message with the
// effects and adopts the new state only after a commit result. Expected rows are written by hand from docs/trips.md and
// the cases in tests/unit/trip-reducer.test.ts; they are not read back from the reducer. Runs under npm run test:storage.
import {createHash} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Storage} from '../../packages/storage/src/index';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {initialTripState, jobKey, stepTrip, type EventMessage, type GapMessage, type TripInput, type TripSeed, type TripState} from '../../packages/telemetry-core/src/index';
import {ATS_A, BASE_UTC, ETS2_A, ETS2_B, GAME_CLOCK_1, GAME_CLOCK_2, RECEIVED_UTC, Script, job, r, run, sessionInput} from '../shared/trip-messages';
import {failed, ok, readOnly, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

/** The T4 trip UUID derivation, written independently of the reducer with node:crypto. */
const uuid = (session: string, eventSeq: string) => {
  const h = createHash('sha256').update(`ets2telemetry-trip-v1:${session}:${eventSeq}`, 'utf8').digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
const at = (seconds: number) => BASE_UTC + seconds * 1_000;
const paused = {simulation: 'paused'} as const;
type Step = EventMessage | GapMessage | TripInput;

/** A T3 caller over the in-process storage core. Returns the adopted state and each carrier's commit status. */
function drive(storage: Storage, steps: Step[], state: TripState = initialTripState()) {
  const statuses: string[] = [];
  for (const step of steps) {
    if ('version' in step) {
      const coveredThrough = ok(storage.committedThrough(step.source.pluginSessionId));
      const input: TripInput = step.kind === 'event' ? {kind: 'event', message: step, coveredThrough, receivedUtcMs: RECEIVED_UTC} : {kind: 'gap', message: step, coveredThrough, receivedUtcMs: RECEIVED_UTC};
      const result = stepTrip(state, input);
      if (!result.ok) throw new Error(`Unexpected ${result.code}`);
      const committed = ok(step.kind === 'event' ? storage.commitEvent({message: step, effects: result.effects}) : storage.commitGap({message: step, effects: result.effects}));
      statuses.push(committed.status);
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
/** The start burst (eventSeq 1–4), a job accepted while paused at eventSeq 6 and the next start at eventSeq 7. */
const accepted = (s: Script): Step[] => [sessionInput(s.welcome()),
  s.event(r.truckConfigured(), paused), s.event(r.trailerConfigured(), paused), s.event(r.timersRestart(), paused), s.event(r.started()),
  s.event(r.paused(), paused), s.event(r.jobConfigured(), paused), s.event(r.started())];

interface Rows {attributions: unknown[]; intervals: unknown[]; counts: Record<string, number>}
function rows(file: string): Rows {
  return readOnly(file, db => ({
    attributions: db.prepare(`SELECT s.plugin_session_uuid AS session, CAST(e.event_seq AS INTEGER) AS eventSeq, t.trip_uuid AS trip, a.attribution FROM event_attributions a
      JOIN events e ON e.id = a.event_ref JOIN plugin_sessions s ON s.id = e.plugin_session_id LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY a.event_ref`).all(),
    intervals: (db.prepare(`SELECT c.kind, t.trip_uuid AS trip, CAST(c.first_event_seq AS INTEGER) AS first, CAST(c.last_event_seq AS INTEGER) AS last,
      CAST(c.start_monotonic_ns AS INTEGER) AS startNs, CAST(c.end_monotonic_ns AS INTEGER) AS endNs, c.start_utc_ms AS startUtc, ks.plugin_session_uuid AS clockSession, c.detail_json
      FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref LEFT JOIN clocks k ON k.id = c.source_clock_ref LEFT JOIN plugin_sessions ks ON ks.id = k.plugin_session_ref
      ORDER BY c.id`).all() as {detail_json: string | null}[])
      .map(({detail_json, ...row}) => ({...row, detail: detail_json === null ? null : JSON.parse(detail_json)})),
    counts: Object.fromEntries(['events', 'event_gaps', 'trips', 'trip_trailers', 'event_attributions', 'completeness_intervals']
      .map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {n: number}]).map(([table, row]) => [table, (row as {n: number}).n]))
  }));
}
const trips = (storage: Storage) => ok(storage.listTrips()).trips.map(t => ({
  tripUuid: t.tripUuid, pluginSessionId: t.pluginSessionId, outcome: t.outcome, closeReason: t.closeReason, recordingCompleteness: t.recordingCompleteness,
  startedUtcMs: t.startedUtcMs, endedUtcMs: t.endedUtcMs, jobConfigurationEventSeq: t.jobConfigurationEventSeq, openedEventSeq: t.openedEventSeq,
  outcomeEventSeq: t.outcomeEventSeq, truckConfigurationEventSeq: t.truckConfigurationEventSeq, trailerConfigurationEventSeqs: t.trailerConfigurationEventSeqs
}));

/**
 * The cold-start seeds a T3 caller (ET-015a) builds from storage: every open trip of the game, the job key of its stored
 * job configuration and the UTC label of its session's last stored event.
 */
function storedSeeds(storage: Storage, game: 'ets2' | 'ats'): TripSeed[] {
  return ok(storage.listTrips()).trips.filter(t => t.outcome === 'open' && t.game === game).map(t => {
    const record = ok(storage.getEvent(t.pluginSessionId, t.jobConfigurationEventSeq))!.record as JobConfiguration;
    const last = ok(storage.listEvents(t.pluginSessionId)).at(-1)!.occurred as {utcUnixMs: {available: boolean; value?: string}};
    return {tripUuid: t.tripUuid, pluginSessionId: t.pluginSessionId, game, jobKey: jobKey(record), startedUtcMs: t.startedUtcMs,
      recordingCompleteness: t.recordingCompleteness, ...(last.utcUnixMs.available ? {lastObservedUtcMs: Number(last.utcUnixMs.value)} : {})};
  });
}

describe('ET-014 reducer effects through real commits', () => {
  it('1. normal delivery: one complete delivered trip with its fine and outcome attributed (REG-001) [O1, O2, O5, O6, O8]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    const {statuses} = drive(storage, [...accepted(s), s.event(r.fined('400')), s.event(r.paused(), paused), s.event(r.delivered(), paused), s.event(r.jobCleared(), paused)]);
    expect(statuses).toEqual(Array(11).fill('committed'));
    expect(trips(storage)).toEqual([{tripUuid: t, pluginSessionId: ETS2_A, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete', startedUtcMs: at(6),
      endedUtcMs: at(10), jobConfigurationEventSeq: '6', openedEventSeq: '6', outcomeEventSeq: '10', truckConfigurationEventSeq: '1', trailerConfigurationEventSeqs: ['2']}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({intervals: [], attributions: [
      {session: ETS2_A, eventSeq: 8, trip: t, attribution: 'trip'}, {session: ETS2_A, eventSeq: 10, trip: t, attribution: 'trip'}]});
  });
  it('2. cancellation after the clear with truck/trailer re-sends (REG-004) [O7]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    drive(storage, [...accepted(s), s.event(r.paused(), paused), s.event(r.jobCleared(), paused), s.event(r.truckConfigured(), paused),
      s.event(r.trailerConfigured(), paused), s.event(r.cancelled('12000'), paused)]);
    expect(trips(storage)).toMatchObject([{tripUuid: t, outcome: 'cancelled', closeReason: 'outcome', recordingCompleteness: 'complete', endedUtcMs: at(12), outcomeEventSeq: '12'}]);
    storage.close();
    expect(rows(ws.database).attributions).toEqual([{session: ETS2_A, eventSeq: 12, trip: t, attribution: 'trip'}]);
  });
  it('7. crash before commit retries with identical effects; after commit, a rebuilt state and the redelivery add nothing (REG-006 domain) [synthetic-inference]', async () => {
    let storage = await ws.open();
    const s = new Script(ETS2_A), t = uuid(ETS2_A, '6'), steps = accepted(s), delivered = s.event(r.delivered(), paused);
    const {state} = drive(storage, steps);
    const input = (): TripInput => ({kind: 'event', message: delivered, coveredThrough: ok(storage.committedThrough(ETS2_A)), receivedUtcMs: RECEIVED_UTC});
    const first = stepTrip(state, input());
    if (!first.ok) throw new Error('unreachable');
    // The transaction fails just before COMMIT: no result, so the caller keeps `state`.
    expect(storage.commitEvent({message: delivered, effects: first.effects}, {testHooks: {beforeCommit: () => { throw new Error('injected before COMMIT'); }}}).ok).toBe(false);
    expect(ok(storage.committedThrough(ETS2_A))).toBe('7');
    const retry = stepTrip(state, input());
    expect(retry).toEqual(first);
    if (!retry.ok) throw new Error('unreachable');
    expect(ok(storage.commitEvent({message: delivered, effects: retry.effects})).status).toBe('committed');
    storage.close();
    const before = rows(ws.database);
    // A process restart after the commit: the state is rebuilt by replaying the committed items through the reducer
    // alone, then the producer redelivers everything, which storage reports as duplicates.
    const rebuilt = run(initialTripState(), [sessionInput(s.welcome()), ...steps.slice(1), delivered]).state;
    expect(rebuilt).toEqual(retry.state);
    storage = await ws.open();
    const redelivered = drive(storage, [sessionInput(s.welcome()), ...steps.slice(1), delivered], rebuilt);
    expect(redelivered.statuses).toEqual(Array(8).fill('duplicate'));
    expect(redelivered.state).toEqual(rebuilt);
    expect(trips(storage)).toMatchObject([{tripUuid: t, outcome: 'delivered', recordingCompleteness: 'complete', endedUtcMs: at(8)}]);
    storage.close();
    expect(rows(ws.database)).toEqual(before);
    expect(before.attributions).toEqual([{session: ETS2_A, eventSeq: 8, trip: t, attribution: 'trip'}]);
  });
  it('8. a gap in an active trip closes it as partial with an event-loss interval; the later delivery is ambiguous (REG-003) [concept-2026-10-13]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6'), first = accepted(s), gap = s.gap(2);
    const {statuses} = drive(storage, [...first, gap, s.event(r.paused(), paused), s.event(r.delivered(), paused)]);
    expect(statuses).toEqual(Array(10).fill('committed'));
    expect(trips(storage)).toMatchObject([{tripUuid: t, outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: at(7), outcomeEventSeq: null}]);
    // Redelivering the gap is a duplicate and adds no interval.
    expect(ok(storage.commitGap({message: gap})).status).toBe('duplicate');
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{session: ETS2_A, eventSeq: 11, trip: null, attribution: 'ambiguous'}],
      intervals: [{kind: 'event-loss', trip: t, first: 8, last: 9, startNs: 1_007_997_000_000, endNs: 1_007_998_000_000, startUtc: null,
        detail: {cause: 'gap', causes: {offline: '0', noDurableConsumer: '0', queueCount: '2', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'}, firstEventSeq: '8', lastEventSeq: '9', redelivered: false}}],
      counts: {event_gaps: 1, completeness_intervals: 1}
    });
  });
  it('10. a plugin restart closes the earlier session\'s trip from the new session; the identical job is not merged (T11) [synthetic-inference]', async () => {
    const storage = await ws.open(), a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000});
    const t = uuid(ETS2_A, '6'), next = uuid(ETS2_B, '1');
    drive(storage, [...accepted(a), a.event(r.fined()), {kind: 'disconnected'}, sessionInput(b.welcome()), b.event(r.jobConfigured(), paused)]);
    expect(trips(storage)).toMatchObject([
      {tripUuid: t, pluginSessionId: ETS2_A, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', startedUtcMs: at(6), endedUtcMs: at(8)},
      {tripUuid: next, pluginSessionId: ETS2_B, outcome: 'open', closeReason: null, recordingCompleteness: 'partial', startedUtcMs: BASE_UTC + 101_000, endedUtcMs: null, jobConfigurationEventSeq: '1'}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{session: ETS2_A, eventSeq: 8, trip: t, attribution: 'trip'}],
      intervals: [{kind: 'discontinuity', trip: next, startNs: null, detail: {cause: 'opened-at-load', atEventSeq: '1'}},
        {kind: 'discontinuity', trip: next, startNs: null, detail: {cause: 'restart', continuationOf: t, decision: 'not-merged', atEventSeq: '1'}}]
    });
  });
  it('11. a save load of the same job continues the trip as partial with a save-load interval (T8) [O9, O10]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    drive(storage, [...accepted(s), s.event(r.fined()), s.event(r.paused(), paused), s.event(r.jobCleared(), paused), s.event(r.truckCleared(), paused),
      s.event(r.trailerCleared(0), paused), s.event(r.jobConfigured(job()), paused), s.event(r.truckConfigured(), paused), s.event(r.trailerConfigured(), paused),
      s.event(r.started()), s.event(r.regression('12345', '12000')), s.event(r.paused(), paused), s.event(r.delivered(), paused)]);
    expect(trips(storage)).toEqual([{tripUuid: t, pluginSessionId: ETS2_A, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'partial', startedUtcMs: at(6),
      endedUtcMs: at(19), jobConfigurationEventSeq: '6', openedEventSeq: '6', outcomeEventSeq: '19', truckConfigurationEventSeq: '1', trailerConfigurationEventSeqs: ['2']}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{eventSeq: 8, trip: t, attribution: 'trip'}, {eventSeq: 19, trip: t, attribution: 'trip'}],
      intervals: [{kind: 'discontinuity', trip: t, first: null, detail: {cause: 'save-load', fromClockId: GAME_CLOCK_1, toClockId: GAME_CLOCK_2, atEventSeq: '17'}}]
    });
  });
  it('20. a UTC label set back is clamped, so the close passes the ended >= started CHECK, and is annotated (T15) [synthetic-inference]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6'), back = BASE_UTC - 3_600_000;
    const {statuses} = drive(storage, [...accepted(s), s.event(r.paused(), {simulation: 'paused', utcMs: back}), s.event(r.delivered(), {simulation: 'paused', utcMs: back + 1_000})]);
    expect(statuses.at(-1)).toBe('committed');
    expect(trips(storage)).toMatchObject([{tripUuid: t, outcome: 'delivered', recordingCompleteness: 'complete', startedUtcMs: at(6), endedUtcMs: at(6)}]);
    // The unclamped label would have violated the schema CHECK and failed the commit.
    failed(storage.commitEvent({message: s.event(r.jobConfigured(), paused), effects: [{kind: 'trip.open', tripUuid: '70000000-0000-4000-8000-000000000001', game: 'ets2',
      gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs: at(20)},
    {kind: 'trip.close', tripUuid: '70000000-0000-4000-8000-000000000001', outcome: 'none', closeReason: 'gap', recordingCompleteness: 'partial', endedUtcMs: at(19)}]}), 'CONSTRAINT_VIOLATION');
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{eventSeq: 9, trip: t, attribution: 'trip'}],
      intervals: [{kind: 'discontinuity', trip: t, detail: {annotation: true, cause: 'utc-label-jump', labelUtcMs: back + 1_000, clampedToUtcMs: at(6), atEventSeq: '9'}}],
      counts: {trips: 1, events: 9}
    });
  });
  it('22. a reconnection marks the open trip partial with a bounded not-connected interval on its own session clock (T13) [synthetic-inference]', async () => {
    const storage = await ws.open(), e = new Script(ETS2_A), a = new Script(ATS_A, 'ats', {utcMs: BASE_UTC + 50_000}), t = uuid(ETS2_A, '6'), atsTrip = uuid(ATS_A, '3');
    const first = accepted(e);
    const {statuses} = drive(storage, [...first, {kind: 'disconnected'}, sessionInput(a.welcome()), a.event(r.started()), a.event(r.paused(), paused),
      a.event(r.jobConfigured(), paused), a.event(r.started()), a.event(r.fined()), {kind: 'disconnected'}, sessionInput(e.welcome()), e.event(r.fined())]);
    expect(statuses).toEqual(Array(13).fill('committed'));
    expect(trips(storage)).toMatchObject([{tripUuid: t, pluginSessionId: ETS2_A, outcome: 'open', recordingCompleteness: 'partial'},
      {tripUuid: atsTrip, pluginSessionId: ATS_A, outcome: 'open', recordingCompleteness: 'unknown', startedUtcMs: BASE_UTC + 53_000}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{session: ATS_A, eventSeq: 5, trip: atsTrip, attribution: 'trip'}, {session: ETS2_A, eventSeq: 8, trip: t, attribution: 'trip'}],
      // From the last ETS2 event before the disconnection (eventSeq 7, 1 ms before its capture) to the reconnection's welcome capture.
      intervals: [{kind: 'not-connected', trip: t, startNs: 1_006_999_000_000, endNs: 1_007_000_000_000, startUtc: at(7), clockSession: ETS2_A, detail: {cause: 'disconnected', odometerDeltaM: null}}]
    });
  });
  it('23. a reload check resolved by a running fine opens from the stored re-send (jobConfiguration {eventSeq}) (T8) [synthetic-inference]', async () => {
    const storage = await ws.open(), s = new Script(ETS2_A), t = uuid(ETS2_A, '6'), next = uuid(ETS2_A, '10');
    drive(storage, [...accepted(s), s.event(r.paused(), paused), s.event(r.jobCleared(), paused), s.event(r.jobConfigured(), paused), s.event(r.started()), s.event(r.fined())]);
    expect(trips(storage)).toEqual([
      {tripUuid: t, pluginSessionId: ETS2_A, outcome: 'none', closeReason: 'configuration-cleared', recordingCompleteness: 'partial', startedUtcMs: at(6), endedUtcMs: at(12),
        jobConfigurationEventSeq: '6', openedEventSeq: '6', outcomeEventSeq: null, truckConfigurationEventSeq: '1', trailerConfigurationEventSeqs: ['2']},
      {tripUuid: next, pluginSessionId: ETS2_A, outcome: 'open', closeReason: null, recordingCompleteness: 'partial', startedUtcMs: at(12), endedUtcMs: null,
        jobConfigurationEventSeq: '10', openedEventSeq: '12', outcomeEventSeq: null, truckConfigurationEventSeq: '1', trailerConfigurationEventSeqs: ['2']}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({attributions: [{eventSeq: 12, trip: null, attribution: 'ambiguous'}],
      intervals: [{kind: 'discontinuity', trip: next, detail: {cause: 'reload', continuationOf: t, decision: 'not-merged', atEventSeq: '12'}}]});
  });
  it('cold start: a stored open trip of an earlier session closes as restart from the new session (T11) [synthetic-inference]', async () => {
    const storage = await ws.open(), a = new Script(ETS2_A), b = new Script(ETS2_B, 'ets2', {utcMs: BASE_UTC + 100_000}), t = uuid(ETS2_A, '6');
    drive(storage, accepted(a));
    // The service restarts: its reducer state is gone, and the caller reads the open trips from storage.
    const seeds = storedSeeds(storage, 'ets2');
    expect(seeds).toEqual([{tripUuid: t, pluginSessionId: ETS2_A, game: 'ets2', jobKey: jobKey(job()), startedUtcMs: at(6), recordingCompleteness: 'unknown', lastObservedUtcMs: at(7)}]);
    const {statuses} = drive(storage, [sessionInput(b.welcome(), '0', seeds), b.event(r.truckConfigured(), paused)]);
    expect(statuses).toEqual(['committed']);
    expect(trips(storage)).toMatchObject([{tripUuid: t, pluginSessionId: ETS2_A, outcome: 'none', closeReason: 'restart', recordingCompleteness: 'partial', endedUtcMs: at(7)}]);
  });
  it('cold start: a stored open trip of the same session resumes as partial with a consumer-restart interval (T13) [synthetic-inference]', async () => {
    const storage = await ws.open(), a = new Script(ETS2_A), t = uuid(ETS2_A, '6');
    drive(storage, accepted(a));
    const {statuses} = drive(storage, [sessionInput(a.welcome(), '0', storedSeeds(storage, 'ets2')), a.event(r.fined()), a.event(r.paused(), paused), a.event(r.delivered(), paused)]);
    expect(statuses).toEqual(['committed', 'committed', 'committed']);
    expect(trips(storage)).toMatchObject([{tripUuid: t, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'partial', endedUtcMs: at(10), outcomeEventSeq: '10'}]);
    storage.close();
    expect(rows(ws.database)).toMatchObject({
      attributions: [{eventSeq: 8, trip: t, attribution: 'trip'}, {eventSeq: 10, trip: t, attribution: 'trip'}],
      intervals: [{kind: 'not-connected', trip: t, startNs: null, clockSession: null, detail: {cause: 'consumer-restart'}}]
    });
  });
});
