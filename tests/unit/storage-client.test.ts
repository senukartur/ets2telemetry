import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {CompletenessOptions, JournalResult, Result, SampleAppendOptions, SampleInput, StorageError, StorageErrorCode, TripPage} from '../../packages/storage/src/api';
import {COMMAND_DEADLINE_MS, MAX_QUEUED_COMMANDS, OPEN_DEADLINE_MS, StorageClient, type StorageClientOptions, type StorageWorkerHandle} from '../../packages/storage/src/client';
import {storageError} from '../../packages/storage/src/errors';
import {parseRequest, type StorageRequest} from '../../packages/storage/src/worker/protocol';
import {job, trailer, truck} from '../shared/trip-messages';

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

describe('ET-015a trip filter and completeness options at the worker boundary', () => {
  const INTERVAL = {kind: 'restore-loss' as const, firstEventSeq: '3', lastEventSeq: '5'};
  const request = (command: Record<string, unknown>) => ({type: 'storage.request', id: 1, command});
  it('sends the listTrips filter and copies only the page fields', () => {
    const f = fixture();
    void f.client.listTrips({game: 'ats', outcome: 'open', cursor: '5', limit: 10, testHooks: {}} as Parameters<StorageClient['listTrips']>[0]);
    expect(f.sent[0].command).toEqual({name: 'listTrips', page: {game: 'ats', outcome: 'open', cursor: '5', limit: 10}});
    expect(Object.keys((f.sent[0].command as {page: object}).page).sort()).toEqual(['cursor', 'game', 'limit', 'outcome']);
    expect(parseRequest(f.sent[0]).ok).toBe(true);
  });
  it('sends ifAbsent and nothing else of the completeness options, and no options when none are given', async () => {
    const f = fixture();
    const first = f.client.recordCompleteness(P1, INTERVAL, {ifAbsent: true, testHooks: {}} as Parameters<StorageClient['recordCompleteness']>[2]);
    expect(f.sent[0].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options: {ifAbsent: true}});
    f.ok(1, undefined);
    await expect(first).resolves.toEqual({ok: true, value: undefined});
    void f.client.recordCompleteness(P1, INTERVAL);
    expect(f.sent[1].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL});
    expect(Object.hasOwn(f.sent[1].command, 'options')).toBe(false);
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  // Review pass 1: a non-object page or options value used to throw a TypeError in the client. It is forwarded as given,
  // so the strict worker parser refuses it and the caller gets an INVALID_INPUT result.
  it.each([['null', null], ['a number', 5], ['a string', 'ets2']])('forwards %s as the page or options value instead of throwing', (_name, value) => {
    const f = fixture();
    expect(() => f.client.listTrips(value as unknown as TripPage)).not.toThrow();
    expect(() => f.client.recordCompleteness(P1, INTERVAL, value as unknown as CompletenessOptions)).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'listTrips', page: value});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
    f.reply(1, error('INVALID_INPUT') as Result<unknown>);
    expect(f.sent).toHaveLength(2);
    expect(f.sent[1].command).toEqual({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options: value});
    expect(parseRequest(f.sent[1])).toEqual({ok: false, id: 2});
  });
  it('returns the INVALID_INPUT answer of a refused page to the caller', async () => {
    const f = fixture();
    const listed = f.client.listTrips(null as unknown as TripPage);
    f.reply(1, error('INVALID_INPUT') as Result<unknown>);
    await expect(listed).resolves.toEqual(error('INVALID_INPUT'));
  });
  it.each([
    ['no page', undefined],
    ['an empty page', {}],
    ['every field', {cursor: '7', limit: 100, game: 'ets2', outcome: 'cancelled'}],
    ['undefined fields', {cursor: undefined, limit: undefined, game: undefined, outcome: undefined}],
    ['outcome none', {outcome: 'none'}],
    ['outcome delivered', {outcome: 'delivered'}]
  ])('accepts a listTrips page with %s', (_name, page) => {
    expect(parseRequest(request({name: 'listTrips', page}))).toMatchObject({ok: true, id: 1});
  });
  it.each([
    ['an unknown key', {game: 'ets2', testHooks: {}}],
    ['an unknown game', {game: 'ETS2'}],
    ['an unknown outcome', {outcome: 'closed'}],
    ['a numeric cursor', {cursor: 5}],
    ['a text limit', {limit: '10'}],
    ['an array', []],
    ['null', null]
  ])('refuses a listTrips page with %s', (_name, page) => {
    expect(parseRequest(request({name: 'listTrips', page}))).toEqual({ok: false, id: 1});
  });
  it.each([
    ['no options', undefined, true],
    ['ifAbsent true', {ifAbsent: true}, true],
    ['ifAbsent false', {ifAbsent: false}, true],
    ['ifAbsent undefined', {ifAbsent: undefined}, true],
    ['a text ifAbsent', {ifAbsent: 'yes'}, false],
    ['an unknown key', {ifAbsent: true, testHooks: {}}, false],
    ['an array', [], false],
    ['null', null, false]
  ])('checks recordCompleteness options strictly: %s', (_name, options, accepted) => {
    expect(parseRequest(request({name: 'recordCompleteness', pluginSessionId: P1, interval: INTERVAL, options})).ok).toBe(accepted);
  });
});

