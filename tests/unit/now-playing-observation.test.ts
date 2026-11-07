import {EventEmitter} from 'node:events';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

// Harness integrity for REG-012, REG-017 and REG-020: persistent checkpoints and required exit/disposal before restart.

type Checkpoint = (phase: string, observation?: Record<string, unknown>) => boolean;
type Observe = (input: {request(): Promise<void>; requireRequest: boolean}) => Promise<{code: number}>;
type Application = EventEmitter & {evaluate: (fn: (electron: {app: {emit: (...args: unknown[]) => boolean}}) => unknown) => Promise<unknown>; close(): Promise<void>};
const {nowPlayingCheckpoints, nowPlayingStage, finishNowPlayingFirstRun, restartNowPlayingAfterExit} = await import(pathToFileURL(path.resolve('scripts/ci/now-playing-observation.mjs')).href) as {
  nowPlayingCheckpoints(filename: string, options: {write(filename: string, bytes: string): void; now(): number}): Checkpoint;
  nowPlayingStage<T>(phase: string, work: () => Promise<T>, checkpoint: Checkpoint, milliseconds: number): Promise<T>;
  finishNowPlayingFirstRun(input: {application: Application; launcher: EventEmitter; record: Record<string, unknown>; checkpoint: Checkpoint; observe?: Observe}): Promise<void>;
  restartNowPlayingAfterExit<T>(input: {exit(): Promise<void>; launch(): Promise<T>; checkpoint: Checkpoint}): Promise<T>;
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => {expect(vi.getTimerCount()).toBe(0); vi.useRealTimers();});
function journal() {
  let stored = '';
  const checkpoint = nowPlayingCheckpoints('fixture-checkpoints.json', {write(_filename, bytes) {stored = bytes;}, now: Date.now});
  return {checkpoint, read: () => JSON.parse(stored) as {rows: {phase: string; exit?: Record<string, unknown>}[]; truncated: boolean}};
}
function application() {
  const emit = vi.fn(() => true), close = vi.fn(() => Promise.resolve());
  const app = Object.assign(new EventEmitter(), {evaluate: vi.fn((fn: (electron: {app: {emit: typeof emit}}) => unknown) => Promise.resolve(fn({app: {emit}}))), close});
  return {app, emit, close};
}
const observe: Observe = async input => {expect(input.requireRequest).toBe(true); await input.request(); return {code: 0};};
it('persists a bounded checkpoint before a stalled stage and consumes its late rejection without changing the failure', async () => {
  const j = journal(); let reject!: (error: Error) => void;
  const pending = nowPlayingStage('first-trace-stop', () => new Promise((_, no) => {reject = no;}), j.checkpoint, 5000), failed = expect(pending).rejects.toThrow('NOW_PLAYING_FIRST_TRACE_STOP_TIMEOUT');
  expect(j.read().rows).toEqual([{phase: 'first-trace-stop-started', milliseconds: 0}]);
  await vi.advanceTimersByTimeAsync(5000); await failed; const before = j.read();
  reject(new Error('late transport error')); await vi.advanceTimersByTimeAsync(0); expect(j.read()).toEqual(before);
  for (let index = 0; index < 100; index++) j.checkpoint('bounded-phase');
  expect(j.read().rows).toHaveLength(64); expect(j.read().truncated).toBe(true);
});
it('requires acknowledged tray delivery and complete transport disposal before restarting', async () => {
  const j = journal(), f = application(), record = {}; let finish!: () => void;
  f.close.mockImplementation(() => new Promise(resolve => {finish = resolve;})); const launch = vi.fn(() => Promise.resolve('second'));
  const pending = restartNowPlayingAfterExit({checkpoint: j.checkpoint, exit: () => finishNowPlayingFirstRun({application: f.app, launcher: new EventEmitter(), record, checkpoint: j.checkpoint, observe}), launch});
  await vi.advanceTimersByTimeAsync(0); expect(f.emit).toHaveBeenCalledWith('ets2telemetry:diagnostic-tray-action', 'exit'); expect(launch).not.toHaveBeenCalled();
  expect(record).toMatchObject({trayExitDelivered: true}); finish(); expect(await pending).toBe('second'); expect(record).toMatchObject({firstExit: 0}); expect(launch).toHaveBeenCalledOnce();
});
it.each(['tray', 'close', 'both'] as const)('preserves required %s failure and prevents a second launch', async boundary => {
  const j = journal(), f = application(), record = {}, trayError = new Error('tray rejected'), closeError = new Error('close rejected');
  if (boundary !== 'close') f.app.evaluate.mockRejectedValue(trayError);
  if (boundary !== 'tray') f.close.mockRejectedValue(closeError);
  const launch = vi.fn(() => Promise.resolve('second'));
  const pending = restartNowPlayingAfterExit({checkpoint: j.checkpoint, exit: () => finishNowPlayingFirstRun({application: f.app, launcher: new EventEmitter(), record, checkpoint: j.checkpoint, observe}), launch});
  if (boundary === 'both') await expect(pending).rejects.toMatchObject({errors: [trayError, closeError]}); else await expect(pending).rejects.toBe(boundary === 'tray' ? trayError : closeError);
  expect(launch).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce(); expect(j.read().rows.at(-1)?.phase).toBe('first-exit-settled'); expect(record).not.toHaveProperty('firstExit');
});
it('keeps required first close pending at the real eight-second guard even after launcher exit', async () => {
  const j = journal(), f = application(), record = {}, launcher = Object.assign(new EventEmitter(), {pid: 200, exitCode: null as number | null, signalCode: null});
  // The identity callback is unavailable in this inert process; the tray callback still executes against a real fake port.
  let reject!: (error: Error) => void; f.close.mockImplementation(() => new Promise((_, no) => {reject = no;}));
  const pending = finishNowPlayingFirstRun({application: f.app, launcher, record, checkpoint: j.checkpoint}), failed = expect(pending).rejects.toThrow('NOW_PLAYING_FIRST_EXIT_TIMEOUT_8_SECONDS');
  await vi.advanceTimersByTimeAsync(0); launcher.exitCode = 0; launcher.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(7999); expect(record).not.toHaveProperty('firstExit');
  await vi.advanceTimersByTimeAsync(1); await failed; expect(j.read().rows.at(-1)?.exit).toMatchObject({request: 'pending', launcherExit: 0});
  reject(new Error('late required close rejection')); await vi.advanceTimersByTimeAsync(0);
  expect(launcher.listenerCount('exit') + launcher.listenerCount('close') + f.app.listenerCount('close')).toBe(0);
});
