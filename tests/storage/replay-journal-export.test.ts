// ET-019 PR-5 (REG-003, REG-004, REG-005, REG-008, REG-014): lifecycle scenarios replayed through the real pipeline (the
// reactive v1 simulator on actual Windows pipes, V1Ingestion, the trip recorder and the real storage worker into a
// temporary synthetic-purpose database), then read back the way the dashboard and main read them: the journal through
// JournalService with main's reply check (journal-contract.ts, parseJournalReply), and the format version 1 export through
// main's JournalExporter, which the shared hand-written validator checks.
//
// Six scenarios come from the ET-005b corpus (save-load, quick-job-profile-change, timers-truck-refuel, ferry-train,
// app-absent-hydration, retention-expired) and reuse their hand-written tests/fixtures/simulator-v1/<id>.trip.expected.json
// rows. Four are derived in this file from a corpus scenario's header and seed, because the corpus has no trip for them:
// - cancellation-trips: a cargo-market job cancelled before pickup, then a job cancelled after its clear;
// - ferry-train-trip: a delivered trip with a ferry, a train and a toll, beside an open one;
// - timers-truck-refuel-trip: a trip with a truck change, fuel use and a refuel, closed by a timer restart;
// - missing-job-configuration: a delivery whose configuration was never observed, then a job whose configuration is
//   cleared without an outcome and an identical job after a timer restart, which must stay a separate, not-merged trip
//   (REG-004).
// Their rows are hand-written in tests/fixtures/recording/<id>.rows.expected.json.
//
// What only the journal and export show (event types, job summaries, close carriers, windows, outcome records, money
// totals and samples) is hand-written in tests/fixtures/recording/replay-journal-export.expected.json, from docs/journal.md,
// docs/journal-export.md, docs/storage.md and docs/trips.md, never read back from the code under test (TESTING.md §4).
// Every case also checks I1-I5 (scripts/ci/history-invariants.mjs) over the stored rows and every ACK written, and that no
// game history exists. Waits are the run's own completion; the only real-time values are named hang guards.
import {existsSync, mkdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {JournalCallResult} from '../../packages/contracts/src';
import {StorageClient} from '../../packages/storage/src/client';
import {parseJournalReply, refusal, type JournalQuery} from '../../apps/desktop/src/journal-contract';
import {JournalExporter} from '../../apps/desktop/src/journal-export-writer';
import {JournalService, type JournalHistory} from '../../apps/desktop/src/journal-service';
import {GAME_HISTORY_RECORDING} from '../../apps/desktop/src/recording-policy';
import {checkHistoryInvariants, formatViolations, type HistoryAck} from '../../scripts/ci/history-invariants.mjs';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveDifferences} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {tripExportProblems} from '../shared/trip-export-validator';
import {ok, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {readHistoryRows} from './history-rows';
import {
  guarded, labels, RECORDING_FIXTURES, recordingExpected, replayOf, runRecording, storageWorker, storedRows, terminateWorkers, tripExpected, type RowsExpected
} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

/** Hang guard of one awaited step (a journal read, an export); far below the case timeout. */
const HANG_GUARD_MS = 30_000;
/**
 * Case timeout: one recording run of at most 13 items, a journal worker, about 30 journal reads and up to two exports. A
 * case takes about a second unloaded; this bounds a hang, never measures a duration.
 */
const CASE_MS = 90_000;

// Source steps of the derived scenarios, in the simulator's scenario format (docs/simulator-v1.md).
const connect = (atMs: number) => ({atMs, action: 'connect', client: {durable: true}});
const disconnect = (atMs: number) => ({atMs, action: 'disconnect'});
const lifecycle = (atMs: number, event: 'simulation.started' | 'simulation.paused') => ({atMs, action: 'lifecycle', event});
const attribute = (name: string, sdkType: string, value: unknown) => ({name, sdkType, value});
const configuration = (atMs: number, id: 'job' | 'truck', attributes: Json[]) => ({atMs, action: 'configuration', id, attributes});
const gameplay = (atMs: number, id: string, attributes: Json[]) => ({atMs, action: 'gameplay', id, attributes});
const frame = (atMs: number, channels: Json, timerRestart = false) => ({atMs, action: 'frame', ...(timerRestart ? {timerRestart} : {}), channels});
const toll = (atMs: number, amount: string) => gameplay(atMs, 'player.tollgate.paid', [attribute('pay.amount', 's64', amount)]);
const cancelled = (atMs: number, penalty: string) => gameplay(atMs, 'job.cancelled', [attribute('cancel.penalty', 's64', penalty)]);
const delivered = (atMs: number, revenue: string, km: number) => gameplay(atMs, 'job.delivered', [attribute('revenue', 's64', revenue), attribute('earned.xp', 's32', 300),
  attribute('cargo.damage', 'float', 0.0625), attribute('distance.km', 'float', km), attribute('delivery.time', 'u32', 240), attribute('auto.park.used', 'bool', false),
  attribute('auto.load.used', 'bool', false)]);
const transfer = (atMs: number, id: 'player.use.ferry' | 'player.use.train', amount: string, from: string, to: string) => gameplay(atMs, id, [attribute('pay.amount', 's64', amount),
  attribute('source.id', 'string', `synthetic_${from}`), attribute('source.name', 'string', `Synthetic ${from}`), attribute('target.id', 'string', `synthetic_${to}`),
  attribute('target.name', 'string', `Synthetic ${to}`)]);
const job = (cargo: string, destination: string, km: number, income?: string, extra: Json[] = []) => [attribute('cargo.id', 'string', cargo),
  attribute('destination.city.id', 'string', destination), attribute('planned_distance.km', 'u32', km), ...(income === undefined ? [] : [attribute('income', 'u64', income)]), ...extra];
const truck = (model: string, capacity?: number) => [attribute('id', 'string', model), ...(capacity === undefined ? [] : [attribute('fuel.capacity', 'float', capacity)])];

interface Scenario {id: string; input: Json & {seed: string}; rows: RowsExpected}
const corpus = (id: string): Scenario => ({id, input: readFixtureFile(scenarioPath(id)) as Json & {seed: string}, rows: tripExpected(id)});
/** A corpus scenario's header and seed with this file's steps and transport, and its hand-written rows. */
function derived(from: string, id: string, purpose: string, reg: string[], steps: Json[], transport: Json[]): Scenario {
  const input = structuredClone(readFixtureFile(scenarioPath(from))) as Json & {seed: string};
  return {id, input: {...input, id, purpose, reg, steps, transport}, rows: recordingExpected(id)};
}

const SCENARIOS: Scenario[] = [
  corpus('save-load'), corpus('quick-job-profile-change'), corpus('timers-truck-refuel'), corpus('ferry-train'), corpus('app-absent-hydration'), corpus('retention-expired'),
  derived('normal-delivery', 'cancellation-trips',
    'A cargo-market job cancelled before pickup with a fine before loading, then a freight job cleared and cancelled after a toll and an identical truck re-send (O7).',
    ['REG-004'], [
      lifecycle(10, 'simulation.started'),
      configuration(20, 'job', job('synthetic_cargo_m', 'synthetic_city_c', 80, '4000', [attribute('job.market', 'string', 'cargo_market'), attribute('cargo.loaded', 'bool', false)])),
      gameplay(30, 'player.fined', [attribute('fine.offence', 'string', 'speeding'), attribute('fine.amount', 's64', '150')]), cancelled(40, '2500'), configuration(50, 'job', []),
      configuration(60, 'truck', truck('vehicle.synthetic_truck')),
      configuration(70, 'job', job('synthetic_cargo', 'synthetic_city_b', 152, '12345', [attribute('source.city.id', 'string', 'synthetic_city_a')])),
      toll(80, '5'), configuration(90, 'job', []), toll(100, '7'), configuration(110, 'truck', truck('vehicle.synthetic_truck')), cancelled(120, '1000'), configuration(130, 'job', [])
    ], [connect(0), disconnect(300)]),
  derived('ferry-train', 'ferry-train-trip',
    'A job configured while running with a ferry, a game-time jump, a train and a toll, delivered; then a second job left open.',
    ['REG-008', 'REG-014'], [
      lifecycle(10, 'simulation.started'), configuration(20, 'job', job('synthetic_cargo', 'synthetic_city_b', 400, '20000', [attribute('source.city.id', 'string', 'synthetic_port_a')])),
      frame(100, {'game.time': 1000}), transfer(150, 'player.use.ferry', '230', 'port_a', 'port_b'), frame(200, {'game.time': 1400}),
      transfer(250, 'player.use.train', '120', 'station_a', 'station_b'), toll(300, '15'), delivered(350, '21000', 400.5), configuration(360, 'job', []),
      configuration(400, 'job', job('synthetic_cargo_b', 'synthetic_city_c', 90, '5000'))
    ], [connect(0), disconnect(600)]),
  derived('timers-truck-refuel', 'timers-truck-refuel-trip',
    'A job with a road stop, fuel use, a truck change and a refuel, closed by a timer restart.',
    ['REG-008', 'REG-009'], [
      lifecycle(10, 'simulation.started'), configuration(20, 'truck', truck('vehicle.synthetic_a', 400)), configuration(30, 'job', job('synthetic_cargo', 'synthetic_city_b', 200)),
      frame(100, {'fuel.amount': 100, odometer: 5000}), frame(200, {'fuel.amount': 90, odometer: 5000}), configuration(250, 'truck', truck('vehicle.synthetic_b', 600)),
      frame(300, {'fuel.amount': 50, odometer: 5000}), frame(400, {'fuel.amount': 550, odometer: 5000}), toll(450, '5'), frame(500, {}, true)
    ], [connect(0), disconnect(700)]),
  derived('units-currency', 'missing-job-configuration',
    'A delivery whose job configuration was never observed; a job whose configuration is cleared without an outcome before a timer restart; the identical job again, delivered.',
    ['REG-004', 'REG-008'], [
      lifecycle(10, 'simulation.started'), delivered(20, '9000', 120.25),
      configuration(30, 'job', job('synthetic_cargo', 'synthetic_city_b', 120, '8000', [attribute('source.city.id', 'string', 'synthetic_city_a')])), toll(40, '9'),
      lifecycle(50, 'simulation.paused'), configuration(60, 'job', []), frame(70, {}, true),
      configuration(80, 'job', job('synthetic_cargo', 'synthetic_city_b', 120, '8000', [attribute('source.city.id', 'string', 'synthetic_city_a')])),
      lifecycle(90, 'simulation.started'), toll(100, '11'), delivered(110, '8500', 120.5), configuration(120, 'job', [])
    ], [connect(0), disconnect(300)])
];

/** The hand-written journal and export expectations of every scenario. */
interface TripJournal {
  trip: string; job: Json; closedBy: string | null; window: {fromEventSeq: string; throughEventSeq: string | null; end: string};
  outcome: null | {eventSeq: string; type: 'job.delivered'; revenue: string; distanceM: number; currency: string} | {eventSeq: string; type: 'job.cancelled'; penalty: string; currency: string};
  money: {category: string; sdkType: string; currency: string; raw: string; count: number}[];
  samples: {utcMs: number; monotonicNs: string; values: Json}[];
}
interface JournalExpected {currencies: Record<string, Json>; scenarios: Record<string, {events: Record<string, string>; trips: TripJournal[]}>}
const JOURNAL = JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'replay-journal-export.expected.json'), 'utf8')) as JournalExpected;
/** A money value of the fixture, with its currency named by a key of `currencies`. */
const currency = (name: string) => JOURNAL.currencies[name];
const expandMoney = (value: Json): Json => JSON.parse(JSON.stringify(value), (key, v: unknown) => key === 'currency' && typeof v === 'string' ? currency(v) : v) as Json;

