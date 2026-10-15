// Read commands over the writer connection. Integers arrive as BigInt (safe integers) and become numbers only within a
// proven bound; wire uint64 keys return to their canonical decimal form. Pages are bounded.
import type Database from 'better-sqlite3';
import type {GameMode} from '../../../contracts/src/protocol-v1';
import {
  ACCEPTED_ORIGIN, MAX_EVENT_PAGE, MAX_SAMPLE_BATCH, MAX_TRIP_PAGE, type EventRow, type Purpose, type SampleRecord, type SessionRecord, type StorageInfo, type TripRecord, type Uint64
} from '../api';
import {fromAvailability, fromMask, fromU64Key, isUuid, SAMPLE_FIELDS, toReal, toSafeNumber, u64Key} from '../codec';
import {fail} from '../errors';
import type {StorageConnection} from './connection';
import {statement} from './writes';

const U32 = 4_294_967_295;
function limit(value: unknown, max: number): number {
  if (value === undefined) return max;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) fail('INVALID_INPUT');
  return value;
}
function sessionId(db: Database.Database, pluginSessionId: unknown): bigint {
  if (!isUuid(pluginSessionId)) fail('INVALID_INPUT');
  const id = statement(db, 'SELECT id FROM plugin_sessions WHERE plugin_session_uuid = ?').pluck().get(pluginSessionId) as bigint | undefined;
  if (id === undefined) fail('UNKNOWN_SESSION');
  return id;
}

export function getSession(conn: StorageConnection, pluginSessionId: string): SessionRecord {
  const db = conn.reader(); sessionId(db, pluginSessionId);
  const r = statement(db, 'SELECT * FROM plugin_sessions WHERE plugin_session_uuid = ?').get(pluginSessionId) as Record<string, unknown>;
  const n = (column: string, max = 65_535) => toSafeNumber(r[column], max, 0);
  return {
    pluginSessionId, game: r.game as SessionRecord['game'], origin: r.origin as SessionRecord['origin'], processInstanceId: String(r.process_instance_uuid),
    processId: n('process_id', U32), windowsSessionId: n('windows_session_id', U32), protocolMinor: n('protocol_minor'),
    telemetryApi: {major: n('telemetry_api_major'), minor: n('telemetry_api_minor')}, gameTelemetry: {major: n('game_telemetry_major'), minor: n('game_telemetry_minor')},
    sdkArchive: String(r.sdk_archive), gameplayEvents: r.gameplay_events as SessionRecord['gameplayEvents'], eventTypes: JSON.parse(String(r.event_types_json)) as string[],
    gameMode: {mode: r.game_mode, method: r.game_mode_method, confidence: r.game_mode_confidence, module: fromAvailability(r.game_mode_module, r.game_mode_module_state, String)} as GameMode,
    committedThroughEventSeq: fromU64Key(r.committed_through_event_seq), firstSeenUtcMs: toSafeNumber(r.first_seen_utc_ms)
  };
}
/** The contiguous committed coverage of a session: the `committedThroughEventSeq` input of DurableAckCursor. */
export function committedThrough(conn: StorageConnection, pluginSessionId: string): Uint64 {
  const db = conn.reader(), id = sessionId(db, pluginSessionId);
  return fromU64Key(statement(db, 'SELECT committed_through_event_seq FROM plugin_sessions WHERE id = ?').pluck().get(id));
}

