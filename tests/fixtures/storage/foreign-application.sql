-- ET-013 storage fixture: a SQLite database of another application (application_id 1179603534, 'FORN').
-- Opening it must fail with DATABASE_UNRECOGNIZED and leave its bytes unchanged.
-- Provenance: created once on October 15, 2026 the same way as schema-v1-representative.sqlite. Never regenerate it.
PRAGMA application_id = 1179603534;
PRAGMA user_version = 3;
CREATE TABLE other_application (id INTEGER PRIMARY KEY, value TEXT);
INSERT INTO other_application (id, value) VALUES (1, 'not ours');
