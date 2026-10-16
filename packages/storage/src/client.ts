// The telemetry service's handle on the storage worker (ET-013). Node-safe: it never loads native SQLite; the worker
// owns the one connection. Commands are sent one at a time with monotonic request ids, each bounded by a deadline.
// A worker failure, a missed deadline or a malformed response fails the client closed: the command in flight and every
// queued command get an error, later commands fail at once, and no success is reported afterwards. See docs/storage.md.
import type {Worker} from 'node:worker_threads';
import type {
  CommitResult, CompletenessInterval, CompletenessOptions, EventRow, JournalEventPage, JournalResult, JournalIntervalPage, JournalPageQuery, JournalTripDetail, JournalTripPage, JournalTripsQuery,
  OpenSummary, Result, SampleAppendOptions, SampleAppendResult, SampleInput, SampleRecord, SessionRecord, StorageError, StorageErrorCode, StorageInfo, TripEffect, TripList,
  TripPage, TripRecord, Uint64
} from './api';
import {storageError} from './errors';
import {parseResponse, type CommandName, type CommandValue, type JournalCommandName, type StorageCommand, type StorageRequest, type WorkerOpenOptions} from './worker/protocol';

/** Deadline of one command after it was sent to the worker. */
export const COMMAND_DEADLINE_MS = 10_000;
/** Deadline of `open`, which can include a verified pre-migration backup and the migration of a large database. */
export const OPEN_DEADLINE_MS = 120_000;
/** Commands waiting behind the one in flight; one more is refused with STORAGE_BUSY. */
export const MAX_QUEUED_COMMANDS = 64;
/** Default wait for an orderly close (in-flight command, close, thread exit) before the worker is terminated. */
export const CLOSE_GRACE_MS = 2_000;

/** The worker as the client sees it; `workerHandle` adapts a worker_threads Worker. */
export interface StorageWorkerHandle {
  postMessage(message: StorageRequest): void;
  onMessage(listener: (message: unknown) => void): void;
  onError(listener: (error: unknown) => void): void;
  onExit(listener: (code: number) => void): void;
  terminate(): Promise<unknown>;
}
export interface ClientTimers {setTimeout(callback: () => void, milliseconds: number): unknown; clearTimeout(handle: unknown): void}
export interface StorageClientOptions {
  timers?: ClientTimers; commandDeadlineMs?: number; openDeadlineMs?: number; closeGraceMs?: number; maxQueued?: number;
  /** Called once when the worker fails or misses a deadline, with the error the command in flight received. */
  onFailure?: (error: StorageError) => void;
  /**
   * Called when a journal answer broke the journal contract (ET-016): that command got JOURNAL_ANSWER_INVALID and the
   * client keeps running. The fact is the command name only; the owner logs it as a fixed code.
   */
  onJournalAnswerInvalid?: (facts: {command: JournalCommandName}) => void;
}
export type ClientState = 'running' | 'closing' | 'closed' | 'failed';

const systemTimers: ClientTimers = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function workerHandle(worker: Worker): StorageWorkerHandle {
  return {
    postMessage: message => worker.postMessage(message),
    onMessage: listener => { worker.on('message', listener); },
    onError: listener => { worker.on('error', listener); },
    onExit: listener => { worker.on('exit', listener); },
    terminate: () => worker.terminate()
  };
}

interface Pending {command: StorageCommand; resolve: (result: Result<unknown> | JournalResult<unknown>) => void}
interface InFlight extends Pending {id: number; timer: unknown}
/** Whether an argument is an object whose fields can be copied; anything else is forwarded for the parser to refuse. */
const isObject = (value: unknown): value is object => typeof value === 'object' && value !== null;
const failure = (code: StorageErrorCode): {ok: false; error: StorageError} => ({ok: false, error: storageError(code)});

