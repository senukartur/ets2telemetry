// Schema version 2 (ET-016, J6): the statements of migration 0002-journal, applied on top of the frozen version 1 text.
// FROZEN once released: a version 2 database is defined by schema-v1.ts followed by exactly these statements, and the
// committed fixture tests/fixtures/storage/schema-v2-representative.sqlite must keep matching it. Never edit it, and
// never import helpers from schema-v1.ts or the codec: a later change there must not change this text. Change the
// schema in a new migration. See docs/storage.md, "Schema version 2".
//
// job_configurations and trips are rebuilt with SQLite's 12-step procedure
// (https://www.sqlite.org/lang_altertable.html#otheralter): create the new table, copy every row with its id, drop the
// old table, rename the new one. Other tables reference both tables by name (trips, trip_trailers, event_attributions,
// completeness_intervals and samples), so those references resolve to the rebuilt tables unchanged; no trigger or view
// names either table. On an upgrade the steps run in one transaction with foreign keys off (the migration declares
// `foreignKeysOff`), and the framework runs foreign_key_check and quick_check before the commit. A new database runs
// every step in one transaction with foreign keys on, which is harmless because its tables are still empty.
// No index is added beyond the implicit index of each rebuilt table's UNIQUE constraints: trips keeps its trip_uuid
// UNIQUE index (sqlite_autoindex_trips_1) and job_configurations gains one for
// UNIQUE (plugin_session_ref, checkpoint_next_event_seq) (J6).

const HEX = (n: number) => '[0-9a-f]'.repeat(n);
const UUID_GLOB = `'${HEX(8)}-${HEX(4)}-${HEX(4)}-${HEX(4)}-${HEX(12)}'`;
const uuid = (c: string) => `${c} TEXT NOT NULL CHECK (${c} GLOB ${UUID_GLOB})`;
const GAMES = `'ets2', 'ats'`;
const GAME_MODES = `'single-player', 'truckersmp', 'unknown', 'convoy'`;
const METHODS = `'module-scan', 'process-scan', 'none'`;
const CONFIDENCES = `'strong', 'weak', 'none'`;
/** A wire uint64 as a 20-digit zero-padded decimal, as in version 1. */
const isKey = (c: string) => `(length(${c}) = 20 AND ${c} NOT GLOB '*[^0-9]*' AND ${c} <= '18446744073709551615')`;
const STATES = `'available', 'not-observed', 'not-supported', 'invalid'`;
/** A value column and its availability state, written exactly as version 1 writes them. */
const avail = (c: string, type: string, check?: string) =>
  `${c} ${type}${check ? ` CHECK (${check})` : ''}, ${c}_state TEXT NOT NULL CHECK (${c}_state IN (${STATES})) CHECK ((${c}_state = 'available') = (${c} IS NOT NULL))`;
const text = (c: string) => avail(c, 'TEXT');
const flag = (c: string) => avail(c, 'INTEGER', `${c} IN (0, 1)`);
const minutes = (c: string) => avail(c, 'INTEGER', `${c} BETWEEN 0 AND 4294967295`);
const digits = (r: string) => `substr(${r}, 2) NOT GLOB '*[^0-9]*'`;
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

/** The normalized job columns of version 1, in table order; the rebuild copies each of them unchanged. */
const JOB_TEXT = ['source_city_id', 'source_city', 'source_company_id', 'source_company', 'destination_city_id', 'destination_city', 'destination_company_id', 'destination_company', 'cargo_id', 'cargo'];
const JOB_COLUMNS = [
  ...JOB_TEXT.flatMap(c => [c, `${c}_state`]),
  ...['cargo_mass_kg', 'cargo_unit_mass_kg', 'cargo_unit_count', 'market', 'is_special_job', 'cargo_loaded', 'planned_distance_m'].flatMap(c => [c, `${c}_state`]),
  ...['raw', 'sdk_type', 'currency_status', 'currency_code', 'currency_source', 'state'].map(suffix => `expected_income_${suffix}`),
  'delivery_deadline_minutes', 'delivery_deadline_minutes_state'
];
/** The trip columns of version 1 except id, in table order; the rebuild copies each of them unchanged. */
const TRIP_COLUMNS = ['trip_uuid', 'plugin_session_ref', 'game', 'game_mode', 'game_mode_method', 'game_mode_confidence', 'game_mode_ambiguous', 'job_configuration_ref',
  'truck_configuration_ref', 'opened_event_ref', 'outcome', 'outcome_event_ref', 'close_reason', 'recording_completeness', 'started_utc_ms', 'ended_utc_ms',
  'observed_distance_m', 'observed_distance_m_state', 'created_utc_ms', 'updated_utc_ms'];