/** No game history: the gate is off and the workspace (a temporary LOCALAPPDATA) holds no history database. */
function expectNoGameHistory() {
  expect(GAME_HISTORY_RECORDING).toBe(false);
  expect(existsSync(path.join(ws.directory, 'ETS2Telemetry', 'data', 'telemetry.sqlite'))).toBe(false);
}
/** Replaces seeded identifiers (plugin session, clocks, trip UUIDs) by their labels, as storedRows does. */
function relabel<T>(value: T, seed: string): T {
  const map = labels(seed);
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) => typeof v === 'string' && map.has(v) ? map.get(v) : v) as T;
}
/** The UUID of a trip label (`trip@3`, `attach@4`). */
function uuidOf(label: string, seed: string): string {
  for (const [uuid, name] of labels(seed)) if (name === label) return uuid;
  throw new Error(`Harness: no UUID for ${label}`);
}

type StoredTrip = {trip: string; jobConfigurationEventSeq: string | null; truckConfigurationEventSeq: string | null; trailerConfigurationEventSeqs: string[];
  openedEventSeq: string | null; gameMode: Json; gameModeAmbiguous: boolean; outcome: string; outcomeEventSeq: string | null; closeReason: string | null;
  recordingCompleteness: string; startedUtcMs: number; endedUtcMs: number | null; observedDistanceM: Json; fuelUsedL: Json};
