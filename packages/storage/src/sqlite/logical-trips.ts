import type Database from 'better-sqlite3';
import type {JobConfiguration} from '../../../contracts/src/protocol-v1';
import {compatibleContinuation, continuationFingerprint, learnContinuationConstraints, type ContinuationConstraints, type ProfileObservation} from '../../../telemetry-core/src/trips/continuation';
import {advanceProgress, restoredProgress, type ProgressAnchor, type ProgressCheckpoint} from '../../../telemetry-core/src/trips/progress';
import type {SampleInput, TripEffect} from '../api';
import {fail} from '../errors';
import {jobValues} from './journal';
import {readHardModeDetails} from './hard-mode';

export type LogicalRow = Record<string, unknown>;
const get = (db: Database.Database, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as LogicalRow | undefined;
export const logicalEnabled = (db: Database.Database) => Number(db.pragma('user_version', {simple: true})) >= 4;
export const encodeRow = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => typeof v === 'bigint' ? {$integer: v.toString()} : v);
export const decodeRow = (value: unknown): LogicalRow => JSON.parse(String(value), (_key, v: unknown) =>
  v && typeof v === 'object' && '$integer' in v ? BigInt((v as {$integer: string}).$integer) : v) as LogicalRow;
const raw = (db: Database.Database, id: unknown) => get(db, 'SELECT * FROM trips WHERE id = ?', id)!;
const job = (db: Database.Database, row: LogicalRow) => jobValues(get(db, 'SELECT * FROM job_configurations WHERE id = ?', row.job_configuration_ref)!);
export function logicalFor(db: Database.Database, trip: unknown): bigint {
  const row = get(db, 'SELECT logical_ref FROM logical_memberships WHERE trip_ref = ?', trip);
  if (!row) fail('DATABASE_CORRUPT');
  return row.logical_ref as bigint;
}
function createGroup(db: Database.Database, row: LogicalRow): void {
  db.prepare('INSERT OR IGNORE INTO logical_trips(id, trip_uuid, latest_trip_ref, game) VALUES (?, ?, ?, ?)').run(row.id, row.trip_uuid, row.id, row.game);
  db.prepare('INSERT OR IGNORE INTO logical_memberships(trip_ref, logical_ref, decision_key) VALUES (?, ?, ?)').run(row.id, row.id, `open-v1:${String(row.trip_uuid)}`);
}
/** Private proof is source-qualified and bounded. Events older than this boundary cannot borrow it. */
export function admittedProfile(proof: ProfileObservation | undefined, source: {game: string; pluginSessionId: string; processInstanceId: string}, clock: string, at: string): ProfileObservation | undefined {
  if (proof === undefined) return undefined;
  if (typeof proof !== 'object' || proof === null || Object.keys(proof).sort().join(',') !== 'afterMonotonicNs,binding,game,loadGeneration,pluginSessionId,processInstanceId,scope,sourceClockId,version'
    || proof.version !== 1 || !/^[0-9a-f]{64}$/.test(proof.scope) || !/^[0-9a-f]{64}$/.test(proof.binding)
    || !Number.isSafeInteger(proof.loadGeneration) || proof.loadGeneration < 0 || !/^(0|[1-9][0-9]{0,19})$/.test(proof.afterMonotonicNs)
    || BigInt(proof.afterMonotonicNs) > 18_446_744_073_709_551_615n) fail('INVALID_INPUT');
  return proof.game === source.game && proof.pluginSessionId === source.pluginSessionId && proof.processInstanceId === source.processInstanceId
    && proof.sourceClockId === clock && BigInt(at) >= BigInt(proof.afterMonotonicNs) ? proof : undefined;
}
/** Bounded unresolved slot lookup; migrated history and already decided recordings never participate. */
export function associate(db: Database.Database, row: LogicalRow, proof: ProfileObservation | undefined, currentJob: JobConfiguration): bigint {
  createGroup(db, row);
  let id = logicalFor(db, row.id);const group=get(db,'SELECT * FROM logical_trips WHERE id=?',id)!;
  const membership = get(db, 'SELECT proof_json FROM logical_memberships WHERE trip_ref = ?', row.id)!;
  if (!proof || group.retired === 1n || row.outcome !== 'open') return id;
  const recordedJob=job(db,row),known=JSON.parse(String(group.canonical_constraints)) as ContinuationConstraints;
  const recorded=learnContinuationConstraints(known,recordedJob);
  const learned = recorded===null?null:learnContinuationConstraints(recorded,currentJob);
  if (membership.proof_json !== null) {
    if (learned) db.prepare('UPDATE logical_trips SET canonical_constraints=? WHERE id=?').run(JSON.stringify(learned),id);
    else db.prepare('UPDATE logical_trips SET retired=1 WHERE id=?').run(id);
    return id;
  }
  const fingerprint = continuationFingerprint(currentJob);
  const canonical=learned!==null && compatibleContinuation(recordedJob,currentJob);
  const candidates = db.prepare(`SELECT * FROM logical_trips WHERE game = ? AND profile_scope = ? AND retired = 0 AND id <> ? ORDER BY id LIMIT 2`)
    .all(row.game, proof.scope, id) as LogicalRow[];
  const candidate = candidates.length === 1 ? candidates[0] : undefined;
  const candidateRecorded=candidate?learnContinuationConstraints(JSON.parse(String(candidate.canonical_constraints)) as ContinuationConstraints,recordedJob):null;
  const combined = candidateRecorded===null?null:learnContinuationConstraints(candidateRecorded,currentJob);
  if (canonical && fingerprint !== null && candidate && candidate.fingerprint === fingerprint && combined !== null && compatibleContinuation(job(db, raw(db, candidate.id)), currentJob)) {
    // Keep the public UUID of the original recording. Never change a raw trip's session or event identity.
    db.prepare('UPDATE logical_memberships SET logical_ref = ?, previous_logical_ref = ?, joined_after_revision = (SELECT coalesce(max(id),0) FROM logical_revisions) WHERE trip_ref = ?').run(candidate.id, id, row.id);
    const abandonedGroup = id;
    db.prepare('UPDATE logical_trips SET retired = 1 WHERE id = ?').run(id);
    id = candidate.id as bigint;
    db.prepare('UPDATE logical_trips SET latest_trip_ref = ?, member_count = member_count + 1, accounting_rebased=1,canonical_constraints=? WHERE id = ?').run(row.id,JSON.stringify(combined), id);
    revise(db,abandonedGroup);
  } else {
    // Conflicting/ambiguous candidates are retired permanently; their outcome remains unknown.
    db.prepare('UPDATE logical_trips SET retired = 1, interrupted = 1 WHERE game = ? AND profile_scope = ? AND retired = 0 AND id <> ?').run(row.game, proof.scope, id);
    for (const previous of candidates) revise(db, previous.id as bigint);
  }
  db.prepare('UPDATE logical_memberships SET proof_json = ? WHERE trip_ref = ?').run(JSON.stringify(proof), row.id);
  db.prepare('UPDATE logical_trips SET profile_scope = ?, fingerprint = ?,canonical_constraints=? WHERE id = ?').run(proof.scope,canonical?fingerprint:null,JSON.stringify(candidate && id===candidate.id ? combined : learned ?? recorded ?? known),id);
  return id;
}

