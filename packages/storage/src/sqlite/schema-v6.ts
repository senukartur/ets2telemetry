// Local synchronization metadata only. Tokens and protected secret bytes never enter this schema.
const eligible = (trip: string) => `EXISTS(SELECT 1 FROM database_info WHERE id=1 AND purpose='history')
  AND EXISTS(SELECT 1 FROM plugin_sessions WHERE id=${trip}.plugin_session_ref AND origin='game')`;
const rootSet = (alias: string) => `SELECT ${alias}.root_ref AS root`;
const contextChange = (alias: string) => `
  UPDATE upload_connection SET next_change=next_change+1 WHERE id=1;
  INSERT INTO upload_change_heads(root_ref,revision_ref,position,material_version,material_key,dirty)
    SELECT r.logical_ref,r.id,(SELECT next_change-1 FROM upload_connection WHERE id=1),1,'',1 FROM logical_revisions r
    WHERE r.id=(SELECT id FROM logical_revisions WHERE logical_ref=${alias}.root_ref ORDER BY id DESC LIMIT 1)
    AND EXISTS(SELECT 1 FROM upload_candidates WHERE trip_ref=r.logical_ref)
    ON CONFLICT(root_ref) DO UPDATE SET position=excluded.position,material_version=material_version+1,dirty=1,mode='live';
  INSERT INTO upload_source_transitions(position,root_ref,revision_ref,material_version,kind,mode,run_ref)
    SELECT position,root_ref,revision_ref,material_version,'context',mode,run_ref FROM upload_change_heads WHERE root_ref IN (${rootSet(alias)});
  UPDATE upload_source_bindings SET pending=1 WHERE root_ref=${alias}.root_ref;
`;
export const SCHEMA_V6: readonly string[] = [
  'CREATE TABLE upload_installation(id INTEGER PRIMARY KEY CHECK(id=1),client_uuid TEXT NOT NULL UNIQUE) STRICT',
  `CREATE TABLE upload_connection(id INTEGER PRIMARY KEY CHECK(id=1),client_uuid TEXT,
    legacy_boundary INTEGER NOT NULL CHECK(legacy_boundary>=0),next_ordinal INTEGER NOT NULL CHECK(next_ordinal>0),next_change INTEGER NOT NULL CHECK(next_change>0),
    version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),claimed_through INTEGER NOT NULL DEFAULT 0 CHECK(claimed_through>=0),active_registration TEXT REFERENCES upload_registrations(registration_id),credential_generation TEXT,
    active_run TEXT REFERENCES upload_scan_runs(run_id),CHECK((active_registration IS NULL)=(credential_generation IS NULL)),CHECK((active_registration IS NULL)=(active_run IS NULL))) STRICT`,
  `CREATE TABLE upload_registrations(registration_id TEXT PRIMARY KEY,client_uuid TEXT NOT NULL,
    origin TEXT NOT NULL,account_id TEXT NOT NULL,company_id TEXT NOT NULL,identity_epoch TEXT NOT NULL,installation_id TEXT NOT NULL,binding_id TEXT NOT NULL,
    pause_reason TEXT CHECK(pause_reason IN ('authentication','configuration','reconciliation')),UNIQUE(origin,account_id,company_id,identity_epoch)) STRICT`,
  `CREATE TABLE upload_owner_counters(registration_ref TEXT PRIMARY KEY REFERENCES upload_registrations(registration_id),change_after INTEGER NOT NULL DEFAULT 0 CHECK(change_after>=0),pending_sources INTEGER NOT NULL DEFAULT 0 CHECK(pending_sources>=0),
    held_sources INTEGER NOT NULL DEFAULT 0 CHECK(held_sources>=0),queued_events INTEGER NOT NULL DEFAULT 0 CHECK(queued_events>=0),queued_bytes INTEGER NOT NULL DEFAULT 0 CHECK(queued_bytes>=0),delivered_events INTEGER NOT NULL DEFAULT 0 CHECK(delivered_events>=0)) STRICT`,
  `CREATE TABLE upload_scan_runs(run_id TEXT PRIMARY KEY,registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    ordinal_through INTEGER NOT NULL,change_through INTEGER NOT NULL,legacy_after INTEGER NOT NULL DEFAULT 0,ordinal_after INTEGER NOT NULL DEFAULT 0,
    phase TEXT NOT NULL DEFAULT 'legacy' CHECK(phase IN ('legacy','candidates','complete')),examined INTEGER NOT NULL DEFAULT 0 CHECK(examined BETWEEN 0 AND 100)) STRICT`,
  `CREATE TABLE upload_history_claims(first_ordinal INTEGER PRIMARY KEY CHECK(first_ordinal>=0),last_ordinal INTEGER NOT NULL CHECK(last_ordinal>=first_ordinal),
    registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),run_ref TEXT NOT NULL REFERENCES upload_scan_runs(run_id)) STRICT`,
  `CREATE TABLE upload_candidates(ordinal INTEGER PRIMARY KEY CHECK(ordinal>0),trip_ref INTEGER NOT NULL UNIQUE REFERENCES trips(id),trip_uuid TEXT NOT NULL UNIQUE REFERENCES trips(trip_uuid),
    opening_registration TEXT REFERENCES upload_registrations(registration_id),opening_run TEXT REFERENCES upload_scan_runs(run_id)) STRICT`,
  `CREATE TABLE upload_reservations(candidate_ref INTEGER PRIMARY KEY REFERENCES upload_candidates(ordinal),registration_ref TEXT REFERENCES upload_registrations(registration_id),
    run_ref TEXT REFERENCES upload_scan_runs(run_id),mode TEXT NOT NULL CHECK(mode IN ('live','backfill','unbound')),hold_reason TEXT,
    CHECK((registration_ref IS NULL)=(mode='unbound')),CHECK((registration_ref IS NULL)=(run_ref IS NULL))) STRICT`,
  'CREATE INDEX upload_reservations_owner ON upload_reservations(registration_ref,candidate_ref)',
  `CREATE TABLE upload_change_heads(root_ref INTEGER PRIMARY KEY REFERENCES logical_trips(id),revision_ref INTEGER NOT NULL REFERENCES logical_revisions(id),
    position INTEGER NOT NULL,material_version INTEGER NOT NULL CHECK(material_version>0),material_key TEXT NOT NULL,dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','backfill')),run_ref TEXT REFERENCES upload_scan_runs(run_id)) STRICT`,
  'CREATE INDEX upload_change_position ON upload_change_heads(position,root_ref)',
  `CREATE TABLE upload_source_transitions(position INTEGER PRIMARY KEY,root_ref INTEGER NOT NULL REFERENCES logical_trips(id),revision_ref INTEGER NOT NULL REFERENCES logical_revisions(id),
    material_version INTEGER NOT NULL CHECK(material_version>0),kind TEXT NOT NULL CHECK(kind IN ('context','initial','terminal','correction','uncertainty')),mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','backfill')),run_ref TEXT REFERENCES upload_scan_runs(run_id)) STRICT`,
  'CREATE INDEX upload_transition_root ON upload_source_transitions(root_ref,position)',
  'CREATE INDEX upload_transition_kind ON upload_source_transitions(root_ref,kind,position)',
  `CREATE TABLE upload_source_bindings(root_ref INTEGER PRIMARY KEY REFERENCES logical_trips(id),registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),
    run_ref TEXT NOT NULL REFERENCES upload_scan_runs(run_id),mode TEXT NOT NULL CHECK(mode IN ('live','backfill')),game TEXT NOT NULL,plugin_session_uuid TEXT NOT NULL,trip_uuid TEXT NOT NULL UNIQUE,
    http_revision INTEGER NOT NULL DEFAULT 0 CHECK(http_revision BETWEEN 0 AND 9007199254740991),material_digest TEXT,
    terminal INTEGER NOT NULL DEFAULT 0 CHECK(terminal IN (0,1)),compared_version INTEGER NOT NULL DEFAULT 0,
    pending INTEGER NOT NULL DEFAULT 1 CHECK(pending IN (0,1)),held INTEGER NOT NULL DEFAULT 0 CHECK(held IN (0,1)),hold_reason TEXT,
    UNIQUE(game,plugin_session_uuid,trip_uuid)) STRICT`,
  'CREATE INDEX upload_binding_owner ON upload_source_bindings(registration_ref,root_ref)',
  'CREATE INDEX upload_binding_pending ON upload_source_bindings(registration_ref,pending,held,root_ref)',
  `CREATE TABLE upload_materializations(work_id TEXT PRIMARY KEY,root_ref INTEGER NOT NULL REFERENCES logical_trips(id),registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),
    material_version INTEGER NOT NULL CHECK(material_version>0),mode TEXT NOT NULL DEFAULT 'live' CHECK(mode IN ('live','backfill')),run_ref TEXT NOT NULL REFERENCES upload_scan_runs(run_id),pin_id TEXT NOT NULL UNIQUE,state TEXT NOT NULL CHECK(state IN ('preparing','folding','complete','frozen','equal','held','stale')),
    fold_json TEXT CHECK(fold_json IS NULL OR json_valid(fold_json)),pin_json TEXT CHECK(pin_json IS NULL OR json_valid(pin_json)),
    event_ref TEXT REFERENCES upload_envelopes(event_id),pin_released INTEGER NOT NULL DEFAULT 0 CHECK(pin_released IN (0,1)),hold_reason TEXT,examined INTEGER NOT NULL DEFAULT 0 CHECK(examined BETWEEN 0 AND 100),
    UNIQUE(root_ref,material_version)) STRICT`,
  'CREATE INDEX upload_work_resume ON upload_materializations(registration_ref,pin_released,work_id)',
  `CREATE TRIGGER upload_work_immutable BEFORE UPDATE OF work_id,root_ref,registration_ref,material_version,mode,run_ref,pin_id ON upload_materializations BEGIN SELECT RAISE(ABORT,'immutable upload work'); END`,
  `CREATE TRIGGER upload_installation_immutable BEFORE UPDATE ON upload_installation BEGIN SELECT RAISE(ABORT,'immutable upload installation'); END`,
  `CREATE TRIGGER upload_claim_immutable BEFORE UPDATE ON upload_history_claims BEGIN SELECT RAISE(ABORT,'immutable upload claim'); END`,
  `CREATE TRIGGER upload_claim_retained BEFORE DELETE ON upload_history_claims BEGIN SELECT RAISE(ABORT,'retained upload claim'); END`,
  `CREATE TRIGGER upload_candidate_immutable BEFORE UPDATE ON upload_candidates BEGIN SELECT RAISE(ABORT,'immutable upload candidate'); END`,
  `CREATE TRIGGER upload_reservation_identity BEFORE UPDATE OF candidate_ref ON upload_reservations BEGIN SELECT RAISE(ABORT,'immutable reservation identity'); END`,
  `CREATE TABLE upload_envelopes(event_id TEXT PRIMARY KEY,work_ref TEXT NOT NULL UNIQUE REFERENCES upload_materializations(work_id),root_ref INTEGER NOT NULL REFERENCES upload_source_bindings(root_ref),
    registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),mode TEXT NOT NULL CHECK(mode IN ('live','backfill')),revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    payload BLOB,byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 65536),payload_digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','sending','held','delivered')),retry_at INTEGER NOT NULL DEFAULT 0 CHECK(retry_at>=0),hold_reason TEXT,
    UNIQUE(root_ref,revision)) STRICT`,
  'CREATE INDEX upload_envelope_eligible ON upload_envelopes(registration_ref,state,retry_at,event_id)',
  'CREATE INDEX upload_envelope_class ON upload_envelopes(registration_ref,state,mode,retry_at,event_id)',
  'CREATE INDEX upload_envelope_reclaim ON upload_envelopes(state,event_id) WHERE payload IS NOT NULL',
  `CREATE TABLE upload_receipts(event_ref TEXT PRIMARY KEY REFERENCES upload_envelopes(event_id),receipt_id TEXT NOT NULL UNIQUE,first_received INTEGER NOT NULL CHECK(first_received BETWEEN 0 AND 9007199254740991)) STRICT`,
  `CREATE TABLE upload_attempt(attempt_id TEXT PRIMARY KEY,event_ref TEXT NOT NULL REFERENCES upload_envelopes(event_id),registration_ref TEXT NOT NULL REFERENCES upload_registrations(registration_id),
    credential_generation TEXT NOT NULL,connection_version INTEGER NOT NULL,started_at INTEGER NOT NULL CHECK(started_at>=0),active INTEGER NOT NULL CHECK(active IN (0,1)),outcome TEXT) STRICT`,
  'CREATE UNIQUE INDEX upload_attempt_slot ON upload_attempt(active) WHERE active=1',
  `CREATE TABLE upload_queue_usage(id INTEGER PRIMARY KEY CHECK(id=1),events INTEGER NOT NULL CHECK(events BETWEEN 0 AND 10000),bytes INTEGER NOT NULL CHECK(bytes BETWEEN 0 AND 67108864),blocked INTEGER NOT NULL DEFAULT 0 CHECK(blocked IN (0,1))) STRICT`,
  'INSERT INTO upload_queue_usage(id,events,bytes) VALUES(1,0,0)',
  `CREATE TRIGGER upload_envelope_immutable BEFORE UPDATE OF event_id,work_ref,root_ref,registration_ref,mode,revision,byte_count,payload_digest ON upload_envelopes BEGIN SELECT RAISE(ABORT,'immutable upload envelope'); END`,
  `CREATE TRIGGER upload_payload_reclaim BEFORE UPDATE OF payload ON upload_envelopes
    WHEN NEW.payload IS NOT NULL OR NOT EXISTS(SELECT 1 FROM upload_receipts WHERE event_ref=OLD.event_id) BEGIN SELECT RAISE(ABORT,'receipt required before payload reclaim'); END`,
  `CREATE TRIGGER upload_receipt_immutable BEFORE UPDATE ON upload_receipts BEGIN SELECT RAISE(ABORT,'immutable upload receipt'); END`,
  `INSERT INTO upload_connection(id,legacy_boundary,next_ordinal,next_change) SELECT 1,coalesce(max(id),0),coalesce(max(id),0)+1,1 FROM trips`,
  `CREATE TRIGGER upload_registration_immutable BEFORE UPDATE OF registration_id,client_uuid,origin,account_id,company_id,identity_epoch,installation_id,binding_id ON upload_registrations BEGIN SELECT RAISE(ABORT,'immutable upload registration'); END`,
  `CREATE TRIGGER upload_reservation_immutable BEFORE UPDATE ON upload_reservations WHEN OLD.registration_ref IS NOT NULL AND
    (NEW.registration_ref IS NOT OLD.registration_ref OR NEW.run_ref IS NOT OLD.run_ref OR NEW.mode IS NOT OLD.mode) BEGIN SELECT RAISE(ABORT,'immutable opening reservation'); END`,
  `CREATE TRIGGER upload_binding_immutable BEFORE UPDATE OF root_ref,registration_ref,game,plugin_session_uuid,trip_uuid,run_ref,mode ON upload_source_bindings BEGIN SELECT RAISE(ABORT,'immutable upload owner'); END`,
  `CREATE TRIGGER upload_binding_added AFTER INSERT ON upload_source_bindings BEGIN
    UPDATE upload_owner_counters SET pending_sources=pending_sources+NEW.pending,held_sources=held_sources+NEW.held WHERE registration_ref=NEW.registration_ref; END`,
  `CREATE TRIGGER upload_binding_counts AFTER UPDATE OF pending,held ON upload_source_bindings BEGIN
    UPDATE upload_owner_counters SET pending_sources=pending_sources+NEW.pending-OLD.pending,held_sources=held_sources+NEW.held-OLD.held WHERE registration_ref=NEW.registration_ref; END`,
  `CREATE TRIGGER upload_candidate_reserved AFTER INSERT ON upload_candidates BEGIN
    INSERT INTO upload_reservations(candidate_ref,registration_ref,run_ref,mode) VALUES(NEW.ordinal,NEW.opening_registration,NEW.opening_run,CASE WHEN NEW.opening_registration IS NULL THEN 'unbound' ELSE 'live' END); END`,
  `CREATE TRIGGER upload_trip_created AFTER INSERT ON trips WHEN ${eligible('NEW')} BEGIN
    INSERT INTO upload_candidates(ordinal,trip_ref,trip_uuid,opening_registration,opening_run)
      SELECT next_ordinal,NEW.id,NEW.trip_uuid,active_registration,active_run FROM upload_connection WHERE id=1;
    UPDATE upload_connection SET next_ordinal=next_ordinal+1 WHERE id=1; END`,
  ...(['INSERT','UPDATE'] as const).map(event=>`CREATE TRIGGER upload_context_${event.toLowerCase()} AFTER ${event} ON upload_projection_evidence_versions
    WHEN EXISTS(SELECT 1 FROM upload_candidates WHERE trip_ref=NEW.root_ref) BEGIN ${contextChange('NEW')} END`)
];
