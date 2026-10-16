import {existsSync} from 'node:fs';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {version} from '../../../package.json';
import type {StorageErrorCode} from '../../../packages/storage/src/api';
import {StorageClient, workerHandle, type ClientTimers, type StorageWorkerHandle} from '../../../packages/storage/src/client';
import {storageError} from '../../../packages/storage/src/errors';
import type {DiagnosticFacts} from './diagnostics';
import {processEntrypoint} from './entrypoints';
import {dataPaths} from './paths';
import {RECORDING_NAME_PATTERN, type RecordingDatabase} from './recording-policy';
import type {TripRecorderClient} from './trip-recorder';

/** Budget of the `history-storage` step in the service's `storage` shutdown phase. */
export const HISTORY_CLOSE_BUDGET_MS = 1000;
/** The orderly close gets this long before the worker is terminated, so the step still ends inside its budget. */
export const HISTORY_CLOSE_GRACE_MS = 800;

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
  /** Tests only. */
  timers?: ClientTimers;
  /** Tests only: the real-worker storage suite bounds a close by its own grace (tests/storage/helpers.ts). */
  closeGraceMs?: number;
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
 * instead: it logs RECORDING_TARGET {purpose} first and then the same codes. `client` serves the trip recorder.
 */
export class HistoryStorage {
  #state: HistoryState = 'idle';
  #client: StorageClient | undefined;
  #opening: Promise<void> | undefined;
  #reported = false;

  constructor(private readonly options: HistoryStorageOptions) {}

  get state(): HistoryState { return this.#state; }
  /** The storage client while the database is open; undefined before the open finished, after a failure and after close. */
  get client(): StorageClient | undefined { return this.#state === 'open' ? this.#client : undefined; }

  start(): void {
    if (this.#state !== 'idle') return;
    const target = this.options.target ?? {purpose: 'history'};
    if (target.purpose !== 'history') this.options.log('RECORDING_TARGET', undefined, {purpose: target.purpose});
    let file: {path: string; backupsDirectory: string};
    try {
      if (!this.options.localAppData) throw new Error('LOCALAPPDATA is not set');
      const paths = dataPaths(this.options.localAppData);
      if (target.purpose === 'history') file = {path: paths.database, backupsDirectory: paths.backups};
      // The name is checked again here, so no caller can leave the synthetic directory or reach the history file.
      else if (RECORDING_NAME_PATTERN.test(target.name)) file = {path: path.join(paths.synthetic, `${target.name}.sqlite`), backupsDirectory: path.join(paths.synthetic, 'backups')};
      else throw new Error('Invalid recording target name');
    } catch { this.#unavailable('DATA_PATH_INVALID'); return; }
    let client: StorageClient;
    try {
      client = new StorageClient(this.options.createWorker(), {timers: this.options.timers, closeGraceMs: this.options.closeGraceMs ?? HISTORY_CLOSE_GRACE_MS, onFailure: error => this.#unavailable(error.code)});
    } catch { this.#unavailable('WORKER_FAILED'); return; }
    this.#client = client;
    this.#state = 'opening';
    this.#opening = client.open({...file, purpose: target.purpose, appVersion: this.options.appVersion ?? version}).then(result => {
      if (!result.ok) {
        this.#unavailable(result.error.code);
        // The worker has nothing left to serve; end its thread now rather than at shutdown.
        void client.close();
        return;
      }
      if (this.#state === 'opening') this.#state = 'open';
      const summary = result.value;
      this.options.log('HISTORY_STORAGE_OPENED', undefined, {schemaVersion: summary.schemaVersion, created: summary.created, migratedFrom: summary.migratedFrom ?? null});
      // Leftovers of a backup that an earlier shutdown terminated; the count only, never a file name.
      if (summary.removedPartialBackups) this.options.log('HISTORY_BACKUP_PARTIALS_REMOVED', undefined, {count: summary.removedPartialBackups});
      if (this.#state === 'open') this.options.onOpened?.();
    });
  }

  /**
   * The `history-storage` shutdown step: waits for a running open, closes the database and waits for the worker thread
   * to end. Rejects when the worker had to be terminated or had failed earlier in the session, so the step reports a
   * failed outcome.
   */
  async close(): Promise<void> {
    const client = this.#client;
    if (!client) { this.#state = 'closed'; return; }
    const {clean} = await client.close();
    await this.#opening;
    // Still open here only when the database opened and no failure followed.
    const opened = this.#state === 'open';
    this.#state = 'closed';
    if (!clean) throw new Error('History storage did not close cleanly');
    if (opened) this.options.log('HISTORY_STORAGE_CLOSED');
  }

  #unavailable(code: StorageErrorCode): void {
    if (this.#state !== 'closed') this.#state = 'unavailable';
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
    listEvents: (session, page) => storage.client?.listEvents(session, page) ?? closed()
  };
}