type StoredInterval = {trip: string | null; kind: string; detail?: Json} & Record<string, unknown>;
/** Everything one trip's journal and export reads must show, from the hand-written rows and the journal fixture. */
interface TripExpectation {
  label: string; listItem: Json; detailTrip: Json; job: Json; truck: string | null; trailers: {eventSeqs: string[]; total: number};
  outcome: Json | null; money: Json[]; window: Json; intervals: Json[]; events: [string, string, Json | null][]; samples: TripJournal['samples'];
}
function expectationsOf(s: Scenario): TripExpectation[] {
  const journal = JOURNAL.scenarios[s.id], game = s.input.game as string, coverage = s.rows.coverage.committedThroughEventSeq;
  const stored = new Map((s.rows.trips as StoredTrip[]).map(t => [t.trip, t]));
  const attributions = new Map((s.rows.attributions as {eventSeq: string; trip: string | null; attribution: string}[]).map(a => [a.eventSeq, {kind: a.attribution, tripUuid: a.trip}]));
  expect(journal.trips.map(t => t.trip).sort(), `${s.id}: the journal fixture names every stored trip`).toEqual([...stored.keys()].sort());
  return journal.trips.map(t => {
    const row = stored.get(t.trip)!;
    const listItem = {isHardMode: false, hardModeDetails: null, tripUuid: t.trip, game, gameMode: row.gameMode, gameModeAmbiguous: row.gameModeAmbiguous, outcome: row.outcome, closeReason: row.closeReason,
      recordingCompleteness: row.recordingCompleteness, startedUtcMs: row.startedUtcMs, endedUtcMs: row.endedUtcMs, observedDistanceM: row.observedDistanceM, fuelUsedL: row.fuelUsedL,
      job: expandMoney(t.job)};
    // A trip opened at an event has its job at its job configuration event; a late-attach trip (attach@<nextEventSeq>) has the checkpoint's job (J9).
    const checkpoint = row.openedEventSeq === null ? t.trip.replace(/^attach@/, '') : null;
    const intervals = (s.rows.intervals as StoredInterval[]).filter(i => i.trip === t.trip).map(i => ({kind: i.kind, annotation: i.detail?.annotation === true,
      cause: i.detail?.cause ?? null, startUtcMs: i.startUtcMs ?? null, endUtcMs: i.endUtcMs ?? null, startMonotonicNs: i.startMonotonicNs ?? null, endMonotonicNs: i.endMonotonicNs ?? null,
      sourceClockId: i.sourceClockId ?? null, firstEventSeq: i.firstEventSeq ?? null, lastEventSeq: i.lastEventSeq ?? null, detail: i.detail ?? null}));
    const through = BigInt(t.window.throughEventSeq ?? coverage);
    const events = Object.entries(journal.events).filter(([seq]) => BigInt(seq) >= BigInt(t.window.fromEventSeq) && BigInt(seq) <= through)
      .sort(([a], [b]) => Number(BigInt(a) - BigInt(b))).map(([seq, type]): [string, string, Json | null] => [seq, type, attributions.get(seq) ?? null]);
    const o = t.outcome;
    const outcome = o === null ? null : {eventSeq: o.eventSeq, record: o.type === 'job.cancelled'
      ? {type: 'job.cancelled', penalty: {available: true, value: {raw: o.penalty, sdkType: 's64', currency: currency(o.currency)}}}
      : {type: 'job.delivered', revenue: {available: true, value: {raw: o.revenue, sdkType: 's64', currency: currency(o.currency)}}, distance: {available: true, value: o.distanceM, unit: 'm'}}};
    return {
      label: t.trip, listItem,
      detailTrip: {...listItem, pluginSessionId: 'plugin-session', openedBy: checkpoint === null ? 'event' : 'checkpoint', openedEventSeq: row.openedEventSeq,
        outcomeEventSeq: row.outcomeEventSeq, closedBy: t.closedBy === null ? null : {pluginSessionId: 'plugin-session', eventSeq: t.closedBy}},
      job: {source: checkpoint === null ? 'event' : 'checkpoint', eventSeq: checkpoint === null ? row.jobConfigurationEventSeq : null, checkpointNextEventSeq: checkpoint},
      truck: row.truckConfigurationEventSeq, trailers: {eventSeqs: row.trailerConfigurationEventSeqs, total: row.trailerConfigurationEventSeqs.length},
      outcome, money: t.money.map(m => expandMoney(m)), window: {known: true, pluginSessionId: 'plugin-session', ...t.window}, intervals, events, samples: t.samples
    };
  });
}

