// ET-065: Unit tests for trip deletion in staging builds (REG-014).
// Covers IPC contract, parseJournalQuery, parseJournalReply, JournalService query handling,
// active recording guard, preload channel restrictions and UUID validation.
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import type {DesktopBridge} from '../../packages/contracts/src';
import type {Result} from '../../packages/storage/src/api';
import {storageError} from '../../packages/storage/src/errors';
import {
  JOURNAL_DELETE_TRIP_CHANNEL,
  parseJournalQuery,
  parseJournalReply,
  type JournalQuery
} from '../../apps/desktop/src/journal-contract';
import {JournalService, type JournalClient, type JournalHistory} from '../../apps/desktop/src/journal-service';

const VALID_UUID = '7a000000-0000-4000-8000-00000000000b';
const DATABASE = {purpose: 'history', schemaVersion: 4} as const;

describe('journal delete contract (ET-065; REG-014)', () => {
  it('defines the staging-only trip deletion channel', () => {
    expect(JOURNAL_DELETE_TRIP_CHANNEL).toBe('journal:delete-trip');
  });

  describe('parseJournalQuery', () => {
    it('parses a valid deleteTrip query without options', () => {
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID})).toEqual({
        kind: 'deleteTrip',
        tripUuid: VALID_UUID
      });
    });

    it('parses a valid deleteTrip query with options', () => {
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, options: {rejectIfOpen: true}})).toEqual({
        kind: 'deleteTrip',
        tripUuid: VALID_UUID,
        options: {rejectIfOpen: true}
      });
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, options: {rejectIfOpen: false}})).toEqual({
        kind: 'deleteTrip',
        tripUuid: VALID_UUID,
        options: {rejectIfOpen: false}
      });
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, options: {}})).toEqual({
        kind: 'deleteTrip',
        tripUuid: VALID_UUID,
        options: {}
      });
    });

    it('rejects malformed deleteTrip queries', () => {
      expect(parseJournalQuery({kind: 'deleteTrip'})).toBeUndefined();
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: 'not-a-uuid'})).toBeUndefined();
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID.toUpperCase()})).toBeUndefined();
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, extra: 123})).toBeUndefined();
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, options: {rejectIfOpen: 'yes'}})).toBeUndefined();
      expect(parseJournalQuery({kind: 'deleteTrip', tripUuid: VALID_UUID, options: 'invalid'})).toBeUndefined();
    });
  });

  describe('parseJournalReply', () => {
    const query: JournalQuery = {kind: 'deleteTrip', tripUuid: VALID_UUID};

    it('accepts successful void/undefined replies', () => {
      expect(parseJournalReply(query, {ok: true, value: undefined})).toEqual({ok: true, value: undefined});
    });

    it('rejects unexpected reply values', () => {
      expect(parseJournalReply(query, {ok: true, value: {id: 123}})).toBeUndefined();
      expect(parseJournalReply(query, {ok: true, value: 'done'})).toBeUndefined();
    });

    it('parses standard refusal replies', () => {
      expect(parseJournalReply(query, {ok: false, code: 'NOT_FOUND'})).toEqual({ok: false, code: 'NOT_FOUND'});
      expect(parseJournalReply(query, {ok: false, code: 'BUSY'})).toEqual({ok: false, code: 'BUSY'});
      expect(parseJournalReply(query, {ok: false, code: 'SERVICE_UNAVAILABLE'})).toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
      expect(parseJournalReply(query, {ok: false, code: 'DATABASE_OPENING'})).toEqual({ok: false, code: 'DATABASE_OPENING'});
      expect(parseJournalReply(query, {ok: false, code: 'TIMEOUT'})).toEqual({ok: false, code: 'TIMEOUT'});
      expect(parseJournalReply(query, {ok: false, code: 'FAILED'})).toEqual({ok: false, code: 'FAILED'});
      expect(parseJournalReply(query, {ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'DATABASE_LOCKED'})).toEqual({
        ok: false,
        code: 'DATABASE_UNAVAILABLE',
        storageCode: 'DATABASE_LOCKED'
      });
    });
  });
});

