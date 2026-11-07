import {spawn} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, expect, it, vi} from 'vitest';
import {isUninstallExitPayload} from '../../apps/desktop/src/app-lifecycle';
import {INSTANCE_EXIT_WAIT_MS} from '../../apps/desktop/src/squirrel-events';

// REG-017 (ET-018 U6, risk G1): proves with the real Electron binary that requesting the single-instance lock again after
// a refusal works, which Electron does not document. Two windowless Electron main scripts share an isolated temporary
// userData folder: the holder plays the running instance, the requester the uninstall hook. Nothing of the installed
// application, its profile or its data is involved.

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// The pinned Electron binary that `npm ci` installs; a missing one fails the test rather than skipping it.
const electron = path.join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
const fixtures = path.join(repository, 'tests', 'fixtures', 'single-instance');
const started: Run[] = [];
const HOLDER_READINESS_MS = 8000, REQUEST_RESULT_MS = INSTANCE_EXIT_WAIT_MS + 4000, FINAL_EXIT_MS = 4000;
let lockDir: string | undefined;
afterEach(async () => {
  const profile = lockDir; lockDir = undefined;
  try {
    const cleanup = await Promise.allSettled(started.splice(0).map(run => run.dispose()));
    const failed = cleanup.filter((value): value is PromiseRejectedResult => value.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(value => value.reason), 'RELOCK_CHILD_CLEANUP_FAILED');
    if (profile) await rm(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  } finally {vi.useRealTimers();}
});

interface Run {lines: string[]; readonly exited: Promise<number | null>; line(prefix: string): Promise<string>; dispose(): Promise<void>}
type RelockChild = EventEmitter & {stdout: EventEmitter; stderr: EventEmitter; exitCode: number | null; signalCode: NodeJS.Signals | null; kill(): boolean};
function observeChild(child: RelockChild, role: 'holder' | 'requester'): Run {
  const lines: string[] = [], waiters = new Set<{prefix: string; resolve(line: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>}>();
  let buffered = '', stderr = '', terminal: Error | undefined, didClose = false, disposing = false, code: number | null = null;
  const safe = (value: string) => value.replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n]*/g, '[path]').replace(/[^\x20-\x7e\r\n\t]/g, '?');
  const failure = (reason: string) => new Error(`RELOCK_${role.toUpperCase()}_${reason} ${JSON.stringify({code, signal: child.signalCode, lines: lines.slice(-8).map(safe), stderr: safe(stderr).slice(-512)})}`);
  const fail = (error: Error) => {terminal ??= error; for (const waiter of waiters) {clearTimeout(waiter.timer); waiter.reject(error);} waiters.clear();};
  let exitResolve!: (code: number | null) => void, exitReject!: (error: Error) => void, closeResolve!: () => void;
  const exited = new Promise<number | null>((yes, no) => {exitResolve = yes; exitReject = no;}), closed = new Promise<void>(yes => {closeResolve = yes;});
  void exited.catch(() => undefined);
  const stdout = (chunk: Buffer) => {
    if (disposing) return;
    if (buffered.length + chunk.length > 8192 || lines.length >= 128) {fail(failure('OUTPUT_LIMIT')); return;}
    buffered += chunk.toString('utf8'); let index;
    while ((index = buffered.indexOf('\n')) >= 0) {
      if (lines.length >= 128) {fail(failure('OUTPUT_LIMIT')); buffered = ''; return;}
      const line = buffered.slice(0, index).trim(); buffered = buffered.slice(index + 1);
      if (line.length > 1024) {fail(failure('OUTPUT_LIMIT')); return;} lines.push(line);
      for (const waiter of waiters) if (line.startsWith(waiter.prefix)) {clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(line);}
    }
  };
  const stderrData = (chunk: Buffer) => {stderr = (stderr + chunk.subarray(-2048).toString('utf8')).slice(-2048);};
  const exit = (value: number | null) => {code = value; exitResolve(value);};
  const error = () => {const error = failure('SPAWN_ERROR'); fail(error); exitReject(error);};
  const detach = () => {child.stdout.removeListener('data', stdout); child.stderr.removeListener('data', stderrData); child.removeListener('exit', exit); child.removeListener('error', error); child.removeListener('close', close);};
  const close = () => {didClose = true; fail(failure('CLOSED_BEFORE_LINE')); exitResolve(code); closeResolve(); if (disposing) detach();};
  child.stdout.on('data', stdout); child.stderr.on('data', stderrData); child.on('exit', exit); child.on('error', error); child.on('close', close);
  const bounded = async <T>(work: Promise<T>, milliseconds: number, reason: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {return await Promise.race([work, new Promise<never>((_, no) => {timer = setTimeout(() => no(failure(reason)), milliseconds);})]);}
    finally {clearTimeout(timer);}
  };
  return {lines, get exited() {return bounded(exited, FINAL_EXIT_MS, 'EXIT_TIMEOUT');}, line(prefix) {
    const seen = lines.find(line => line.startsWith(prefix)); if (seen) return Promise.resolve(seen);
    if (terminal) return Promise.reject(terminal);
    return new Promise((resolve, reject) => {
      const waiter = {prefix, resolve, reject, timer: setTimeout(() => {waiters.delete(waiter); reject(failure(prefix === 'HOLDER_LOCKED' ? 'READINESS_TIMEOUT' : 'RESULT_TIMEOUT'));}, prefix === 'HOLDER_LOCKED' ? HOLDER_READINESS_MS : REQUEST_RESULT_MS)};
      waiters.add(waiter);
    });
  }, async dispose() {
    disposing = true; let killFailure: Error | undefined;
    try {if (!didClose && child.exitCode === null && child.signalCode === null) child.kill();} catch {killFailure = failure('CLEANUP_KILL_ERROR');}
    try {await bounded(closed, FINAL_EXIT_MS, 'CLEANUP_TIMEOUT'); if (killFailure) throw killFailure;}
    catch (error) {fail(error instanceof Error ? error : failure('CLEANUP_FAILED')); throw error;}
    finally {if (didClose) detach();}
  }};
}
function launch(script: string, env: Record<string, string>): Run {
  const environment: NodeJS.ProcessEnv = {...process.env, ...env};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(fixtures, script)], {env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  const run = observeChild(child, script === 'holder.cjs' ? 'holder' : 'requester'); started.push(run); return run;
}
const signals = (holder: Run) => holder.lines.filter(line => line.startsWith('HOLDER_SIGNAL ')).map(line => JSON.parse(line.slice('HOLDER_SIGNAL '.length)) as {plain: boolean; data: unknown});
const outcome = async (requester: Run) => JSON.parse((await requester.line('REQUESTER ')).slice('REQUESTER '.length)) as {locked: boolean; requests: number; elapsedMs: number};

