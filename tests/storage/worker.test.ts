// The storage worker as the telemetry service runs it: the bundled apps/desktop/src/storage-worker.ts in a real worker
// thread under the pinned Electron runtime, driven through StorageClient (REG-006, REG-007 partial).
import {chmodSync, existsSync} from 'node:fs';
import {once} from 'node:events';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import type {Result, StorageErrorCode, TripEffect} from '../../packages/storage/src/index';
import type {WorkerOpenOptions} from '../../packages/storage/src/worker/protocol';
import {ok, P1, readOnly, v1, withEventSeq, workspace} from './helpers';

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

function startWorker() {
  const worker = new Worker(WORKER, {workerData: {kind: 'storage'}});
  started.push(worker);
  const exit = once(worker, 'exit').then(([code]) => code as number);
  return {worker, client: new StorageClient(workerHandle(worker)), exit};
}
const options = (overrides: Partial<WorkerOpenOptions> = {}): WorkerOpenOptions =>
  ({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test', ...overrides});
function refused<T>(result: Result<T>, code: StorageErrorCode) {
  expect(result.ok ? 'ok' : result.error.code).toBe(code);
  // Error results cross the worker boundary with fixed text only, never a path.
  expect(JSON.stringify(result)).not.toContain(ws.directory.replaceAll('\\', '\\\\'));
}
const T1 = '70000000-0000-4000-8000-000000000001';
const openTrip: TripEffect = {kind: 'trip.open', tripUuid: T1, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'},
  jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: 1_791_676_800_000};

describe('storage worker', () => {
  it('opens, commits, reads and closes through the real worker, and a new worker reopens the same history', async () => {
    const first = startWorker();
    const summary = ok(await first.client.open(options()));
    expect(summary).toMatchObject({schemaVersion: 1, created: true, purpose: 'synthetic'});
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
    expect(await second.client.close()).toEqual({clean: true});
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
    expect(await client.close()).toEqual({clean: true});
    // Every reported commit is durable: the reopened database covers at least the last acknowledged eventSeq.
    const reopened = startWorker();
    ok(await reopened.client.open(options()));
    expect(BigInt(ok(await reopened.client.committedThrough(P1)))).toBeGreaterThanOrEqual(BigInt(firstFailure));
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
});