export class StorageClient {
  #state: ClientState = 'running';
  #nextId = 1;
  #inFlight: InFlight | undefined;
  readonly #queue: Pending[] = [];
  #exited = false;
  #close: Promise<{clean: boolean}> | undefined;
  #finishClose: ((clean: boolean) => void) | undefined;
  #closeAcknowledged = false;
  #closeTimer: unknown;
  readonly #timers: ClientTimers;
  readonly #options: Required<Omit<StorageClientOptions, 'timers' | 'onFailure' | 'onJournalAnswerInvalid'>>;

  constructor(private readonly worker: StorageWorkerHandle, private readonly settings: StorageClientOptions = {}) {
    this.#timers = settings.timers ?? systemTimers;
    this.#options = {commandDeadlineMs: settings.commandDeadlineMs ?? COMMAND_DEADLINE_MS, openDeadlineMs: settings.openDeadlineMs ?? OPEN_DEADLINE_MS,
      closeGraceMs: settings.closeGraceMs ?? CLOSE_GRACE_MS, maxQueued: settings.maxQueued ?? MAX_QUEUED_COMMANDS};
    worker.onMessage(message => this.#receive(message));
    worker.onError(() => this.#fail('WORKER_FAILED'));
    worker.onExit(code => this.#exit(code));
  }

  get state(): ClientState { return this.#state; }

  open(options: WorkerOpenOptions): Promise<Result<OpenSummary>> {
    return this.#request({name: 'open', options: {path: options.path, purpose: options.purpose, backupsDirectory: options.backupsDirectory, appVersion: options.appVersion}});
  }
  upsertSession(input: {message: unknown}) { return this.#request({name: 'upsertSession', input}); }
  commitEvent(input: {message: unknown; effects?: TripEffect[]}): Promise<Result<CommitResult>> { return this.#request({name: 'commitEvent', input}); }
  commitGap(input: {message: unknown; effects?: TripEffect[]}): Promise<Result<CommitResult>> { return this.#request({name: 'commitGap', input}); }
  /**
   * Only `uniqueSeconds` of the options crosses the worker boundary (ET-015b). A value that is not an object is forwarded
   * as given, so the worker's request parser refuses it with INVALID_INPUT instead of the client throwing.
   */
  appendSamples(pluginSessionId: string, rows: SampleInput[], options?: SampleAppendOptions): Promise<Result<SampleAppendResult>> {
    if (options === undefined) return this.#request({name: 'appendSamples', pluginSessionId, rows});
    return this.#request({name: 'appendSamples', pluginSessionId, rows, options: isObject(options) ? {uniqueSeconds: options.uniqueSeconds} : options});
  }
  /**
   * Only `ifAbsent` of the options crosses the worker boundary. A value that is not an object is forwarded as given, so
   * the worker's request parser refuses it with INVALID_INPUT instead of the client throwing.
   */
  recordCompleteness(pluginSessionId: string, interval: CompletenessInterval, options?: CompletenessOptions): Promise<Result<undefined>> {
    if (options === undefined) return this.#request({name: 'recordCompleteness', pluginSessionId, interval});
    return this.#request({name: 'recordCompleteness', pluginSessionId, interval, options: isObject(options) ? {ifAbsent: options.ifAbsent} : options});
  }
  committedThrough(pluginSessionId: string): Promise<Result<Uint64>> { return this.#request({name: 'committedThrough', pluginSessionId}); }
  getSession(pluginSessionId: string): Promise<Result<SessionRecord>> { return this.#request({name: 'getSession', pluginSessionId}); }
  getEvent(pluginSessionId: string, eventSeq: Uint64): Promise<Result<EventRow | undefined>> { return this.#request({name: 'getEvent', pluginSessionId, eventSeq}); }
  listEvents(pluginSessionId: string, page?: {afterEventSeq?: Uint64; limit?: number}): Promise<Result<EventRow[]>> { return this.#request({name: 'listEvents', pluginSessionId, page}); }
  getTrip(tripUuid: string): Promise<Result<TripRecord | undefined>> { return this.#request({name: 'getTrip', tripUuid}); }
  /**
   * The page is copied field by field: only the cursor, limit and the `game` and `outcome` filter cross the boundary.
   * A page that is not an object is forwarded as given, so the worker's request parser refuses it with INVALID_INPUT.
   */
  listTrips(page?: TripPage): Promise<Result<TripList>> {
    if (page === undefined) return this.#request({name: 'listTrips'});
    return this.#request({name: 'listTrips', page: isObject(page) ? {cursor: page.cursor, limit: page.limit, game: page.game, outcome: page.outcome} : page});
  }
  listSamples(scope: {tripUuid: string} | {pluginSessionId: string}, page?: {afterId?: string; limit?: number}): Promise<Result<SampleRecord[]>> { return this.#request({name: 'listSamples', scope, page}); }
  storageInfo(): Promise<Result<StorageInfo>> { return this.#request({name: 'storageInfo'}); }
  /**
   * Journal reads (ET-016, J5). Queries and pages are copied field by field, so only their listed fields cross the
   * boundary; a value that is not an object is forwarded as given, and the worker's request parser refuses it with
   * INVALID_INPUT. Every answer is validated against the journal contract and the requested page size: a well-framed answer
   * that breaks it resolves that command alone with JOURNAL_ANSWER_INVALID and the client keeps serving (review pass 1);
   * a malformed frame still fails the client closed.
   */
  journalTrips(query?: JournalTripsQuery): Promise<JournalResult<JournalTripPage>> {
    if (query === undefined) return this.#request({name: 'journalTrips'});
    return this.#request({name: 'journalTrips', query: isObject(query) ? {cursor: query.cursor, game: query.game, outcome: query.outcome, completeness: query.completeness} : query});
  }
  journalTrip(tripUuid: string): Promise<JournalResult<JournalTripDetail>> { return this.#request({name: 'journalTrip', tripUuid}); }
  journalEvents(tripUuid: string, page: JournalPageQuery): Promise<JournalResult<JournalEventPage>> {
    return this.#request({name: 'journalEvents', tripUuid, page: isObject(page) ? {cursor: page.cursor, limit: page.limit} : page});
  }
  journalIntervals(tripUuid: string, page: JournalPageQuery): Promise<JournalResult<JournalIntervalPage>> {
    return this.#request({name: 'journalIntervals', tripUuid, page: isObject(page) ? {cursor: page.cursor, limit: page.limit} : page});
  }

  /**
   * Orderly close: queued commands get STORAGE_CLOSED, the command in flight finishes with its real result, then the
   * worker closes the database (SQLite checkpoints the WAL) and its thread exits. Resolves `{clean: true}` only after
   * the worker acknowledged the close and exited. After `closeGraceMs` the worker is terminated, the command in flight
   * gets WORKER_FAILED and the result is `{clean: false}`. A client that already failed (worker error or exit, missed
   * deadline, malformed answer) never closed its database in order: closing waits for the terminated thread, within the
   * grace, and always resolves `{clean: false}`.
   */
  close(): Promise<{clean: boolean}> {
    if (this.#close) return this.#close;
    this.#close = new Promise(resolve => { this.#finishClose = clean => { this.#timers.clearTimeout(this.#closeTimer); resolve({clean}); }; });
    if (this.#state === 'failed') {
      this.#closeTimer = this.#timers.setTimeout(() => this.#finishClose?.(false), this.#options.closeGraceMs);
      void this.#terminate().then(() => this.#finishClose?.(false));
      return this.#close;
    }
    this.#state = 'closing';
    for (const pending of this.#queue.splice(0)) pending.resolve(failure('STORAGE_CLOSED'));
    this.#closeTimer = this.#timers.setTimeout(() => { void this.#forceClose(); }, this.#options.closeGraceMs);
    if (!this.#inFlight) this.#sendClose();
    return this.#close;
  }

  #request<K extends CommandName>(command: StorageCommand & {name: K}): Promise<Result<CommandValue<K>>> {
    if (this.#close) return Promise.resolve(failure('STORAGE_CLOSED'));
    if (this.#state === 'failed') return Promise.resolve(failure('WORKER_FAILED'));
    if (this.#inFlight && this.#queue.length >= this.#options.maxQueued) return Promise.resolve(failure('STORAGE_BUSY'));
    return new Promise<Result<CommandValue<K>>>(resolve => {
      this.#queue.push({command, resolve: resolve as Pending['resolve']});
      this.#pump();
    });
  }

  #pump(): void {
    if (this.#inFlight || this.#state !== 'running') return;
    const next = this.#queue.shift();
    if (next) this.#send(next);
  }

  #send(pending: Pending): void {
    if (!Number.isSafeInteger(this.#nextId)) { pending.resolve(failure('WORKER_FAILED')); this.#fail('WORKER_FAILED'); return; }
    const id = this.#nextId++;
    const deadline = pending.command.name === 'open' ? this.#options.openDeadlineMs : this.#options.commandDeadlineMs;
    // The close command is bounded by the close grace instead.
    const timer = pending.command.name === 'close' ? undefined : this.#timers.setTimeout(() => this.#fail('TIMEOUT'), deadline);
    this.#inFlight = {...pending, id, timer};
    try { this.worker.postMessage({type: 'storage.request', id, command: pending.command}); } catch { this.#fail('WORKER_FAILED'); }
  }

  #sendClose(): void {
    this.#send({command: {name: 'close'}, resolve: result => {
      this.#closeAcknowledged = result.ok;
      if (!result.ok) { this.#state = 'failed'; void this.#terminate().then(() => this.#finishClose?.(false)); }
      else if (this.#exited) this.#closed();
    }});
  }

  #receive(message: unknown): void {
    // Nothing is accepted once the client failed or closed: a late answer never turns into a success.
    if (this.#state === 'failed' || this.#state === 'closed') return;
    const inFlight = this.#inFlight;
    const response = inFlight ? parseResponse(message, inFlight.command) : undefined;
    if (!inFlight || !response || response.id !== inFlight.id) { this.#fail('WORKER_FAILED'); return; }
    this.#timers.clearTimeout(inFlight.timer);
    this.#inFlight = undefined;
    // A bad journal page fails only its own command (worker/protocol.ts, parseResponse); the client keeps serving.
    if ('journalAnswerInvalid' in response) this.settings.onJournalAnswerInvalid?.({command: inFlight.command.name as JournalCommandName});
    inFlight.resolve(response.result);
    if (this.#state === 'closing') { if (inFlight.command.name !== 'close') this.#sendClose(); }
    else this.#pump();
  }

  #exit(code: number): void {
    this.#exited = true;
    if (this.#state === 'closing' && this.#closeAcknowledged && code === 0) { this.#closed(); return; }
    this.#fail('WORKER_FAILED');
  }

  #closed(): void {
    this.#state = 'closed';
    this.#finishClose?.(true);
  }

  /**
   * Fails the client closed. The command in flight receives `code` (TIMEOUT or WORKER_FAILED); its outcome in the
   * database is unknown, so it is never reported as a success. Queued commands receive WORKER_FAILED.
   */
  #fail(code: StorageErrorCode): void {
    if (this.#state === 'failed' || this.#state === 'closed') return;
    const closing = this.#state === 'closing';
    this.#state = 'failed';
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    if (inFlight) { this.#timers.clearTimeout(inFlight.timer); inFlight.resolve(failure(code)); }
    for (const pending of this.#queue.splice(0)) pending.resolve(failure('WORKER_FAILED'));
    const terminated = this.#terminate();
    if (closing) void terminated.then(() => this.#finishClose?.(false));
    else this.settings.onFailure?.(storageError(code));
  }

  async #forceClose(): Promise<void> {
    if (this.#state !== 'closing') return;
    this.#state = 'failed';
    const inFlight = this.#inFlight;
    this.#inFlight = undefined;
    if (inFlight) { this.#timers.clearTimeout(inFlight.timer); inFlight.resolve(failure('WORKER_FAILED')); }
    await this.#terminate();
    this.#finishClose?.(false);
  }

  #terminate(): Promise<void> {
    if (this.#exited) return Promise.resolve();
    return this.worker.terminate().then(() => undefined, () => undefined);
  }
}
