// ET-016 PR-3 (J2, J4, J11): journal queries in the telemetry service, with a recorded client in place of the storage
// client. The service runs one journal read at a time, only while the database is open and the service is not stopping,
// and maps every storage result to a fixed J11 code. Expected values are written by hand from J4 and J11 (REG-011, REG-014).
import {describe, expect, it, vi} from 'vitest';
import type {JournalCallResult} from '../../packages/contracts/src';
import type {JournalResult, StorageErrorCode} from '../../packages/storage/src/api';
import {JOURNAL_ANSWER_INVALID} from '../../packages/storage/src/api';
import {storageError} from '../../packages/storage/src/errors';
import type {HistoryState} from '../../apps/desktop/src/history-storage';
import {JournalService, type JournalClient, type JournalHistory, type JournalReplyMessage} from '../../apps/desktop/src/journal-service';
import type {JournalQuery} from '../../apps/desktop/src/journal-contract';
import {DETAIL, EVENT_PAGE, INTERVAL_PAGE, SAMPLE, TRIP, TRIP_PAGE} from '../shared/journal-replies';

const DATABASE = {purpose: 'synthetic', schemaVersion: 2} as const;
const TRIPS: JournalQuery = {kind: 'trips', query: {game: 'ets2'}};

/** A deferred client answer, resolved by the test. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return {promise, resolve};
}
/** A recorded client: every read waits for the answer the test gives it. */
function recordedClient() {
  const calls: unknown[][] = [];
  const pending: ReturnType<typeof deferred<JournalResult<unknown>>>[] = [];
  const read = (name: string) => vi.fn((...args: unknown[]) => { calls.push([name, ...args]); const next = deferred<JournalResult<unknown>>(); pending.push(next); return next.promise; });
  const client = {journalTrips: read('journalTrips'), journalTrip: read('journalTrip'), journalEvents: read('journalEvents'), journalIntervals: read('journalIntervals'),
    listSamples: read('listSamples')} as unknown as JournalClient;
  return {client, calls, answer: (index: number, result: JournalResult<unknown>) => pending[index].resolve(result)};
}
function fixture(state: HistoryState = 'open', failureCode: StorageErrorCode | null = null) {
  const recorded = recordedClient(), log = vi.fn();
  const history: {-readonly [K in keyof JournalHistory]: JournalHistory[K]} = {state, failureCode, client: state === 'open' ? recorded.client : undefined, database: state === 'open' ? DATABASE : undefined};
  let stopping = false;
  const service = new JournalService({history, stopping: () => stopping, log});
  return {...recorded, history, log, service, stop: () => { stopping = true; }};
}
const failed = (code: StorageErrorCode): JournalResult<never> => ({ok: false, error: storageError(code)});

describe('refusals before any storage read (J4, J11)', () => {
  it.each<[HistoryState, StorageErrorCode | null, JournalCallResult<never>]>([
    ['idle', null, {ok: false, code: 'DATABASE_OPENING'}],
    ['opening', null, {ok: false, code: 'DATABASE_OPENING'}],
    ['unavailable', 'PERMISSION_DENIED', {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'PERMISSION_DENIED'}],
    ['unavailable', 'SCHEMA_NEWER', {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'SCHEMA_NEWER'}],
    ['closed', null, {ok: false, code: 'SERVICE_UNAVAILABLE'}]
  ])('answers a read while the database is %s (%s) without reading', async (state, code, expected) => {
    const f = fixture(state, code);
    // A client that a stale reference could still reach must not be used either.
    f.history.client = f.client;
    await expect(f.service.query(TRIPS)).resolves.toEqual(expected);
    expect(f.calls).toEqual([]);
  });
  it('answers SERVICE_UNAVAILABLE without reading once the service stops', async () => {
    const f = fixture();
    f.stop();
    await expect(f.service.query(TRIPS)).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
    expect(f.calls).toEqual([]);
  });
});

