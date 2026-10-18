import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createDiagnostics} from '../../apps/desktop/src/diagnostics';

/**
 * Filesystem seams for the writer. `appendFile` (node:fs/promises) records every write; a `gate` holds writes that start
 * while it is set, and `fail` rejects that many writes. `syncDelayMs` slows `appendFileSync` (node:fs), as a stalled disk
 * or file-system filter would, so a writer that appends synchronously blocks its caller.
 */
const control = vi.hoisted(() => ({syncDelayMs: 0, gate: undefined as Promise<void> | undefined, fail: 0, writes: [] as string[]}));
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const appendFileSync = (...args: Parameters<typeof actual.appendFileSync>) => {
    if (control.syncDelayMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, control.syncDelayMs);
    actual.appendFileSync(...args);
  };
  return {...actual, default: {...actual, appendFileSync}, appendFileSync};
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const appendFile = async (...args: Parameters<typeof actual.appendFile>) => {
    control.writes.push(String(args[1]));
    const gate = control.gate;
    if (gate) await gate;
    if (control.fail > 0) { control.fail--; throw new Error('EIO: i/o error, open C:\\private\\startup.jsonl'); }
    await actual.appendFile(...args);
  };
  return {...actual, default: {...actual, appendFile}, appendFile};
});

const directories: string[] = [];
function directory() {const result = mkdtempSync(path.join(tmpdir(), 'ets2-log-test-')); directories.push(result); return result;}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true});
  Object.assign(control, {syncDelayMs: 0, gate: undefined, fail: 0, writes: []});
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
