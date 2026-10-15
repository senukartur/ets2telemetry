-- ET-013 storage fixture: a database with this application's id (1163154226, 'ETS2') and schema version 999,
-- newer than any supported version. Opening it must fail with SCHEMA_NEWER and leave its bytes unchanged.
-- Provenance: created once on October 15, 2026 the same way as schema-v1-representative.sqlite. Never regenerate it.
PRAGMA application_id = 1163154226;
PRAGMA user_version = 999;
CREATE TABLE future_data (id INTEGER PRIMARY KEY, note TEXT NOT NULL) STRICT;
INSERT INTO future_data (id, note) VALUES (1, 'written by a newer schema');
