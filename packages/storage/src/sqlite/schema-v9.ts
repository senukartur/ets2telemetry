// Schema version 9 (ET-112b2): durable trip membership decisions and per-session profile boundaries. Additive: no table
// rebuild and no backfill. A raw trip without a decision row keeps its schema 8 meaning; only an open raw trip without
// profile proof gets a row later, the first time its membership is evaluated. Event-sequence columns hold the 20-digit
// keys of events.event_seq, so text order is numeric order.
export const SCHEMA_V9: readonly string[] = [
  `CREATE TABLE logical_membership_decisions (
  trip_ref INTEGER PRIMARY KEY REFERENCES trips(id),
  game TEXT NOT NULL CHECK (game IN ('ets2','ats')),
  plugin_session_ref INTEGER NOT NULL REFERENCES plugin_sessions(id),
  rule_version INTEGER NOT NULL CHECK (rule_version = 1),
  state TEXT NOT NULL CHECK (state IN ('pending','joined','root','separate')),
  reason TEXT NOT NULL CHECK (CASE state
    WHEN 'pending'  THEN reason IN ('profile-unverified','job-evidence-incomplete')
    WHEN 'joined'   THEN reason = 'matched'
    WHEN 'root'     THEN reason IN ('recorded-job-incomplete','deadline-unavailable','job-evidence-conflict','no-candidate','ambiguous-candidates')
    WHEN 'separate' THEN reason IN ('profile-boundary','process-ended','published','out-of-order') END),
  raw_closed_event_seq TEXT,
  target_logical_ref INTEGER REFERENCES logical_trips(id),
  decided_revision INTEGER,
  CHECK ((state='pending') = (decided_revision IS NULL)),
  CHECK ((state='joined') = (target_logical_ref IS NOT NULL))
) STRICT`,
  'CREATE INDEX logical_membership_decisions_session ON logical_membership_decisions(plugin_session_ref, state, trip_ref)',
  'CREATE INDEX logical_membership_decisions_game ON logical_membership_decisions(game, state, plugin_session_ref)',
  `CREATE TABLE session_profile_boundaries (
  plugin_session_ref INTEGER PRIMARY KEY REFERENCES plugin_sessions(id),
  through_event_seq TEXT NOT NULL
) STRICT`
];
