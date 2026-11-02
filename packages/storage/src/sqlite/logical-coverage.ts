import type Database from 'better-sqlite3';
import type {CapturedEndpoint} from '../api';
import type {ProgressAnchor, ProgressCheckpoint} from '../../../telemetry-core/src/trips/progress';
import {isUuid} from '../codec';

export interface CoverageEndpoint extends ProgressCheckpoint {trip: string; head: string | null; prefixState: string | null}

/** References change at coverage boundaries only; ordinary samples use logical_revisions' existing bounds/head. */
export interface LogicalCoverage {
  version: 1; start: 'observed' | 'unproven'; losses: number; member: string;
  phase: 'active' | 'pending' | 'resumed'; endpoint: CoverageEndpoint | null;
  window: {session: string; opened: string | null} | null;
}
export const COVERAGE_LOSS = {event: 1, sample: 2, restore: 4, discontinuity: 8, unknown: 16} as const;
type Row = Record<string, unknown>;
const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as Row | undefined;
const keys = (v: object, expected: string) => Object.keys(v).sort().join(',') === expected;
const reference = (v: unknown): v is string => typeof v === 'string' && /^[1-9][0-9]{0,18}$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
const nullableReference = (v: unknown) => v === null || reference(v);
const nullableNumber = (v: unknown) => v === null || typeof v === 'number' && Number.isFinite(v);
const unsigned = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n;
const position = (v: unknown) => v === null || typeof v === 'object' && keys(v, 'x,y,z') && Object.values(v).every(n => typeof n === 'number' && Number.isFinite(n));
const point = (v: CapturedEndpoint | ProgressAnchor) => (v.truck === null || typeof v.truck === 'string' && v.truck.length > 0 && v.truck.length <= 2048)
  && nullableNumber(v.odometerM) && (v.odometerM === null || v.odometerM >= 0) && nullableNumber(v.fuelL) && (v.fuelL === null || v.fuelL >= 0)
  && nullableNumber(v.speedMps) && (v.gameClockId === null || isUuid(v.gameClockId)) && (v.gameMinutes === null || unsigned(v.gameMinutes)) && position(v.position);
