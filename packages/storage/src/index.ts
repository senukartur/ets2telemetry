// In-process storage API (ET-013). It loads native better-sqlite3, so only the storage worker and the Electron-runtime
// storage suite may import it; Node-safe callers use ./api. Every method returns a Result and never throws for storage
// failures; error results carry fixed text and never a filesystem path. See docs/storage.md.
import {rmSync} from 'node:fs';
import type {
  AttachInput, AttachResult, CommitOptions, CommitResult, CompletenessInterval, CompletenessOptions, EventRow, JournalEventPage, JournalIntervalPage, JournalPageQuery, JournalTripDetail, JournalTripPage,
  JournalTripsQuery, OpenSummary, Result, SampleAppendOptions, SampleAppendResult, SampleInput, SampleRecord, SessionRecord, StorageInfo, TripEffect, TripList, TripPage, TripRecord, Uint64
} from './api';
import {classifyError} from './errors';
import {restoreCopy} from './sqlite/backup';
import {checkPath, openConnection, type OpenOptions, type StorageConnection} from './sqlite/connection';
import * as journal from './sqlite/journal';
import * as reads from './sqlite/reads';
import * as writes from './sqlite/writes';

export * from './api';
export {MIGRATIONS, APPLICATION_ID, type Migration} from './sqlite/migrations';
export {JOURNAL_QUERIES} from './sqlite/journal';
export type {OpenOptions, OpenTestHooks} from './sqlite/connection';
export {REOPEN_RETRYABLE_CODES, isReopenRetryable} from './errors';

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
  appendSamples(pluginSessionId: string, rows: SampleInput[], options?: SampleAppendOptions, commitOptions?: CommitOptions): Result<SampleAppendResult> {
    return attempt(() => writes.appendSamples(this.connection, pluginSessionId, rows, options, commitOptions));
  }
  recordCompleteness(pluginSessionId: string, interval: CompletenessInterval, options?: CompletenessOptions): Result<void> {
    return attempt(() => writes.recordCompleteness(this.connection, pluginSessionId, interval, options));
  }
  /** ET-016 PR-7 (J9): opens a trip from a checkpoint job; see AttachInput. */
  openAttachedTrip(input: AttachInput): Result<AttachResult> { return attempt(() => writes.openAttachedTrip(this.connection, input)); }
  committedThrough(pluginSessionId: string): Result<Uint64> { return attempt(() => reads.committedThrough(this.connection, pluginSessionId)); }
  getSession(pluginSessionId: string): Result<SessionRecord> { return attempt(() => reads.getSession(this.connection, pluginSessionId)); }
  getEvent(pluginSessionId: string, eventSeq: Uint64): Result<EventRow | undefined> { return attempt(() => reads.getEvent(this.connection, pluginSessionId, eventSeq)); }
  listEvents(pluginSessionId: string, page?: {afterEventSeq?: Uint64; limit?: number}): Result<EventRow[]> { return attempt(() => reads.listEvents(this.connection, pluginSessionId, page)); }
  getTrip(tripUuid: string): Result<TripRecord | undefined> { return attempt(() => reads.getTrip(this.connection, tripUuid)); }
  listTrips(page?: TripPage): Result<TripList> { return attempt(() => reads.listTrips(this.connection, page)); }
  listSamples(scope: {tripUuid: string} | {pluginSessionId: string}, page?: {afterId?: string; limit?: number}): Result<SampleRecord[]> { return attempt(() => reads.listSamples(this.connection, scope, page)); }
  /** Journal reads (ET-016 PR-2, J5): bounded pages for the trip journal and its export; see sqlite/journal.ts. */
  journalTrips(query?: JournalTripsQuery): Result<JournalTripPage> { return attempt(() => journal.journalTrips(this.connection, query)); }
  journalTrip(tripUuid: string): Result<JournalTripDetail> { return attempt(() => journal.journalTrip(this.connection, tripUuid)); }
  journalEvents(tripUuid: string, page: JournalPageQuery): Result<JournalEventPage> { return attempt(() => journal.journalEvents(this.connection, tripUuid, page)); }
  journalIntervals(tripUuid: string, page: JournalPageQuery): Result<JournalIntervalPage> { return attempt(() => journal.journalIntervals(this.connection, tripUuid, page)); }
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
 * removed again on a best-effort basis: a removal that fails (for example EBUSY from a scanner) is ignored, and the
 * open's error is still returned as a Result.
 */
export async function restoreBackup(manifestPath: string, options: OpenOptions): Promise<Result<Storage>> {
  try { checkPath(options.path, options.purpose); await restoreCopy(manifestPath, options.path, options.purpose); } catch (error) { return {ok: false, error: classifyError(error)}; }
  const opened = await openStorage(options);
  if (!opened.ok) {
    const remove = options.testHooks?.removeFile ?? ((file: string) => rmSync(file, {force: true}));
    for (const suffix of ['', '-wal', '-shm', '-journal']) { try { remove(options.path + suffix); } catch { /* best effort; the open error is reported */ } }
  }
  return opened;
}
