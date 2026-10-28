import path from 'node:path';
import {readAtomicFile, writeAtomicFile, type AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {nodeExecFile, runFixedProgram, systemRoot, type ExecFilePort} from '../plugin-setup/fixed-program';
import {PENDING_DIRECTORY} from './pending-record';
import type {UninstallRoots} from './roots';
import {CHANNEL} from '../channel';

// The deferred-cleanup executor of an uninstall (ET-018 U7, owner decision O3; docs/uninstall.md, "Deferred cleanup at
// the next sign-in"). When a Windows-initiated uninstall cannot finish (a game runs, a file is locked), Squirrel still
// deletes the binaries. Before the uninstall deletes anything, it therefore copies the retained Windows PowerShell 5.1
// script `resources\uninstall\Complete-ETS2TelemetryUninstall.ps1` into `<data root>\uninstall\` and registers it under
// HKCU RunOnce, so the next sign-in finishes the cleanup from `uninstall\pending.json`. The registration is the last
// thing removed: only after a complete run, once the data root is gone.
//
// The RunOnce key is fixed: `HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce` for a production install, and for a
// test install only the per-run `HKCU\Software\ETS2Telemetry-Test-<32 hex>\RunOnce` its test file names; a test file
// with `runOnceKey: null` registers nothing and copies nothing. No other key is ever written. The registry is reached
// only through the fixed `reg.exe` with fixed arguments, no shell, a hidden window and a deadline.

export const EXECUTOR_FILE = 'Complete-ETS2TelemetryUninstall.ps1';
/** The packaged executor: `resources\uninstall\<EXECUTOR_FILE>`. */
export const EXECUTOR_RESOURCE_DIRECTORY = 'uninstall';
export const RUN_ONCE_VALUE = CHANNEL.runOnceValue;
export const PRODUCTION_RUN_ONCE_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';
/** The only test key a test install may name (plan U7, U12). */
export const TEST_RUN_ONCE_KEY = /^HKCU\\Software\\ETS2Telemetry-Test-[0-9a-f]{32}\\RunOnce$/;
/** Windows runs a Run or RunOnce command of at most 260 characters; a longer one is never registered. */
export const MAX_RUN_ONCE_COMMAND = 260;
/** The script is ASCII, so Windows PowerShell 5.1 reads it the same without a byte order mark; it stays far below this. */
export const MAX_EXECUTOR_BYTES = 256 * 1024;
/** One reg.exe call gets at most this long, and never more than what is left of the uninstall budget. */
export const REG_TIMEOUT_MS = 2000;
/** The attempts the intent may count before the executor stops and leaves README.txt (O3). */
export const MAX_ATTEMPTS = 10;

/**
 * What the run did with the executor: `registered` (copied and registered, kept for a later sign-in), `removed` (the
 * registration is gone after a complete run), `not-applicable` (a test install without a RunOnce key), `failed` (the
 * copy, the registration or its removal failed; the README stays the fallback), `not-run` (the run never got there).
 */
export type ExecutorState = 'registered' | 'removed' | 'not-applicable' | 'failed' | 'not-run';

/** The two registry operations; the production port runs reg.exe, tests inject a fake or use a test key. */
export interface RunOnceRegistry {
  /** Sets `key\value` to `data` (REG_SZ); true on success. */
  set(key: string, value: string, data: string, timeoutMs: number): Promise<boolean>;
  /** Removes `key\value`: `absent` when it did not exist. */
  remove(key: string, value: string, timeoutMs: number): Promise<'removed' | 'absent' | 'failed'>;
  /** The value's data, null when absent, undefined when it cannot be read. */
  read(key: string, value: string, timeoutMs: number): Promise<string | null | undefined>;
}

/** The RunOnce key of an install: production's, the test file's, or null (a test install without one, or no install). */
export function runOnceKeyFor(roots: UninstallRoots): string | null {
  if (!roots.ok) return null;
  if (roots.mode === 'production') return PRODUCTION_RUN_ONCE_KEY;
  return roots.testFile.runOnceKey !== null && TEST_RUN_ONCE_KEY.test(roots.testFile.runOnceKey) ? roots.testFile.runOnceKey : null;
}
const allowedKey = (key: string) => key === PRODUCTION_RUN_ONCE_KEY || TEST_RUN_ONCE_KEY.test(key);

/** Windows PowerShell 5.1 under the Windows folder (`%SystemRoot%`, expanded when the command is built). */
export const powershellPath = (windows: string) => path.win32.join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const EXECUTOR_ARGUMENTS = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File';

/**
 * The registered command: Windows PowerShell 5.1 runs the copied script, hidden, without a profile and without prompts.
 * The program is the absolute, quoted `<windows>\System32\WindowsPowerShell\v1.0\powershell.exe`, so no folder on PATH
 * can stand in for it. That form takes 139 characters plus the script's path; when it would exceed the 260 characters
 * Windows runs from a RunOnce key, the plain `powershell.exe` form (94 plus the path, resolved through PATH) is used
 * instead, and when even that is too long, nothing is registered (undefined) and README.txt is the fallback. With
 * `C:\Windows` and the usual `C:\Users\<name>\AppData\Local` (a script path of 83 characters plus the name) the
 * absolute form fits for user names of up to 38 characters. The deferred-cleanup script builds the same command
 * (`Get-ExecutorCommand`) from its own location and `%SystemRoot%` when it registers itself again.
 */
export function executorCommand(dataRoot: string, windows: string): string | undefined {
  const script = `"${path.win32.join(dataRoot, PENDING_DIRECTORY, EXECUTOR_FILE)}"`;
  for (const program of [`"${powershellPath(windows)}"`, 'powershell.exe']) {
    const command = `${program} ${EXECUTOR_ARGUMENTS} ${script}`;
    if (command.length <= MAX_RUN_ONCE_COMMAND) return command;
  }
  return undefined;
}

/** True for executor bytes that are plain ASCII text within the bound (a BOM-less script that PowerShell 5.1 reads as is). */
export function validExecutorBytes(bytes: Uint8Array): boolean {
  if (!bytes.byteLength || bytes.byteLength > MAX_EXECUTOR_BYTES) return false;
  return bytes.every(byte => byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte < 0x7f));
}

