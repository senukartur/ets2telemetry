import {MessageChannel} from 'node:worker_threads';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SERVICE_STOP_BUDGET_MS, ShutdownSequence, type ShutdownStepContext} from '../../apps/desktop/src/shutdown-sequence';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(now = () => Date.now()) {
  const log = vi.fn();
  // The injected clock follows Vitest's fake time, so measured step durations are deterministic.
  const sequence = new ShutdownSequence(log, {setTimeout: (callback, ms) => setTimeout(callback, ms), clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
    setImmediate: callback => setImmediate(callback), clearImmediate: handle => clearImmediate(handle as ReturnType<typeof setImmediate>), now});
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
  // Under ET-038 adaptive budget cascading, with 0 ms spent in earlier phases, effective budget is 2500 ms.
  expect(f.steps()).toEqual([{phase: 'storage', name: 'history-storage', outcome: 'ok', ms: 2500}]);
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
  // Under ET-038 adaptive budget cascading, with 0 ms spent in earlier phases, effective budget is 2500 ms (2501 with immediate).
  expect(f.steps()).toEqual([{phase: 'storage', name: 'history-storage', outcome: 'timeout', ms: 2501}]);
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

it('cascades unused intake and flush budget to storage phase steps', async () => {
  const f = fixture();
  let storageProbeContext: ShutdownStepContext | undefined;
  let historyContext: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 30);
  })});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 20);
  })});
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: ctx => {
    storageProbeContext = ctx;
  }});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: ctx => {
    historyContext = ctx;
    return new Promise<void>(resolve => {
      setTimeout(resolve, 1500);
    });
  }});
  const result = f.sequence.run();
  await vi.advanceTimersByTimeAsync(30 + 20);
  expect(storageProbeContext).toEqual({budgetMs: 1000});
  expect(historyContext).toEqual({budgetMs: 2450, graceMs: 2250});
  await vi.advanceTimersByTimeAsync(1500);
  await expect(result).resolves.toEqual({clean: true});
  expect(f.steps().map(s => [s.phase, s.name, s.outcome])).toEqual([
    ['intake', 'v1-ingestion', 'ok'],
    ['flush', 'recording-flush', 'ok'],
    ['storage', 'storage-probe', 'ok'],
    ['storage', 'history-storage', 'ok']
  ]);
  const historyStep = f.steps().find(s => s.name === 'history-storage')!;
  expect(historyStep.ms).toBe(1500);
});

it('scales down storage effective budget and grace when earlier phases consume their full budget', async () => {
  const f = fixture();
  let historyContext: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 1000);
  })});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 500);
  })});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: ctx => {
    historyContext = ctx;
  }});
  const result = f.sequence.run();
  await vi.advanceTimersByTimeAsync(1500);
  await expect(result).resolves.toEqual({clean: true});
  expect(historyContext).toEqual({budgetMs: 1000, graceMs: 800});
});

it('strictly enforces total 2500 ms bound by timing out a hanging storage step at its effective budget', async () => {
  const f = fixture();
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 40);
  })});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => new Promise<void>(resolve => {
    setTimeout(resolve, 10);
  })});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => new Promise<void>(() => undefined)});
  let settled: {clean: boolean} | undefined;
  void f.sequence.run().then(res => { settled = res; });
  await vi.advanceTimersByTimeAsync(50);
  await vi.advanceTimersByTimeAsync(2449);
  expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(settled).toEqual({clean: false});
  expect(f.steps().find(s => s.name === 'history-storage')).toEqual({
    phase: 'storage',
    name: 'history-storage',
    outcome: 'timeout',
    ms: 2451
  });
});

