import {existsSync} from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {version} from '../../../package.json';
import type {JournalDatabase} from '../../../packages/contracts/src';
import type {StorageError, StorageErrorCode} from '../../../packages/storage/src/api';
import {StorageClient, workerHandle, type ClientTimers, type StorageWorkerHandle} from '../../../packages/storage/src/client';
import {isReopenRetryable, storageError} from '../../../packages/storage/src/errors';
import type {DiagnosticFacts} from './diagnostics';
import {processEntrypoint} from './entrypoints';
import {dataPaths} from './paths';
import {RECORDING_NAME_PATTERN, type RecordingDatabase} from './recording-policy';
import type {TripRecorderClient} from './trip-recorder';

/** Budget of the `history-storage` step in the service's `storage` shutdown phase. */
export const HISTORY_CLOSE_BUDGET_MS = 1000;
/**
 * The orderly close gets this long, plus one event-loop turn for answers that already arrived, before the worker is
 * terminated, so the step still ends inside its budget. A termination cannot interrupt a native SQLite call; such a stall
 * ends at the step budget instead.
 */
export const HISTORY_CLOSE_GRACE_MS = 800;
/** Reserve between the storage close grace and the step budget for worker termination and step settlement. */
export const CLOSE_TERMINATE_RESERVE_MS = 200;
/** Schedule of backoff delays for re-opening a database after a retryable open refusal. */
export const HISTORY_REOPEN_BACKOFF_MS = [250, 500, 1000, 2000, 4000] as const;
/** Maximum retry attempts before giving up re-opening. */
export const MAX_HISTORY_REOPEN_ATTEMPTS = 60;

const systemTimers: ClientTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setImmediate: callback => setImmediate(callback),
  clearImmediate: handle => clearImmediate(handle as ReturnType<typeof setImmediate>)
};

export interface HistoryStorageOptions {
  /** The service's LOCALAPPDATA. Missing or not absolute: history stays unavailable; there is no fallback location. */
  localAppData: string | undefined;
  /** Stamped into a new database and its migration rows; defaults to the application version. */
  appVersion?: string;
  log(event: string, detail?: unknown, facts?: DiagnosticFacts): void;
  createWorker(): StorageWorkerHandle;
  /**
   * ET-015a (R3): the database to open; the production history database when omitted. A synthetic or replay target is
   * `%LOCALAPPDATA%\ETS2Telemetry\synthetic\<name>.sqlite` with that purpose and backups in `synthetic\backups`.
   */
  target?: RecordingDatabase;
  /** ET-015a (R10): called once, after the database opened, so durable delivery can start without waiting for a reconnection. */
  onOpened?: () => void;
  /** ET-015c (G3): called after every change of `state`, for the recording status. */
  onStateChange?: (state: HistoryState) => void;
  /** Tests only. */
  timers?: ClientTimers;
  /** Tests only: the real-worker storage suite bounds a close by its own grace (tests/storage/helpers.ts). */
  closeGraceMs?: number;
  /** Tests only: backoff schedule for re-opening after a retryable open refusal. */
  reopenBackoffMs?: readonly number[];
  /** Tests only: max retry attempts before giving up re-opening. */
  maxReopenAttempts?: number;
}
export type HistoryState = 'idle' | 'opening' | 'open' | 'unavailable' | 'closed';

/** Starts the physical storage worker beside the service bundle in storage mode. */
export function historyWorker(directory: string): StorageWorkerHandle {
  const entrypoint = processEntrypoint(directory, 'storage-worker');
  if (!existsSync(entrypoint)) throw new Error('Missing physical storage worker entrypoint');
  return workerHandle(new Worker(entrypoint, {workerData: {kind: 'storage'}}));
}

/**
 * The durable history database of the telemetry service (ET-013, OD-2). `start` opens
 * `%LOCALAPPDATA%\ETS2Telemetry\data\telemetry.sqlite` in the storage worker without waiting for it, so live telemetry
 * and the overlay never depend on storage. Diagnostics carry fixed codes and numbers only: HISTORY_STORAGE_OPENED,
 * HISTORY_STORAGE_UNAVAILABLE (once) and HISTORY_STORAGE_CLOSED. ET-015a (R3) can open a synthetic or replay target
 * instead: it logs RECORDING_TARGET {purpose} first and then the same codes. `client` serves the trip recorder and, since
 * ET-016, the journal reads (journal-service.ts), which also read `database`; a journal answer that broke the journal
 * contract is logged as JOURNAL_ANSWER_INVALID {command, count} at counts 1, 2, 4, 8, ...
 */
