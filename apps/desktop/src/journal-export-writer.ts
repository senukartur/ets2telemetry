// The trip export flow in main (ET-016 PR-5, J16, J17). One export at a time: read the trip detail through the journal
// broker, ask the user for a file in main's Save dialog, refuse a target inside the application's data directory or a
// device path, then write `<name>.<hex8>.partial` beside the target page by page through the journal reads at the export
// page sizes, sync it, close it and rename it over the target. A cancelled dialog touches nothing; a failure or an
// application exit removes the partial file and leaves an existing target unchanged. The renderer receives the result
// codes and row counts only, never a path, and the log holds fixed codes only. See docs/journal-export.md.
import {randomBytes} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {JournalCallResult, JournalEventPage, JournalExportCode, JournalExportResult, JournalIntervalPage, JournalSamplePage, JournalTripDetail} from '../../../packages/contracts/src';
import type {DiagnosticFacts} from './diagnostics';
import {
  JOURNAL_EXPORT_EVENT_LIMIT, JOURNAL_EXPORT_INTERVAL_LIMIT, JOURNAL_EXPORT_SAMPLE_LIMIT, type JournalDatabaseInfo, type JournalQuery
} from './journal-contract';
import {tripExportBounds, tripExportFileName, tripExportHeader, TripExportSerializer, withinTripExportBounds, type TripExportRows, type TripExportSection} from './journal-export';

/** Delays before each retry of the final rename, as for settings saves: five retries within 300 ms. */
export const EXPORT_RENAME_RETRY_DELAYS_MS: readonly number[] = Object.freeze([20, 40, 60, 80, 100]);
/** Antivirus scanners and indexers briefly hold new files open on Windows. */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);
/** The Save dialog's only file type. */
export const EXPORT_DIALOG_FILTERS = Object.freeze([{name: 'JSON', extensions: ['json']}]);

interface ExportFileHandle {write(data: string): Promise<unknown>; sync(): Promise<void>; close(): Promise<void>}
/** The file operations of an export; tests wrap the real ones to inject failures. */
export interface ExportFileSystem {
  open(target: string, flags: 'wx'): Promise<ExportFileHandle>;
  rename(from: string, to: string): Promise<void>;
  unlink(target: string): Promise<void>;
  realpath(target: string): Promise<string>;
}
export interface JournalExporterOptions {
  /** One journal read through main's broker, whose answer main already checked against the request (journal-contract.ts). */
  read(query: JournalQuery): Promise<JournalCallResult<unknown>>;
  /** Main's Save dialog for the dashboard window; resolves with the chosen file or a cancellation. */
  showSaveDialog(defaultPath: string): Promise<{canceled: boolean; filePath?: string}>;
  /** The directory of the dialog's default path (the user's Documents); undefined leaves only the file name. */
  documents(): string | undefined;
  /** LOCALAPPDATA; the data directory `<LOCALAPPDATA>\ETS2Telemetry` is never a target. Without it every target is refused. */
  localAppData: string | undefined;
  /** The application version written into the header. */
  appVersion: string;
  /** Fixed codes and facts only. */
  log(event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  fs?: ExportFileSystem;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  /** Eight hex digits of the partial file's name. */
  suffix?: () => string;
}

const errorCode = (error: unknown) => error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
const DEVICE_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(\..*)?$/i;
/**
 * A Windows path as Windows compares it: resolved, with the trailing dots and spaces Windows drops from each component
 * removed, in lower case (NTFS names are case-insensitive by default).
 */
function comparable(target: string): string {
  return path.win32.resolve(target).split('\\').map((part, index) => index === 0 ? part : part.replace(/[. ]+$/, '')).join('\\').toLowerCase();
}
const inside = (target: string, root: string) => target === root || target.startsWith(`${root}\\`);
/**
 * Whether a chosen target is refused (J16): anything that is not a drive or UNC path, a `\\?\` or `\\.\` device path, a
 * DOS device name in any component, or a path inside `<LOCALAPPDATA>\ETS2Telemetry` (normalized and case-insensitive).
 * Without a usable LOCALAPPDATA the data directory is unknown, so every target is refused.
 */
export function exportTargetRefused(target: unknown, localAppData: string | undefined): boolean {
  if (typeof target !== 'string' || target.length === 0 || target.includes('\0')) return true;
  const raw = target.replaceAll('/', '\\');
  if (raw.startsWith('\\\\?\\') || raw.startsWith('\\\\.\\') || raw.startsWith('\\??\\')) return true;
  if (!/^[A-Za-z]:\\/.test(raw) && !/^\\\\[^\\?.]/.test(raw)) return true;
  const resolved = comparable(raw);
  if (resolved.split('\\').slice(1).some(part => DEVICE_NAME.test(part.trim()))) return true;
  if (!localAppData || !path.win32.isAbsolute(localAppData)) return true;
  return inside(resolved, comparable(path.win32.join(localAppData, 'ETS2Telemetry')));
}

type ExportFailure = Extract<JournalExportResult, {ok: false}>;
/**
 * An export that ends with a fixed code; the partial file is removed and the target left unchanged. `facts` are fixed
 * facts for the log only (the write step and the system error code), never a path.
 */
class ExportStop extends Error {
  constructor(readonly result: ExportFailure, readonly facts: DiagnosticFacts = {}) { super('Export stopped'); }
}
const stop = (code: JournalExportCode | 'FAILED', facts?: DiagnosticFacts) => new ExportStop({ok: false, code}, facts);

/**
 * One export at a time (J16). `abort` (the application exits) stops a running export at its next step and refuses new
 * ones with EXPORT_INTERRUPTED; `idle` settles once no partial file is left, for the exit's bounded idle hook.
 */
export class JournalExporter {
  #running = false;
  #aborted = false;
  #fileWork: Promise<void> | undefined;
  readonly #fs: ExportFileSystem;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #suffix: () => string;

