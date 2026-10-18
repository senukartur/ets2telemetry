import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';
import {runUninstall, type UninstallPorts, type UninstallResult} from '../../apps/desktop/src/uninstall/engine';
import {armExecutor, disarmExecutor, EXECUTOR_FILE, executorCommand, MAX_RUN_ONCE_COMMAND, parseRegQuery, PRODUCTION_RUN_ONCE_KEY, regExeRunOnce, RUN_ONCE_VALUE,
  runOnceKeyFor, validExecutorBytes, type ExecutorState} from '../../apps/desktop/src/uninstall/executor';
import {resolveUninstallRoots, type UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';
import {CURRENT, exists, fakeRunOnce, gameFolder, installFixture, installRecord, KNOWN, notRunning, seedData, TEST_RUN_ONCE, useRunOnceKey, writeRegistry,
  type InstallFixture} from '../shared/uninstall-fixture';

// REG-017 (ET-018 PR-5, U7): the deferred-cleanup executor's copy and RunOnce registration. The engine registers it after
// the intent and before the first deletion and removes the registration only after a complete run. Every test uses the
// in-memory registry, except one round trip through the real reg.exe under this run's own
// HKCU\Software\ETS2Telemetry-Test-<uuid>\RunOnce key, which it deletes afterwards; the real RunOnce key is never written.

const SCRIPT = readFileSync(path.join(import.meta.dirname, '..', '..', 'resources', 'uninstall', EXECUTOR_FILE));
const WINDOWS = 'C:\\Windows';
let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot('ets2telemetry-uninstall-executor-');});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});
const scriptCopy = (fixture: InstallFixture) => path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE);
async function testRoots(fixture: InstallFixture, key: string | null = TEST_RUN_ONCE): Promise<UninstallRoots> {
  await useRunOnceKey(fixture, key);
  return resolveUninstallRoots({executable: fixture.executable, env: {}, fs: fixture.fs});
}

describe('the packaged executor', () => {
  it('is plain ASCII within the bound, so Windows PowerShell 5.1 reads it without a byte order mark', () => {
    expect(validExecutorBytes(SCRIPT)).toBe(true);
    expect(validExecutorBytes(Buffer.from('caf\u00e9'))).toBe(false);
    expect(validExecutorBytes(Buffer.alloc(0))).toBe(false);
  });
});

describe('the RunOnce key and command', () => {
  it('uses the production key for a production install, the test file\'s key for a test install and none without one', async () => {
    const fixture = await installFixture(guard);
    expect(runOnceKeyFor(await testRoots(fixture))).toBe(TEST_RUN_ONCE);
    expect(runOnceKeyFor(await testRoots(fixture, null))).toBeNull();
    const production = await installFixture(guard, {name: 'production', testRoot: false});
    expect(runOnceKeyFor(await resolveUninstallRoots({executable: production.executable, env: {LOCALAPPDATA: production.base}, fs: production.fs})))
      .toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce');
    expect(runOnceKeyFor({ok: false, code: 'NOT_INSTALLED'})).toBeNull();
  });

  it('runs the absolute Windows PowerShell hidden, without a profile or prompts, on the copied script', () => {
    expect(executorCommand('C:\\Users\\Driver\\AppData\\Local\\ETS2Telemetry', WINDOWS)).toBe('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" '
      + '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\\Users\\Driver\\AppData\\Local\\ETS2Telemetry\\uninstall\\Complete-ETS2TelemetryUninstall.ps1"');
  });

  it('keeps the budget: the absolute form up to 260 characters, then the PATH form, then nothing', () => {
    // The absolute form is 139 characters plus the script path; the PATH form 94 plus it.
    const dataRootFor = (scriptLength: number) => `C:\\${'d'.repeat(scriptLength - 3 - '\\uninstall\\Complete-ETS2TelemetryUninstall.ps1'.length)}`;
    const script = (dataRoot: string) => path.win32.join(dataRoot, 'uninstall', EXECUTOR_FILE);
    const typical = 'C:\\Users\\a-user-name-of-38-characters-xxxxxxxxx\\AppData\\Local\\ETS2Telemetry';
    expect(script(typical).length).toBe(83 + 38);
    expect(executorCommand(typical, WINDOWS)).toMatch(/^"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" /);
    expect(executorCommand(typical, WINDOWS)).toHaveLength(260);
    expect(executorCommand(dataRootFor(122), WINDOWS)).toMatch(/^powershell\.exe /);
    expect(executorCommand(dataRootFor(122), WINDOWS)).toHaveLength(94 + 122);
    expect(executorCommand(dataRootFor(166), WINDOWS)).toHaveLength(260);
    expect(executorCommand(dataRootFor(167), WINDOWS)).toBeUndefined();
  });

  it('parses the data of one REG_SZ value from reg.exe query', () => {
    const output = `\r\nHKEY_CURRENT_USER\\Software\\X\\RunOnce\r\n    ${RUN_ONCE_VALUE}    REG_SZ    powershell.exe -File "C:\\a b\\c.ps1"\r\n\r\n`;
    expect(parseRegQuery(output, RUN_ONCE_VALUE)).toBe('powershell.exe -File "C:\\a b\\c.ps1"');
    expect(parseRegQuery(output, 'Other')).toBeUndefined();
  });
});

