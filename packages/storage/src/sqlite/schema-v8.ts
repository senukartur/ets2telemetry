// Schema version 8 (ET-062): HaulMP multiplayer mode support for ETS2.
// Rebuilds plugin_sessions and trips using SQLite's 12-step procedure to extend
// the game_mode CHECK constraint with 'haulmp'.
// Foreign keys and triggers are restored; all rows and identifiers are preserved.

const HEX = (n: number) => '[0-9a-f]'.repeat(n);
const UUID_GLOB = `'${HEX(8)}-${HEX(4)}-${HEX(4)}-${HEX(4)}-${HEX(12)}'`;
const uuid = (c: string) => `${c} TEXT NOT NULL CHECK (${c} GLOB ${UUID_GLOB})`;
const GAMES = `'ets2', 'ats'`;
const ORIGINS = `'game', 'synthetic', 'replay'`;
const GAME_MODES = `'single-player', 'truckersmp', 'haulmp', 'unknown', 'convoy'`;
const METHODS = `'module-scan', 'process-scan', 'none'`;
const CONFIDENCES = `'strong', 'weak', 'none'`;
const isKey = (c: string) => `(length(${c}) = 20 AND ${c} NOT GLOB '*[^0-9]*' AND ${c} <= '18446744073709551615')`;
const key = (c: string) => `${c} TEXT NOT NULL CHECK ${isKey(c)}`;
const optionalKey = (c: string) => `${c} TEXT CHECK (${c} IS NULL OR ${isKey(c)})`;
const u16 = (c: string) => `${c} INTEGER NOT NULL CHECK (${c} BETWEEN 0 AND 65535)`;
const STATES = `'available', 'not-observed', 'not-supported', 'invalid'`;
const avail = (c: string, type: string, check?: string) =>
  `${c} ${type}${check ? ` CHECK (${check})` : ''}, ${c}_state TEXT NOT NULL CHECK (${c}_state IN (${STATES})) CHECK ((${c}_state = 'available') = (${c} IS NOT NULL))`;
const text = (c: string) => avail(c, 'TEXT');

const SESSION_COLUMNS = [
  'id', 'plugin_session_uuid', 'game', 'origin', 'process_instance_uuid', 'process_id', 'windows_session_id',
  'protocol_major', 'protocol_minor', 'telemetry_api_major', 'telemetry_api_minor', 'game_telemetry_major',
  'game_telemetry_minor', 'sdk_archive', 'gameplay_events', 'event_types_json', 'game_mode', 'game_mode_method',
  'game_mode_confidence', 'game_mode_module', 'game_mode_module_state', 'committed_through_event_seq',
  'first_seen_utc_ms', 'end_reason', 'end_next_event_seq'
];

const TRIP_COLUMNS = [
  'id', 'trip_uuid', 'plugin_session_ref', 'game', 'game_mode', 'game_mode_method', 'game_mode_confidence',
  'game_mode_ambiguous', 'job_configuration_ref', 'truck_configuration_ref', 'opened_event_ref', 'opened_by',
  'outcome', 'outcome_event_ref', 'close_reason', 'recording_completeness', 'started_utc_ms', 'ended_utc_ms',
  'observed_distance_m', 'observed_distance_m_state', 'created_utc_ms', 'updated_utc_ms', 'fuel_used_l',
  'fuel_used_l_state', 'closed_by_session_ref', 'closed_by_event_seq', 'is_hard_mode', 'hard_mode_details'
];

const eligible = (trip: string) => `EXISTS(SELECT 1 FROM database_info WHERE id=1 AND purpose='history')
  AND EXISTS(SELECT 1 FROM plugin_sessions WHERE id=${trip}.plugin_session_ref AND origin='game')`;

