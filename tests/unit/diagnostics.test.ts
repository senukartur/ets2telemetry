import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createDiagnostics} from '../../apps/desktop/src/diagnostics';
const directories: string[] = [];
function directory() {const result = mkdtempSync(path.join(tmpdir(), 'ets2-log-test-')); directories.push(result); return result;}
afterEach(() => {for (const dir of directories.splice(0)) rmSync(dir, {recursive: true, force: true}); vi.restoreAllMocks();});

it('stores structured events, suppressing sensitive details by default', () => {
  const dir = directory();
  createDiagnostics(dir)('FAILURE', new Error('private path'));
  const record = JSON.parse(readFileSync(path.join(dir, 'startup.jsonl'), 'utf8'));
  expect(record.event).toBe('FAILURE');
  expect(record.detail).toBeUndefined();
  expect(record.pid).toBe(process.pid);
});
it('always records fixed facts while still suppressing the default detail', () => {
  const dir = directory();
  createDiagnostics(dir)('NATIVE_BROKER_EXIT', new Error('private path'), {outcome: 'busy', stage: 'policy-publish', win32Error: 5, elapsedMs: null});
  const record = JSON.parse(readFileSync(path.join(dir, 'startup.jsonl'), 'utf8'));
  expect(record.facts).toEqual({outcome: 'busy', stage: 'policy-publish', win32Error: 5, elapsedMs: null}); expect(record.detail).toBeUndefined();
});
it('retains opt-in errors and caps file growth and individual messages', () => {
  const dir = directory();
  const log = createDiagnostics(dir, true);
  log('FAILURE', new Error('diagnostic reason'));
  for (let i = 0; i < 3000; i++) log('STDERR', 'x'.repeat(10000));
  const filename = path.join(dir, 'startup.jsonl');
  expect(statSync(filename).size).toBeLessThanOrEqual(256 * 1024);
  const records = readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(records[0].detail.message).toBe('diagnostic reason');
  expect(records[1].detail.length).toBe(4096);
  createDiagnostics(dir)('NEXT_RUN');
  expect(statSync(`${filename}.1`).size).toBeLessThanOrEqual(256 * 1024);
});
it('does not throw on an unwritable log destination or expose details in fallback', () => {
  const dir = directory();
  const file = path.join(dir, 'not-a-directory');
  writeFileSync(file, 'fixture');
  const fallback = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(() => createDiagnostics(file, true)('DISK_FAILURE', new Error('private'))).not.toThrow();
  expect(fallback).toHaveBeenCalledExactlyOnceWith('[ETS2Telemetry] DISK_FAILURE');
});
