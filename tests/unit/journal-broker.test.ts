// ET-016 PR-3 (J4, J10, J11): main's journal broker with fake services and fake timers. One request is in flight per
// service, at most four wait behind it (BUSY beyond), each has 15 s from the moment it is sent (TIMEOUT), only the current
// service's reply to the request in flight is accepted and checked against the request, and every pending request
// resolves SERVICE_UNAVAILABLE when the service is retired. Expected values are written by hand from J4 and J11 (REG-011, REG-014).
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {JOURNAL_QUEUE_LIMIT, JOURNAL_REQUEST_DEADLINE_MS, JournalBroker} from '../../apps/desktop/src/journal-broker';
import type {JournalQuery} from '../../apps/desktop/src/journal-contract';
import {changed, DETAIL, LIST_ITEM, TRIP, TRIP_PAGE} from '../shared/journal-replies';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const TRIPS: JournalQuery = {kind: 'trips', query: {}};
const DETAIL_QUERY: JournalQuery = {kind: 'trip', tripUuid: TRIP};
const service = () => ({postMessage: vi.fn<(message: unknown) => void>()});
function fixture() {
  const log = vi.fn(), broker = new JournalBroker({log}), current = service();
  broker.attach(current);
  const sent = (target = current) => target.postMessage.mock.calls.map(call => call[0] as {type: string; id: number; query: JournalQuery});
  const logged = () => log.mock.calls.map(call => [call[0], call[2]] as const);
  return {broker, current, sent, log, logged};
}
/** Records each request's settled result in call order, for checks of what is still pending. */
function track(results: unknown[], index: number, promise: Promise<unknown>) { void promise.then(result => { results[index] = result; }); }

describe('one request in flight per service, at most four queued (J4)', () => {
  it('limits the queue to four behind the request in flight and answers the sixth BUSY at once', async () => {
    expect(JOURNAL_QUEUE_LIMIT).toBe(4);
    const f = fixture(), results: unknown[] = [];
    for (let index = 0; index < 6; index++) track(results, index, f.broker.request({kind: 'trip', tripUuid: TRIP}));
    await vi.advanceTimersByTimeAsync(0);
    // Only the first was sent; the sixth was refused without reaching the service.
    expect(f.sent()).toEqual([{type: 'journal', id: 1, query: DETAIL_QUERY}]);
    expect(results).toEqual([undefined, undefined, undefined, undefined, undefined, {ok: false, code: 'BUSY'}]);
    expect(f.logged()).toEqual([['JOURNAL_REQUEST_BUSY', {count: 1}]]);
    // Each reply sends the next queued request, in order, with the next id.
    for (let id = 1; id <= 5; id++) {
      expect(f.sent()).toHaveLength(id);
      f.broker.reply(f.current, {type: 'journal', id, result: {ok: true, value: DETAIL}});
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.sent().map(message => message.id)).toEqual([1, 2, 3, 4, 5]);
    expect(results).toEqual([...Array<unknown>(5).fill({ok: true, value: DETAIL}), {ok: false, code: 'BUSY'}]);
  });
  it('answers SERVICE_UNAVAILABLE without a ready service', async () => {
    const broker = new JournalBroker({log: vi.fn()});
    await expect(broker.request(TRIPS)).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  });
});

