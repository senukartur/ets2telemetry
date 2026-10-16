import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {DELIVERY_FIELDS, JOB_FIELDS, specColumns, TRAILER_FIELDS, TRUCK_FIELDS, type FieldSpec} from '../../packages/storage/src/codec';
import {Storage} from '../../packages/storage/src/index';
import {openConnection, type StorageConnection} from '../../packages/storage/src/sqlite/connection';
import {failed, ok, v1, workspace} from './helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
let connection: StorageConnection;
beforeEach(async () => {
  ws = await workspace(); connection = await openConnection(ws.options());
  const storage = new Storage(connection);
  ok(storage.upsertSession({message: v1('welcome')}));
  ok(storage.commitEvent({message: v1('event-job-configured')}));
});
afterEach(async () => { connection.close(); await ws.dispose(); });

const sql = (statement: string, ...parameters: unknown[]) => connection.writer().prepare(statement).run(...parameters);
const rejected = (statement: string, code: string, ...parameters: unknown[]) => expect(() => sql(statement, ...parameters)).toThrow(expect.objectContaining({code}));
const SQL_TYPE: Record<FieldSpec['kind'], string> = {text: 'TEXT', real: 'REAL', integer: 'INTEGER', boolean: 'INTEGER', minutes: 'INTEGER', money: 'TEXT'};

