// Storage worker host (ET-013): serves StorageClient requests on the worker thread that owns the one SQLite connection.
// It runs the in-process storage core and therefore loads native SQLite; only the desktop storage worker imports it.
// Requests are handled one at a time in arrival order. Open options are copied field by field, so test hooks, injected
// migrations and clocks never cross the worker boundary. See docs/storage.md.
import type {CommitOptions, Result} from '../api';
import {classifyError, storageError} from '../errors';
import {openStorage, type Storage} from '../index';
import {parseRequest, type StorageCommand, type StorageResponse} from './protocol';

/** A commit command as the host received it, after the request was parsed; `appendSamples` since ET-015b (H16). */
export type CommitCommand = Extract<StorageCommand, {name: 'commitEvent' | 'commitGap' | 'appendSamples'}>;
/**
 * In-process options of a test entry that starts the host itself (ET-015a, R13). They are passed by code on the worker
 * thread and are never read from a message. `commitOptions` may return the in-process commit options, such as a
 * `testHooks.beforeCommit` fault, for one commit or sample append command. The production storage worker passes none.
 */
export interface HostTestOptions {commitOptions?: (command: CommitCommand) => CommitOptions | undefined}

/** The worker side of the port: worker_threads' parentPort satisfies it. */
export interface HostPort {
  on(event: 'message', listener: (message: unknown) => void): unknown;
  off(event: 'message', listener: (message: unknown) => void): unknown;
  postMessage(message: StorageResponse): void;
  unref?(): void;
}

const failed = (code: Parameters<typeof storageError>[0]): Result<never> => ({ok: false, error: storageError(code)});

/**
 * Serves requests until a `close` request: it closes the database, answers, stops listening and releases the port so
 * the worker thread can end with exit code 0. Commands before a successful `open` or after `close` get STORAGE_CLOSED.
 */
export function serveStorage(port: HostPort, testOptions: HostTestOptions = {}): void {
  let storage: Storage | undefined;
  let closed = false;
  let queue = Promise.resolve();

  async function execute(command: StorageCommand): Promise<Result<unknown>> {
    if (command.name === 'close') {
      closed = true;
      const open = storage;
      storage = undefined;
      return open ? open.close() : {ok: true, value: undefined};
    }
    if (closed) return failed('STORAGE_CLOSED');
    if (command.name === 'open') {
      if (storage) return failed('INVALID_INPUT');
      const {path, purpose, backupsDirectory, appVersion} = command.options;
      const opened = await openStorage({path, purpose, backupsDirectory, appVersion});
      if (!opened.ok) return opened;
      // A close that arrived while the open was running is impossible: requests are handled one at a time.
      storage = opened.value;
      return {ok: true, value: opened.value.summary};
    }
    if (!storage) return failed('STORAGE_CLOSED');
    switch (command.name) {
    case 'upsertSession': return storage.upsertSession({message: command.input.message});
    // Only the message and its effects are forwarded; in-process commit options never come from a message, only from
    // a test entry's in-process testOptions.
    case 'commitEvent': return storage.commitEvent({message: command.input.message, effects: command.input.effects, hardMode: command.input.hardMode, hardModeLoss: command.input.hardModeLoss}, testOptions.commitOptions?.(command));
    case 'commitGap': return storage.commitGap({message: command.input.message, effects: command.input.effects, hardMode: command.input.hardMode, hardModeLoss: command.input.hardModeLoss}, testOptions.commitOptions?.(command));
    // Only `uniqueSeconds` of the options is forwarded; the commit options come from the in-process testOptions only.
    case 'appendSamples':
      return storage.appendSamples(command.pluginSessionId, command.rows, command.options === undefined ? undefined : {uniqueSeconds: command.options.uniqueSeconds},
        testOptions.commitOptions?.(command));
    case 'recordCompleteness':
      return storage.recordCompleteness(command.pluginSessionId, command.interval, command.options === undefined ? undefined : {ifAbsent: command.options.ifAbsent});
    // ET-016 PR-7: only the parsed input fields are forwarded.
    case 'openAttachedTrip': {
      const {pluginSessionId, nextEventSeq, job, effects} = command.input;
      return storage.openAttachedTrip({pluginSessionId, nextEventSeq, job, effects});
    }
    case 'observeHardMode': return storage.observeHardMode(command.game, command.observation);
    case 'committedThrough': return storage.committedThrough(command.pluginSessionId);
    case 'getSession': return storage.getSession(command.pluginSessionId);
    case 'getEvent': return storage.getEvent(command.pluginSessionId, command.eventSeq);
    case 'listEvents': return storage.listEvents(command.pluginSessionId, command.page);
    case 'getTrip': return storage.getTrip(command.tripUuid);
    case 'listTrips': return storage.listTrips(command.page);
    case 'listSamples': return storage.listSamples(command.scope, command.page);
    case 'storageInfo': return storage.storageInfo();
    // ET-016: only the parsed fields are forwarded; the parser already refused any other key.
    case 'journalTrips': return storage.journalTrips(command.query === undefined ? undefined
      : {cursor: command.query.cursor, game: command.query.game, outcome: command.query.outcome, completeness: command.query.completeness});
    case 'journalTrip': return storage.journalTrip(command.tripUuid);
    case 'journalEvents': return storage.journalEvents(command.tripUuid, {cursor: command.page.cursor, limit: command.page.limit});
    case 'journalIntervals': return storage.journalIntervals(command.tripUuid, {cursor: command.page.cursor, limit: command.page.limit});
    }
  }

  async function handle(message: unknown): Promise<void> {
    const request = parseRequest(message);
    if (!request.ok) {
      if (request.id !== undefined) port.postMessage({type: 'storage.response', id: request.id, result: failed('INVALID_INPUT')});
      return;
    }
    let result: Result<unknown>;
    try { result = await execute(request.command); } catch (error) { result = {ok: false, error: classifyError(error)}; }
    port.postMessage({type: 'storage.response', id: request.id, result});
    if (request.command.name === 'close') { port.off('message', listener); port.unref?.(); }
  }

  const listener = (message: unknown) => { queue = queue.then(() => handle(message)); };
  port.on('message', listener);
}