describe('the 15 s deadline (J4)', () => {
  it('answers TIMEOUT 15 s after sending, sends the next request, and ignores the late reply', async () => {
    expect(JOURNAL_REQUEST_DEADLINE_MS).toBe(15_000);
    const f = fixture(), results: unknown[] = [];
    track(results, 0, f.broker.request(DETAIL_QUERY));
    // The second request waits; its own deadline starts only when it is sent.
    await vi.advanceTimersByTimeAsync(10_000);
    track(results, 1, f.broker.request(TRIPS));
    await vi.advanceTimersByTimeAsync(4_999);
    expect(results).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(results).toEqual([{ok: false, code: 'TIMEOUT'}]);
    expect(f.sent()).toEqual([{type: 'journal', id: 1, query: DETAIL_QUERY}, {type: 'journal', id: 2, query: TRIPS}]);
    // The first request's late reply is not taken for the second one.
    f.broker.reply(f.current, {type: 'journal', id: 1, result: {ok: true, value: DETAIL}});
    await vi.advanceTimersByTimeAsync(14_999);
    expect(results).toHaveLength(1);
    f.broker.reply(f.current, {type: 'journal', id: 2, result: {ok: true, value: TRIP_PAGE}});
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ok: false, code: 'TIMEOUT'}, {ok: true, value: TRIP_PAGE}]);
    expect(f.logged()).toEqual([['JOURNAL_REQUEST_TIMEOUT', {kind: 'trip', count: 1}], ['JOURNAL_REPLY_IGNORED', {count: 1}]]);
    // A reply after its answer leaves no timer behind.
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('replies (J10, J11)', () => {
  it('never forwards a reply that does not answer the request exactly; it answers FAILED with a fixed log', async () => {
    const f = fixture();
    const invalid = changed(TRIP_PAGE, page => { page.trips = Array<typeof LIST_ITEM>(51).fill(LIST_ITEM); });
    const first = f.broker.request(TRIPS);
    f.broker.reply(f.current, {type: 'journal', id: 1, result: {ok: true, value: invalid}});
    await expect(first).resolves.toEqual({ok: false, code: 'FAILED'});
    // A detail of another trip than the one requested.
    const second = f.broker.request({kind: 'trip', tripUuid: '7a000000-0000-4000-8000-000000000002'});
    f.broker.reply(f.current, {type: 'journal', id: 2, result: {ok: true, value: DETAIL}});
    await expect(second).resolves.toEqual({ok: false, code: 'FAILED'});
    // A refusal with text.
    const third = f.broker.request(TRIPS);
    f.broker.reply(f.current, {type: 'journal', id: 3, result: {ok: false, code: 'FAILED', message: 'SQLITE_BUSY at C:\\Users\\owner'}});
    await expect(third).resolves.toEqual({ok: false, code: 'FAILED'});
    expect(f.logged()).toEqual([['JOURNAL_REPLY_REJECTED', {kind: 'trips', count: 1}], ['JOURNAL_REPLY_REJECTED', {kind: 'trip', count: 2}]]);
    // A valid refusal passes as it is.
    const fourth = f.broker.request(TRIPS);
    f.broker.reply(f.current, {type: 'journal', id: 4, result: {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'DISK_FULL'}});
    await expect(fourth).resolves.toEqual({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'DISK_FULL'});
  });
  it('ignores a reply for another id, with extra fields or from another service, and keeps waiting', async () => {
    const f = fixture(), results: unknown[] = [], other = service();
    track(results, 0, f.broker.request(TRIPS));
    f.broker.reply(f.current, {type: 'journal', id: 2, result: {ok: true, value: TRIP_PAGE}});
    f.broker.reply(f.current, {type: 'journal', id: 1, result: {ok: true, value: TRIP_PAGE}, path: 'C:\\'});
    f.broker.reply(f.current, {type: 'journal', id: '1', result: {ok: true, value: TRIP_PAGE}});
    f.broker.reply(other, {type: 'journal', id: 1, result: {ok: true, value: TRIP_PAGE}});
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([]);
    expect(f.logged()).toEqual([['JOURNAL_REPLY_IGNORED', {count: 1}], ['JOURNAL_REPLY_IGNORED', {count: 2}], ['JOURNAL_REPLY_IGNORED', {count: 4}]]);
    f.broker.reply(f.current, {type: 'journal', id: 1, result: {ok: true, value: TRIP_PAGE}});
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ok: true, value: TRIP_PAGE}]);
  });
});

describe('retiring the service (J4)', () => {
  it.each(['failure', 'exit', 'exhaustion', 'application exit'])('resolves the request in flight and every queued one SERVICE_UNAVAILABLE on its %s', async () => {
    const f = fixture(), results: unknown[] = [];
    for (let index = 0; index < 3; index++) track(results, index, f.broker.request(TRIPS));
    f.broker.retire();
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual(Array<unknown>(3).fill({ok: false, code: 'SERVICE_UNAVAILABLE'}));
    // The retired service's late reply changes nothing, and later requests are refused until a service is attached.
    f.broker.reply(f.current, {type: 'journal', id: 1, result: {ok: true, value: TRIP_PAGE}});
    await expect(f.broker.request(TRIPS)).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
    expect(f.sent()).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    f.broker.retire();
  });
  it('sends to the restarted service and ignores the replaced one, whose request ids it may repeat', async () => {
    const f = fixture(), results: unknown[] = [], next = service();
    track(results, 0, f.broker.request(TRIPS));
    track(results, 1, f.broker.request(TRIPS));
    f.broker.attach(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toEqual([{ok: false, code: 'SERVICE_UNAVAILABLE'}, {ok: false, code: 'SERVICE_UNAVAILABLE'}]);
    track(results, 2, f.broker.request(DETAIL_QUERY));
    expect(f.sent(next)).toEqual([{type: 'journal', id: 2, query: DETAIL_QUERY}]);
    // A reply of the replaced service, even with the id now in flight, is ignored.
    f.broker.reply(f.current, {type: 'journal', id: 2, result: {ok: true, value: DETAIL}});
    await vi.advanceTimersByTimeAsync(0);
    expect(results).toHaveLength(2);
    f.broker.reply(next, {type: 'journal', id: 2, result: {ok: true, value: DETAIL}});
    await vi.advanceTimersByTimeAsync(0);
    expect(results[2]).toEqual({ok: true, value: DETAIL});
  });
  it('answers SERVICE_UNAVAILABLE when the service channel is closed, and sends the next request', async () => {
    const f = fixture();
    f.current.postMessage.mockImplementationOnce(() => { throw new Error('channel closed'); });
    const first = f.broker.request(TRIPS), second = f.broker.request(DETAIL_QUERY);
    await expect(first).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
    expect(f.sent().map(message => message.id)).toEqual([1, 2]);
    f.broker.reply(f.current, {type: 'journal', id: 2, result: {ok: false, code: 'NOT_FOUND'}});
    await expect(second).resolves.toEqual({ok: false, code: 'NOT_FOUND'});
  });
});
