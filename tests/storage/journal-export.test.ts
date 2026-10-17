// ET-016 PR-5 (J15-J17): the trip export end to end below the Electron UI. A synthetic recording target under a temporary
// LOCALAPPDATA is opened by the service's HistoryStorage in the real storage worker and seeded through its client with the
// hand-written anchors of tests/shared/journal-seed.ts, one open trip of 521 events, 520 completeness intervals and
// 3,601 samples, so every export section takes more than one page, and one late-attach trip opened from a checkpoint. The service's JournalService answers the reads, main's
// reply check (journal-contract.ts) forwards them and main's JournalExporter writes the file. After the database closes,
// independent SQL on a read-only connection reconciles each export with the stored rows; rows written after the detail
// read (during the Save dialog) must stay out of the export (J17). Runs under npm run test:storage (REG-014).
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import type {JournalCallResult} from '../../packages/contracts/src';
import type {StorageClient} from '../../packages/storage/src/client';
import {HistoryStorage} from '../../apps/desktop/src/history-storage';
import {parseJournalReply, refusal, type JournalQuery} from '../../apps/desktop/src/journal-contract';
import {JournalExporter} from '../../apps/desktop/src/journal-export-writer';
import {JournalService} from '../../apps/desktop/src/journal-service';
import {EUR, JOURNAL_TRIPS as T, seedJournalAnchors, seedSample} from '../shared/journal-seed';
import {BASE_UTC, ETS2_A, job, money, r, Script} from '../shared/trip-messages';
import {tripExportProblems} from '../shared/trip-export-validator';
import {readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {storageWorker, terminateWorkers, until} from './recording-helpers';

/** The large open trip: its own plugin session, opened by its job at eventSeq 1, then 520 attributed tolls. */
const LARGE_SESSION = '10000000-0000-4000-8000-0000000000f7';
const LARGE_TRIP = '7c000000-0000-4000-8000-000000000001';
const LARGE_UTC = BASE_UTC + 5_000_000;
const TOLLS = 520, SAMPLES = 3_601;
/** PR-5 review round 1: a late-attach trip (ET-016b PR-7, J9) opened from a checkpoint with nextEventSeq 3 in its own session. */
const LATE_SESSION = '10000000-0000-4000-8000-0000000000f8';
const LATE_UTC = BASE_UTC + 6_000_000;
const lateHash = createHash('sha256').update(`ets2telemetry-trip-attach-v1:${LATE_SESSION}:3`, 'utf8').digest('hex');
const LATE_TRIP = `${lateHash.slice(0, 8)}-${lateHash.slice(8, 12)}-${lateHash.slice(12, 16)}-${lateHash.slice(16, 20)}-${lateHash.slice(20, 32)}`;
const HANG_GUARD_MS = 30_000;

let ws: Awaited<ReturnType<typeof workspace>>;
let history: HistoryStorage;
let client: StorageClient;
let large: Script;
let exports: string;
const logs: [string, unknown][] = [];
const database = () => path.join(ws.directory, 'ETS2Telemetry', 'synthetic', 'export.sqlite');
const ok = async <T>(result: Promise<{ok: true; value: T} | {ok: false; error: {code: string}}>, what: string): Promise<T> => {
  const settled = await result;
  if (!settled.ok) throw new Error(`${what} failed with ${settled.error.code}`);
  return settled.value;
};

beforeAll(async () => {
  ws = await workspace();
  exports = path.join(ws.directory, 'exports');
  mkdirSync(exports);
  history = new HistoryStorage({localAppData: ws.directory, target: {purpose: 'synthetic', name: 'export'}, appVersion: '0.1.0-test', closeGraceMs: TEST_CLOSE_GRACE_MS,
    createWorker: () => storageWorker().handle, log: (event, _detail, facts) => { logs.push([event, facts]); }});
  history.start();
  await until(() => history.state !== 'idle' && history.state !== 'opening', 'the database open', HANG_GUARD_MS);
  expect(history.state).toBe('open');
  client = history.client!;
  // The late-attach trip first: storage opens one only while no trip of its game is open (J9), and the anchors leave one open.
  // Its eventSeq 1-2 before the checkpoint, the trip opened from the checkpoint job, then 3-5 with its delivery.
  const late = new Script(LATE_SESSION, 'ets2', {utcMs: LATE_UTC});
  await ok(client.upsertSession({message: late.welcome()}), 'late session');
  await ok(client.commitEvent({message: late.event(r.paused(), {simulation: 'paused'})}), 'late 1');
  await ok(client.commitEvent({message: late.event(r.fined()), effects: [{kind: 'event.attribute', tripUuid: null, attribution: 'free-driving'}]}), 'late 2');
  await ok(client.openAttachedTrip({pluginSessionId: LATE_SESSION, nextEventSeq: '3', job: job(), effects: [
    {kind: 'trip.open', tripUuid: LATE_TRIP, game: 'ets2', gameMode: {mode: 'single-player', method: 'module-scan', confidence: 'weak'}, jobConfiguration: 'this-event',
      recordingCompleteness: 'partial', startedUtcMs: LATE_UTC + 2_500},
    {kind: 'completeness.add', interval: {tripUuid: LATE_TRIP, kind: 'not-connected', detail: {cause: 'late-attach', source: 'checkpoint', nextEventSeq: '3'}}}]}), 'late attach');
  await ok(client.commitEvent({message: late.event(r.started())}), 'late 3');
  await ok(client.commitEvent({message: late.event(r.fined()), effects: [{kind: 'event.attribute', tripUuid: LATE_TRIP, attribution: 'trip'}]}), 'late 4');
  await ok(client.commitEvent({message: late.event(r.delivered(), {simulation: 'paused'}), effects: [{kind: 'event.attribute', tripUuid: LATE_TRIP, attribution: 'trip'},
    {kind: 'trip.close', tripUuid: LATE_TRIP, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'partial', endedUtcMs: LATE_UTC + 5_000}]}), 'late 5');
  await seedJournalAnchors(client);
  large = new Script(LARGE_SESSION, 'ets2', {utcMs: LARGE_UTC});
  await ok(client.upsertSession({message: large.welcome()}), 'large session');
  await ok(client.commitEvent({message: large.event(r.jobConfigured(job({cargoId: {available: true, value: 'synthetic_export_cargo'}}))), effects: [{kind: 'trip.open', tripUuid: LARGE_TRIP,
    game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs: LARGE_UTC + 1_000}]}), 'large job');
  for (let i = 0; i < TOLLS; i++) await addToll(String(i + 2));
  const rows = Array.from({length: SAMPLES}, (_, second) => seedSample(large, LARGE_TRIP, second, LARGE_UTC + 600_000 + second * 1_000, {speed: {available: true, value: second % 30}}));
  await ok(client.appendSamples(LARGE_SESSION, rows.slice(0, 1_800)), 'large samples 1');
  await ok(client.appendSamples(LARGE_SESSION, rows.slice(1_800)), 'large samples 2');
}, 240_000);
afterAll(async () => {
  if (history.state === 'open') await history.close();
  await terminateWorkers(); await ws.dispose();
});

/** One toll of the large trip with its truck-change annotation, as the smoke's paging trip has. */
async function addToll(atEventSeq: string) {
  await ok(client.commitEvent({message: large.event({type: 'player.tollgate.paid', amount: money('1', 's64', EUR)}),
    effects: [{kind: 'event.attribute', tripUuid: LARGE_TRIP, attribution: 'trip'},
      {kind: 'completeness.add', interval: {tripUuid: LARGE_TRIP, kind: 'discontinuity', detail: {cause: 'truck-change', annotation: true, atEventSeq}}}]}), `toll ${atEventSeq}`);
}
/** Main's export over the service's journal: each answer passes main's reply check, as the broker forwards it. */
function exporter(onDialog: () => Promise<void> = () => Promise.resolve()) {
  const journal = new JournalService({history, stopping: () => false, log: (event, _detail, facts) => { logs.push([event, facts]); }});
  const read = async (query: JournalQuery): Promise<JournalCallResult<unknown>> => parseJournalReply(query, await journal.query(query)) ?? refusal('FAILED');
  let target = '';
  const instance = new JournalExporter({read, documents: () => exports, localAppData: ws.directory, appVersion: '0.1.0-test', log: (event, _detail, facts) => { logs.push([event, facts]); },
    showSaveDialog: async defaultPath => { await onDialog(); target = path.join(exports, path.basename(defaultPath)); return {canceled: false, filePath: target}; }});
  return {instance, target: () => target};
}
interface Exported {
  header: {database: {uuid: string; purpose: string}; sessionOrigin: string}; bounds: {committedThroughEventSeq: string; lastSampleId: string | null; lastIntervalId: string | null; snapshot: boolean};
  trip: Record<string, unknown>; window: Record<string, unknown>;
  events: {eventSeq: string; type: string; attribution: {kind: string; tripUuid: string | null} | null}[];
  intervals: {id: string; kind: string; detail: unknown}[]; samples: {id: string; speed: {available: boolean; value?: number}}[];
}
const results: Record<string, {file: string; document: Exported}> = {};

describe('a trip export through the real worker, the service journal and main\'s writer (J15-J17)', () => {
  it('exports the delivered anchor in one page per section', async () => {
    const f = exporter();
    await expect(f.instance.export(T.delivered)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 6, intervals: 0, samples: 3}});
    const document = JSON.parse(readFileSync(f.target(), 'utf8')) as Exported;
    expect(tripExportProblems(document)).toEqual([]);
    expect(path.basename(f.target())).toBe('ets2telemetry-trip-ets2-20261011-0000-7a000000.json');
    results.delivered = {file: f.target(), document};
  });
  it('exports the large open trip page by page and leaves out rows written during the Save dialog', async () => {
    // Written after the detail read, while the dialog is open: one more toll (eventSeq 522), its interval and one sample.
    const f = exporter(async () => {
      await addToll('522');
      await ok(client.appendSamples(LARGE_SESSION, [seedSample(large, LARGE_TRIP, SAMPLES, LARGE_UTC + 600_000 + SAMPLES * 1_000, {speed: {available: true, value: 1}})]), 'late sample');
    });
    await expect(f.instance.export(LARGE_TRIP)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 521, intervals: 520, samples: 3_601}});
    const document = JSON.parse(readFileSync(f.target(), 'utf8')) as Exported;
    expect(tripExportProblems(document)).toEqual([]);
    expect(document.bounds).toEqual({committedThroughEventSeq: '521', lastSampleId: expect.stringMatching(/^[1-9][0-9]*$/) as string, lastIntervalId: expect.stringMatching(/^[1-9][0-9]*$/) as string,
      snapshot: true});
    results.large = {file: f.target(), document};
  });
  it('exports a late-attach trip opened from a checkpoint: its checkpoint job, no truck or trailer, and its window from the checkpoint', async () => {
    const f = exporter();
    await expect(f.instance.export(LATE_TRIP)).resolves.toEqual({ok: true, value: {outcome: 'saved', events: 3, intervals: 1, samples: 0}});
    const document = JSON.parse(readFileSync(f.target(), 'utf8')) as Exported & {job: unknown; truck: unknown; trailers: unknown};
    expect(tripExportProblems(document)).toEqual([]);
    expect(path.basename(f.target())).toBe(`ets2telemetry-trip-ets2-20261011-0140-${LATE_TRIP.slice(0, 8)}.json`);
    expect(document.trip).toEqual({tripUuid: LATE_TRIP, pluginSessionId: LATE_SESSION, game: 'ets2', gameMode: {mode: 'single-player', method: 'module-scan', confidence: 'weak'},
      gameModeAmbiguous: false, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'partial', startedUtcMs: LATE_UTC + 2_500, endedUtcMs: LATE_UTC + 5_000,
      observedDistanceM: {available: false, reason: 'not-observed'}, fuelUsedL: {available: false, reason: 'not-observed'}, openedBy: 'checkpoint', openedEventSeq: null,
      outcomeEventSeq: '5', closedBy: {pluginSessionId: LATE_SESSION, eventSeq: '5'}});
    expect(document.job).toEqual({source: 'checkpoint', eventSeq: null, checkpointNextEventSeq: '3', values: job()});
    expect([document.truck, document.trailers]).toEqual([null, {items: [], total: 0}]);
    expect(document.window).toEqual({known: true, pluginSessionId: LATE_SESSION, fromEventSeq: '3', throughEventSeq: '5', end: 'close-event'});
    expect(document.events.map(event => [event.eventSeq, event.type, event.attribution?.kind ?? null])).toEqual([['3', 'simulation.started', null], ['4', 'player.fined', 'trip'],
      ['5', 'job.delivered', 'trip']]);
    expect(document.intervals.map(interval => [interval.kind, interval.detail])).toEqual([['not-connected', {cause: 'late-attach', source: 'checkpoint', nextEventSeq: '3'}]]);
    expect([document.samples, document.bounds.committedThroughEventSeq, document.bounds.lastSampleId, document.bounds.snapshot]).toEqual([[], '5', null, false]);
    results.late = {file: f.target(), document};
  });
  it('reconciles the exports with the stored rows read by independent SQL', async () => {
    expect(Object.keys(results).sort()).toEqual(['delivered', 'large', 'late']);
    await history.close();
    readOnly(database(), db => {
      const info = db.prepare('SELECT database_uuid, purpose FROM database_info WHERE id = 1').get() as {database_uuid: string; purpose: string};
      for (const {document} of Object.values(results)) {
        expect(document.header.database).toMatchObject({uuid: info.database_uuid, purpose: 'synthetic'});
        expect(document.header.sessionOrigin).toBe('synthetic');
      }
      const tripRow = (uuid: string) => db.prepare(`SELECT t.id, t.outcome, t.close_reason, t.recording_completeness, t.started_utc_ms, t.ended_utc_ms, p.id AS session, p.plugin_session_uuid,
        p.origin FROM trips t JOIN plugin_sessions p ON p.id = t.plugin_session_ref WHERE t.trip_uuid = ?`).get(uuid) as Record<string, unknown> & {id: number; session: number};
      const seqs = (session: number, from: string, through: string) => (db.prepare('SELECT event_seq FROM events WHERE plugin_session_id = ? AND event_seq >= ? AND event_seq <= ? ORDER BY event_seq')
        .pluck().all(session, from.padStart(20, '0'), through.padStart(20, '0')) as string[]).map(seq => BigInt(seq).toString());
      const ids = (table: 'samples' | 'completeness_intervals', trip: number) => (db.prepare(`SELECT id FROM ${table} WHERE trip_ref = ? ORDER BY id`).pluck().all(trip) as number[]).map(String);

      // The delivered anchor: its row, its window 4-9 of session A (A10 and A11 follow the outcome) and its three samples.
      const delivered = results.delivered.document, d = tripRow(T.delivered);
      expect({outcome: d.outcome, closeReason: d.close_reason, completeness: d.recording_completeness, started: d.started_utc_ms, ended: d.ended_utc_ms, session: d.plugin_session_uuid, origin: d.origin})
        .toEqual({outcome: 'delivered', closeReason: 'outcome', completeness: 'complete', started: BASE_UTC + 4_000, ended: BASE_UTC + 9_000, session: ETS2_A, origin: 'synthetic'});
      expect(delivered.trip).toMatchObject({tripUuid: T.delivered, pluginSessionId: ETS2_A, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete',
        startedUtcMs: BASE_UTC + 4_000, endedUtcMs: BASE_UTC + 9_000, observedDistanceM: {available: true, value: 152_000.5}});
      expect(delivered.events.map(event => event.eventSeq)).toEqual(seqs(d.session, '4', '9'));
      expect(delivered.events.map(event => event.eventSeq)).toEqual(['4', '5', '6', '7', '8', '9']);
      expect(delivered.samples.map(sample => sample.id)).toEqual(ids('samples', d.id));
      expect(delivered.intervals).toEqual([]);
      expect(delivered.bounds.snapshot).toBe(false);

      // The large trip: every stored row up to the bounds, and the rows written during the dialog left out.
      const large = results.large.document, l = tripRow(LARGE_TRIP);
      const storedSeqs = seqs(l.session, '1', '600'), storedIntervals = ids('completeness_intervals', l.id), storedSamples = ids('samples', l.id);
      expect([storedSeqs.length, storedIntervals.length, storedSamples.length]).toEqual([522, 521, 3_602]);
      expect(large.events.map(event => event.eventSeq)).toEqual(storedSeqs.slice(0, 521));
      expect(large.intervals.map(interval => interval.id)).toEqual(storedIntervals.slice(0, 520));
      expect(large.samples.map(sample => sample.id)).toEqual(storedSamples.slice(0, 3_601));
      expect([large.bounds.lastIntervalId, large.bounds.lastSampleId]).toEqual([storedIntervals[519], storedSamples[3_600]]);
      // Attributions, interval details and sample values as stored.
      const attributions = new Map((db.prepare(`SELECT e.event_seq, a.attribution, t.trip_uuid FROM events e LEFT JOIN event_attributions a ON a.event_ref = e.id
        LEFT JOIN trips t ON t.id = a.trip_ref WHERE e.plugin_session_id = ?`).all(l.session) as {event_seq: string; attribution: string | null; trip_uuid: string | null}[])
        .map(row => [BigInt(row.event_seq).toString(), row.attribution === null ? null : {kind: row.attribution, tripUuid: row.trip_uuid}]));
      expect(large.events.map(event => event.attribution)).toEqual(large.events.map(event => attributions.get(event.eventSeq)));
      expect(large.events.filter(event => event.attribution?.kind === 'trip')).toHaveLength(TOLLS);
      const details = db.prepare('SELECT detail_json FROM completeness_intervals WHERE trip_ref = ? ORDER BY id').pluck().all(l.id) as string[];
      expect(large.intervals.map(interval => interval.detail)).toEqual(details.slice(0, 520).map(text => JSON.parse(text) as unknown));
      const speeds = db.prepare('SELECT speed_mps FROM samples WHERE trip_ref = ? ORDER BY id').pluck().all(l.id) as number[];
      expect(large.samples.map(sample => sample.speed.value)).toEqual(speeds.slice(0, 3_601));
      expect(large.window).toEqual({known: true, pluginSessionId: LARGE_SESSION, fromEventSeq: '1', throughEventSeq: null, end: 'open'});
    });
    // Only the two documents are left in the export folder: no partial file, and nothing was written beside the database.
    expect(readdirSync(exports).sort()).toEqual([path.basename(results.large.file), path.basename(results.delivered.file), path.basename(results.late.file)].sort());
    expect(existsSync(path.join(ws.directory, 'ETS2Telemetry', 'data'))).toBe(false);
    expect(logs.filter(([event]) => event.startsWith('JOURNAL_EXPORT_'))).toEqual([['JOURNAL_EXPORT_SAVED', {events: 6, samples: 3}], ['JOURNAL_EXPORT_SAVED', {events: 521, samples: 3_601}],
      ['JOURNAL_EXPORT_SAVED', {events: 3, samples: 0}]]);
    expect(logs.filter(([event]) => /UNAVAILABLE|INVALID|REJECTED/.test(event))).toEqual([]);
  });
});
