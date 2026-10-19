import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HISTORY_CLOSE_BUDGET_MS, HISTORY_CLOSE_GRACE_MS, HistoryStorage, recorderClient, type HistoryStorageOptions} from '../../apps/desktop/src/history-storage';
import {SERVICE_STOP_BUDGET_MS, ShutdownSequence} from '../../apps/desktop/src/shutdown-sequence';
import type {Result, StorageErrorCode} from '../../packages/storage/src/api';
import type {StorageClient, StorageWorkerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import type {StorageRequest} from '../../packages/storage/src/worker/protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const SUMMARY = {schemaVersion: 1, created: true, databaseUuid: '50000000-0000-4000-8000-000000000001', purpose: 'history'};
const timers = {setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setImmediate: (callback: () => void) => setImmediate(callback), clearImmediate: (handle: unknown) => clearImmediate(handle as ReturnType<typeof setImmediate>)};

/** A scripted storage worker. `open` answers with `openResult`; `close` is answered only when `answerClose` is true. */
function fixture(localAppData: string | null = 'C:\\isolated', openResult: Result<unknown> | ((attempt: number) => Result<unknown>) = {ok: true, value: SUMMARY}, answerClose = true, extra: Pick<HistoryStorageOptions, 'target' | 'onOpened' | 'onStateChange' | 'reopenBackoffMs' | 'maxReopenAttempts'> = {}) {
  const sent: StorageRequest[] = [], log = vi.fn();
  let workerCount = 0;
  let latestWorker: StorageWorkerHandle | undefined;
  const workers: {
    worker: StorageWorkerHandle;
    respond: (id: number, result: Result<unknown>) => void;
    finishClose: (id: number) => void;
    crash: () => void;
  }[] = [];

  const createWorker = vi.fn(() => {
    const attempt = workerCount++;
    const listeners: {message?: (message: unknown) => void; error?: (error: unknown) => void; exit?: (code: number) => void} = {};
    let exited = false;
    const exit = (code: number) => { if (!exited) { exited = true; listeners.exit?.(code); } };
    const respond = (id: number, result: Result<unknown>) => queueMicrotask(() => listeners.message?.({type: 'storage.response', id, result}));
    const worker: StorageWorkerHandle = {
      postMessage: message => {
        sent.push(message);
        if (message.command.name === 'open') {
          const res = typeof openResult === 'function' ? openResult(attempt) : openResult;
          if (res) respond(message.id, res);
        }
        if (message.command.name === 'close' && answerClose) {
          respond(message.id, {ok: true, value: undefined});
          queueMicrotask(() => queueMicrotask(() => exit(0)));
        }
      },
      onMessage: listener => { listeners.message = listener; },
      onError: listener => { listeners.error = listener; },
      onExit: listener => { listeners.exit = listener; },
      terminate: vi.fn(() => { exit(1); return Promise.resolve(1); })
    };
    latestWorker = worker;
    const finishClose = (id: number) => { listeners.message?.({type: 'storage.response', id, result: {ok: true, value: undefined}}); exit(0); };
    const crash = () => listeners.error?.(new Error('worker crashed'));
    workers.push({worker, respond, finishClose, crash});
    return worker;
  });

  // null stands for an unset variable, since an omitted argument takes the default.
  const history = new HistoryStorage({localAppData: localAppData ?? undefined, appVersion: '0.1.0-test', log, createWorker, timers, ...extra});
  const events = () => log.mock.calls.map(call => [call[0], call[2]]);

  return {
    history, sent, log, events, createWorker,
    get worker() { return latestWorker!; },
    respond: (id: number, result: Result<unknown>) => workers.at(-1)?.respond(id, result),
    finishClose: (id: number) => workers.at(-1)?.finishClose(id),
    crash: () => workers.at(-1)?.crash(),
    workers
  };
}

describe('history storage at service start (OD-2)', () => {
  it('opens the production history database under LOCALAPPDATA without waiting for it', async () => {
    const f = fixture();
    f.history.start();
    // start returned before the worker answered: live telemetry never waits for storage.
    expect(f.history.state).toBe('opening');
    expect(f.sent.map(request => request.command)).toEqual([{name: 'open', options: {
      path: 'C:\\isolated\\ETS2Telemetry\\data\\telemetry.sqlite', purpose: 'history', backupsDirectory: 'C:\\isolated\\ETS2Telemetry\\backups', appVersion: '0.1.0-test'}}]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.history.state).toBe('open');
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}]]);
  });
  it('reports a migrated database with its source version', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: {...SUMMARY, created: false, migratedFrom: 1, schemaVersion: 2, backupFileName: 'telemetry-50000000-v1-x.sqlite'}});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 2, created: false, migratedFrom: 1}]]);
  });
  it('reports how many stale partial backup files the open removed, as a count only', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: {...SUMMARY, created: false, removedPartialBackups: 3}});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: false, migratedFrom: null}], ['HISTORY_BACKUP_PARTIALS_REMOVED', {count: 3}]]);
    expect('HISTORY_BACKUP_PARTIALS_REMOVED').not.toMatch(/FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/);
  });
  it.each([['missing', null], ['empty', ''], ['relative', 'relative\\profile'], ['drive-relative', 'C:profile']])(
    'never falls back to TEMP or the working directory when LOCALAPPDATA is %s', async (_name, localAppData) => {
      const f = fixture(localAppData);
      f.history.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.createWorker).not.toHaveBeenCalled();
      expect(f.history.state).toBe('unavailable');
      expect(f.events()).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code: 'DATA_PATH_INVALID'}]]);
      await expect(f.history.close()).resolves.toBeUndefined();
      expect(f.events()).toHaveLength(1);
    });
  it.each<StorageErrorCode>(['SCHEMA_NEWER', 'DATABASE_LOCKED', 'DATABASE_UNRECOGNIZED', 'MIGRATION_FAILED'])('stays unavailable with %s and ends the worker', async code => {
    const f = fixture('C:\\isolated', {ok: false, error: storageError(code)});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.history.state).toBe('unavailable');
    expect(f.sent.map(request => request.command.name)).toEqual(['open', 'close']);
    await f.history.close();
    expect(f.events()).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code}]]);
  });
  it('reports a worker that cannot be created', () => {
    const f = fixture();
    f.createWorker.mockImplementation(() => { throw new Error('Missing physical storage worker entrypoint'); });
    f.history.start();
    expect(f.events()).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code: 'WORKER_FAILED'}]]);
  });
  it('reports a worker crash after open once, never as a success', async () => {
    const f = fixture();
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    f.crash(); f.crash();
    expect(f.history.state).toBe('unavailable');
    // The database was not closed in order, so the shutdown step must not report success (PR #60 review).
    await expect(f.history.close()).rejects.toThrow('History storage did not close cleanly');
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}], ['HISTORY_STORAGE_UNAVAILABLE', {code: 'WORKER_FAILED'}]]);
  });
  it('fails the shutdown step after a worker crash earlier in the session', async () => {
    const f = fixture();
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    f.crash();
    const sequence = new ShutdownSequence(f.log, {...timers, now: () => Date.now()});
    sequence.register('storage', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => f.history.close()});
    await expect(sequence.run()).resolves.toEqual({clean: false});
    expect(f.log.mock.calls.find(call => call[0] === 'SHUTDOWN_STEP')?.[2]).toMatchObject({phase: 'storage', name: 'history-storage', outcome: 'failed'});
  });
  it('uses fixed event names that the smoke diagnostics never treat as failures', async () => {
    const opened = fixture(), refused = fixture('C:\\isolated', {ok: false, error: storageError('DATABASE_LOCKED')});
    opened.history.start(); refused.history.start(); await vi.advanceTimersByTimeAsync(0);
    await opened.history.close(); await refused.history.close();
    const names = [...opened.events(), ...refused.events()].map(([name]) => name as string);
    expect(new Set(names)).toEqual(new Set(['HISTORY_STORAGE_OPENED', 'HISTORY_STORAGE_CLOSED', 'HISTORY_STORAGE_UNAVAILABLE']));
    for (const name of names) expect(name).not.toMatch(/FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/);
  });
});