export interface ExecutorPorts {
  readonly roots: UninstallRoots;
  readonly fs: AtomicFileSystem;
  readonly registry: RunOnceRegistry;
  /** The Windows folder (`systemRoot(env)` in production) for the absolute powershell.exe path. */
  readonly windowsDirectory: string;
  /** The packaged executor's bytes, or undefined when it cannot be read. */
  readExecutor(): Promise<Uint8Array | undefined>;
  /** The milliseconds a registry call may take now (REG_TIMEOUT_MS, cut to the uninstall's remaining budget). */
  readonly timeoutMs: () => number;
}

/**
 * Copies the executor into `<data root>\uninstall\` (atomically, then read back and compared) and registers it. Called
 * after the intent is written and before anything is deleted. A failed copy registers nothing, so the registration never
 * names a missing or partial script; a command that fits 260 characters in neither form is never registered
 * (executorCommand). Either failure leaves README.txt as the fallback.
 */
export async function armExecutor(ports: ExecutorPorts): Promise<ExecutorState> {
  const key = runOnceKeyFor(ports.roots);
  if (!ports.roots.ok || key === null) return 'not-applicable';
  if (!allowedKey(key)) return 'failed';
  const command = executorCommand(ports.roots.dataRoot, ports.windowsDirectory);
  if (command === undefined) return 'failed';
  const bytes = await ports.readExecutor().catch(() => undefined);
  if (!bytes || !validExecutorBytes(bytes)) return 'failed';
  const directory = path.win32.join(ports.roots.dataRoot, PENDING_DIRECTORY);
  const text = Buffer.from(bytes).toString('latin1');
  try {
    await writeAtomicFile(ports.fs, directory, EXECUTOR_FILE, text);
    const copied = await readAtomicFile(ports.fs, directory, EXECUTOR_FILE, MAX_EXECUTOR_BYTES);
    if (copied.state !== 'present' || !Buffer.from(copied.bytes).equals(Buffer.from(bytes))) return 'failed';
  } catch {return 'failed';}
  return await ports.registry.set(key, RUN_ONCE_VALUE, command, Math.max(1, ports.timeoutMs())).catch(() => false) ? 'registered' : 'failed';
}

