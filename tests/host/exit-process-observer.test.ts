import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';

// REG-012/REG-017 harness: the real exit observer script that scripts/ci/exit-observation.mjs starts with -File.
// It runs against a live Node child owned by this test, never against another process.

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const script = path.resolve('scripts/ci/exit-process-observer.ps1');
// The script autoloads ConvertTo-Json, so it gets Windows PowerShell's own module folder whatever the parent exported.
const environment = {...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath')),
  PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')};
// Bounds one Windows PowerShell start; hosted runners take up to about 2.4 s (docs/ci.md#powershell-validator-test-budgets).
const POWERSHELL_START_TIMEOUT_MS = 30_000;
// A case starts at most two PowerShell processes, plus Vitest's margin.
const CASE_BUDGET_MS = 2 * POWERSHELL_START_TIMEOUT_MS + 5_000;

let observed: ChildProcess | undefined;
afterEach(() => {if (observed && observed.exitCode === null && observed.signalCode === null) observed.kill(); observed = undefined;});

/** A Node child that exits with code 7 after one line on stdin. */
function observedChild() {
  observed = spawn(process.execPath, ['-e', "process.stdin.once('data', () => process.exit(7))"], {stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true});
  const pid = observed.pid!;
  const createdMs = Number(execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[DateTimeOffset]::new([Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`],
  {windowsHide: true, timeout: POWERSHELL_START_TIMEOUT_MS, env: environment, encoding: 'utf8'}).trim());
  return {child: observed, pid, createdMs};
}

/** Runs the script for one identity; `onOpened` runs once the script reports the open handle. */
function observe(identity: {pid: number; createdMs: number; executable: string}, onOpened = () => {}) {
  return new Promise<{code: number | null; events: unknown[]}>((resolve, reject) => {
    const events: unknown[] = []; let line = '';
    const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
      windowsHide: true, timeout: POWERSHELL_START_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: {...environment,
        ETS2TELEMETRY_OBSERVED_PID: String(identity.pid), ETS2TELEMETRY_OBSERVED_CREATED: String(identity.createdMs), ETS2TELEMETRY_OBSERVED_EXE: identity.executable}});
    child.stdout.on('data', chunk => {
      line += String(chunk); let end;
      while ((end = line.indexOf('\n')) >= 0) {
        const event = JSON.parse(line.slice(0, end)) as {event: string}; line = line.slice(end + 1); events.push(event);
        if (event.event === 'opened') onOpened();
      }
    });
    child.on('error', reject); child.on('close', code => resolve({code, events}));
  });
}

describe.runIf(process.platform === 'win32')('the real exit observer script', () => {
  it('opens the exact live process, then reports its own exit code', async () => {
    const {child, pid, createdMs} = observedChild();
    const result = await observe({pid, createdMs, executable: process.execPath}, () => child.stdin!.end('exit\n'));
    expect(result).toEqual({code: 0, events: [{event: 'opened'}, {event: 'terminated', code: 7}]});
    if (child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
    expect(child.exitCode).toBe(7);
  }, CASE_BUDGET_MS);

  it('refuses a creation-time mismatch and leaves the process running', async () => {
    const {child, pid, createdMs} = observedChild();
    const result = await observe({pid, createdMs: createdMs + 1, executable: process.execPath});
    expect(result).toEqual({code: 0, events: [{event: 'unknown', code: 'IDENTITY_MISMATCH'}]});
    expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  }, CASE_BUDGET_MS);
});