export function validCapturedEndpoint(v: unknown): v is CapturedEndpoint {
  if (!v || typeof v !== 'object') return false;
  const c = v as CapturedEndpoint, fields = Object.keys(c).filter(k => k !== 'previous').sort().join(',');
  return fields === 'fuelL,gameClockId,gameMinutes,odometerM,position,simulation,speedMps,truck,version' && c.version === 1
    && ['running', 'paused'].includes(c.simulation) && point(c) && (c.previous === undefined || typeof c.previous === 'object' && c.previous !== null
      && keys(c.previous, 'monotonicNs,sourceClockId,tripUuid') && isUuid(c.previous.tripUuid) && isUuid(c.previous.sourceClockId) && unsigned(c.previous.monotonicNs));
}
function validEndpoint(v: unknown): v is CoverageEndpoint {
  if (!v || typeof v !== 'object' || !keys(v, 'anchor,distanceM,fuelUsedL,head,prefixState,trip')) return false;
  const c = v as CoverageEndpoint, a = c.anchor;
  const amount = (v: unknown) => !!v && typeof v === 'object' && ('available' in v && v.available === true ? keys(v, 'available,value')
    && 'value' in v && typeof v.value === 'number' && Number.isFinite(v.value) : keys(v, 'available,reason') && 'available' in v && v.available === false && 'reason' in v && v.reason === 'not-observed');
  return reference(c.trip) && nullableReference(c.head) && nullableReference(c.prefixState) && amount(c.distanceM) && amount(c.fuelUsedL)
    && (!c.distanceM.available || c.distanceM.value >= 0)
    && !!a && typeof a === 'object' && keys(a, 'fuelL,gameClockId,gameMinutes,monotonicNs,odometerM,pluginSessionId,position,sourceClockId,speedMps,truck')
    && isUuid(a.pluginSessionId) && isUuid(a.sourceClockId) && unsigned(a.monotonicNs) && point(a);
}
export function validCoverage(v: unknown): v is LogicalCoverage {
  if (!v || typeof v !== 'object' || !keys(v, 'endpoint,losses,member,phase,start,version,window')) return false;
  const c = v as LogicalCoverage;
  return c.version === 1 && ['observed', 'unproven'].includes(c.start) && Number.isInteger(c.losses) && c.losses >= 0 && c.losses <= 31
    && reference(c.member) && ['active', 'pending', 'resumed'].includes(c.phase) && (c.endpoint === null || validEndpoint(c.endpoint))
    && (c.window === null || typeof c.window === 'object' && keys(c.window, 'opened,session') && reference(c.window.session) && (c.window.opened === null || reference(c.window.opened)))
    && (c.phase === 'pending' || c.window === null);
}
export function latestCoverage(db: Database.Database, id: unknown): {revision?: Row; present: boolean; value?: LogicalCoverage} {
  const revision = get(db, 'SELECT r.*,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref WHERE r.logical_ref=? ORDER BY r.id DESC LIMIT 1', id);
  if (!revision) return {present: false};
  const row = JSON.parse(String(revision.row_json)) as Row, value = row._coverage;
  return {revision, present: Object.hasOwn(row, '_coverage'), ...(validCoverage(value) ? {value: structuredClone(value)} : {})};
}
export function originalCoverage(db: Database.Database, row: Row): LogicalCoverage {
  const event = row.opened_event_ref === null ? undefined : get(db, 'SELECT event_seq,payload_json FROM events WHERE id=?', row.opened_event_ref);
  const payload = event ? JSON.parse(String(event.payload_json)) as {occurred: {simulation: string}} : null;
  const started = event && get(db, "SELECT id FROM events WHERE plugin_session_id=? AND event_seq<? AND type='simulation.started' ORDER BY id DESC LIMIT 1", row.plugin_session_ref, event.event_seq);
  const gap = event && get(db, 'SELECT id FROM event_gaps WHERE plugin_session_ref=? AND first_event_seq<=? LIMIT 1', row.plugin_session_ref, event.event_seq);
  return {version: 1, start: row.opened_by === 'event' && payload?.occurred.simulation === 'running' && started && !gap ? 'observed' : 'unproven',
    losses: 0, member: String(row.id), phase: 'active', endpoint: null, window: null};
}
/** A bootstrap loss is outside this member's active job only for the explicit ordered loaded-job boundary. */
export function cleanLoadWindow(db: Database.Database, row: Row, requireStarted = true): boolean {
  if (row.opened_by !== 'event' || row.opened_event_ref === null) return false;
  const event = get(db, 'SELECT id,event_seq,payload_json FROM events WHERE id=? AND plugin_session_id=?', row.opened_event_ref, row.plugin_session_ref);
  const membership = get(db, 'SELECT proof_json FROM logical_memberships WHERE trip_ref=?', row.id);
  if (!event || membership?.proof_json === null || !membership) return false;
  const proof = JSON.parse(membership.proof_json as string) as {loadGeneration?: number};
  const payload = JSON.parse(String(event.payload_json)) as {occurred: {simulation: string}};
  if (!Number.isSafeInteger(proof.loadGeneration) || proof.loadGeneration! < 1 || payload.occurred.simulation !== 'paused') return false;
  const started = get(db, "SELECT id FROM events WHERE plugin_session_id=? AND id>? AND type='simulation.started' ORDER BY id LIMIT 1", row.plugin_session_ref, event.id);
  if (requireStarted && !started) return false;
  const forbidden = get(db, "SELECT id FROM events WHERE plugin_session_id=? AND id<? AND (type LIKE 'job.%' OR type IN ('player.use.ferry','player.use.train')) LIMIT 1", row.plugin_session_ref, event.id);
  if (forbidden) return false;
  const gaps = db.prepare('SELECT first_event_seq,last_event_seq FROM event_gaps WHERE plugin_session_ref=? ORDER BY id LIMIT 2').all(row.plugin_session_ref) as Row[];
  return gaps.length === 0 || gaps.length === 1 && event.event_seq === '00000000000000000003'
    && gaps[0].first_event_seq === '00000000000000000001' && gaps[0].last_event_seq === '00000000000000000002';
}
/** Inspect new interval rows of the selected members, with an explicit overflow veto. No member-history arrays. */
export function advanceCoverage(db: Database.Database, id: unknown, _group: Row, row: Row, override?: LogicalCoverage): LogicalCoverage | undefined {
  const prior = latestCoverage(db, id), coverage = override ? structuredClone(override) : prior.value;
  if (!coverage) return prior.present ? {...originalCoverage(db, row), start: 'unproven', losses: COVERAGE_LOSS.unknown} : undefined;
  const from = override && (!prior.value || prior.value.member !== override.member) ? 0n : prior.revision?.interval_through ?? 0n;
  const intervals = db.prepare(`SELECT c.* FROM completeness_intervals c WHERE
    (c.id>@from AND (c.trip_ref=@member OR c.trip_ref IS NULL AND c.plugin_session_ref=@session)) OR
    (c.id>@previous AND (EXISTS(SELECT 1 FROM logical_memberships m WHERE m.logical_ref=@logical AND m.trip_ref=c.trip_ref)
      OR c.trip_ref IS NULL AND EXISTS(SELECT 1 FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE m.logical_ref=@logical AND t.plugin_session_ref=c.plugin_session_ref)))
    ORDER BY c.id LIMIT 129`).all({from,previous:prior.revision?.interval_through??0n,member:row.id,session:row.plugin_session_ref,logical:id}) as Row[];
  if (intervals.length > 128) coverage.losses |= COVERAGE_LOSS.unknown;
  for (const interval of intervals) {
    const detail = interval.detail_json === null ? {} : JSON.parse(interval.detail_json as string) as Row;
    if (interval.kind === 'event-loss' && interval.plugin_session_ref !== row.plugin_session_ref && (row.outcome === 'open' || row.close_reason === 'restart')
      && !get(db,'SELECT t.id FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE m.logical_ref=? AND t.plugin_session_ref=? LIMIT 1',id,interval.plugin_session_ref)) {
      if (coverage.phase === 'pending' && coverage.window?.opened !== null) coverage.losses |= COVERAGE_LOSS.unknown;
      coverage.phase = 'pending';
      coverage.window = {session: String(interval.plugin_session_ref), opened: null}; continue;
    }
    if (interval.kind === 'not-connected' && coverage.phase === 'resumed' && cleanLoadWindow(db,row)
      && get(db,"SELECT t.id FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE m.logical_ref=? AND t.id=? AND t.closed_by_session_ref=? AND t.close_reason='restart'",id,interval.trip_ref,row.plugin_session_ref)) continue;
    if (interval.kind === 'not-connected' && row.close_reason === 'restart' && row.closed_by_session_ref !== null && row.closed_by_session_ref !== row.plugin_session_ref) {
      coverage.phase = 'pending';
      coverage.window = {session: (row.closed_by_session_ref as bigint).toString(), opened: null}; continue;
    }
    if (interval.kind === 'event-loss' && coverage.phase === 'pending' && cleanLoadWindow(db, row, false)
      && interval.plugin_session_ref === row.plugin_session_ref && interval.first_event_seq === '00000000000000000001' && interval.last_event_seq === '00000000000000000002') continue;
    if (interval.kind === 'discontinuity' && detail.cause === 'opened-at-load' && coverage.phase === 'pending' && cleanLoadWindow(db,row,false)) continue;
    if (interval.kind === 'discontinuity' && detail.cause === 'restart' && coverage.phase === 'pending' && cleanLoadWindow(db, row, false)
      && typeof detail.continuationOf === 'string' && get(db, `SELECT t.id FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=? AND m.logical_ref=? AND t.closed_by_session_ref=? AND t.close_reason='restart'`, detail.continuationOf, id, row.plugin_session_ref)) continue;
    if (interval.kind === 'discontinuity' && detail.annotation === true && detail.label === 'crossing') continue;
    if (interval.kind === 'event-loss') coverage.losses |= COVERAGE_LOSS.event;
    else if (interval.kind === 'sample-loss') coverage.losses |= COVERAGE_LOSS.sample;
    else if (interval.kind === 'restore-loss') coverage.losses |= COVERAGE_LOSS.restore;
    else if (interval.kind === 'not-connected') coverage.losses |= COVERAGE_LOSS.unknown;
    else if (detail.annotation !== true || ['odometer-jump', 'position-jump', 'game-time-jump'].includes(String(detail.cause))) coverage.losses |= COVERAGE_LOSS.discontinuity;
  }
  if (coverage.phase === 'pending' && coverage.endpoint?.trip === coverage.member && cleanLoadWindow(db,row)) {coverage.phase='resumed';coverage.window=null;}
  return coverage;
}
export function applyCoverage(row: Row, group: Row, coverage: LogicalCoverage | undefined, present: boolean): void {
  if (coverage) {
    row._coverage = coverage;
    if (group.profile_scope !== null && coverage.start === 'observed' && coverage.losses === 0 && coverage.phase !== 'pending') row.recording_completeness = 'complete';
    else if (coverage.losses !== 0 || coverage.phase === 'pending' || Number(group.member_count) > 1) row.recording_completeness = 'partial';
  } else if (present || Number(group.member_count) > 1) row.recording_completeness = 'partial';
}
