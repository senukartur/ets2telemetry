// Schema version 1 (ET-013). FROZEN: a version 1 database is defined by exactly this text, and the committed fixture
// tests/fixtures/storage/schema-v1-representative.sqlite must keep matching it. Never edit it; change the schema in a
// new migration. Tables are STRICT: SQLite refuses a value that cannot become its column's type. See docs/storage.md.

const HEX = (n: number) => '[0-9a-f]'.repeat(n);
const UUID_GLOB = `'${HEX(8)}-${HEX(4)}-${HEX(4)}-${HEX(4)}-${HEX(12)}'`;
const uuid = (c: string) => `${c} TEXT NOT NULL CHECK (${c} GLOB ${UUID_GLOB})`;
/** A wire uint64 as a 20-digit zero-padded decimal: exact, and text order equals numeric order. */
const isKey = (c: string) => `(length(${c}) = 20 AND ${c} NOT GLOB '*[^0-9]*' AND ${c} <= '18446744073709551615')`;
const key = (c: string) => `${c} TEXT NOT NULL CHECK ${isKey(c)}`;
const optionalKey = (c: string) => `${c} TEXT CHECK (${c} IS NULL OR ${isKey(c)})`;
const eventSeq = (c: string) => `${c} TEXT NOT NULL CHECK (${isKey(c)} AND ${c} > '00000000000000000000' AND ${c} <= '18446744073709551614')`;
const STATES = `'available', 'not-observed', 'not-supported', 'invalid'`;
/**
 * A value column and its availability state; the value is present exactly when the state is `available`. Cross-column
 * checks are column constraints here, because SQLite allows table constraints only after the last column.
 */
const avail = (c: string, type: string, check?: string) =>
  `${c} ${type}${check ? ` CHECK (${check})` : ''}, ${c}_state TEXT NOT NULL CHECK (${c}_state IN (${STATES})) CHECK ((${c}_state = 'available') = (${c} IS NOT NULL))`;
const text = (c: string) => avail(c, 'TEXT');
const flag = (c: string) => avail(c, 'INTEGER', `${c} IN (0, 1)`);
const minutes = (c: string) => avail(c, 'INTEGER', `${c} BETWEEN 0 AND 4294967295`);
const digits = (r: string) => `substr(${r}, 2) NOT GLOB '*[^0-9]*'`;
/** Raw SDK money: canonical decimal text with its SDK type, never a float. The codec range-checks it with BigInt. */
function money(p: string) {
  const r = `${p}_raw`, t = `${p}_sdk_type`;
  const shape = `(${t} = 'u64' AND (${r} = '0' OR (${r} GLOB '[1-9]*' AND length(${r}) <= 20 AND ${digits(r)}))) OR ` +
    `(${t} = 's64' AND (${r} = '0' OR (${r} GLOB '[1-9]*' AND length(${r}) <= 19 AND ${digits(r)}) OR (${r} GLOB '-[1-9]*' AND length(${r}) <= 20 AND ${digits(r)})))`;
  return [
    `${r} TEXT CHECK (${shape})`, `${t} TEXT CHECK (${t} IN ('s64', 'u64'))`,
    `${p}_currency_status TEXT CHECK (${p}_currency_status IN ('unknown', 'sdk-documented'))`,
    `${p}_currency_code TEXT CHECK (${p}_currency_code GLOB '[A-Z][A-Z][A-Z]')`,
    `${p}_currency_source TEXT CHECK (length(${p}_currency_source) BETWEEN 1 AND 128)`,
    `${p}_state TEXT NOT NULL CHECK (${p}_state IN (${STATES}))` +
      ` CHECK ((${p}_state = 'available') = (${r} IS NOT NULL) AND (${r} IS NULL) = (${t} IS NULL) AND (${r} IS NULL) = (${p}_currency_status IS NULL))` +
      ` CHECK ((${p}_currency_status IS 'sdk-documented') = (${p}_currency_code IS NOT NULL) AND (${p}_currency_code IS NULL) = (${p}_currency_source IS NULL))`
  ].join(', ');
}
const immutable = (table: string) => [
  `CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows are immutable'); END`,
  `CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table} rows are immutable'); END`
];
const GAMES = `'ets2', 'ats'`;
const ORIGINS = `'game', 'synthetic', 'replay'`;
// Enumerations match protocol minor 0, including values reserved for later minors (game mode `convoy`).
const GAME_MODES = `'single-player', 'truckersmp', 'unknown', 'convoy'`;
const METHODS = `'module-scan', 'process-scan', 'none'`;
const CONFIDENCES = `'strong', 'weak', 'none'`;
const EVENT_TYPES = ['job.configured', 'job.cleared', 'truck.configured', 'truck.cleared', 'trailer.configured', 'trailer.cleared',
  'simulation.paused', 'simulation.started', 'timers.restart', 'gameTime.regression', 'job.delivered', 'job.cancelled',
  'player.fined', 'player.tollgate.paid', 'player.use.ferry', 'player.use.train', 'source.gameMode'].map(t => `'${t}'`).join(', ');