describe('schema version 1 constraints', () => {
  it('has a typed column pair for every normalized protocol field', () => {
    const columns = (table: string) => new Map((connection.reader().pragma(`table_info(${table})`) as {name: string; type: string}[]).map(c => [c.name, c.type]));
    for (const [table, fields] of [['job_configurations', JOB_FIELDS], ['truck_configurations', TRUCK_FIELDS], ['trailer_configurations', TRAILER_FIELDS], ['job_deliveries', DELIVERY_FIELDS]] as const) {
      const actual = columns(table);
      for (const column of specColumns(fields)) expect(actual.has(column), `${table}.${column}`).toBe(true);
      for (const field of fields) if (field.kind !== 'money') {
        expect(actual.get(field.column), `${table}.${field.column}`).toBe(SQL_TYPE[field.kind]);
        expect(actual.get(`${field.column}_state`)).toBe('TEXT');
      }
    }
  });
  it('rejects unpadded keys, non-canonical money and an available state without a value', () => {
    rejected("INSERT INTO event_gaps (plugin_session_ref, first_event_seq, last_event_seq, cause_offline, cause_no_durable_consumer, cause_queue_count, cause_queue_bytes, cause_retention_expired, cause_encoding_failed, first_lost_monotonic_ns_state, last_lost_monotonic_ns_state, source_clock_ref, redelivered, committed_utc_ms) VALUES (1, '2', '00000000000000000002', '00000000000000000001', '00000000000000000000', '00000000000000000000', '00000000000000000000', '00000000000000000000', '00000000000000000000', 'not-observed', 'not-observed', 1, 0, 0)", 'SQLITE_CONSTRAINT_CHECK');
    for (const raw of ['-0', '01', '1.5', '1e3', '+5', '-']) {
      rejected("INSERT INTO event_amounts (event_ref, amount_raw, amount_sdk_type, amount_currency_status, amount_state) VALUES (1, ?, 's64', 'unknown', 'available')", 'SQLITE_CONSTRAINT_CHECK', raw);
    }
    rejected("INSERT INTO event_amounts (event_ref, amount_raw, amount_sdk_type, amount_currency_status, amount_state) VALUES (1, '-1', 'u64', 'unknown', 'available')", 'SQLITE_CONSTRAINT_CHECK');
    rejected("INSERT INTO event_amounts (event_ref, amount_raw, amount_sdk_type, amount_currency_status, amount_state) VALUES (1, NULL, NULL, NULL, 'available')", 'SQLITE_CONSTRAINT_CHECK');
    rejected("INSERT INTO event_amounts (event_ref, amount_raw, amount_sdk_type, amount_currency_status, amount_currency_code, amount_state) VALUES (1, '5', 's64', 'unknown', 'EUR', 'available')", 'SQLITE_CONSTRAINT_CHECK');
    // STRICT tables refuse a value that cannot become the column type, such as text in an INTEGER column.
    rejected("INSERT INTO samples (plugin_session_ref, utc_ms, source_clock_ref, monotonic_ns) VALUES (1, 'yesterday', 1, 0)", 'SQLITE_CONSTRAINT_DATATYPE');
  });
  it('enforces the event key, foreign keys and immutable event and identity rows', () => {
    rejected("INSERT INTO events (plugin_session_id, event_seq, type, occurred_monotonic_ns_state, source_clock_ref, occurred_game_minutes_state, occurred_game_clock_ref, occurred_utc_ms_state, occurred_simulation, configuration_revision, boundary_order, payload_json, protocol_minor, first_redelivered, committed_utc_ms) VALUES (1, '00000000000000000001', 'job.cleared', 'not-observed', 1, 'not-observed', 2, 'not-observed', 'running', '00000000000000000000', '00000000000000000000', '{}', 0, 0, 0)", 'SQLITE_CONSTRAINT_UNIQUE');
    rejected("INSERT INTO samples (plugin_session_ref, utc_ms, source_clock_ref, monotonic_ns) VALUES (999, 0, 1, 0)", 'SQLITE_CONSTRAINT_FOREIGNKEY');
    rejected("UPDATE events SET payload_json = '{}'", 'SQLITE_CONSTRAINT_TRIGGER');
    rejected('DELETE FROM events', 'SQLITE_CONSTRAINT_TRIGGER');
    rejected("UPDATE database_info SET purpose = 'history', accepted_origin = 'game'", 'SQLITE_CONSTRAINT_TRIGGER');
    rejected("UPDATE plugin_sessions SET origin = 'game'", 'SQLITE_CONSTRAINT_TRIGGER');
  });
  it('requires an outcome event for delivered or cancelled trips and a trip exactly for attributed events', () => {
    const trip = "INSERT INTO trips (trip_uuid, plugin_session_ref, game, game_mode, game_mode_method, game_mode_confidence, job_configuration_ref, opened_event_ref, outcome, outcome_event_ref, close_reason, recording_completeness, started_utc_ms, ended_utc_ms, observed_distance_m_state, created_utc_ms, updated_utc_ms) VALUES ('70000000-0000-4000-8000-000000000001', 1, 'ets2', 'unknown', 'none', 'none', 1, 1, ?, ?, ?, 'unknown', 0, ?, 'not-observed', 0, 0)";
    rejected(trip, 'SQLITE_CONSTRAINT_CHECK', 'delivered', null, 'outcome', 1);
    rejected(trip, 'SQLITE_CONSTRAINT_CHECK', 'open', null, 'outcome', null);
    sql(trip, 'open', null, null, null);
    rejected("INSERT INTO event_attributions (event_ref, trip_ref, attribution) VALUES (1, NULL, 'trip')", 'SQLITE_CONSTRAINT_CHECK');
    rejected("INSERT INTO event_attributions (event_ref, trip_ref, attribution) VALUES (1, 1, 'ambiguous')", 'SQLITE_CONSTRAINT_CHECK');
  });
  it('uses indexes for session, trip and event lookups', () => {
    const plan = (statement: string) => (connection.reader().prepare(`EXPLAIN QUERY PLAN ${statement}`).all() as {detail: string}[]).map(r => r.detail).join('\n');
    expect(plan('SELECT * FROM samples WHERE trip_ref = 1 AND id > 0 ORDER BY trip_ref, id LIMIT 10')).toMatch(/USING INDEX samples_trip/);
    expect(plan('SELECT * FROM samples WHERE plugin_session_ref = 1 AND id > 0 ORDER BY plugin_session_ref, id LIMIT 10')).toMatch(/USING (COVERING )?INDEX samples_session/);
    expect(plan("SELECT 1 FROM events WHERE plugin_session_id = 1 AND event_seq = '00000000000000000001'")).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_events_1/);
    expect(plan("SELECT max(last_event_seq) FROM event_gaps WHERE plugin_session_ref = 1 AND first_event_seq <= '1' AND last_event_seq >= '1'")).toMatch(/USING (COVERING )?INDEX sqlite_autoindex_event_gaps_1/);
    expect(plan('SELECT * FROM event_attributions WHERE trip_ref = 1')).toMatch(/USING (COVERING )?INDEX event_attributions_trip/);
    expect(plan('SELECT * FROM completeness_intervals WHERE trip_ref = 1')).toMatch(/USING INDEX completeness_intervals_trip/);
  });
});