describe('armExecutor and disarmExecutor', () => {
  it('copies the executor byte-identically, then registers the exact command under the test key', async () => {
    const fixture = await installFixture(guard), registry = fakeRunOnce({onSet: () => order.push(readFileSync(scriptCopy(fixture)).equals(SCRIPT) ? 'set-after-copy' : 'set')});
    const order: string[] = [];
    const roots = await testRoots(fixture);
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(SCRIPT), timeoutMs: () => 2000})).toBe('registered');
    expect(order).toEqual(['set-after-copy']);
    expect(registry.values.get(`${TEST_RUN_ONCE}\\${RUN_ONCE_VALUE}`)).toBe(executorCommand(fixture.dataRoot, WINDOWS));
    expect(await disarmExecutor(roots, registry, 2000)).toBe('removed');
    expect(registry.values.size).toBe(0);
    expect(await disarmExecutor(roots, registry, 2000)).toBe('removed');
  });

  it('registers nothing when the script cannot be read or is not plain ASCII, and nothing names a missing script', async () => {
    const fixture = await installFixture(guard), registry = fakeRunOnce();
    const roots = await testRoots(fixture);
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(undefined), timeoutMs: () => 2000})).toBe('failed');
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.reject(new Error('gone')), timeoutMs: () => 2000})).toBe('failed');
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(Buffer.from('\u00ff\u00fe')), timeoutMs: () => 2000})).toBe('failed');
    expect(registry.calls).toEqual([]);
    expect(await exists(scriptCopy(fixture))).toBe(false);
  });

  it('never registers a command longer than Windows runs', async () => {
    const fixture = await installFixture(guard, {name: `r${'x'.repeat(MAX_RUN_ONCE_COMMAND - 100)}`}), registry = fakeRunOnce();
    const roots = await testRoots(fixture);
    expect(executorCommand(fixture.dataRoot, WINDOWS)).toBeUndefined();
    expect(path.win32.join(fixture.dataRoot, 'uninstall', EXECUTOR_FILE).length + 94).toBeGreaterThan(MAX_RUN_ONCE_COMMAND);
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(SCRIPT), timeoutMs: () => 2000})).toBe('failed');
    expect(registry.calls).toEqual([]);
  });

  it('reports a failed registration and a failed removal', async () => {
    const fixture = await installFixture(guard), registry = fakeRunOnce({fail: true});
    const roots = await testRoots(fixture);
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(SCRIPT), timeoutMs: () => 2000})).toBe('failed');
    expect(await disarmExecutor(roots, registry, 2000)).toBe('failed');
  });

  it('a test install without a RunOnce key copies nothing and writes no key at all', async () => {
    const fixture = await installFixture(guard), registry = fakeRunOnce();
    const roots = await testRoots(fixture, null);
    expect(await armExecutor({roots, fs: fixture.fs, registry, windowsDirectory: WINDOWS, readExecutor: () => Promise.resolve(SCRIPT), timeoutMs: () => 2000})).toBe('not-applicable');
    expect(await disarmExecutor(roots, registry, 2000)).toBe('not-applicable');
    expect(registry.calls).toEqual([]);
    expect(await exists(scriptCopy(fixture))).toBe(false);
  });
});