describe('ET-015b sample options and counts at the worker boundary', () => {
  const ROWS: SampleInput[] = [];
  const request = (options: unknown) => ({type: 'storage.request', id: 1, command: {name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options}});
  it('sends uniqueSeconds and nothing else of the sample options, and no options when none are given', async () => {
    const f = fixture();
    const first = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true, testHooks: {beforeCommit: () => undefined}} as Parameters<StorageClient['appendSamples']>[2]);
    expect(f.sent[0].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options: {uniqueSeconds: true}});
    expect(Object.keys((f.sent[0].command as {options: object}).options)).toEqual(['uniqueSeconds']);
    f.ok(1, {appended: 0, skipped: 0});
    await expect(first).resolves.toEqual({ok: true, value: {appended: 0, skipped: 0}});
    void f.client.appendSamples(P1, ROWS);
    expect(f.sent[1].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS});
    expect(Object.hasOwn(f.sent[1].command, 'options')).toBe(false);
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  it('forwards sample options that are not an object as given, so the worker parser refuses them', () => {
    const f = fixture();
    expect(() => f.client.appendSamples(P1, ROWS, null as unknown as SampleAppendOptions)).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'appendSamples', pluginSessionId: P1, rows: ROWS, options: null});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
  });
  it.each([
    ['no options', undefined, true],
    ['uniqueSeconds true', {uniqueSeconds: true}, true],
    ['uniqueSeconds false', {uniqueSeconds: false}, true],
    ['uniqueSeconds undefined', {uniqueSeconds: undefined}, true],
    ['an empty object', {}, true],
    ['a text uniqueSeconds', {uniqueSeconds: 'true'}, false],
    ['a numeric uniqueSeconds', {uniqueSeconds: 1}, false],
    ['an unknown key', {uniqueSeconds: true, testHooks: {}}, false],
    ['an array', [], false],
    ['null', null, false]
  ])('checks appendSamples options strictly: %s', (_name, options, accepted) => {
    expect(parseRequest(request(options)).ok).toBe(accepted);
  });
  it.each([
    ['both counts zero', {appended: 0, skipped: 0}],
    ['a full batch', {appended: 3_600, skipped: 0}],
    ['skipped rows', {appended: 59, skipped: 1}]
  ])('accepts a sample answer with %s', async (_name, value) => {
    const f = fixture();
    const append = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true});
    f.ok(1, value);
    await expect(append).resolves.toEqual({ok: true, value});
    expect(f.client.state).toBe('running');
  });
  it.each([
    ['no skipped count', {appended: 1}],
    ['a negative skipped count', {appended: 1, skipped: -1}],
    ['a fractional appended count', {appended: 1.5, skipped: 0}],
    ['a text count', {appended: '1', skipped: 0}],
    ['an unsafe count', {appended: 2 ** 53, skipped: 0}],
    ['a count that is not finite', {appended: Number.POSITIVE_INFINITY, skipped: 0}],
    ['no value object', 1]
  ])('fails closed on a sample answer with %s', async (_name, value) => {
    const f = fixture();
    const append = f.client.appendSamples(P1, ROWS, {uniqueSeconds: true});
    f.ok(1, value);
    await expect(append).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
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

/**
 * ET-016 PR-2: the journal commands at the worker boundary. Requests are copied field by field and checked strictly;
 * every answer is validated against the journal contract, and a malformed one fails the client closed like a
 * malformed commit result. The valid answers below are written by hand in the documented shapes.
 */
describe('ET-016 journal reads at the worker boundary', () => {
  const TRIP = '7a000000-0000-4000-8000-000000000001';
  const NO = {available: false, reason: 'not-observed'} as const;
  const DATABASE = {purpose: 'synthetic', schemaVersion: 2};
  const LIST_ITEM = {tripUuid: TRIP, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, gameModeAmbiguous: false, outcome: 'open', closeReason: null,
    recordingCompleteness: 'unknown', startedUtcMs: 1_791_676_800_000, endedUtcMs: null, observedDistanceM: {available: true, value: 0}, fuelUsedL: NO,
    job: {source: 'event', sourceCity: {available: true, value: ''}, sourceCompany: NO, destinationCity: NO, destinationCompany: NO, cargo: NO,
      plannedDistance: {available: true, value: 0, unit: 'm'}, expectedIncome: {available: true, value: {raw: '18446744073709551615', sdkType: 'u64', currency: {status: 'unknown'}}}}};
  const INTERVAL = {id: '1', kind: 'discontinuity', annotation: true, cause: 'truck-change', startUtcMs: null, endUtcMs: null, startMonotonicNs: null, endMonotonicNs: null,
    sourceClockId: null, firstEventSeq: null, lastEventSeq: null, detail: {cause: 'truck-change', annotation: true, atEventSeq: '2'}};
  const WINDOW = {known: true, pluginSessionId: P1, fromEventSeq: '1', throughEventSeq: null, end: 'open'};
  const configured = JSON.parse(readFileSync(path.resolve('tests/fixtures/protocol-v1/event-job-configured.json'), 'utf8')) as {data: {occurred: unknown; record: unknown}};
  const EVENT = {eventSeq: '1', type: 'job.configured', occurred: configured.data.occurred, record: configured.data.record, attribution: null};
  const PAGE = {database: DATABASE, trips: [LIST_ITEM], nextCursor: null};
  const EVENTS = {database: DATABASE, window: WINDOW, events: [EVENT, {...EVENT, eventSeq: '2', attribution: {kind: 'ambiguous', tripUuid: null}}], nextCursor: null};
  const INTERVALS = {database: DATABASE, intervals: [INTERVAL], total: 1, nextCursor: null};
  const DETAIL = {database: DATABASE, trip: {...LIST_ITEM, pluginSessionId: P1, openedBy: 'event', openedEventSeq: '1', outcomeEventSeq: null, closedBy: null},
    job: {source: 'event', eventSeq: '1', checkpointNextEventSeq: null, values: job()}, truck: {eventSeq: '2', values: truck()}, trailers: {items: [{eventSeq: '3', values: trailer(0)}], total: 1},
    outcomeDetails: null,
    money: {incomplete: false, totals: [{category: 'fine', sdkType: 's64', currency: {status: 'unknown'}, raw: '-18446744073709551616', count: 2}],
      unavailable: [{category: 'toll', reason: 'invalid', count: 1}]},
    window: WINDOW, intervals: {items: [INTERVAL], total: 1, nextCursor: null}, samples: {count: 0, firstUtcMs: null, lastUtcMs: null},
    exportBounds: {committedThroughEventSeq: '3', lastSampleId: null, lastIntervalId: '1'}};
  type Call = (client: StorageClient) => Promise<JournalResult<unknown>>;
  const CALLS: Record<'trips' | 'trip' | 'events' | 'intervals', Call> = {
    trips: client => client.journalTrips(), trip: client => client.journalTrip(TRIP),
    events: client => client.journalEvents(TRIP, {limit: 100}), intervals: client => client.journalIntervals(TRIP, {limit: 100})
  };
  const VALID = {trips: PAGE, trip: DETAIL, events: EVENTS, intervals: INTERVALS};
  const changed = <T>(value: T, change: (copy: T) => void): T => { const copy = structuredClone(value); change(copy); return copy; };
  const request = (command: Record<string, unknown>) => ({type: 'storage.request', id: 1, command});

  it('copies only the listed query and page fields, and sends no query when none is given', () => {
    const f = fixture();
    void f.client.journalTrips({cursor: '5', game: 'ats', outcome: 'open', completeness: 'partial', limit: 51} as Parameters<StorageClient['journalTrips']>[0]);
    expect(f.sent[0].command).toEqual({name: 'journalTrips', query: {cursor: '5', game: 'ats', outcome: 'open', completeness: 'partial'}});
    f.ok(1, PAGE);
    void f.client.journalTrips();
    expect(f.sent[1].command).toEqual({name: 'journalTrips'});
    expect(Object.hasOwn(f.sent[1].command, 'query')).toBe(false);
    f.ok(2, PAGE);
    void f.client.journalEvents(TRIP, {limit: 500, cursor: '9', testHooks: {}} as Parameters<StorageClient['journalEvents']>[1]);
    expect(f.sent[2].command).toEqual({name: 'journalEvents', tripUuid: TRIP, page: {limit: 500, cursor: '9'}});
    f.ok(3, EVENTS);
    void f.client.journalIntervals(TRIP, {limit: 100, after: '1'} as Parameters<StorageClient['journalIntervals']>[1]);
    expect(f.sent[3].command).toEqual({name: 'journalIntervals', tripUuid: TRIP, page: {limit: 100, cursor: undefined}});
    for (const sent of f.sent) expect(parseRequest(sent).ok).toBe(true);
  });
  it('forwards a page that is not an object as given, so the worker parser refuses it', () => {
    const f = fixture();
    expect(() => f.client.journalEvents(TRIP, null as unknown as {limit: number})).not.toThrow();
    expect(f.sent[0].command).toEqual({name: 'journalEvents', tripUuid: TRIP, page: null});
    expect(parseRequest(f.sent[0])).toEqual({ok: false, id: 1});
  });
  it.each([
    ['journalTrips without a query', {name: 'journalTrips'}, true],
    ['journalTrips with every filter', {name: 'journalTrips', query: {cursor: '9223372036854775807', game: 'ets2', outcome: 'none', completeness: 'complete'}}, true],
    ['journalTrips with undefined fields', {name: 'journalTrips', query: {cursor: undefined, game: undefined}}, true],
    ['journalTrips with a page size', {name: 'journalTrips', query: {limit: 50}}, false],
    ['journalTrips with cursor 0', {name: 'journalTrips', query: {cursor: '0'}}, false],
    ['journalTrips with a cursor beyond 2^63 - 1', {name: 'journalTrips', query: {cursor: '9223372036854775808'}}, false],
    ['journalTrips with an unknown completeness', {name: 'journalTrips', query: {completeness: 'full'}}, false],
    ['journalTrips with an extra field', {name: 'journalTrips', query: {}, testHooks: {}}, false],
    ['journalTrip', {name: 'journalTrip', tripUuid: TRIP}, true],
    ['journalTrip with an upper-case id', {name: 'journalTrip', tripUuid: TRIP.toUpperCase()}, false],
    ['journalEvents of 100', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 100}}, true],
    ['journalEvents of 500 after the last eventSeq', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 500, cursor: '18446744073709551614'}}, true],
    ['journalEvents of 51', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 51}}, false],
    ['journalEvents of 300', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 300}}, false],
    ['journalEvents beyond the last eventSeq', {name: 'journalEvents', tripUuid: TRIP, page: {limit: 100, cursor: '18446744073709551615'}}, false],
    ['journalEvents without a page', {name: 'journalEvents', tripUuid: TRIP}, false],
    ['journalIntervals of 500', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: 500, cursor: '1'}}, true],
    ['journalIntervals of 3,600', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: 3_600}}, false],
    ['journalIntervals with a text limit', {name: 'journalIntervals', tripUuid: TRIP, page: {limit: '100'}}, false]
  ])('checks %s strictly', (_name, command, accepted) => {
    expect(parseRequest(request(command)).ok).toBe(accepted);
  });
  it.each(Object.keys(CALLS) as (keyof typeof CALLS)[])('accepts a well-formed %s answer', async name => {
    const f = fixture();
    const read = CALLS[name](f.client);
    f.ok(1, VALID[name]);
    await expect(read).resolves.toEqual({ok: true, value: VALID[name]});
    expect(f.client.state).toBe('running');
  });
  it('accepts a detail with the latest ten of twelve trailer configurations', async () => {
    const f = fixture();
    const detail = changed(DETAIL, p => { p.trailers = {items: Array(10).fill(p.trailers.items[0]) as typeof p.trailers.items, total: 12}; });
    const read = f.client.journalTrip(TRIP);
    f.ok(1, detail);
    await expect(read).resolves.toEqual({ok: true, value: detail});
  });
  const COMMANDS = {trips: 'journalTrips', trip: 'journalTrip', events: 'journalEvents', intervals: 'journalIntervals'} as const;
  it.each<[string, keyof typeof CALLS, unknown]>([
    ['51 trips on a page', 'trips', changed(PAGE, p => { p.trips = Array<typeof LIST_ITEM>(51).fill(LIST_ITEM); })],
    ['an unknown database purpose', 'trips', changed(PAGE, p => { p.database.purpose = 'game'; })],
    ['a cursor of 0', 'trips', changed(PAGE, p => { (p as {nextCursor: unknown}).nextCursor = '0'; })],
    ['an available distance without a value', 'trips', changed(PAGE, p => { (p.trips[0] as {observedDistanceM: unknown}).observedDistanceM = {available: true}; })],
    ['a negative distance', 'trips', changed(PAGE, p => { p.trips[0].observedDistanceM = {available: true, value: -1}; })],
    ['an unknown availability reason', 'trips', changed(PAGE, p => { (p.trips[0] as {fuelUsedL: unknown}).fuelUsedL = {available: false, reason: 'zero'}; })],
    ['money as a number', 'trips', changed(PAGE, p => { (p.trips[0].job as {expectedIncome: unknown}).expectedIncome = {available: true, value: {raw: 5, sdkType: 'u64', currency: {status: 'unknown'}}}; })],
    ['an open trip with a close reason', 'trips', changed(PAGE, p => { (p.trips[0] as {closeReason: unknown}).closeReason = 'gap'; })],
    ['an extra field', 'trips', changed(PAGE, p => { (p.trips[0] as Record<string, unknown>).processId = 4242; })],
    ['an interval flag that disagrees with its detail', 'intervals', changed(INTERVALS, p => { p.intervals[0].annotation = false; })],
    ['an interval total below its page', 'trip', changed(DETAIL, p => { p.intervals.total = 0; })],
    ['an event whose type differs from its record', 'events', changed(EVENTS, p => { p.events[0].type = 'job.cleared'; })],
    ['an event occurrence with an invalid clock', 'events', changed(EVENTS, p => { (p.events[0].occurred as {gameTime: {clockId: string}}).gameTime.clockId = 'clock'; })],
    ['a free-driving event with a trip', 'events', changed(EVENTS, p => { (p.events[1] as {attribution: unknown}).attribution = {kind: 'free-driving', tripUuid: TRIP}; })],
    ['501 events', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(501).fill(EVENT); })],
    ['an open window with an end', 'events', changed(EVENTS, p => { (p.window as {throughEventSeq: unknown}).throughEventSeq = '9'; })],
    ['a window of another session', 'trip', changed(DETAIL, p => { p.window = {...WINDOW, pluginSessionId: '10000000-0000-4000-8000-000000000002'}; })],
    ['job values outside the protocol', 'trip', changed(DETAIL, p => { (p.job.values as unknown as {plannedDistance: unknown}).plannedDistance = {available: true, value: 1_500, unit: 'm'}; })],
    ['incomplete money with totals', 'trip', changed(DETAIL, p => { p.money.incomplete = true; })],
    ['a money total that is not an integer', 'trip', changed(DETAIL, p => { p.money.totals[0].raw = '1.5'; })],
    ['a sample label without samples', 'trip', changed(DETAIL, p => { (p.samples as {firstUtcMs: unknown}).firstUtcMs = 1; })],
    ['export bounds that disagree with the intervals', 'trip', changed(DETAIL, p => { (p.exportBounds as {lastIntervalId: unknown}).lastIntervalId = null; })],
    ['an event-opened trip without its opening event', 'trip', changed(DETAIL, p => { (p.trip as {openedEventSeq: unknown}).openedEventSeq = null; })],
    ['a checkpoint-opened trip with an opening event', 'trip', changed(DETAIL, p => { p.trip.openedBy = 'checkpoint'; })],
    ['a missing value', 'trip', undefined],
    // Review pass 1: lists bounded like the storage reads, and pages tied to the requested limit.
    ['eleven trailer configurations', 'trip', changed(DETAIL, p => { p.trailers = {items: Array(11).fill(p.trailers.items[0]) as typeof p.trailers.items, total: 11}; })],
    ['fewer trailer configurations than the total allows', 'trip', changed(DETAIL, p => { p.trailers.total = 5; })],
    ['101 events for a page of 100', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(101).fill(EVENT); })],
    ['a full page of 100 events without a cursor', 'events', changed(EVENTS, p => { p.events = Array<typeof EVENT>(100).fill(EVENT); })],
    ['a cursor on a short page', 'trips', changed(PAGE, p => { (p as {nextCursor: unknown}).nextCursor = '5'; })],
    ['101 intervals for a page of 100', 'intervals', changed(INTERVALS, p => { p.intervals = Array<typeof INTERVAL>(101).fill(INTERVAL); p.total = 101; })]
  ])('refuses a journal answer with %s for that read alone, and the client keeps serving (review pass 1)', async (_name, name, value) => {
    const refusals: unknown[] = [];
    const f = fixture({onJournalAnswerInvalid: facts => refusals.push(facts)});
    const read = CALLS[name](f.client);
    f.ok(1, value);
    await expect(read).resolves.toEqual({ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false,
      message: 'The storage worker returned a journal page that does not match the journal contract.'}});
    expect(refusals).toEqual([{command: COMMANDS[name]}]);
    expect(f.client.state).toBe('running');
    expect(f.failures).toEqual([]);
    expect(f.handle.terminate).not.toHaveBeenCalled();
    // The recorder's next command is sent and answered as usual.
    const next = f.client.commitEvent({message: {}});
    expect(f.sent.map(sent => sent.command.name)).toEqual([COMMANDS[name], 'commitEvent']);
    f.ok(2, COMMITTED);
    await expect(next).resolves.toEqual({ok: true, value: COMMITTED});
  });
  it('resolves the read and sends the next command even when the report callback throws (review pass 2)', async () => {
    const f = fixture({onJournalAnswerInvalid: () => { throw new Error('the log sink is closing'); }});
    const read = f.client.journalTrips();
    const next = f.client.commitEvent({message: {}});
    // The worker answers the journal read with a page that breaks the contract; the throw must not escape the listener.
    expect(() => f.ok(1, changed(PAGE, p => { p.database.purpose = 'game'; }))).not.toThrow();
    await expect(read).resolves.toEqual({ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false,
      message: 'The storage worker returned a journal page that does not match the journal contract.'}});
    expect(f.sent.map(sent => sent.command.name)).toEqual(['journalTrips', 'commitEvent']);
    f.ok(2, COMMITTED);
    await expect(next).resolves.toEqual({ok: true, value: COMMITTED});
    expect(f.client.state).toBe('running');
  });
  it.each<[string, (f: ReturnType<typeof fixture>) => void]>([
    ['a success without a value', f => f.raw({type: 'storage.response', id: 1, result: {ok: true}})],
    ['an error with an unknown code', f => f.reply(1, {ok: false, error: {code: 'JOURNAL_ANSWER_INVALID', retryable: false, message: 'x'}} as unknown as Result<unknown>)],
    ['an answer for another id', f => f.ok(2, PAGE)],
    ['a frame of another type', f => f.raw({type: 'storage.request', id: 1, result: {ok: true, value: PAGE}})]
  ])('still fails the client closed on a malformed journal frame: %s', async (_name, answer) => {
    const f = fixture();
    const read = f.client.journalTrips();
    answer(f);
    await expect(read).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
  it('still fails the client closed on an invalid answer to a recorder command', async () => {
    const f = fixture({onJournalAnswerInvalid: () => { throw new Error('not a journal command'); }});
    const commit = f.client.commitEvent({message: {}});
    f.ok(1, {status: 'committed', committedThroughEventSeq: '01'});
    await expect(commit).resolves.toEqual(error('WORKER_FAILED'));
    expect(f.client.state).toBe('failed');
  });
});