/** Summary uses opening identity, final observed outcome, and irreversible evidence from every recording. */
export function projectionRow(db: Database.Database, id: bigint, includeProgress=true): LogicalRow {
  const group = get(db, 'SELECT * FROM logical_trips WHERE id = ?', id)!, first = raw(db, id), last = raw(db, group.latest_trip_ref);
  const row: LogicalRow = {...last, id, trip_uuid: first.trip_uuid, plugin_session_ref: first.plugin_session_ref, job_configuration_ref: first.job_configuration_ref,
    opened_by: first.opened_by, opened_event_ref: first.opened_event_ref, started_utc_ms: first.started_utc_ms, created_utc_ms: first.created_utc_ms,
    game_mode: first.game_mode, game_mode_method: first.game_mode_method, game_mode_confidence: first.game_mode_confidence};
  const rawPath=Number(group.member_count)===1 && group.accounting_rebased===0n;
  row._moneyIncomplete=group.reconciliation_unknown===1n;
  row._currentProgress=group.progress_head===null || get(db,'SELECT trip_ref FROM logical_progress WHERE id=?',group.progress_head)!.trip_ref===group.latest_trip_ref;
  row._rawDistance=rawPath && row.observed_distance_m_state==='available';row._rawFuel=rawPath && row.fuel_used_l_state==='available';
  if (Number(group.member_count) > 1) row.recording_completeness = 'partial';
  if (group.mode_ambiguous === 1n || first.game_mode_ambiguous === 1n || last.game_mode_ambiguous === 1n
    || last.game_mode !== first.game_mode || last.game_mode_method !== first.game_mode_method || last.game_mode_confidence !== first.game_mode_confidence) row.game_mode_ambiguous = 1n;
  const opening = readHardModeDetails(first.hard_mode_details), latest = readHardModeDetails(last.hard_mode_details);
  const loss = group.first_loss_json === null ? null : JSON.parse(group.first_loss_json as string) as NonNullable<import('../../../contracts/src/hard-mode').HardModeDetails['firstLoss']>;
  if (opening && latest) row.hard_mode_details = JSON.stringify({...opening, latest: latest.latest, manualDelivery: latest.manualDelivery, firstLoss: loss ?? opening.firstLoss});
  if (group.hard_mode_lost === 1n) row.is_hard_mode = 0n;
  if (group.interrupted === 1n && row.outcome !== 'delivered' && row.outcome !== 'cancelled') {
    row.outcome = 'none'; row.close_reason = 'different-job';
  } else if (group.profile_scope !== null && group.retired === 0n && row.outcome === 'none') {
    row.outcome = 'open'; row.close_reason = null; row.ended_utc_ms = null; row.closed_by_session_ref = null; row.closed_by_event_seq = null;
  }
  if (group.progress_head !== null && includeProgress) applyProgress(db,row,group.progress_head);
  else if(group.progress_head!==null || Number(group.member_count)>1){
    if(!row._rawDistance){row.observed_distance_m=null;row.observed_distance_m_state='not-observed';}
    if(!row._rawFuel){row.fuel_used_l=null;row.fuel_used_l_state='not-observed';}
  }

  return row;
}
function latchEvidence(db: Database.Database, id: bigint): void {
  const group = get(db, 'SELECT latest_trip_ref FROM logical_trips WHERE id = ?', id)!, first = raw(db,id), last = raw(db,group.latest_trip_ref);
  const details = readHardModeDetails(last.hard_mode_details), firstDetails = readHardModeDetails(first.hard_mode_details);
  const loss = firstDetails?.firstLoss ?? details?.firstLoss;
  db.prepare(`UPDATE logical_trips SET hard_mode_lost = max(hard_mode_lost, ?), first_loss_json = coalesce(first_loss_json, ?),
    mode_ambiguous = max(mode_ambiguous, ?) WHERE id = ?`).run(!details || details.firstLoss !== null || !firstDetails || firstDetails.firstLoss !== null ? 1 : 0,
      loss ? JSON.stringify(loss) : null, first.game_mode_ambiguous === 1n || last.game_mode_ambiguous === 1n || last.game_mode !== first.game_mode
      || last.game_mode_method !== first.game_mode_method || last.game_mode_confidence !== first.game_mode_confidence ? 1 : 0, id);
}
export function revise(db: Database.Database, id: bigint): void {
  latchEvidence(db,id);
  const row = projectionRow(db, id,false), head = get(db, 'SELECT progress_head FROM logical_trips WHERE id = ?', id)!.progress_head;
  const max = (table: string) => get(db, `SELECT coalesce(max(id),0) AS id FROM ${table}`)!.id;
  const member = get(db, 'SELECT max(trip_ref) AS id FROM logical_memberships WHERE logical_ref = ?', id)!.id;

  const metadata=encodeRow(row);
  db.prepare('INSERT OR IGNORE INTO logical_projection_states(row_json) VALUES(?)').run(metadata);
  const state=get(db,'SELECT id FROM logical_projection_states WHERE row_json=?',metadata)!.id;
  db.prepare(`INSERT INTO logical_revisions(logical_ref,state_ref,member_through,event_through,gap_through,sample_through,interval_through,progress_head) VALUES(?,?,?,?,?,?,?,?)`)
    .run(id, state, member ?? 0n, max('events'), max('event_gaps'), max('samples'), max('completeness_intervals'), head);
}
export function projectEffects(db: Database.Database, effects: TripEffect[] | undefined, proof?: ProfileObservation): void {
  if (!logicalEnabled(db)) return;
  const affected = new Set<bigint>();
  for (const effect of effects ?? []) {
    const uuid = 'tripUuid' in effect ? effect.tripUuid : effect.kind === 'completeness.add' ? effect.interval.tripUuid : null;
    if (!uuid) continue;
    const row = get(db, 'SELECT * FROM trips WHERE trip_uuid = ?', uuid);
    if (!row) continue;
    createGroup(db, row);
    const id = effect.kind === 'trip.open' ? associate(db, row, proof, job(db, row)) : logicalFor(db, row.id);
    if (effect.kind === 'trip.close' && (effect.outcome === 'delivered' || effect.outcome === 'cancelled' || effect.closeReason === 'different-job'))
      db.prepare('UPDATE logical_trips SET retired = 1, interrupted = ? WHERE id = ?').run(effect.closeReason === 'different-job' ? 1 : 0, id);
    affected.add(id);
  }
  for (const id of affected) revise(db, id);
}

