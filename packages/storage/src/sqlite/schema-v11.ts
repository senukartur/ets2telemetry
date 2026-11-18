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
    version TEXT NOT NULL,result_revision TEXT NOT NULL,source_revision INTEGER NOT NULL CHECK(source_revision BETWEEN 1 AND 9007199254740991),
    local_material_digest TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json) AND length(CAST(snapshot_json AS BLOB))<=1048576),
    fetched_at INTEGER NOT NULL CHECK(fetched_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(registration_ref,event_ref,security_scope,version)) STRICT`,
  `CREATE TABLE qualification_result_heads(
    registration_ref TEXT NOT NULL,event_ref TEXT NOT NULL,security_scope TEXT NOT NULL,version TEXT NOT NULL,
    PRIMARY KEY(registration_ref,event_ref,security_scope),
    FOREIGN KEY(registration_ref,event_ref,security_scope,version) REFERENCES qualification_result_versions(registration_ref,event_ref,security_scope,version)) STRICT`,
  `CREATE TABLE qualification_refresh_state(
    registration_ref TEXT PRIMARY KEY REFERENCES upload_registrations(registration_id),security_scope TEXT NOT NULL,
    connection_version TEXT NOT NULL,after_event TEXT, retry_at INTEGER NOT NULL DEFAULT 0 CHECK(retry_at BETWEEN 0 AND 9007199254740991),
    failure_streak INTEGER NOT NULL DEFAULT 0 CHECK(failure_streak BETWEEN 0 AND 9),
    suspended INTEGER NOT NULL DEFAULT 0 CHECK(suspended IN (0,1))) STRICT`,
  'CREATE INDEX qualification_result_event ON qualification_result_versions(event_ref,registration_ref,security_scope)',
  'CREATE INDEX qualification_refresh_due ON qualification_refresh_state(retry_at,registration_ref)',
  'CREATE INDEX qualification_source_page ON upload_envelopes(registration_ref,event_id)',
  `CREATE TRIGGER qualification_result_immutable BEFORE UPDATE ON qualification_result_versions BEGIN SELECT RAISE(ABORT,'immutable qualification result'); END`
];
