// Storage size measurement (ET-013 PR-2, partial REG-018): 100 hours of 1 Hz history samples (360,000 rows) with
// representative sessions, trips and gameplay events, written through the real storage core with its verified
// durability settings into a temporary database. Prints database, WAL, table and index sizes, the per-100-hour
// projection and command timings, including the ET-016 journal reads (recorded only, never asserted). Run with
// `npm run measure:storage`; it is not part of a check suite.
import {existsSync, statSync, writeFileSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {afterAll, beforeAll, expect, it} from 'vitest';
import type {ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {openStorage, type SampleInput, type Storage, type TripEffect} from '../../packages/storage/src/index';
import {ok, readOnly, v1, withEventSeq, workspace} from '../storage/helpers';

const SESSIONS = 50, SAMPLES_PER_SESSION = 7_200, TRIPS_PER_SESSION = 2, SAMPLES_PER_TRIP = 3_300, BATCH = 60;
const SOURCE_CLOCK = '30000000-0000-4000-8000-000000000001', GAME_CLOCK = '40000000-0000-4000-8000-000000000001';
const START_UTC = 1_791_676_800_000;

let ws: Awaited<ReturnType<typeof workspace>>;
beforeAll(async () => { ws = await workspace(); });
afterAll(async () => { await ws.dispose(); });

const uuid = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;
function forSession<T extends ServerMessage>(message: T, session: string): T {
  return {...message, source: {...message.source, pluginSessionId: session}};
}
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };
const p95 = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]; };
const round = (value: number, digits = 3) => Number(value.toFixed(digits));
function timed<T>(samples: number[], body: () => T): T { const start = performance.now(); const value = body(); samples.push(performance.now() - start); return value; }

/** A plausible driving reading: float32 values like the SDK's, all available. */
function sample(session: number, index: number, tripUuid: string | null): SampleInput {
  const t = session * SAMPLES_PER_SESSION + index, phase = t / 37;
  const f = Math.fround;
  return {
    tripUuid, utcMs: START_UTC + t * 1000, sourceClockId: SOURCE_CLOCK, monotonicNs: String(1_000_000_000_000n + BigInt(index) * 1_000_000_000n),
    gameTime: {minutes: {available: true, value: 12_345 + Math.floor(index * 0.32)}, clockId: GAME_CLOCK},
    speed: {available: true, value: f(Math.max(0, 22 + 6 * Math.sin(phase)))}, fuel: {available: true, value: f(900 - (index % 3_600) * 0.0103)},
    averageConsumption: {available: true, value: f(31.5 + Math.sin(phase / 9))}, estimatedRange: {available: true, value: f(2_500_000 - index * 7.3)},
    engineRpm: {available: true, value: f(1_250 + 220 * Math.cos(phase))}, gear: {available: true, value: 8 + (index % 5)},
    odometer: {available: true, value: f(254_000_000 + t * 22.7)},
    position: {available: true, value: {x: f(-31_234.5 + t * 0.0217), y: f(42.25 + Math.sin(phase) * 3), z: f(18_800.75 - t * 0.0193)}}
  };
}

