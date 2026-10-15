// In-process storage API (ET-013). It loads native better-sqlite3, so only the storage worker and the Electron-runtime
// storage suite may import it; Node-safe callers use ./api. Every method returns a Result and never throws for storage
// failures; error results carry fixed text and never a filesystem path. See docs/storage.md.
import {rmSync} from 'node:fs';
import type {
  CommitOptions, CommitResult, CompletenessInterval, EventRow, OpenSummary, Result, SampleInput, SampleRecord, SessionRecord, StorageInfo, TripEffect, TripRecord, Uint64
} from './api';
import {classifyError} from './errors';
import {restoreCopy} from './sqlite/backup';
import {checkPath, openConnection, type OpenOptions, type StorageConnection} from './sqlite/connection';
import * as reads from './sqlite/reads';
import * as writes from './sqlite/writes';

export * from './api';
export {MIGRATIONS, APPLICATION_ID, type Migration} from './sqlite/migrations';
export type {OpenOptions, OpenTestHooks} from './sqlite/connection';

function attempt<T>(body: () => T): Result<T> {
  try { return {ok: true, value: body()}; } catch (error) { return {ok: false, error: classifyError(error)}; }
}

/** One open database. Commands run synchronously, one at a time, on its single verified writer connection. */
export class Storage {
  constructor(private readonly connection: StorageConnection) {}
  get summary(): OpenSummary { return this.connection.summary; }
  get closed(): boolean { return this.connection.closed; }
  upsertSession(input: {message: unknown}) { return attempt(() => writes.upsertSession(this.connection, input)); }
  commitEvent(input: {message: unknown; effects?: TripEffect[]}, options?: CommitOptions): Result<CommitResult> { return attempt(() => writes.commitEvent(this.connection, input, options)); }
  commitGap(input: {message: unknown; effects?: TripEffect[]}, options?: CommitOptions): Result<CommitResult> { return attempt(() => writes.commitGap(this.connection, input, options)); }
  appendSamples(pluginSessionId: string, rows: SampleInput[]) { return attempt(() => writes.appendSamples(this.connection, pluginSessionId, rows)); }
  recordCompleteness(pluginSessionId: string, interval: CompletenessInterval): Result<void> { return attempt(() => writes.recordCompleteness(this.connection, pluginSessionId, interval)); }
  committedThrough(pluginSessionId: string): Result<Uint64> { return attempt(() => reads.committedThrough(this.connection, pluginSessionId)); }
  getSession(pluginSessionId: string): Result<SessionRecord> { return attempt(() => reads.getSession(this.connection, pluginSessionId)); }
  getEvent(pluginSessionId: string, eventSeq: Uint64): Result<EventRow | undefined> { return attempt(() => reads.getEvent(this.connection, pluginSessionId, eventSeq)); }
  listEvents(pluginSessionId: string, page?: {afterEventSeq?: Uint64; limit?: number}): Result<EventRow[]> { return attempt(() => reads.listEvents(this.connection, pluginSessionId, page)); }
  getTrip(tripUuid: string): Result<TripRecord | undefined> { return attempt(() => reads.getTrip(this.connection, tripUuid)); }
  listTrips(page?: {cursor?: string; limit?: number}) { return attempt(() => reads.listTrips(this.connection, page)); }
  listSamples(scope: {tripUuid: string} | {pluginSessionId: string}, page?: {afterId?: string; limit?: number}): Result<SampleRecord[]> { return attempt(() => reads.listSamples(this.connection, scope, page)); }
  storageInfo(): Result<StorageInfo> { return attempt(() => reads.storageInfo(this.connection)); }
  /** Closes the connection. SQLite checkpoints the WAL into the main file; further commands fail with STORAGE_CLOSED. */
  close(): Result<void> { return attempt(() => this.connection.close()); }
}

/** Opens, creates or migrates a database through the full durability sequence. */
export async function openStorage(options: OpenOptions): Promise<Result<Storage>> {
  try { return {ok: true, value: new Storage(await openConnection(options))}; } catch (error) { return {ok: false, error: classifyError(error)}; }
}

/**
 * Restores a verified pre-migration backup into a new database file, then opens it through the normal durability path,
 * which migrates it when it is older. The target path and the backup's purpose are checked before anything is written;
 * the target and its sidecar files must not exist. If the follow-up open fails, the restored file this call created is
 * removed again.
 */
export async function restoreBackup(manifestPath: string, options: OpenOptions): Promise<Result<Storage>> {
  try { checkPath(options.path, options.purpose); await restoreCopy(manifestPath, options.path, options.purpose); } catch (error) { return {ok: false, error: classifyError(error)}; }
  const opened = await openStorage(options);
  if (!opened.ok) for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(options.path + suffix, {force: true});
  return opened;
}