export const SCHEMA_V2: readonly string[] = [
  // S-2: a job configuration comes from a job.configured event of its session or from a checkpoint of that session,
  // keyed by the checkpoint's nextEventSeq (J9). Exactly one reference matches the source.
  `CREATE TABLE new_job_configurations (id INTEGER PRIMARY KEY, plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions (id),
    source TEXT NOT NULL CHECK (source IN ('event', 'checkpoint')), event_ref INTEGER UNIQUE REFERENCES events (id),
    checkpoint_next_event_seq TEXT CHECK (checkpoint_next_event_seq IS NULL OR (${isKey('checkpoint_next_event_seq')} AND checkpoint_next_event_seq > '00000000000000000000')),
    ${JOB_TEXT.map(text).join(', ')},
    ${avail('cargo_mass_kg', 'REAL')}, ${avail('cargo_unit_mass_kg', 'REAL')}, ${avail('cargo_unit_count', 'INTEGER', 'cargo_unit_count BETWEEN 0 AND 4294967295')},
    ${text('market')}, ${flag('is_special_job')}, ${flag('cargo_loaded')}, ${avail('planned_distance_m', 'INTEGER', 'planned_distance_m >= 0')},
    ${money('expected_income')}, ${minutes('delivery_deadline_minutes')},
    CHECK ((source = 'event') = (event_ref IS NOT NULL)), CHECK ((source = 'checkpoint') = (checkpoint_next_event_seq IS NOT NULL)),
    UNIQUE (plugin_session_ref, checkpoint_next_event_seq)) STRICT`,
  // Every version 1 row came from an event. Its session is the session of that event. The verified pre-migration
  // backup already refuses a database whose foreign keys fail; should a row's event still be missing, the LEFT JOIN
  // keeps the row, so the NOT NULL constraint fails the migration instead of dropping it.
  `INSERT INTO new_job_configurations (id, plugin_session_ref, source, event_ref, checkpoint_next_event_seq, ${JOB_COLUMNS.join(', ')})
    SELECT j.id, e.plugin_session_id, 'event', j.event_ref, NULL, ${JOB_COLUMNS.map(c => `j.${c}`).join(', ')} FROM job_configurations j LEFT JOIN events e ON e.id = j.event_ref ORDER BY j.id`,
  'DROP TABLE job_configurations',
  'ALTER TABLE new_job_configurations RENAME TO job_configurations'
,
  // The trip columns of version 1 written exactly as version 1 writes them, except opened_event_ref, which becomes
  // nullable: a late-attach trip opens from a checkpoint, possibly in a session without any event (J9, S-2). opened_by
  // names the opening; fuel used (S-1, J8) and the close carrier (J7) are new. Every version 1 table constraint is kept.
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
    CHECK ((outcome = 'open') = (close_reason IS NULL)), CHECK ((outcome IN ('delivered', 'cancelled')) = (outcome_event_ref IS NOT NULL)),
    CHECK ((outcome = 'open') = (ended_utc_ms IS NULL)),
    CHECK ((opened_by = 'event' AND opened_event_ref IS NOT NULL) OR (opened_by = 'checkpoint' AND opened_event_ref IS NULL)),
    CHECK ((closed_by_session_ref IS NULL) = (closed_by_event_seq IS NULL)), CHECK (closed_by_event_seq IS NULL OR outcome <> 'open')) STRICT`,
  // Every version 1 trip opened at an event. Fuel used takes its default (not observed) and the carrier stays NULL: a
  // version 1 close did not record it. Row ids are kept, so trip_trailers, event_attributions, completeness_intervals
  // and samples keep referencing the same trips.
  `INSERT INTO new_trips (id, ${TRIP_COLUMNS.join(', ')}, opened_by) SELECT id, ${TRIP_COLUMNS.join(', ')}, 'event' FROM trips ORDER BY id`,
  'DROP TABLE trips',
  'ALTER TABLE new_trips RENAME TO trips'
];
