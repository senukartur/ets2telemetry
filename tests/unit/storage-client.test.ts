import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {Result, StorageError, StorageErrorCode} from '../../packages/storage/src/api';
import {COMMAND_DEADLINE_MS, MAX_QUEUED_COMMANDS, OPEN_DEADLINE_MS, StorageClient, type StorageClientOptions, type StorageWorkerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import {parseRequest, type StorageRequest} from '../../packages/storage/src/worker/protocol';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const P1 = '10000000-0000-4000-8000-000000000001';
const OPEN = {path: 'C:\\isolated\\ETS2Telemetry\\synthetic\\test.sqlite', purpose: 'synthetic' as const, backupsDirectory: 'C:\\isolated\\ETS2Telemetry\\synthetic\\backups', appVersion: '0.1.0-test'};
const SUMMARY = {schemaVersion: 1, created: true, databaseUuid: '50000000-0000-4000-8000-000000000001', purpose: 'synthetic'};
const COMMITTED = {status: 'committed', committedThroughEventSeq: '1'};

/** A scripted worker: it records requests, and the test answers, fails or ends it explicitly. */
function fixture(options: StorageClientOptions = {}) {
  const sent: StorageRequest[] = [];
  const listeners: {message?: (message: unknown) => void; error?: (error: unknown) => void; exit?: (code: number) => void} = {};
  let exited = false;
  const exit = (code: number) => { if (exited) return; exited = true; listeners.exit?.(code); };
  const handle: StorageWorkerHandle = {
    postMessage: message => { sent.push(structuredClone(message)); },
    onMessage: listener => { listeners.message = listener; },
    onError: listener => { listeners.error = listener; },
    onExit: listener => { listeners.exit = listener; },
    // Like worker_threads: termination ends the thread with exit code 1 before the promise resolves.
    terminate: vi.fn(() => { exit(1); return Promise.resolve(1); })
  };
  const failures: StorageError[] = [];
  const client = new StorageClient(handle, {onFailure: error => failures.push(error), ...options});
  return {
    client, sent, handle, failures,
    reply(id: number, result: Result<unknown>) { listeners.message?.({type: 'storage.response', id, result}); },
    ok(id: number, value: unknown) { listeners.message?.({type: 'storage.response', id, result: {ok: true, value}}); },
    raw(message: unknown) { listeners.message?.(message); },
    error() { listeners.error?.(new Error('worker crashed')); },
    exit
  };
}
/** Tracks a promise's settlement without awaiting it. */
function track<T>(promise: Promise<T>) {
  const state: {value?: T} = {};
  void promise.then(value => { state.value = value; });
  return state;
}
const code = (result: Result<unknown> | undefined) => result && !result.ok ? result.error.code : result?.ok ? 'ok' : 'pending';
const error = (value: StorageErrorCode) => ({ok: false, error: storageError(value)});

describe('StorageClient command flow', () => {
  it('sends one command at a time with monotonic request ids and returns each result', async () => {
    const f = fixture();
    const first = f.client.committedThrough(P1), second = f.client.committedThrough(P1), third = f.client.storageInfo();
    expect(f.sent.map(request => [request.id, request.command.name])).toEqual([[1, 'committedThrough']]);
    f.ok(1, '5');
    await expect(first).resolves.toEqual({ok: true, value: '5'});
    expect(f.sent.map(request => request.id)).toEqual([1, 2]);
    f.ok(2, '6'); await expect(second).resolves.toEqual({ok: true, value: '6'});
    f.ok(3, {schemaVersion: 1}); await expect(third).resolves.toEqual({ok: true, value: {schemaVersion: 1}});
    expect(f.sent.map(request => request.id)).toEqual([1, 2, 3]);
    // Every request is a well-formed storage request.
    for (const request of f.sent) expect(parseRequest(request).ok).toBe(true);
  });
  it('copies only the four open fields: in-process test hooks and migrations never reach the worker', () => {
    const f = fixture();
    void f.client.open({...OPEN, testHooks: {beforeCommit: () => undefined}, migrations: []} as unknown as typeof OPEN);
    expect(f.sent[0].command).toEqual({name: 'open', options: OPEN});
  });
  it(`queues ${MAX_QUEUED_COMMANDS} commands behind the one in flight and refuses the next with STORAGE_BUSY`, async () => {
    const f = fixture();
    const accepted = Array.from({length: MAX_QUEUED_COMMANDS + 1}, () => f.client.committedThrough(P1));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('STORAGE_BUSY'));
    expect(storageError('STORAGE_BUSY').retryable).toBe(true);
    expect(f.sent).toHaveLength(1);
    for (let id = 1; id <= accepted.length; id++) f.ok(id, String(id));
    expect((await Promise.all(accepted)).map(result => result.ok && result.value)).toEqual(accepted.map((_, index) => String(index + 1)));
    expect(f.sent).toHaveLength(MAX_QUEUED_COMMANDS + 1);
  });
  it('passes a storage error through and keeps serving: a failed commit is not a worker failure', async () => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    f.reply(1, error('DISK_FULL') as Result<unknown>);
    await expect(commit).resolves.toEqual(error('DISK_FULL'));
    const retry = f.client.commitEvent({message: {}});
    f.ok(2, COMMITTED);
    await expect(retry).resolves.toEqual({ok: true, value: COMMITTED});
    expect(f.failures).toEqual([]);
    expect(f.client.state).toBe('running');
  });
});

