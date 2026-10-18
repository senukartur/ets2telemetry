import {MessageChannel} from 'node:worker_threads';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SERVICE_STOP_BUDGET_MS, ShutdownSequence} from '../../apps/desktop/src/shutdown-sequence';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const log = vi.fn();
  // The injected clock follows Vitest's fake time, so measured step durations are deterministic.
  const sequence = new ShutdownSequence(log, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setImmediate: callback => setImmediate(callback), clearImmediate: handle => clearImmediate(handle as ReturnType<typeof setImmediate>), now: () => Date.now()});
  const steps = () => log.mock.calls.filter(call => call[0] === 'SHUTDOWN_STEP').map(call => call[2] as Record<string, unknown>);
  return {log, sequence, steps};
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}

it('runs phases in intake, flush, storage order and steps of one phase in parallel', async () => {
  const f = fixture(), order: string[] = [];
  const intake = deferred(), capture = deferred();
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: () => {order.push('storage');}});
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => {order.push('ingestion'); return intake.promise;}});
  f.sequence.register('intake', {name: 'capture', budgetMs: 1000, run: () => {order.push('capture'); return capture.promise;}});
  f.sequence.register('flush', {name: 'history-flush', budgetMs: 500, run: () => {order.push('flush');}});
  const result = f.sequence.run(); await Promise.resolve();
  // Both intake steps started before either finished; later phases wait for the whole phase.
  expect(order).toEqual(['ingestion', 'capture']);
  capture.resolve(); await vi.advanceTimersByTimeAsync(0); expect(order).toEqual(['ingestion', 'capture']);
  intake.resolve(); await expect(result).resolves.toEqual({clean: true});
  expect(order).toEqual(['ingestion', 'capture', 'flush', 'storage']);
  expect(f.steps().map(step => [step.phase, step.name, step.outcome])).toEqual([
    ['intake', 'capture', 'ok'], ['intake', 'ingestion', 'ok'], ['flush', 'history-flush', 'ok'], ['storage', 'storage-probe', 'ok']]);
  expect(vi.getTimerCount()).toBe(0);
});

it('bounds a hanging step by its budget, continues with later phases and reports an unclean stop', async () => {
  const f = fixture(), storage = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => new Promise<void>(() => undefined)});
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: storage});
  let settled: {clean: boolean} | undefined;
  void f.sequence.run().then(result => {settled = result;});
  await vi.advanceTimersByTimeAsync(999); expect(storage).not.toHaveBeenCalled(); expect(settled).toBeUndefined();
  // Requirement change (October 18, 2026): the timeout verdict runs one event-loop turn after the budget (an
  // immediate), which the fake clock schedules 1 ms later.
  await vi.advanceTimersByTimeAsync(1); expect(storage).not.toHaveBeenCalled(); expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); expect(storage).toHaveBeenCalledOnce();
  expect(settled).toEqual({clean: false});
  expect(f.steps()).toEqual([{phase: 'intake', name: 'ingestion', outcome: 'timeout', ms: 1001}, {phase: 'storage', name: 'storage-probe', outcome: 'ok', ms: 0}]);
  expect(vi.getTimerCount()).toBe(0);
});

// Regression (history close grace review, October 18, 2026): a service thread stalled past a step's budget runs the due
// budget timer before the next poll phase delivers the step's result that arrived meanwhile. The result now counts.
it('counts a step result that arrives after the due budget timer and before the verdict turn', async () => {
  const f = fixture(), step = deferred();
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => step.promise});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(0);
  // Only the budget timer runs, as when the stalled thread resumes; then the late poll phase delivers the result.
  vi.advanceTimersToNextTimer();
  expect(f.steps()).toEqual([]);
  step.resolve();
  await expect(result).resolves.toEqual({clean: true});
  expect(f.steps()).toEqual([{phase: 'storage', name: 'history-storage', outcome: 'ok', ms: 1000}]);
  await vi.advanceTimersByTimeAsync(10);
  expect(f.steps()).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('with the real event loop, counts a step result posted before the thread stalled past the budget', async () => {
  vi.useRealTimers();
  const log = vi.fn(), sequence = new ShutdownSequence(log), {port1, port2} = new MessageChannel();
  try {
    // The intake step starts synchronously in run(), so its budget timer runs from here.
    sequence.register('intake', {name: 'ingestion', budgetMs: 50, run: () => new Promise<void>(resolve => { port2.once('message', () => resolve()); })});
    const cell = new Int32Array(new SharedArrayBuffer(4));
    // Run and block in an immediate, outside any message callback: the result is posted at once, but the loop runs the
    // due budget timer before the poll phase that delivers it.
    const result = await new Promise<{clean: boolean}>(resolve => setImmediate(() => {
      const running = sequence.run();
      port1.postMessage('done');
      Atomics.wait(cell, 0, 0, 300);
      resolve(running);
    }));
    expect(result).toEqual({clean: true});
    const step = log.mock.calls.find(call => call[0] === 'SHUTDOWN_STEP')?.[2] as {outcome: string; ms: number};
    expect(step.outcome).toBe('ok');
    expect(step.ms).toBeGreaterThanOrEqual(250);
  } finally { port1.close(); port2.close(); }
});