/** A journal read that main would forward unchanged (journal-contract.ts, parseJournalReply). */
async function read(journal: JournalService, query: JournalQuery): Promise<JournalCallResult<unknown>> {
  const result = await guarded(journal.query(query), `the journal ${query.kind} read`, HANG_GUARD_MS);
  expect(parseJournalReply(query, result), query.kind).toEqual(result);
  return result;
}
async function value<T>(journal: JournalService, query: JournalQuery): Promise<T> {
  const result = await read(journal, query);
  if (!result.ok) throw new Error(`The journal ${query.kind} read failed with ${result.code}`);
  return result.value as T;
}
const SYNTHETIC_V3 = {purpose: 'synthetic', schemaVersion: 3};
const OUTCOMES = ['open', 'delivered', 'cancelled', 'none'] as const, COMPLETENESS = ['complete', 'partial', 'unknown'] as const, GAMES = ['ets2', 'ats'] as const;
const withoutId = <T extends {id: string}>(rows: T[]) => rows.map(({id, ...rest}) => { void id; return rest; });
const eventTuple = (e: {eventSeq: string; type: string; attribution: Json | null}) => [e.eventSeq, e.type, e.attribution];
const sortMoney = (totals: Json[]) => [...totals].sort((a, b) => String(a.category).localeCompare(String(b.category)));