// ET-016 PR-1 (J6): the version 2 columns. Each row below is inserted by hand next to the job configuration that the
// beforeEach commit stored (id 1, event 1 of plugin session 1).
describe('schema version 2 constraints', () => {
  const TRIP = `INSERT INTO trips (trip_uuid, plugin_session_ref, game, game_mode, game_mode_method, game_mode_confidence, job_configuration_ref, opened_event_ref, outcome,
    close_reason, recording_completeness, started_utc_ms, ended_utc_ms, observed_distance_m_state, created_utc_ms, updated_utc_ms, fuel_used_l, fuel_used_l_state,
    closed_by_session_ref, closed_by_event_seq) VALUES (?, 1, 'ets2', 'unknown', 'none', 'none', 1, 1, ?, ?, 'unknown', 0, ?, 'not-observed', 0, 0, ?, ?, ?, ?)`;
  const tripUuid = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  /** A closed (gap) trip with the given fuel used and carrier. */
  const closed = (n: number, fuel: unknown, state: unknown, session: unknown, eventSeq: unknown) => [tripUuid(n), 'none', 'gap', 0, fuel, state, session, eventSeq];
  const open = (n: number, session: unknown, eventSeq: unknown) => [tripUuid(n), 'open', null, null, null, 'not-observed', session, eventSeq];
  const SEQ_1 = '00000000000000000001';

  it('keeps fuel used with its availability state: not observed by default, zero is a value, nothing negative or without a state', () => {
    sql("INSERT INTO trips (trip_uuid, plugin_session_ref, game, game_mode, game_mode_method, game_mode_confidence, job_configuration_ref, opened_event_ref, outcome, recording_completeness, started_utc_ms, observed_distance_m_state, created_utc_ms, updated_utc_ms) VALUES (?, 1, 'ets2', 'unknown', 'none', 'none', 1, 1, 'open', 'unknown', 0, 'not-observed', 0, 0)", tripUuid(1));
    expect(connection.reader().prepare('SELECT fuel_used_l, fuel_used_l_state, closed_by_session_ref, closed_by_event_seq FROM trips WHERE trip_uuid = ?').get(tripUuid(1)))
      .toEqual({fuel_used_l: null, fuel_used_l_state: 'not-observed', closed_by_session_ref: null, closed_by_event_seq: null});
    sql(TRIP, ...closed(2, 0, 'available', 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, -0.5, 'available', 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, 5, 'not-observed', 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, null, 'available', 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, null, 'unknown', 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_NOTNULL', ...closed(3, null, null, 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_DATATYPE', ...closed(3, 'many', 'available', 1n, SEQ_1));
  });
  it('records a close carrier only as a stored session with an eventSeq key, and never on an open trip', () => {
    sql(TRIP, ...open(1, null, null));
    sql(TRIP, ...closed(2, null, 'not-observed', null, null));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...open(3, 1n, SEQ_1));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, null, 'not-observed', 1n, null));
    rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, null, 'not-observed', null, SEQ_1));
    for (const eventSeq of ['1', '00000000000000000000', '18446744073709551615', '0000000000000000000a']) rejected(TRIP, 'SQLITE_CONSTRAINT_CHECK', ...closed(3, null, 'not-observed', 1n, eventSeq));
    rejected(TRIP, 'SQLITE_CONSTRAINT_FOREIGNKEY', ...closed(3, null, 'not-observed', 999n, SEQ_1));
    sql(TRIP, ...closed(3, null, 'not-observed', 1n, '18446744073709551614'));
  });
  it('ties a job configuration to exactly one event or checkpoint reference of its plugin session', () => {
    const states = specColumns(JOB_FIELDS).filter(column => column.endsWith('_state'));
    const job = `INSERT INTO job_configurations (plugin_session_ref, source, event_ref, checkpoint_next_event_seq, ${states.join(', ')})
      VALUES (?, ?, ?, ?, ${states.map(() => "'not-observed'").join(', ')})`;
    expect(connection.reader().prepare('SELECT plugin_session_ref, source, event_ref, checkpoint_next_event_seq FROM job_configurations').all())
      .toEqual([{plugin_session_ref: 1n, source: 'event', event_ref: 1n, checkpoint_next_event_seq: null}]);
    sql(job, 1n, 'checkpoint', null, '00000000000000000002');
    rejected(job, 'SQLITE_CONSTRAINT_UNIQUE', 1n, 'checkpoint', null, '00000000000000000002');
    rejected(job, 'SQLITE_CONSTRAINT_UNIQUE', 1n, 'event', 1n, null);
    rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'checkpoint', 1n, '00000000000000000003');
    rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'event', null, null);
    rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'event', null, '00000000000000000003');
    rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'checkpoint', null, null);
    rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'replay', null, '00000000000000000003');
    for (const next of ['3', '00000000000000000000', '18446744073709551616']) rejected(job, 'SQLITE_CONSTRAINT_CHECK', 1n, 'checkpoint', null, next);
    rejected(job, 'SQLITE_CONSTRAINT_NOTNULL', null, 'checkpoint', null, '00000000000000000003');
    rejected(job, 'SQLITE_CONSTRAINT_FOREIGNKEY', 999n, 'checkpoint', null, '00000000000000000003');
    rejected(job, 'SQLITE_CONSTRAINT_FOREIGNKEY', 1n, 'event', 999n, null);
  });
});

describe('synthetic and replay data never enter history', () => {
  it('accepts only the origin of the database purpose', async () => {
    const history = await ws.open({path: `${ws.directory}\\history.sqlite`, purpose: 'history'});
    failed(history.upsertSession({message: v1('welcome')}), 'CONSTRAINT_VIOLATION');
    const game = structuredClone(v1('welcome')); game.source.origin = 'game';
    expect(ok(history.upsertSession({message: game})).created).toBe(true);
    const synthetic = new Storage(connection);
    const replayLabel = structuredClone(v1('welcome')); replayLabel.source.pluginSessionId = '10000000-0000-4000-8000-000000000003'; replayLabel.source.origin = 'replay';
    failed(synthetic.upsertSession({message: replayLabel}), 'CONSTRAINT_VIOLATION');
  });
});