interface Timings {eventCommit: number[]; sampleBatch: number[]; singleSample: number[]}
/** One plugin session: a truck, two trips with their gameplay events and a lost eventSeq, free driving, 7,200 samples. */
function writeSession(storage: Storage, session: number, timings: Timings, walPeak: {bytes: number}): {events: number; gaps: number; trips: number} {
  const id = uuid('10000000', session + 1);
  ok(storage.upsertSession({message: forSession(v1('welcome'), id)}));
  let seq = 0n, events = 0, gaps = 0;
  const commit = (name: string, effects: TripEffect[] = []) => {
    seq++; events++;
    const result = timed(timings.eventCommit, () => storage.commitEvent({message: forSession(withEventSeq(name, seq), id), effects}));
    expect(ok(result).status).toBe('committed');
    return seq;
  };
  const free: TripEffect = {kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'};
  const truck = commit('event-truck-configured', [free]);
  commit('event-simulation-started', [free]);
  let written = 0;
  const samples = (count: number, tripUuid: string | null) => {
    for (let done = 0; done < count; done += BATCH) {
      const rows = Array.from({length: Math.min(BATCH, count - done)}, (_, offset) => sample(session, written + done + offset, tripUuid));
      timed(timings.sampleBatch, () => ok(storage.appendSamples(id, rows)));
      if (existsSync(ws.database + '-wal')) walPeak.bytes = Math.max(walPeak.bytes, statSync(ws.database + '-wal').size);
    }
    written += count;
  };
  for (let trip = 0; trip < TRIPS_PER_SESSION; trip++) {
    const tripUuid = uuid('70000000', session * TRIPS_PER_SESSION + trip + 1), inTrip: TripEffect = {kind: 'event.attribute', tripUuid, attribution: 'trip'};
    const trailer = commit('event-trailer-configured', [free]);
    commit('event-job-configured', [{kind: 'trip.open', tripUuid, game: 'ets2', gameMode: {mode: 'single-player', method: 'module-scan', confidence: 'weak'},
      jobConfiguration: 'this-event', truckConfiguration: {eventSeq: String(truck)}, trailerConfigurations: [{eventSeq: String(trailer)}],
      recordingCompleteness: 'complete', startedUtcMs: START_UTC + session * 7_200_000 + trip * 3_600_000}, inTrip]);
    const legs = ['event-player-tollgate-paid', 'event-simulation-paused', 'event-simulation-started', 'event-player-fined', 'event-player-use-ferry'];
    const perLeg = Math.floor(SAMPLES_PER_TRIP / (legs.length + 1));
    for (const name of legs) { samples(perLeg, tripUuid); commit(name, [inTrip]); }
    samples(SAMPLES_PER_TRIP - perLeg * legs.length, tripUuid);
    if (trip === 0) {
      // One lost eventSeq per session, recorded as a gap with its completeness interval.
      seq++; gaps++;
      expect(ok(storage.commitGap({message: forSession(withEventSeq('gap', seq), id), effects: [
        {kind: 'completeness.add', interval: {tripUuid, kind: 'event-loss', firstEventSeq: String(seq), lastEventSeq: String(seq)}},
        {kind: 'trip.update', tripUuid, set: {recordingCompleteness: 'partial'}}]})).status).toBe('committed');
    }
    commit('event-job-delivered', [inTrip, {kind: 'trip.update', tripUuid, set: {observedDistanceM: {available: true, value: 152_000 + trip}}},
      {kind: 'trip.close', tripUuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: trip === 0 ? 'partial' : 'complete',
        endedUtcMs: START_UTC + session * 7_200_000 + trip * 3_600_000 + 3_300_000}]);
  }
  samples(SAMPLES_PER_SESSION - written, null);
  commit('event-simulation-paused', [free]);
  return {events, gaps, trips: TRIPS_PER_SESSION};
}

it('measures 100 hours of 1 Hz history: database, WAL, indexes and command timings', async () => {
  const storage = ok(await openStorage(ws.options()));
  const timings: Timings = {eventCommit: [], sampleBatch: [], singleSample: []}, walPeak = {bytes: 0}, totals = {events: 0, gaps: 0, trips: 0};
  const started = performance.now();
  for (let session = 0; session < SESSIONS; session++) {
    const written = writeSession(storage, session, timings, walPeak);
    totals.events += written.events; totals.gaps += written.gaps; totals.trips += written.trips;
  }
  const loadSeconds = (performance.now() - started) / 1000;
  // One-row transactions, the worst case of a 1 Hz writer, on top of the full database (300 extra samples).
  const extra = uuid('10000000', SESSIONS + 1);
  ok(storage.upsertSession({message: forSession(v1('welcome'), extra)}));
  for (let index = 0; index < 300; index++) timed(timings.singleSample, () => ok(storage.appendSamples(extra, [sample(SESSIONS, index, null)])));
  storage.close();

  const reopened = ok(await openStorage(ws.options()));
  // ET-016 PR-2: the journal reads are recorded beside them, never asserted (J20).
  const queries: Record<string, number[]> = {listTrips: [], getTrip: [], listTripSamples: [], listEvents: [], committedThrough: [], storageInfo: [],
    journalTrips: [], journalTrip: [], journalEvents: [], journalIntervals: [], journalTripSamples300: []};
  const lastTrip = uuid('70000000', SESSIONS * TRIPS_PER_SESSION), lastSession = uuid('10000000', SESSIONS);
  for (let run = 0; run < 20; run++) {
    timed(queries.listTrips, () => ok(reopened.listTrips({limit: 100})));
    timed(queries.getTrip, () => ok(reopened.getTrip(lastTrip)));
    const tripSamples = timed(queries.listTripSamples, () => ok(reopened.listSamples({tripUuid: lastTrip}, {limit: 3_600})));
    expect(tripSamples).toHaveLength(SAMPLES_PER_TRIP);
    timed(queries.listEvents, () => ok(reopened.listEvents(lastSession, {limit: 500})));
    timed(queries.committedThrough, () => ok(reopened.committedThrough(lastSession)));
    timed(queries.storageInfo, () => ok(reopened.storageInfo()));
    timed(queries.journalTrips, () => ok(reopened.journalTrips()));
    timed(queries.journalTrip, () => ok(reopened.journalTrip(lastTrip)));
    timed(queries.journalEvents, () => ok(reopened.journalEvents(lastTrip, {limit: 100})));
    timed(queries.journalIntervals, () => ok(reopened.journalIntervals(lastTrip, {limit: 100})));
    timed(queries.journalTripSamples300, () => ok(reopened.listSamples({tripUuid: lastTrip}, {limit: 300})));
  }
  const info = ok(reopened.storageInfo());
  reopened.close();

  const database = statSync(ws.database).size;
  const objects = readOnly(ws.database, db => ({
    integrity: db.pragma('integrity_check', {simple: true}),
    samples: db.prepare('SELECT count(*) FROM samples').pluck().get(),
    sizes: db.prepare(`SELECT d.name AS name, s.type AS type, s.tbl_name AS tableName, SUM(d.pgsize) AS bytes FROM dbstat d
      LEFT JOIN sqlite_schema s ON s.name = d.name GROUP BY d.name ORDER BY bytes DESC`).all() as {name: string; type: string | null; tableName: string | null; bytes: number | bigint}[]
  }));
  expect(objects.integrity).toBe('ok');
  expect(Number(objects.samples)).toBe(SESSIONS * SAMPLES_PER_SESSION + 300);
  const sizes = objects.sizes.map(row => ({...row, bytes: Number(row.bytes)}));
  const samplesBytes = sizes.filter(row => row.tableName === 'samples').reduce((sum, row) => sum + row.bytes, 0);
  const historyHours = SESSIONS * SAMPLES_PER_SESSION / 3_600;
  const report = {
    runtime: {electron: process.versions.electron, node: process.versions.node, sqlite: 'better-sqlite3 13.0.3', platform: `${process.platform} ${process.arch}`},
    workload: {sessions: SESSIONS, samples: SESSIONS * SAMPLES_PER_SESSION, extraSingleRowSamples: 300, historyHours, trips: totals.trips, events: totals.events, gaps: totals.gaps, sampleBatch: BATCH},
    database: {bytes: database, pageSize: info.pageSize, pageCount: info.pageCount, freelistCount: info.freelistCount, walPeakBytes: walPeak.bytes},
    projection: {mbPer100Hours: round(database / 1e6 * (100 / historyHours), 1), samplesBytesPerSample: round(samplesBytes / (SESSIONS * SAMPLES_PER_SESSION + 300), 1)},
    objects: sizes,
    timingsMs: {
      loadSeconds: round(loadSeconds, 1),
      eventCommit: {median: round(median(timings.eventCommit)), p95: round(p95(timings.eventCommit)), count: timings.eventCommit.length},
      sampleBatch60: {median: round(median(timings.sampleBatch)), p95: round(p95(timings.sampleBatch)), count: timings.sampleBatch.length},
      singleSampleCommit: {median: round(median(timings.singleSample)), p95: round(p95(timings.singleSample)), count: timings.singleSample.length},
      ...Object.fromEntries(Object.entries(queries).map(([name, values]) => [name, {median: round(median(values)), p95: round(p95(values))}]))
    }
  };
  // Vitest may hold back console output of a passing test; standard error reaches the terminal directly.
  process.stderr.write(`STORAGE_MEASUREMENT ${JSON.stringify(report)}\n`);
  // Optional copy for the record, outside the checkout.
  if (process.env.ETS2TELEMETRY_MEASURE_REPORT) writeFileSync(process.env.ETS2TELEMETRY_MEASURE_REPORT, JSON.stringify(report, null, 2) + '\n');
});
