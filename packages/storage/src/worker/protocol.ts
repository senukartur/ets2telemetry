import {isHardModeObservation, type HardModeObservation} from '../../../contracts/src/hard-mode';
// Messages between the StorageClient in the telemetry service and the storage worker host (ET-013). Node-safe: plain
// data only, so the client and its tests never load native SQLite. Messages cross a worker port by structured clone.
// The client sends one request at a time; the host answers every request exactly once, in order. See docs/storage.md.
import {
  isJournalPageQuery, isJournalTripsQuery, isJournalUuid, JOURNAL_EVENT_LIMITS, JOURNAL_INTERVAL_LIMITS, validateJournalEventPage, validateJournalIntervalPage,
  validateJournalTripDetail, validateJournalTripPage
} from '../../../contracts/src/journal';
import type {
  AttachInput, AttachResult, CommitResult, CompletenessInterval, CompletenessOptions, EventRow, JournalAnswerError, JournalEventPage, JournalIntervalPage, JournalPageQuery, JournalTripDetail, JournalTripPage, JournalTripsQuery,
  OpenSummary, Purpose, Result, SampleAppendOptions, SampleAppendResult, SampleInput, SampleRecord, SessionRecord, StorageError, StorageInfo, TripEffect, TripList, TripPage,
  TripRecord, Uint64
} from '../api';
import {JOURNAL_ANSWER_INVALID} from '../api';
import {ERROR_MESSAGES} from '../errors';

/**
 * Open options that cross the worker boundary. Test hooks, injected migrations and clocks are in-process only and are
 * never part of a worker message.
 */
export interface WorkerOpenOptions {path: string; purpose: Purpose; backupsDirectory: string; appVersion: string}

/** Arguments and success value of every worker command; each mirrors the in-process Storage method of the same name. */
export interface StorageCommands {
  open: {args: {options: WorkerOpenOptions}; value: OpenSummary};
  upsertSession: {args: {input: {message: unknown}}; value: {created: boolean; committedThroughEventSeq: Uint64}};
  commitEvent: {args: {input: {message: unknown; effects?: TripEffect[]; hardMode?: HardModeObservation; hardModeLoss?: HardModeObservation}}; value: CommitResult};
  commitGap: {args: {input: {message: unknown; effects?: TripEffect[]; hardMode?: HardModeObservation; hardModeLoss?: HardModeObservation}}; value: CommitResult};
  appendSamples: {args: {pluginSessionId: string; rows: SampleInput[]; options?: SampleAppendOptions}; value: SampleAppendResult};
  recordCompleteness: {args: {pluginSessionId: string; interval: CompletenessInterval; options?: CompletenessOptions}; value: undefined};
  /** ET-016 PR-7 (J9): a late-attach trip; never acknowledged and never a coverage change. */
  openAttachedTrip: {args: {input: AttachInput}; value: AttachResult};
  observeHardMode: {args: {game: 'ets2' | 'ats'; observation: HardModeObservation}; value: undefined};
  committedThrough: {args: {pluginSessionId: string}; value: Uint64};
  getSession: {args: {pluginSessionId: string}; value: SessionRecord};
  getEvent: {args: {pluginSessionId: string; eventSeq: Uint64}; value: EventRow | undefined};
  listEvents: {args: {pluginSessionId: string; page?: {afterEventSeq?: Uint64; limit?: number}}; value: EventRow[]};
  getTrip: {args: {tripUuid: string}; value: TripRecord | undefined};
  listTrips: {args: {page?: TripPage}; value: TripList};
  listSamples: {args: {scope: {tripUuid: string} | {pluginSessionId: string}; page?: {afterId?: string; limit?: number}}; value: SampleRecord[]};
  storageInfo: {args: Record<never, never>; value: StorageInfo};
  /** Journal reads (ET-016 PR-2, J5); arguments and answers are checked strictly on both sides of the boundary. */
  journalTrips: {args: {query?: JournalTripsQuery}; value: JournalTripPage};
  journalTrip: {args: {tripUuid: string}; value: JournalTripDetail};
  journalEvents: {args: {tripUuid: string; page: JournalPageQuery}; value: JournalEventPage};
  journalIntervals: {args: {tripUuid: string; page: JournalPageQuery}; value: JournalIntervalPage};
  /** Closes the connection (SQLite checkpoints the WAL); the host then stops listening and the worker thread ends. */
  close: {args: Record<never, never>; value: undefined};
}
export type CommandName = keyof StorageCommands;
export type StorageCommand = {[K in CommandName]: {name: K} & StorageCommands[K]['args']}[CommandName];
export type CommandValue<K extends CommandName> = StorageCommands[K]['value'];

export interface StorageRequest {type: 'storage.request'; id: number; command: StorageCommand}
export interface StorageResponse {type: 'storage.response'; id: number; result: Result<unknown>}
/**
 * A parsed response. `journalAnswerInvalid` marks a well-framed journal answer whose value broke the journal contract:
 * its result was replaced by a JOURNAL_ANSWER_INVALID error for that command alone (ET-016 review pass 1).
 */
