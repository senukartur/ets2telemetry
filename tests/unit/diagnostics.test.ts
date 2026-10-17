import {mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {createDiagnostics} from '../../apps/desktop/src/diagnostics';
import {mainLogLocation, SERVICE_LOG_ROOT_VARIABLE, serviceEnvironment, serviceLogLocation} from '../../apps/desktop/src/log-location';
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