describe('JournalService deleteTrip queries (ET-065)', () => {
  function createFixture(isRecordingActive = false) {
    const calls: unknown[][] = [];
    let nextResult: Result<void> = {ok: true, value: undefined};
    const client: JournalClient = {
      journalTrips: vi.fn(),
      journalTrip: vi.fn(),
      journalEvents: vi.fn(),
      journalIntervals: vi.fn(),
      listSamples: vi.fn(),
      deleteTrip: vi.fn((tripUuid: string, options?: {rejectIfOpen?: boolean}) => {
        calls.push(['deleteTrip', tripUuid, options]);
        return Promise.resolve(nextResult);
      })
    };
    const history: JournalHistory = {
      state: 'open',
      failureCode: null,
      client,
      database: DATABASE,
      databaseUuid: 'uuid-1'
    };
    const log = vi.fn();
    const service = new JournalService({
      history,
      stopping: () => false,
      log,
      isRecordingActive: () => isRecordingActive
    });
    return {service, calls, setResult: (res: Result<void>) => { nextResult = res; }};
  }

  it('delegates deleteTrip to client with rejectIfOpen = true when inactive and refuses with BUSY when recording is active', async () => {
    const inactive = createFixture(false);
    await expect(inactive.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID})).resolves.toEqual({ok: true, value: undefined});
    expect(inactive.calls).toEqual([['deleteTrip', VALID_UUID, {rejectIfOpen: true}]]);

    const active = createFixture(true);
    await expect(active.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID})).resolves.toEqual({ok: false, code: 'BUSY'});
    expect(active.calls).toEqual([]);
  });

  it('allows explicit rejectIfOpen override in query options when inactive', async () => {
    const inactive = createFixture(false);
    await inactive.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID, options: {rejectIfOpen: false}});
    expect(inactive.calls).toEqual([['deleteTrip', VALID_UUID, {rejectIfOpen: false}]]);
  });

  it('maps UNKNOWN_TRIP to NOT_FOUND and STORAGE_BUSY to BUSY', async () => {
    const f = createFixture();
    f.setResult({ok: false, error: storageError('UNKNOWN_TRIP')});
    await expect(f.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID})).resolves.toEqual({ok: false, code: 'NOT_FOUND'});

    f.setResult({ok: false, error: storageError('STORAGE_BUSY')});
    await expect(f.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID})).resolves.toEqual({ok: false, code: 'BUSY'});
  });

  it('maps fatal storage failures to DATABASE_UNAVAILABLE', async () => {
    const f = createFixture();
    f.setResult({ok: false, error: storageError('STORAGE_CLOSED')});
    await expect(f.service.query({kind: 'deleteTrip', tripUuid: VALID_UUID})).resolves.toEqual({
      ok: false,
      code: 'DATABASE_UNAVAILABLE',
      storageCode: 'STORAGE_CLOSED'
    });
  });
});

describe('preload deleteJournalTrip boundary (ET-065)', () => {
  let ipc: EventEmitter & {send: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>};
  let bridge: DesktopBridge;

  beforeEach(() => {
    vi.resetModules();
    ipc = Object.assign(new EventEmitter(), {
      send: vi.fn(),
      invoke: vi.fn(() => Promise.resolve({ok: true, value: undefined}))
    });
    vi.doMock('electron', () => ({
      ipcRenderer: ipc,
      contextBridge: {exposeInMainWorld: (_key: string, value: DesktopBridge) => { bridge = value; }}
    }));
  });

  afterEach(() => {
    vi.doUnmock('electron');
    vi.doUnmock('../../apps/desktop/src/channel');
  });

  it('forwards deleteJournalTrip to JOURNAL_DELETE_TRIP_CHANNEL in staging channel', async () => {
    vi.doMock('../../apps/desktop/src/channel', () => ({
      ACTIVE_CHANNEL: 'staging',
      CHANNEL: {displayName: 'Yukon Union Telemetry Staging'}
    }));
    await import('../../apps/desktop/src/preload');

    const result = await bridge.deleteJournalTrip(VALID_UUID);
    expect(result).toEqual({ok: true, value: undefined});
    expect(ipc.invoke).toHaveBeenCalledWith('journal:delete-trip', VALID_UUID);

    // Invalid UUIDs reject before IPC
    await expect(bridge.deleteJournalTrip('not-a-uuid')).rejects.toThrow('Invalid journal request');
    await expect(bridge.deleteJournalTrip(VALID_UUID.toUpperCase())).rejects.toThrow('Invalid journal request');
  });

  it('refuses deleteJournalTrip completely in production channel', async () => {
    vi.doMock('../../apps/desktop/src/channel', () => ({
      ACTIVE_CHANNEL: 'production',
      CHANNEL: {displayName: 'Yukon Union Telemetry'}
    }));
    await import('../../apps/desktop/src/preload');

    await expect(bridge.deleteJournalTrip(VALID_UUID)).rejects.toThrow('Trip deletion is only available in staging builds');
    expect(ipc.invoke).not.toHaveBeenCalled();
  });
});