/** The list, every filter, and each trip's detail, intervals, timeline and samples, as the Journal tab reads them (J5, J7). */
async function expectJournal(journal: JournalService, s: Scenario, trips: TripExpectation[]) {
  const seed = s.input.seed, coverage = s.rows.coverage.committedThroughEventSeq;
  const page = await value<{database: unknown; trips: Json[]; nextCursor: string | null}>(journal, {kind: 'trips', query: {}});
  expect(relabel(page, seed)).toEqual({database: SYNTHETIC_V3, trips: trips.map(t => t.listItem), nextCursor: null});
  // Every filter, from the hand-written outcome, completeness and game of each trip (the list order is newest first).
  for (const [key, values] of [['outcome', OUTCOMES], ['completeness', COMPLETENESS], ['game', GAMES]] as const) {
    for (const v of values) {
      const filtered = await value<{trips: {tripUuid: string}[]}>(journal, {kind: 'trips', query: {[key]: v}});
      const field = key === 'completeness' ? 'recordingCompleteness' : key;
      expect(relabel(filtered.trips.map(t => t.tripUuid), seed), `${key} ${v}`).toEqual(trips.filter(t => t.listItem[field] === v).map(t => t.label));
    }
  }
  for (const t of trips) {
    const tripUuid = uuidOf(t.label, seed);
    const detail = relabel(await value<Json & {trip: Json; job: Json; truck: {eventSeq: string} | null; trailers: {items: {eventSeq: string}[]; total: number};
      outcomeDetails: {eventSeq: string; record: Json} | null; money: {incomplete: boolean; totals: Json[]; unavailable: unknown[]}; window: Json;
      intervals: {items: (Json & {id: string})[]; total: number; nextCursor: string | null}; samples: Json; exportBounds: Json}>(journal, {kind: 'trip', tripUuid}), seed);
    expect(detail.database, t.label).toEqual(SYNTHETIC_V3);
    expect(detail.trip, t.label).toEqual(t.detailTrip);
    expect({source: detail.job.source, eventSeq: detail.job.eventSeq, checkpointNextEventSeq: detail.job.checkpointNextEventSeq}, t.label).toEqual(t.job);
    expect([detail.truck?.eventSeq ?? null, {eventSeqs: detail.trailers.items.map(i => i.eventSeq), total: detail.trailers.total}], t.label).toEqual([t.truck, t.trailers]);
    if (t.outcome === null) expect(detail.outcomeDetails, t.label).toBeNull();
    else expect(detail.outcomeDetails, t.label).toMatchObject(t.outcome);
    expect({incomplete: detail.money.incomplete, totals: sortMoney(detail.money.totals), unavailable: detail.money.unavailable}, t.label)
      .toEqual({incomplete: false, totals: sortMoney(t.money), unavailable: []});
    expect(detail.window, t.label).toEqual(t.window);
    expect({items: withoutId(detail.intervals.items), total: detail.intervals.total, nextCursor: detail.intervals.nextCursor}, t.label)
      .toEqual({items: t.intervals, total: t.intervals.length, nextCursor: null});
    expect(detail.samples, t.label).toEqual({count: t.samples.length, firstUtcMs: t.samples[0]?.utcMs ?? null, lastUtcMs: t.samples.at(-1)?.utcMs ?? null});
    expect(detail.exportBounds, t.label).toMatchObject({committedThroughEventSeq: coverage});
    expect([detail.exportBounds.lastSampleId === null, detail.exportBounds.lastIntervalId === null], t.label).toEqual([t.samples.length === 0, t.intervals.length === 0]);

    const intervals = relabel(await value<{intervals: (Json & {id: string})[]; total: number; nextCursor: string | null}>(journal, {kind: 'intervals', tripUuid, page: {limit: 100}}), seed);
    expect({intervals: withoutId(intervals.intervals), total: intervals.total, nextCursor: intervals.nextCursor}, t.label).toEqual({intervals: t.intervals, total: t.intervals.length, nextCursor: null});
    const timeline = relabel(await value<{window: Json; events: {eventSeq: string; type: string; attribution: Json | null}[]; nextCursor: string | null}>(journal,
      {kind: 'events', tripUuid, page: {limit: 100}}), seed);
    expect({window: timeline.window, events: timeline.events.map(eventTuple), nextCursor: timeline.nextCursor}, t.label).toEqual({window: t.window, events: t.events, nextCursor: null});
    const samples = relabel(await value<{samples: Json[]; nextCursor: string | null}>(journal, {kind: 'samples', tripUuid, page: {limit: 300}}), seed);
    expect(samples.samples, t.label).toHaveLength(t.samples.length);
    expect(samples.samples, t.label).toMatchObject(t.samples.map(x => ({tripUuid: t.label, utcMs: x.utcMs, monotonicNs: x.monotonicNs, sourceClockId: 'capture-clock', ...x.values})));
    expect(samples.nextCursor, t.label).toBeNull();
  }
}

