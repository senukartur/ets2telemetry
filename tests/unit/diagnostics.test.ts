import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createDiagnostics} from '../../apps/desktop/src/diagnostics';
import {mainLogLocation, SERVICE_LOG_ROOT_VARIABLE, serviceEnvironment, serviceLogLocation} from '../../apps/desktop/src/log-location';

/**
 * Filesystem seams for the writer. `appendFile` (node:fs/promises) records every write; a `gate` holds writes that start
 * while it is set, and `fail` rejects that many writes. `syncDelayMs` slows `appendFileSync` (node:fs), as a stalled disk
 * or file-system filter would, so a writer that appends synchronously blocks its caller. `syncWrites` records synchronous
 * appends and `syncFail` makes the next one throw.
 *
 * The asynchronous `appendFile` completes only through promises: once its gate is open it writes the file with the real,
 * undelayed `appendFileSync`. No test therefore waits for real thread-pool I/O, which a loaded runner can delay without
 * bound; one macrotask turn (afterCallbacks) delivers every completion that is due.
 */
const control = vi.hoisted(() => ({syncDelayMs: 0, gate: undefined as Promise<void> | undefined, fail: 0, writes: [] as string[], syncWrites: [] as string[], syncFail: false}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = (...args: Parameters<typeof actual.appendFileSync>) => {
    if (control.syncDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, control.syncDelayMs);
    control.syncWrites.push(String(args[1]));
    if (control.syncFail) { control.syncFail = false; throw new Error('EIO: i/o error, open C:\\private\\startup.jsonl'); }
    actual.appendFileSync(...args);
  };
  return {...actual, default: {...actual, appendFileSync}, appendFileSync};
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const {appendFileSync: realAppendFileSync} = await vi.importActual<typeof import('node:fs')>('node:fs');
  const appendFile = async (...args: Parameters<typeof actual.appendFile>) => {
    control.writes.push(String(args[1]));
    const gate = control.gate;
    if (gate) await gate;
    if (control.fail > 0) { control.fail--; throw new Error('EIO: i/o error, open C:\\private\\startup.jsonl'); }
    realAppendFileSync(args[0] as string, String(args[1]), 'utf8');
  };
  return {...actual, default: {...actual, appendFile}, appendFile};
});

