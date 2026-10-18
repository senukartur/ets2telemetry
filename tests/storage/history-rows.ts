// ET-019: reads the rows the history invariants check (scripts/ci/history-invariants.mjs) from a closed schema version 2
// database, through a separate read-only connection. It writes nothing; the plain rows carry UUIDs and canonical decimal
// uint64 strings, never row ids, so the checker stays independent of SQLite. better-sqlite3 stays in the storage suite.
import type {HistoryRows} from '../../scripts/ci/history-invariants.mjs';
import {readOnly} from './helpers';

/** A column value under safeIntegers: TEXT, an INTEGER as BigInt, or NULL. */
type Cell = string | bigint | null;
/** A 20-digit zero-padded key column as a canonical decimal string. */
const key = (value: Cell) => value === null ? null : BigInt(value).toString();
const required = (value: Cell) => { if (value === null) throw new Error('Harness: a NOT NULL column read as NULL'); return BigInt(value).toString(); };

type Row = Record<string, Cell>;
export function readHistoryRows(file: string): HistoryRows {
  return readOnly(file, db => {
    const all = (sql: string) => db.prepare(sql).safeIntegers(true).all() as Row[];
    const integrity = db.pragma('integrity_check', {simple: true}) as string;
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    const sessions = all('SELECT plugin_session_uuid AS session, game, committed_through_event_seq AS through FROM plugin_sessions ORDER BY id')
      .map(r => ({pluginSessionId: String(r.session), game: String(r.game), committedThroughEventSeq: required(r.through)}));
    const events = all(`SELECT s.plugin_session_uuid AS session, e.event_seq AS seq, e.type, e.first_redelivered AS redelivered
      FROM events e JOIN plugin_sessions s ON s.id = e.plugin_session_id ORDER BY e.id`)
      .map(r => ({pluginSessionId: String(r.session), eventSeq: required(r.seq), type: String(r.type), firstRedelivered: Number(r.redelivered) === 1}));
    const gaps = all(`SELECT s.plugin_session_uuid AS session, g.first_event_seq AS first, g.last_event_seq AS last
      FROM event_gaps g JOIN plugin_sessions s ON s.id = g.plugin_session_ref ORDER BY g.id`)
      .map(r => ({pluginSessionId: String(r.session), firstEventSeq: required(r.first), lastEventSeq: required(r.last)}));
    const trips = all(`SELECT t.trip_uuid AS trip, t.game, s.plugin_session_uuid AS session, t.opened_by AS openedBy, oe.event_seq AS opened,
      t.outcome, os.plugin_session_uuid AS outcomeSession, xe.event_seq AS outcomeSeq, t.close_reason AS closeReason, t.recording_completeness AS completeness
      FROM trips t JOIN plugin_sessions s ON s.id = t.plugin_session_ref LEFT JOIN events oe ON oe.id = t.opened_event_ref
      LEFT JOIN events xe ON xe.id = t.outcome_event_ref LEFT JOIN plugin_sessions os ON os.id = xe.plugin_session_id ORDER BY t.id`)
      .map(r => ({tripUuid: String(r.trip), game: String(r.game), pluginSessionId: String(r.session), openedBy: r.openedBy as 'event' | 'checkpoint', openedEventSeq: key(r.opened),
        outcome: r.outcome as HistoryRows['trips'][number]['outcome'], outcomeSessionId: r.outcomeSession === null ? null : String(r.outcomeSession), outcomeEventSeq: key(r.outcomeSeq),
        closeReason: r.closeReason === null ? null : String(r.closeReason), recordingCompleteness: r.completeness as HistoryRows['trips'][number]['recordingCompleteness']}));
    const attributions = all(`SELECT s.plugin_session_uuid AS session, e.event_seq AS seq, t.trip_uuid AS trip, a.attribution
      FROM event_attributions a JOIN events e ON e.id = a.event_ref JOIN plugin_sessions s ON s.id = e.plugin_session_id LEFT JOIN trips t ON t.id = a.trip_ref ORDER BY e.id`)
      .map(r => ({pluginSessionId: String(r.session), eventSeq: required(r.seq), tripUuid: r.trip === null ? null : String(r.trip), attribution: String(r.attribution)}));
    const intervals = all(`SELECT t.trip_uuid AS trip, s.plugin_session_uuid AS session, c.kind, c.first_event_seq AS first, c.last_event_seq AS last, c.detail_json AS detail
      FROM completeness_intervals c JOIN plugin_sessions s ON s.id = c.plugin_session_ref LEFT JOIN trips t ON t.id = c.trip_ref ORDER BY c.id`)
      .map(r => ({tripUuid: r.trip === null ? null : String(r.trip), pluginSessionId: String(r.session), kind: String(r.kind), firstEventSeq: key(r.first), lastEventSeq: key(r.last),
        annotation: r.detail !== null && (JSON.parse(String(r.detail)) as {annotation?: unknown}).annotation === true}));
    const samples = all(`SELECT s.plugin_session_uuid AS session, k.clock_uuid AS clock, m.monotonic_ns AS ns
      FROM samples m JOIN plugin_sessions s ON s.id = m.plugin_session_ref JOIN clocks k ON k.id = m.source_clock_ref ORDER BY m.id`)
      .map(r => ({pluginSessionId: String(r.session), sourceClockId: String(r.clock), monotonicNs: required(r.ns)}));
    return {integrity, foreignKeys, sessions, events, gaps, trips, attributions, intervals, samples};
  });
}
