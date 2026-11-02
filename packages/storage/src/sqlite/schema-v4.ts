// Additive migration. Old history stays in singleton groups with no invented profile identity.
export const SCHEMA_V4: readonly string[] = [
  'CREATE TABLE observation_closes(trip_ref INTEGER PRIMARY KEY REFERENCES trips(id)) STRICT',
  `CREATE TABLE logical_trips (
    id INTEGER PRIMARY KEY REFERENCES trips(id), trip_uuid TEXT NOT NULL UNIQUE REFERENCES trips(trip_uuid),
    latest_trip_ref INTEGER NOT NULL REFERENCES trips(id), game TEXT NOT NULL CHECK(game IN ('ets2','ats')),
    profile_scope TEXT, fingerprint TEXT, canonical_constraints TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(canonical_constraints)),
    retired INTEGER NOT NULL DEFAULT 0 CHECK(retired IN (0,1)),
    hard_mode_lost INTEGER NOT NULL DEFAULT 0 CHECK(hard_mode_lost IN (0,1)), progress_head INTEGER REFERENCES logical_progress(id),
    accounting_rebased INTEGER NOT NULL DEFAULT 0 CHECK(accounting_rebased IN (0,1)), reconciliation_unknown INTEGER NOT NULL DEFAULT 0 CHECK(reconciliation_unknown IN (0,1)),
    member_count INTEGER NOT NULL DEFAULT 1, mode_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(mode_ambiguous IN (0,1)),
    first_loss_json TEXT CHECK(first_loss_json IS NULL OR json_valid(first_loss_json)),
    interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1))) STRICT`,
  `CREATE TABLE logical_memberships (trip_ref INTEGER PRIMARY KEY REFERENCES trips(id), logical_ref INTEGER NOT NULL REFERENCES logical_trips(id),
    previous_logical_ref INTEGER REFERENCES logical_trips(id), joined_after_revision INTEGER,
    decision_key TEXT NOT NULL UNIQUE, observation_key TEXT, proof_json TEXT CHECK(proof_json IS NULL OR json_valid(proof_json))) STRICT`,
  `CREATE VIEW logical_snapshot_memberships AS SELECT trip_ref,logical_ref,coalesce(joined_after_revision,0) AS from_revision,NULL AS through_revision FROM logical_memberships
    UNION ALL SELECT trip_ref,previous_logical_ref,0,joined_after_revision FROM logical_memberships WHERE previous_logical_ref IS NOT NULL`,
  'CREATE INDEX logical_memberships_previous ON logical_memberships(previous_logical_ref,trip_ref)',
  'CREATE INDEX logical_memberships_group ON logical_memberships(logical_ref, trip_ref)',
  'CREATE INDEX logical_profile_slots ON logical_trips(game,profile_scope,retired,id)',
  'CREATE INDEX logical_candidates ON logical_trips(game, profile_scope, fingerprint, retired)',
  'CREATE TABLE logical_trucks(id INTEGER PRIMARY KEY, identity_key TEXT NOT NULL UNIQUE) STRICT',
  `CREATE TABLE logical_progress (
    id INTEGER PRIMARY KEY, logical_ref INTEGER NOT NULL REFERENCES logical_trips(id), trip_ref INTEGER NOT NULL REFERENCES trips(id),
    anchor_sample_ref INTEGER NOT NULL REFERENCES samples(id), sample_ref INTEGER REFERENCES samples(id), bound_sample_ref INTEGER REFERENCES samples(id), prefix_ref INTEGER REFERENCES logical_progress(id), start_ref INTEGER REFERENCES logical_progress(id),
    cut_odometer_m REAL, truck_ref INTEGER REFERENCES logical_trucks(id), odometer_m REAL, start_odometer_m REAL, distance_m REAL, fuel_used_l REAL,
    UNIQUE(sample_ref)) STRICT`,
  'CREATE INDEX logical_progress_cut ON logical_progress(logical_ref, truck_ref, start_odometer_m, odometer_m)',
  'CREATE TABLE logical_projection_states(id INTEGER PRIMARY KEY,row_json TEXT NOT NULL UNIQUE CHECK(json_valid(row_json))) STRICT',
  `CREATE TABLE logical_revisions (
    id INTEGER PRIMARY KEY, logical_ref INTEGER NOT NULL REFERENCES logical_trips(id),
    state_ref INTEGER NOT NULL REFERENCES logical_projection_states(id), member_through INTEGER NOT NULL,
    event_through INTEGER NOT NULL, gap_through INTEGER NOT NULL, sample_through INTEGER NOT NULL, interval_through INTEGER NOT NULL,
    progress_head INTEGER REFERENCES logical_progress(id)) STRICT`,
  'CREATE INDEX logical_revisions_group ON logical_revisions(logical_ref, id)',
  `INSERT INTO logical_trips(id, trip_uuid, latest_trip_ref, game, retired, hard_mode_lost)
    SELECT id, trip_uuid, id, game, 1, CASE WHEN is_hard_mode = 1 THEN 0 ELSE 1 END FROM trips`,
  `INSERT INTO logical_memberships(trip_ref, logical_ref, decision_key) SELECT id, id, 'migration-v4:' || trip_uuid FROM trips`
];
