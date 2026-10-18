import {existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 256 * 1024;
const MAX_RECORDS = 2000;
/**
 * The longest a process waits for its pending log records before it exits. The service's stop sequence takes at most
 * 2,500 ms, so with this wait the service exits inside main's 3,000 ms kill deadline. Main has no such deadline after
 * its supervisor finished, and gives its own final rows (`SERVICE_EXIT`, `APP_EXIT`) up to 1,000 ms.
 */
export const SERVICE_EXIT_FLUSH_MS = 250;
export const MAIN_EXIT_FLUSH_MS = 1000;
/** The longest the diagnostic bundle waits for main's pending records before it reads the logs. */
export const BUNDLE_FLUSH_MS = 250;

/** Always-logged fields; callers pass only fixed codes, numbers and flags, never paths, peer data or telemetry. */
export type DiagnosticFacts = Readonly<Record<string, string | number | boolean | null>>;
export interface DiagnosticLog {
  (event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  /**
   * Resolves once every record logged before the call was written or reported to the console, with `true`, or after
   * `timeoutMs` with `false`. It never rejects.
   */
  flush(timeoutMs: number): Promise<boolean>;
}

/**
 * Startup diagnostics only; never log telemetry or credentials. Detailed errors are opt-in.
 *
 * Logging never waits for the disk. A record is formatted and counted against the 256 KiB and 2,000-record bounds when
 * it is logged, then queued; one asynchronous append at a time writes everything queued, in order, to `startup.jsonl`
 * with the same append semantics as before. The bounds count queued records too, so the queue never holds more than
 * 256 KiB. A failed append reports that batch, the rest of the queue and every later record on the console by event
 * code only, as a failed synchronous append did. Rotation to `.1` still happens once, when the log is created.
 */
export function createDiagnostics(directory: string, detailed = false): DiagnosticLog {
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

  let queue: {event: string; line: string}[] = [];
  let writing = false;
  // Records handed to the queue, and records written or reported; flush waits until the second reaches the first.
  let queued = 0, handled = 0;
  const waiters: {until: number; resolve: (done: boolean) => void}[] = [];

  // A disk error must not break shutdown, and fallback output never includes raw errors.
  const fallback = (event: string) => console.error(`[ETS2Telemetry] ${event}`);
  function settle(): void {
    for (const waiter of waiters.splice(0)) {
      if (handled >= waiter.until) waiter.resolve(true); else waiters.push(waiter);
    }
  }
  function pump(): void {
    if (writing || !queue.length) return;
    const batch = queue; queue = [];
    writing = true;
    const finished = (written: boolean) => {
      if (!written) {
        // As after a failed synchronous append: this batch, everything queued behind it and every later record go to the
        // console, in order.
        available = false;
        for (const entry of [...batch, ...queue]) fallback(entry.event);
        handled += queue.length; queue = [];
      }
      writing = false; handled += batch.length;
      settle(); pump();
    };
    appendFile(filename, batch.map(entry => entry.line).join(''), 'utf8').then(() => finished(true), () => finished(false));
  }

  const log = (event: string, detail?: unknown, facts?: DiagnosticFacts): void => {
    if (++records > MAX_RECORDS) return;
    const value = detail instanceof Error
      ? {name: detail.name, message: detail.message.slice(0, 2048), stack: detail.stack?.slice(0, 4096)}
      : typeof detail === 'string' ? detail.slice(0, 4096) : detail;
    let line: string;
    try {
      line = JSON.stringify({time: new Date().toISOString(), pid: process.pid, event, ...(facts ? {facts} : {}),
        ...(detailed && value !== undefined ? {detail: value} : {})}) + '\n';
    } catch {return;}
    const size = Buffer.byteLength(line);
    if (bytes + size > LIMIT) return;
    bytes += size;
    if (!available) { fallback(event); return; }
    queue.push({event, line}); queued++;
    pump();
  };
  return Object.assign(log, {
    flush(timeoutMs: number): Promise<boolean> {
      if (handled >= queued) return Promise.resolve(true);
      return new Promise<boolean>(resolve => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          resolve(false);
        }, timeoutMs);
        const waiter = {until: queued, resolve: (done: boolean) => { clearTimeout(timer); resolve(done); }};
        waiters.push(waiter);
      });
    }
  });
}
