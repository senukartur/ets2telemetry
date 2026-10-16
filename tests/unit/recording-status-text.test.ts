import {expect, it} from 'vitest';
import type {RecordingCode, RecordingHealth, RecordingLosses, RecordingState, RecordingTarget, RecordingTrip} from '../../packages/contracts/src';
import {RECORDING_CODES} from '../../apps/desktop/src/recording-status';
import {recordingStatusText} from '../../apps/desktop/src/recording-status-text';

// ET-015c PR-4 (G8): every expected text below is written by hand.
const NO_LOSSES: RecordingLosses = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
const status = (state: RecordingState, options: {target?: RecordingTarget; code?: RecordingCode | null; losses?: Partial<RecordingLosses>; trip?: RecordingTrip | null} = {}): RecordingHealth =>
  ({state, target: options.target ?? 'history', code: options.code ?? null, losses: {...NO_LOSSES, ...options.losses}, trip: options.trip ?? null});
const HISTORY_NOTICE = 'Prototype live display. Game history recording is new; check the recording status below.';
const TEST_NOTICE = 'Prototype live display. Only a test database is recorded, never game history.';

it('shows the fixed texts of the disabled and unknown states without detail, losses or alert', () => {
  expect(recordingStatusText({state: 'disabled'})).toEqual({headline: 'Off: this version does not record game history', short: 'off in this version',
    detail: [], losses: [], alert: null, notice: 'Prototype live display. No trip recording or durable history.'});
  expect(recordingStatusText({state: 'unknown'})).toEqual({headline: 'Not known: the telemetry service is not running or has not reported a valid status', short: 'not known',
    detail: [], losses: [], alert: null, notice: 'Prototype live display. The recording status is not known right now.'});
});

it('gives every reported state its headline, short form and alert', () => {
  const rows: [RecordingState, RecordingCode | null, string, string, string | null][] = [
    ['opening', null, 'Opening the database', 'opening the database', null],
    ['waiting', null, 'Waiting for the recorded source to connect', 'waiting for the source', null],
    ['recording', null, 'Recording', 'on', null],
    ['paused', null, 'Game paused; recording continues when it resumes', 'game paused', null],
    ['interrupted', null, 'Connection lost; recording resumes on reconnection, and the missing time is recorded as a gap', 'connection lost', null],
    ['retrying', 'DISK_FULL', 'Retrying: the disk is full. Nothing is acknowledged until storage commits; events while reconnecting are recorded as a gap',
      'retrying, the disk is full', 'ETS2Telemetry retries automatically. Live telemetry and the overlay keep working.'],
    ['stopped', 'PERMISSION_DENIED', 'Stopped: no permission to write the database. Restart ETS2Telemetry after fixing it', 'stopped, no permission to write the database',
      'Recording stopped until the telemetry service starts again. Live telemetry and the overlay keep working.'],
    ['live-only', 'ACK_AHEAD_OF_STORAGE', 'Not recording this game session: the database is behind the plugin (restored database); recording resumes with the next game session',
      'not this game session', 'Live telemetry and the overlay keep working; this game session is not recorded.'],
    ['not-recorded-source', null, 'Not recording the selected source', 'not this source', null]
  ];
  expect(rows.map(row => row[0]).sort()).toEqual(['interrupted', 'live-only', 'not-recorded-source', 'opening', 'paused', 'recording', 'retrying', 'stopped', 'waiting']);
  for (const [state, code, headline, short, alert] of rows)
    expect(recordingStatusText(status(state, {code})), state).toEqual({headline, short, detail: [], losses: [], alert, notice: HISTORY_NOTICE});
});

it('names the cause of every recording code in the retrying and stopped headlines', () => {
  const causes: Record<RecordingCode, string> = {
    DATABASE_LOCKED: 'the database is locked by another program', PERMISSION_DENIED: 'no permission to write the database', DISK_FULL: 'the disk is full',
    IO_ERROR: 'a disk read or write failed', DATABASE_CORRUPT: 'the database is damaged', CONSTRAINT_VIOLATION: 'storage refused inconsistent data',
    INVALID_INPUT: 'storage refused invalid data', UNKNOWN_SESSION: 'storage does not know this game session', UNKNOWN_TRIP: 'storage does not know this trip',
    SESSION_CONFLICT: 'this game session conflicts with the stored one', VALUE_OUT_OF_RANGE: 'a value was out of range', STORAGE_CLOSED: 'the database is closed',
    STORAGE_BUSY: 'storage is busy', WORKER_FAILED: 'the storage worker failed', TIMEOUT: 'storage did not answer in time',
    DATA_PATH_INVALID: 'the data folder cannot be used', DATABASE_UNRECOGNIZED: 'the database file is not an ETS2Telemetry database',
    SCHEMA_NEWER: 'the database was written by a newer version', PURPOSE_MISMATCH: 'the database holds another kind of data',
    DURABILITY_UNVERIFIED: 'safe disk writes could not be confirmed', BACKUP_FAILED: 'the backup before a database upgrade failed',
    MIGRATION_FAILED: 'the database upgrade failed', INTERNAL: 'an internal error occurred', TRIP_ORDER_VIOLATION: 'trip events arrived out of order',
    TRIP_COVERAGE_MISMATCH: 'the trip records do not match the stored coverage', TRIP_UNKNOWN_SESSION: 'a trip belongs to an unknown game session',
    BACKLOG_FULL: 'too much work is waiting for storage', COVERAGE_MISMATCH: 'the plugin and the database disagree about what was stored',
    ACK_AHEAD_OF_STORAGE: 'the database is behind the plugin'
  };
  expect(Object.keys(causes).sort()).toEqual([...RECORDING_CODES].sort());
  for (const code of RECORDING_CODES) {
    const retrying = recordingStatusText(status('retrying', {code})), stopped = recordingStatusText(status('stopped', {code}));
    expect(retrying.headline, code).toBe(`Retrying: ${causes[code]}. Nothing is acknowledged until storage commits; events while reconnecting are recorded as a gap`);
    expect(retrying.short, code).toBe(`retrying, ${causes[code]}`);
    expect(stopped.headline, code).toBe(`Stopped: ${causes[code]}. Restart ETS2Telemetry after fixing it`);
    expect(stopped.short, code).toBe(`stopped, ${causes[code]}`);
  }
  // A retrying or stopped status without a code reads as an internal error, never as a blank cause.
  expect(recordingStatusText(status('stopped')).headline).toBe('Stopped: an internal error occurred. Restart ETS2Telemetry after fixing it');
});