/** Removes the registration; `removed` also when it was already gone. A test install without a key touches nothing. */
export async function disarmExecutor(roots: UninstallRoots, registry: RunOnceRegistry, timeoutMs: number): Promise<ExecutorState> {
  const key = runOnceKeyFor(roots);
  if (key === null) return 'not-applicable';
  if (!allowedKey(key)) return 'failed';
  const result = await registry.remove(key, RUN_ONCE_VALUE, Math.max(1, timeoutMs)).catch((): 'failed' => 'failed');
  return result === 'failed' ? 'failed' : 'removed';
}

/** Parses the data of one REG_SZ value from `reg.exe query <key> /v <value>`; undefined when the output is not that. */
export function parseRegQuery(output: string, value: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}REG_SZ {4}(.*)$/.exec(line);
    if (match && match[1] === value) return match[2];
  }
  return undefined;
}

/**
 * The production registry port: `%SystemRoot%\System32\reg.exe` with fixed arguments. Only the production key and the
 * test key pattern are accepted; anything else fails without starting reg.exe.
 */
export function regExeRunOnce(env: Readonly<Record<string, string | undefined>>, execFile: ExecFilePort = nodeExecFile, now: () => number = Date.now): RunOnceRegistry {
  const reg = path.win32.join(systemRoot(env), 'System32', 'reg.exe');
  const run = (args: readonly string[], timeoutMs: number) => runFixedProgram(execFile, reg, args, {timeoutMs, maxOutputBytes: 256 * 1024});
  const valid = (key: string, value: string) => allowedKey(key) && value === RUN_ONCE_VALUE;
  /** One budget for every reg.exe call of an operation: each call gets what is left of it, at least 1 ms. */
  const budget = (timeoutMs: number) => {
    const end = now() + timeoutMs;
    return () => Math.max(1, end - now());
  };
  /**
   * The value's data (an empty string for a value of another type), null when it does not exist, or undefined when that
   * cannot be told. reg.exe exits 1 both for a missing key or value and for a failure such as a denied read, and its
   * error text is localized, so only exit 0 and the listing on stdout are trusted: the key's own listing (its values),
   * or, when the key cannot be listed, the listing of its nearest readable ancestor up to `HKCU\Software`, which shows
   * whether the key exists at all. A key that exists but cannot be listed is undefined, never absent.
   */
  const probe = async (key: string, value: string, left: () => number): Promise<string | null | undefined> => {
    const listing = await run(['query', key], left());
    if (listing.ok) return valueIn(listing.stdout.toString('utf8'), value);
    if (listing.failure !== 'failed') return undefined;
    let child = key;
    for (let parent = path.win32.dirname(key); child.toLowerCase() !== 'hkcu\\software'; child = parent, parent = path.win32.dirname(parent)) {
      const ancestor = await run(['query', parent], left());
      if (!ancestor.ok) {
        if (ancestor.failure !== 'failed') return undefined;
        continue;
      }
      return listsSubkey(ancestor.stdout.toString('utf8'), child) ? undefined : null;
    }
    return undefined;
  };
  const read = async (key: string, value: string, timeoutMs: number): Promise<string | null | undefined> =>
    valid(key, value) ? probe(key, value, budget(timeoutMs)) : undefined;
  return {
    set: async (key, value, data, timeoutMs) => {
      if (!valid(key, value) || /[\r\n\0]/.test(data)) return false;
      return (await run(['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'], timeoutMs)).ok;
    },
    remove: async (key, value, timeoutMs) => {
      if (!valid(key, value)) return 'failed';
      const left = budget(timeoutMs);
      if ((await run(['delete', key, '/v', value, '/f'], left())).ok) return 'removed';
      // The delete also fails for a missing value; only a listing that shows the value is gone makes it `absent`.
      return await probe(key, value, left) === null ? 'absent' : 'failed';
    },
    read
  };
}

/** The data of `value` in a `reg query <key>` listing: REG_SZ data, '' for another type, or null when it is not listed. */
function valueIn(output: string, value: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const match = /^ {4}(.+?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/.exec(line);
    if (match && match[1] === value) return match[2] === 'REG_SZ' ? match[3] ?? '' : '';
  }
  return null;
}
/** True when a `reg query <parent>` listing names the subkey `key` (full names, compared case-insensitively). */
function listsSubkey(output: string, key: string): boolean {
  const full = key.replace(/^HKCU\\/i, 'HKEY_CURRENT_USER\\').toLowerCase();
  return output.split(/\r?\n/).some(line => line.trim().toLowerCase() === full);
}
