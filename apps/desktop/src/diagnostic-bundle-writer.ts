// The diagnostic bundle export in main (ET-017 P17). One export at a time: ask for a file in main's Save dialog,
// parented to the dashboard; refuse a target inside the application's data directory or a device path; build the
// redacted bundle; write it through a partial file beside the target and rename it over the target (export-file.ts,
// shared with the trip export). A cancelled dialog reads and writes nothing; a failure or an application exit removes
// the partial file and leaves an existing target unchanged. Nothing is uploaded. The renderer receives a fixed outcome
// only, never a path, and the log holds fixed codes only. See docs/plugin-setup.md#diagnostic-bundle.
import {randomBytes} from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import type {DiagnosticsExportFailure, DiagnosticsExportRefusal, DiagnosticsExportResult} from '../../../packages/contracts/src';
import type {DiagnosticFacts} from './diagnostics';
import {exportErrorCode, exportTargetRefused, writeThroughPartial, type ExportFileSystem} from './export-file';

export interface DiagnosticBundleExporterOptions {
  /** Builds the bundle text (diagnostic-bundle.ts); called only after the user chose an allowed file. */
  build(): Promise<string>;
  /** Main's Save dialog for the dashboard window; resolves with the chosen file or a cancellation. */
  showSaveDialog(defaultPath: string): Promise<{canceled: boolean; filePath?: string}>;
  /** The directory of the dialog's default path (the user's Documents); undefined leaves only the file name. */
  documents(): string | undefined;
  /** LOCALAPPDATA; the data directory `<LOCALAPPDATA>\ETS2Telemetry` is never a target. Without it every target is refused. */
  localAppData: string | undefined;
  /** Fixed codes and facts only. */
  log(event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  fs?: ExportFileSystem;
  now?: () => number;
  delay?: (milliseconds: number) => Promise<void>;
  /** Eight hex digits of the partial file's name. */
  suffix?: () => string;
}

/** The default file name: `ets2telemetry-diagnostics-<UTC>.json`, such as `ets2telemetry-diagnostics-20261017T083015Z.json`. */
export function diagnosticBundleFileName(nowMs: number): string {
  return `ets2telemetry-diagnostics-${new Date(nowMs).toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(/[-:]/g, '')}.json`;
}

type Ended = Extract<DiagnosticsExportResult, {outcome: 'refused' | 'failed'}>;
/** An export that ends with a fixed code; `facts` are fixed log facts (the write step and the system error code). */
class DiagnosticsStop extends Error {
  constructor(readonly result: Ended, readonly facts: DiagnosticFacts = {}) { super('Diagnostics export stopped'); }
}
const refuse = (code: DiagnosticsExportRefusal) => new DiagnosticsStop({outcome: 'refused', code});
const fail = (code: DiagnosticsExportFailure, facts?: DiagnosticFacts) => new DiagnosticsStop({outcome: 'failed', code}, facts);

/**
 * One diagnostics export at a time. `abort` (the application exits) stops a running export at its next step and
 * refuses new ones with EXPORT_INTERRUPTED; `idle` settles once no partial file is left, for the exit's bounded idle hook.
 */
export class DiagnosticBundleExporter {
  #running = false;
  #aborted = false;
  #fileWork: Promise<void> | undefined;
  readonly #fs: ExportFileSystem;
  readonly #now: () => number;
  readonly #delay: (milliseconds: number) => Promise<void>;
  readonly #suffix: () => string;

  constructor(private readonly options: DiagnosticBundleExporterOptions) {
    this.#fs = options.fs ?? nodeFs;
    this.#now = options.now ?? Date.now;
    this.#delay = options.delay ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.#suffix = options.suffix ?? (() => randomBytes(4).toString('hex'));
  }

  /** Stops a running export at its next step and refuses later ones (the application exits). */
  abort(): void { this.#aborted = true; }
  /** Settles when the running export's file work, including the removal of its partial file, has finished. */
  idle(): Promise<void> | undefined { return this.#fileWork; }

  /** Exports the bundle. Never rejects: resolves the saved or cancelled outcome or a fixed code, and logs it. */
  async export(): Promise<DiagnosticsExportResult> {
    if (this.#aborted) return this.#end(refuse('EXPORT_INTERRUPTED'));
    if (this.#running) return this.#end(refuse('EXPORT_IN_PROGRESS'));
    this.#running = true;
    try {
      return await this.#run();
    } catch (error) {
      return this.#end(error instanceof DiagnosticsStop ? error : fail('BUNDLE_FAILED'));
    } finally { this.#running = false; }
  }

  async #run(): Promise<DiagnosticsExportResult> {
    let directory: string | undefined;
    try { directory = this.options.documents(); } catch { directory = undefined; }
    const name = diagnosticBundleFileName(this.#now());
    const choice = await this.options.showSaveDialog(directory ? path.join(directory, name) : name);
    this.#check();
    if (choice.canceled || !choice.filePath) {
      this.options.log('DIAGNOSTICS_EXPORT_CANCELLED');
      return {outcome: 'cancelled'};
    }
    const target = choice.filePath;
    if (exportTargetRefused(target, this.options.localAppData)) throw refuse('EXPORT_TARGET_REFUSED');
    let content: string;
    try { content = await this.options.build(); } catch { throw fail('BUNDLE_FAILED'); }
    this.#check();
    const work = writeThroughPartial({fs: this.#fs, target, localAppData: this.options.localAppData, suffix: this.#suffix, delay: this.#delay,
      check: () => this.#check(), refused: () => refuse('EXPORT_TARGET_REFUSED'),
      failed: (step, error) => error instanceof DiagnosticsStop ? error : fail('EXPORT_WRITE_FAILED', {step, errno: exportErrorCode(error) ?? null}),
      body: write => write(content)});
    this.#fileWork = work.then(() => undefined, () => undefined);
    try {
      await work;
      this.options.log('DIAGNOSTICS_EXPORT_SAVED', undefined, {bytes: Buffer.byteLength(content, 'utf8')});
      return {outcome: 'saved'};
    } finally { this.#fileWork = undefined; }
  }

  #check(): void { if (this.#aborted) throw refuse('EXPORT_INTERRUPTED'); }

  #end(stop: DiagnosticsStop): DiagnosticsExportResult {
    this.options.log('DIAGNOSTICS_EXPORT_FAILED', undefined, {outcome: stop.result.outcome, code: stop.result.code, ...stop.facts});
    return stop.result;
  }
}
