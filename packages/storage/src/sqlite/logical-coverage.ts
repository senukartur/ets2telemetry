import type Database from 'better-sqlite3';
import type {CapturedEndpoint, CapturedRunning} from '../api';
import type {ProgressAnchor, ProgressCheckpoint} from '../../../telemetry-core/src/trips/progress';
import {isUuid} from '../codec';

export interface CoverageEndpoint extends ProgressCheckpoint {trip: string; head: string | null; prefixState: string | null; running?: CapturedRunning}

/** References change at coverage boundaries only; ordinary samples use logical_revisions' existing bounds/head. */
export interface LogicalCoverage {
  acceptancePending?: boolean;
  sampleResumePending?: boolean;
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
export function validAcceptanceDetail(v: unknown): boolean {
  if(!v || typeof v!=='object')return false;
  const d=v as Row,confirmed=d.phase==='confirmed';
  return keys(d,confirmed?'absenceBoundaryOrder,absenceMonotonicNs,annotation,cause,clearEventSeq,configurationRevision,confirmedThroughEventSeq,loadGeneration,phase,throughEventSeq,version'
    :'absenceBoundaryOrder,absenceMonotonicNs,annotation,cause,clearEventSeq,configurationRevision,loadGeneration,phase,throughEventSeq,version')
    && d.version===1 && d.annotation===true && d.cause==='observed-acceptance' && (confirmed || d.phase==='pending')
    && unsigned(d.clearEventSeq) && BigInt(d.clearEventSeq)>0n && unsigned(d.throughEventSeq) && BigInt(d.clearEventSeq)<=BigInt(d.throughEventSeq)
    && unsigned(d.configurationRevision) && unsigned(d.absenceMonotonicNs) && unsigned(d.absenceBoundaryOrder)
    && Number.isSafeInteger(d.loadGeneration) && Number(d.loadGeneration)>=0 && (!confirmed || unsigned(d.confirmedThroughEventSeq));
}
function acceptedStart(db:Database.Database,row:Row,detail:Row):boolean {
  if(!validAcceptanceDetail(detail)||detail.phase!=='confirmed'||row.opened_event_ref===null)return false;
  const opened=get(db,'SELECT event_seq,occurred_monotonic_ns,payload_json,source_clock_ref FROM events WHERE id=?',row.opened_event_ref);
  const membership=get(db,'SELECT proof_json FROM logical_memberships WHERE trip_ref=?',row.id);
  if(!opened || typeof membership?.proof_json!=='string' || typeof opened.occurred_monotonic_ns!=='string')return false;
  const profile=JSON.parse(membership.proof_json) as Row,payload=JSON.parse(String(opened.payload_json)) as {occurred:{configurationRevision:string;boundaryOrder:string}};
  const clock=get(db,'SELECT clock_uuid FROM clocks WHERE id=?',opened.source_clock_ref);
  if(profile.sourceClockId!==clock?.clock_uuid || profile.loadGeneration!==detail.loadGeneration || BigInt(String(profile.afterMonotonicNs))>BigInt(String(detail.absenceMonotonicNs))
    || BigInt(String(detail.absenceMonotonicNs))>BigInt(opened.occurred_monotonic_ns) || BigInt(String(detail.throughEventSeq))>=BigInt(String(opened.event_seq))
    || BigInt(String(detail.confirmedThroughEventSeq))<=BigInt(String(opened.event_seq))
    || BigInt(payload.occurred.configurationRevision)<=BigInt(String(detail.configurationRevision)) || BigInt(payload.occurred.boundaryOrder)<=BigInt(String(detail.absenceBoundaryOrder)))return false;
  const clear=get(db,"SELECT id FROM events WHERE plugin_session_id=? AND event_seq=? AND type='job.cleared' AND first_redelivered=0",row.plugin_session_ref,String(detail.clearEventSeq).padStart(20,'0'));
  if(!clear)return false;
  if(get(db,"SELECT id FROM events WHERE plugin_session_id=? AND event_seq>? AND event_seq<=? AND type IN ('job.configured','job.cleared') LIMIT 1",row.plugin_session_ref,
    String(detail.clearEventSeq).padStart(20,'0'),String(detail.throughEventSeq).padStart(20,'0')))return false;
  const intervening=db.prepare(`SELECT type,event_seq FROM events WHERE plugin_session_id=? AND event_seq>? AND event_seq<=? ORDER BY event_seq LIMIT 65`)
    .all(row.plugin_session_ref,String(detail.throughEventSeq).padStart(20,'0'),String(detail.confirmedThroughEventSeq).padStart(20,'0')) as Row[];
  if(intervening.length>64 || intervening.some(e=>['timers.restart','gameTime.regression','job.cleared'].includes(String(e.type))
    || e.type==='job.configured' && e.event_seq!==opened.event_seq))return false;
  return !get(db,'SELECT id FROM event_gaps WHERE plugin_session_ref=? AND last_event_seq>? AND first_event_seq<=? LIMIT 1',row.plugin_session_ref,
    String(detail.throughEventSeq).padStart(20,'0'),String(detail.confirmedThroughEventSeq).padStart(20,'0'));
}
/** Only source-qualified bounds strictly before every selected job in this session exclude a session-level loss. */
function beforeJobWindow(db:Database.Database,id:unknown,row:Row,interval:Row):boolean {
  if(interval.trip_ref!==null || interval.plugin_session_ref!==row.plugin_session_ref)return false;
  const first=get(db,`SELECT t.opened_event_ref,e.event_seq,e.occurred_monotonic_ns,e.source_clock_ref FROM trips t
    JOIN logical_memberships m ON m.trip_ref=t.id LEFT JOIN events e ON e.id=t.opened_event_ref
    WHERE m.logical_ref=? AND t.plugin_session_ref=? ORDER BY t.id LIMIT 1`,id,row.plugin_session_ref);
  if(typeof first?.event_seq!=='string')return false;
  if(typeof interval.first_event_seq==='string' && typeof interval.last_event_seq==='string')
    return interval.first_event_seq<=interval.last_event_seq && interval.last_event_seq<first.event_seq;
  return interval.source_clock_ref!==null && interval.source_clock_ref===first.source_clock_ref && interval.start_monotonic_ns!==null
    && typeof interval.start_monotonic_ns==='string' && typeof interval.end_monotonic_ns==='string' && typeof first.occurred_monotonic_ns==='string'
    && interval.start_monotonic_ns<=interval.end_monotonic_ns && interval.end_monotonic_ns<first.occurred_monotonic_ns;
}
const position = (v: unknown) => v === null || typeof v === 'object' && keys(v, 'x,y,z') && Object.values(v).every(n => typeof n === 'number' && Number.isFinite(n));
const point = (v: CapturedEndpoint | ProgressAnchor) => (v.truck === null || typeof v.truck === 'string' && v.truck.length > 0 && v.truck.length <= 2048)
  && nullableNumber(v.odometerM) && (v.odometerM === null || v.odometerM >= 0) && nullableNumber(v.fuelL) && (v.fuelL === null || v.fuelL >= 0)
  && nullableNumber(v.speedMps) && (v.gameClockId === null || isUuid(v.gameClockId)) && (v.gameMinutes === null || unsigned(v.gameMinutes)) && position(v.position);
export function validCapturedEndpoint(v: unknown): v is CapturedEndpoint {
  if (!v || typeof v !== 'object') return false;
  const c = v as CapturedEndpoint, fields = Object.keys(c).filter(k => k !== 'previous' && k !== 'running').sort().join(',');
  return fields === 'fuelL,gameClockId,gameMinutes,odometerM,position,simulation,speedMps,truck,version' && c.version === 1
    && ['running', 'paused'].includes(c.simulation) && point(c) && (c.previous === undefined || typeof c.previous === 'object' && c.previous !== null
      && keys(c.previous, 'monotonicNs,sourceClockId,tripUuid') && isUuid(c.previous.tripUuid) && isUuid(c.previous.sourceClockId) && unsigned(c.previous.monotonicNs))
    && (c.running === undefined || validCapturedRunning(c.running));
}
function validCapturedRunning(v: unknown): v is CapturedRunning {
  if (!v || typeof v !== 'object' || !keys(v,'fuelL,gameClockId,gameMinutes,monotonicNs,odometerM,pluginSessionId,position,profile,sourceClockId,speedMps,tripUuid,truck')) return false;
  const c=v as CapturedRunning,p=c.profile;
  return point(c) && isUuid(c.tripUuid) && isUuid(c.pluginSessionId) && isUuid(c.sourceClockId) && unsigned(c.monotonicNs)
    && !!p && typeof p==='object' && keys(p,'afterMonotonicNs,binding,game,loadGeneration,pluginSessionId,processInstanceId,scope,sourceClockId,version')
    && p.version===1 && /^[0-9a-f]{64}$/.test(p.scope) && /^[0-9a-f]{64}$/.test(p.binding) && ['ets2','ats'].includes(p.game)
    && isUuid(p.pluginSessionId) && isUuid(p.processInstanceId) && isUuid(p.sourceClockId) && unsigned(p.afterMonotonicNs)
    && Number.isSafeInteger(p.loadGeneration) && p.loadGeneration>=0;
}
function validEndpoint(v: unknown): v is CoverageEndpoint {
  if (!v || typeof v !== 'object' || Object.keys(v).filter(k=>k!=='running').sort().join(',') !== 'anchor,distanceM,fuelUsedL,head,prefixState,trip') return false;
  const c = v as CoverageEndpoint, a = c.anchor;
  const amount = (v: unknown) => !!v && typeof v === 'object' && ('available' in v && v.available === true ? keys(v, 'available,value')
    && 'value' in v && typeof v.value === 'number' && Number.isFinite(v.value) : keys(v, 'available,reason') && 'available' in v && v.available === false && 'reason' in v && v.reason === 'not-observed');
  return reference(c.trip) && nullableReference(c.head) && nullableReference(c.prefixState) && amount(c.distanceM) && amount(c.fuelUsedL)
    && (!c.distanceM.available || c.distanceM.value >= 0)
    && !!a && typeof a === 'object' && keys(a, 'fuelL,gameClockId,gameMinutes,monotonicNs,odometerM,pluginSessionId,position,sourceClockId,speedMps,truck')
    && isUuid(a.pluginSessionId) && isUuid(a.sourceClockId) && unsigned(a.monotonicNs) && point(a) && (c.running===undefined || validCapturedRunning(c.running)
      && c.running.pluginSessionId===a.pluginSessionId && c.running.sourceClockId===a.sourceClockId && c.running.gameClockId===a.gameClockId && c.running.truck===a.truck
      && c.running.profile.pluginSessionId===a.pluginSessionId
      && c.running.profile.sourceClockId===a.sourceClockId && BigInt(c.running.monotonicNs)<BigInt(a.monotonicNs)
      && BigInt(c.running.profile.afterMonotonicNs)<=BigInt(c.running.monotonicNs));
}
export function validCoverage(v: unknown): v is LogicalCoverage {
  if (!v || typeof v !== 'object' || Object.keys(v).filter(key=>key!=='acceptancePending'&&key!=='sampleResumePending').sort().join(',')!=='endpoint,losses,member,phase,start,version,window') return false;
  const c = v as LogicalCoverage;
  return (!Object.hasOwn(c,'acceptancePending') || typeof c.acceptancePending==='boolean')
    && (!Object.hasOwn(c,'sampleResumePending') || typeof c.sampleResumePending==='boolean') && c.version === 1 && ['observed', 'unproven'].includes(c.start) && Number.isInteger(c.losses) && c.losses >= 0 && c.losses <= 31
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
  const event = row.opened_event_ref === null ? undefined : get(db, 'SELECT event_seq,type,first_redelivered FROM events WHERE id=?', row.opened_event_ref);
  const started = event && get(db, "SELECT event_seq FROM events WHERE plugin_session_id=? AND event_seq<? AND type='simulation.started' ORDER BY event_seq DESC LIMIT 1", row.plugin_session_ref, event.event_seq);
  const previousJob = event && get(db, "SELECT event_seq,type,first_redelivered FROM events WHERE plugin_session_id=? AND event_seq<? AND type IN ('job.configured','job.cleared') ORDER BY event_seq DESC LIMIT 1", row.plugin_session_ref, event.event_seq);
  const reset = event && get(db, `SELECT id FROM events WHERE plugin_session_id=? AND event_seq>? AND event_seq<?
    AND (type='gameTime.regression' OR (?=1 AND type='timers.restart')) LIMIT 1`, row.plugin_session_ref,
    started?.event_seq ?? previousJob?.event_seq ?? '00000000000000000000', event.event_seq, started ? 1 : 0);
  // Both the absence and the start must remain trustworthy; a gap before a later clear can hide a load.
  const gapAfter = previousJob && started && String(started.event_seq) < String(previousJob.event_seq) ? started.event_seq : previousJob?.event_seq ?? '00000000000000000000';
  const gap = event && get(db, 'SELECT id FROM event_gaps WHERE plugin_session_ref=? AND last_event_seq>? AND first_event_seq<=? LIMIT 1', row.plugin_session_ref, gapAfter, event.event_seq);
  const notes=db.prepare('SELECT detail_json FROM completeness_intervals WHERE trip_ref=? ORDER BY id LIMIT 129').all(row.id) as Row[];
  // The reducer's durable witness includes initial checkpoint, reconnect and previous-job vetoes, absent from event history alone.
  const menu=notes.length<=128 && notes.some(note=>{const d=typeof note.detail_json==='string'?JSON.parse(note.detail_json) as Row:null;
    return d?.cause==='menu-job-acceptance' && d.version===1 && d.annotation===true && unsigned(d.atEventSeq)
      && d.atEventSeq.padStart(20,'0')===event?.event_seq;});
  const observed = row.opened_by === 'event' && event?.type === 'job.configured' && event.first_redelivered === 0n && (started || previousJob?.type === 'job.cleared' && menu) && !reset && !gap
    && (!previousJob || previousJob.type === 'job.cleared' && previousJob.first_redelivered === 0n);
  const pending=notes.some(note=>{const detail=typeof note.detail_json!=='string'?null:JSON.parse(note.detail_json) as Row;return detail?.cause==='observed-acceptance'&&detail.phase==='pending'&&validAcceptanceDetail(detail);});
  return {version: 1, start: observed ? 'observed' : 'unproven',
    ...(pending && !observed?{acceptancePending:true}:{}),losses: 0, member: String(row.id), phase: 'active', endpoint: null, window: null};
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
    if(beforeJobWindow(db,id,row,interval))continue;
    if(detail.cause==='menu-job-acceptance'){
      if(String(id)===String(row.id) && originalCoverage(db,row).start==='observed')coverage.start='observed';
      continue;
    }
    if(detail.cause==='observed-acceptance'){
      // A later member cannot establish the first recording's missing acceptance.
      if(acceptedStart(db,row,detail) && String(id)===String(row.id)){coverage.start='observed';if(coverage.acceptancePending)coverage.acceptancePending=false;}
      else if(!validAcceptanceDetail(detail))coverage.losses|=COVERAGE_LOSS.unknown;
      continue;
    }
    if (interval.trip_ref === id && ['opened-at-load','save-load'].includes(String(detail.cause))) coverage.start = 'unproven';
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
    if (interval.kind === 'discontinuity' && detail.annotation === true && (detail.label === 'crossing'
      || detail.cause === 'game-time-jump' && detail.label === 'possible-sleep' && detail.stationary === true)) continue;
    if (interval.kind === 'event-loss') coverage.losses |= COVERAGE_LOSS.event;
    else if (interval.kind === 'sample-loss') coverage.losses |= COVERAGE_LOSS.sample;
    else if (interval.kind === 'restore-loss') coverage.losses |= COVERAGE_LOSS.restore;
    else if (interval.kind === 'not-connected') coverage.losses |= COVERAGE_LOSS.unknown;
    else if (detail.annotation !== true || ['odometer-jump', 'position-jump', 'game-time-jump'].includes(String(detail.cause))) coverage.losses |= COVERAGE_LOSS.discontinuity;
  }
  if (coverage.phase === 'pending' && coverage.endpoint?.trip === coverage.member && cleanLoadWindow(db,row)) {coverage.phase='resumed';coverage.window=null;coverage.sampleResumePending=false;}
  return coverage;
}
export function applyCoverage(row: Row, group: Row, coverage: LogicalCoverage | undefined, present: boolean): void {
  if (coverage) {
    row._coverage = coverage;
    if(coverage.acceptancePending===true)row.recording_completeness='partial';
    else if (group.profile_scope !== null && coverage.start === 'observed' && coverage.losses === 0 && coverage.phase !== 'pending') row.recording_completeness = 'complete';
    else if (coverage.losses !== 0 || coverage.phase === 'pending' || Number(group.member_count) > 1) row.recording_completeness = 'partial';
  } else if (present || Number(group.member_count) > 1) row.recording_completeness = 'partial';
}