export class HistoryStorage {
  #state: HistoryState = 'idle';
  #client: StorageClient | undefined;
  #opening: Promise<void> | undefined;
  #reported = false;
  #failure: StorageErrorCode | null = null;
  #database: JournalDatabase | undefined;
  #databaseUuid: string | undefined;
  #invalidJournalAnswers = 0;
  #retryTimer: unknown = undefined;
  #attempts = 0;
  #file: {path: string; backupsDirectory: string} | undefined;
  #target: RecordingDatabase | undefined;
  #closing = false;

  constructor(private readonly options: HistoryStorageOptions) {}

  get state(): HistoryState { return this.#state; }
  /** ET-015c (G10): the code that made the database unavailable (the first one, as logged); null before any failure. */
  get failureCode(): StorageErrorCode | null { return this.#failure; }
  /** The storage client while the database is open; undefined before the open finished, after a failure and after close. */
  get client(): StorageClient | undefined { return this.#state === 'open' ? this.#client : undefined; }
  /** ET-016 (J3): the open database's purpose and schema version, from its open summary; undefined while it is not open. */
  get database(): JournalDatabase | undefined { return this.#state === 'open' ? this.#database : undefined; }
  /** ET-016 PR-5: the open database's UUID from its open summary, for an export header; undefined while it is not open. */
  get databaseUuid(): string | undefined { return this.#state === 'open' ? this.#databaseUuid : undefined; }

  start(): void {
    if (this.#state !== 'idle') return;
    const target = this.options.target ?? {purpose: 'history'};
    this.#target = target;
    if (target.purpose !== 'history') this.options.log('RECORDING_TARGET', undefined, {purpose: target.purpose});
    try {
      if (!this.options.localAppData) throw new Error('LOCALAPPDATA is not set');
      const paths = dataPaths(this.options.localAppData);
      if (target.purpose === 'history') this.#file = {path: paths.database, backupsDirectory: paths.backups};
      // The name is checked again here, so no caller can leave the synthetic directory or reach the history file.
      else if (RECORDING_NAME_PATTERN.test(target.name)) this.#file = {path: path.join(paths.synthetic, `${target.name}.sqlite`), backupsDirectory: path.join(paths.synthetic, 'backups')};
      else throw new Error('Invalid recording target name');
    } catch { this.#unavailable('DATA_PATH_INVALID'); return; }
    this.#attemptOpen();
  }

  #attemptOpen(): void {
    if (this.#closing || this.#state === 'closed') return;
    let client: StorageClient;
    try {
      client = new StorageClient(this.options.createWorker(), {timers: this.options.timers, closeGraceMs: this.options.closeGraceMs ?? HISTORY_CLOSE_GRACE_MS, onFailure: error => this.#unavailable(error.code),
        // ET-016: a journal answer that broke the journal contract failed only that read; the database stays open.
        onJournalAnswerInvalid: ({command}) => {
          const count = ++this.#invalidJournalAnswers;
          if ((count & (count - 1)) === 0) this.options.log('JOURNAL_ANSWER_INVALID', undefined, {command, count});
        }});
    } catch { this.#unavailable('WORKER_FAILED'); return; }
    this.#client = client;
    this.#set('opening');
    const file = this.#file!;
    const target = this.#target!;
    this.#opening = client.open({...file, purpose: target.purpose, appVersion: this.options.appVersion ?? version}).then(result => {
      if (this.#state === 'closed') {
        void client.close();
        return;
      }
      if (!result.ok) {
        this.#unavailable(result.error.code);
        // The worker has nothing left to serve; end its thread now rather than at shutdown.
        void client.close();
        if (!this.#closing && isReopenRetryable(result.error)) {
          this.#scheduleRetry(result.error);
        }
        return;
      }
      const summary = result.value;
      this.#database = {purpose: summary.purpose, schemaVersion: summary.schemaVersion};
      this.#databaseUuid = summary.databaseUuid;
      this.#failure = null;
      this.#attempts = 0;
      this.#reported = false;
      if (this.#state === 'opening') this.#set('open');
      this.options.log('HISTORY_STORAGE_OPENED', undefined, {schemaVersion: summary.schemaVersion, created: summary.created, migratedFrom: summary.migratedFrom ?? null});
      // Leftovers of a backup that an earlier shutdown terminated; the count only, never a file name.
      if (summary.removedPartialBackups) this.options.log('HISTORY_BACKUP_PARTIALS_REMOVED', undefined, {count: summary.removedPartialBackups});
      if (this.#state === 'open') this.options.onOpened?.();
    });
  }

  #scheduleRetry(error: StorageError): void {
    if (this.#closing || this.#state === 'closed') return;
    const maxAttempts = this.options.maxReopenAttempts ?? MAX_HISTORY_REOPEN_ATTEMPTS;
    if (this.#attempts >= maxAttempts) {
      this.options.log('HISTORY_STORAGE_REOPEN_EXHAUSTED', undefined, {attempts: this.#attempts, code: error.code});
      return;
    }
    const backoffs = this.options.reopenBackoffMs ?? HISTORY_REOPEN_BACKOFF_MS;
    const delay = backoffs[Math.min(this.#attempts, backoffs.length - 1)];
    this.#attempts++;
    const timers = this.options.timers ?? systemTimers;
    this.#clearRetryTimer();
    this.#retryTimer = timers.setTimeout(() => {
      this.#retryTimer = undefined;
      this.#attemptOpen();
    }, delay);
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) {
      const timers = this.options.timers ?? systemTimers;
      timers.clearTimeout(this.#retryTimer);
      this.#retryTimer = undefined;
    }
  }

  /**
   * The `history-storage` shutdown step: waits for a running open, closes the database and waits for the worker thread
   * to end. Rejects when the worker had to be terminated before it answered the close, or had failed earlier in the
   * session, so the step reports a failed outcome. A worker that answered the close but whose thread was still ending
   * when the grace ran out is terminated and the close stays clean (StorageClient.close).
   */
  async close(graceMs?: number): Promise<void> {
    this.#closing = true;
    this.#clearRetryTimer();
    const client = this.#client;
    if (!client) { this.#set('closed'); return; }
    const effectiveGrace = this.options.closeGraceMs ?? graceMs;
    const {clean} = await client.close(effectiveGrace);
    await this.#opening;
    // Still open here only when the database opened and no failure followed.
    const opened = this.#state === 'open';
    this.#set('closed');
    if (!clean) throw new Error('History storage did not close cleanly');
    if (opened) this.options.log('HISTORY_STORAGE_CLOSED');
  }

  #set(state: HistoryState): void {
    if (state === this.#state) return;
    this.#state = state;
    this.options.onStateChange?.(state);
  }

  #unavailable(code: StorageErrorCode): void {
    this.#failure ??= code;
    if (this.#state !== 'closed') this.#set('unavailable');
    if (this.#reported) return;
    this.#reported = true;
    this.options.log('HISTORY_STORAGE_UNAVAILABLE', undefined, {code});
  }
}

/**
 * The trip recorder's storage over a HistoryStorage (ET-015a): each command goes to the client of the open database.
 * Before the open finished, after a failure or after close it answers STORAGE_CLOSED, which stops durable delivery like
 * any unavailable storage failure. The ingestion requests durable delivery only while the database is open (R10).
 */
export function recorderClient(storage: {readonly client: StorageClient | undefined}): TripRecorderClient {
  const closed = () => Promise.resolve({ok: false as const, error: storageError('STORAGE_CLOSED')});
  return {
    upsertSession: input => storage.client?.upsertSession(input) ?? closed(),
    committedThrough: session => storage.client?.committedThrough(session) ?? closed(),
    commitEvent: input => storage.client?.commitEvent(input) ?? closed(),
    commitGap: input => storage.client?.commitGap(input) ?? closed(),
    recordCompleteness: (session, interval, options) => storage.client?.recordCompleteness(session, interval, options) ?? closed(),
    listTrips: page => storage.client?.listTrips(page) ?? closed(),
    getEvent: (session, eventSeq) => storage.client?.getEvent(session, eventSeq) ?? closed(),
    listEvents: (session, page) => storage.client?.listEvents(session, page) ?? closed(),
    appendSamples: (session, rows, options) => storage.client?.appendSamples(session, rows, options) ?? closed(),
    openAttachedTrip: input => storage.client?.openAttachedTrip(input) ?? closed()
  };
}
