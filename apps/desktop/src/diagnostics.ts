import {appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync} from 'node:fs';
import {appendFile} from 'node:fs/promises';
import path from 'node:path';

const LIMIT = 256 * 1024;
const MAX_RECORDS = 2000;
/**
 * How long the telemetry service's final log write waits for the asynchronous append in flight on exit paths without a
 * `stop` request (a failed probe). After `stop` the wait is the time left before main's kill deadline less a 300 ms
 * reserve (service-supervisor.ts, stopTimeLeftMs). Whatever is still queued afterwards is written synchronously.
 */
export const SERVICE_EXIT_FLUSH_MS = 150;
/**
 * How long the service lets an append in flight finish before it writes its queue synchronously and posts a failure
 * report that main answers by killing it. Main reacts to the failure that much later at most.
 */
export const SERVICE_REPORT_SETTLE_MS = 500;
/**
 * How long main lets an append in flight finish before it writes its final rows (`SERVICE_EXIT`, `APP_EXIT`)
 * synchronously and calls `app.exit`. The exiting instance still holds the single-instance lock, so a launch in this
 * window only signals it and ends; the wait is kept short for that.
 */
export const MAIN_EXIT_FLUSH_MS = 300;
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
  /**
   * Lets the asynchronous append in flight, if any, finish within `timeoutMs`, then writes everything still queued with
   * one synchronous append (at most the 256 KiB the bounds counted). The queued rows are therefore on disk when it
   * resolves, whatever the timer does. Only a batch that is still in flight after `timeoutMs` can land after them, or be
   * lost if the process exits first. Nothing is written twice. Later records are written asynchronously again.
   */
  settle(timeoutMs: number): Promise<void>;
  /**
   * The final write before the process exits: like `settle`, but no further asynchronous append is started once it is
   * called, and every record logged after it resolved is written synchronously at once.
   */
  finalize(timeoutMs: number): Promise<void>;
  /**
   * Crash and unhandled-rejection paths only: writes every queued record at once with a synchronous append (at most the
   * 256 KiB the bounds counted). A batch already being written asynchronously may land after these records, or be lost
   * if the process exits first; nothing is written twice.
   */
  drainSync(): void;
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
  // final: no new asynchronous append (finalize was called); drained: finalize resolved, so records are written at once.
  let final = false, drained = false;
  // Called once the append in flight settled, before the next one may start (settle and finalize).
  const idle: (() => void)[] = [];
  // Records handed to the queue, and records written or reported; flush waits until the second reaches the first.
  let queued = 0, handled = 0;
  const waiters: {until: number; resolve: (done: boolean) => void}[] = [];

  // A disk error must not break shutdown, and fallback output never includes raw errors.
  const fallback = (event: string) => console.error(`[ETS2Telemetry] ${event}`);
  function notifyFlushes(): void {
    for (const waiter of waiters.splice(0)) {
      if (handled >= waiter.until) waiter.resolve(true); else waiters.push(waiter);
    }
  }
  function pump(): void {
    if (writing || final || !queue.length) return;
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
      for (const resume of idle.splice(0)) resume();
      notifyFlushes(); pump();
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
    if (drained) drainSync(); else pump();
  };
  function drainSync(): void {
    if (!queue.length) return;
    const batch = queue; queue = [];
    if (!available) { for (const entry of batch) fallback(entry.event); }
    else {
      try { appendFileSync(filename, batch.map(entry => entry.line).join(''), 'utf8'); }
      catch { available = false; for (const entry of batch) fallback(entry.event); }
    }
    handled += batch.length;
    notifyFlushes();
  }
  function settleWrites(timeoutMs: number): Promise<void> {
    return new Promise<void>(resolve => {
      // No append in flight, or no time left to wait for it: write the queue now.
      if (!writing || timeoutMs <= 0) { drainSync(); resolve(); return; }
      const done = () => {
        clearTimeout(timer);
        const index = idle.indexOf(done);
        if (index >= 0) idle.splice(index, 1);
        drainSync(); resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      idle.push(done);
    });
  }
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
    },
    settle: settleWrites,
    finalize(timeoutMs: number): Promise<void> {
      final = true;
      return settleWrites(timeoutMs).then(() => { drained = true; drainSync(); });
    },
    drainSync
  });
}