describe('StorageClient deadlines and worker failures', () => {
  it(`times out a command after ${COMMAND_DEADLINE_MS} ms, terminates the worker and never reports a later success`, async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitEvent({message: {}}));
    await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS - 1);
    expect(code(commit.value)).toBe('pending');
    await vi.advanceTimersByTimeAsync(1);
    expect(commit.value).toEqual(error('TIMEOUT'));
    expect(queued.value).toEqual(error('WORKER_FAILED'));
    expect(f.handle.terminate).toHaveBeenCalledOnce();
    expect(f.failures.map(failure => failure.code)).toEqual(['TIMEOUT']);
    // The late answer of the timed-out commit is ignored; it never becomes a commit result.
    f.ok(1, COMMITTED);
    expect(commit.value).toEqual(error('TIMEOUT'));
    await expect(f.client.commitEvent({message: {}})).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.sent).toHaveLength(1);
  });
  it(`allows open ${OPEN_DEADLINE_MS} ms for a verified backup and migration`, async () => {
    const f = fixture();
    const open = track(f.client.open(OPEN));
    await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS - 1);
    expect(code(open.value)).toBe('pending');
    f.ok(1, SUMMARY);
    await vi.advanceTimersByTimeAsync(0);
    expect(open.value).toEqual({ok: true, value: SUMMARY});
    const slow = track(f.client.open(OPEN));
    await vi.advanceTimersByTimeAsync(OPEN_DEADLINE_MS);
    expect(slow.value).toEqual(error('TIMEOUT'));
  });
  it('fails the command in flight and every queued command when the worker errors, and ignores a later answer', async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitGap({message: {}}));
    f.error();
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(queued.value).toEqual(error('WORKER_FAILED'));
    f.ok(1, COMMITTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
    expect(f.client.state).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('fails closed when the worker exits unexpectedly', async () => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    f.exit(0);
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
  });
  it.each([
    ['an answer for another request id', (f: ReturnType<typeof fixture>) => f.ok(2, COMMITTED)],
    ['a commit result with a numeric coverage', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'committed', committedThroughEventSeq: 1})],
    ['a commit result with an unknown status', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'stored', committedThroughEventSeq: '1'})],
    ['an event commit reported as covered', (f: ReturnType<typeof fixture>) => f.ok(1, {status: 'covered', committedThroughEventSeq: '1'})],
    ['an error with an unknown code', (f: ReturnType<typeof fixture>) => f.reply(1, {ok: false, error: {code: 'LOST' as StorageErrorCode, retryable: true, message: 'x'}})],
    ['a message that is not a response', (f: ReturnType<typeof fixture>) => f.raw({type: 'verified'})]
  ])('fails closed on %s', async (_name, answer) => {
    const f = fixture();
    const commit = f.client.commitEvent({message: {}});
    answer(f);
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
  it('fails closed on an unsolicited message while nothing is in flight', () => {
    const f = fixture();
    f.ok(1, COMMITTED);
    expect(f.client.state).toBe('failed');
    expect(f.failures.map(failure => failure.code)).toEqual(['WORKER_FAILED']);
  });
});

