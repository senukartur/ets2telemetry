import {EventEmitter} from 'node:events';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

type Launcher = EventEmitter & {exitCode: number | null; signalCode: string | null};
type Observation = Record<string, unknown>;
const {observeExit} = await import(pathToFileURL(path.resolve('scripts/ci/exit-observation.mjs')).href) as {
  observeExit(input: {application: EventEmitter; launcher: Launcher; request: () => unknown; record: Observation; message: string; requireRequest?: boolean}): Promise<{code: number; signal: null}>;
};
beforeEach(() => {vi.useFakeTimers(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now());});
afterEach(() => {vi.restoreAllMocks(); vi.useRealTimers();});
function fixture(requireRequest = false) {
  const application = new EventEmitter(), launcher = Object.assign(new EventEmitter(), {exitCode: null as number | null, signalCode: null as string | null});
  const stdout = Object.assign(new EventEmitter(), {closed: false, destroyed: false});
  const stderr = Object.assign(new EventEmitter(), {closed: false, destroyed: false});
  Object.assign(launcher, {stdout, stderr});
  const record: Observation = {}, request = vi.fn<() => unknown>(() => undefined);
  const run = () => observeExit({application, launcher, request, record, requireRequest, message: 'EXIT_TIMEOUT'});
  const exit = (code: number | null = 0, signal: string | null = null) => {
    launcher.exitCode = code; launcher.signalCode = signal; launcher.emit('exit', code, signal);
  };
  const cleaned = () => {
    expect(launcher.listenerCount('exit') + launcher.listenerCount('close') + application.listenerCount('close')).toBe(0);
    expect(stdout.listenerCount('close') + stderr.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  };
  return {application, launcher, stdout, stderr, record, request, run, exit, cleaned};
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
