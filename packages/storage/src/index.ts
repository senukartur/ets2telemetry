import {recordTrailerBaseline} from './sqlite/trailer-baselines';
import type {TrailerBaselineInput} from './api';
import type {UploadSyncCommands} from './upload-sync';
import * as sync from './sqlite/upload-sync';
import * as queue from './sqlite/upload-queue';
import type {ProfileObservation} from '../../telemetry-core/src/trips/continuation';
import type {HardModeObservation} from '../../contracts/src/hard-mode';
// In-process storage API (ET-013). It loads native better-sqlite3, so only the storage worker and the Electron-runtime
// storage suite may import it; Node-safe callers use ./api. Every method returns a Result and never throws for storage
// failures; error results carry fixed text and never a filesystem path. See docs/storage.md.
import {rmSync} from 'node:fs';
import type {
  AttachInput, AttachResult, CommitOptions, CommitResult, CompletenessInterval, CompletenessOptions, DeleteTripOptions, EventRow, JournalEventPage, JournalIntervalPage, JournalPageQuery, JournalTripDetail, JournalTripPage,
  JournalTripsQuery, OpenSummary, Result, SampleAppendOptions, SampleAppendResult, SampleInput, SampleRecord, SessionRecord, StorageInfo, TripEffect, TripList, TripPage, TripRecord, Uint64
} from './api';
import {classifyError} from './errors';
import {restoreCopy} from './sqlite/backup';
import {checkPath, openConnection, type OpenOptions, type StorageConnection} from './sqlite/connection';
import * as journal from './sqlite/journal';
import * as reads from './sqlite/reads';
import * as writes from './sqlite/writes';
import * as upload from './sqlite/upload-projection';
import type {UploadProjectionBegin, UploadProjectionPageQuery} from './upload-projection';

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
  recordTrailerBaseline(input: TrailerBaselineInput): Result<void> {return attempt(() => recordTrailerBaseline(this.connection,input));}
  commitEvent(input: {message: unknown; effects?: TripEffect[]; hardMode?: HardModeObservation; hardModeFresh?: boolean; hardModeLoss?: HardModeObservation; profile?: ProfileObservation}, options?: CommitOptions): Result<CommitResult> { return attempt(() => writes.commitEvent(this.connection, input, options)); }
  commitGap(input: {message: unknown; effects?: TripEffect[]; hardMode?: HardModeObservation; hardModeFresh?: boolean; hardModeLoss?: HardModeObservation; profile?: ProfileObservation}, options?: CommitOptions): Result<CommitResult> { return attempt(() => writes.commitGap(this.connection, input, options)); }
  appendSamples(pluginSessionId: string, rows: SampleInput[], options?: SampleAppendOptions, commitOptions?: CommitOptions): Result<SampleAppendResult> {
    return attempt(() => writes.appendSamples(this.connection, pluginSessionId, rows, options, commitOptions));
  }
  recordCompleteness(pluginSessionId: string, interval: CompletenessInterval, options?: CompletenessOptions): Result<void> {
    return attempt(() => writes.recordCompleteness(this.connection, pluginSessionId, interval, options));
  }
  /** ET-016 PR-7 (J9): opens a trip from a checkpoint job; see AttachInput. */
  openAttachedTrip(input: AttachInput, options?:CommitOptions): Result<AttachResult> { return attempt(() => writes.openAttachedTrip(this.connection, input,options)); }
  observeHardMode(game: 'ets2' | 'ats', observation: HardModeObservation, fresh = false): Result<void> {return attempt(() => writes.observeHardMode(this.connection, game, observation, fresh));}
  committedThrough(pluginSessionId: string): Result<Uint64> { return attempt(() => reads.committedThrough(this.connection, pluginSessionId)); }
  getSession(pluginSessionId: string): Result<SessionRecord> { return attempt(() => reads.getSession(this.connection, pluginSessionId)); }
  getEvent(pluginSessionId: string, eventSeq: Uint64): Result<EventRow | undefined> { return attempt(() => reads.getEvent(this.connection, pluginSessionId, eventSeq)); }
  listEvents(pluginSessionId: string, page?: {afterEventSeq?: Uint64; limit?: number}): Result<EventRow[]> { return attempt(() => reads.listEvents(this.connection, pluginSessionId, page)); }
  getTrip(tripUuid: string): Result<TripRecord | undefined> { return attempt(() => reads.getTrip(this.connection, tripUuid)); }
  listTrips(page?: TripPage): Result<TripList> { return attempt(() => reads.listTrips(this.connection, page)); }
  deleteTrip(tripUuid: string, options?: DeleteTripOptions): Result<void> { return attempt(() => writes.deleteTrip(this.connection, tripUuid, options)); }
  listSamples(scope: {tripUuid: string} | {pluginSessionId: string}, page?: {afterId?: string; limit?: number; includeExcluded?: boolean}): Result<SampleRecord[]> { return attempt(() => reads.listSamples(this.connection, scope, page)); }
  /** Journal reads (ET-016 PR-2, J5): bounded pages for the trip journal and its export; see sqlite/journal.ts. */
  journalTrips(query?: JournalTripsQuery): Result<JournalTripPage> { return attempt(() => journal.journalTrips(this.connection, query)); }
  journalTrip(tripUuid: string): Result<JournalTripDetail> { return attempt(() => journal.journalTrip(this.connection, tripUuid)); }
  journalEvents(tripUuid: string, page: JournalPageQuery): Result<JournalEventPage> { return attempt(() => journal.journalEvents(this.connection, tripUuid, page)); }
  journalIntervals(tripUuid: string, page: JournalPageQuery): Result<JournalIntervalPage> { return attempt(() => journal.journalIntervals(this.connection, tripUuid, page)); }
  storageInfo(): Result<StorageInfo> { return attempt(() => reads.storageInfo(this.connection)); }
  beginUploadProjection(input: UploadProjectionBegin) {return attempt(() => upload.beginUploadProjection(this.connection,input));}
  advanceUploadProjection(pinId: string, options?: CommitOptions) {return attempt(() => upload.advanceUploadProjection(this.connection,pinId,options?.testHooks));}
  getUploadProjectionPreparation(pinId: string) {return attempt(() => upload.getUploadProjectionPreparation(this.connection,pinId));}
  releaseUploadProjection(pinId: string, options?: CommitOptions) {return attempt(() => upload.releaseUploadProjection(this.connection,pinId,options?.testHooks));}
  readUploadProjectionPage(query: UploadProjectionPageQuery) { return attempt(() => upload.readUploadProjectionPage(this.connection, query)); }
  readRetainedUploadMaterializations() {return attempt(()=>sync.readRetainedUploadMaterializations(this.connection));}
  getUploadConfiguration() {return attempt(()=>sync.getUploadConfiguration(this.connection));}
  pageUploadScanRuns(input:import('./upload-sync').UploadSyncCommands['pageUploadScanRuns']['args']['input']) {return attempt(()=>sync.pageUploadScanRuns(this.connection,input));}
  pageUploadSources(input:import('./upload-sync').UploadSyncCommands['pageUploadSources']['args']['input']) {return attempt(()=>sync.pageUploadSources(this.connection,input));}
  getUploadSchedulingHints(input:{registrationId:string}) {return attempt(()=>sync.getUploadSchedulingHints(this.connection,input));}
  ensureUploadInstallation(options?:CommitOptions) {return attempt(()=>sync.ensureUploadInstallation(this.connection,options));}
  recordUploadRegistration(input:UploadSyncCommands['recordUploadRegistration']['args']['input'],options?:CommitOptions) {return attempt(()=>sync.recordUploadRegistration(this.connection,input,options));}
  confirmUploadOwner(input:UploadSyncCommands['confirmUploadOwner']['args']['input'],options?:CommitOptions) {return attempt(()=>sync.confirmUploadOwner(this.connection,input,options));}
  disconnectUploadOwner(input:UploadSyncCommands['disconnectUploadOwner']['args']['input'],options?:CommitOptions) {return attempt(()=>sync.disconnectUploadOwner(this.connection,input,options));}
  getUploadStoreStatus(input:UploadSyncCommands['getUploadStoreStatus']['args']['input']) {return attempt(()=>sync.getUploadStoreStatus(this.connection,input));}
  advanceUploadScan(input:UploadSyncCommands['advanceUploadScan']['args']['input'],options?:CommitOptions) {return attempt(()=>sync.advanceUploadScan(this.connection,input,options));}
  pageUploadDiscovery(input:UploadSyncCommands['pageUploadDiscovery']['args']['input'],options?:CommitOptions) {return attempt(()=>sync.pageUploadDiscovery(this.connection,input,options));}
  beginUploadMaterialization(input:UploadSyncCommands['beginUploadMaterialization']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.beginUploadMaterialization(this.connection,input,options));}
  advanceUploadMaterialization(input:UploadSyncCommands['advanceUploadMaterialization']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.advanceUploadMaterialization(this.connection,input,options));}
  freezeUploadMaterialization(input:UploadSyncCommands['freezeUploadMaterialization']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.freezeUploadMaterialization(this.connection,input,options));}
  releaseUploadMaterialization(input:UploadSyncCommands['releaseUploadMaterialization']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.releaseUploadMaterialization(this.connection,input,options));}
  claimUploadAttempt(input:UploadSyncCommands['claimUploadAttempt']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.claimUploadAttempt(this.connection,input,options));}
  recordUploadAttemptOutcome(input:UploadSyncCommands['recordUploadAttemptOutcome']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.recordUploadAttemptOutcome(this.connection,input,options));}
  recoverUploadAttempt(input:UploadSyncCommands['recoverUploadAttempt']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.recoverUploadAttempt(this.connection,input,options));}
  commitUploadReceipt(input:UploadSyncCommands['commitUploadReceipt']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.commitUploadReceipt(this.connection,input,options));}
  reclaimUploadPayloads(input:UploadSyncCommands['reclaimUploadPayloads']['args']['input'],options?:CommitOptions) {return attempt(()=>queue.reclaimUploadPayloads(this.connection,input,options));}
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