describe('history storage shutdown step', () => {
  it('fits the storage phase beside the probe within the service stop budget', () => {
    expect(HISTORY_CLOSE_GRACE_MS).toBeLessThan(HISTORY_CLOSE_BUDGET_MS);
    const sequence = new ShutdownSequence(vi.fn());
    sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
    sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: () => undefined});
    sequence.register('storage', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => undefined});
    expect(sequence.budgetMs).toBeLessThanOrEqual(SERVICE_STOP_BUDGET_MS);
  });
  it('resolves only after the worker closed the database and its thread ended', async () => {
    const f = fixture();
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    let settled = false;
    const closing = f.history.close().then(() => { settled = true; });
    expect(settled).toBe(false);
    expect(f.sent.map(request => request.command.name)).toEqual(['open', 'close']);
    await closing;
    expect(f.history.state).toBe('closed');
    expect(f.events().at(-1)).toEqual(['HISTORY_STORAGE_CLOSED', undefined]);
    expect(f.worker.terminate).not.toHaveBeenCalled();
  });
  it('lets a running open finish before closing', async () => {
    const f = fixture();
    f.history.start();
    await f.history.close();
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}], ['HISTORY_STORAGE_CLOSED', undefined]]);
  });
  it('fails the step when the worker has to be terminated, inside the step budget', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, false);
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    const sequence = new ShutdownSequence(f.log, {...timers, now: () => Date.now()});
    sequence.register('storage', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => f.history.close()});
    const result = sequence.run();
    // Requirement change (October 18, 2026): the verdict runs one event-loop turn after the grace, an immediate that the
    // fake clock schedules 1 ms later.
    await vi.advanceTimersByTimeAsync(HISTORY_CLOSE_GRACE_MS + 1);
    await expect(result).resolves.toEqual({clean: false});
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(f.log.mock.calls.find(call => call[0] === 'SHUTDOWN_STEP')?.[2]).toEqual({phase: 'storage', name: 'history-storage', outcome: 'failed', ms: HISTORY_CLOSE_GRACE_MS + 1});
    expect(f.events().map(([name]) => name)).not.toContain('HISTORY_STORAGE_CLOSED');
  });
  // Regression (packaged recording smoke, October 18, 2026): run B logged `history-storage` failed at 807 ms, just past
  // the 800 ms grace, while the service used almost no CPU. A service thread that was stalled past the grace runs the due
  // grace timer before it delivers the close answer and exit that arrived meanwhile. They now still count.
  it('keeps the step ok when the close answer and exit wait behind the due grace timer', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, false);
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    const sequence = new ShutdownSequence(f.log, {...timers, now: () => Date.now()});
    sequence.register('storage', {name: 'history-storage', budgetMs: HISTORY_CLOSE_BUDGET_MS, run: () => f.history.close()});
    const result = sequence.run();
    await vi.advanceTimersByTimeAsync(0);
    const close = f.sent.find(request => request.command.name === 'close');
    expect(close).toBeDefined();
    // Only the grace timer runs, as when the stalled thread resumes; then the late poll phase delivers the worker's work.
    vi.advanceTimersToNextTimer();
    f.finishClose(close!.id);
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({clean: true});
    expect(f.worker.terminate).not.toHaveBeenCalled();
    expect(f.log.mock.calls.find(call => call[0] === 'SHUTDOWN_STEP')?.[2]).toEqual({phase: 'storage', name: 'history-storage', outcome: 'ok', ms: HISTORY_CLOSE_GRACE_MS});
    expect(f.events().map(([name]) => name)).toContain('HISTORY_STORAGE_CLOSED');
    expect(f.history.state).toBe('closed');
  });
});

