// Journal queries in the telemetry service (ET-016, J2, J4, J11). Main sends `{type: 'journal', id, query}` on the
// service's parent port; the service answers `{type: 'journal', id, result}` with a value or a fixed J11 code. The reads
// go through the client of the database the service opened (J2), so they share the recorder's single storage command
// lane: this module runs at most one journal read at a time, and only while the database is open, so at most one journal
// command is ever in the storage queue and a journal read never waits for, or delays, more than one recorder command.
// Node-safe: it never loads native SQLite. See docs/telemetry-service-v1.md#journal-queries-et-016.
import type {JournalCallResult, JournalDatabase, JournalSamplePage} from '../../../packages/contracts/src';
import type {JournalResult, Result, SampleRecord, StorageError, StorageErrorCode} from '../../../packages/storage/src/api';
import type {StorageClient} from '../../../packages/storage/src/client';
import type {DiagnosticFacts} from './diagnostics';
import type {HistoryState} from './history-storage';
import {parseJournalQuery, refusal, type JournalQuery} from './journal-contract';

/** The reads a journal query uses; StorageClient provides them. */
export type JournalClient = Pick<StorageClient, 'journalTrips' | 'journalTrip' | 'journalEvents' | 'journalIntervals' | 'listSamples'>;
/** The service's database as the journal sees it; HistoryStorage provides it. */
export interface JournalHistory {
  readonly state: HistoryState;
  readonly failureCode: StorageErrorCode | null;
  /** Defined only while the database is open. */
  readonly client: JournalClient | undefined;
  /** The open database's purpose and schema version; defined only while it is open. */
  readonly database: JournalDatabase | undefined;
  /** ET-016 PR-5: the open database's UUID from its open summary, for an export header; defined only while it is open. */
  readonly databaseUuid: string | undefined;
}
export interface JournalServiceOptions {
  history: JournalHistory;
  /** True once the service's orderly stop began. */
  stopping: () => boolean;
  /** Fixed codes and facts only. */
  log: (event: string, detail?: unknown, facts?: DiagnosticFacts) => void;
}
/** A journal reply on the parent port. */
export interface JournalReplyMessage {type: 'journal'; id: number; result: JournalCallResult<unknown>}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** The J11 answer of a database that is not open (J4): its state, and the storage code that made it unavailable. */
function notOpen(history: JournalHistory): JournalCallResult<never> {
  switch (history.state) {
  case 'idle': case 'opening': return refusal('DATABASE_OPENING');
  case 'unavailable': return {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: history.failureCode ?? 'INTERNAL'};
  default: return refusal('SERVICE_UNAVAILABLE');
  }
}

export class JournalService {
  #busy = false;
  #rejected = 0;

  constructor(private readonly options: JournalServiceOptions) {}

  /**
   * Answers one parent-port message `{type: 'journal', id, query}` through `send`. A message that is not exactly that
   * shape is logged as JOURNAL_REQUEST_REJECTED {count} at counts 1, 2, 4, 8, ...; with a valid id it is answered FAILED.
   * `send` failing (a closed port) is ignored: main no longer waits for this answer.
   */
  receive(message: unknown, send: (reply: JournalReplyMessage) => void): void {
    const o = isRecord(message) ? message : {};
    const id = Number.isSafeInteger(o.id) && (o.id as number) >= 1 ? o.id as number : undefined;
    const keys = Object.keys(o);
    const query = keys.length === 3 && o.type === 'journal' && Object.hasOwn(o, 'query') ? parseJournalQuery(o.query) : undefined;
    const reply = (result: JournalCallResult<unknown>) => { if (id !== undefined) { try { send({type: 'journal', id, result}); } catch { /* main stopped waiting */ } } };
    if (id === undefined || !query) {
      const count = ++this.#rejected;
      if ((count & (count - 1)) === 0) this.options.log('JOURNAL_REQUEST_REJECTED', undefined, {count});
      reply(refusal('FAILED'));
      return;
    }
    void this.query(query).then(reply);
  }

  /**
   * Runs one journal read (J4). Refused while the service stops, while the database is not open (J11:
   * DATABASE_OPENING, DATABASE_UNAVAILABLE with its storage code, SERVICE_UNAVAILABLE once closed) and while another
   * journal read is in flight (BUSY), so the storage queue never holds a second journal command.
   */
  async query(query: JournalQuery): Promise<JournalCallResult<unknown>> {
    const {history} = this.options;
    if (this.options.stopping()) return refusal('SERVICE_UNAVAILABLE');
    if (history.state !== 'open') return notOpen(history);
    const client = history.client, database = history.database;
    if (!client || !database) return refusal('SERVICE_UNAVAILABLE');
    // An export header (ET-016 PR-5) comes from the open summary: no storage command joins the queue for it.
    if (query.kind === 'database') {
      const databaseUuid = history.databaseUuid;
      return databaseUuid === undefined ? refusal('SERVICE_UNAVAILABLE')
        : {ok: true, value: {database: {purpose: database.purpose, schemaVersion: database.schemaVersion}, databaseUuid}};
    }
    if (this.#busy) return refusal('BUSY');
    this.#busy = true;
    try {
      return this.#answer(await this.#read(client, database, query));
    } catch {
      // The client resolves every command; a throw is a defect, answered with the fixed code only.
      return refusal('FAILED');
    } finally { this.#busy = false; }
  }

  #read(client: JournalClient, database: JournalDatabase, query: Exclude<JournalQuery, {kind: 'database'}>): Promise<JournalResult<unknown>> {
    switch (query.kind) {
    case 'trips': return client.journalTrips(query.query);
    case 'trip': return client.journalTrip(query.tripUuid);
    case 'events': return client.journalEvents(query.tripUuid, query.page);
    case 'intervals': return client.journalIntervals(query.tripUuid, query.page);
    case 'samples': return client.listSamples({tripUuid: query.tripUuid}, {...(query.page.cursor === undefined ? {} : {afterId: query.page.cursor}), limit: query.page.limit})
      .then(result => samplePage(result, database, query.page.limit));
    }
  }

  /** Maps a storage result to J11. The value is forwarded as read; main checks it against the contract. */
  #answer(result: JournalResult<unknown>): JournalCallResult<unknown> {
    if (result.ok) return {ok: true, value: result.value};
    const code = result.error.code;
    switch (code) {
    case 'UNKNOWN_TRIP': return refusal('NOT_FOUND');
    case 'STORAGE_BUSY': return refusal('BUSY');
    // The client failed or closed: the database is no longer readable in this service. A storage TIMEOUT is one of these:
    // the client produces it only when a command missed its deadline, and then fails itself closed, so the database stays
    // unavailable and recording stops until the service restarts; it is never a retryable TIMEOUT (PR #97 review).
    case 'TIMEOUT': case 'WORKER_FAILED': case 'STORAGE_CLOSED':
      return this.options.stopping() ? refusal('SERVICE_UNAVAILABLE')
        : {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: this.options.history.failureCode ?? code};
    // JOURNAL_ANSWER_INVALID (logged by the history storage) and every other storage error.
    default: return refusal('FAILED');
    }
  }
}

/** A trip's sample page with the database it was read from and the next cursor when the page is full. */
function samplePage(result: Result<SampleRecord[]>, database: JournalDatabase, limit: number): Result<JournalSamplePage> | {ok: false; error: StorageError} {
  if (!result.ok) return result;
  const samples = result.value;
  return {ok: true, value: {database: {purpose: database.purpose, schemaVersion: database.schemaVersion}, samples, nextCursor: samples.length === limit ? samples.at(-1)!.id : null}};
}