interface ExportDocument {
  header: {database: {purpose: string; schemaVersion: number}; sessionOrigin: string};
  bounds: {committedThroughEventSeq: string; lastSampleId: string | null; lastIntervalId: string | null; snapshot: boolean};
  trip: Json; job: Json; truck: {eventSeq: string} | null; trailers: {items: {eventSeq: string}[]; total: number}; outcomeDetails: Json | null;
  money: {incomplete: boolean; totals: Json[]; unavailable: unknown[]}; window: Json; intervals: (Json & {id: string})[];
  events: {eventSeq: string; type: string; attribution: Json | null}[]; samples: Json[];
}
/** Each trip exported through main's writer over the service's journal: a valid format version 1 document with the trip's hand-written key fields (J15-J17). */
async function expectExports(journal: JournalService, s: Scenario, trips: TripExpectation[]) {
  const seed = s.input.seed, coverage = s.rows.coverage.committedThroughEventSeq, folder = path.join(ws.directory, 'exports');
  mkdirSync(folder, {recursive: true});
  for (const t of trips) {
    let target = '';
    const exporter = new JournalExporter({read: async query => parseJournalReply(query, await journal.query(query)) ?? refusal('FAILED'), documents: () => folder,
      localAppData: ws.directory, appVersion: '0.1.0-test', log: () => undefined,
      showSaveDialog: defaultPath => { target = path.join(folder, path.basename(defaultPath)); return Promise.resolve({canceled: false, filePath: target}); }});
    const saved = await guarded(exporter.export(uuidOf(t.label, seed)), `the export of ${t.label}`, HANG_GUARD_MS);
    expect(saved, t.label).toEqual({ok: true, value: {outcome: 'saved', events: t.events.length, intervals: t.intervals.length, samples: t.samples.length}});
    const raw = JSON.parse(readFileSync(target, 'utf8')) as unknown;
    expect(tripExportProblems(raw), t.label).toEqual([]);
    const document = relabel(raw as ExportDocument, seed);
    expect([document.header.database, document.header.sessionOrigin], t.label).toEqual([{...SYNTHETIC_V3, uuid: expect.any(String) as string}, 'synthetic']);
    expect(document.bounds, t.label).toMatchObject({committedThroughEventSeq: coverage, snapshot: t.listItem.outcome === 'open'});
    expect([document.bounds.lastSampleId === null, document.bounds.lastIntervalId === null], t.label).toEqual([t.samples.length === 0, t.intervals.length === 0]);
    // The export's trip block is the detail's trip without the list's job summary (docs/journal-export.md).
    const {job: summary, isHardMode, hardModeDetails, ...trip} = t.detailTrip; void summary;
    expect(document.trip, t.label).toEqual({is_hard_mode: isHardMode, hard_mode_details: hardModeDetails, ...trip});
    expect({source: document.job.source, eventSeq: document.job.eventSeq, checkpointNextEventSeq: document.job.checkpointNextEventSeq}, t.label).toEqual(t.job);
    expect([document.truck?.eventSeq ?? null, {eventSeqs: document.trailers.items.map(i => i.eventSeq), total: document.trailers.total}], t.label).toEqual([t.truck, t.trailers]);
    if (t.outcome === null) expect(document.outcomeDetails, t.label).toBeNull();
    else expect(document.outcomeDetails, t.label).toMatchObject(t.outcome);
    expect({incomplete: document.money.incomplete, totals: sortMoney(document.money.totals), unavailable: document.money.unavailable}, t.label)
      .toEqual({incomplete: false, totals: sortMoney(t.money), unavailable: []});
    expect(document.window, t.label).toEqual(t.window);
    expect(withoutId(document.intervals), t.label).toEqual(t.intervals);
    expect(document.events.map(eventTuple), t.label).toEqual(t.events);
    expect(document.samples, t.label).toHaveLength(t.samples.length);
    expect(document.samples, t.label).toMatchObject(t.samples.map(x => ({utcMs: x.utcMs, monotonicNs: x.monotonicNs, sourceClockId: 'capture-clock', ...x.values})));
  }
}