describe('recording target and the trip recorder client (ET-015a, R3, R10)', () => {
  it.each([['synthetic', 't'], ['replay', 'smoke-01']] as const)('opens the %s target %s in the synthetic directory instead of history', async (purpose, name) => {
    const f = fixture('C:\\isolated', {ok: true, value: {...SUMMARY, purpose}}, true, {target: {purpose, name}});
    f.history.start();
    expect(f.sent.map(request => request.command)).toEqual([{name: 'open', options: {
      path: `C:\\isolated\\ETS2Telemetry\\synthetic\\${name}.sqlite`, purpose, backupsDirectory: 'C:\\isolated\\ETS2Telemetry\\synthetic\\backups', appVersion: '0.1.0-test'}}]);
    await vi.advanceTimersByTimeAsync(0);
    await f.history.close();
    // The target's purpose first, then the same fixed codes and facts as history mode.
    expect(f.events()).toEqual([['RECORDING_TARGET', {purpose}], ['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}], ['HISTORY_STORAGE_CLOSED', undefined]]);
  });
  it('keeps history mode unchanged with an explicit history target', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {target: {purpose: 'history'}});
    f.history.start();
    expect(f.sent.map(request => request.command)).toEqual([{name: 'open', options: {
      path: 'C:\\isolated\\ETS2Telemetry\\data\\telemetry.sqlite', purpose: 'history', backupsDirectory: 'C:\\isolated\\ETS2Telemetry\\backups', appVersion: '0.1.0-test'}}]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.events()).toEqual([['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}]]);
  });
  it.each(['', 'A', '..', '../data/telemetry', 'telemetry.sqlite', 'a\\b', 'a'.repeat(65)])('refuses a target name %j that the policy would never produce, without a worker', async name => {
    const f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {target: {purpose: 'synthetic', name}});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.createWorker).not.toHaveBeenCalled();
    expect([f.history.state, f.history.client]).toEqual(['unavailable', undefined]);
    expect(f.events()).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_UNAVAILABLE', {code: 'DATA_PATH_INVALID'}]]);
  });
  it('refuses a synthetic target without LOCALAPPDATA like history', async () => {
    const f = fixture(null, {ok: true, value: SUMMARY}, true, {target: {purpose: 'synthetic', name: 't'}});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.createWorker).not.toHaveBeenCalled();
    expect(f.events()).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_UNAVAILABLE', {code: 'DATA_PATH_INVALID'}]]);
  });
  it('exposes the client only while the database is open and reports the open once', async () => {
    const onOpened = vi.fn(), f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {onOpened});
    expect(f.history.client).toBeUndefined();
    f.history.start();
    expect([f.history.state, f.history.client, onOpened.mock.calls.length]).toEqual(['opening', undefined, 0]);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.history.state).toBe('open'); expect(f.history.client).toBeDefined(); expect(onOpened).toHaveBeenCalledOnce();
    // The open is reported after HISTORY_STORAGE_OPENED, so the log shows the open before any durable reconnection.
    expect(onOpened.mock.invocationCallOrder[0]).toBeGreaterThan(f.log.mock.invocationCallOrder[0]);
    await f.history.close();
    expect([f.history.state, f.history.client, onOpened.mock.calls.length]).toEqual(['closed', undefined, 1]);
  });
  it('never reports a refused open or a crashed worker as open', async () => {
    const onOpened = vi.fn(), refused = fixture('C:\\isolated', {ok: false, error: storageError('PERMISSION_DENIED')}, true, {target: {purpose: 'synthetic', name: 't'}, onOpened});
    refused.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect([refused.history.state, refused.history.client]).toEqual(['unavailable', undefined]);
    expect(refused.events()).toEqual([['RECORDING_TARGET', {purpose: 'synthetic'}], ['HISTORY_STORAGE_UNAVAILABLE', {code: 'PERMISSION_DENIED'}]]);
    expect(onOpened).not.toHaveBeenCalled();
    const crashed = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {onOpened});
    crashed.history.start(); await vi.advanceTimersByTimeAsync(0); crashed.crash();
    expect([crashed.history.state, crashed.history.client, onOpened.mock.calls.length]).toEqual(['unavailable', undefined, 1]);
  });
  it('answers every recorder command with STORAGE_CLOSED while no database is open, and forwards it while one is', async () => {
    const source: {client: StorageClient | undefined} = {client: undefined}, client = recorderClient(source);
    const welcome = {kind: 'welcome'}, interval = {kind: 'restore-loss' as const, firstEventSeq: '3', lastEventSeq: '5'};
    const calls = () => [
      client.upsertSession({message: welcome}), client.committedThrough('s'), client.commitEvent({message: {kind: 'event'}}), client.commitGap({message: {kind: 'gap'}}),
      client.recordCompleteness('s', interval, {ifAbsent: true}), client.listTrips({game: 'ets2', outcome: 'open'}), client.getEvent('s', '1'), client.listEvents('s', {afterEventSeq: '0', limit: 500})
    ];
    for (const result of await Promise.all(calls())) expect(result).toEqual({ok: false, error: storageError('STORAGE_CLOSED')});
    const received: unknown[][] = [];
    const answer = (name: string) => (...args: unknown[]) => { received.push([name, ...args]); return Promise.resolve({ok: true, value: name}); };
    source.client = Object.fromEntries(['upsertSession', 'committedThrough', 'commitEvent', 'commitGap', 'recordCompleteness', 'listTrips', 'getEvent', 'listEvents']
      .map(name => [name, answer(name)])) as unknown as StorageClient;
    expect((await Promise.all(calls())).map(result => result.ok && result.value)).toEqual(['upsertSession', 'committedThrough', 'commitEvent', 'commitGap', 'recordCompleteness', 'listTrips', 'getEvent', 'listEvents']);
    expect(received).toEqual([
      ['upsertSession', {message: welcome}], ['committedThrough', 's'], ['commitEvent', {message: {kind: 'event'}}], ['commitGap', {message: {kind: 'gap'}}],
      ['recordCompleteness', 's', interval, {ifAbsent: true}], ['listTrips', {game: 'ets2', outcome: 'open'}], ['getEvent', 's', '1'], ['listEvents', 's', {afterEventSeq: '0', limit: 500}]
    ]);
  });
  it('answers appendSamples with STORAGE_CLOSED while no database is open, and forwards it with its options while one is (ET-015b)', async () => {
    const source: {client: StorageClient | undefined} = {client: undefined}, client = recorderClient(source);
    expect(await client.appendSamples('s', [], {uniqueSeconds: true})).toEqual({ok: false, error: storageError('STORAGE_CLOSED')});
    const received: unknown[][] = [];
    source.client = {appendSamples: (...args: unknown[]) => { received.push(args); return Promise.resolve({ok: true, value: {appended: 0, skipped: 0}}); }} as unknown as StorageClient;
    expect(await client.appendSamples('s', [], {uniqueSeconds: true})).toEqual({ok: true, value: {appended: 0, skipped: 0}});
    expect(received).toEqual([['s', [], {uniqueSeconds: true}]]);
  });
});