it('still times out a step that has not finished after the verdict turn', async () => {
  const f = fixture();
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => new Promise<void>(() => undefined)});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(0);
  vi.advanceTimersToNextTimer();
  expect(f.steps()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({clean: false});
  expect(f.steps()).toEqual([{phase: 'storage', name: 'history-storage', outcome: 'timeout', ms: 1001}]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['rejects', 'throws'])('contains a step that %s and still runs every other step', async mode => {
  const f = fixture(), capture = vi.fn(), storage = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => {
    if (mode === 'throws') throw new Error('synchronous failure');
    return Promise.reject(new Error('asynchronous failure'));
  }});
  f.sequence.register('intake', {name: 'capture', budgetMs: 1000, run: capture});
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: storage});
  await expect(f.sequence.run()).resolves.toEqual({clean: false});
  expect(capture).toHaveBeenCalledOnce(); expect(storage).toHaveBeenCalledOnce();
  expect(f.steps().find(step => step.name === 'ingestion')).toMatchObject({outcome: 'failed'});
  // Failure text never reaches the fact-only diagnostic.
  expect(JSON.stringify(f.log.mock.calls)).not.toContain('failure');
  expect(vi.getTimerCount()).toBe(0);
});

it('is idempotent: a repeated run returns the same result without repeating steps', async () => {
  const f = fixture(), run = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run});
  const first = f.sequence.run(), second = f.sequence.run();
  expect(second).toBe(first); await first; await f.sequence.run();
  expect(run).toHaveBeenCalledOnce(); expect(f.steps()).toHaveLength(1);
  expect(() => f.sequence.register('storage', {name: 'late', budgetMs: 100, run})).toThrow('already started');
});

it('rejects registrations whose phase maxima exceed the service stop budget, and invalid steps', () => {
  const f = fixture(), run = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run});
  f.sequence.register('intake', {name: 'capture', budgetMs: 1000, run});
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run});
  // Parallel steps share their phase's bound; only a larger maximum adds to the total.
  f.sequence.register('storage', {name: 'storage-close', budgetMs: 1000, run});
  expect(f.sequence.budgetMs).toBe(2000);
  expect(() => f.sequence.register('flush', {name: 'history-flush', budgetMs: SERVICE_STOP_BUDGET_MS - 1999, run})).toThrow('budget exceeded');
  f.sequence.register('flush', {name: 'history-flush', budgetMs: SERVICE_STOP_BUDGET_MS - 2000, run});
  expect(f.sequence.budgetMs).toBe(SERVICE_STOP_BUDGET_MS);
  expect(() => f.sequence.register('intake', {name: 'slow-intake', budgetMs: 1001, run})).toThrow('budget exceeded');
  for (const step of [{name: 'C:\\path', budgetMs: 1}, {name: 'ok', budgetMs: 0}, {name: 'ok', budgetMs: 1.5}, {name: 'ingestion', budgetMs: 1}])
    expect(() => f.sequence.register('intake', {...step, run})).toThrow();
  expect(() => f.sequence.register('unknown' as never, {name: 'other', budgetMs: 1, run})).toThrow('Unknown');
});

it('reports a clean empty sequence without timers', async () => {
  const f = fixture();
  await expect(f.sequence.run()).resolves.toEqual({clean: true});
  expect(f.steps()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});
