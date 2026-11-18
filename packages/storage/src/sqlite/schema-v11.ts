// Companion snapshots inherit immutable upload ownership. No credential bytes or receipt authority live here.
export const SCHEMA_V11: readonly string[] = [
  `CREATE TABLE qualification_cache(
    registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),
    game TEXT NOT NULL CHECK(game IN ('ets2','ats')),security_scope TEXT NOT NULL,
    progress_revision TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=1048576),
    fetched_at INTEGER NOT NULL CHECK(fetched_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(registration_ref,game)) STRICT`,
  `CREATE TABLE qualification_result_versions(
    registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),
    event_ref TEXT NOT NULL REFERENCES upload_envelopes(event_id),security_scope TEXT NOT NULL,
    view_key TEXT NOT NULL CHECK(length(view_key)=64),assessment_key TEXT CHECK(assessment_key IS NULL OR length(assessment_key)=64),source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
    local_material_digest TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=1048576),
    fetched_at INTEGER NOT NULL CHECK(fetched_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(registration_ref,event_ref,security_scope,view_key)) STRICT`,
  `CREATE TABLE qualification_result_heads(
    id INTEGER PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('event','root')),
    registration_ref TEXT NOT NULL,event_ref TEXT NOT NULL,security_scope TEXT NOT NULL,view_key TEXT NOT NULL,
    root_ref INTEGER REFERENCES upload_source_bindings(root_ref),server_version TEXT NOT NULL,result_revision TEXT NOT NULL,generation TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
    latest_event_ref TEXT,latest_view_key TEXT,latest_assessment_key TEXT,
    previous_event_ref TEXT,previous_view_key TEXT,previous_assessment_key TEXT,
    CHECK((kind='event' AND root_ref IS NULL AND latest_event_ref IS NULL AND previous_event_ref IS NULL) OR (kind='root' AND root_ref IS NOT NULL)),
    CHECK((latest_event_ref IS NULL AND latest_view_key IS NULL AND latest_assessment_key IS NULL) OR (latest_event_ref IS NOT NULL AND latest_view_key IS NOT NULL AND latest_assessment_key IS NOT NULL)),
    CHECK((previous_event_ref IS NULL AND previous_view_key IS NULL AND previous_assessment_key IS NULL) OR (previous_event_ref IS NOT NULL AND previous_view_key IS NOT NULL AND previous_assessment_key IS NOT NULL)),
    CHECK(latest_assessment_key IS NULL OR previous_assessment_key IS NULL OR latest_assessment_key<>previous_assessment_key),
    FOREIGN KEY(registration_ref,event_ref,security_scope,view_key) REFERENCES qualification_result_versions(registration_ref,event_ref,security_scope,view_key),
    FOREIGN KEY(registration_ref,latest_event_ref,security_scope,latest_view_key) REFERENCES qualification_result_versions(registration_ref,event_ref,security_scope,view_key),
    FOREIGN KEY(registration_ref,previous_event_ref,security_scope,previous_view_key) REFERENCES qualification_result_versions(registration_ref,event_ref,security_scope,view_key)) STRICT`,
  `CREATE TABLE qualification_refresh_state(
    registration_ref TEXT PRIMARY KEY REFERENCES upload_registrations(registration_id),security_scope TEXT NOT NULL,
    connection_version TEXT NOT NULL,after_event TEXT, retry_at INTEGER NOT NULL DEFAULT 0 CHECK(retry_at BETWEEN 0 AND 9007199254740991),
    preview_pin TEXT UNIQUE REFERENCES upload_projection_pins(pin_id),
    failure_streak INTEGER NOT NULL DEFAULT 0 CHECK(failure_streak BETWEEN 0 AND 9),
    suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1))) STRICT`,
  'CREATE INDEX qualification_result_event ON qualification_result_versions(event_ref,registration_ref,security_scope)',
  "CREATE INDEX qualification_result_transport ON qualification_result_versions(registration_ref,event_ref,security_scope,json_extract(snapshot_json,'$.version'))",
  "CREATE UNIQUE INDEX qualification_event_head ON qualification_result_heads(registration_ref,security_scope,event_ref) WHERE kind='event'",
  "CREATE UNIQUE INDEX qualification_root_head ON qualification_result_heads(registration_ref,security_scope,root_ref) WHERE kind='root'",
  'CREATE INDEX qualification_refresh_due ON qualification_refresh_state(retry_at,registration_ref)',
  'CREATE INDEX qualification_source_page ON upload_envelopes(registration_ref,event_id)',
  `CREATE TRIGGER qualification_result_immutable BEFORE UPDATE ON qualification_result_versions BEGIN SELECT RAISE(ABORT,'immutable qualification result'); END`
];
