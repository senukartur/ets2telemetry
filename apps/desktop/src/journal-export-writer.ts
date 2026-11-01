// The trip export flow in main (ET-016 PR-5, J16, J17). One export at a time: read the trip detail through the journal
// broker, ask the user for a file in main's Save dialog, refuse a target inside the application's data directory or a
// device path, then write `<name>.<hex8>.partial` beside the target page by page through the journal reads at the export
// page sizes, sync it, close it and rename it over the target. A cancelled dialog touches nothing; a failure or an
// application exit removes the partial file and leaves an existing target unchanged. The renderer receives the result
// codes and row counts only, never a path, and the log holds fixed codes only. See docs/journal-export.md. The target
// checks and the partial-file write are shared with the diagnostic bundle in export-file.ts (ET-017 PR-6).
import {randomBytes} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {JournalCallResult, JournalEventPage, JournalExportCode, JournalExportResult, JournalIntervalPage, JournalSamplePage, JournalTripDetail, TripExportDiagnostics} from '../../../packages/contracts/src';
import {emptyTripDiagnostics} from './trip-export-diagnostics';
import type {DiagnosticFacts} from './diagnostics';
import {
  JOURNAL_EXPORT_EVENT_LIMIT, JOURNAL_EXPORT_INTERVAL_LIMIT, JOURNAL_EXPORT_SAMPLE_LIMIT, type JournalDatabaseInfo, type JournalQuery
} from './journal-contract';
import {exportErrorCode, exportTargetRefused, writeThroughPartial, type ExportFileSystem} from './export-file';
import {tripExportBounds, tripExportFileName, tripExportHeader, TripExportSerializer, withinTripExportBounds, type TripExportRows, type TripExportSection} from './journal-export';

export {EXPORT_ANCESTOR_LIMIT, EXPORT_DIALOG_FILTERS, EXPORT_RENAME_RETRY_DELAYS_MS, exportTargetRefused, type ExportFileSystem} from './export-file';

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
  /** Optional bounded log evidence, collected only after Save and target checks, inside the export's idle work. */
  diagnostics?(detail: JournalTripDetail, exportedUtcMs: number): Promise<TripExportDiagnostics>;
  /** Fixed codes and facts only. */
  log(event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  fs?: ExportFileSystem;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  /** Eight hex digits of the partial file's name. */
  suffix?: () => string;
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
    const work = (async () => {
      let diagnostics = emptyTripDiagnostics(detail);
      if (detail.database.purpose === 'history' && this.options.diagnostics) {
        try { diagnostics = await this.options.diagnostics(detail, header.exportedUtcMs); }
        catch { diagnostics.notes = ['COLLECTION_FAILED']; }
      }
      this.#check();
      return this.#write(target, detail, new TripExportSerializer(detail, header, diagnostics));
    })();
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
    const counts = {intervals: 0, events: 0, samples: 0};
    await writeThroughPartial({fs: this.#fs, target, localAppData: this.options.localAppData, suffix: this.#suffix, delay: this.#delay,
      check: () => this.#check(), refused: () => stop('EXPORT_TARGET_REFUSED'),
      failed: (step, error) => error instanceof ExportStop ? error : stop('EXPORT_WRITE_FAILED', {step, errno: exportErrorCode(error) ?? null}),
      body: async write => {
        await write(serializer.begin());
        const bounds = tripExportBounds(detail), session = detail.trip.pluginSessionId;
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
      }});
    return counts;
  }

  #fail(failure: ExportStop): JournalExportResult {
    this.options.log('JOURNAL_EXPORT_FAILED', undefined, {code: failure.result.code, ...failure.facts});
    return failure.result;
  }
}