export type ParsedResponse = StorageResponse | {type: 'storage.response'; id: number; result: {ok: false; error: JournalAnswerError}; journalAnswerInvalid: true};

export const COMMAND_NAMES: readonly CommandName[] = Object.freeze([
  'observeHardMode', 'open', 'upsertSession', 'commitEvent', 'commitGap', 'appendSamples', 'recordCompleteness', 'openAttachedTrip', 'committedThrough', 'getSession', 'getEvent',
  'listEvents', 'getTrip', 'listTrips', 'listSamples', 'storageInfo', 'journalTrips', 'journalTrip', 'journalEvents', 'journalIntervals', 'close'
] as const);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
/** Wire uint64 in canonical decimal form, as the storage core returns it. */
const isUint64 = (value: unknown): value is Uint64 => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;

/**
 * An optional argument object: absent, or a plain object whose every key is listed and whose value is undefined or
 * passes its check. An unknown key, such as an in-process option, refuses the request instead of being ignored.
 */
function optionalArgs(value: unknown, checks: Readonly<Record<string, (field: unknown) => boolean>>): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  return Object.entries(value).every(([key, field]) => Object.hasOwn(checks, key) && (field === undefined || checks[key](field)));
}
const oneOf = (options: readonly string[]) => (field: unknown) => typeof field === 'string' && options.includes(field);
/** ET-015a: the `listTrips` filter and the `recordCompleteness` options, checked strictly at the worker boundary. */
const TRIP_PAGE_ARGS = {cursor: (field: unknown) => typeof field === 'string', limit: (field: unknown) => typeof field === 'number',
  game: oneOf(['ets2', 'ats']), outcome: oneOf(['open', 'delivered', 'cancelled', 'none'])};
const COMPLETENESS_OPTIONS_ARGS = {ifAbsent: (field: unknown) => typeof field === 'boolean'};
/** ET-015b: the `appendSamples` options, checked strictly like the completeness options. */
const SAMPLE_OPTIONS_ARGS = {uniqueSeconds: (field: unknown) => typeof field === 'boolean'};
const ATTACH_INPUT_KEYS: readonly string[] = ['pluginSessionId', 'nextEventSeq', 'job', 'effects'];
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export type JournalCommandName = 'journalTrips' | 'journalTrip' | 'journalEvents' | 'journalIntervals';
const JOURNAL_COMMAND_KEYS: Readonly<Record<JournalCommandName, readonly string[]>> = {
  journalTrips: ['name', 'query'], journalTrip: ['name', 'tripUuid'], journalEvents: ['name', 'tripUuid', 'page'], journalIntervals: ['name', 'tripUuid', 'page']
};
/**
 * ET-016: a journal command carries exactly its listed fields, and each is checked as the storage core checks it: a
 * trip UUID, a query of only the listed filters and a page whose `limit` is one of the read's allowed values and whose
 * cursor has the read's fixed format. Anything else refuses the request.
 */
function journalArgs(name: JournalCommandName, command: Record<string, unknown>): boolean {
  if (!Object.keys(command).every(key => JOURNAL_COMMAND_KEYS[name].includes(key))) return false;
  switch (name) {
  case 'journalTrips': return isJournalTripsQuery(command.query);
  case 'journalTrip': return isJournalUuid(command.tripUuid);
  case 'journalEvents': return isJournalUuid(command.tripUuid) && isJournalPageQuery(command.page, JOURNAL_EVENT_LIMITS, 'event');
  case 'journalIntervals': return isJournalUuid(command.tripUuid) && isJournalPageQuery(command.page, JOURNAL_INTERVAL_LIMITS, 'row');
  }
}
const isJournalCommand = (name: CommandName): name is JournalCommandName => Object.hasOwn(JOURNAL_COMMAND_KEYS, name);
/**
 * Whether a journal answer has exactly the documented shape (packages/contracts/src/journal.ts) for the request that was
 * sent: a page holds at most the requested number of rows.
 */
function validJournal(command: Extract<StorageCommand, {name: JournalCommandName}>, value: unknown): boolean {
  try {
    switch (command.name) {
    case 'journalTrips': validateJournalTripPage(value); break;
    case 'journalTrip': validateJournalTripDetail(value); break;
    case 'journalEvents': validateJournalEventPage(value, command.page.limit); break;
    case 'journalIntervals': validateJournalIntervalPage(value, command.page.limit); break;
    }
    return true;
  } catch { return false; }
}

/**
 * Checks the envelope and the argument shapes a command needs to reach the storage core. The core validates every
 * argument value itself; this refuses messages that are not storage requests at all, and checks the `listTrips` page,
 * the `recordCompleteness` options, the `appendSamples` options, the `openAttachedTrip` input and every journal command (ET-016) strictly, so only
 * their listed fields cross the worker boundary.
 */
