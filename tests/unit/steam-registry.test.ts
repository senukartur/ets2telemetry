import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir, symlink, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {nodeExecFile, type ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';
import {parseSteamRegistryOutput, readSteamRegistryValues, readSteamRoot, STEAM_MACHINE_KEY, STEAM_USER_KEY,
  steamRegistryScript} from '../../apps/desktop/src/plugin-setup/steam-registry';
import {guardedTempRoot, type GuardedRoot} from '../shared/guarded-fs';

// REG-015 (ET-017 P1): the fixed PowerShell reader of the Steam root. Stubbed runs cover the bounds and the output
// contract. The single real run points the fixed script at a per-run HKCU test key and never at Valve's keys; the key
// is deleted after the test.

let guard: GuardedRoot;
beforeEach(async () => {guard = await guardedTempRoot();});
afterEach(async () => {
  const violations = [...guard.violations];
  await guard.dispose();
  expect(violations).toEqual([]);
});

const env = {SystemRoot: 'C:\\Windows'};
const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
type Call = {file: string; args: readonly string[]; options: Parameters<ExecFilePort>[2]};
/** A stub execFile that records its call and answers with `reply`; it never starts a process. */
function stub(reply: (call: Call) => {error?: Record<string, unknown>; stdout?: string | Buffer}) {
  const calls: Call[] = [];
  const execFile: ExecFilePort = (file, args, options, callback) => {
    const call = {file, args, options};
    calls.push(call);
    const answer = reply(call);
    const stdout = Buffer.isBuffer(answer.stdout) ? answer.stdout : Buffer.from(answer.stdout ?? '', 'utf8');
    queueMicrotask(() => callback(answer.error ? Object.assign(new Error('child failed'), answer.error) : null, stdout, Buffer.alloc(0)));
  };
  return {execFile, calls};
}
const output = (steamPath: string | null, installPath: string | null) => JSON.stringify({steamPath: steamPath === null ? null : b64(steamPath), installPath: installPath === null ? null : b64(installPath)});

describe('the fixed call', () => {
  it('runs absolute Windows PowerShell with fixed flags, a hidden window, no shell, 5 s and 16 KiB, and reads only the two Valve values', async () => {
    const {execFile, calls} = stub(() => ({stdout: output(null, null)}));
    expect(await readSteamRegistryValues({execFile, env})).toEqual({ok: true, steamPath: null, installPath: null});
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(call.args.slice(0, 4)).toEqual(['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
    expect(call.args).toHaveLength(5);
    expect(call.options).toEqual({encoding: 'buffer', timeout: 5000, maxBuffer: 16 * 1024, windowsHide: true, shell: false,
      env: {SystemRoot: 'C:\\Windows', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'}});
    const script = call.args[4];
    expect(script).toBe(steamRegistryScript());
    expect(script).toContain(`'${STEAM_USER_KEY}' 'SteamPath'`);
    expect(script).toContain(`'${STEAM_MACHINE_KEY}' 'InstallPath'`);
    expect(script.match(/HKEY_[A-Z_]+\\[^']*/g)).toEqual(['HKEY_CURRENT_USER\\Software\\Valve\\Steam', 'HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Valve\\Steam']);
  });

  it('passes the parent environment with only Windows PowerShell\'s own module folder in PSModulePath, in any case', async () => {
    const {execFile, calls} = stub(() => ({stdout: output(null, null)}));
    await readSteamRegistryValues({execFile, env: {SystemRoot: 'D:\\Win', PSModulePath: 'C:\\Program Files\\PowerShell\\7\\Modules', psmodulepath: 'E:\\Other', KEEP: 'kept'}});
    expect(calls[0].options.env).toEqual({SystemRoot: 'D:\\Win', KEEP: 'kept', PSModulePath: 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules'});
  });

  it('uses only a plain SystemRoot to build the program path', async () => {
    for (const [value, expected] of [['D:\\Win', 'D:\\Win'], ['\\\\server\\share', 'C:\\Windows'], ['relative', 'C:\\Windows'], ['C:\\Windows"; calc', 'C:\\Windows']]) {
      const {execFile, calls} = stub(() => ({stdout: output(null, null)}));
      await readSteamRegistryValues({execFile, env: {SystemRoot: value}});
      expect(calls[0].file).toBe(`${expected}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`);
    }
  });

  it('accepts only per-run HKCU test keys in place of the Valve keys', () => {
    const user = `HKEY_CURRENT_USER\\Software\\ETS2Telemetry-Test-${randomUUID()}`;
    expect(steamRegistryScript({user, machine: `${user}\\Machine`})).not.toContain('Valve');
    for (const keys of [
      {user: STEAM_USER_KEY, machine: STEAM_MACHINE_KEY},
      {user, machine: STEAM_MACHINE_KEY},
      {user: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\ETS2Telemetry-Test-00000000-0000-0000-0000-000000000000', machine: user},
      {user: `${user}'; Remove-Item C:\\ -Recurse; '`, machine: user},
      {user: `${user}\\..\\Valve`, machine: user}
    ]) expect(() => steamRegistryScript(keys)).toThrow('Steam registry test keys rejected');
  });
});

describe('bounds and output contract', () => {
  it('reports a timeout, oversized output, a failed run and an aborted run as failures', async () => {
    const cases: [ReturnType<typeof stub>, string][] = [
      [stub(() => ({error: {killed: true, signal: 'SIGTERM'}})), 'STEAM_REGISTRY_TIMEOUT'],
      [stub(() => ({error: {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}})), 'STEAM_REGISTRY_OUTPUT_TOO_LARGE'],
      [stub(() => ({stdout: Buffer.alloc(16 * 1024 + 1, 0x20)})), 'STEAM_REGISTRY_OUTPUT_TOO_LARGE'],
      [stub(() => ({error: {code: 1}})), 'STEAM_REGISTRY_FAILED']
    ];
    for (const [{execFile}, code] of cases) {
      expect(await readSteamRegistryValues({execFile, env})).toEqual({ok: false, code});
      expect(await readSteamRoot({execFile, env, fs: guard.fs})).toEqual({kind: 'failed', code});
    }
    const abort = new AbortController();
    abort.abort();
    const {execFile, calls} = stub(() => ({stdout: output(null, null)}));
    expect(await readSteamRegistryValues({execFile, env, signal: abort.signal})).toEqual({ok: false, code: 'STEAM_REGISTRY_ABORTED'});
    expect(calls).toEqual([]);
  });

  it.each([
    ['invalid base64 characters', JSON.stringify({steamPath: '@@@=', installPath: null})],
    ['unpadded base64', JSON.stringify({steamPath: 'QQ', installPath: null})],
    ['non-canonical base64', JSON.stringify({steamPath: 'QR==', installPath: null})],
    ['base64 of bytes that are not UTF-8', JSON.stringify({steamPath: Buffer.from([0xc8, 0xe3]).toString('base64'), installPath: null})],
    ['a plain path instead of base64', JSON.stringify({steamPath: 'C:\\Steam', installPath: null})],
    ['a number', JSON.stringify({steamPath: 5, installPath: null})],
    ['an extra key', JSON.stringify({steamPath: null, installPath: null, other: null})],
    ['a missing key', JSON.stringify({steamPath: null})],
    ['an array', '[]'],
    ['text that is not JSON', 'SteamPath REG_SZ C:\\Steam'],
    ['a value over 4096 bytes', JSON.stringify({steamPath: b64('C:\\' + 'a'.repeat(4094)), installPath: null})]
  ])('rejects %s', (_name, text) => {
    expect(parseSteamRegistryOutput(Buffer.from(text))).toEqual({ok: false, code: 'STEAM_REGISTRY_OUTPUT_INVALID'});
  });

  it('decodes non-ASCII values exactly', () => {
    expect(parseSteamRegistryOutput(Buffer.from(` ${output('D:/Игры/Steam', null)}\r\n`))).toEqual({ok: true, steamPath: 'D:/Игры/Steam', installPath: null});
  });
});

describe('canonical Steam root', () => {
  it('canonicalizes SteamPath with forward slashes and another case through realpath', async () => {
    const steam = path.win32.join(guard.root, 'Program Files (x86)', 'Steam');
    await mkdir(steam, {recursive: true});
    const spelled = steam.toLowerCase().replaceAll('\\', '/');
    const {execFile} = stub(() => ({stdout: output(spelled, null)}));
    expect(await readSteamRoot({execFile, env, fs: guard.fs})).toEqual({kind: 'found', path: steam});
  });

  it('resolves a junction-moved Steam folder to its target', async () => {
    const real = path.win32.join(guard.root, 'Moved', 'Steam');
    await mkdir(real, {recursive: true});
    const alias = path.win32.join(guard.root, 'SteamAlias');
    await symlink(real, alias, 'junction');
    const {execFile} = stub(() => ({stdout: output(alias, null)}));
    expect(await readSteamRoot({execFile, env, fs: guard.fs})).toEqual({kind: 'found', path: real});
  });

  it('falls back to InstallPath when SteamPath is absent, missing on disk or not a local drive path', async () => {
    const install = path.win32.join(guard.root, 'MachineSteam');
    await mkdir(install);
    for (const steamPath of [null, path.win32.join(guard.root, 'Gone'), '\\\\server\\share\\Steam', 'relative\\Steam', '\\\\?\\C:\\Steam']) {
      const {execFile} = stub(() => ({stdout: output(steamPath, install)}));
      expect([steamPath, await readSteamRoot({execFile, env, fs: guard.fs})]).toEqual([steamPath, {kind: 'found', path: install}]);
    }
  });

  it('reports not-found when neither value names an existing folder', async () => {
    const file = path.win32.join(guard.root, 'steam.txt');
    await writeFile(file, 'not a folder');
    for (const values of [[null, null], [path.win32.join(guard.root, 'Gone'), file]] as const) {
      const {execFile} = stub(() => ({stdout: output(values[0], values[1])}));
      expect(await readSteamRoot({execFile, env, fs: guard.fs})).toEqual({kind: 'not-found'});
    }
  });
});

/**
 * Bounds each Windows PowerShell process start in the real-run cases and their cleanup: a hang guard for a loaded
 * runner, not a timing assertion. The product's own 5 s deadline still applies inside each case.
 */
const POWERSHELL_START_TIMEOUT_MS = 30_000;

describe.runIf(process.platform === 'win32')('a real run of the fixed script against a temporary HKCU key', () => {
  const id = randomUUID();
  const userKey = `HKEY_CURRENT_USER\\Software\\ETS2Telemetry-Test-${id}`;
  const providerKey = `HKCU:\\Software\\ETS2Telemetry-Test-${id}`;
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershell = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Setup and cleanup use cmdlets, so they get Windows PowerShell's own module folder whatever the parent exported.
  const cleanEnvironment = {...Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath')),
    PSModulePath: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')};
  const run = (script: string, environment: NodeJS.ProcessEnv = cleanEnvironment) => execFileSync(powershell,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {windowsHide: true, timeout: POWERSHELL_START_TIMEOUT_MS, env: environment, stdio: 'pipe'});
  let steam: string, stored: string;
  beforeEach(async () => {
    steam = path.win32.join(guard.root, 'Игры', 'Стим');
    await mkdir(steam, {recursive: true});
    // Stored as Steam writes it: lowercase with forward slashes. Passed in base64 so no code page touches it.
    stored = steam.toLowerCase().replaceAll('\\', '/');
    run(`$value = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64(stored)}')); New-Item -Path '${providerKey}' -Force | Out-Null; `
      + `New-ItemProperty -LiteralPath '${providerKey}' -Name SteamPath -Value $value -PropertyType String | Out-Null`);
  }, POWERSHELL_START_TIMEOUT_MS);
  afterEach(() => {
    run(`Remove-Item -LiteralPath '${providerKey}' -Recurse -Force -ErrorAction SilentlyContinue`);
    expect(run(`Test-Path -LiteralPath '${providerKey}'`).toString().trim()).toBe('False');
  }, POWERSHELL_START_TIMEOUT_MS);
  const testKeys = () => ({user: userKey, machine: `${userKey}\\Machine`});
  /**
   * A module folder like the one a pwsh 7 parent exports: a Core-edition Microsoft.PowerShell.Utility that Windows
   * PowerShell 5.1 finds first and cannot load.
   */
  async function pollutedModulePath(): Promise<string> {
    const folder = path.win32.join(guard.root, 'PollutedModules');
    const module = path.win32.join(folder, 'Microsoft.PowerShell.Utility');
    await mkdir(module, {recursive: true});
    await writeFile(path.win32.join(module, 'Microsoft.PowerShell.Utility.psd1'), "@{ ModuleVersion = '7.0.0.0'; CompatiblePSEditions = @('Core'); "
      + "RootModule = 'Microsoft.PowerShell.Utility.psm1'; FunctionsToExport = @('ConvertTo-Json'); CmdletsToExport = @(); PowerShellVersion = '3.0' }\n");
    await writeFile(path.win32.join(module, 'Microsoft.PowerShell.Utility.psm1'), "throw 'polluted module loaded'\n");
    return `${folder};${process.env.PSModulePath ?? ''}`;
  }

  it('reads a Cyrillic SteamPath and canonicalizes it; the missing machine value stays null', async () => {
    const scripts: string[] = [];
    const recorded: ExecFilePort = (file, args, options, callback) => {scripts.push(args[4]); return nodeExecFile(file, args, options, callback);};
    expect(await readSteamRegistryValues({execFile: recorded, testKeys: testKeys()})).toEqual({ok: true, steamPath: stored, installPath: null});
    expect(await readSteamRoot({execFile: recorded, testKeys: testKeys(), fs: guard.fs})).toEqual({kind: 'found', path: steam});
    expect(scripts).toHaveLength(2);
    for (const script of scripts) expect(script).not.toContain('Valve');
  }, POWERSHELL_START_TIMEOUT_MS);

  it('still succeeds when the parent exports an incompatible PSModulePath', async () => {
    const polluted = await pollutedModulePath();
    // The pollution is real: a cmdlet from that module fails under it.
    let probe = 'succeeded';
    try {run("$ErrorActionPreference = 'Stop'; ConvertTo-Json -InputObject 1", {...cleanEnvironment, PSModulePath: polluted});} catch (error) {
      probe = String((error as {stderr?: Buffer}).stderr);
    }
    expect(probe).toContain('CouldNotAutoloadMatchingModule');
    const children: (string | undefined)[] = [];
    const recorded: ExecFilePort = (file, args, options, callback) => {children.push(options.env?.PSModulePath); return nodeExecFile(file, args, options, callback);};
    // The test process itself carries the polluted value, as under a pwsh 7 parent; the reader uses process.env.
    vi.stubEnv('PSModulePath', polluted);
    try {
      expect(await readSteamRegistryValues({execFile: recorded, testKeys: testKeys()})).toEqual({ok: true, steamPath: stored, installPath: null});
    } finally {vi.unstubAllEnvs();}
    expect(children).toEqual([path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')]);
  }, POWERSHELL_START_TIMEOUT_MS);

  it('needs no module: the fixed script succeeds even when the child itself gets the incompatible PSModulePath', async () => {
    const polluted = await pollutedModulePath();
    const forced: ExecFilePort = (file, args, options, callback) => nodeExecFile(file, args, {...options, env: {...options.env, PSModulePath: polluted}}, callback);
    expect(await readSteamRegistryValues({execFile: forced, testKeys: testKeys()})).toEqual({ok: true, steamPath: stored, installPath: null});
  }, POWERSHELL_START_TIMEOUT_MS);
});
