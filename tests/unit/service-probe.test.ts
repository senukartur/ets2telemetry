import {afterEach, describe, expect, it, vi} from 'vitest';
import {ServiceProbe, type ProbeWorker} from '../../apps/desktop/src/service-probe';

function fixture(createDirectory: () => Promise<string> = async () => 'temporary-probe') {
  let message: (value: unknown) => void = () => {};
  let error: (error: unknown) => void = () => {};
  let exit: (code: number) => void = () => {};
  const worker: ProbeWorker = {
    onMessage: listener => {message = listener;},
    onError: listener => {error = listener;},
    onExit: listener => {exit = listener;},
    terminate: vi.fn(async () => {})
  };
  const dependencies = {
    createDirectory: vi.fn(createDirectory),
    createWorker: vi.fn(() => worker),
    removeDirectory: vi.fn(async () => {}),
    report: vi.fn()
  };
  return {probe: new ServiceProbe(dependencies), dependencies, worker,
    message: (value: unknown) => message(value), error: () => error(new Error('worker failed')), exit: (code: number) => exit(code)};
}

afterEach(() => vi.useRealTimers());

describe('Temporary storage probe lifecycle (partial REG-011)', () => {
  it('removes a directory created after shutdown began without creating a worker', async () => {
    let finish: (directory: string) => void = () => {};
    const f = fixture(() => new Promise(resolve => {finish = resolve;}));
    const initialization = f.probe.start();
    const shutdown = f.probe.stop();
    finish('late-directory');
    await Promise.all([initialization, shutdown]);
    expect(f.dependencies.createWorker).not.toHaveBeenCalled();
    expect(f.dependencies.removeDirectory).toHaveBeenCalledExactlyOnceWith('late-directory');
    expect(f.dependencies.report.mock.calls).toEqual([[{type: 'stopped'}]]);
  });

  it('ignores late readiness and disposes resources once on repeated stop', async () => {
    const f = fixture();
    await f.probe.start();
    const first = f.probe.stop();
    f.message({type: 'verified'});
    await Promise.all([first, f.probe.stop()]);
    expect(f.worker.terminate).toHaveBeenCalledTimes(1);
    expect(f.dependencies.removeDirectory).toHaveBeenCalledTimes(1);
    expect(f.dependencies.report.mock.calls).toEqual([[{type: 'stopped'}]]);
  });

  it('reports a silent worker exit instead of waiting for readiness', async () => {
    const f = fixture();
    await f.probe.start();
    f.exit(0);
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'failed', code: 'STORAGE_WORKER_EXIT'}], [{type: 'stopped'}]
    ]);
  });

  it('bounds a stalled probe and suppresses late messages after timeout', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.probe.start();
    await vi.advanceTimersByTimeAsync(10000);
    f.message({type: 'verified'});
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'failed', code: 'STORAGE_TIMEOUT'}], [{type: 'stopped'}]
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('accepts one verified result and removes the probe on shutdown', async () => {
    const f = fixture();
    await f.probe.start();
    f.message({type: 'verified'});
    f.message({type: 'verified'});
    f.exit(0);
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([[{type: 'ready'}], [{type: 'stopped'}]]);
  });

  it('rejects malformed results and bounds error diagnostics', async () => {
    const f = fixture();
    await f.probe.start();
    f.message(null);
    f.error();
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'failed', code: 'STORAGE_PROBE_FAILED'}], [{type: 'stopped'}]
    ]);
  });

  it('does not hide a worker crash after a verified result', async () => {
    const f = fixture();
    await f.probe.start();
    f.message({type: 'verified'});
    f.exit(1);
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'ready'}], [{type: 'failed', code: 'STORAGE_WORKER_EXIT'}], [{type: 'stopped'}]
    ]);
  });

  it('reports directory creation failure without attempting cleanup on an unknown path', async () => {
    const f = fixture(async () => {throw new Error('access denied');});
    await f.probe.start();
    await f.probe.stop();
    expect(f.dependencies.createWorker).not.toHaveBeenCalled();
    expect(f.dependencies.removeDirectory).not.toHaveBeenCalled();
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'failed', code: 'SERVICE_START_FAILED'}], [{type: 'stopped'}]
    ]);
  });

  it('removes its temporary directory if worker construction throws', async () => {
    const f = fixture();
    f.dependencies.createWorker.mockImplementation(() => {throw new Error('missing entrypoint');});
    await f.probe.start();
    await f.probe.stop();
    expect(f.dependencies.removeDirectory).toHaveBeenCalledExactlyOnceWith('temporary-probe');
    expect(f.dependencies.report.mock.calls).toEqual([
      [{type: 'failed', code: 'SERVICE_START_FAILED'}], [{type: 'stopped'}]
    ]);
  });

  it('reports cleanup failure without pretending that shutdown succeeded', async () => {
    const f = fixture();
    f.dependencies.removeDirectory.mockRejectedValue(new Error('locked file'));
    await f.probe.start();
    await f.probe.stop();
    expect(f.dependencies.report.mock.calls).toEqual([[{type: 'failed', code: 'SERVICE_STOP_FAILED'}]]);
  });
});
