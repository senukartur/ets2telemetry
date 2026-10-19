// The storage worker as the telemetry service runs it: the bundled apps/desktop/src/storage-worker.ts in a real worker
// thread under the pinned Electron runtime, driven through StorageClient (REG-006, REG-007 partial), and the ET-015a
// test-only fault storage worker.
import {chmodSync, existsSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {MessageChannel, Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CLOSE_GRACE_MS, StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {JournalResult, Result, SampleInput, StorageErrorCode, TripEffect} from '../../packages/storage/src/index';
import type {WorkerOpenOptions} from '../../packages/storage/src/worker/protocol';
import {JOURNAL_TRIPS as T, seedJournalAnchors} from '../shared/journal-seed';
import {BASE_UTC, ETS2_A} from '../shared/trip-messages';
import {ok, P1, readOnly, TEST_CLOSE_GRACE_MS, v1, withEventSeq, workspace} from './helpers';

const bundles = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if (!bundles) throw new Error('Storage test bundles are missing; run npm run test:storage.');
const WORKER = path.join(bundles, 'storage-worker.cjs');

let ws: Awaited<ReturnType<typeof workspace>>;
const started: Worker[] = [];
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => {
  await Promise.all(started.splice(0).map(worker => worker.terminate()));
  await ws.dispose();
});

/**
 * The bundled worker with each `close` request held on the worker thread for `closeDelayMs` before the host receives it,
 * as a stalled host or disk would hold the close. Only the delivery is delayed; the worker code is unchanged.
 */
const DELAYED_CLOSE_WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const held = new Map(), on = parentPort.on.bind(parentPort), off = parentPort.off.bind(parentPort);
parentPort.on = (event, listener) => {
  if (event !== 'message') return on(event, listener);
  const hold = message => {
    if (message && message.command && message.command.name === 'close') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.closeDelayMs);
    listener(message);
  };
  held.set(listener, hold);
  return on(event, hold);
};
parentPort.off = (event, listener) => off(event, held.get(listener) ?? listener);
require(workerData.entry);
`;

function startWorker({closeGraceMs = TEST_CLOSE_GRACE_MS, closeDelayMs}: {closeGraceMs?: number; closeDelayMs?: number} = {}) {
  const worker = closeDelayMs === undefined ? new Worker(WORKER, {workerData: {kind: 'storage'}})
    : new Worker(DELAYED_CLOSE_WORKER, {eval: true, workerData: {kind: 'storage', entry: WORKER, closeDelayMs}});
  started.push(worker);
  const exit = once(worker, 'exit').then(([code]) => code as number);
  return {worker, client: new StorageClient(workerHandle(worker), {closeGraceMs}), exit};
}
const options = (overrides: Partial<WorkerOpenOptions> = {}): WorkerOpenOptions =>
  ({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test', ...overrides});
function refused<T>(result: Result<T> | JournalResult<T>, code: StorageErrorCode | 'JOURNAL_ANSWER_INVALID') {
  expect(result.ok ? 'ok' : result.error.code).toBe(code);
  // Error results cross the worker boundary with fixed text only, never a path.
  expect(JSON.stringify(result)).not.toContain(ws.directory.replaceAll('\\', '\\\\'));
}
const T1 = '70000000-0000-4000-8000-000000000001';
const openTrip: TripEffect = {kind: 'trip.open', tripUuid: T1, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
  jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1_791_676_800_000};
const notObserved = {available: false as const, reason: 'not-observed' as const};
/** A one-second sample on the session's source clock, identified by its monotonic time. */
const sampleAt = (monotonicNs: string): SampleInput => ({utcMs: 1_791_676_800_000, sourceClockId: '30000000-0000-4000-8000-000000000001', monotonicNs, gameTime: null,
  speed: {available: true, value: 0}, fuel: notObserved, averageConsumption: notObserved, estimatedRange: notObserved, engineRpm: notObserved, gear: notObserved,
  odometer: notObserved, position: notObserved});

describe('storage worker', () => {
  it('opens, commits, reads and closes through the real worker, and a new worker reopens the same history', async () => {
    const first = startWorker();
    const summary = ok(await first.client.open(options()));
    expect(summary).toMatchObject({schemaVersion: 2, created: true, purpose: 'synthetic'});
    expect(ok(await first.client.upsertSession({message: v1('welcome')}))).toEqual({created: true, committedThroughEventSeq: '0'});
    expect(ok(await first.client.commitEvent({message: v1('event-job-configured'), effects: [openTrip, {kind: 'event.attribute', tripUuid: T1, attribution: 'trip'}]})))
      .toEqual({status: 'committed', committedThroughEventSeq: '1'});
    expect(ok(await first.client.commitGap({message: withEventSeq('gap', 2n, 3n)}))).toEqual({status: 'committed', committedThroughEventSeq: '3', previouslyCoveredThrough: '1'});
    expect(ok(await first.client.committedThrough(P1))).toBe('3');
    expect(ok(await first.client.getTrip(T1))).toMatchObject({tripUuid: T1, outcome: 'open', openedEventSeq: '1'});
    expect(ok(await first.client.storageInfo()).durability).toEqual({journalMode: 'wal', synchronous: 'full', lockingMode: 'exclusive', foreignKeys: true});
    expect(await first.client.close()).toEqual({clean: true});
    expect(await first.exit).toBe(0);
    // Closing checkpointed the WAL; exclusive locking never created a shared-memory file.
    expect(['-wal', '-shm'].filter(suffix => existsSync(ws.database + suffix))).toEqual([]);
    refused(await first.client.committedThrough(P1), 'STORAGE_CLOSED');

    const second = startWorker();
    expect(ok(await second.client.open(options()))).toMatchObject({created: false, databaseUuid: summary.databaseUuid});
    expect(ok(await second.client.committedThrough(P1))).toBe('3');
    // A redelivered event after the restart is a duplicate and its effects are not applied again.
    expect(ok(await second.client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]}))).toEqual({status: 'duplicate', committedThroughEventSeq: '3'});
    expect(ok(await second.client.listEvents(P1)).map(event => event.eventSeq)).toEqual(['1']);
    expect(await second.client.close()).toEqual({clean: true});
    expect(await second.exit).toBe(0);
    readOnly(ws.database, db => expect(db.prepare('SELECT count(*) AS trips FROM trips').get()).toEqual({trips: 1}));
  });

  it('returns refused opens and command errors as results and still closes cleanly (REG-007)', async () => {
    const {client, exit} = startWorker();
    refused(await client.committedThrough(P1), 'STORAGE_CLOSED');
    refused(await client.open(options({path: 'relative\\telemetry.sqlite'})), 'DATA_PATH_INVALID');
    refused(await client.open(options({path: ws.copyFixture('schema-newer-999.sqlite')})), 'SCHEMA_NEWER');
    refused(await client.open(options({path: ws.copyFixture('foreign-application.sqlite')})), 'DATABASE_UNRECOGNIZED');
    ok(await client.open(options()));
    refused(await client.open(options()), 'INVALID_INPUT');
    refused(await client.commitEvent({message: v1('event-job-configured')}), 'UNKNOWN_SESSION');
    ok(await client.upsertSession({message: v1('welcome')}));
    refused(await client.commitEvent({message: v1('event-job-delivered'), effects: [{kind: 'event.attribute', tripUuid: T1, attribution: 'trip'}]}), 'UNKNOWN_TRIP');
    // The refused commit stored nothing; coverage is unchanged.
    expect(ok(await client.committedThrough(P1))).toBe('0');
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('reports a second writer and a read-only file through the worker', async () => {
    const holder = startWorker();
    ok(await holder.client.open(options()));
    const second = startWorker();
    const locked = await second.client.open(options());
    refused(locked, 'DATABASE_LOCKED');
    expect(!locked.ok && locked.error.retryable).toBe(true);
    expect(await holder.client.close()).toEqual({clean: true});
    expect(await holder.exit).toBe(0);
    expect(await second.client.close()).toEqual({clean: true});
    expect(await second.exit).toBe(0);
    chmodSync(ws.database, 0o444);
    try {
      const reader = startWorker();
      refused(await reader.client.open(options()), 'PERMISSION_DENIED');
      expect(await reader.client.close()).toEqual({clean: true});
    } finally { chmodSync(ws.database, 0o666); }
  });

  it('fails every unanswered command of a terminated worker and never reports a later success', async () => {
    const {worker, client} = startWorker();
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    const commits = Array.from({length: 8}, (_, index) => client.commitEvent({message: withEventSeq('event-simulation-started', BigInt(index + 1))}));
    await worker.terminate();
    const results = await Promise.all(commits);
    const outcomes = results.map(result => result.ok ? 'ok' : result.error.code);
    // Answers that arrived before the thread ended stand; everything after the first failure failed.
    const firstFailure = outcomes.indexOf('WORKER_FAILED');
    expect(firstFailure).toBeGreaterThanOrEqual(0);
    expect(outcomes.slice(firstFailure).every(outcome => outcome === 'WORKER_FAILED')).toBe(true);
    expect(outcomes.slice(0, firstFailure).every(outcome => outcome === 'ok')).toBe(true);
    refused(await client.committedThrough(P1), 'WORKER_FAILED');
    // The terminated worker never closed the database in order.
    expect(await client.close()).toEqual({clean: false});
    // Every reported commit is durable: the reopened database covers at least the last acknowledged eventSeq.
    const reopened = startWorker();
    ok(await reopened.client.open(options()));
    expect(BigInt(ok(await reopened.client.committedThrough(P1)))).toBeGreaterThanOrEqual(BigInt(firstFailure));
    expect(await reopened.client.close()).toEqual({clean: true});
  });

  // Regression of the suite's grace (October 15, 2026): with the 2 s production default, which these clients used before,
  // this stall and the same stall of the holder's close in the second-writer case were reported `{clean: false}`. A
  // production-grace client still reports this stall unclean; the next case covers grace expiry.
  it('with the test close grace, a close stalled 500 ms past the 2 s production default ends clean', async () => {
    const {client, exit} = startWorker({closeDelayMs: CLOSE_GRACE_MS + 500});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('terminates a worker whose close outlasts the grace, reports it unclean and keeps every committed event', async () => {
    const held = startWorker({closeGraceMs: 200, closeDelayMs: 5_000});
    ok(await held.client.open(options()));
    ok(await held.client.upsertSession({message: v1('welcome')}));
    expect(ok(await held.client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]})).status).toBe('committed');
    expect(await held.client.close()).toEqual({clean: false});
    // Terminated before its host received the close: worker_threads reports exit code 1.
    expect(await held.exit).toBe(1);
    // The terminated thread released the exclusive lock, and the commit it reported is stored.
    const reopened = startWorker();
    ok(await reopened.client.open(options()));
    expect(ok(await reopened.client.committedThrough(P1))).toBe('1');
    expect(ok(await reopened.client.getTrip(T1))).toMatchObject({tripUuid: T1, outcome: 'open'});
    expect(await reopened.client.close()).toEqual({clean: true});
    expect(await reopened.exit).toBe(0);
  });

  // Regression (packaged recording smoke, October 18, 2026): a service thread that is blocked past the grace while the
  // worker closes runs the due grace timer before the event loop's next poll phase delivers the close answer that arrived
  // meanwhile. Before the fix this close was reported `{clean: false}` although the worker had closed the database.
  it('counts a close that finished while the client thread was blocked past the grace', async () => {
    const {client, exit} = startWorker({closeGraceMs: 200});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(ok(await client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]})).status).toBe('committed');
    expect(existsSync(ws.database + '-wal')).toBe(true);
    // The close and the block run in an immediate, outside the worker port's message callback: that callback would read
    // the answer from the port's queue before it returns, whereas another callback returns to the loop, which runs its due
    // timers before the next poll phase. The block lasts until the worker removed the WAL (its close checkpointed and
    // closed the database) and the grace passed, plus a 1,000 ms margin for the answer to be posted on a loaded host.
    const cell = new Int32Array(new SharedArrayBuffer(4));
    let walRemoved = false;
    const closed = await new Promise<{clean: boolean}>(resolve => setImmediate(() => {
      const pending = client.close(), started = Date.now();
      while (existsSync(ws.database + '-wal') && Date.now() - started < 20_000) Atomics.wait(cell, 0, 0, 5);
      walRemoved = !existsSync(ws.database + '-wal');
      Atomics.wait(cell, 0, 0, Math.max(0, 200 - (Date.now() - started)) + 1_000);
      resolve(pending);
    }));
    expect(walRemoved).toBe(true);
    expect(closed).toEqual({clean: true});
    // 0 when the thread had also ended during the block, 1 when it was terminated after it acknowledged the close.
    expect([0, 1]).toContain(await exit);
    const reopened = startWorker();
    ok(await reopened.client.open(options()));
    expect(ok(await reopened.client.committedThrough(P1))).toBe('1');
    expect(await reopened.client.close()).toEqual({clean: true});
  });

  it('answers a malformed request with INVALID_INPUT', async () => {
    const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
    started.push(worker);
    const answer = once(worker, 'message');
    worker.postMessage({type: 'storage.request', id: 7, command: {name: 'dropTable'}});
    const [response] = await answer;
    expect(response).toMatchObject({type: 'storage.response', id: 7, result: {ok: false, error: {code: 'INVALID_INPUT'}}});
  });

  it('applies uniqueSeconds through the real worker, and a new worker skips the stored second (ET-015b, REG-005)', async () => {
    const first = startWorker();
    ok(await first.client.open(options()));
    ok(await first.client.upsertSession({message: v1('welcome')}));
    expect(ok(await first.client.appendSamples(P1, [sampleAt('1000000000000'), sampleAt('1000900000000'), sampleAt('1001000000000')], {uniqueSeconds: true})))
      .toEqual({appended: 2, skipped: 1});
    // Without the option the worker appends every row, as before ET-015b.
    expect(ok(await first.client.appendSamples(P1, [sampleAt('1001500000000')]))).toEqual({appended: 1, skipped: 0});
    expect(await first.client.close()).toEqual({clean: true});
    const second = startWorker();
    ok(await second.client.open(options()));
    expect(ok(await second.client.appendSamples(P1, [sampleAt('1001999999999'), sampleAt('1002000000000')], {uniqueSeconds: true}))).toEqual({appended: 1, skipped: 1});
    expect(ok(await second.client.listSamples({pluginSessionId: P1})).map(s => s.monotonicNs)).toEqual(['1000000000000', '1001000000000', '1001500000000', '1002000000000']);
    expect(await second.client.close()).toEqual({clean: true});
  });

  it('refuses appendSamples options with an unknown key or a non-boolean value with INVALID_INPUT', async () => {
    const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
    started.push(worker);
    const answers: unknown[] = [];
    worker.on('message', message => answers.push(message));
    const request = (id: number, sampleOptions: unknown) => ({type: 'storage.request', id, command: {name: 'appendSamples', pluginSessionId: P1, rows: [], options: sampleOptions}});
    worker.postMessage(request(1, {uniqueSeconds: true, testHooks: {}}));
    worker.postMessage(request(2, {uniqueSeconds: 'yes'}));
    worker.postMessage(request(3, null));
    // A well-formed request passes the parser and reaches the host, which has no open database yet.
    worker.postMessage(request(4, {uniqueSeconds: true}));
    await vi.waitFor(() => expect(answers).toHaveLength(4));
    expect(answers.map(answer => (answer as {result: {error: {code: string}}}).result.error.code)).toEqual(['INVALID_INPUT', 'INVALID_INPUT', 'INVALID_INPUT', 'STORAGE_CLOSED']);
  });

  it('serves the journal reads through the real worker and the validating client (ET-016, REG-014)', async () => {
    const {client, exit} = startWorker();
    ok(await client.open(options()));
    // The seed writes the anchors through the client, as a later seeding script would.
    await seedJournalAnchors(client);
    const page = ok(await client.journalTrips());
    expect(page.database).toEqual({purpose: 'synthetic', schemaVersion: 2});
    expect(page.trips.map(trip => trip.tripUuid)).toEqual([T.manySamples, T.zeroValues, T.open, T.restartClosed, T.gapClosed, T.differentJob, T.cancelled, T.delivered]);
    expect(page.nextCursor).toBeNull();
    expect(ok(await client.journalTrips({game: 'ats', outcome: 'delivered', completeness: 'complete'})).trips.map(trip => trip.tripUuid)).toEqual([T.zeroValues]);
    expect(ok(await client.journalTrips({cursor: '2'})).trips.map(trip => trip.tripUuid)).toEqual([T.delivered]);
    const detail = ok(await client.journalTrip(T.delivered));
    expect(detail.window).toEqual({known: true, pluginSessionId: ETS2_A, fromEventSeq: '4', throughEventSeq: '9', end: 'close-event'});
    expect(detail.money.totals.map(total => [total.category, total.raw])).toEqual([['fine', '401'], ['toll', '35'], ['ferry', '677']]);
    expect(detail.samples).toEqual({count: 3, firstUtcMs: BASE_UTC + 5_000, lastUtcMs: BASE_UTC + 8_000});
    expect(ok(await client.journalEvents(T.delivered, {limit: 100})).events.map(event => event.eventSeq)).toEqual(['4', '5', '6', '7', '8', '9']);
    expect(ok(await client.journalEvents(T.delivered, {limit: 500, cursor: '7'})).events.map(event => event.eventSeq)).toEqual(['8', '9']);
    expect(ok(await client.journalIntervals(T.gapClosed, {limit: 100})).intervals.map(i => [i.kind, i.annotation])).toEqual([
      ['discontinuity', true], ['sample-loss', false], ['event-loss', false]]);
    expect(ok(await client.listSamples({tripUuid: T.manySamples}, {limit: 300}))).toHaveLength(300);
    refused(await client.journalTrip('7a000000-0000-4000-8000-0000000000ff'), 'UNKNOWN_TRIP');
    refused(await client.journalEvents(T.delivered, {limit: 51}), 'INVALID_INPUT');
    // A refused argument is an ordinary result: the client keeps serving.
    expect(client.state).toBe('running');
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('bounds the trailers of a trip that holds more than ten through the real worker and the validating client (ET-016 review pass 1)', async () => {
    const {client, exit} = startWorker();
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(ok(await client.commitEvent({message: withEventSeq('event-job-configured', 1n), effects: [openTrip]})).status).toBe('committed');
    // Twelve trailer configurations given to the open trip: every one stays a trip_trailers row.
    for (let seq = 2n; seq <= 13n; seq++) {
      expect(ok(await client.commitEvent({message: withEventSeq('event-trailer-configured', seq),
        effects: [{kind: 'trip.update', tripUuid: T1, set: {trailerConfigurations: ['this-event']}}]})).status).toBe('committed');
    }
    const detail = ok(await client.journalTrip(T1));
    expect(detail.trailers.total).toBe(12);
    // The latest ten, in eventSeq order.
    expect(detail.trailers.items.map(trailer => trailer.eventSeq)).toEqual(['4', '5', '6', '7', '8', '9', '10', '11', '12', '13']);
    expect(client.state).toBe('running');
    expect(ok(await client.committedThrough(P1))).toBe('13');
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('answers a contract-invalid journal page with JOURNAL_ANSWER_INVALID for that read alone; recorder commands keep working (ET-016 review pass 1)', async () => {
    // The bundled worker with each journalTrips answer altered on the worker thread after the host produced it, as a
    // faulty host would: the frame stays well formed, only the page breaks the journal contract.
    const CORRUPTING_WORKER = `