const directories: string[] = [];
function directory() {const result = mkdtempSync(path.join(tmpdir(), 'ets2-log-test-')); directories.push(result); return result;}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true});
  Object.assign(control, {syncDelayMs: 0, gate: undefined, fail: 0, writes: [], syncWrites: [], syncFail: false});
  vi.restoreAllMocks(); vi.useRealTimers();
});
function held() {
  let release!: () => void;
  control.gate = new Promise<void>(resolve => {release = resolve;});
  return () => {control.gate = undefined; release();};
}
const rows = (dir: string) => readFileSync(path.join(dir, 'startup.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as {event: string; detail?: unknown});

it('stores structured events, suppressing sensitive details by default', async () => {
  const dir = directory(), log = createDiagnostics(dir);
  log('FAILURE', new Error('private path'));
  expect(await log.flush(5000)).toBe(true);
  const record = JSON.parse(readFileSync(path.join(dir, 'startup.jsonl'), 'utf8'));
  expect(record.event).toBe('FAILURE');
  expect(record.detail).toBeUndefined();
  expect(record.pid).toBe(process.pid);
});
it('always records fixed facts while still suppressing the default detail', async () => {
  const dir = directory(), log = createDiagnostics(dir);
  log('NATIVE_BROKER_EXIT', new Error('private path'), {outcome: 'busy', stage: 'policy-publish', win32Error: 5, elapsedMs: null});
  await log.flush(5000);
  const record = JSON.parse(readFileSync(path.join(dir, 'startup.jsonl'), 'utf8'));
  expect(record.facts).toEqual({outcome: 'busy', stage: 'policy-publish', win32Error: 5, elapsedMs: null}); expect(record.detail).toBeUndefined();
});
it('retains opt-in errors and caps file growth and individual messages', async () => {
  const dir = directory();
  const log = createDiagnostics(dir, true);
  log('FAILURE', new Error('diagnostic reason'));
  for (let i = 0; i < 3000; i++) log('STDERR', 'x'.repeat(10000));
  await log.flush(5000);
  const filename = path.join(dir, 'startup.jsonl');
  expect(statSync(filename).size).toBeLessThanOrEqual(256 * 1024);
  const records = readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records[0].detail.message).toBe('diagnostic reason');
  expect(records[1].detail.length).toBe(4096);
  const next = createDiagnostics(dir);
  next('NEXT_RUN'); await next.flush(5000);
  expect(statSync(`${filename}.1`).size).toBeLessThanOrEqual(256 * 1024);
  expect(rows(dir).map(row => row.event)).toEqual(['NEXT_RUN']);
});
it('does not throw on an unwritable log destination or expose details in fallback', async () => {
  const dir = directory();
  const file = path.join(dir, 'not-a-directory');
  writeFileSync(file, 'fixture');
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = createDiagnostics(file, true);
  expect(() => log('DISK_FAILURE', new Error('private'))).not.toThrow();
  await log.flush(5000);
  expect(fallback).toHaveBeenCalledExactlyOnceWith('[ETS2Telemetry] DISK_FAILURE');
});

// Regression (October 18, 2026): a synchronous append blocked the caller's thread, once for 1,184 ms on the development
// host, which stalled the telemetry service's shutdown verdicts. The append now runs off the caller's thread.
it('returns to the caller at once while the disk is slow, and writes the record afterwards', async () => {
  const dir = directory(), log = createDiagnostics(dir);
  control.syncDelayMs = 300;
  const release = held();
  const started = performance.now();
  log('SLOW_DISK', undefined, {count: 1});
  expect(performance.now() - started).toBeLessThan(100);
  release();
  expect(await log.flush(5000)).toBe(true);
  expect(rows(dir).map(row => row.event)).toEqual(['SLOW_DISK']);
});
it('keeps the order across batches, with one write at a time', async () => {
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('FIRST'); log('SECOND'); log('THIRD');
  // The first record is being written; the others wait behind it and are written together.
  expect(control.writes).toHaveLength(1);
  release();
  await log.flush(5000);
  expect(control.writes.map(chunk => chunk.trim().split('\n').map(line => (JSON.parse(line) as {event: string}).event)))
    .toEqual([['FIRST'], ['SECOND', 'THIRD']]);
  expect(rows(dir).map(row => row.event)).toEqual(['FIRST', 'SECOND', 'THIRD']);
});
it('bounds what a stalled disk holds in memory by the 256 KiB and 2,000-record limits', async () => {
  const dir = directory(), log = createDiagnostics(dir, true);
  const release = held();
  for (let i = 0; i < 3000; i++) log('STDERR', 'x'.repeat(10000));
  for (let i = 0; i < 3000; i++) log('TINY');
  release();
  await log.flush(5000);
  // Everything that was ever queued fits the file bound; the rest was refused when it was logged, as before.
  expect(control.writes.reduce((sum, chunk) => sum + Buffer.byteLength(chunk), 0)).toBeLessThanOrEqual(256 * 1024);
  expect(statSync(path.join(dir, 'startup.jsonl')).size).toBeLessThanOrEqual(256 * 1024);
  const small = directory(), counted = createDiagnostics(small);
  for (let i = 0; i < 2100; i++) counted('TINY');
  await counted.flush(5000);
  expect(rows(small)).toHaveLength(2000);
});
it('reports a failed write and everything after it on the console, in order, without throwing', async () => {
  const dir = directory(), log = createDiagnostics(dir, true);
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => {});
  const release = held();
  control.fail = 1;
  log('FIRST', new Error('private')); log('SECOND'); log('THIRD');
  release();
  await log.flush(5000);
  log('FOURTH');
  await log.flush(5000);
  expect(fallback.mock.calls.map(call => call[0] as string)).toEqual(['FIRST', 'SECOND', 'THIRD', 'FOURTH'].map(event => `[ETS2Telemetry] ${event}`));
  expect(JSON.stringify(fallback.mock.calls)).not.toContain('private');
  expect(control.writes).toHaveLength(1);
});
// Crash path (review round 1): the telemetry service's crash handler writes the queue synchronously before it exits.
it('drains the queue synchronously on the crash path; a batch already in flight may land after it or be lost', async () => {
  const dir = directory(), log = createDiagnostics(dir, true);
  const release = held();
  log('IN_FLIGHT'); log('QUEUED'); log('SERVICE_UNCAUGHT', new Error('cause'), {kind: 'exception'});
  log.drainSync();
  // The queued rows are on disk when drainSync returns, in one bounded write, while the first batch is still held.
  expect(control.syncWrites).toHaveLength(1);
  expect(Buffer.byteLength(control.syncWrites[0])).toBeLessThanOrEqual(256 * 1024);
  expect(rows(dir).map(row => row.event)).toEqual(['QUEUED', 'SERVICE_UNCAUGHT']);
  expect(rows(dir)[1].detail).toMatchObject({message: 'cause'});
  release();
  expect(await log.flush(5000)).toBe(true);
  // The documented reordering: here the batch that was in flight lands after the drained rows (a process that exits first
  // loses it instead), and nothing is written twice.
  expect(rows(dir).map(row => row.event)).toEqual(['QUEUED', 'SERVICE_UNCAUGHT', 'IN_FLIGHT']);
  log.drainSync();
  expect(control.syncWrites).toHaveLength(1);
});
it('reports a failed synchronous drain on the console by event code only', async () => {
  const dir = directory(), log = createDiagnostics(dir, true);
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => {});
  const release = held();
  log('IN_FLIGHT'); log('SERVICE_UNCAUGHT', new Error('private'), {kind: 'rejection'});
  control.syncFail = true;
  expect(() => log.drainSync()).not.toThrow();
  expect(fallback.mock.calls.map(call => call[0] as string)).toEqual(['[ETS2Telemetry] SERVICE_UNCAUGHT']);
  release();
  await log.flush(5000);
});
// Final write (October 18, 2026): dispatch run 39094511631 lost the service's last SHUTDOWN_STEP and SERVICE_REPORT rows on a
// 4-processor runner at a 25% CPU cap, because the exit waited a fixed 150 ms for asynchronous appends that had not
// finished. The final write now gives the append in flight a bounded wait and then writes the queue synchronously.
const events = (dir: string) => rows(dir).map(row => row.event);
/**
 * One macrotask turn (immediates are not faked): every promise continuation that is due runs first, including the
 * completion of an append whose gate was opened. The mock does no real asynchronous I/O, so nothing else is awaited.
 */