it('borrows unused registered intake for recording flush without spending the storage reserve twice', async () => {
  const f = fixture();
  let flushContext: ShutdownStepContext | undefined, historyContext: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => new Promise(resolve => setTimeout(resolve, 30))});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: context => {
    flushContext = context; return new Promise(resolve => setTimeout(resolve, 900));
  }});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: context => {
    historyContext = context; return new Promise(resolve => setTimeout(resolve, 1200));
  }});
  const result = f.sequence.run();
  await vi.advanceTimersByTimeAsync(2130);
  await expect(result).resolves.toEqual({clean: true});
  expect(flushContext).toEqual({budgetMs: 1470});
  expect(historyContext).toEqual({budgetMs: 1570, graceMs: 1370});
  expect(f.steps().map(step => step.outcome)).toEqual(['ok', 'ok', 'ok']);
  expect(f.sequence.budgetMs).toBe(2500);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([0, 200, 1000, 1500])('borrows only unused registered intake after %i ms, never unregistered slack', async elapsed => {
  const f = fixture();
  let flushContext: ShutdownStepContext | undefined;
  if (elapsed !== 0) f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => {
    // Move the measured clock without executing the budget timer, as after synchronous work or host preemption.
    vi.setSystemTime(Date.now() + elapsed);
  }});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: context => {flushContext = context;}});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => undefined});
  await expect(f.sequence.run()).resolves.toEqual({clean: true});
  expect(flushContext).toEqual({budgetMs: elapsed === 0 ? 500 : 500 + Math.max(0, 1000 - elapsed)});
  expect(vi.getTimerCount()).toBe(0);
});

it('times out a hanging borrowed flush while preserving the future storage reservation', async () => {
  const f = fixture();
  let historyContext: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => new Promise<void>(() => undefined)});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: context => {historyContext = context;}});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(1500);
  expect(f.steps().map(step => step.name)).toEqual(['v1-ingestion']);
  await vi.advanceTimersByTimeAsync(1);
  await expect(result).resolves.toEqual({clean: false});
  expect(f.steps()).toContainEqual({phase: 'flush', name: 'recording-flush', outcome: 'timeout', ms: 1501});
  expect(historyContext).toEqual({budgetMs: 1000, graceMs: 800});
  expect(vi.getTimerCount()).toBe(0);
});

it('does not transfer recording flush allocation to another flush step', async () => {
  const f = fixture();
  let context: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'other-flush', budgetMs: 500, run: value => {context = value;}});
  await f.sequence.run(); expect(context).toEqual({budgetMs: 500});
});

it('reports a clean empty sequence without timers', async () => {
  const f = fixture();
  await expect(f.sequence.run()).resolves.toEqual({clean: true});
  expect(f.steps()).toEqual([]); expect(vi.getTimerCount()).toBe(0);
});

// Owner-approved corrective allocation: a prompt intake may lend its unused budget to the final recording flush.
it('keeps an 829 ms recording flush clean and reserves actual remaining time for storage', async () => {
  const f = fixture(), pending = deferred(); let flush: ShutdownStepContext | undefined, storage: ShutdownStepContext | undefined;
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: context => {flush = context; return pending.promise;}});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: context => {storage = context;}});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(829);
  pending.resolve(); await expect(result).resolves.toEqual({clean: true});
  expect(flush).toEqual({budgetMs: 1500}); expect(storage).toEqual({budgetMs: 1671, graceMs: 1471});
  expect(f.steps()).toEqual([{phase: 'intake', name: 'v1-ingestion', outcome: 'ok', ms: 0},
    {phase: 'flush', name: 'recording-flush', outcome: 'ok', ms: 829}, {phase: 'storage', name: 'history-storage', outcome: 'ok', ms: 0}]);
});