const {parentPort, workerData} = require('node:worker_threads');
const journal = new Set(), on = parentPort.on.bind(parentPort), post = parentPort.postMessage.bind(parentPort);
parentPort.on = (event, listener) => on(event, event !== 'message' ? listener : message => {
  if (message && message.command && message.command.name === 'journalTrips') journal.add(message.id);
  listener(message);
});
parentPort.postMessage = message => {
  if (message && journal.has(message.id) && message.result && message.result.ok) message.result.value.database.purpose = 'game';
  post(message);
};
require(workerData.entry);
`;
    const worker = new Worker(CORRUPTING_WORKER, {eval: true, workerData: {kind: 'storage', entry: WORKER}});
    started.push(worker);
    const exit = once(worker, 'exit').then(([code]) => code as number);
    const refusals: unknown[] = [];
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS, onJournalAnswerInvalid: facts => refusals.push(facts)});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(ok(await client.commitEvent({message: withEventSeq('event-job-configured', 1n), effects: [openTrip]})).status).toBe('committed');
    refused(await client.journalTrips(), 'JOURNAL_ANSWER_INVALID');
    expect(refusals).toEqual([{command: 'journalTrips'}]);
    expect(client.state).toBe('running');
    // The recorder's commands and other journal reads keep working on the same client and worker.
    expect(ok(await client.commitEvent({message: withEventSeq('event-trailer-configured', 2n)}))).toEqual({status: 'committed', committedThroughEventSeq: '2'});
    expect(ok(await client.committedThrough(P1))).toBe('2');
    expect(ok(await client.journalTrip(T1)).trip.tripUuid).toBe(T1);
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('refuses journal commands with unknown fields, other page sizes or malformed cursors with INVALID_INPUT', async () => {
    const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
    started.push(worker);
    const answers: unknown[] = [];
    worker.on('message', message => answers.push(message));
    const commands: Record<string, unknown>[] = [
      {name: 'journalTrips', query: {limit: 50}},
      {name: 'journalTrips', query: {cursor: '0'}},
      {name: 'journalTrips', query: {game: 'ETS2'}},
      {name: 'journalTrips', query: null},
      {name: 'journalTrips', testHooks: {}},
      {name: 'journalTrip', tripUuid: 'not-a-uuid'},
      {name: 'journalTrip', tripUuid: T.delivered, page: {limit: 100}},
      {name: 'journalEvents', tripUuid: T.delivered, page: {limit: 51}},
      {name: 'journalEvents', tripUuid: T.delivered, page: {limit: 100, cursor: '18446744073709551615'}},
      {name: 'journalEvents', tripUuid: T.delivered},
      {name: 'journalIntervals', tripUuid: T.delivered, page: {limit: 3_600}},
      {name: 'journalIntervals', tripUuid: T.delivered, page: {limit: 100, cursor: '01'}},
      // Well-formed requests pass the parser and reach the host, which has no open database yet.
      {name: 'journalTrips', query: {cursor: '9223372036854775807', game: 'ats', outcome: 'open', completeness: 'unknown'}},
      {name: 'journalEvents', tripUuid: T.delivered, page: {limit: 500, cursor: '18446744073709551614'}}
    ];
    commands.forEach((command, index) => worker.postMessage({type: 'storage.request', id: index + 1, command}));
    await vi.waitFor(() => expect(answers).toHaveLength(commands.length));
    expect(answers.map(answer => (answer as {result: {error: {code: string}}}).result.error.code)).toEqual([...Array(12).fill('INVALID_INPUT'), 'STORAGE_CLOSED', 'STORAGE_CLOSED']);
  });
});

/**
 * ET-015a fault injection through the real worker (R13): the bundled test entry tests/storage/fixtures/fault-storage-worker.ts
 * runs the same host with an in-process commit fault inside the real transaction. Nothing of the fault crosses a message.
 */
describe('fault storage worker', () => {
  const FAULT_WORKER = path.join(bundles, 'fault-storage-worker.cjs');
  function startFaultWorker(data: {fault?: {eventSeq: string; code: string; times: number}; hold?: {eventSeq: string}; samplesFault?: {code: string; times: number} | {hold: true}; closeHold?: true}) {
    const channel = new MessageChannel();
    const worker = new Worker(FAULT_WORKER, {workerData: {kind: 'storage', ...data, control: channel.port2}, transferList: [channel.port2]});
    started.push(worker);
    const exit = once(worker, 'exit').then(([code]) => code as number);
    return {client: new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS}), control: channel.port1, exit};
  }
  const attribute: TripEffect = {kind: 'event.attribute', tripUuid: T1, attribution: 'trip'};
  const deliver: TripEffect[] = [{kind: 'trip.close', tripUuid: T1, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete',
    endedUtcMs: 1_791_676_900_000}, attribute];

  it('an injected SQLITE_FULL rolls back the event and its trip effects, is DISK_FULL, and the retry commits once (REG-007)', async () => {
    const {client, exit} = startFaultWorker({fault: {eventSeq: '2', code: 'SQLITE_FULL', times: 1}});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(ok(await client.commitEvent({message: v1('event-job-configured'), effects: [openTrip, attribute]}))).toEqual({status: 'committed', committedThroughEventSeq: '1'});
    const full = await client.commitEvent({message: withEventSeq('event-job-delivered', 2n), effects: deliver});
    expect(full).toEqual({ok: false, error: {code: 'DISK_FULL', retryable: true, message: 'The disk or the database size limit is full.', sqliteCode: 'SQLITE_FULL'}});
    // The transaction rolled back the event row, its close and its attribution; coverage did not move.
    expect(ok(await client.committedThrough(P1))).toBe('1');
    expect(ok(await client.getEvent(P1, '2'))).toBeUndefined();
    expect(ok(await client.getTrip(T1))).toMatchObject({outcome: 'open', outcomeEventSeq: null, closeReason: null, endedUtcMs: null});
    // The worker keeps serving: the retry of the same commit is stored once, with its effects.
    expect(ok(await client.commitEvent({message: withEventSeq('event-job-delivered', 2n), effects: deliver}))).toEqual({status: 'committed', committedThroughEventSeq: '2'});
    expect(ok(await client.getTrip(T1))).toMatchObject({outcome: 'delivered', outcomeEventSeq: '2', closeReason: 'outcome', endedUtcMs: 1_791_676_900_000});
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
    readOnly(ws.database, db => {
      expect(db.prepare('SELECT event_seq AS seq, type FROM events ORDER BY event_seq').all()).toEqual([{seq: '00000000000000000001', type: 'job.configured'}, {seq: '00000000000000000002', type: 'job.delivered'}]);
      expect(db.prepare('SELECT count(*) AS attributions FROM event_attributions').get()).toEqual({attributions: 2});
      expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe('ok');
    });
  });

  it.each([['SQLITE_READONLY', 'PERMISSION_DENIED', false], ['SQLITE_BUSY', 'DATABASE_LOCKED', true]] as const)('classifies an injected %s as %s and stores nothing', async (sqliteCode, code, retryable) => {
    const {client} = startFaultWorker({fault: {eventSeq: '1', code: sqliteCode, times: 1}});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    const refused = await client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]});
    expect(refused.ok ? 'ok' : [refused.error.code, refused.error.retryable, refused.error.sqliteCode]).toEqual([code, retryable, sqliteCode]);
    expect(ok(await client.committedThrough(P1))).toBe('0');
    expect(ok(await client.getTrip(T1))).toBeUndefined();
    expect(ok(await client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]})).status).toBe('committed');
    expect(await client.close()).toEqual({clean: true});
  });

  it('holds the commit covering the configured eventSeq inside its transaction until the release message', async () => {
    const {client, control, exit} = startFaultWorker({hold: {eventSeq: '1'}});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    const held = once(control, 'message');
    let answered = false;
    const commit = client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]}).then(result => { answered = true; return result; });
    const queued = client.committedThrough(P1);
    expect((await held)[0]).toEqual({type: 'held', eventSeq: '1'});
    // The worker thread is blocked inside the transaction, so neither the commit nor the command behind it is answered.
    expect(answered).toBe(false);
    control.postMessage({type: 'release'});
    expect(ok(await commit)).toEqual({status: 'committed', committedThroughEventSeq: '1'});
    expect(ok(await queued)).toBe('1');
    control.close();
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  it('an injected SQLITE_FULL in appendSamples is DISK_FULL, stores no row, and the retry appends once (ET-015b, REG-007)', async () => {
    const {client, exit} = startFaultWorker({samplesFault: {code: 'SQLITE_FULL', times: 1}});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    const batch = [sampleAt('1000000000000'), sampleAt('1001000000000')];
    const full = await client.appendSamples(P1, batch, {uniqueSeconds: true});
    expect(full).toEqual({ok: false, error: {code: 'DISK_FULL', retryable: true, message: 'The disk or the database size limit is full.', sqliteCode: 'SQLITE_FULL'}});
    // The transaction rolled back both rows.
    expect(ok(await client.listSamples({pluginSessionId: P1}))).toEqual([]);
    // The worker keeps serving: the retry stores the batch once, and a second retry finds both seconds stored.
    expect(ok(await client.appendSamples(P1, batch, {uniqueSeconds: true}))).toEqual({appended: 2, skipped: 0});
    expect(ok(await client.appendSamples(P1, batch, {uniqueSeconds: true}))).toEqual({appended: 0, skipped: 2});
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
    readOnly(ws.database, db => {
      expect(db.prepare('SELECT monotonic_ns AS ns FROM samples ORDER BY id').all()).toEqual([{ns: 1_000_000_000_000}, {ns: 1_001_000_000_000}]);
      expect(db.prepare("PRAGMA integrity_check").pluck().get()).toBe('ok');
    });
  });

  it('holds an appendSamples batch inside its transaction until the release message (ET-015b)', async () => {
    const {client, control, exit} = startFaultWorker({samplesFault: {hold: true}});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    const held = once(control, 'message');
    let answered = false;
    const append = client.appendSamples(P1, [sampleAt('1000000000000')], {uniqueSeconds: true}).then(result => { answered = true; return result; });
    const queued = client.listSamples({pluginSessionId: P1});
    expect((await held)[0]).toEqual({type: 'held', command: 'appendSamples'});
    expect(answered).toBe(false);
    control.postMessage({type: 'release'});
    expect(ok(await append)).toEqual({appended: 1, skipped: 0});
    expect(ok(await queued).map(s => s.monotonicNs)).toEqual(['1000000000000']);
    // Only the first batch is held.
    expect(ok(await client.appendSamples(P1, [sampleAt('1001000000000')], {uniqueSeconds: true}))).toEqual({appended: 1, skipped: 0});
    control.close();
    expect(await client.close()).toEqual({clean: true});
    expect(await exit).toBe(0);
  });

  // ET-019 PR-4 (G18): the close is held on the worker thread before the host receives it, so the database stays open and
  // the close unanswered until the release; then the host closes the database and the thread ends with code 0.
  it('holds the close request before the host receives it until the release message (ET-019 PR-4)', async () => {
    const {client, control, exit} = startFaultWorker({closeHold: true});
    ok(await client.open(options()));
    ok(await client.upsertSession({message: v1('welcome')}));
    expect(ok(await client.commitEvent({message: v1('event-job-configured'), effects: [openTrip]})).status).toBe('committed');
    const held = once(control, 'message');
    let answered = false;
    const closed = client.close().then(result => { answered = true; return result; });
    expect((await held)[0]).toEqual({type: 'held', command: 'close'});
    // The host has not received the close: the database is still open, so its WAL is still there.
    expect([answered, existsSync(ws.database + '-wal')]).toEqual([false, true]);
    control.postMessage({type: 'release'});
    expect(await closed).toEqual({clean: true});
    expect(await exit).toBe(0);
    control.close();
    // The released close checkpointed and closed the database.
    expect(existsSync(ws.database + '-wal')).toBe(false);
  });
});
