// ET-015c PR-3 (G2-G6): the pure recording status rules, the strict parser main applies to every report, the saturating
// loss totals and the coalescing publisher. Expected statuses are written by hand from G3's ordered rules
// (DESIGN-DECISIONS.md) and docs/telemetry-service-v1.md#recording-status-et-015c; none is read back from the code
// under test.
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {RecordingHealth, RecordingLosses} from '../../packages/contracts/src';
import {
  addLosses, deriveRecordingStatus, parseRecordingHealth, RECORDING_CODES, RECORDING_STATUS_INTERVAL_MS, RecordingStatusPublisher, ZERO_LOSSES, type RecordingStatusInput
} from '../../apps/desktop/src/recording-status';

const LOSSES: RecordingLosses = {lostEvents: 3, eventLoss: 1, notConnected: 2, sampleLoss: 0, restoreLoss: 0, droppedSamples: 4};
const TRIP = {phase: 'active', completeness: 'partial', untrackedJob: false} as const;
/** Every rule passes: a recording synthetic connection with an open database. */
const BASE: RecordingStatusInput = {
  recorder: true, target: 'synthetic', history: {state: 'open', code: null}, durableSelections: ['synthetic'],
  v1: {selection: 'synthetic', status: 'connected', durable: {state: 'active'}}, retryCode: null, recorded: true, losses: LOSSES, trip: TRIP
};
const input = (change: Omit<Partial<RecordingStatusInput>, 'v1'> & {v1?: Partial<RecordingStatusInput['v1']>}): RecordingStatusInput =>
  ({...BASE, ...change, v1: {...BASE.v1, ...change.v1}});
const status = (state: string, code: string | null = null) => ({state, target: 'synthetic', code, losses: LOSSES, trip: TRIP});

describe('G3 ordered rules', () => {
  // Each row also breaks every later rule, so only the rule it names can give its expectation.
  const failedLater = {durableSelections: [] as const, retryCode: 'DISK_FULL', v1: {status: 'stale' as const, durable: {state: 'failed' as const, code: 'PERMISSION_DENIED'}}};
  it.each<[string, RecordingStatusInput, unknown]>([
    ['1 no recorder', input({...failedLater, recorder: false, history: {state: 'unavailable', code: 'PERMISSION_DENIED'}}), {state: 'disabled'}],
    ['2 idle database', input({...failedLater, history: {state: 'idle', code: null}}), status('opening')],
    ['2 opening database', input({...failedLater, history: {state: 'opening', code: null}}), status('opening')],
    ['3 unavailable database', input({...failedLater, history: {state: 'unavailable', code: 'PERMISSION_DENIED'}}), status('stopped', 'PERMISSION_DENIED')],
    ['3 closed database without a code', input({...failedLater, history: {state: 'closed', code: null}}), status('stopped', 'STORAGE_CLOSED')],
    ['4 ACK ahead of storage', input({...failedLater, v1: {status: 'stale', durable: {state: 'failed', code: 'ACK_AHEAD_OF_STORAGE'}}}), status('live-only', 'ACK_AHEAD_OF_STORAGE')],
    ['4 durable delivery failed', input(failedLater), status('stopped', 'PERMISSION_DENIED')],
    ['4 a code outside the closed set', input({...failedLater, v1: {status: 'stale', durable: {state: 'failed', code: 'C:\\path'}}}), status('stopped', 'INTERNAL')],
    ['5 a selection that is not recorded', input({durableSelections: [], retryCode: 'DISK_FULL', v1: {selection: 'game', status: 'stale'}}), status('not-recorded-source')],
    ['5 a recorded game outside the plan', input({v1: {selection: 'ets2'}}), status('not-recorded-source')],
    ['6 a retry code', input({retryCode: 'DISK_FULL', v1: {status: 'stale', durable: {state: 'pending'}}}), status('retrying', 'DISK_FULL')],
    ['6 a retry code while connected and active', input({retryCode: 'BACKLOG_FULL'}), status('retrying', 'BACKLOG_FULL')],
    ['7 active and connected', BASE, status('recording')],
    ['7 active and paused', input({v1: {status: 'paused'}}), status('paused')],
    ['7 active and stale after recording', input({v1: {status: 'stale'}}), status('interrupted')],
    ['7 active and disconnected after recording', input({v1: {status: 'disconnected'}}), status('interrupted')],
    ['7 active and waiting after recording', input({v1: {status: 'waiting'}}), status('interrupted')],
    ['8 a reconnection whose session is not open yet, after recording', input({v1: {durable: {state: 'pending'}}}), status('interrupted')],
    ['8 active and stale before any recording', input({recorded: false, v1: {status: 'stale'}}), status('waiting')],
    ['8 connected before the session opened', input({recorded: false, v1: {durable: {state: 'pending'}}}), status('waiting')],
    ['8 no hello yet', input({recorded: false, v1: {status: 'waiting', durable: {state: 'off'}}}), status('waiting')]
  ])('%s', (_name, value, expected) => {
    expect(deriveRecordingStatus(value)).toEqual(expected);
  });

  it('never reports recording without the database open, the durable cursor active and fresh v1 data', () => {
    for (const v1Status of ['waiting', 'stale', 'disconnected', 'incompatible', 'unavailable'] as const) expect(deriveRecordingStatus(input({v1: {status: v1Status}})).state).not.toBe('recording');
    for (const durable of [{state: 'off'}, {state: 'pending'}] as const) expect(deriveRecordingStatus(input({v1: {durable}})).state).not.toBe('recording');
    for (const state of ['idle', 'opening', 'unavailable', 'closed'] as const) expect(deriveRecordingStatus(input({history: {state, code: null}})).state).not.toBe('recording');
  });

  it('copies the losses and the trip, and reports a missing trip as null', () => {
    const derived = deriveRecordingStatus(input({trip: null}));
    expect(derived).toEqual({...status('recording'), trip: null});
    if (!('losses' in derived)) throw new Error('A state with losses was expected');
    expect(derived.losses).not.toBe(LOSSES);
  });
});