describe('one journal read at a time (J4)', () => {
  it('answers a second read BUSY while one is in flight, so the storage queue never holds two journal commands', async () => {
    const f = fixture();
    const first = f.service.query(TRIPS);
    await expect(f.service.query({kind: 'trip', tripUuid: TRIP})).resolves.toEqual({ok: false, code: 'BUSY'});
    await expect(f.service.query(TRIPS)).resolves.toEqual({ok: false, code: 'BUSY'});
    expect(f.calls).toEqual([['journalTrips', {game: 'ets2'}]]);
    f.answer(0, {ok: true, value: TRIP_PAGE});
    await expect(first).resolves.toEqual({ok: true, value: TRIP_PAGE});
    // The next read runs once the first one answered.
    const next = f.service.query({kind: 'trip', tripUuid: TRIP});
    expect(f.calls).toHaveLength(2);
    f.answer(1, failed('UNKNOWN_TRIP'));
    await expect(next).resolves.toEqual({ok: false, code: 'NOT_FOUND'});
  });
  it('frees the slot after a read that threw', async () => {
    const f = fixture();
    vi.mocked(f.client.journalTrips).mockRejectedValueOnce(new Error('defect'));
    await expect(f.service.query(TRIPS)).resolves.toEqual({ok: false, code: 'FAILED'});
    void f.service.query(TRIPS);
    expect(f.calls).toEqual([['journalTrips', {game: 'ets2'}]]);
  });
});

describe('each query reads through the service database (J2, J5)', () => {
  it.each<[string, JournalQuery, unknown[], unknown]>([
    ['the trip list', {kind: 'trips', query: {cursor: '60', completeness: 'partial'}}, ['journalTrips', {cursor: '60', completeness: 'partial'}], TRIP_PAGE],
    ['a trip detail', {kind: 'trip', tripUuid: TRIP}, ['journalTrip', TRIP], DETAIL],
    ['a timeline page', {kind: 'events', tripUuid: TRIP, page: {cursor: '9', limit: 100}}, ['journalEvents', TRIP, {cursor: '9', limit: 100}], EVENT_PAGE],
    ['an interval page', {kind: 'intervals', tripUuid: TRIP, page: {limit: 500}}, ['journalIntervals', TRIP, {limit: 500}], INTERVAL_PAGE]
  ])('reads %s and forwards the value as read', async (_name, query, call, value) => {
    const f = fixture();
    const result = f.service.query(query);
    expect(f.calls).toEqual([call]);
    f.answer(0, {ok: true, value});
    await expect(result).resolves.toEqual({ok: true, value});
  });
  it('reads a sample page with listSamples and adds the database and the next cursor of a full page', async () => {
    const f = fixture();
    const full = f.service.query({kind: 'samples', tripUuid: TRIP, page: {cursor: '10', limit: 300}});
    expect(f.calls).toEqual([['listSamples', {tripUuid: TRIP}, {afterId: '10', limit: 300}]]);
    const rows = Array.from({length: 300}, (_, index) => ({...SAMPLE, id: String(11 + index)}));
    f.answer(0, {ok: true, value: rows});
    await expect(full).resolves.toEqual({ok: true, value: {database: {purpose: 'synthetic', schemaVersion: 2}, samples: rows, nextCursor: '310'}});
    const short = f.service.query({kind: 'samples', tripUuid: TRIP, page: {limit: 300}});
    expect(f.calls[1]).toEqual(['listSamples', {tripUuid: TRIP}, {limit: 300}]);
    f.answer(1, {ok: true, value: [SAMPLE]});
    await expect(short).resolves.toEqual({ok: true, value: {database: {purpose: 'synthetic', schemaVersion: 2}, samples: [SAMPLE], nextCursor: null}});
  });
});