// ET-015c (G3, G10): the recording status reads the database state, each change of it and the code of its failure.
describe('history storage state for the recording status (ET-015c)', () => {
  it('reports each state change once and no failure code for an open and an orderly close', async () => {
    const states: string[] = [], f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {onStateChange: state => states.push(state)});
    expect([f.history.state, f.history.failureCode]).toEqual(['idle', null]);
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    await f.history.close();
    expect([states, f.history.failureCode]).toEqual([['opening', 'open', 'closed'], null]);
  });
  it.each<[string, string | null, Result<unknown>, string[], StorageErrorCode]>([
    ['a refused open', 'C:\\isolated', {ok: false, error: storageError('SCHEMA_NEWER')}, ['opening', 'unavailable'], 'SCHEMA_NEWER'],
    ['a missing LOCALAPPDATA', null, {ok: true, value: SUMMARY}, ['unavailable'], 'DATA_PATH_INVALID']
  ])('keeps the first failure code after %s', async (_name, localAppData, openResult, expected, code) => {
    const states: string[] = [], f = fixture(localAppData, openResult, true, {onStateChange: state => states.push(state)});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    expect([states, f.history.failureCode]).toEqual([expected, code]);
    await f.history.close();
    expect(f.history.failureCode).toBe(code);
  });
  it('reports a worker crash after the open as unavailable with WORKER_FAILED', async () => {
    const states: string[] = [], f = fixture('C:\\isolated', {ok: true, value: SUMMARY}, true, {onStateChange: state => states.push(state)});
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    f.crash(); f.crash();
    expect([states, f.history.failureCode]).toEqual([['opening', 'open', 'unavailable'], 'WORKER_FAILED']);
  });
});

