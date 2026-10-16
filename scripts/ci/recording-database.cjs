// ET-015a PR-4: reads a copy of the recording runtime journey's synthetic database read-only and prints its rows as one
// JSON line. It runs under the pinned Electron executable in Node mode (ELECTRON_RUN_AS_NODE=1), so better-sqlite3
// loads with the same runtime and ABI as the telemetry service. It only queries; the journey driver maps the rows and
// compares them with the hand-written expectation. Usage: electron recording-database.cjs <copy of smoke.sqlite>
'use strict';
const Database = require('better-sqlite3');

const [file] = process.argv.slice(2);
if (!file) { console.error('Usage: recording-database.cjs <database copy>'); process.exit(2); }
const db = new Database(file, {readonly: true, fileMustExist: true});
try {
  const pragma = name => db.pragma(name, {simple: true});
  const info = db.prepare('SELECT purpose, accepted_origin AS acceptedOrigin FROM database_info WHERE id = 1').get();
  const trips = db.prepare(`SELECT t.id, t.trip_uuid AS tripUuid, p.plugin_session_uuid AS session, t.game, je.event_seq AS jobSeq, te.event_seq AS truckSeq,
      oe.event_seq AS openedSeq, t.game_mode AS mode, t.game_mode_method AS method, t.game_mode_confidence AS confidence, t.game_mode_ambiguous AS ambiguous,
      t.outcome, ue.event_seq AS outcomeSeq, t.close_reason AS closeReason, t.recording_completeness AS completeness, t.started_utc_ms AS startedUtcMs,
      t.ended_utc_ms AS endedUtcMs, t.observed_distance_m AS distance, t.observed_distance_m_state AS distanceState
    FROM trips t JOIN plugin_sessions p ON p.id = t.plugin_session_ref JOIN job_configurations j ON j.id = t.job_configuration_ref JOIN events je ON je.id = j.event_ref
    LEFT JOIN truck_configurations k ON k.id = t.truck_configuration_ref LEFT JOIN events te ON te.id = k.event_ref
    JOIN events oe ON oe.id = t.opened_event_ref LEFT JOIN events ue ON ue.id = t.outcome_event_ref ORDER BY t.id`).all();
  const trailers = db.prepare(`SELECT e.event_seq AS eventSeq FROM trip_trailers r JOIN trailer_configurations c ON c.id = r.trailer_configuration_ref
    JOIN events e ON e.id = c.event_ref WHERE r.trip_ref = ? ORDER BY e.event_seq`);
  const out = {
    applicationId: pragma('application_id'), userVersion: pragma('user_version'), journalMode: pragma('journal_mode'),
    integrity: db.prepare('PRAGMA integrity_check').pluck().all(), foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
    purpose: info.purpose, acceptedOrigin: info.acceptedOrigin,
    sessions: db.prepare(`SELECT plugin_session_uuid AS session, game, origin, committed_through_event_seq AS committedThrough, end_reason AS endReason
      FROM plugin_sessions ORDER BY id`).all(),
    events: db.prepare(`SELECT e.event_seq AS eventSeq, e.type, e.first_redelivered AS firstRedelivered, e.occurred_utc_ms AS utcMs, p.plugin_session_uuid AS session
      FROM events e JOIN plugin_sessions p ON p.id = e.plugin_session_id ORDER BY e.id`).all(),
    gaps: db.prepare('SELECT count(*) FROM event_gaps').pluck().get(),
    samples: db.prepare('SELECT count(*) FROM samples').pluck().get(),
    // ET-015b PR-3: each sample's trip UUID and source monotonic time, in insertion order.
    sampleRows: db.prepare(`SELECT t.trip_uuid AS trip, CAST(s.monotonic_ns AS TEXT) AS monotonicNs FROM samples s LEFT JOIN trips t ON t.id = s.trip_ref ORDER BY s.id`).all(),
    trips: trips.map(({id, ...trip}) => ({...trip, trailerSeqs: trailers.pluck().all(id)})),
    attributions: db.prepare(`SELECT e.event_seq AS eventSeq, t.trip_uuid AS trip, a.attribution FROM event_attributions a JOIN events e ON e.id = a.event_ref
      LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.event_seq`).all(),
    intervals: db.prepare(`SELECT t.trip_uuid AS trip, c.kind, c.start_utc_ms AS startUtcMs, c.end_utc_ms AS endUtcMs, c.start_monotonic_ns AS startMonotonicNs,
      c.end_monotonic_ns AS endMonotonicNs, k.clock_uuid AS sourceClockId, c.first_event_seq AS firstEventSeq, c.last_event_seq AS lastEventSeq, c.detail_json AS detail
      FROM completeness_intervals c LEFT JOIN trips t ON t.id = c.trip_ref LEFT JOIN clocks k ON k.id = c.source_clock_ref ORDER BY c.id`).all()
  };
  process.stdout.write(JSON.stringify(out) + '\n');
} finally { db.close(); }
