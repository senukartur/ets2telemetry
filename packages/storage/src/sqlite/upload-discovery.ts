import {validCoverage} from './logical-coverage';
import type Database from 'better-sqlite3';
import {fail} from '../errors';
export type Row=Record<string,unknown>;
export const get=(db:Database.Database,sql:string,...args:unknown[])=>db.prepare(sql).get(...args) as Row|undefined;
export const all=(db:Database.Database,sql:string,...args:unknown[])=>db.prepare(sql).all(...args) as Row[];
export const required=(row:Row|undefined):Row=>{if(!row)fail('INVALID_INPUT');return row;};
export const syncEnabled=(db:Database.Database)=>Number(db.pragma('user_version',{simple:true}))>=6;
export const connection=(db:Database.Database)=>required(get(db,'SELECT * FROM upload_connection WHERE id=1'));
export function candidate(db:Database.Database,trip:unknown):Row|undefined {
  const prior=get(db,'SELECT * FROM upload_candidates WHERE trip_ref=?',trip);if(prior)return prior;
  const t=get(db,`SELECT t.id,t.trip_uuid FROM trips t JOIN plugin_sessions s ON s.id=t.plugin_session_ref
    WHERE t.id=? AND s.origin='game' AND (SELECT purpose FROM database_info WHERE id=1)='history'`,trip);
  if(!t)return undefined;
  // Future inserts are allocated by the trip trigger, before any association. Only untouched legacy rows reach here.
  if((t.id as bigint)>(connection(db).legacy_boundary as bigint))fail('DATABASE_CORRUPT');
  db.prepare('INSERT INTO upload_candidates(ordinal,trip_ref,trip_uuid) VALUES(?,?,?)').run(t.id,t.id,t.trip_uuid);
  return required(get(db,'SELECT * FROM upload_candidates WHERE trip_ref=?',trip));
}
export function reservation(db:Database.Database,entry:Row):Row {
  let value=required(get(db,'SELECT * FROM upload_reservations WHERE candidate_ref=?',entry.ordinal));
  if(value.registration_ref===null){
    // Select the nearest range first, then check its end: no rejection scan across older claims.
    const claim=get(db,'SELECT * FROM upload_history_claims WHERE first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',entry.ordinal);
    if(claim && (claim.last_ordinal as bigint)>=(entry.ordinal as bigint)){
      db.prepare("UPDATE upload_reservations SET registration_ref=?,run_ref=?,mode='backfill' WHERE candidate_ref=? AND registration_ref IS NULL").run(claim.registration_ref,claim.run_ref,entry.ordinal);
      value=required(get(db,'SELECT * FROM upload_reservations WHERE candidate_ref=?',entry.ordinal));
    }else if((entry.ordinal as bigint)<=(connection(db).claimed_through as bigint)){db.prepare("UPDATE upload_reservations SET hold_reason='reconciliation-required' WHERE candidate_ref=?").run(entry.ordinal);value={...value,hold_reason:'reconciliation-required'};}
  }
  return value;
}
export function resolveBinding(db:Database.Database,root:unknown):Row|undefined {
  const t=get(db,`SELECT t.*,s.plugin_session_uuid,m.logical_ref,m.proof_json,l.retired FROM trips t JOIN logical_trips l ON l.id=t.id
    JOIN logical_memberships m ON m.trip_ref=t.id JOIN plugin_sessions s ON s.id=t.plugin_session_ref WHERE t.id=?`,root);
  if(!t)return undefined;
  const bound=get(db,'SELECT * FROM upload_source_bindings WHERE root_ref=?',root);
  if(t.logical_ref!==t.id){
    if(bound)db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE root_ref=?").run(root);
    return undefined;
  }
  if(bound)return bound;
  const entry=candidate(db,root);if(!entry)return undefined;
  const owner=reservation(db,entry);
  if(owner.hold_reason!==null || owner.registration_ref===null || t.proof_json===null&&t.retired===0n&&t.outcome==='open')return undefined;
  db.prepare(`INSERT INTO upload_source_bindings(root_ref,registration_ref,run_ref,mode,game,plugin_session_uuid,trip_uuid)
    VALUES(?,?,?,?,?,?,?)`).run(root,owner.registration_ref,owner.run_ref,owner.mode,t.game,t.plugin_session_uuid,t.trip_uuid);
  return required(get(db,'SELECT * FROM upload_source_bindings WHERE root_ref=?',root));
}
/** Called by revise inside the recorder transaction. No projection fold, payload serialization or history walk. */
export function discoverRevision(db:Database.Database,root:bigint,revision:unknown,delivery?:{mode:'backfill';runId:string}):void {
  if(!syncEnabled(db)||!candidate(db,root))return;
  const r=required(get(db,`SELECT r.state_ref,r.progress_head,l.retired,m.proof_json,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref
    JOIN logical_trips l ON l.id=r.logical_ref JOIN logical_memberships m ON m.trip_ref=l.id WHERE r.id=?`,revision));
  const row=JSON.parse(String(r.row_json)) as Row,outcome=String(row.outcome),head=r.progress_head===null?undefined:get(db,'SELECT distance_m,fuel_used_l FROM logical_progress WHERE id=?',r.progress_head);
  const evidence=get(db,'SELECT generation FROM upload_projection_evidence_versions WHERE root_ref=?',root)?.generation??0n;
  const fields=['game','game_mode','game_mode_method','game_mode_confidence','game_mode_ambiguous','job_configuration_ref','opened_by','opened_event_ref',
    'outcome','outcome_event_ref','close_reason','recording_completeness','started_utc_ms','ended_utc_ms','closed_by_session_ref','closed_by_event_seq',
    'observed_distance_m_state','fuel_used_l_state','is_hard_mode','hard_mode_details','_moneyIncomplete','_rawDistance','_rawFuel','_currentProgress'];
  // Separate material context/availability from ordinary OPEN counter values and update labels.
  const atom=(value:unknown)=>{const s=String(value&&typeof value==='object'&&'$integer' in value?value.$integer:value);return `${s.length}:${s}`;};
  const coverage=validCoverage(row._coverage)?row._coverage:undefined,endpoint=coverage?.endpoint;
  const quality=[coverage?.start,coverage?.phase,coverage?.losses,coverage?.acceptancePending??false,endpoint?.distanceM.available,endpoint?(endpoint.distanceM.available?null:endpoint.distanceM.reason):null,endpoint?.fuelUsedL.available,endpoint?(endpoint.fuelUsedL.available?null:endpoint.fuelUsedL.reason):null];
  const materialKey=[...fields.map(field=>row[field]),...quality,evidence,r.retired,r.proof_json===null?0:1,head?.distance_m===null?'distance-unknown':'distance-supported',
    head?.fuel_used_l===null?'fuel-unknown':'fuel-supported',...(outcome==='open'?[]:[r.progress_head,row.observed_distance_m,row.fuel_used_l,endpoint?.distanceM.available?endpoint.distanceM.value:null,endpoint?.fuelUsedL.available?endpoint.fuelUsedL.value:null])].map(atom).join('|');
  const prior=get(db,'SELECT * FROM upload_change_heads WHERE root_ref=?',root),material=!prior||prior.material_key!==materialKey||prior.dirty===1n;
  const position=connection(db).next_change;
  db.prepare('UPDATE upload_connection SET next_change=next_change+1 WHERE id=1').run();
  const version=prior?(prior.material_version as bigint)+(material?1n:0n):1n;
  const bound=resolveBinding(db,root),active=connection(db),mode=material?(delivery?.mode??'live'):prior.mode;
  const run=material?(delivery?.runId??(bound&&active.active_registration===bound.registration_ref?active.active_run:bound?.run_ref)??null):prior.run_ref;
  db.prepare(`INSERT INTO upload_change_heads(root_ref,revision_ref,position,material_version,material_key,dirty,mode,run_ref) VALUES(?,?,?,?,?,0,?,?) ON CONFLICT(root_ref) DO UPDATE SET revision_ref=excluded.revision_ref,
    position=excluded.position,material_version=excluded.material_version,material_key=excluded.material_key,dirty=0,mode=excluded.mode,run_ref=excluded.run_ref`).run(root,revision,position,version,materialKey,mode,run);
  if(material){
    const kind=!prior?'initial':outcome==='open'?'uncertainty':get(db,"SELECT 1 FROM upload_source_transitions WHERE root_ref=? AND kind IN ('terminal','correction') LIMIT 1",root)?'correction':'terminal';
    db.prepare('INSERT INTO upload_source_transitions(position,root_ref,revision_ref,material_version,kind,mode,run_ref) VALUES(?,?,?,?,?,?,?)').run(position,root,revision,version,kind,mode,run);
    db.prepare('UPDATE upload_source_bindings SET pending=1 WHERE root_ref=?').run(root);
  }
  resolveBinding(db,root);
}
export function retainUploadDeletion(db:Database.Database,trip:unknown,roots:readonly bigint[]):void {
  if(!syncEnabled(db))return;
  // An existing candidate, even explicitly unbound, is retained synchronization evidence.
  for(const root of roots){
    if(get(db,'SELECT 1 FROM upload_candidates WHERE trip_ref=?',root)||get(db,'SELECT 1 FROM upload_change_heads WHERE root_ref=?',root)
      ||get(db,'SELECT 1 FROM upload_source_bindings WHERE root_ref=?',root))fail('STORAGE_BUSY');
  }
  const entry=get(db,'SELECT ordinal FROM upload_candidates WHERE trip_ref=?',trip);
  if(entry)fail('STORAGE_BUSY');
  const boundary=connection(db).legacy_boundary as bigint;
  for(const ref of [trip,...roots])if(typeof ref==='bigint'&&ref<=boundary){
    const claim=get(db,'SELECT last_ordinal FROM upload_history_claims WHERE first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',ref);
    if(claim&&(claim.last_ordinal as bigint)>=ref)fail('STORAGE_BUSY');
  }
}

/** Association already knows both roots; preserve reservations without walking the member group. */
export function redirectReservation(db:Database.Database,incoming:unknown,target:unknown):void {
  if(!syncEnabled(db)||get(db,'SELECT 1 FROM upload_source_bindings WHERE root_ref=?',target))return;
  const own=candidate(db,target),other=candidate(db,incoming);if(!own||!other)return;
  const a=reservation(db,own),b=reservation(db,other);
  if(a.registration_ref===null&&b.registration_ref!==null)db.prepare("UPDATE upload_reservations SET hold_reason='reconciliation-required' WHERE candidate_ref=?").run(own.ordinal);
}