it.each([[0, 1500], [300, 1200], [1000, 500]])('after %i ms intake grants the recording flush %i ms', async (elapsed, budgetMs) => {
  const f = fixture(), recording = vi.fn();
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1000, run: () => new Promise<void>(resolve => setTimeout(resolve, elapsed))});
  f.sequence.register('intake', {name: 'capture', budgetMs: 600, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: recording});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => undefined});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(elapsed);
  await expect(result).resolves.toEqual({clean: true}); expect(recording).toHaveBeenCalledExactlyOnceWith({budgetMs});
  expect(f.sequence.budgetMs).toBe(2500);
});
it('uses parallel maxima and retains the registered storage reserve', async () => {
  const f = fixture(), recording = vi.fn();
  f.sequence.register('intake', {name: 'v1-ingestion', budgetMs: 1500, run: () => undefined});
  f.sequence.register('intake', {name: 'capture', budgetMs: 1200, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: recording});
  f.sequence.register('storage', {name: 'first-storage', budgetMs: 500, run: () => undefined});
  f.sequence.register('storage', {name: 'second-storage', budgetMs: 400, run: () => undefined});
  await expect(f.sequence.run()).resolves.toEqual({clean: true});
  expect(recording).toHaveBeenCalledExactlyOnceWith({budgetMs: 2000}); expect(f.sequence.budgetMs).toBe(2500);
});
it.each(['flush', 'intake'] as const)('does not lend to an unrelated name or a recording name in the %s phase', async phase => {
  const f = fixture(), ordinary = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register(phase, {name: phase === 'flush' ? 'other-flush' : 'recording-flush', budgetMs: 500, run: ordinary});
  f.sequence.register('storage', {name: 'storage-probe', budgetMs: 1000, run: () => undefined});
  await expect(f.sequence.run()).resolves.toEqual({clean: true}); expect(ordinary).toHaveBeenCalledExactlyOnceWith({budgetMs: 500});
});
it('grants no spare intake allocation when no intake steps are registered', async () => {
  const f = fixture(), recording = vi.fn();
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: recording});
  await expect(f.sequence.run()).resolves.toEqual({clean: true}); expect(recording).toHaveBeenCalledExactlyOnceWith({budgetMs: 500});
});
it.each([-1, NaN, Infinity, -Infinity])('grants nothing for invalid elapsed time %s', async elapsed => {
  let reads = 0; const f = fixture(() => reads++ === 0 ? 0 : elapsed), recording = vi.fn();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: recording});
  await expect(f.sequence.run()).resolves.toEqual({clean: true}); expect(recording).toHaveBeenCalledExactlyOnceWith({budgetMs: 500});
});
it('bounds stalled recording and history at nominal 2500 ms plus the existing verdict turns and history floor', async () => {
  const f = fixture(); let result: {clean: boolean} | undefined;
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => new Promise<void>(() => undefined)});
  f.sequence.register('storage', {name: 'history-storage', budgetMs: 1000, run: () => new Promise<void>(() => undefined)});
  void f.sequence.run().then(value => {result = value;}); await vi.advanceTimersByTimeAsync(2500); expect(result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2); expect(result).toEqual({clean: false});
  expect(f.steps()).toEqual([{phase: 'intake', name: 'ingestion', outcome: 'ok', ms: 0},
    {phase: 'flush', name: 'recording-flush', outcome: 'timeout', ms: 1501}, {phase: 'storage', name: 'history-storage', outcome: 'timeout', ms: 1001}]);
  expect(vi.getTimerCount()).toBe(0);
});
it.each(['failed', 'late-success', 'late-failure'])('keeps %s sticky after recording uses its effective budget', async outcome => {
  const f = fixture(), pending = deferred();
  f.sequence.register('intake', {name: 'ingestion', budgetMs: 1000, run: () => undefined});
  f.sequence.register('flush', {name: 'recording-flush', budgetMs: 500, run: () => pending.promise});
  const result = f.sequence.run(); await vi.advanceTimersByTimeAsync(0);
  if (outcome === 'failed') pending.reject(new Error('fixed-test-failure')); else await vi.advanceTimersByTimeAsync(1501);
  await expect(result).resolves.toEqual({clean: false});
  const before = f.steps();
  if (outcome === 'late-success') pending.resolve(); else if (outcome === 'late-failure') pending.reject(new Error('fixed-late-failure'));
  await vi.advanceTimersByTimeAsync(0); expect(f.steps()).toEqual(before);
  expect(before.at(-1)?.outcome).toBe(outcome === 'failed' ? 'failed' : 'timeout'); expect(vi.getTimerCount()).toBe(0);
});
