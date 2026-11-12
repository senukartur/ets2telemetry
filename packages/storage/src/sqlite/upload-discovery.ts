import {ruleLossBounds,ruleNativeBounds} from './trailer-baselines';
import {validCoverage} from './logical-coverage';
import {decisionState,identityPending} from './identity-pending';
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
function identityState(db:Database.Database,root:unknown,state:'unbound'|'pending'|'held'|'resolved'|'redirected'):void {
  // One reservation per original root, never one count per joined raw member. The trigger updates two owner points.
  db.prepare('UPDATE upload_reservations SET identity_state=? WHERE candidate_ref=(SELECT ordinal FROM upload_candidates WHERE trip_ref=?) AND identity_state<>?').run(state,root,state);
}
export function resolveBinding(db:Database.Database,root:unknown):Row|undefined {
  const t=get(db,`SELECT t.*,s.plugin_session_uuid,m.logical_ref,m.proof_json,l.retired,l.member_count AS group_members FROM trips t JOIN logical_trips l ON l.id=t.id
    JOIN logical_memberships m ON m.trip_ref=t.id JOIN plugin_sessions s ON s.id=t.plugin_session_ref WHERE t.id=?`,root);
  if(!t)return undefined;
  const bound=get(db,'SELECT * FROM upload_source_bindings WHERE root_ref=?',root);
  if(t.logical_ref!==t.id){
    identityState(db,root,'redirected');
    if(bound)db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE root_ref=?").run(root);
    return undefined;
  }
  // A root whose group holds another member with its own source binding carries that member's evidence again. Hold it here,
  // before begin, freeze and discovery publish anything and before an unbound root gets a binding, not only at the members fold.
  // A singleton group (member_count 1) has no other member, so it never runs the group join.
  const memberBound=(t.group_members as bigint)>1n&&get(db,`SELECT 1 FROM logical_memberships m JOIN upload_source_bindings b ON b.root_ref=m.trip_ref
    WHERE m.logical_ref=? AND m.trip_ref<>? LIMIT 1`,root,root)!==undefined;
  if(bound){
    identityState(db,root,'resolved');
    if(!memberBound||bound.held===1n)return bound;
    db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE root_ref=?").run(root);
    return required(get(db,'SELECT * FROM upload_source_bindings WHERE root_ref=?',root));
  }
  const entry=candidate(db,root);if(!entry)return undefined;
  let owner=reservation(db,entry);
  if(memberBound&&owner.hold_reason===null){
    db.prepare("UPDATE upload_reservations SET hold_reason='reconciliation-required' WHERE candidate_ref=?").run(entry.ordinal);
    owner={...owner,hold_reason:'reconciliation-required'};
  }
  // The bound check above returned already; a schema-9 pending decision holds the root like an unproven open trip.
  const pending=identityPending(t,decisionState(db,root),false);
  const state=owner.hold_reason!==null?'held':owner.registration_ref===null?'unbound':pending?'pending':'resolved';
  identityState(db,root,state);
  if(state!=='resolved')return undefined;
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
  const ruleContext=Number(db.pragma('user_version',{simple:true}))>=7
    ?JSON.stringify([outcome==='open'?ruleNativeBounds(db,BigInt((row.plugin_session_ref as {$integer:string}).$integer)):null,ruleLossBounds(db,BigInt((row.plugin_session_ref as {$integer:string}).$integer))]):null;
  const materialKey=[ruleContext,...fields.map(field=>row[field]),...quality,evidence,r.retired,r.proof_json===null?0:1,head?.distance_m===null?'distance-unknown':'distance-supported',
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
/** Checks the entire explicit deletion set before returning its unowned metadata cleanup. No guard mutates data. */
export function retainUploadDeletion(db:Database.Database,members:readonly bigint[],roots:readonly bigint[]):()=>void {
  if(!syncEnabled(db))return ()=>undefined;
  const state=get(db,'SELECT legacy_boundary,claimed_through FROM upload_connection WHERE id=1');if(!state)fail('STORAGE_BUSY');
  const refs=[...new Set([...members,...roots])];
  for(const ref of refs){
    const trip=get(db,'SELECT t.trip_uuid,s.origin FROM trips t JOIN plugin_sessions s ON s.id=t.plugin_session_ref WHERE t.id=?',ref);
    if(!trip)fail('STORAGE_BUSY');
    const entry=get(db,'SELECT * FROM upload_candidates WHERE trip_ref=?',ref),head=get(db,'SELECT run_ref FROM upload_change_heads WHERE root_ref=?',ref);
    // Every receipt and attempt depends on an envelope. Its indexed root guard protects those children too.
    if(get(db,'SELECT 1 FROM upload_source_bindings WHERE root_ref=?',ref)||get(db,'SELECT 1 FROM upload_materializations WHERE root_ref=? LIMIT 1',ref)
      ||get(db,'SELECT 1 FROM upload_envelopes WHERE root_ref=? LIMIT 1',ref)||get(db,'SELECT 1 FROM upload_projection_pins WHERE root_ref=? LIMIT 1',ref)
      ||head?.run_ref!==undefined&&head.run_ref!==null||get(db,'SELECT 1 FROM upload_source_transitions WHERE root_ref=? AND run_ref IS NOT NULL LIMIT 1',ref))fail('STORAGE_BUSY');
    let ordinal:bigint|undefined;
    if(entry){
      const reserved=get(db,'SELECT * FROM upload_reservations WHERE candidate_ref=?',entry.ordinal);
      if(entry.trip_uuid!==trip.trip_uuid||entry.opening_registration!==null||entry.opening_run!==null||!reserved||reserved.registration_ref!==null||reserved.run_ref!==null
        ||reserved.mode!=='unbound'||reserved.hold_reason!==null||!['unbound','redirected'].includes(String(reserved.identity_state)))fail('STORAGE_BUSY');
      ordinal=entry.ordinal as bigint;
    }else{
      // A head/transition without its observed candidate is inconsistent. Only untouched legacy rows use raw IDs.
      if(head||get(db,'SELECT 1 FROM upload_source_transitions WHERE root_ref=? LIMIT 1',ref))fail('STORAGE_BUSY');
      const eligible=trip.origin==='game'&&get(db,"SELECT 1 FROM database_info WHERE id=1 AND purpose='history'");
      if(ref<=(state.legacy_boundary as bigint))ordinal=ref;
      else if(eligible)fail('STORAGE_BUSY');
    }
    if(ordinal!==undefined){
      const claim=get(db,'SELECT last_ordinal FROM upload_history_claims WHERE first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1',ordinal);
      if(ordinal<=(state.claimed_through as bigint)||claim&&(claim.last_ordinal as bigint)>=ordinal)fail('STORAGE_BUSY');
    }
  }
  // Caller runs this only after its remaining guards (including rejectIfOpen). Remove discovery before source triggers.
  return ()=>{
    for(const ref of refs)db.prepare('DELETE FROM upload_source_transitions WHERE root_ref=?').run(ref);
    for(const ref of refs)db.prepare('DELETE FROM upload_change_heads WHERE root_ref=?').run(ref);
    for(const ref of refs)db.prepare('DELETE FROM upload_reservations WHERE candidate_ref=(SELECT ordinal FROM upload_candidates WHERE trip_ref=?)').run(ref);
    for(const ref of refs)db.prepare('DELETE FROM upload_candidates WHERE trip_ref=?').run(ref);
  };
}

/** Association already knows both roots; preserve reservations without walking the member group. */
export function redirectReservation(db:Database.Database,incoming:unknown,target:unknown):void {
  if(!syncEnabled(db)||get(db,'SELECT 1 FROM upload_source_bindings WHERE root_ref=?',target))return;
  const own=candidate(db,target),other=candidate(db,incoming);if(!own||!other)return;
  const a=reservation(db,own),b=reservation(db,other);
  if(a.registration_ref===null&&b.registration_ref!==null)db.prepare("UPDATE upload_reservations SET hold_reason='reconciliation-required' WHERE candidate_ref=?").run(own.ordinal);
}