export function parseRequest(message: unknown): {ok: true; id: number; command: StorageCommand} | {ok: false; id?: number} {
  if (!isRecord(message) || message.type !== 'storage.request' || !isId(message.id)) return {ok: false};
  const id = message.id, command = message.command;
  if (!isRecord(command) || typeof command.name !== 'string' || !(COMMAND_NAMES as readonly string[]).includes(command.name)) return {ok: false, id};
  const name = command.name as CommandName;
  if (name === 'open') {
    const options = command.options;
    if (!isRecord(options) || !isText(options.path) || !isText(options.purpose) || !isText(options.backupsDirectory) || !isText(options.appVersion)) return {ok: false, id};
  }
  if ((name === 'upsertSession' || name === 'commitEvent' || name === 'commitGap') && !isRecord(command.input)) return {ok: false, id};
  if (name === 'listTrips' && !optionalArgs(command.page, TRIP_PAGE_ARGS)) return {ok: false, id};
  if (name === 'observeHardMode' && (Object.keys(command).sort().join(',') !== 'game,name,observation' || !['ets2', 'ats'].includes(command.game as string) || !isHardModeObservation(command.observation))) return {ok: false, id};
  if (name === 'recordCompleteness' && !optionalArgs(command.options, COMPLETENESS_OPTIONS_ARGS)) return {ok: false, id};
  if (name === 'appendSamples' && !optionalArgs(command.options, SAMPLE_OPTIONS_ARGS)) return {ok: false, id};
  // ET-016 PR-7: only the four listed input fields cross the boundary; the storage core checks their values.
  if (name === 'openAttachedTrip' && (!isRecord(command.input) || !Object.keys(command.input).every(key => ATTACH_INPUT_KEYS.includes(key)))) return {ok: false, id};
  if (isJournalCommand(name) && !journalArgs(name, command)) return {ok: false, id};
  return {ok: true, id, command: command as StorageCommand};
}

function isStorageError(value: unknown): value is StorageError {
  return isRecord(value) && typeof value.code === 'string' && Object.hasOwn(ERROR_MESSAGES, value.code) && typeof value.retryable === 'boolean' && typeof value.message === 'string';
}

/**
 * A commit result is what a later durable ACK is built from (protocol v1 §10), so its shape is checked exactly, and so are
 * the sample counts by which a caller keeps or drops its pending rows (ET-015b), and every journal answer (ET-016),
 * which leaves the service; any other success value is passed through from the host, which returns only what the
 * storage core produced.
 */
function validValue(command: StorageCommand, value: unknown): boolean {
  const name = command.name;
  switch (command.name) {
  case 'appendSamples': return isRecord(value) && isCount(value.appended) && isCount(value.skipped);
  case 'commitEvent': case 'commitGap':
    return isRecord(value) && ['committed', 'duplicate', 'conflict', 'covered'].includes(value.status as string) && isUint64(value.committedThroughEventSeq)
      && (value.previouslyCoveredThrough === undefined || isUint64(value.previouslyCoveredThrough)) && (name === 'commitGap' || value.status !== 'covered');
  case 'committedThrough': return isUint64(value);
  // ET-016 PR-7: the recorder adopts a late-attach trip only on one of these two statuses (T3).
  case 'openAttachedTrip': return isRecord(value) && Object.keys(value).length === 1 && (value.status === 'committed' || value.status === 'duplicate');
  case 'open': return isRecord(value) && typeof value.schemaVersion === 'number' && typeof value.created === 'boolean' && isText(value.databaseUuid) && isText(value.purpose);
  case 'upsertSession': return isRecord(value) && typeof value.created === 'boolean' && isUint64(value.committedThroughEventSeq);
  case 'close': case 'recordCompleteness': case 'observeHardMode': return value === undefined;
  // ET-016: a journal page reaches main and the renderer, so its value is checked exactly; parseResponse turns a
  // mismatch into a per-command error rather than a client failure.
  case 'journalTrips': case 'journalTrip': case 'journalEvents': case 'journalIntervals':
    return validJournal(command, value);
  default: return true;
  }
}

/**
 * Accepts only a well-formed response with a known error code or a success value of the right shape for the command
 * that was sent; anything else is undefined and fails the client closed. One exception (ET-016 review pass 1): a
 * well-framed success answer to a journal command whose value breaks the journal contract becomes a JOURNAL_ANSWER_INVALID
 * error for that command alone. Journal reads are off the commit and ACK path, and the worker answered in order with
 * the right id, so this is a bad page, not a lost worker; the client and the recorder keep running.
 */
export function parseResponse(message: unknown, command: StorageCommand): ParsedResponse | undefined {
  if (!isRecord(message) || message.type !== 'storage.response' || !isId(message.id) || !isRecord(message.result)) return undefined;
  const result = message.result;
  if (result.ok === true && Object.hasOwn(result, 'value')) {
    if (validValue(command, result.value)) return {type: 'storage.response', id: message.id, result: {ok: true, value: result.value}};
    if (isJournalCommand(command.name)) return {type: 'storage.response', id: message.id, result: {ok: false, error: {...JOURNAL_ANSWER_INVALID}}, journalAnswerInvalid: true};
    return undefined;
  }
  if (result.ok === false && isStorageError(result.error)) return {type: 'storage.response', id: message.id, result: {ok: false, error: result.error}};
  return undefined;
}
