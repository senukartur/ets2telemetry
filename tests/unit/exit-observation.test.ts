import {EventEmitter} from 'node:events';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

type Launcher = EventEmitter & {exitCode: number | null; signalCode: string | null};
type Observation = Record<string, unknown>;
type MainIdentity = {pid: number; createdMs: number; executable: string};
type MainEvent = {state: string; reason?: string; code?: number};
type MainObserver = (identity: MainIdentity, update: (event: MainEvent) => void) => {ready: Promise<void>; dispose(): Promise<unknown>};
const {observeExit, observeMainProcess} = await import(pathToFileURL(path.resolve('scripts/ci/exit-observation.mjs')).href) as {
  observeExit(input: {application: EventEmitter; launcher: Launcher; request: () => unknown; record: Observation; message: string; requireRequest?: boolean; observeMain?: MainObserver}): Promise<{code: number; signal: null}>;
  observeMainProcess(identity: MainIdentity, update: (event: MainEvent) => void, options: {spawnProcess: (...args: unknown[]) => unknown; platform: string}): ReturnType<MainObserver>;
};
beforeEach(() => {vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());});
afterEach(() => {vi.restoreAllMocks(); vi.useRealTimers();});
function fixture(requireRequest = false) {
  const application = Object.assign(new EventEmitter(), {evaluate: undefined as (() => Promise<unknown>) | undefined}), launcher = Object.assign(new EventEmitter(), {pid: 200, exitCode: null as number | null, signalCode: null as string | null});
  const stdout = Object.assign(new EventEmitter(), {closed: false, destroyed: false});
  const stderr = Object.assign(new EventEmitter(), {closed: false, destroyed: false});
  Object.assign(launcher, {stdout, stderr});
  const record: Observation = {}, request = vi.fn<() => unknown>(() => undefined);
  let observeMain: MainObserver | undefined;
  const run = () => observeExit({application, launcher, request, record, requireRequest, observeMain, message: 'EXIT_TIMEOUT'});
  const main = () => {
    const identity = {pid: 100, createdMs: 123456, executable: 'C:\\fixture\\staging.exe'}, update: {current: (event: MainEvent) => void} = {current: () => {}};
    const dispose = vi.fn(() => Promise.resolve({closed: true}));
    application.evaluate = vi.fn(() => Promise.resolve(identity));
    observeMain = vi.fn((captured, emit) => {expect(captured).toEqual(identity); update.current = emit; emit({state: 'opened'}); return {ready: Promise.resolve(), dispose};});
    return {identity, update, dispose, fail(observer: MainObserver) {observeMain = observer;}};
  };
  const exit = (code: number | null = 0, signal: string | null = null) => {
    launcher.exitCode = code; launcher.signalCode = signal; launcher.emit('exit', code, signal);
  };
  const cleaned = () => {
    expect(launcher.listenerCount('exit') + launcher.listenerCount('close') + application.listenerCount('close')).toBe(0);
    expect(stdout.listenerCount('close') + stderr.listenerCount('close') + stdout.listenerCount('data') + stderr.listenerCount('data')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  };
  return {application, launcher, stdout, stderr, record, request, run, exit, cleaned, main};
}
it('installs observers before the request and requires a real clean launcher exit', async () => {
  const f = fixture();
  f.request.mockImplementation(() => {f.exit(); f.launcher.emit('close'); f.application.emit('close');});
  await expect(f.run()).resolves.toEqual({code: 0, signal: null});
  expect(f.record).toMatchObject({request: 'fulfilled', launcherExited: true, launcherExit: 0, signal: null, launcherClosed: true, applicationClosed: true});
  f.cleaned();
});
it('does not treat a fulfilled request or application close as a process exit', async () => {
  const f = fixture(), pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT');
  await Promise.resolve(); f.application.emit('close');
  await vi.advanceTimersByTimeAsync(7999); expect(f.record.elapsedMilliseconds).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await failed;
  expect(f.record).toMatchObject({request: 'fulfilled', launcherExited: false, launcherExit: null, applicationClosed: true, elapsedMilliseconds: 8000});
  f.cleaned();
});
it.each([false, true])('bounds a hanging request even after launcher exit (Playwright close required: %s)', async requireRequest => {
  const f = fixture(requireRequest); let reject!: (error: Error) => void;
  f.request.mockReturnValue(new Promise((_, no) => {reject = no;}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT');
  await Promise.resolve(); f.exit(); f.stdout.closed = true; f.stdout.destroyed = true; f.stdout.emit('close');
  await vi.advanceTimersByTimeAsync(8000); await failed;
  expect(f.record).toMatchObject({request: 'pending', launcherExited: true, launcherExit: 0, launcherClosed: false, applicationClosed: false});
  expect(f.record).toMatchObject({stdout: {closed: true, destroyed: true}, stderr: {closed: false, destroyed: false}});
  // A request that rejects after the deadline must be consumed, with no listener or timer retained.
  reject(new Error('late debugger rejection')); await Promise.resolve(); await Promise.resolve();
  expect(f.record.request).toBe('pending'); f.cleaned();
});
it('keeps Playwright close pending when process exit preceded its close response', async () => {
  const f = fixture(true); let complete!: () => void;
  f.request.mockReturnValue(new Promise<void>(resolve => {complete = resolve;}));
  const pending = f.run(); await Promise.resolve(); f.exit(); await vi.advanceTimersByTimeAsync(120);
  expect(f.record.elapsedMilliseconds).toBeUndefined();
  f.launcher.emit('close'); f.application.emit('close'); complete();
  await expect(pending).resolves.toEqual({code: 0, signal: null}); expect(f.record.elapsedMilliseconds).toBe(120); f.cleaned();
});
it.each([{code: 1, signal: null}, {code: null, signal: 'SIGTERM'}])('rejects an unclean launcher outcome %j', async outcome => {
  const f = fixture(), pending = f.run(); f.exit(outcome.code, outcome.signal);
  await expect(pending).rejects.toThrow(); expect(f.record).toMatchObject({launcherExit: outcome.code, signal: outcome.signal}); f.cleaned();
});
it('accepts an evaluation torn down by a clean exit, but preserves a failed required close', async () => {
  for (const required of [false, true]) {
    const f = fixture(required); f.request.mockImplementation(() => {f.exit(); throw new Error('debugger gone');});
    if (required) await expect(f.run()).rejects.toThrow('debugger gone');
    else await expect(f.run()).resolves.toEqual({code: 0, signal: null});
    expect(f.record.request).toBe('rejected'); f.cleaned();
  }
});
it('accepts a launcher whose exit was already recorded and cleans up on request failure', async () => {
  const f = fixture(true); f.exit(); f.request.mockRejectedValue(new Error('close failed'));
  await expect(f.run()).rejects.toThrow('close failed'); expect(f.record.launcherExited).toBe(true); f.cleaned();
});

it('records exact main termination while a shell and required Playwright close remain pending, without passing', async () => {
  const f = fixture(true), main = f.main(); f.request.mockReturnValue(new Promise(() => {}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT'); await vi.advanceTimersByTimeAsync(0);
  main.update.current({state: 'terminated', code: 0});
  await vi.advanceTimersByTimeAsync(7999); expect(f.record.elapsedMilliseconds).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await failed;
  expect(f.record).toMatchObject({launcherPid: 200, launcherExited: false, request: 'pending', elapsedMilliseconds: 8000,
    main: {pid: 100, identity: 'verified', executable: 'staging.exe', termination: 'exited', exitCode: 0, observerCleanup: {closed: true}}});
  expect(main.dispose).toHaveBeenCalledTimes(1); f.cleaned();
});
it('keeps the same failure verdict when the shell exits but the required close is still pending', async () => {
  const f = fixture(true), main = f.main(); f.request.mockReturnValue(new Promise(() => {}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT'); await vi.advanceTimersByTimeAsync(0); f.exit();
  await vi.advanceTimersByTimeAsync(8000); await failed;
  expect(f.record).toMatchObject({request: 'pending', launcherExited: true, main: {termination: 'observing'}, elapsedMilliseconds: 8000});
  expect(main.dispose).toHaveBeenCalledTimes(1); f.cleaned();
});
it('records bounded sanitized shutdown/debugger output without treating APP_EXIT as OS termination', async () => {
  const f = fixture(true); f.main(); f.request.mockReturnValue(new Promise(() => {}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT'); await vi.advanceTimersByTimeAsync(0);
  f.stdout.emit('data', Buffer.from('APP_EXIT code0\n')); f.stderr.emit('data', Buffer.from('Waiting for the debugger to disconnect...\nDebugger ending on ws://127.0.0.1:1234/fixture\nvtc1_secret C:\\private\\user-data\n'));
  f.stderr.emit('data', Buffer.from('x'.repeat(5000)));
  for (let index = 0; index < 40; index++) f.stdout.emit('close');
  await vi.advanceTimersByTimeAsync(8000); await failed;
  expect(f.record).toMatchObject({launcherExited: false, main: {termination: 'observing'}, stdout: {text: 'APP_EXIT code0\n', truncated: false}, stderr: {truncated: true}});
  const stderr = f.record.stderr as {text: string}; expect(stderr.text.length).toBeLessThanOrEqual(4096);
  expect((f.record.stages as unknown[]).length).toBeLessThanOrEqual(32); expect(f.record.stagesTruncated).toBe(true);
  expect(stderr.text).toContain('Waiting for the debugger to disconnect'); expect(stderr.text).toContain('Debugger ending on [url]'); expect(stderr.text).not.toContain('secret'); expect(stderr.text).not.toContain('private'); f.cleaned();
});
it.each(['identity', 'observer'] as const)('keeps %s errors unknown and still requires the original exit conditions', async boundary => {
  const f = fixture(true), main = f.main();
  if (boundary === 'identity') f.application.evaluate = () => Promise.reject(new Error('private-path'));
  else main.fail(() => {throw new Error('private-path');});
  f.request.mockImplementation(() => {f.exit();}); await expect(f.run()).resolves.toEqual({code: 0, signal: null});
  expect(f.record).toMatchObject({main: {termination: 'unknown', reason: 'IDENTITY_OBSERVATION_FAILED'}});
  expect(JSON.stringify(f.record)).not.toContain('private-path'); f.cleaned();
});
it('retires the process observer and consumes a late close rejection after the unchanged deadline', async () => {
  const f = fixture(true), main = f.main(); let reject!: (error: Error) => void;
  f.request.mockReturnValue(new Promise((_, no) => {reject = no;}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT'); await vi.advanceTimersByTimeAsync(8000); await failed;
  const before = JSON.stringify(f.record); reject(new Error('late debugger rejection')); main.update.current({state: 'terminated', code: 0});
  await vi.advanceTimersByTimeAsync(0); expect(JSON.stringify(f.record)).toBe(before); expect(main.dispose).toHaveBeenCalledTimes(1); f.cleaned();
});
it('bounds an unresponsive identity read separately and retains all eight seconds from the actual close request', async () => {
  const f = fixture(true); let reject!: (error: Error) => void;
  f.application.evaluate = () => new Promise((_, no) => {reject = no;}); f.request.mockReturnValue(new Promise(() => {}));
  const pending = f.run(), failed = expect(pending).rejects.toThrow('EXIT_TIMEOUT');
  await vi.advanceTimersByTimeAsync(1999); expect(f.request).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.request).toHaveBeenCalledTimes(1); f.exit();
  await vi.advanceTimersByTimeAsync(7999); expect(f.record.elapsedMilliseconds).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); await failed;
  expect(f.record).toMatchObject({setupMilliseconds: 2000, requestMilliseconds: 8000, elapsedMilliseconds: 10000, request: 'pending',
    main: {identity: 'unknown', termination: 'unknown', reason: 'IDENTITY_SETUP_TIMEOUT'}});
  const before = JSON.stringify(f.record); reject(new Error('late identity rejection')); await vi.advanceTimersByTimeAsync(0);
  expect(JSON.stringify(f.record)).toBe(before); f.cleaned();
});
it('keeps a null Electron creation time unknown rather than converting it to zero', async () => {
  const f = fixture(true), main = f.main(); f.application.evaluate = () => Promise.resolve({...main.identity, createdMs: null});
  f.request.mockImplementation(() => {f.exit();}); await expect(f.run()).resolves.toEqual({code: 0, signal: null});
  expect(f.record).toMatchObject({main: {identity: 'unknown', createdMs: null, termination: 'unknown', reason: 'IDENTITY_UNAVAILABLE'}});
  expect(main.dispose).not.toHaveBeenCalled(); f.cleaned();
});
it('bounds a nonresponsive observer setup and reports cleanup failure without changing the close verdict', async () => {
  const f = fixture(true), main = f.main(), dispose = vi.fn(() => Promise.reject(new Error('private cleanup error')));
  main.fail(() => ({ready: new Promise(() => {}), dispose})); f.request.mockImplementation(() => {f.exit();});
  const pending = f.run(); await vi.advanceTimersByTimeAsync(2000); await expect(pending).resolves.toEqual({code: 0, signal: null});
  expect(f.record).toMatchObject({setupMilliseconds: 2000, requestMilliseconds: 0, main: {termination: 'unknown', reason: 'IDENTITY_SETUP_TIMEOUT', observerCleanup: {closed: false}}});
  expect(JSON.stringify(f.record)).not.toContain('private cleanup error'); expect(dispose).toHaveBeenCalledTimes(1); f.cleaned();
});
function observerChild() {
  const stdout = new EventEmitter(), child = Object.assign(new EventEmitter(), {stdout, exitCode: null as number | null, signalCode: null as string | null,
    kill: vi.fn(() => {child.signalCode = 'SIGTERM'; child.emit('close'); return true;})});
  const spawnProcess = vi.fn(() => child), identity = {pid: 100, createdMs: 123456, executable: 'C:\\fixture\\staging.exe'}, events: MainEvent[] = [];
  const observation = observeMainProcess(identity, event => events.push(event), {spawnProcess, platform: 'win32'});
  const cleaned = () => {expect(child.listenerCount('error') + child.listenerCount('close') + stdout.listenerCount('data')).toBe(0); expect(vi.getTimerCount()).toBe(0);};
  return {child, stdout, spawnProcess, events, observation, cleaned};
}
it('opens the exact main identity before waiting, and retires only its own hidden observer child', async () => {
  const f = observerChild(); f.stdout.emit('data', Buffer.from('{"event":"opened"}\n')); await f.observation.ready;
  expect(f.events).toEqual([{state: 'opened'}]); expect(f.spawnProcess).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({windowsHide: true,
    env: expect.objectContaining({ETS2TELEMETRY_OBSERVED_PID: '100', ETS2TELEMETRY_OBSERVED_CREATED: '123456', ETS2TELEMETRY_OBSERVED_EXE: 'C:\\fixture\\staging.exe'})}));
  f.stdout.emit('data', Buffer.from('{"event":"terminated","code":0}\n')); expect(f.events.at(-1)).toEqual({state: 'terminated', code: 0});
  await f.observation.dispose(); expect(f.child.kill).toHaveBeenCalledTimes(1); f.cleaned();
});
it.each(['mismatch', 'error', 'closed', 'timeout', 'oversized'] as const)('keeps native observer %s unknown and cleans up its resources', async boundary => {
  const f = observerChild();
  if (boundary === 'mismatch') f.stdout.emit('data', Buffer.from('{"event":"unknown","code":"IDENTITY_MISMATCH"}\n'));
  if (boundary === 'error') f.child.emit('error', new Error('private-path'));
  if (boundary === 'closed') f.child.emit('close');
  if (boundary === 'timeout') await vi.advanceTimersByTimeAsync(2000);
  if (boundary === 'oversized') f.stdout.emit('data', Buffer.from('x'.repeat(1025)));
  await f.observation.ready; expect(f.events.every(event => event.state === 'unknown')).toBe(true);
  expect(JSON.stringify(f.events)).not.toContain('private-path'); await f.observation.dispose(); f.cleaned();
});
it('reports an observer cleanup timeout and consumes late child errors until its actual close', async () => {
  const f = observerChild(); f.child.kill.mockImplementation(() => true);
  f.stdout.emit('data', Buffer.from('{"event":"opened"}\n')); await f.observation.ready;
  const cleanup = f.observation.dispose(); await vi.advanceTimersByTimeAsync(1000);
  await expect(cleanup).resolves.toMatchObject({closed: false, reason: 'OBSERVER_CLEANUP_TIMEOUT', errorSinkUntilClose: true});
  expect(f.stdout.listenerCount('data')).toBe(0); expect(f.child.listenerCount('error')).toBe(1);
  f.child.emit('error', new Error('late observer error')); f.child.emit('close'); f.cleaned();
});
