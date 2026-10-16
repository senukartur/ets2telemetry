// Messages between the StorageClient in the telemetry service and the storage worker host (ET-013). Node-safe: plain
// data only, so the client and its tests never load native SQLite. Messages cross a worker port by structured clone.
// The client sends one request at a time; the host answers every request exactly once, in order. See docs/storage.md.
import type {
  CommitResult, CompletenessInterval, CompletenessOptions, EventRow, OpenSummary, Purpose, Result, SampleAppendOptions, SampleAppendResult, SampleInput, SampleRecord, SessionRecord,
  StorageError, StorageInfo, TripEffect, TripList, TripPage, TripRecord, Uint64
} from '../api';
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
  commitEvent: {args: {input: {message: unknown; effects?: TripEffect[]}}; value: CommitResult};
  commitGap: {args: {input: {message: unknown; effects?: TripEffect[]}}; value: CommitResult};
  appendSamples: {args: {pluginSessionId: string; rows: SampleInput[]; options?: SampleAppendOptions}; value: SampleAppendResult};
  recordCompleteness: {args: {pluginSessionId: string; interval: CompletenessInterval; options?: CompletenessOptions}; value: undefined};
  committedThrough: {args: {pluginSessionId: string}; value: Uint64};
  getSession: {args: {pluginSessionId: string}; value: SessionRecord};
  getEvent: {args: {pluginSessionId: string; eventSeq: Uint64}; value: EventRow | undefined};
  listEvents: {args: {pluginSessionId: string; page?: {afterEventSeq?: Uint64; limit?: number}}; value: EventRow[]};
  getTrip: {args: {tripUuid: string}; value: TripRecord | undefined};
  listTrips: {args: {page?: TripPage}; value: TripList};
  listSamples: {args: {scope: {tripUuid: string} | {pluginSessionId: string}; page?: {afterId?: string; limit?: number}}; value: SampleRecord[]};
  storageInfo: {args: Record<never, never>; value: StorageInfo};
  /** Closes the connection (SQLite checkpoints the WAL); the host then stops listening and the worker thread ends. */
  close: {args: Record<never, never>; value: undefined};
}
export type CommandName = keyof StorageCommands;
export type StorageCommand = {[K in CommandName]: {name: K} & StorageCommands[K]['args']}[CommandName];
export type CommandValue<K extends CommandName> = StorageCommands[K]['value'];

export interface StorageRequest {type: 'storage.request'; id: number; command: StorageCommand}
export interface StorageResponse {type: 'storage.response'; id: number; result: Result<unknown>}

export const COMMAND_NAMES: readonly CommandName[] = Object.freeze([
  'open', 'upsertSession', 'commitEvent', 'commitGap', 'appendSamples', 'recordCompleteness', 'committedThrough', 'getSession', 'getEvent',
  'listEvents', 'getTrip', 'listTrips', 'listSamples', 'storageInfo', 'close'
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
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Checks the envelope and the argument shapes a command needs to reach the storage core. The core validates every
 * argument value itself; this refuses messages that are not storage requests at all, and checks the `listTrips` page,
 * the `recordCompleteness` options and the `appendSamples` options strictly, so only their listed fields cross the
 * worker boundary.
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
  if (name === 'recordCompleteness' && !optionalArgs(command.options, COMPLETENESS_OPTIONS_ARGS)) return {ok: false, id};
  if (name === 'appendSamples' && !optionalArgs(command.options, SAMPLE_OPTIONS_ARGS)) return {ok: false, id};
  return {ok: true, id, command: command as StorageCommand};
}

function isStorageError(value: unknown): value is StorageError {
  return isRecord(value) && typeof value.code === 'string' && Object.hasOwn(ERROR_MESSAGES, value.code) && typeof value.retryable === 'boolean' && typeof value.message === 'string';
}

/**
 * A commit result is what a later durable ACK is built from (protocol v1 §10), so its shape is checked exactly, and so are
 * the sample counts by which a caller keeps or drops its pending rows (ET-015b); any other success value is passed
 * through from the host, which returns only what the storage core produced.
 */
function validValue(name: CommandName, value: unknown): boolean {
  switch (name) {
  case 'appendSamples': return isRecord(value) && isCount(value.appended) && isCount(value.skipped);
  case 'commitEvent': case 'commitGap':
    return isRecord(value) && ['committed', 'duplicate', 'conflict', 'covered'].includes(value.status as string) && isUint64(value.committedThroughEventSeq)
      && (value.previouslyCoveredThrough === undefined || isUint64(value.previouslyCoveredThrough)) && (name === 'commitGap' || value.status !== 'covered');
  case 'committedThrough': return isUint64(value);
  case 'open': return isRecord(value) && typeof value.schemaVersion === 'number' && typeof value.created === 'boolean' && isText(value.databaseUuid) && isText(value.purpose);
  case 'upsertSession': return isRecord(value) && typeof value.created === 'boolean' && isUint64(value.committedThroughEventSeq);
  case 'close': case 'recordCompleteness': return value === undefined;
  default: return true;
  }
}

/** Accepts only a well-formed response with a known error code or a success value of the right shape for its command. */
export function parseResponse(message: unknown, name: CommandName): StorageResponse | undefined {
  if (!isRecord(message) || message.type !== 'storage.response' || !isId(message.id) || !isRecord(message.result)) return undefined;
  const result = message.result;
  if (result.ok === true && Object.hasOwn(result, 'value') && validValue(name, result.value)) return {type: 'storage.response', id: message.id, result: {ok: true, value: result.value}};
  if (result.ok === false && isStorageError(result.error)) return {type: 'storage.response', id: message.id, result: {ok: false, error: result.error}};
  return undefined;
}