it('notes a synthetic or replay target in the detail, the short form and the prototype notice', () => {
  expect(recordingStatusText(status('recording', {target: 'synthetic'}))).toEqual({headline: 'Recording', short: 'on · synthetic test database',
    detail: ['Synthetic test database (never game history)'], losses: [], alert: null, notice: TEST_NOTICE});
  expect(recordingStatusText(status('waiting', {target: 'replay'}))).toEqual({headline: 'Waiting for the recorded source to connect',
    short: 'waiting for the source · replay test database', detail: ['Replay test database (never game history)'], losses: [], alert: null, notice: TEST_NOTICE});
  expect(recordingStatusText(status('retrying', {target: 'synthetic', code: 'BACKLOG_FULL'})).short).toBe('retrying, too much work is waiting for storage · synthetic test database');
});

it('describes the current trip and an untracked job', () => {
  const trip = (phase: RecordingTrip['phase'], completeness: RecordingTrip['completeness'], untrackedJob = false): RecordingTrip => ({phase, completeness, untrackedJob});
  const detail = (value: RecordingTrip | null) => recordingStatusText(status('recording', {trip: value})).detail;
  expect(detail(null)).toEqual([]);
  expect(detail(trip('idle', null))).toEqual([]);
  expect(detail(trip('idle', null, true))).toEqual(['The current job started before recording and is not tracked as a trip']);
  expect(detail(trip('active', 'partial'))).toEqual(['Current trip is partial']);
  expect(detail(trip('active', 'complete'))).toEqual(['Current trip is recorded completely so far']);
  expect(detail(trip('active', 'unknown'))).toEqual(["The current trip's completeness is not known yet"]);
  expect(detail(trip('awaiting-outcome', 'partial'))).toEqual(['Current trip is partial; waiting for its delivery outcome']);
  expect(detail(trip('reload-check', 'complete'))).toEqual(['Current trip is recorded completely so far; checking a loaded save']);
  expect(detail(trip('active', null))).toEqual(['A trip is in progress']);
  expect(recordingStatusText(status('interrupted', {target: 'synthetic', trip: trip('active', 'partial')})).detail)
    .toEqual(['Synthetic test database (never game history)', 'Current trip is partial']);
});

it('shows a loss line only for each non-zero total, since ETS2Telemetry started', () => {
  expect(recordingStatusText(status('recording')).losses).toEqual([]);
  expect(recordingStatusText(status('recording', {losses: {notConnected: 1}})).losses)
    .toEqual(['Gaps recorded since ETS2Telemetry started', 'Intervals without a connection: 1']);
  expect(recordingStatusText(status('interrupted', {losses: {lostEvents: 12, eventLoss: 2, sampleLoss: 3, droppedSamples: 40}})).losses).toEqual([
    'Gaps recorded since ETS2Telemetry started', 'Lost events: 12', 'Event loss intervals: 2', 'One-second sample loss intervals: 3', 'Dropped one-second samples: 40']);
  // TD-004: a restore loss may be counted again after a service restart in the same plugin session.
  expect(recordingStatusText(status('live-only', {code: 'ACK_AHEAD_OF_STORAGE', losses: {lostEvents: 4, restoreLoss: 1}})).losses).toEqual([
    'Gaps recorded since ETS2Telemetry started', 'Lost events: 4', 'Restored-database intervals: 1',
    'These totals may be an upper bound: after a telemetry service restart in the same game session a restored-database loss is counted again. The database itself is correct.']);
  expect(recordingStatusText(status('recording', {losses: {lostEvents: Number.MAX_SAFE_INTEGER}})).losses[1]).toBe('Lost events: 9007199254740991');
});