describe('StorageClient close', () => {
  it('finishes the command in flight, refuses queued and new commands, then closes and waits for the thread to end', async () => {
    const f = fixture();
    const commit = track(f.client.commitEvent({message: {}})), queued = track(f.client.commitEvent({message: {}}));
    const closed = track(f.client.close());
    await vi.advanceTimersByTimeAsync(0);
    expect(queued.value).toEqual(error('STORAGE_CLOSED'));
    await expect(f.client.committedThrough(P1)).resolves.toEqual(error('STORAGE_CLOSED'));
    expect(f.sent.map(request => request.command.name)).toEqual(['commitEvent']);
    f.ok(1, COMMITTED);
    await vi.advanceTimersByTimeAsync(0);
    expect(commit.value).toEqual({ok: true, value: COMMITTED});
    expect(f.sent.map(request => [request.id, request.command.name])).toEqual([[1, 'commitEvent'], [2, 'close']]);
    f.ok(2, undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toBeUndefined();
    f.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(closed.value).toEqual({clean: true});
    expect(f.client.state).toBe('closed');
    expect(f.handle.terminate).not.toHaveBeenCalled();
    expect(f.failures).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.client.close()).toBe(f.client.close());
  });
  it('terminates the worker after the close grace; the command in flight never succeeds', async () => {
    const f = fixture({closeGraceMs: 800});
    const commit = track(f.client.commitEvent({message: {}}));
    const closed = track(f.client.close());
    await vi.advanceTimersByTimeAsync(799);
    expect(closed.value).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(closed.value).toEqual({clean: false});
    expect(f.handle.terminate).toHaveBeenCalledOnce();
    f.ok(1, COMMITTED);
    expect(commit.value).toEqual(error('WORKER_FAILED'));
    expect(vi.getTimerCount()).toBe(0);
  });
  it('is not clean when the worker exits before acknowledging the close or refuses it', async () => {
    const early = fixture();
    const first = track(early.client.close());
    early.exit(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.value).toEqual({clean: false});
    const refused = fixture();
    const second = track(refused.client.close());
    refused.reply(1, error('IO_ERROR') as Result<unknown>);
    await vi.advanceTimersByTimeAsync(0);
    expect(second.value).toEqual({clean: false});
    expect(refused.handle.terminate).toHaveBeenCalledOnce();
  });
  // Requirement change (PR #60 review): an earlier failure means the database was not closed in order, so the close of
  // a failed client is never clean, after a worker error and after a missed deadline alike.
  it('after a worker failure, close waits for the terminated thread and reports an unclean close', async () => {
    const f = fixture();
    f.error();
    await expect(f.client.close()).resolves.toEqual({clean: false});
    await expect(f.client.commitEvent({message: {}})).resolves.toEqual(error('STORAGE_CLOSED'));
  });
  it('after a missed deadline, close reports an unclean close', async () => {
    const f = fixture();
    void f.client.commitEvent({message: {}});
    await vi.advanceTimersByTimeAsync(COMMAND_DEADLINE_MS);
    expect(f.client.state).toBe('failed');
    await expect(f.client.close()).resolves.toEqual({clean: false});
  });
});
