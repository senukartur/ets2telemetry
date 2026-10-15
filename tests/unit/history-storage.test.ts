import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {HISTORY_CLOSE_BUDGET_MS, HISTORY_CLOSE_GRACE_MS, HistoryStorage} from '../../apps/desktop/src/history-storage';
import {SERVICE_STOP_BUDGET_MS, ShutdownSequence} from '../../apps/desktop/src/shutdown-sequence';
import type {Result, StorageErrorCode} from '../../packages/storage/src/api';
import type {StorageWorkerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import type {StorageRequest} from '../../packages/storage/src/worker/protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const SUMMARY = {schemaVersion: 1, created: true, databaseUuid: '50000000-0000-4000-8000-000000000001', purpose: 'history'};
const timers = {setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)};

/** A scripted storage worker. `open` answers with `openResult`; `close` is answered only when `answerClose` is true. */
function fixture(localAppData: string | null = 'C:\\isolated', openResult: Result<unknown> = {ok: true, value: SUMMARY}, answerClose = true) {
  const sent: StorageRequest[] = [], log = vi.fn();
  const listeners: {message?: (message: unknown) => void; error?: (error: unknown) => void; exit?: (code: number) => void} = {};
  let exited = false;
  const exit = (code: number) => { if (!exited) { exited = true; listeners.exit?.(code); } };
  const respond = (id: number, result: Result<unknown>) => queueMicrotask(() => listeners.message?.({type: 'storage.response', id, result}));
  const worker: StorageWorkerHandle = {
    postMessage: message => {
      sent.push(message);
      if (message.command.name === 'open' && openResult) respond(message.id, openResult);
      if (message.command.name === 'close' && answerClose) { respond(message.id, {ok: true, value: undefined}); queueMicrotask(() => queueMicrotask(() => exit(0))); }
    },
    onMessage: listener => { listeners.message = listener; },
    onError: listener => { listeners.error = listener; },
    onExit: listener => { listeners.exit = listener; },
    terminate: vi.fn(() => { exit(1); return Promise.resolve(1); })
  };
  const createWorker = vi.fn(() => worker);
  // null stands for an unset variable, since an omitted argument takes the default.
  const history = new HistoryStorage({localAppData: localAppData ?? undefined, appVersion: '0.1.0-test', log, createWorker, timers});
  const events = () => log.mock.calls.map(call => [call[0], call[2]]);
  return {history, sent, log, events, createWorker, worker, crash: () => listeners.error?.(new Error('worker crashed'))};
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
    await vi.advanceTimersByTimeAsync(HISTORY_CLOSE_GRACE_MS);
    await expect(result).resolves.toEqual({clean: false});
    expect(f.worker.terminate).toHaveBeenCalledOnce();
    expect(f.log.mock.calls.find(call => call[0] === 'SHUTDOWN_STEP')?.[2]).toEqual({phase: 'storage', name: 'history-storage', outcome: 'failed', ms: HISTORY_CLOSE_GRACE_MS});
    expect(f.events().map(([name]) => name)).not.toContain('HISTORY_STORAGE_CLOSED');
  });
});