export const SCHEMA_V8: readonly string[] = [
  'DROP TRIGGER IF EXISTS upload_trip_created',
  // 1. Rebuild plugin_sessions with 'haulmp' in GAME_MODES
  `CREATE TABLE new_plugin_sessions (id INTEGER PRIMARY KEY, ${uuid('plugin_session_uuid')} UNIQUE, game TEXT NOT NULL CHECK (game IN (${GAMES})),
    origin TEXT NOT NULL CHECK (origin IN (${ORIGINS})), ${uuid('process_instance_uuid')},
    process_id INTEGER NOT NULL CHECK (process_id BETWEEN 1 AND 4294967295), windows_session_id INTEGER NOT NULL CHECK (windows_session_id BETWEEN 0 AND 4294967295),
    protocol_major INTEGER NOT NULL CHECK (protocol_major = 1), ${u16('protocol_minor')},
    ${u16('telemetry_api_major')}, ${u16('telemetry_api_minor')}, ${u16('game_telemetry_major')}, ${u16('game_telemetry_minor')},
    sdk_archive TEXT NOT NULL CHECK (length(sdk_archive) BETWEEN 1 AND 128), gameplay_events TEXT NOT NULL CHECK (gameplay_events IN ('registered', 'not-supported')),
    event_types_json TEXT NOT NULL CHECK (json_valid(event_types_json)),
    game_mode TEXT NOT NULL CHECK (game_mode IN (${GAME_MODES})), game_mode_method TEXT NOT NULL CHECK (game_mode_method IN (${METHODS})),
    game_mode_confidence TEXT NOT NULL CHECK (game_mode_confidence IN (${CONFIDENCES})), ${text('game_mode_module')},
    ${key('committed_through_event_seq')}, first_seen_utc_ms INTEGER NOT NULL CHECK (first_seen_utc_ms >= 0),
    end_reason TEXT CHECK (end_reason IN ('plugin-shutdown', 'sequence-exhausted', 'source-retired')), ${optionalKey('end_next_event_seq')},
    CHECK ((end_reason IS NULL) = (end_next_event_seq IS NULL))) STRICT`,
  `INSERT INTO new_plugin_sessions (${SESSION_COLUMNS.join(', ')}) SELECT ${SESSION_COLUMNS.join(', ')} FROM plugin_sessions ORDER BY id`,
  'DROP TABLE plugin_sessions',
  'ALTER TABLE new_plugin_sessions RENAME TO plugin_sessions',
  `CREATE TRIGGER plugin_sessions_origin BEFORE INSERT ON plugin_sessions WHEN NEW.origin IS NOT (SELECT accepted_origin FROM database_info WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'plugin session origin is not accepted by this database'); END`,
  `CREATE TRIGGER plugin_sessions_identity BEFORE UPDATE OF plugin_session_uuid, game, origin, process_instance_uuid, process_id, windows_session_id ON plugin_sessions
    BEGIN SELECT RAISE(ABORT, 'plugin session identity is immutable'); END`,

  // 2. Rebuild trips with 'haulmp' in GAME_MODES
  `CREATE TABLE new_trips (id INTEGER PRIMARY KEY, ${uuid('trip_uuid')} UNIQUE, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    game TEXT NOT NULL CHECK (game IN (${GAMES})), game_mode TEXT NOT NULL CHECK (game_mode IN (${GAME_MODES})),
    game_mode_method TEXT NOT NULL CHECK (game_mode_method IN (${METHODS})), game_mode_confidence TEXT NOT NULL CHECK (game_mode_confidence IN (${CONFIDENCES})),
    game_mode_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (game_mode_ambiguous IN (0, 1)),
    job_configuration_ref INTEGER NOT NULL REFERENCES job_configurations (id), truck_configuration_ref INTEGER REFERENCES truck_configurations (id),
    opened_event_ref INTEGER REFERENCES events (id), opened_by TEXT NOT NULL CHECK (opened_by IN ('event', 'checkpoint')),
    outcome TEXT NOT NULL CHECK (outcome IN ('open', 'delivered', 'cancelled', 'none')), outcome_event_ref INTEGER REFERENCES events (id),
    close_reason TEXT CHECK (close_reason IN ('outcome', 'configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap')),
    recording_completeness TEXT NOT NULL CHECK (recording_completeness IN ('complete', 'partial', 'unknown')),
    started_utc_ms INTEGER NOT NULL CHECK (started_utc_ms >= 0), ended_utc_ms INTEGER CHECK (ended_utc_ms >= started_utc_ms),
    ${avail('observed_distance_m', 'REAL', 'observed_distance_m >= 0')},
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), updated_utc_ms INTEGER NOT NULL CHECK (updated_utc_ms >= created_utc_ms),
    fuel_used_l REAL CHECK (fuel_used_l IS NULL OR fuel_used_l >= 0),
    fuel_used_l_state TEXT NOT NULL DEFAULT 'not-observed' CHECK (fuel_used_l_state IN (${STATES})) CHECK ((fuel_used_l_state = 'available') = (fuel_used_l IS NOT NULL)),
    closed_by_session_ref INTEGER REFERENCES plugin_sessions (id),
    closed_by_event_seq TEXT CHECK (closed_by_event_seq IS NULL OR (${isKey('closed_by_event_seq')} AND closed_by_event_seq > '00000000000000000000' AND closed_by_event_seq <= '18446744073709551614')),
    is_hard_mode INTEGER NOT NULL DEFAULT 0 CHECK (is_hard_mode IN (0, 1)),
    hard_mode_details TEXT CHECK (hard_mode_details IS NULL OR (length(hard_mode_details) <= 16384 AND json_valid(hard_mode_details))),
    CHECK ((outcome = 'open') = (close_reason IS NULL)), CHECK ((outcome IN ('delivered', 'cancelled')) = (outcome_event_ref IS NOT NULL)),
    CHECK ((outcome = 'open') = (ended_utc_ms IS NULL)),
    CHECK ((opened_by = 'event' AND opened_event_ref IS NOT NULL) OR (opened_by = 'checkpoint' AND opened_event_ref IS NULL)),
    CHECK ((closed_by_session_ref IS NULL) = (closed_by_event_seq IS NULL)), CHECK (closed_by_event_seq IS NULL OR outcome <> 'open')) STRICT`,
  `INSERT INTO new_trips (${TRIP_COLUMNS.join(', ')}) SELECT ${TRIP_COLUMNS.join(', ')} FROM trips ORDER BY id`,
  'DROP TABLE trips',
  'ALTER TABLE new_trips RENAME TO trips',
  `CREATE TRIGGER upload_trip_created AFTER INSERT ON trips WHEN ${eligible('NEW')} BEGIN
    INSERT INTO upload_candidates(ordinal,trip_ref,trip_uuid,opening_registration,opening_run)
      SELECT next_ordinal,NEW.id,NEW.trip_uuid,active_registration,active_run FROM upload_connection WHERE id=1;
    UPDATE upload_connection SET next_ordinal=next_ordinal+1 WHERE id=1; END`
];
