import {appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs';
import path from 'node:path';

const LIMIT = 256 * 1024;
// Startup diagnostics only; never log telemetry or credentials. Detailed errors are opt-in.
export function createDiagnostics(directory: string, detailed = false) {
  let available = true;
  let bytes = 0;
  let records = 0;
  const filename = path.join(directory, 'startup.jsonl');
  try {
    mkdirSync(directory, {recursive: true});
    if (existsSync(filename)) {
      if (statSync(filename).size >= LIMIT - 8192) {
        rmSync(`${filename}.1`, {force: true});
        renameSync(filename, `${filename}.1`);
      } else bytes = statSync(filename).size;
    }
  } catch {available = false;}
  return (event: string, detail?: unknown): void => {
    if (++records > 2000) return;
    const value = detail instanceof Error
      ? {name: detail.name, message: detail.message.slice(0, 2048), stack: detail.stack?.slice(0, 4096)}
      : typeof detail === 'string' ? detail.slice(0, 4096) : detail;
    let line: string;
    try {
      line = JSON.stringify({time: new Date().toISOString(), pid: process.pid, event,
        ...(detailed && value !== undefined ? {detail: value} : {})}) + '\n';
    } catch {return;}
    const size = Buffer.byteLength(line);
    if (bytes + size > LIMIT) return;
    bytes += size;
    if (available) {
      try {appendFileSync(filename, line, 'utf8'); return;} catch {available = false;}
    }
    // A disk error must not break shutdown, and fallback output never includes raw errors.
    console.error(`[ETS2Telemetry] ${event}`);
  };
}