const u16 = (c: string) => `${c} INTEGER NOT NULL CHECK (${c} BETWEEN 0 AND 65535)`;
const SAMPLE_BITS: [string, number][] = [['speed_mps', 1], ['fuel_l', 2], ['avg_consumption_l100km', 4], ['range_m', 8], ['engine_rpm', 16], ['gear', 32], ['odometer_m', 64], ['x', 128], ['y', 128], ['z', 128], ['game_minutes', 256]];

export const SCHEMA_V1: readonly string[] = [
  `CREATE TABLE database_info (id INTEGER PRIMARY KEY CHECK (id = 1), ${uuid('database_uuid')},
    purpose TEXT NOT NULL CHECK (purpose IN ('history', 'synthetic', 'replay')), accepted_origin TEXT NOT NULL CHECK (accepted_origin IN (${ORIGINS})),
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), created_app_version TEXT NOT NULL CHECK (length(created_app_version) BETWEEN 1 AND 64),
    CHECK ((purpose = 'history' AND accepted_origin = 'game') OR (purpose = 'synthetic' AND accepted_origin = 'synthetic') OR (purpose = 'replay' AND accepted_origin = 'replay'))) STRICT`,
  ...immutable('database_info'),
  `CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY CHECK (version >= 1), name TEXT NOT NULL, applied_utc_ms INTEGER NOT NULL CHECK (applied_utc_ms >= 0),
    app_version TEXT NOT NULL, backup_file_name TEXT, backup_sha256 TEXT CHECK (length(backup_sha256) = 64 AND backup_sha256 NOT GLOB '*[^0-9a-f]*'),
    CHECK ((backup_file_name IS NULL) = (backup_sha256 IS NULL))) STRICT`,
  `CREATE TABLE plugin_sessions (id INTEGER PRIMARY KEY, ${uuid('plugin_session_uuid')} UNIQUE, game TEXT NOT NULL CHECK (game IN (${GAMES})),
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
  // A database accepts exactly one origin, so synthetic or replay sessions can never enter history.
  `CREATE TRIGGER plugin_sessions_origin BEFORE INSERT ON plugin_sessions WHEN NEW.origin IS NOT (SELECT accepted_origin FROM database_info WHERE id = 1)
    BEGIN SELECT RAISE(ABORT, 'plugin session origin is not accepted by this database'); END`,
  `CREATE TRIGGER plugin_sessions_identity BEFORE UPDATE OF plugin_session_uuid, game, origin, process_instance_uuid, process_id, windows_session_id ON plugin_sessions
    BEGIN SELECT RAISE(ABORT, 'plugin session identity is immutable'); END`,
  `CREATE TABLE clocks (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    kind TEXT NOT NULL CHECK (kind IN ('source-monotonic', 'game')), ${uuid('clock_uuid')}, UNIQUE (plugin_session_ref, kind, clock_uuid)) STRICT`,
  `CREATE TABLE events (id INTEGER PRIMARY KEY, plugin_session_id INTEGER NOT NULL REFERENCES plugin_sessions (id), ${eventSeq('event_seq')},
    type TEXT NOT NULL CHECK (type IN (${EVENT_TYPES})),
    ${avail('occurred_monotonic_ns', 'TEXT', isKey('occurred_monotonic_ns'))}, source_clock_ref INTEGER NOT NULL REFERENCES clocks (id),
    ${minutes('occurred_game_minutes')}, occurred_game_clock_ref INTEGER NOT NULL REFERENCES clocks (id),
    ${avail('occurred_utc_ms', 'TEXT', isKey('occurred_utc_ms'))}, occurred_simulation TEXT NOT NULL CHECK (occurred_simulation IN ('running', 'paused', 'unavailable')),
    ${key('configuration_revision')}, ${key('boundary_order')}, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    ${u16('protocol_minor')}, first_redelivered INTEGER NOT NULL CHECK (first_redelivered IN (0, 1)), committed_utc_ms INTEGER NOT NULL CHECK (committed_utc_ms >= 0),
    UNIQUE (plugin_session_id, event_seq)) STRICT`,
  ...immutable('events'),
  `CREATE TABLE event_gaps (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    ${eventSeq('first_event_seq')}, ${eventSeq('last_event_seq')},
    ${['offline', 'no_durable_consumer', 'queue_count', 'queue_bytes', 'retention_expired', 'encoding_failed'].map(c => key(`cause_${c}`)).join(', ')},
    ${avail('first_lost_monotonic_ns', 'TEXT', isKey('first_lost_monotonic_ns'))}, ${avail('last_lost_monotonic_ns', 'TEXT', isKey('last_lost_monotonic_ns'))},
    source_clock_ref INTEGER NOT NULL REFERENCES clocks (id), redelivered INTEGER NOT NULL CHECK (redelivered IN (0, 1)),
    committed_utc_ms INTEGER NOT NULL CHECK (committed_utc_ms >= 0), CHECK (first_event_seq <= last_event_seq), UNIQUE (plugin_session_ref, first_event_seq, last_event_seq)) STRICT`,
  ...immutable('event_gaps'),
  `CREATE TABLE job_configurations (id INTEGER PRIMARY KEY, event_ref INTEGER NOT NULL UNIQUE REFERENCES events (id),
    ${['source_city_id', 'source_city', 'source_company_id', 'source_company', 'destination_city_id', 'destination_city', 'destination_company_id', 'destination_company', 'cargo_id', 'cargo'].map(text).join(', ')},
    ${avail('cargo_mass_kg', 'REAL')}, ${avail('cargo_unit_mass_kg', 'REAL')}, ${avail('cargo_unit_count', 'INTEGER', 'cargo_unit_count BETWEEN 0 AND 4294967295')},
    ${text('market')}, ${flag('is_special_job')}, ${flag('cargo_loaded')}, ${avail('planned_distance_m', 'INTEGER', 'planned_distance_m >= 0')},
    ${money('expected_income')}, ${minutes('delivery_deadline_minutes')}) STRICT`,
  `CREATE TABLE truck_configurations (id INTEGER PRIMARY KEY, event_ref INTEGER NOT NULL UNIQUE REFERENCES events (id),
    ${['brand_id', 'brand', 'model_id', 'model_name'].map(text).join(', ')}, ${avail('fuel_capacity_l', 'REAL')},
    ${['license_plate', 'plate_country_id', 'plate_country'].map(text).join(', ')}) STRICT`,
  `CREATE TABLE trailer_configurations (id INTEGER PRIMARY KEY, event_ref INTEGER NOT NULL UNIQUE REFERENCES events (id),
    slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 9),
    ${['trailer_id', 'body_type', 'chain_type', 'cargo_accessory_id', 'brand_id', 'brand', 'name', 'license_plate', 'plate_country_id', 'plate_country'].map(text).join(', ')}) STRICT`,
  `CREATE TABLE event_amounts (event_ref INTEGER PRIMARY KEY REFERENCES events (id), ${money('amount')}) STRICT`,
  `CREATE TABLE job_deliveries (event_ref INTEGER PRIMARY KEY REFERENCES events (id),
    ${avail('earned_xp', 'INTEGER', 'earned_xp BETWEEN -2147483648 AND 2147483647')}, ${avail('cargo_damage', 'REAL')}, ${avail('distance_m', 'REAL')},
    ${minutes('delivery_duration_minutes')}, ${flag('auto_park_used')}, ${flag('auto_load_used')}) STRICT`,
  `CREATE TABLE trips (id INTEGER PRIMARY KEY, ${uuid('trip_uuid')} UNIQUE, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    game TEXT NOT NULL CHECK (game IN (${GAMES})), game_mode TEXT NOT NULL CHECK (game_mode IN (${GAME_MODES})),
    game_mode_method TEXT NOT NULL CHECK (game_mode_method IN (${METHODS})), game_mode_confidence TEXT NOT NULL CHECK (game_mode_confidence IN (${CONFIDENCES})),
    game_mode_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK (game_mode_ambiguous IN (0, 1)),
    job_configuration_ref INTEGER NOT NULL REFERENCES job_configurations (id), truck_configuration_ref INTEGER REFERENCES truck_configurations (id),
    opened_event_ref INTEGER NOT NULL REFERENCES events (id),
    outcome TEXT NOT NULL CHECK (outcome IN ('open', 'delivered', 'cancelled', 'none')), outcome_event_ref INTEGER REFERENCES events (id),
    close_reason TEXT CHECK (close_reason IN ('outcome', 'configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap')),
    recording_completeness TEXT NOT NULL CHECK (recording_completeness IN ('complete', 'partial', 'unknown')),
    started_utc_ms INTEGER NOT NULL CHECK (started_utc_ms >= 0), ended_utc_ms INTEGER CHECK (ended_utc_ms >= started_utc_ms),
    ${avail('observed_distance_m', 'REAL', 'observed_distance_m >= 0')},
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), updated_utc_ms INTEGER NOT NULL CHECK (updated_utc_ms >= created_utc_ms),
    CHECK ((outcome = 'open') = (close_reason IS NULL)), CHECK ((outcome IN ('delivered', 'cancelled')) = (outcome_event_ref IS NOT NULL)),
    CHECK ((outcome = 'open') = (ended_utc_ms IS NULL))) STRICT`,
  `CREATE TABLE trip_trailers (trip_ref INTEGER NOT NULL REFERENCES trips (id), trailer_configuration_ref INTEGER NOT NULL REFERENCES trailer_configurations (id),
    PRIMARY KEY (trip_ref, trailer_configuration_ref)) STRICT`,
  `CREATE TABLE event_attributions (event_ref INTEGER PRIMARY KEY REFERENCES events (id), trip_ref INTEGER REFERENCES trips (id),
    attribution TEXT NOT NULL CHECK (attribution IN ('trip', 'trip-before-loaded', 'free-driving', 'ambiguous')),
    CHECK ((trip_ref IS NULL) = (attribution IN ('free-driving', 'ambiguous')))) STRICT`,
  `CREATE TABLE completeness_intervals (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id), trip_ref INTEGER REFERENCES trips (id),
    kind TEXT NOT NULL CHECK (kind IN ('event-loss', 'not-connected', 'storage-unavailable', 'sample-loss', 'discontinuity', 'restore-loss')),
    start_utc_ms INTEGER CHECK (start_utc_ms >= 0), end_utc_ms INTEGER CHECK (end_utc_ms >= start_utc_ms),
    ${optionalKey('start_monotonic_ns')}, ${optionalKey('end_monotonic_ns')}, source_clock_ref INTEGER REFERENCES clocks (id),
    ${optionalKey('first_event_seq')}, ${optionalKey('last_event_seq')}, detail_json TEXT CHECK (json_valid(detail_json)),
    created_utc_ms INTEGER NOT NULL CHECK (created_utc_ms >= 0), CHECK (end_monotonic_ns >= start_monotonic_ns),
    CHECK ((start_monotonic_ns IS NULL AND end_monotonic_ns IS NULL) OR source_clock_ref IS NOT NULL), CHECK (last_event_seq >= first_event_seq)) STRICT`,
  // Samples keep compact numeric references; UUIDs live once in their entity rows. NULL without a mask bit is not observed.
  `CREATE TABLE samples (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id), trip_ref INTEGER REFERENCES trips (id),
    utc_ms INTEGER NOT NULL CHECK (utc_ms >= 0), source_clock_ref INTEGER NOT NULL REFERENCES clocks (id), monotonic_ns INTEGER NOT NULL CHECK (monotonic_ns >= 0),
    game_minutes INTEGER CHECK (game_minutes BETWEEN 0 AND 4294967295), game_clock_ref INTEGER REFERENCES clocks (id),
    speed_mps REAL, fuel_l REAL, avg_consumption_l100km REAL, range_m REAL, engine_rpm REAL, gear INTEGER, odometer_m REAL, x REAL, y REAL, z REAL,
    not_supported_mask INTEGER NOT NULL DEFAULT 0 CHECK (not_supported_mask BETWEEN 0 AND 511),
    invalid_mask INTEGER NOT NULL DEFAULT 0 CHECK (invalid_mask BETWEEN 0 AND 511),
    CHECK (game_minutes IS NULL OR game_clock_ref IS NOT NULL), CHECK ((x IS NULL) = (y IS NULL) AND (y IS NULL) = (z IS NULL)), CHECK ((not_supported_mask & invalid_mask) = 0),
    ${SAMPLE_BITS.map(([c, bit]) => `CHECK (((not_supported_mask | invalid_mask) & ${bit}) = 0 OR ${c} IS NULL)`).join(', ')}) STRICT`,
  'CREATE INDEX samples_session ON samples (plugin_session_ref, id)',
  'CREATE INDEX samples_trip ON samples (trip_ref, id) WHERE trip_ref IS NOT NULL',
  'CREATE INDEX event_attributions_trip ON event_attributions (trip_ref)',
  'CREATE INDEX completeness_intervals_trip ON completeness_intervals (trip_ref)',
  'CREATE INDEX completeness_intervals_session ON completeness_intervals (plugin_session_ref)'
];