describe('the database the journal reads (ET-016 PR-3, J3, J4)', () => {
  it('names the open database purpose and schema version only while it is open', async () => {
    const f = fixture('C:\\isolated', {ok: true, value: {...SUMMARY, purpose: 'synthetic', schemaVersion: 2}}, true, {target: {purpose: 'synthetic', name: 't'}});
    expect(f.history.database).toBeUndefined();
    f.history.start();
    expect(f.history.database).toBeUndefined();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.history.database).toEqual({purpose: 'synthetic', schemaVersion: 2});
    // ET-016 PR-5: the export header names the database UUID of the open summary, also only while it is open.
    expect(f.history.databaseUuid).toBe('50000000-0000-4000-8000-000000000001');
    await f.history.close();
    expect(f.history.database).toBeUndefined();
    expect(f.history.databaseUuid).toBeUndefined();
  });
  it('names no database after a failure', async () => {
    const f = fixture();
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    f.crash();
    expect([f.history.state, f.history.database, f.history.databaseUuid]).toEqual(['unavailable', undefined, undefined]);
  });
  it('logs a journal answer that broke the contract as a counted fixed code and keeps the database open', async () => {
    const f = fixture();
    f.history.start(); await vi.advanceTimersByTimeAsync(0);
    for (let read = 0; read < 3; read++) {
      const answer = f.history.client!.journalTrips();
      const request = f.sent.at(-1)!;
      expect(request.command).toEqual({name: 'journalTrips'});
      // A well-framed answer whose page carries a field the contract does not list.
      f.respond(request.id, {ok: true, value: {database: {purpose: 'history', schemaVersion: 1}, trips: [], nextCursor: null, path: 'C:\\Users\\owner'}});
      await expect(answer).resolves.toMatchObject({ok: false, error: {code: 'JOURNAL_ANSWER_INVALID'}});
    }
    expect(f.events().filter(([event]) => event === 'JOURNAL_ANSWER_INVALID')).toEqual([['JOURNAL_ANSWER_INVALID', {command: 'journalTrips', count: 1}],
      ['JOURNAL_ANSWER_INVALID', {command: 'journalTrips', count: 2}]]);
    expect([f.history.state, f.history.failureCode, f.history.client?.state]).toEqual(['open', null, 'running']);
  });
});