/** Sample endpoints, membership and the selected accounting head commit together. Raw samples are never rewritten. */
export function projectSample(db: Database.Database, session: {game: string; process_instance_uuid: string}, pluginSessionId: string, sample: SampleInput, sampleId: bigint): void {
  if (!logicalEnabled(db) || !sample.tripUuid || !sample.recording) return;
  const row = get(db, 'SELECT * FROM trips WHERE trip_uuid = ?', sample.tripUuid)!;
  if(sample.recording.processInstanceId!==session.process_instance_uuid) fail('INVALID_INPUT');
  const proof = admittedProfile(sample.recording.profile, {game: session.game, processInstanceId: session.process_instance_uuid, pluginSessionId}, sample.sourceClockId, sample.monotonicNs);
  const id = associate(db, row, proof, sample.recording.job);
  let truckRef:unknown=null;
  if(sample.recording.truck!==null){db.prepare('INSERT OR IGNORE INTO logical_trucks(identity_key) VALUES(?)').run(sample.recording.truck);truckRef=get(db,'SELECT id FROM logical_trucks WHERE identity_key=?',sample.recording.truck)!.id;}
  const group = get(db, 'SELECT * FROM logical_trips WHERE id = ?', id)!;
  const head = group.progress_head === null ? undefined : get(db, 'SELECT * FROM logical_progress WHERE id = ?', group.progress_head);
  const previous = head ? progressCheckpoint(db,head) : null;
  const anchor: ProgressAnchor = {gameClockId:sample.gameTime?.clockId ?? null,position:sample.position.available?sample.position.value:null,pluginSessionId, sourceClockId: sample.sourceClockId, monotonicNs: sample.monotonicNs, truck: sample.recording.truck,
    odometerM: sample.odometer.available ? sample.odometer.value : null, fuelL: sample.fuel.available ? sample.fuel.value : null};
  const sameSource = previous?.anchor.pluginSessionId === pluginSessionId && previous.anchor.sourceClockId === sample.sourceClockId;
  const elapsed = sameSource ? Number(BigInt(sample.monotonicNs) - BigInt(previous.anchor.monotonicNs)) / 1e9 : 0;
  const delta = previous?.anchor.odometerM === null || !previous || anchor.odometerM === null ? null : anchor.odometerM - previous.anchor.odometerM;
  const positionContinuous=!previous?.anchor.position || !anchor.position || Math.hypot(anchor.position.x-previous.anchor.position.x,anchor.position.y-previous.anchor.position.y,anchor.position.z-previous.anchor.position.z)<=100*elapsed+50;
  const predecessor=sample.recording.previous;
  const linked=predecessor && head && head.trip_ref===row.id && predecessor.tripUuid===sample.tripUuid && predecessor.sourceClockId===previous?.anchor.sourceClockId && predecessor.monotonicNs===previous?.anchor.monotonicNs;
  const continuous = !!linked && sameSource && previous?.anchor.gameClockId===anchor.gameClockId && positionContinuous && elapsed > 0 && elapsed < 5 && delta !== null && delta >= 0 && delta <= 100 * elapsed + 50;
  let value = advanceProgress(previous, anchor, continuous);
  let prefix: unknown = head?.prefix_ref ?? null, start: unknown = head?.start_ref ?? head?.id ?? null;
  if (previous && (!continuous || delta !== null && delta < 0)) {
    // Walk span prefixes, not per-sample history. Every run points directly to its start and retained prefix.
    let cursor = head, matched: {value: ProgressCheckpoint; prefix: unknown; start: unknown; end: LogicalRow} | undefined;
    let runs = 0;
    while (cursor && ++runs <= 256) {
      const begin = get(db, 'SELECT * FROM logical_progress WHERE id = ?', cursor.start_ref ?? cursor.id)!;
      const a = progressCheckpoint(db,begin), b = progressCheckpoint(db,cursor);
      const restored = restoredProgress(a, b, anchor);
      if (restored.distanceM.available) {matched = {value: restored, prefix: cursor.prefix_ref, start: begin.id, end: cursor}; break;}
      cursor = cursor.prefix_ref === null ? undefined : get(db, 'SELECT * FROM logical_progress WHERE id = ?', cursor.prefix_ref);
    }
    if (matched) {
      value = matched.value;db.prepare('UPDATE logical_trips SET accounting_rebased=1 WHERE id=?').run(id);
      // The cut references the old raw bounds and an odometer cutoff; it is not a fabricated sample/time/fuel reading.
      const cut = db.prepare(`INSERT INTO logical_progress(logical_ref,trip_ref,anchor_sample_ref,sample_ref,bound_sample_ref,prefix_ref,start_ref,cut_odometer_m,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l)
        VALUES(?,?,?,NULL,?,?,?,?,?,?,?,?,?)`).run(id, matched.end.trip_ref,sampleId, matched.end.bound_sample_ref, matched.prefix, matched.start, anchor.odometerM,
        truckRef, anchor.odometerM, matched.end.start_odometer_m, value.distanceM.available ? value.distanceM.value : null,
        value.fuelUsedL.available ? value.fuelUsedL.value : null);
      prefix = cut.lastInsertRowid; start = null;
    }
    else {
      db.prepare('UPDATE logical_trips SET accounting_rebased=1,reconciliation_unknown=1 WHERE id=?').run(id);
      // A known backward move abandons the old suffix even when no supported cut can recover its prefix.
      prefix = delta!==null && delta<0 ? null : head?.id ?? null; start = null;
    }
  }
  const result = db.prepare(`INSERT INTO logical_progress(logical_ref,trip_ref,anchor_sample_ref,sample_ref,bound_sample_ref,prefix_ref,start_ref,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, row.id, sampleId,sampleId, sampleId, prefix, start, truckRef, anchor.odometerM,
    start === null ? anchor.odometerM : get(db, 'SELECT odometer_m FROM logical_progress WHERE id = ?', start)?.odometer_m ?? null,
    value.distanceM.available ? value.distanceM.value : null, value.fuelUsedL.available ? value.fuelUsedL.value : null);
  db.prepare('UPDATE logical_trips SET progress_head = ? WHERE id = ?').run(result.lastInsertRowid, id);
}

/** Selected run ranges are materialized once for each page, bounded by the persisted prefix path. */
export const ACCOUNTING_PATH = `WITH RECURSIVE path AS (
  SELECT p.*,0 AS depth FROM logical_progress p WHERE p.id = @head
  UNION ALL SELECT p.*,x.depth+1 FROM path x JOIN logical_progress p ON p.id=x.prefix_ref WHERE x.depth<256
), ranges AS (
  SELECT coalesce(b.sample_ref,p.bound_sample_ref) AS first,p.bound_sample_ref AS last,p.cut_odometer_m
  FROM path p LEFT JOIN logical_progress b ON b.id=p.start_ref
)`;
export const INCLUDED_SAMPLE = `EXISTS(SELECT 1 FROM ranges r WHERE s.id>=r.first AND s.id<=r.last AND (r.cut_odometer_m IS NULL OR s.odometer_m<=r.cut_odometer_m))`;

/** A terminal seen after a gap still vetoes future matching, even when it cannot establish a trip's outcome. */
export function retireObservedTerminal(db: Database.Database, session: bigint): void {
  if (!logicalEnabled(db)) return;
  const last=get(db,'SELECT id FROM trips WHERE plugin_session_ref=? ORDER BY id DESC LIMIT 1',session);
  if (!last) return;
  const id=logicalFor(db,last.id);
  db.prepare('UPDATE logical_trips SET retired=1 WHERE id=?').run(id);revise(db,id);
}

export function progressCheckpoint(db:Database.Database,row:LogicalRow):ProgressCheckpoint {
  const sample=get(db,`SELECT s.fuel_l,s.odometer_m,s.monotonic_ns,s.x,s.y,s.z,c.clock_uuid,g.clock_uuid AS game_clock_uuid,p.plugin_session_uuid FROM samples s JOIN clocks c ON c.id=s.source_clock_ref LEFT JOIN clocks g ON g.id=s.game_clock_ref
    JOIN plugin_sessions p ON p.id=s.plugin_session_ref WHERE s.id=?`,row.anchor_sample_ref)!;
  const truck=row.truck_ref===null?null:String(get(db,'SELECT identity_key FROM logical_trucks WHERE id=?',row.truck_ref)!.identity_key);
  const available=(n:unknown)=>n===null?{available:false as const,reason:'not-observed' as const}:{available:true as const,value:Number(n)};
  return {anchor:{gameClockId:sample.game_clock_uuid===null?null:sample.game_clock_uuid as string,position:sample.x===null?null:{x:Number(sample.x),y:Number(sample.y),z:Number(sample.z)},pluginSessionId:String(sample.plugin_session_uuid),sourceClockId:String(sample.clock_uuid),monotonicNs:String(sample.monotonic_ns),truck,
    odometerM:sample.odometer_m===null?null:Number(sample.odometer_m),fuelL:sample.fuel_l===null?null:Number(sample.fuel_l)},distanceM:available(row.distance_m),fuelUsedL:available(row.fuel_used_l)};
}
export function applyProgress(db:Database.Database,row:LogicalRow,head:unknown):LogicalRow {
  if(head===null)return row;
  const point=get(db,'SELECT * FROM logical_progress WHERE id=?',head)!,progress=progressCheckpoint(db,point);
  if(row._currentProgress===false){row.observed_distance_m=null;row.observed_distance_m_state='not-observed';row.fuel_used_l=null;row.fuel_used_l_state='not-observed';return row;}
  if(point.start_ref===null && point.prefix_ref===null){progress.distanceM={available:false,reason:'not-observed'};progress.fuelUsedL={available:false,reason:'not-observed'};}
  for(const [column,reading] of [['observed_distance_m',progress.distanceM],['fuel_used_l',progress.fuelUsedL]] as const){if(column==='observed_distance_m'?row._rawDistance===true:row._rawFuel===true)continue;
    const invalid=reading.available && reading.value<0;row[column]=reading.available && !invalid?reading.value:null;row[`${column}_state`]=invalid?'invalid':reading.available?'available':reading.reason;}
  return row;
}

export function projectSessionBounds(db:Database.Database,session:bigint):void {
  if(!logicalEnabled(db))return;
  const rows=db.prepare("SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.plugin_session_ref=? AND t.outcome='open' ORDER BY t.id DESC LIMIT 1").all(session) as {logical_ref:bigint}[];
  for(const row of rows)revise(db,row.logical_ref);
}
