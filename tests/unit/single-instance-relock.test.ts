import {spawn, type ChildProcess} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, expect, it} from 'vitest';
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
const started: ChildProcess[] = [];
let lockDir: string | undefined;
afterEach(async () => {
  for (const child of started.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill();
  if (lockDir) await rm(lockDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
  lockDir = undefined;
});

interface Run {lines: string[]; exited: Promise<number | null>; line(prefix: string): Promise<string>}
function launch(script: string, env: Record<string, string>): Run {
  const environment: NodeJS.ProcessEnv = {...process.env, ...env};
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [path.join(fixtures, script)], {env: environment, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
  started.push(child);
  const lines: string[] = [];
  const waiters: {prefix: string; resolve: (line: string) => void}[] = [];
  let buffered = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8');
    let index: number;
    while ((index = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, index).trim(); buffered = buffered.slice(index + 1);
      lines.push(line);
      for (const waiter of waiters.splice(0)) if (line.startsWith(waiter.prefix)) waiter.resolve(line); else waiters.push(waiter);
    }
  });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return {lines, exited, line: prefix => {
    const seen = lines.find(line => line.startsWith(prefix));
    return seen ? Promise.resolve(seen) : new Promise(resolve => waiters.push({prefix, resolve}));
  }};
}
const signals = (holder: Run) => holder.lines.filter(line => line.startsWith('HOLDER_SIGNAL ')).map(line => JSON.parse(line.slice('HOLDER_SIGNAL '.length)) as {plain: boolean; data: unknown});
const outcome = async (requester: Run) => JSON.parse((await requester.line('REQUESTER ')).slice('REQUESTER '.length)) as {locked: boolean; requests: number; elapsedMs: number};

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
