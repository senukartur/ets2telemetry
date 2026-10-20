import {execFile} from 'node:child_process';
import path from 'node:path';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import type {GameProcess} from './reader';
/** A fixed, read-only query of the already authenticated pipe peer. No renderer text is interpolated. */
export function inspectGameProcess(source: SourceIdentity, signal: AbortSignal): Promise<GameProcess | null> {
  if (!Number.isSafeInteger(source.processId) || source.processId < 1 || source.processId > 4294967295 || !process.env.SystemRoot) return Promise.resolve(null);
  const script = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${source.processId}'; if($null -eq $p){exit 1}; @{pid=[int]$p.ProcessId;createdUtcMs=[DateTimeOffset]::new($p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds();executable=$p.ExecutablePath;commandLine=$p.CommandLine}|ConvertTo-Json -Compress`;
  return new Promise(resolve => {
    execFile(path.win32.join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {windowsHide: true, timeout: 1500, maxBuffer: 16 * 1024, signal, encoding: 'utf8'}, (error, stdout) => {
        if (error) {resolve(null); return;}
        try {
          const p = JSON.parse(stdout) as GameProcess;
          resolve(p.pid === source.processId && Number.isSafeInteger(p.createdUtcMs) && typeof p.executable === 'string' && typeof p.commandLine === 'string' ? p : null);
        } catch {resolve(null);}
      });
  });
}
