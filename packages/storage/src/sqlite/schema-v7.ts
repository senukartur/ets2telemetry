// Checkpoint observations are session-owned evidence, separate from native events and trip lifetimes.
const key = (name: string) => `${name} TEXT NOT NULL CHECK(length(${name})=20 AND ${name} NOT GLOB '*[^0-9]*' AND ${name}<='18446744073709551615')`;
export const SCHEMA_V7: readonly string[] = [
  `CREATE TABLE trailer_baselines(id INTEGER PRIMARY KEY,plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions(id),
    ${key('next_event_seq')},${key('configuration_revision')},source_clock_uuid TEXT NOT NULL,${key('monotonic_ns')},${key('boundary_order')},
    slots_json TEXT NOT NULL CHECK(json_valid(slots_json)),CHECK(next_event_seq>'00000000000000000000'),
    UNIQUE(plugin_session_ref,next_event_seq,source_clock_uuid,monotonic_ns,boundary_order)) STRICT`,
  'CREATE INDEX trailer_baselines_boundary ON trailer_baselines(plugin_session_ref,next_event_seq,id)',
  'CREATE INDEX completeness_intervals_context ON completeness_intervals(plugin_session_ref,kind,id)',
  'CREATE INDEX event_gaps_boundary ON event_gaps(plugin_session_ref,first_event_seq,id)',
  "CREATE TRIGGER trailer_baselines_no_update BEFORE UPDATE ON trailer_baselines BEGIN SELECT RAISE(ABORT,'trailer baselines are immutable'); END",
  "CREATE TRIGGER trailer_baselines_no_delete BEFORE DELETE ON trailer_baselines BEGIN SELECT RAISE(ABORT,'trailer baselines are immutable'); END"
];
