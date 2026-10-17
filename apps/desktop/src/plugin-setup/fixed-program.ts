import {execFile, type ExecFileException} from 'node:child_process';
import path from 'node:path';

// Runs one fixed Windows system program (PowerShell for the Steam registry values, tasklist for running games) with
// fixed arguments, no shell, a hidden window, a deadline and an output bound (ET-017 P1, P7). No caller passes text
// from the renderer, a file or the environment into the arguments.

/** The parts of `execFile` this module uses; tests replace it to simulate timeouts and oversized output. */
export type ExecFilePort = (
  file: string,
  args: readonly string[],
  options: {encoding: 'buffer'; timeout: number; maxBuffer: number; windowsHide: true; shell: false; signal?: AbortSignal},
  callback: (error: ExecFileException | null, stdout: Buffer, stderr: Buffer) => void
) => unknown;
export const nodeExecFile: ExecFilePort = (file, args, options, callback) => execFile(file, args, options, callback);

export type FixedProgramFailure = 'timeout' | 'output-too-large' | 'aborted' | 'failed';
export type FixedProgramResult = {readonly ok: true; readonly stdout: Buffer} | {readonly ok: false; readonly failure: FixedProgramFailure};

export interface FixedProgramLimits {timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal}

/** Runs `file` with `args`; a non-zero exit, a timeout, an abort or output beyond the bound is a failure. */
export function runFixedProgram(execFilePort: ExecFilePort, file: string, args: readonly string[], limits: FixedProgramLimits): Promise<FixedProgramResult> {
  if (limits.signal?.aborted) return Promise.resolve({ok: false, failure: 'aborted'});
  return new Promise(resolve => {
    try {
      execFilePort(file, args, {encoding: 'buffer', timeout: limits.timeoutMs, maxBuffer: limits.maxOutputBytes, windowsHide: true, shell: false,
        ...(limits.signal ? {signal: limits.signal} : {})}, (error, stdout) => {
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