function controlledChild() {
  const child = Object.assign(new EventEmitter(), {stdout: new EventEmitter(), stderr: new EventEmitter(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => {child.exitCode = 0; child.emit('exit', 0); child.emit('close'); return true;})});
  const run = observeChild(child, 'holder');
  const cleaned = () => {expect(child.eventNames()).toEqual([]); expect(child.stdout.eventNames()).toEqual([]); expect(child.stderr.eventNames()).toEqual([]); expect(vi.getTimerCount()).toBe(0);};
  return {child, run, cleaned};
}
it('the relock observer joins split readiness lines and disposes its listeners after actual close', async () => {
  vi.useFakeTimers(); const f = controlledChild(), line = f.run.line('HOLDER_LOCKED');
  f.child.stdout.emit('data', Buffer.from('HOLDER_LOC')); f.child.stdout.emit('data', Buffer.from('KED\r\n'));
  expect(await line).toBe('HOLDER_LOCKED'); await f.run.dispose(); expect(await f.run.exited).toBe(0); f.cleaned();
});
it('the relock observer fails a missing line on terminal close and retains bounded stderr context', async () => {
  vi.useFakeTimers(); const f = controlledChild(), line = f.run.line('HOLDER_LOCKED'), rejected = expect(line).rejects.toThrow('RELOCK_HOLDER_CLOSED_BEFORE_LINE');
  f.child.stderr.emit('data', Buffer.from('x'.repeat(3000))); f.child.exitCode = 9; f.child.emit('exit', 9); f.child.emit('close');
  await rejected; await expect(f.run.line('HOLDER_LOCKED')).rejects.toThrow('"code":9'); await f.run.dispose(); f.cleaned();
});
it('the relock observer reports spawn failure before readiness without leaking raw errors', async () => {
  vi.useFakeTimers(); const f = controlledChild(), line = f.run.line('HOLDER_LOCKED'), rejected = expect(line).rejects.toThrow('RELOCK_HOLDER_SPAWN_ERROR');
  f.child.emit('error', new Error('private process path')); await rejected; await expect(f.run.exited).rejects.toThrow('RELOCK_HOLDER_SPAWN_ERROR');
  f.child.emit('close'); await f.run.dispose(); f.cleaned();
});
it('the relock observer waits for owned cleanup close before retiring pending waiters', async () => {
  vi.useFakeTimers(); const f = controlledChild(); f.child.kill.mockImplementation(() => true);
  const line = f.run.line('HOLDER_LOCKED'), rejected = expect(line).rejects.toThrow('CLOSED_BEFORE_LINE');
  let disposed = false; const cleanup = f.run.dispose().then(() => {disposed = true;});
  await vi.advanceTimersByTimeAsync(0); expect(disposed).toBe(false); expect(f.child.listenerCount('error')).toBe(1);
  f.child.emit('close'); await rejected; await cleanup; expect(disposed).toBe(true); f.cleaned();
});
it('the relock observer rejects cleanup stalls and consumes late child errors until actual close', async () => {
  vi.useFakeTimers(); const f = controlledChild(); f.child.kill.mockImplementation(() => true);
  const line = f.run.line('HOLDER_LOCKED'), lineFailed = expect(line).rejects.toThrow('CLEANUP_TIMEOUT');
  const cleanup = f.run.dispose(), failed = expect(cleanup).rejects.toThrow('CLEANUP_TIMEOUT');
  await vi.advanceTimersByTimeAsync(FINAL_EXIT_MS); await failed; await lineFailed;
  expect(f.child.listenerCount('error')).toBe(1); f.child.emit('error', new Error('late process failure')); f.child.emit('close'); f.cleaned();
});