describe('the engine registers first and unregisters last', () => {
  async function scene() {
    const fixture = await installFixture(guard);
    const game = await gameFolder(fixture, 'ETS2', {content: CURRENT});
    await writeRegistry(fixture, [installRecord(game)]);
    await seedData(fixture);
    return {fixture, game, roots: await testRoots(fixture)};
  }
  /** The engine on a file system that records each deletion, with executor ports that record when they ran. */
  async function run(current: Awaited<ReturnType<typeof scene>>, overrides: Partial<UninstallPorts> = {}) {
    const order: string[] = [];
    const fs = new Proxy(current.fixture.fs, {get: (target, name, receiver) => {
      const value: unknown = Reflect.get(target, name, receiver);
      if ((name === 'unlink' || name === 'rmdir') && typeof value === 'function') {
        return (...args: unknown[]) => {
          const file = String(args[0]);
          // The intent's and the registry's own temporary files are writes, not deletions of data.
          if (!/\.tmp$/.test(file)) order.push('delete');
          return (value as (...parameters: unknown[]) => unknown).apply(target, args);
        };
      }
      return value;
    }});
    const arm = vi.fn(async (): Promise<ExecutorState> => {order.push(await exists(path.win32.join(current.fixture.dataRoot, 'uninstall', 'pending.json')) ? 'arm-after-intent' : 'arm'); return 'registered';});
    const disarm = vi.fn(async (): Promise<ExecutorState> => {order.push(await exists(current.fixture.dataRoot) ? 'disarm' : 'disarm-after-root'); return 'removed';});
    let clock = 0;
    const result: UninstallResult = await runUninstall({roots: current.roots, fs, checkRunning: notRunning, known: KNOWN, clock: () => clock++, deadline: Number.MAX_SAFE_INTEGER,
      delay: () => Promise.resolve(), now: () => new Date('2026-10-18T09:00:00.000Z'), armExecutor: arm, disarmExecutor: disarm, ...overrides});
    return {result, order, arm, disarm};
  }

  it('a complete run arms after the intent and before the first deletion, and disarms after the data root is gone', async () => {
    const {result, order} = await run(await scene());
    expect(result).toMatchObject({outcome: 'complete', executor: 'removed'});
    expect(order[0]).toBe('arm-after-intent');
    expect(order.indexOf('delete')).toBeGreaterThan(0);
    expect(order.at(-1)).toBe('disarm-after-root');
    expect(order.filter(step => step.startsWith('arm') || step.startsWith('disarm'))).toEqual(['arm-after-intent', 'disarm-after-root']);
  });

  it('a deferred run keeps the registration', async () => {
    const {result, order, disarm} = await run(await scene(), {checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(result).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', executor: 'registered'});
    expect(order[0]).toBe('arm-after-intent');
    expect(disarm).not.toHaveBeenCalled();
  });

  it('a running instance defers everything, still registered', async () => {
    const {result, order} = await run(await scene(), {deferAll: 'INSTANCE_RUNNING'});
    expect(result).toMatchObject({outcome: 'deferred', code: 'INSTANCE_RUNNING', executor: 'registered'});
    expect(order).toEqual(['arm-after-intent']);
  });

  it('the in-app scopes never register: the preflight writes nothing and the plugin scope rolls back instead', async () => {
    for (const scope of ['preflight', 'plugins'] as const) {
      const {result, arm, disarm} = await run(await scene(), {scope});
      expect(result.executor).toBe('not-run');
      expect(arm).not.toHaveBeenCalled();
      expect(disarm).not.toHaveBeenCalled();
      await guard.dispose();
      guard = await guardedTempRoot('ets2telemetry-uninstall-executor-');
    }
  });

  it('nothing left to clean only removes a stray registration', async () => {
    const current = await scene();
    await fsp.rm(current.fixture.dataRoot, {recursive: true});
    await fsp.rm(current.game.dll);
    const {result, order} = await run(current);
    expect(result).toMatchObject({outcome: 'complete', executor: 'removed'});
    expect(order).toEqual(['disarm-after-root']);
  });

  it('a failed registration does not stop the run', async () => {
    const {result} = await run(await scene(), {armExecutor: () => Promise.reject(new Error('reg.exe failed')),
      checkRunning: () => Promise.resolve({ok: true, running: {ets2: true, ats: false, client: false}})});
    expect(result).toMatchObject({outcome: 'deferred', code: 'GAME_RUNNING', executor: 'failed'});
  });
});

describe('the reg.exe port', () => {
  it('refuses any key but the production and the test key, and any other value, without starting reg.exe', async () => {
    const execFile = vi.fn<ExecFilePort>();
    const registry = regExeRunOnce({SystemRoot: 'C:\\Windows'}, execFile);
    expect(await registry.set('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', RUN_ONCE_VALUE, 'x', 1000)).toBe(false);
    expect(await registry.set('HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce', RUN_ONCE_VALUE, 'x', 1000)).toBe(false);
    expect(await registry.set(TEST_RUN_ONCE, 'Other', 'x', 1000)).toBe(false);
    expect(await registry.set(TEST_RUN_ONCE, RUN_ONCE_VALUE, 'x\r\ny', 1000)).toBe(false);
    expect(await registry.remove('HKCU\\Software\\ETS2Telemetry-Test-x\\RunOnce', RUN_ONCE_VALUE, 1000)).toBe('failed');
    expect(execFile).not.toHaveBeenCalled();
  });

  it('passes the production key and the command as fixed arguments', async () => {
    const calls: {file: string; args: readonly string[]}[] = [];
    const execFile: ExecFilePort = (file, args, _options, callback) => {calls.push({file, args}); callback(null, Buffer.alloc(0), Buffer.alloc(0)); return undefined;};
    expect(await regExeRunOnce({SystemRoot: 'C:\\Windows'}, execFile).set(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 'powershell.exe -File "C:\\a b\\c.ps1"', 1000)).toBe(true);
    expect(calls).toEqual([{file: 'C:\\Windows\\System32\\reg.exe', args: ['add', PRODUCTION_RUN_ONCE_KEY, '/v', RUN_ONCE_VALUE, '/t', 'REG_SZ', '/d',
      'powershell.exe -File "C:\\a b\\c.ps1"', '/f']}]);
  });

  describe('an absent value is told from a failure without reading reg.exe\'s localized error text', () => {
    const PARENT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion';
    const full = (key: string) => key.replace(/^HKCU\\/, 'HKEY_CURRENT_USER\\');
    const valueLine = `    ${RUN_ONCE_VALUE}    REG_SZ    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -File "C:\\a b\\c.ps1"`;
    /** A fake reg.exe: each call is answered by `answer`; exit 0 with stdout, or exit 1 with nothing (as any failure). */
    function fakeReg(answer: (args: readonly string[]) => string | null, calls: {args: readonly string[]; timeout: number}[] = [], cost = 0) {
      let clock = 0;
      const execFile: ExecFilePort = (_file, args, options, callback) => {
        calls.push({args, timeout: options.timeout});
        clock += cost;
        const stdout = answer(args);
        if (stdout === null) callback(Object.assign(new Error('Command failed'), {code: 1, killed: false}), Buffer.alloc(0), Buffer.alloc(0));
        else callback(null, Buffer.from(stdout), Buffer.alloc(0));
        return undefined;
      };
      return regExeRunOnce({SystemRoot: 'C:\\Windows'}, execFile, () => clock);
    }

    it('a denied delete of a value that is still listed is failed, not absent', async () => {
      const registry = fakeReg(args => args[0] === 'query' && args[1] === PRODUCTION_RUN_ONCE_KEY ? `\r\n${full(PRODUCTION_RUN_ONCE_KEY)}\r\n${valueLine}\r\n` : null);
      expect(await registry.remove(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBe('failed');
    });

    it('a key that exists but cannot be listed is failed, not absent (review of PR-5)', async () => {
      // The key query fails as a denied read does; its parent lists it, so it exists.
      const registry = fakeReg(args => args[0] === 'query' && args[1] === PARENT ? `\r\n${full(PARENT)}\r\n${full(PRODUCTION_RUN_ONCE_KEY)}\r\n` : null);
      expect(await registry.remove(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBe('failed');
      expect(await registry.read(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBeUndefined();
    });

    it('a listed key without the value, and a key its parent does not list, are absent', async () => {
      const withoutValue = fakeReg(args => args[0] === 'query' && args[1] === PRODUCTION_RUN_ONCE_KEY ? `\r\n${full(PRODUCTION_RUN_ONCE_KEY)}\r\n    Other    REG_SZ    x\r\n` : null);
      expect(await withoutValue.remove(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBe('absent');
      const noKey = fakeReg(args => args[0] === 'query' && args[1] === PARENT ? `\r\n${full(PARENT)}\r\n${full(PARENT)}\\Run\r\n` : null);
      expect(await noKey.remove(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBe('absent');
      expect(await noKey.read(PRODUCTION_RUN_ONCE_KEY, RUN_ONCE_VALUE, 2000)).toBeNull();
    });

    it('walks up to HKCU\\Software for a test key whose parent is missing too, and never past it', async () => {
      const calls: {args: readonly string[]; timeout: number}[] = [];
      const registry = fakeReg(args => args[0] === 'query' && args[1] === 'HKCU\\Software' ? '\r\nHKEY_CURRENT_USER\\Software\r\nHKEY_CURRENT_USER\\Software\\Other\r\n' : null, calls);
      expect(await registry.remove(TEST_RUN_ONCE, RUN_ONCE_VALUE, 2000)).toBe('absent');
      expect(calls.map(call => call.args.slice(0, 2).join(' '))).toEqual([`delete ${TEST_RUN_ONCE}`, `query ${TEST_RUN_ONCE}`, `query ${path.win32.dirname(TEST_RUN_ONCE)}`,
        'query HKCU\\Software']);
      const unreadable = fakeReg(() => null, calls.splice(0));
      expect(await unreadable.remove(TEST_RUN_ONCE, RUN_ONCE_VALUE, 2000)).toBe('failed');
      expect(calls.map(call => call.args[1])).not.toContain('HKCU');
    });

    it('the delete and its fallback queries share one timeout', async () => {
      const calls: {args: readonly string[]; timeout: number}[] = [];
      const registry = fakeReg(args => args[0] === 'query' && args[1] === 'HKCU\\Software' ? '\r\nHKEY_CURRENT_USER\\Software\r\n' : null, calls, 600);
      expect(await registry.remove(TEST_RUN_ONCE, RUN_ONCE_VALUE, 2000)).toBe('absent');
      // Each call costs 600 ms on the fake clock: the four calls get 2000, 1400, 800 and 200 ms.
      expect(calls.map(call => call.timeout)).toEqual([2000, 1400, 800, 200]);
    });
  });

  describe('a round trip through the real reg.exe under this run\'s own test key', () => {
    const keyRoot = `HKCU\\Software\\ETS2Telemetry-Test-${randomUUID().replaceAll('-', '')}`;
    const key = `${keyRoot}\\RunOnce`;
    afterEach(() => {
      try {execFileSync(path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), ['delete', keyRoot, '/f'], {windowsHide: true, stdio: 'ignore'});}
      catch {/* already gone */}
    });

    it('sets, reads and removes the value with quotes and spaces intact', async () => {
      const registry = regExeRunOnce(process.env);
      const command = executorCommand('C:\\Users\\Driver Name\\AppData\\Local\\ETS2Telemetry', WINDOWS)!;
      // Neither the key nor its parent exists yet: HKCU\Software's listing shows that the value is absent.
      expect(await registry.read(key, RUN_ONCE_VALUE, 5000)).toBeNull();
      expect(await registry.remove(key, RUN_ONCE_VALUE, 5000)).toBe('absent');
      expect(await registry.set(key, RUN_ONCE_VALUE, command, 5000)).toBe(true);
      expect(await registry.read(key, RUN_ONCE_VALUE, 5000)).toBe(command);
      expect(await registry.remove(key, RUN_ONCE_VALUE, 5000)).toBe('removed');
      expect(await registry.remove(key, RUN_ONCE_VALUE, 5000)).toBe('absent');
      expect(await registry.read(key, RUN_ONCE_VALUE, 5000)).toBeNull();
    });
  });
});
