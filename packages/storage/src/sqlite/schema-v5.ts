// Durable private projection preparation. Released schema versions remain frozen.
const bump = (roots: string) => `INSERT INTO upload_projection_evidence_versions(root_ref,generation)
  SELECT root,1 FROM (${roots}) WHERE root IS NOT NULL
  ON CONFLICT(root_ref) DO UPDATE SET generation=generation+1;`;
const memberRoots = (alias: string) => `SELECT ${alias}.logical_ref AS root UNION SELECT ${alias}.previous_logical_ref`;
const linkRoots = (alias: string) => `SELECT logical_ref AS root FROM logical_memberships WHERE trip_ref=${alias}.trip_ref
  UNION SELECT previous_logical_ref FROM logical_memberships WHERE trip_ref=${alias}.trip_ref`;
export const SCHEMA_V5: readonly string[] = [
  `CREATE TABLE upload_projection_evidence_versions(root_ref INTEGER PRIMARY KEY REFERENCES logical_trips(id) ON DELETE CASCADE,
    generation INTEGER NOT NULL CHECK(generation>=0)) STRICT`,
  `CREATE TABLE upload_projection_pins(
    pin_id TEXT PRIMARY KEY, incarnation_uuid TEXT NOT NULL CHECK(length(incarnation_uuid)=36), requested_trip_uuid TEXT NOT NULL REFERENCES trips(trip_uuid),
    root_ref INTEGER NOT NULL REFERENCES logical_trips(id), revision_ref INTEGER NOT NULL REFERENCES logical_revisions(id),
    evidence_generation INTEGER NOT NULL CHECK(evidence_generation>=0),
    state TEXT NOT NULL CHECK(state IN ('preparing','ready','invalidated','releasing')),
    phase TEXT NOT NULL CHECK(phase IN ('current','previous','configurations','intervals','finalize')),
    snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), metadata_json TEXT CHECK(metadata_json IS NULL OR json_valid(metadata_json)),
    member_after INTEGER NOT NULL DEFAULT 0 CHECK(member_after>=0), item_after INTEGER NOT NULL DEFAULT 0 CHECK(item_after>=0),
    source_after INTEGER NOT NULL DEFAULT 0 CHECK(source_after>=0),
    member_count INTEGER NOT NULL DEFAULT 0 CHECK(member_count>=0), configuration_count INTEGER NOT NULL DEFAULT 0 CHECK(configuration_count>=0),
    interval_count INTEGER NOT NULL DEFAULT 0 CHECK(interval_count>=0),
    outcome_trip_ref INTEGER REFERENCES trips(id), close_trip_ref INTEGER REFERENCES trips(id),
    examined INTEGER NOT NULL DEFAULT 0 CHECK(examined BETWEEN 0 AND 100),
    CHECK((state='ready')=(metadata_json IS NOT NULL))) STRICT`,
  'CREATE INDEX upload_projection_retained_root ON upload_projection_pins(root_ref)',
  `CREATE TABLE upload_projection_members(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), trip_ref INTEGER NOT NULL REFERENCES trips(id),
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,trip_ref)) STRICT`,
  `CREATE TABLE upload_projection_configurations(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), event_ref INTEGER NOT NULL REFERENCES events(id),
    qualified INTEGER NOT NULL CHECK(qualified IN (0,1)), raw_trip_uuid TEXT NOT NULL,
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,event_ref)) STRICT`,
  `CREATE TABLE upload_projection_intervals(pin_ref TEXT NOT NULL REFERENCES upload_projection_pins(pin_id), interval_ref INTEGER NOT NULL REFERENCES completeness_intervals(id),
    row_json TEXT NOT NULL CHECK(json_valid(row_json)), PRIMARY KEY(pin_ref,interval_ref)) STRICT`,
  'CREATE INDEX completeness_intervals_trip_keyset ON completeness_intervals(trip_ref,id)',
  ...(['INSERT','DELETE','UPDATE'] as const).map(event => `CREATE TRIGGER upload_projection_trailer_${event.toLowerCase()} AFTER ${event} ON trip_trailers BEGIN
    ${bump(event==='INSERT'?linkRoots('NEW'):event==='DELETE'?linkRoots('OLD'):`${linkRoots('OLD')} UNION ${linkRoots('NEW')}`)} END`),
  ...(['INSERT','DELETE','UPDATE'] as const).map(event => `CREATE TRIGGER upload_projection_membership_${event.toLowerCase()} AFTER ${event}${event==='UPDATE'?' OF logical_ref,previous_logical_ref,joined_after_revision':''} ON logical_memberships BEGIN
    ${bump(event==='INSERT'?memberRoots('NEW'):event==='DELETE'?memberRoots('OLD'):`${memberRoots('OLD')} UNION ${memberRoots('NEW')}`)} END`)
];
