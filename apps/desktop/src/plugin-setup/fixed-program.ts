import {spawn, type ExecFileException} from 'node:child_process';
import path from 'node:path';

// Runs one fixed Windows system program (PowerShell for the Steam registry values, tasklist for running games) with
// fixed arguments, no shell, a hidden window, a deadline and an output bound (ET-017 P1, P7). No caller passes text
// from the renderer, a file or the environment into the arguments.

/** The parts of `execFile` this module uses; tests replace it to simulate timeouts and oversized output. */
export type ExecFilePort = (
  file: string,
  args: readonly string[],
  options: {encoding: 'buffer'; timeout: number; maxBuffer: number; windowsHide: true; shell: false; signal?: AbortSignal;
    /** The child's whole environment; absent means the parent's. */
    env?: Readonly<Record<string, string | undefined>>},
  callback: (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void
) => unknown;
/**
 * `execFile`'s contract on `spawn`, without destroying the child's output streams. On an abort, a timeout or output
 * beyond the bound, Node's `execFile` destroys stdout and stderr and then kills the child; output the dying child still
 * writes can then reach the destroyed pipe, where Node raises `RangeError ERR_OUT_OF_RANGE` from `onStreamRead` as an
 * uncaught exception. That ended main with exit code 1 when an exit aborted plugin setup's tasklist (ET-018 PR-3, fifth
 * hosted lifecycle run). Here the child is killed and the callback answers at once, while the streams stay open and are
 * drained and discarded until they close by themselves.
 */
export const nodeExecFile: ExecFilePort = (file, args, options, callback) => {
  const child = spawn(file, args, {windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], ...(options.env ? {env: options.env} : {})});
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let size = 0, settled = false, timer: ReturnType<typeof setTimeout> | undefined;
  const failure = (message: string, properties: Partial<ExecFileException> & {name?: string}): ExecFileException =>
    Object.assign(new Error(message), {killed: false, code: undefined, signal: undefined, cmd: file}, properties);
  const settle = (error: ExecFileException | null) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    callback(error, Buffer.concat(stdout), Buffer.concat(stderr));
  };
  const stop = (error: ExecFileException) => {
    try {child.kill();} catch {/* already gone */}
    settle(error);
  };
  const collect = (target: Buffer[]) => (chunk: Buffer) => {
    if (settled) return;
    size += chunk.length;
    if (size > options.maxBuffer) {stop(failure('maxBuffer exceeded', {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true})); return;}
    target.push(chunk);
  };
  const onAbort = () => stop(failure('The operation was aborted', {name: 'AbortError', code: 'ABORT_ERR', killed: true}));
  child.stdout.on('data', collect(stdout));
  child.stderr.on('data', collect(stderr));
  child.stdout.on('error', () => undefined);
  child.stderr.on('error', () => undefined);
  child.on('error', error => settle(failure(error.message, {code: (error as NodeJS.ErrnoException).code})));
  child.on('close', (code, signal) => settle(code === 0 ? null : failure(`Command failed: ${file}`, {code: code ?? undefined, signal: signal ?? undefined})));
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener('abort', onAbort, {once: true});
  if (!settled && options.timeout > 0) timer = setTimeout(() => stop(failure('Timed out', {killed: true, signal: 'SIGTERM'})), options.timeout);
  return child;
};

export type FixedProgramFailure = 'timeout' | 'output-too-large' | 'aborted' | 'failed';
export type FixedProgramResult = {readonly ok: true; readonly stdout: Buffer} | {readonly ok: false; readonly failure: FixedProgramFailure};

export interface FixedProgramLimits {timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; env?: Readonly<Record<string, string | undefined>>}

/** Runs `file` with `args`; a non-zero exit, a timeout, an abort or output beyond the bound is a failure. */
export function runFixedProgram(execFilePort: ExecFilePort, file: string, args: readonly string[], limits: FixedProgramLimits): Promise<FixedProgramResult> {
  if (limits.signal?.aborted) return Promise.resolve({ok: false, failure: 'aborted'});
  return new Promise(resolve => {
    try {
      execFilePort(file, args, {encoding: 'buffer', timeout: limits.timeoutMs, maxBuffer: limits.maxOutputBytes, windowsHide: true, shell: false,
        ...(limits.signal ? {signal: limits.signal} : {}), ...(limits.env ? {env: limits.env} : {})}, (error, stdout) => {
        if (error) {
          if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') resolve({ok: false, failure: 'output-too-large'});
          else if (error.name === 'AbortError' || limits.signal?.aborted) resolve({ok: false, failure: 'aborted'});
          // Node kills the child with SIGTERM when the timeout expires and reports it as killed.
          else if (error.killed) resolve({ok: false, failure: 'timeout'});
          else resolve({ok: false, failure: 'failed'});
          return;
        }
        if (!Buffer.isBuffer(stdout) || stdout.length > limits.maxOutputBytes) resolve({ok: false, failure: 'output-too-large'});
        else resolve({ok: true, stdout});
      });
    } catch {resolve({ok: false, failure: 'failed'});}
  });
}

/**
 * The Windows directory from SystemRoot (or windir), used only to build the absolute path of a system program. A value
 * that is not a plain absolute drive folder falls back to `C:\Windows`.
 */
export function systemRoot(env: Readonly<Record<string, string | undefined>>): string {
  const value = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return typeof value === 'string' && /^[A-Za-z]:\\[^\\/:*?"<>|]+(\\[^\\/:*?"<>|]+)*$/.test(value) ? path.win32.normalize(value) : 'C:\\Windows';
}
