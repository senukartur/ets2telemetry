import {existsSync} from 'node:fs';
import {Worker} from 'node:worker_threads';
import {version} from '../../../package.json';
import type {StorageErrorCode} from '../../../packages/storage/src/api';
import {StorageClient, workerHandle, type ClientTimers, type StorageWorkerHandle} from '../../../packages/storage/src/client';
import type {DiagnosticFacts} from './diagnostics';
import {processEntrypoint} from './entrypoints';
import {dataPaths} from './paths';

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
  /** Tests only. */
  timers?: ClientTimers;
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
 * HISTORY_STORAGE_UNAVAILABLE (once) and HISTORY_STORAGE_CLOSED. Nothing is recorded yet; ET-015a adds ingestion.
 */
export class HistoryStorage {
  #state: HistoryState = 'idle';
  #client: StorageClient | undefined;
  #opening: Promise<void> | undefined;
  #reported = false;

  constructor(private readonly options: HistoryStorageOptions) {}

  get state(): HistoryState { return this.#state; }

  start(): void {
    if (this.#state !== 'idle') return;
    let paths: ReturnType<typeof dataPaths>;
    try {
      if (!this.options.localAppData) throw new Error('LOCALAPPDATA is not set');
      paths = dataPaths(this.options.localAppData);
    } catch { this.#unavailable('DATA_PATH_INVALID'); return; }
    let client: StorageClient;
    try {
      client = new StorageClient(this.options.createWorker(), {timers: this.options.timers, closeGraceMs: HISTORY_CLOSE_GRACE_MS, onFailure: error => this.#unavailable(error.code)});
    } catch { this.#unavailable('WORKER_FAILED'); return; }
    this.#client = client;
    this.#state = 'opening';
    this.#opening = client.open({path: paths.database, purpose: 'history', backupsDirectory: paths.backups, appVersion: this.options.appVersion ?? version}).then(result => {
      if (!result.ok) {
        this.#unavailable(result.error.code);
        // The worker has nothing left to serve; end its thread now rather than at shutdown.
        void client.close();
        return;
      }
      if (this.#state === 'opening') this.#state = 'open';
      const summary = result.value;
      this.options.log('HISTORY_STORAGE_OPENED', undefined, {schemaVersion: summary.schemaVersion, created: summary.created, migratedFrom: summary.migratedFrom ?? null});
    });
  }

  /**
   * The `history-storage` shutdown step: waits for a running open, closes the database and waits for the worker thread
   * to end. Rejects when the worker had to be terminated, so the step reports a failed outcome.
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
