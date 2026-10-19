// ET-019 PR-12b: reads a copy of the application soak's synthetic database read-only and prints its rows as one JSON line.
// It runs under the pinned Electron executable in Node mode (ELECTRON_RUN_AS_NODE=1), like recording-database.cjs, so
// better-sqlite3 loads with the telemetry service's runtime and ABI. It only queries. The rows have the shape the history
// invariants check (scripts/ci/history-invariants.mjs, HistoryRows; the same queries as tests/storage/history-rows.ts),
// plus the values the soak compares with its hand-written expectation (scripts/ci/soak-evidence.mjs): UTC labels, trip
// references and configuration eventSeqs, observed distance, fuel used, interval details and each sample's trip, time,
// speed and odometer. Every uint64 is a canonical decimal string. Usage: electron soak-database.cjs <database copy>
'use strict';

/** A 20-digit key or a safe-integer column as a canonical decimal string, or null. */
const key = value => value === null || value === undefined ? null : BigInt(value).toString();
const number = value => value === null || value === undefined ? null : Number(value);
const available = (value, state) => state === 'available' ? {available: true, value: Number(value)} : {available: false, reason: state};

/** The rows of one closed schema version 2 database, through `Database` (better-sqlite3), read-only. */
function readSoakDatabase(file, Database) {
  const db = new Database(file, {readonly: true, fileMustExist: true});
  try {
    const all = sql => db.prepare(sql).safeIntegers(true).all();
    const info = db.prepare('SELECT database_uuid AS databaseUuid, purpose, accepted_origin AS acceptedOrigin FROM database_info WHERE id = 1').get();
    const trailers = db.prepare(`SELECT e.event_seq AS seq FROM trip_trailers r JOIN trailer_configurations c ON c.id = r.trailer_configuration_ref
      JOIN events e ON e.id = c.event_ref WHERE r.trip_ref = ? ORDER BY e.event_seq`).safeIntegers(true);
    return {
      applicationId: db.pragma('application_id', {simple: true}), userVersion: db.pragma('user_version', {simple: true}), journalMode: db.pragma('journal_mode', {simple: true}),
      integrity: db.pragma('integrity_check', {simple: true}), foreignKeys: db.prepare('PRAGMA foreign_key_check').all(),
      databaseUuid: info.databaseUuid, purpose: info.purpose, acceptedOrigin: info.acceptedOrigin,
      sessions: all(`SELECT plugin_session_uuid AS session, game, origin, committed_through_event_seq AS through, end_reason AS endReason FROM plugin_sessions ORDER BY id`)
        .map(r => ({pluginSessionId: String(r.session), game: String(r.game), origin: String(r.origin), committedThroughEventSeq: key(r.through), endReason: r.endReason === null ? null : String(r.endReason)})),
      events: all(`SELECT s.plugin_session_uuid AS session, e.event_seq AS seq, e.type, e.first_redelivered AS redelivered, e.occurred_utc_ms AS utcMs
        FROM events e JOIN plugin_sessions s ON s.id = e.plugin_session_id ORDER BY e.id`)
        .map(r => ({pluginSessionId: String(r.session), eventSeq: key(r.seq), type: String(r.type), firstRedelivered: Number(r.redelivered) === 1, utcMs: number(r.utcMs)})),
      gaps: all(`SELECT s.plugin_session_uuid AS session, g.first_event_seq AS first, g.last_event_seq AS last
        FROM event_gaps g JOIN plugin_sessions s ON s.id = g.plugin_session_ref ORDER BY g.id`)
        .map(r => ({pluginSessionId: String(r.session), firstEventSeq: key(r.first), lastEventSeq: key(r.last)})),
      trips: all(`SELECT t.id, t.trip_uuid AS trip, t.game, s.plugin_session_uuid AS session, t.opened_by AS openedBy, oe.event_seq AS opened,
          t.outcome, os.plugin_session_uuid AS outcomeSession, xe.event_seq AS outcomeSeq, t.close_reason AS closeReason, t.recording_completeness AS completeness,
          je.event_seq AS jobSeq, te.event_seq AS truckSeq, t.started_utc_ms AS startedUtcMs, t.ended_utc_ms AS endedUtcMs,
          t.observed_distance_m AS distance, t.observed_distance_m_state AS distanceState, t.fuel_used_l AS fuelUsed, t.fuel_used_l_state AS fuelUsedState
        FROM trips t JOIN plugin_sessions s ON s.id = t.plugin_session_ref JOIN job_configurations j ON j.id = t.job_configuration_ref LEFT JOIN events je ON je.id = j.event_ref
        LEFT JOIN truck_configurations k ON k.id = t.truck_configuration_ref LEFT JOIN events te ON te.id = k.event_ref
        LEFT JOIN events oe ON oe.id = t.opened_event_ref LEFT JOIN events xe ON xe.id = t.outcome_event_ref LEFT JOIN plugin_sessions os ON os.id = xe.plugin_session_id ORDER BY t.id`)
        .map(r => ({tripUuid: String(r.trip), game: String(r.game), pluginSessionId: String(r.session), openedBy: String(r.openedBy), openedEventSeq: key(r.opened),
          outcome: String(r.outcome), outcomeSessionId: r.outcomeSession === null ? null : String(r.outcomeSession), outcomeEventSeq: key(r.outcomeSeq),
          closeReason: r.closeReason === null ? null : String(r.closeReason), recordingCompleteness: String(r.completeness),
          jobConfigurationEventSeq: key(r.jobSeq), truckConfigurationEventSeq: key(r.truckSeq), trailerConfigurationEventSeqs: trailers.all(r.id).map(t => key(t.seq)),
          startedUtcMs: number(r.startedUtcMs), endedUtcMs: number(r.endedUtcMs),
          observedDistanceM: available(r.distance, String(r.distanceState)), fuelUsedL: available(r.fuelUsed, String(r.fuelUsedState))})),
      attributions: all(`SELECT s.plugin_session_uuid AS session, e.event_seq AS seq, t.trip_uuid AS trip, a.attribution
        FROM event_attributions a JOIN events e ON e.id = a.event_ref JOIN plugin_sessions s ON s.id = e.plugin_session_id LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.id`)
        .map(r => ({pluginSessionId: String(r.session), eventSeq: key(r.seq), tripUuid: r.trip === null ? null : String(r.trip), attribution: String(r.attribution)})),
      intervals: all(`SELECT t.trip_uuid AS trip, s.plugin_session_uuid AS session, c.kind, c.first_event_seq AS first, c.last_event_seq AS last, c.detail_json AS detail
        FROM completeness_intervals c JOIN plugin_sessions s ON s.id = c.plugin_session_ref LEFT JOIN trips t ON t.id = c.trip_ref ORDER BY c.id`)
        .map(r => {
          const detail = r.detail === null ? null : JSON.parse(String(r.detail));
          return {tripUuid: r.trip === null ? null : String(r.trip), pluginSessionId: String(r.session), kind: String(r.kind), firstEventSeq: key(r.first), lastEventSeq: key(r.last),
            annotation: detail !== null && detail.annotation === true, detail};
        }),
      samples: all(`SELECT s.plugin_session_uuid AS session, k.clock_uuid AS clock, m.monotonic_ns AS ns, t.trip_uuid AS trip, m.utc_ms AS utcMs, m.speed_mps AS speed, m.odometer_m AS odometer
        FROM samples m JOIN plugin_sessions s ON s.id = m.plugin_session_ref JOIN clocks k ON k.id = m.source_clock_ref LEFT JOIN trips t ON t.id = m.trip_ref ORDER BY m.id`)
        .map(r => ({pluginSessionId: String(r.session), sourceClockId: String(r.clock), monotonicNs: key(r.ns), tripUuid: r.trip === null ? null : String(r.trip),
          utcMs: number(r.utcMs), speedMps: number(r.speed), odometerM: number(r.odometer)}))
    };
  } finally { db.close(); }
}

module.exports = {readSoakDatabase};

if (require.main === module) {
  const [file] = process.argv.slice(2);
  if (!file) { console.error('Usage: soak-database.cjs <database copy>'); process.exit(2); }
  process.stdout.write(JSON.stringify(readSoakDatabase(file, require('better-sqlite3'))) + '\n');
}