describe('ET-019 lifecycle scenarios replayed into the journal and the export', () => {
  for (const s of SCENARIOS) it(`${s.id}: the stored rows, the journal (list, filters, detail, intervals, timeline, samples) and each trip's export match the hand-written expectation`, async () => {
    expectNoGameHistory();
    const session = scenarioSource(replayOf(s.input).scenario).pluginSessionId;
    const run = await runRecording(s.input, {path: ws.database, backups: ws.backups});
    // The served stream is the replayed one, so the hand-written expectations of the lockstep replay apply to this consumer.
    expect(reactiveDifferences(replayOf(s.input), run.report)).toEqual([]);
    expect(run.services).toHaveLength(1);
    for (const service of run.services) {
      expect(await service.client.close()).toEqual({clean: true});
      expect(service.states.filter(x => x.status === 'incompatible' || x.durable.state === 'failed')).toEqual([]);
    }
    // Every ACK handed to the pipe was at or below the coverage storage had reported (REG-005).
    for (const ack of run.acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
    expect({committedThroughEventSeq: run.tally.coverage.toString(), committed: run.tally.committed, duplicate: run.tally.duplicate, covered: run.tally.covered})
      .toEqual(s.rows.coverage);
    expect(await storedRows(ws, s.input.seed)).toEqual({trips: s.rows.trips, attributions: s.rows.attributions, intervals: s.rows.intervals});
    const written: HistoryAck[] = run.acks.map(ack => ({pluginSessionId: session, throughEventSeq: ack.through.toString()}));
    const violations = checkHistoryInvariants(readHistoryRows(ws.database), written);
    expect(violations, formatViolations(violations)).toEqual([]);

    // The journal and the export over a new real worker on the closed file, as the service reads the database it opened.
    const trips = expectationsOf(s);
    const worker = storageWorker(), client = new StorageClient(worker.handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
    const summary = ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}));
    const history: JournalHistory = {state: 'open', failureCode: null, client, database: {purpose: summary.purpose, schemaVersion: summary.schemaVersion}, databaseUuid: summary.databaseUuid};
    try {
      const journal = new JournalService({history, stopping: () => false, log: () => undefined});
      await expectJournal(journal, s, trips);
      await expectExports(journal, s, trips);
    } finally { expect(await client.close()).toEqual({clean: true}); }
    expectNoGameHistory();
  }, CASE_MS);
});