const afterCallbacks = () => new Promise<void>(resolve => setImmediate(resolve));
it('leaves every queued row on disk once at exit, after a slow in-flight write settles within the bound', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('IN_FLIGHT'); log('SHUTDOWN_STEP'); log('SERVICE_REPORT');
  let done = false;
  void log.finalize(2700).then(() => {done = true;});
  await vi.advanceTimersByTimeAsync(200);
  expect(done).toBe(false);
  // The slow append settles after 200 ms, well past the earlier fixed 150 ms wait.
  release(); await afterCallbacks();
  expect(done).toBe(true);
  expect(events(dir)).toEqual(['IN_FLIGHT', 'SHUTDOWN_STEP', 'SERVICE_REPORT']);
  // One asynchronous append (the batch in flight), then one synchronous append of the queue; nothing written twice.
  expect(control.writes).toHaveLength(1);
  expect(control.syncWrites).toHaveLength(1);
  // A row logged after the final write is on disk when log() returns, and no asynchronous append starts any more.
  log('LATE_ROW');
  expect(events(dir)).toEqual(['IN_FLIGHT', 'SHUTDOWN_STEP', 'SERVICE_REPORT', 'LATE_ROW']);
  expect(control.writes).toHaveLength(1);
});
it('still writes every queued row before exit when the in-flight write outlasts the bound, and never twice', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('STORAGE_PROBE_STEP'); log('HISTORY_STORAGE_STEP'); log('SERVICE_REPORT');
  let done = false;
  void log.finalize(150).then(() => {done = true;});
  await vi.advanceTimersByTimeAsync(150);
  expect(done).toBe(true);
  // At exit: the queued rows are on disk; only the batch still in flight is not (it may land later or be lost).
  expect(events(dir)).toEqual(['HISTORY_STORAGE_STEP', 'SERVICE_REPORT']);
  release(); await afterCallbacks();
  expect(events(dir).sort()).toEqual(['HISTORY_STORAGE_STEP', 'SERVICE_REPORT', 'STORAGE_PROBE_STEP']);
});
it('settles before a failure report: the queue is on disk, then logging continues asynchronously', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('FIRST'); log('SERVICE_REPORT');
  let done = false;
  void log.settle(500).then(() => {done = true;});
  await vi.advanceTimersByTimeAsync(100); expect(done).toBe(false);
  release(); await afterCallbacks();
  expect(done).toBe(true);
  expect(events(dir)).toEqual(['FIRST', 'SERVICE_REPORT']);
  expect([control.writes.length, control.syncWrites.length]).toEqual([1, 1]);
  log('AFTER'); expect(control.writes).toHaveLength(2);
  await afterCallbacks();
  expect(await log.flush(0)).toBe(true);
  expect(events(dir)).toEqual(['FIRST', 'SERVICE_REPORT', 'AFTER']);
});
// Review round 1: a stop that overran its budget leaves no time to wait, so the queue is written within the call.
it('writes the queue at once when no time is left, even while an append is in flight', async () => {
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('IN_FLIGHT'); log('SHUTDOWN_STEP'); log('SERVICE_REPORT');
  const finished = log.finalize(0);
  // Already on disk when finalize returns, before any timer or I/O callback ran.
  expect(events(dir)).toEqual(['SHUTDOWN_STEP', 'SERVICE_REPORT']);
  expect(control.syncWrites).toHaveLength(1);
  await finished;
  release(); await afterCallbacks();
  expect(events(dir).sort()).toEqual(['IN_FLIGHT', 'SERVICE_REPORT', 'SHUTDOWN_STEP']);
  expect(control.writes).toHaveLength(1);
});
// Review round 1 (nit): after a settle that its timer ended, no new asynchronous append starts until the one in flight
// finished, so two appends are never in flight together.
it('starts no asynchronous append after a timer-ended settle until the append in flight finishes', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const dir = directory(), log = createDiagnostics(dir);
  const release = held();
  log('IN_FLIGHT'); log('QUEUED');
  let done = false;
  void log.settle(100).then(() => {done = true;});
  await vi.advanceTimersByTimeAsync(100);
  expect(done).toBe(true);
  expect(events(dir)).toEqual(['QUEUED']);
  log('AFTER');
  expect(control.writes).toHaveLength(1);
  release(); await afterCallbacks();
  expect(await log.flush(0)).toBe(true);
  expect(control.writes).toHaveLength(2);
  expect(events(dir)).toEqual(['QUEUED', 'IN_FLIGHT', 'AFTER']);
});
it('bounds the flush: it reports false after its wait and true once the records are written', async () => {
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
  const dir = directory(), log = createDiagnostics(dir);
  expect(await log.flush(250)).toBe(true);
  const release = held();
  log('FINAL_ROW');
  let first: boolean | undefined;
  void log.flush(250).then(done => {first = done;});
  await vi.advanceTimersByTimeAsync(249); expect(first).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1); expect(first).toBe(false);
  const second = log.flush(1000);
  release();
  vi.useRealTimers();
  expect(await second).toBe(true);
  expect(rows(dir).map(row => row.event)).toEqual(['FINAL_ROW']);
});
// Log location: main resolves one root and hands it to the telemetry service at fork, so a diagnostic bundle that reads
// both logs from one root also finds the service rows when LOCALAPPDATA is unset.
const USER_DATA = 'C:\\isolated\\user-data', TEMP = 'C:\\isolated\\temp';
/** Main's location, and the service's for the environment main forks it with. */
function locations(env: Record<string, string | undefined>) {
  const main = mainLogLocation(env, USER_DATA);
  return {main, service: serviceLogLocation(serviceEnvironment(env, main.directory), TEMP)};
}
it('puts both logs under LOCALAPPDATA when it is set', () => {
  const root = path.join('C:\\isolated\\local', 'ETS2Telemetry', 'logs');
  expect(locations({LOCALAPPDATA: 'C:\\isolated\\local'})).toEqual({main: {directory: root, detailed: false}, service: {directory: path.join(root, 'service'), detailed: false}});
});
it('puts the service log under main\'s userData root, not TEMP, when LOCALAPPDATA is unset', () => {
  const root = path.join(USER_DATA, 'ETS2Telemetry', 'logs');
  expect(locations({})).toEqual({main: {directory: root, detailed: false}, service: {directory: path.join(root, 'service'), detailed: false}});
  expect(locations({LOCALAPPDATA: ''}).service.directory).toBe(path.join(root, 'service'));
});
it('keeps the diagnostic directory first, with detailed logs, in both processes', () => {
  const diagnostic = 'C:\\isolated\\diagnostics';
  expect(locations({ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostic, LOCALAPPDATA: 'C:\\isolated\\local'}))
    .toEqual({main: {directory: diagnostic, detailed: true}, service: {directory: path.join(diagnostic, 'service'), detailed: true}});
  // The override wins over a passed root that differs from it.
  expect(serviceLogLocation({ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostic, [SERVICE_LOG_ROOT_VARIABLE]: 'C:\\isolated\\other'}, TEMP))
    .toEqual({directory: path.join(diagnostic, 'service'), detailed: true});
});
it('replaces a log root in main\'s own environment with the one main resolved', () => {
  const env = {LOCALAPPDATA: 'C:\\isolated\\local', [SERVICE_LOG_ROOT_VARIABLE]: 'C:\\isolated\\elsewhere'};
  expect(locations(env).service.directory).toBe(path.join('C:\\isolated\\local', 'ETS2Telemetry', 'logs', 'service'));
  expect(env[SERVICE_LOG_ROOT_VARIABLE]).toBe('C:\\isolated\\elsewhere');
});
it('keeps the earlier fallbacks for a service started without an absolute root from main', () => {
  for (const passed of [undefined, '', 'relative\\logs']) {
    expect(serviceLogLocation({LOCALAPPDATA: 'C:\\isolated\\local', [SERVICE_LOG_ROOT_VARIABLE]: passed}, TEMP).directory)
      .toBe(path.join('C:\\isolated\\local', 'ETS2Telemetry', 'logs', 'service'));
    expect(serviceLogLocation({[SERVICE_LOG_ROOT_VARIABLE]: passed}, TEMP)).toEqual({directory: path.join(TEMP, 'ETS2Telemetry', 'logs', 'service'), detailed: false});
  }
});