describe('re-opening history storage after a recoverable stop (ET-037)', () => {
  it.each<StorageErrorCode>(['DATABASE_LOCKED', 'DISK_FULL', 'IO_ERROR'])(
    'schedules retry with backoff on %s and re-opens when subsequent attempt succeeds',
    async code => {
      const onOpened = vi.fn();
      const states: string[] = [];
      const f = fixture(
        'C:\\isolated',
        attempt => (attempt === 0 ? {ok: false, error: storageError(code)} : {ok: true, value: SUMMARY}),
        true,
        {onOpened, onStateChange: s => states.push(s)}
      );
      f.history.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.history.state).toBe('unavailable');
      expect(f.history.failureCode).toBe(code);
      expect(f.createWorker).toHaveBeenCalledTimes(1);
      expect(onOpened).not.toHaveBeenCalled();

      // At 249 ms, retry has not fired yet
      await vi.advanceTimersByTimeAsync(249);
      expect(f.createWorker).toHaveBeenCalledTimes(1);
      expect(f.history.state).toBe('unavailable');

      // At 250 ms, first retry fires and succeeds
      await vi.advanceTimersByTimeAsync(1);
      expect(f.createWorker).toHaveBeenCalledTimes(2);
      expect(f.history.state).toBe('open');
      expect(f.history.failureCode).toBeNull();
      expect(f.history.client).toBeDefined();
      expect(onOpened).toHaveBeenCalledOnce();
      expect(states).toEqual(['opening', 'unavailable', 'opening', 'open']);
      expect(f.events()).toEqual([
        ['HISTORY_STORAGE_UNAVAILABLE', {code}],
        ['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}]
      ]);

      await f.history.close();
      expect(f.history.state).toBe('closed');
      expect(f.events().at(-1)).toEqual(['HISTORY_STORAGE_CLOSED', undefined]);
    }
  );

  it('schedules retry on BACKUP_FAILED with retryable cause and re-opens when subsequent attempt succeeds', async () => {
    const onOpened = vi.fn();
    const states: string[] = [];
    const backupError = storageError('BACKUP_FAILED', {cause: 'DATABASE_LOCKED'});
    const f = fixture(
      'C:\\isolated',
      attempt => (attempt === 0 ? {ok: false, error: backupError} : {ok: true, value: SUMMARY}),
      true,
      {onOpened, onStateChange: s => states.push(s)}
    );
    f.history.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.history.state).toBe('unavailable');
    expect(f.history.failureCode).toBe('BACKUP_FAILED');
    expect(f.createWorker).toHaveBeenCalledTimes(1);
    expect(onOpened).not.toHaveBeenCalled();

    // At 249 ms, retry has not fired yet
    await vi.advanceTimersByTimeAsync(249);
    expect(f.createWorker).toHaveBeenCalledTimes(1);
    expect(f.history.state).toBe('unavailable');

    // At 250 ms, first retry fires and succeeds
    await vi.advanceTimersByTimeAsync(1);
    expect(f.createWorker).toHaveBeenCalledTimes(2);
    expect(f.history.state).toBe('open');
    expect(f.history.failureCode).toBeNull();
    expect(f.history.client).toBeDefined();
    expect(onOpened).toHaveBeenCalledOnce();
    expect(states).toEqual(['opening', 'unavailable', 'opening', 'open']);
    expect(f.events()).toEqual([
      ['HISTORY_STORAGE_UNAVAILABLE', {code: 'BACKUP_FAILED'}],
      ['HISTORY_STORAGE_OPENED', {schemaVersion: 1, created: true, migratedFrom: null}]
    ]);

    await f.history.close();
    expect(f.history.state).toBe('closed');
    expect(f.events().at(-1)).toEqual(['HISTORY_STORAGE_CLOSED', undefined]);
  });

  it.each<StorageErrorCode>(['SCHEMA_NEWER', 'DATABASE_UNRECOGNIZED', 'PURPOSE_MISMATCH', 'PERMISSION_DENIED'])(
    'never schedules retry for non-retryable open refusal %s',
    async code => {
      const f = fixture('C:\\isolated', {ok: false, error: storageError(code)});
      f.history.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.history.state).toBe('unavailable');
      expect(f.history.failureCode).toBe(code);
      expect(f.createWorker).toHaveBeenCalledTimes(1);

      // Advance past max backoff delays
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.createWorker).toHaveBeenCalledTimes(1);
      expect(f.history.state).toBe('unavailable');
      expect(f.events()).toEqual([['HISTORY_STORAGE_UNAVAILABLE', {code}]]);

      await f.history.close();
      expect(f.history.state).toBe('closed');
    }
  );

  it('cancels pending retry timer and closes cleanly on orderly close()', async () => {
    const f = fixture('C:\\isolated', {ok: false, error: storageError('DATABASE_LOCKED')});
    f.history.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.history.state).toBe('unavailable');
    expect(f.createWorker).toHaveBeenCalledTimes(1);

    // Close while waiting for retry timer
    await f.history.close();
    expect(f.history.state).toBe('closed');

    // Advancing timers should not spawn any new worker
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.createWorker).toHaveBeenCalledTimes(1);
    expect(f.history.state).toBe('closed');
  });

  it('stops retrying and stays unavailable when maxReopenAttempts is exhausted', async () => {
    const states: string[] = [];
    const f = fixture(
      'C:\\isolated',
      {ok: false, error: storageError('DATABASE_LOCKED')},
      true,
      {maxReopenAttempts: 3, reopenBackoffMs: [100, 200, 300], onStateChange: s => states.push(s)}
    );
    f.history.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.createWorker).toHaveBeenCalledTimes(1); // initial attempt
    expect(f.history.state).toBe('unavailable');

    // Retry 1: after 100 ms
    await vi.advanceTimersByTimeAsync(100);
    expect(f.createWorker).toHaveBeenCalledTimes(2);
    expect(f.history.state).toBe('unavailable');

    // Retry 2: after 200 ms
    await vi.advanceTimersByTimeAsync(200);
    expect(f.createWorker).toHaveBeenCalledTimes(3);
    expect(f.history.state).toBe('unavailable');

    // Retry 3: after 300 ms
    await vi.advanceTimersByTimeAsync(300);
    expect(f.createWorker).toHaveBeenCalledTimes(4); // 3 retries executed
    expect(f.history.state).toBe('unavailable');

    // Attempts exhausted; advancing further does not spawn more workers
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.createWorker).toHaveBeenCalledTimes(4);
    expect(f.history.state).toBe('unavailable');
    expect(f.history.failureCode).toBe('DATABASE_LOCKED');
    expect(f.events()).toContainEqual(['HISTORY_STORAGE_REOPEN_EXHAUSTED', {attempts: 3, code: 'DATABASE_LOCKED'}]);

    await f.history.close();
    expect(f.history.state).toBe('closed');
  });
});