describe('storage results map to fixed J11 codes (J11)', () => {
  it.each<[string, JournalResult<unknown>, JournalCallResult<never>]>([
    ['UNKNOWN_TRIP', failed('UNKNOWN_TRIP'), {ok: false, code: 'NOT_FOUND'}],
    ['JOURNAL_ANSWER_INVALID (a bad page fails only this read)', {ok: false, error: {...JOURNAL_ANSWER_INVALID}}, {ok: false, code: 'FAILED'}],
    ['STORAGE_BUSY', failed('STORAGE_BUSY'), {ok: false, code: 'BUSY'}],
    ['TIMEOUT', failed('TIMEOUT'), {ok: false, code: 'TIMEOUT'}],
    ['INVALID_INPUT', failed('INVALID_INPUT'), {ok: false, code: 'FAILED'}],
    ['DATABASE_CORRUPT', failed('DATABASE_CORRUPT'), {ok: false, code: 'FAILED'}],
    ['INTERNAL', failed('INTERNAL'), {ok: false, code: 'FAILED'}]
  ])('maps %s', async (_name, result, expected) => {
    const f = fixture();
    const answer = f.service.query({kind: 'trip', tripUuid: TRIP});
    f.answer(0, result);
    await expect(answer).resolves.toEqual(expected);
  });
  it('reports a failed client as DATABASE_UNAVAILABLE with the code that made the database unavailable', async () => {
    const f = fixture();
    const answer = f.service.query(TRIPS);
    // The client failed closed on a missed deadline of an earlier command; this read got WORKER_FAILED.
    f.history.state = 'unavailable'; f.history.failureCode = 'TIMEOUT';
    f.answer(0, failed('WORKER_FAILED'));
    await expect(answer).resolves.toEqual({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'TIMEOUT'});
  });
  it('reports a client closed by the orderly stop as SERVICE_UNAVAILABLE', async () => {
    const f = fixture();
    const answer = f.service.query(TRIPS);
    f.stop();
    f.answer(0, failed('STORAGE_CLOSED'));
    await expect(answer).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  });
});

describe('the parent-port protocol (J4)', () => {
  it('answers {type: journal, id, query} with {type: journal, id, result}', async () => {
    const f = fixture(), sent: JournalReplyMessage[] = [];
    f.service.receive({type: 'journal', id: 7, query: {kind: 'trip', tripUuid: TRIP}}, reply => sent.push(reply));
    f.answer(0, {ok: true, value: DETAIL});
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent).toEqual([{type: 'journal', id: 7, result: {ok: true, value: DETAIL}}]);
    expect(f.log).not.toHaveBeenCalled();
  });
  it('answers a malformed request FAILED when its id is valid, never reads, and logs a counted fixed code', () => {
    const f = fixture(), sent: JournalReplyMessage[] = [];
    const malformed = [
      {type: 'journal', id: 1, query: {kind: 'trips', query: {limit: 51}}},
      {type: 'journal', id: 2, query: {kind: 'samples', tripUuid: TRIP, page: {limit: 51}}},
      {type: 'journal', id: 3, query: {kind: 'trip', tripUuid: TRIP}, path: 'C:\\'},
      {type: 'journal', id: 0, query: {kind: 'trip', tripUuid: TRIP}},
      {type: 'journal', id: '5', query: {kind: 'trip', tripUuid: TRIP}},
      {type: 'journal', query: {kind: 'trip', tripUuid: TRIP}}
    ];
    for (const message of malformed) f.service.receive(message, reply => sent.push(reply));
    expect(sent).toEqual([1, 2, 3].map(id => ({type: 'journal', id, result: {ok: false, code: 'FAILED'}})));
    expect(f.calls).toEqual([]);
    expect(f.log.mock.calls.map(call => [call[0], call[2]])).toEqual([['JOURNAL_REQUEST_REJECTED', {count: 1}], ['JOURNAL_REQUEST_REJECTED', {count: 2}],
      ['JOURNAL_REQUEST_REJECTED', {count: 4}]]);
  });
  it('ignores a closed parent port when it answers', async () => {
    const f = fixture();
    const send = vi.fn(() => { throw new Error('port closed'); });
    f.service.receive({type: 'journal', id: 1, query: TRIPS}, send);
    f.answer(0, {ok: true, value: TRIP_PAGE});
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    // The slot is free again.
    void f.service.query(TRIPS);
    expect(f.calls).toHaveLength(2);
  });
});