describe('parseRecordingHealth (G4)', () => {
  const valid = {state: 'retrying', target: 'replay', code: 'DISK_FULL', losses: {...LOSSES}, trip: {phase: 'reload-check', completeness: null, untrackedJob: true}};
  it('accepts every variant and returns a fresh copy', () => {
    for (const value of [{state: 'disabled'}, {state: 'unknown'}, valid, {...valid, code: null, trip: null}]) {
      const parsed = parseRecordingHealth(structuredClone(value));
      expect(parsed).toEqual(value);
    }
    const parsed = parseRecordingHealth(valid);
    expect(parsed).not.toBe(valid);
    expect(parsed && 'losses' in parsed && parsed.losses).not.toBe(valid.losses);
    for (const code of RECORDING_CODES) expect(parseRecordingHealth({...valid, code})).toEqual({...valid, code});
  });

  it.each<[string, unknown]>([
    ['an extra key', {...valid, detail: 'C:\\path'}],
    ['an extra key on disabled', {state: 'disabled', code: null}],
    ['a missing key', {state: 'recording', target: 'synthetic', code: null, losses: LOSSES}],
    ['an unknown state', {...valid, state: 'recorded'}],
    ['an unknown target', {...valid, target: 'game'}],
    ['a code outside the closed set', {...valid, code: 'SQLITE_FULL'}],
    ['a code of the wrong type', {...valid, code: 0}],
    ['a negative loss', {...valid, losses: {...LOSSES, lostEvents: -1}}],
    ['a fractional loss', {...valid, losses: {...LOSSES, eventLoss: 0.5}}],
    ['an unsafe loss', {...valid, losses: {...LOSSES, notConnected: Number.MAX_SAFE_INTEGER + 1}}],
    ['a loss as text', {...valid, losses: {...LOSSES, sampleLoss: '1'}}],
    ['a missing loss', {...valid, losses: {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0}}],
    ['an extra loss key', {...valid, losses: {...LOSSES, gaps: 1}}],
    ['an unknown trip phase', {...valid, trip: {...valid.trip, phase: 'closed'}}],
    ['an unknown completeness', {...valid, trip: {...valid.trip, completeness: 'full'}}],
    ['a non-boolean untracked job', {...valid, trip: {...valid.trip, untrackedJob: 1}}],
    ['an extra trip key', {...valid, trip: {...valid.trip, tripUuid: 'x'}}],
    ['an array', [valid]], ['null', null], ['text', 'recording']
  ])('rejects %s', (_name, value) => {
    expect(parseRecordingHealth(value)).toBeUndefined();
  });
});