const EVENT_COLUMNS = 'event_seq, type, payload_json, first_redelivered, protocol_minor, committed_utc_ms';
function eventRow(r: Record<string, unknown>): EventRow {
  const payload = JSON.parse(String(r.payload_json)) as {occurred: unknown; record: unknown};
  return {eventSeq: fromU64Key(r.event_seq), type: String(r.type), occurred: payload.occurred, record: payload.record,
    firstRedelivered: toSafeNumber(r.first_redelivered, 1, 0) === 1, protocolMinor: toSafeNumber(r.protocol_minor, 65_535, 0), committedUtcMs: toSafeNumber(r.committed_utc_ms)};
}
export function getEvent(conn: StorageConnection, pluginSessionId: string, eventSeq: Uint64): EventRow | undefined {
  const db = conn.reader(), id = sessionId(db, pluginSessionId);
  const r = statement(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE plugin_session_id = ? AND event_seq = ?`).get(id, u64Key(eventSeq)) as Record<string, unknown> | undefined;
  return r && eventRow(r);
}
/** Events of a session in eventSeq order after `afterEventSeq` (exclusive), at most 500 per page. */
export function listEvents(conn: StorageConnection, pluginSessionId: string, page: {afterEventSeq?: Uint64; limit?: number} = {}): EventRow[] {
  const db = conn.reader(), id = sessionId(db, pluginSessionId);
  return (statement(db, `SELECT ${EVENT_COLUMNS} FROM events WHERE plugin_session_id = ? AND event_seq > ? ORDER BY event_seq LIMIT ?`)
    .all(id, u64Key(page.afterEventSeq ?? '0'), limit(page.limit, MAX_EVENT_PAGE)) as Record<string, unknown>[]).map(eventRow);
}

const seqOf = (db: Database.Database, eventRef: unknown) => fromU64Key(statement(db, 'SELECT event_seq FROM events WHERE id = ?').pluck().get(eventRef));
function tripRecord(db: Database.Database, r: Record<string, unknown>): TripRecord {
  const configSeq = (table: string, ref: unknown) => seqOf(db, statement(db, `SELECT event_ref FROM ${table} WHERE id = ?`).pluck().get(ref));
  const trailers = statement(db, `SELECT e.event_seq FROM trip_trailers t JOIN trailer_configurations c ON c.id = t.trailer_configuration_ref JOIN events e ON e.id = c.event_ref
    WHERE t.trip_ref = ? ORDER BY e.event_seq`).pluck().all(r.id).map(fromU64Key);
  return {
    tripUuid: String(r.trip_uuid), pluginSessionId: String(statement(db, 'SELECT plugin_session_uuid FROM plugin_sessions WHERE id = ?').pluck().get(r.plugin_session_ref)),
    game: r.game as TripRecord['game'], gameMode: {mode: r.game_mode, method: r.game_mode_method, confidence: r.game_mode_confidence} as TripRecord['gameMode'],
    gameModeAmbiguous: toSafeNumber(r.game_mode_ambiguous, 1, 0) === 1, jobConfigurationEventSeq: configSeq('job_configurations', r.job_configuration_ref),
    truckConfigurationEventSeq: r.truck_configuration_ref === null ? null : configSeq('truck_configurations', r.truck_configuration_ref), trailerConfigurationEventSeqs: trailers,
    openedEventSeq: seqOf(db, r.opened_event_ref), outcome: r.outcome as TripRecord['outcome'], outcomeEventSeq: r.outcome_event_ref === null ? null : seqOf(db, r.outcome_event_ref),
    closeReason: r.close_reason as TripRecord['closeReason'], recordingCompleteness: r.recording_completeness as TripRecord['recordingCompleteness'],
    startedUtcMs: toSafeNumber(r.started_utc_ms), endedUtcMs: r.ended_utc_ms === null ? null : toSafeNumber(r.ended_utc_ms),
    observedDistanceM: fromAvailability(r.observed_distance_m, r.observed_distance_m_state, toReal), createdUtcMs: toSafeNumber(r.created_utc_ms), updatedUtcMs: toSafeNumber(r.updated_utc_ms)
  };
}
export function getTrip(conn: StorageConnection, tripUuid: string): TripRecord | undefined {
  const db = conn.reader(); if (!isUuid(tripUuid)) fail('INVALID_INPUT');
  const r = statement(db, 'SELECT * FROM trips WHERE trip_uuid = ?').get(tripUuid) as Record<string, unknown> | undefined;
  return r && tripRecord(db, r);
}
/** Trips in creation order; `cursor` is the opaque `nextCursor` of the previous page. */
export function listTrips(conn: StorageConnection, page: {cursor?: string; limit?: number} = {}): {trips: TripRecord[]; nextCursor: string | null} {
  const db = conn.reader(), max = limit(page.limit, MAX_TRIP_PAGE);
  if (page.cursor !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(page.cursor)) fail('INVALID_INPUT');
  const rows = statement(db, 'SELECT * FROM trips WHERE id > ? ORDER BY id LIMIT ?').all(BigInt(page.cursor ?? '0'), max) as Record<string, unknown>[];
  return {trips: rows.map(r => tripRecord(db, r)), nextCursor: rows.length === max ? String(rows[rows.length - 1].id) : null};
}

/** Samples of one trip or one session in insertion order, at most 3,600 per page. `afterId` is the last `id` read. */
export function listSamples(conn: StorageConnection, scope: {tripUuid: string} | {pluginSessionId: string}, page: {afterId?: string; limit?: number} = {}): SampleRecord[] {
  const db = conn.reader(), max = limit(page.limit, MAX_SAMPLE_BATCH);
  if (page.afterId !== undefined && !/^(0|[1-9][0-9]{0,18})$/.test(page.afterId)) fail('INVALID_INPUT');
  const after = BigInt(page.afterId ?? '0');
  let rows: Record<string, unknown>[];
  if ('tripUuid' in scope) {
    if (!isUuid(scope.tripUuid)) fail('INVALID_INPUT');
    const trip = statement(db, 'SELECT id FROM trips WHERE trip_uuid = ?').pluck().get(scope.tripUuid); if (trip === undefined) fail('UNKNOWN_TRIP');
    rows = statement(db, 'SELECT * FROM samples WHERE trip_ref = ? AND id > ? ORDER BY trip_ref, id LIMIT ?').all(trip, after, max) as Record<string, unknown>[];
  } else rows = statement(db, 'SELECT * FROM samples WHERE plugin_session_ref = ? AND id > ? ORDER BY plugin_session_ref, id LIMIT ?').all(sessionId(db, scope.pluginSessionId), after, max) as Record<string, unknown>[];
  const clock = (ref: unknown) => String(statement(db, 'SELECT clock_uuid FROM clocks WHERE id = ?').pluck().get(ref));
  const tripUuid = (ref: unknown) => ref === null ? null : String(statement(db, 'SELECT trip_uuid FROM trips WHERE id = ?').pluck().get(ref));
  return rows.map(r => {
    const notSupported = toSafeNumber(r.not_supported_mask, 511, 0), invalid = toSafeNumber(r.invalid_mask, 511, 0);
    const field = (name: string) => { const f = SAMPLE_FIELDS.find(s => s.field === name)!; const v = r[f.columns[0]]; return fromMask(v === null ? null : f.integer ? toSafeNumber(v) : toReal(v), f.bit, notSupported, invalid); };
    const position = fromMask(r.x === null ? null : {x: toReal(r.x), y: toReal(r.y), z: toReal(r.z)}, 128, notSupported, invalid);
    const minutes = fromMask(r.game_minutes === null ? null : toSafeNumber(r.game_minutes, U32, 0), 256, notSupported, invalid);
    return {
      id: String(r.id), tripUuid: tripUuid(r.trip_ref), utcMs: toSafeNumber(r.utc_ms), sourceClockId: clock(r.source_clock_ref), monotonicNs: String(r.monotonic_ns),
      gameTime: r.game_clock_ref === null ? null : {minutes, clockId: clock(r.game_clock_ref)},
      speed: field('speed'), fuel: field('fuel'), averageConsumption: field('averageConsumption'), estimatedRange: field('estimatedRange'),
      engineRpm: field('engineRpm'), gear: field('gear'), odometer: field('odometer'), position
    };
  });
}

/** Database identity, verified durability and page usage; `pageSize × pageCount` is the main file size. */
export function storageInfo(conn: StorageConnection): StorageInfo {
  const db = conn.reader();
  const info = statement(db, 'SELECT database_uuid, purpose FROM database_info WHERE id = 1').get() as {database_uuid: string; purpose: Purpose};
  const pragma = (name: string) => toSafeNumber(db.prepare(`PRAGMA ${name}`).pluck().get());
  if (!conn.durability) fail('DURABILITY_UNVERIFIED');
  return {schemaVersion: pragma('user_version'), databaseUuid: info.database_uuid, purpose: info.purpose, acceptedOrigin: ACCEPTED_ORIGIN[info.purpose], durability: conn.durability,
    pageSize: pragma('page_size'), pageCount: pragma('page_count'), freelistCount: pragma('freelist_count')};
}
