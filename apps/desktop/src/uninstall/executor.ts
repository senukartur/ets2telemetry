import path from 'node:path';
import {readAtomicFile, writeAtomicFile, type AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {nodeExecFile, runFixedProgram, systemRoot, type ExecFilePort} from '../plugin-setup/fixed-program';
import {PENDING_DIRECTORY} from './pending-record';
import type {UninstallRoots} from './roots';

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
export const RUN_ONCE_VALUE = 'ETS2TelemetryUninstall';
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

/** The registered command: Windows PowerShell 5.1 runs the copied script, hidden, without a profile and without prompts. */
export function executorCommand(dataRoot: string): string {
  return `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${path.win32.join(dataRoot, PENDING_DIRECTORY, EXECUTOR_FILE)}"`;
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
  /** The packaged executor's bytes, or undefined when it cannot be read. */
  readExecutor(): Promise<Uint8Array | undefined>;
  /** The milliseconds a registry call may take now (REG_TIMEOUT_MS, cut to the uninstall's remaining budget). */
  readonly timeoutMs: () => number;
}

/**
 * Copies the executor into `<data root>\uninstall\` (atomically, then read back and compared) and registers it. Called
 * after the intent is written and before anything is deleted. A failed copy registers nothing, so the registration never
 * names a missing or partial script; a command longer than 260 characters is never registered. Either failure leaves
 * README.txt as the fallback.
 */
export async function armExecutor(ports: ExecutorPorts): Promise<ExecutorState> {
  const key = runOnceKeyFor(ports.roots);
  if (!ports.roots.ok || key === null) return 'not-applicable';
  if (!allowedKey(key)) return 'failed';
  const command = executorCommand(ports.roots.dataRoot);
  if (command.length > MAX_RUN_ONCE_COMMAND) return 'failed';
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
export function regExeRunOnce(env: Readonly<Record<string, string | undefined>>, execFile: ExecFilePort = nodeExecFile): RunOnceRegistry {
  const reg = path.win32.join(systemRoot(env), 'System32', 'reg.exe');
  const run = (args: readonly string[], timeoutMs: number) => runFixedProgram(execFile, reg, args, {timeoutMs, maxOutputBytes: 64 * 1024});
  const valid = (key: string, value: string) => allowedKey(key) && value === RUN_ONCE_VALUE;
  const read = async (key: string, value: string, timeoutMs: number): Promise<string | null | undefined> => {
    if (!valid(key, value)) return undefined;
    const result = await run(['query', key, '/v', value], timeoutMs);
    // reg.exe exits 1 both for a missing value and for a failure; a missing value has no output on stdout.
    if (!result.ok) return result.failure === 'failed' ? null : undefined;
    return parseRegQuery(result.stdout.toString('utf8'), value);
  };
  return {
    set: async (key, value, data, timeoutMs) => {
      if (!valid(key, value) || /[\r\n\0]/.test(data)) return false;
      return (await run(['add', key, '/v', value, '/t', 'REG_SZ', '/d', data, '/f'], timeoutMs)).ok;
    },
    remove: async (key, value, timeoutMs) => {
      if (!valid(key, value)) return 'failed';
      if ((await run(['delete', key, '/v', value, '/f'], timeoutMs)).ok) return 'removed';
      // The delete fails for a missing value too: a query that finds nothing tells them apart.
      return await read(key, value, timeoutMs) === null ? 'absent' : 'failed';
    },
    read
  };
}