it('a refused requester signals the holder on each request and gets the lock once the holder exits', {timeout: 30_000}, async () => {
  lockDir = await mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-relock-'));
  const holder = launch('holder.cjs', {LOCK_DIR: lockDir, HOLDER_EXIT: '1'});
  await holder.line('HOLDER_LOCKED');
  const requester = launch('requester.cjs', {LOCK_DIR: lockDir, REQUEST_WAIT_MS: String(INSTANCE_EXIT_WAIT_MS)});
  const result = await outcome(requester);
  expect(await holder.exited).toBe(0);
  expect(await requester.exited).toBe(0);
  expect(result.locked).toBe(true);
  // The holder exits 600 ms after the first signal: at least one more request, well inside the 6 s wait.
  expect(result.requests).toBeGreaterThan(1);
  expect(result.elapsedMs).toBeLessThan(INSTANCE_EXIT_WAIT_MS);
  const received = signals(holder);
  expect(received.length).toBeGreaterThanOrEqual(1);
  // Electron delivers the payload as a plain object that main's exact check accepts.
  for (const signal of received) {
    expect(signal).toEqual({plain: true, data: {ets2telemetry: 'uninstall-exit'}});
    expect(isUninstallExitPayload(signal.data)).toBe(true);
  }
});

it('a holder that does not exit keeps the lock: the requester gives up after its wait, having signalled on every request', {timeout: 30_000}, async () => {
  lockDir = await mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-relock-'));
  const holder = launch('holder.cjs', {LOCK_DIR: lockDir, HOLDER_EXIT: '0'});
  await holder.line('HOLDER_LOCKED');
  const requester = launch('requester.cjs', {LOCK_DIR: lockDir, REQUEST_WAIT_MS: '1500'});
  const result = await outcome(requester);
  expect(await requester.exited).toBe(3);
  expect(result.locked).toBe(false);
  // It gave up only after its wait, and requested again while waiting. The number of requests that fit into the real
  // 1.5 s depends on how late a loaded host fires the requester's timers, so only the repetition is asserted, not a rate.
  expect(result.elapsedMs).toBeGreaterThanOrEqual(1500);
  expect(result.requests).toBeGreaterThanOrEqual(2);
  // Every refused request reached the holder.
  await expect.poll(() => signals(holder).length, {timeout: 2000}).toBe(result.requests);
});