  constructor(private readonly options: JournalExporterOptions) {
    this.#fs = options.fs ?? nodeFs;
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#suffix = options.suffix ?? (() => randomBytes(4).toString('hex'));
  }

  /** Stops a running export at its next step and refuses later ones (the application exits). */
  abort(): void { this.#aborted = true; }
  /** Settles when the running export's file work, including the removal of its partial file, has finished; undefined when there is none. */
  idle(): Promise<void> | undefined { return this.#fileWork; }

  /** Exports one trip. Never rejects: resolves the saved or cancelled outcome or a fixed code, and logs it. */
  async export(tripUuid: string): Promise<JournalExportResult> {
    if (this.#aborted) return this.#fail(stop('EXPORT_INTERRUPTED'));
    if (this.#running) return this.#fail(stop('EXPORT_IN_PROGRESS'));
    this.#running = true;
    try {
      return await this.#run(tripUuid);
    } catch (error) {
      return this.#fail(error instanceof ExportStop ? error : stop('FAILED'));
    } finally { this.#running = false; }
  }

  async #run(tripUuid: string): Promise<JournalExportResult> {
    const detail = await this.#value<JournalTripDetail>({kind: 'trip', tripUuid});
    const info = await this.#value<JournalDatabaseInfo>({kind: 'database'});
    // Both answers must describe the same database; the header names it.
    if (info.database.purpose !== detail.database.purpose || info.database.schemaVersion !== detail.database.schemaVersion) throw stop('FAILED');
    this.#check();
    let directory: string | undefined;
    try { directory = this.options.documents(); } catch { directory = undefined; }
    const name = tripExportFileName(detail);
    const choice = await this.options.showSaveDialog(directory ? path.join(directory, name) : name);
    this.#check();
    if (choice.canceled || !choice.filePath) {
      this.options.log('JOURNAL_EXPORT_CANCELLED');
      return {ok: true, value: {outcome: 'cancelled'}};
    }
    const target = choice.filePath;
    if (exportTargetRefused(target, this.options.localAppData)) throw stop('EXPORT_TARGET_REFUSED');
    const header = tripExportHeader({uuid: info.databaseUuid, purpose: info.database.purpose, schemaVersion: info.database.schemaVersion}, this.options.appVersion, this.#now());
    const work = this.#write(target, detail, new TripExportSerializer(detail, header));
    this.#fileWork = work.then(() => undefined, () => undefined);
    try {
      const counts = await work;
      this.options.log('JOURNAL_EXPORT_SAVED', undefined, {events: counts.events, samples: counts.samples});
      return {ok: true, value: {outcome: 'saved', ...counts}};
    } finally { this.#fileWork = undefined; }
  }

  /**
   * The value of one journal read, or a stop with the read's own J11 refusal. An exit during the read wins: main retires
   * the journal broker when it exits, which answers the read SERVICE_UNAVAILABLE.
   */
  async #value<T>(query: JournalQuery): Promise<T> {
    const result = await this.options.read(query);
    this.#check();
    if (!result.ok) throw new ExportStop(result);
    return result.value as T;
  }
  #check(): void { if (this.#aborted) throw stop('EXPORT_INTERRUPTED'); }

  async #write(target: string, detail: JournalTripDetail, serializer: TripExportSerializer): Promise<{events: number; intervals: number; samples: number}> {
    const fs = this.#fs, directory = path.dirname(target);
    let handle: ExportFileHandle | undefined, partial: string | undefined, step = 'target';
    try {
      // The chosen directory as Windows resolves it (junctions, short names), checked against the data directory again.
      const real = await fs.realpath(directory);
      const root = this.options.localAppData ? await fs.realpath(path.join(this.options.localAppData, 'ETS2Telemetry')).catch(() => undefined) : undefined;
      if (exportTargetRefused(path.join(real, path.basename(target)), this.options.localAppData)
        || (root !== undefined && inside(comparable(path.join(real, path.basename(target))), comparable(root)))) throw stop('EXPORT_TARGET_REFUSED');
      step = 'open';
      const candidate = path.join(directory, `${path.basename(target)}.${this.#suffix()}.partial`);
      handle = await fs.open(candidate, 'wx');
      partial = candidate;
      step = 'write';
      const write = async (text: string) => { this.#check(); if (text) await handle!.write(text); };
      await write(serializer.begin());
      const bounds = tripExportBounds(detail), session = detail.trip.pluginSessionId;
      const counts = {intervals: 0, events: 0, samples: 0};
      const section = async <S extends TripExportSection>(name: S, read: (cursor: string | undefined) => Promise<{rows: TripExportRows[S][]; next: string | null}>) => {
        // A section whose bound is null has nothing to export, and none is read.
        if ((name === 'intervals' && bounds.lastIntervalId === null) || (name === 'samples' && bounds.lastSampleId === null)) return;
        let cursor: string | undefined;
        for (;;) {
          this.#check();
          const page = await read(cursor);
          const kept = page.rows.filter(row => withinTripExportBounds(name, row, bounds));
          counts[name] += kept.length;
          await write(serializer.rows(name, kept));
          // Pages stop at the bounds (J17): a row past them ends the section.
          if (page.next === null || kept.length < page.rows.length) return;
          cursor = page.next;
        }
      };
      const page = <P extends {database: JournalTripDetail['database']}>(value: P) => {
        if (value.database.purpose !== detail.database.purpose || value.database.schemaVersion !== detail.database.schemaVersion) throw stop('FAILED');
        return value;
      };
      await section('intervals', async cursor => {
        const value = page(await this.#value<JournalIntervalPage>({kind: 'intervals', tripUuid: detail.trip.tripUuid, page: {...(cursor ? {cursor} : {}), limit: JOURNAL_EXPORT_INTERVAL_LIMIT}}));
        return {rows: value.intervals, next: value.nextCursor};
      });
      await section('events', async cursor => {
        const value = page(await this.#value<JournalEventPage>({kind: 'events', tripUuid: detail.trip.tripUuid, page: {...(cursor ? {cursor} : {}), limit: JOURNAL_EXPORT_EVENT_LIMIT}}));
        // The timeline is the trip's own plugin session's (J7).
        if (value.window.pluginSessionId !== session) throw stop('FAILED');
        return {rows: value.events, next: value.nextCursor};
      });
      await section('samples', async cursor => {
        const value = page(await this.#value<JournalSamplePage>({kind: 'samples', tripUuid: detail.trip.tripUuid, page: {...(cursor ? {cursor} : {}), limit: JOURNAL_EXPORT_SAMPLE_LIMIT}}));
        return {rows: value.samples, next: value.nextCursor};
      });
      await write(serializer.end());
      step = 'sync';
      await handle.sync();
      step = 'close';
      const closing = handle; handle = undefined;
      await closing.close();
      step = 'rename';
      await this.#renameWithRetry(partial, target);
      partial = undefined;
      return counts;
    } catch (error) {
      if (error instanceof ExportStop) throw error;
      throw stop('EXPORT_WRITE_FAILED', {step, errno: errorCode(error) ?? null});
    } finally {
      if (handle) await handle.close().catch(() => undefined);
      if (partial) await fs.unlink(partial).catch(() => undefined);
    }
  }

  async #renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      this.#check();
      try { await this.#fs.rename(from, to); return; }
      catch (error) {
        const code = errorCode(error);
        if (attempt >= EXPORT_RENAME_RETRY_DELAYS_MS.length || !code || !RETRYABLE_RENAME.has(code)) throw error;
        await this.#delay(EXPORT_RENAME_RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  #fail(failure: ExportStop): JournalExportResult {
    this.options.log('JOURNAL_EXPORT_FAILED', undefined, {code: failure.result.code, ...failure.facts});
    return failure.result;
  }
}
