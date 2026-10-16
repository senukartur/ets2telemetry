// Schema version 2 (ET-016, J6): the statements of migration 0002-journal, applied on top of the frozen version 1 text.
// FROZEN once released: a version 2 database is defined by schema-v1.ts followed by exactly these statements, and the
// committed fixture tests/fixtures/storage/schema-v2-representative.sqlite must keep matching it. Never edit it, and
// never import helpers from schema-v1.ts or the codec: a later change there must not change this text. Change the
// schema in a new migration. See docs/storage.md, "Schema version 2".
//
// The steps run in one transaction with foreign keys off (the migration declares `foreignKeysOff`), because
// job_configurations is rebuilt with SQLite's 12-step procedure (https://www.sqlite.org/lang_altertable.html#otheralter):
// create the new table, copy every row, drop the old table, rename the new one. The framework runs foreign_key_check
// and quick_check before the commit. trips only gains columns (ALTER TABLE ADD COLUMN), so its triggers, indexes and
// the references of other tables are untouched. No index is added (J6).

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

export const SCHEMA_V2: readonly string[] = [
  // S-1: fuel used by the trip in litres, persisted like observed distance (J8). Every existing row is not observed.
  'ALTER TABLE trips ADD COLUMN fuel_used_l REAL CHECK (fuel_used_l IS NULL OR fuel_used_l >= 0)',
  `ALTER TABLE trips ADD COLUMN fuel_used_l_state TEXT NOT NULL DEFAULT 'not-observed' CHECK (fuel_used_l_state IN (${STATES})) CHECK ((fuel_used_l_state = 'available') = (fuel_used_l IS NOT NULL))`,
  // The close carrier (J7): the plugin session and eventSeq of the event or gap whose commit closed the trip. Both are
  // NULL while the trip is open and for trips closed under version 1, whose carrier was not recorded.
  'ALTER TABLE trips ADD COLUMN closed_by_session_ref INTEGER REFERENCES plugin_sessions (id)',
  `ALTER TABLE trips ADD COLUMN closed_by_event_seq TEXT CHECK (closed_by_event_seq IS NULL OR (${isKey('closed_by_event_seq')} AND closed_by_event_seq > '00000000000000000000' AND closed_by_event_seq <= '18446744073709551614'))` +
    ` CHECK ((closed_by_session_ref IS NULL) = (closed_by_event_seq IS NULL)) CHECK (closed_by_event_seq IS NULL OR outcome <> 'open')`,
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
];