describe('addLosses (G6)', () => {
  it('adds field by field and saturates at Number.MAX_SAFE_INTEGER', () => {
    expect(addLosses(ZERO_LOSSES, LOSSES)).toEqual(LOSSES);
    expect(addLosses(LOSSES, {lostEvents: 1, eventLoss: 2, notConnected: 3, sampleLoss: 4, restoreLoss: 5, droppedSamples: 6}))
      .toEqual({lostEvents: 4, eventLoss: 3, notConnected: 5, sampleLoss: 4, restoreLoss: 5, droppedSamples: 10});
    const max = Number.MAX_SAFE_INTEGER;
    expect(addLosses({...ZERO_LOSSES, lostEvents: max - 1, droppedSamples: max}, {...ZERO_LOSSES, lostEvents: 5, droppedSamples: max}))
      .toEqual({...ZERO_LOSSES, lostEvents: max, droppedSamples: max});
  });
});

describe('RecordingStatusPublisher (G5)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const timers = {setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setImmediate: (callback: () => void) => setImmediate(callback), clearImmediate: (handle: unknown) => clearImmediate(handle as ReturnType<typeof setImmediate>), now: () => Date.now()};
  function fixture() {
    let current: RecordingHealth = {state: 'opening', target: 'synthetic', code: null, losses: {...ZERO_LOSSES}, trip: null};
    const sent: string[] = [];
    const publisher = new RecordingStatusPublisher(() => current, next => sent.push('losses' in next ? `${next.state} ${next.losses.lostEvents}` : next.state), {timers});
    const set = (state: string, lostEvents = 0) => { current = {state: state as 'opening', target: 'synthetic', code: null, losses: {...ZERO_LOSSES, lostEvents}, trip: null}; publisher.changed(); };
    return {publisher, sent, set};
  }

  it('sends the first status at start and nothing for a change before it', async () => {
    const f = fixture();
    f.set('waiting'); await vi.advanceTimersByTimeAsync(1000);
    expect(f.sent).toEqual([]);
    f.publisher.start();
    expect(f.sent).toEqual(['waiting 0']);
  });

  it('sends at most one coarse change per 250 ms, the latest one at the end of the interval, and never repeats a status', async () => {
    const f = fixture(); f.publisher.start();
    // Changes made in one turn settle into one status.
    f.set('waiting'); f.set('recording'); f.set('waiting');
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent).toEqual(['opening 0']);
    f.set('recording'); f.set('interrupted');
    await vi.advanceTimersByTimeAsync(RECORDING_STATUS_INTERVAL_MS - 2);
    expect(f.sent).toEqual(['opening 0']);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent).toEqual(['opening 0', 'interrupted 0']);
    // After an idle interval a change is sent once it settled; the same status again is not sent.
    await vi.advanceTimersByTimeAsync(1000);
    f.set('interrupted'); f.set('recording'); await vi.advanceTimersByTimeAsync(1);
    f.set('recording'); await vi.advanceTimersByTimeAsync(1000);
    expect(f.sent).toEqual(['opening 0', 'interrupted 0', 'recording 0']);
  });

  it('sends a change of the losses at once, without waiting for the interval', async () => {
    const f = fixture(); f.publisher.start();
    f.set('opening', 2); await vi.advanceTimersByTimeAsync(1);
    f.set('recording', 2); await vi.advanceTimersByTimeAsync(1);
    // The state change alone waits for the interval; the loss change that follows sends the latest status at once.
    expect(f.sent).toEqual(['opening 0', 'opening 2']);
    f.set('recording', 3); await vi.advanceTimersByTimeAsync(1);
    expect(f.sent).toEqual(['opening 0', 'opening 2', 'recording 3']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sent).toEqual(['opening 0', 'opening 2', 'recording 3']);
  });

  it('sends nothing after close and leaves no timer', async () => {
    const f = fixture(); f.publisher.start();
    f.set('waiting'); await vi.advanceTimersByTimeAsync(1); f.set('recording');
    f.publisher.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.sent).toEqual(['opening 0']);
    expect(vi.getTimerCount()).toBe(0);
    f.set('interrupted', 1); await vi.advanceTimersByTimeAsync(1000);
    expect(f.sent).toEqual(['opening 0']);
  });
});
