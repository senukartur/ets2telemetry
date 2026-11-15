import type Database from 'better-sqlite3';
import {V1_MAX_MINOR, validateServerMessage} from '../../../contracts/src/protocol-v1';
import type {TrailerBaselineInput} from '../api';
import {canonicalJson, u64Key} from '../codec';
import {fail} from '../errors';
import {MAX_UPLOAD_PROJECTION_PINS} from '../upload-projection';
import type {StorageConnection} from './connection';

/** Persist the actual checkpoint, including empty slots; it neither covers nor acknowledges native events. */
export function recordTrailerBaseline(conn: StorageConnection, input: TrailerBaselineInput): void {
  if (!input || Object.keys(input).join(',') !== 'message') fail('INVALID_INPUT');
  let message;
  try {message=validateServerMessage(input.message,{maxMinor:V1_MAX_MINOR});} catch {fail('INVALID_INPUT');}
  if (message.kind !== 'checkpoint' || !message.data.status.delivery.durable) fail('INVALID_INPUT');
  const m=message,db=conn.writer();
  db.transaction(()=>{
    const session=db.prepare('SELECT * FROM plugin_sessions WHERE plugin_session_uuid=?').get(m.source.pluginSessionId) as Record<string,unknown>|undefined;
    if(!session)fail('UNKNOWN_SESSION');
    if(session.game!==m.source.game||session.origin!==m.source.origin||session.process_instance_uuid!==m.source.processInstanceId
      ||Number(session.process_id)!==m.source.processId||Number(session.windows_session_id)!==m.source.windowsSessionId)fail('SESSION_CONFLICT');
    const slots={version:1,slots:m.data.state.configuration.trailers.map(slot=>slot.available?{available:true,value:{index:slot.value.index,
      id:slot.value.id,bodyType:slot.value.bodyType,chainType:slot.value.chainType}}:slot)};
    const args=[session.id,u64Key(m.data.status.delivery.nextEventSeq),m.capture.clockId,u64Key(m.capture.monotonicNs),u64Key(m.data.state.boundaryOrder)];
    const json=canonicalJson(slots),revision=u64Key(m.data.state.configuration.revision);
    const prior=db.prepare('SELECT configuration_revision,slots_json FROM trailer_baselines WHERE plugin_session_ref=? AND next_event_seq=? AND source_clock_uuid=? AND monotonic_ns=? AND boundary_order=?').get(...args) as Record<string,unknown>|undefined;
    if(prior){if(prior.configuration_revision!==revision||prior.slots_json!==json)fail('SESSION_CONFLICT');return;}
    db.prepare('INSERT INTO trailer_baselines(plugin_session_ref,next_event_seq,source_clock_uuid,monotonic_ns,boundary_order,configuration_revision,slots_json) VALUES(?,?,?,?,?,?,?)').run(...args,revision,json);
  }).immediate();
}


export const RULE_LOSSES=['event-loss','restore-loss','storage-unavailable'] as const;
/** Indexed bounded facts shared by preparation and material discovery; ordinary events are excluded. */
export function ruleLossBounds(db:Database.Database,session:unknown):Record<string,string>{
  return Object.fromEntries(RULE_LOSSES.map(kind=>{
    const row=db.prepare('SELECT id FROM completeness_intervals WHERE plugin_session_ref=? AND kind=? ORDER BY id DESC LIMIT 1').get(session,kind) as {id:bigint}|undefined;
    return [kind,String(row?.id??0n)];
  }));
}
export function ruleNativeBounds(db:Database.Database,session:unknown,joined=false){
  const event=(type:string)=>{
    const row=db.prepare('SELECT id FROM events WHERE plugin_session_id=? AND type=? ORDER BY id DESC LIMIT 1').get(session,type) as {id:bigint}|undefined;
    return String(row?.id??0n);
  };
  const gap=db.prepare('SELECT id FROM event_gaps WHERE plugin_session_ref=? ORDER BY id DESC LIMIT 1').get(session) as {id:bigint}|undefined;
  return {configured:event('trailer.configured'),cleared:event('trailer.cleared'),gaps:String(gap?.id??0n),
    ...(joined?{job:JOINED_JOB_EVENTS.map(event)}:{})};
}

export const JOINED_RULE_VERSION=1;
export interface JoinedRuleFence {
  version:typeof JOINED_RULE_VERSION;
  game:string;lastMember:string;lastSession:string;terminalSeq:string|null;terminalClock:string|null;terminalNs:string|null;
  minSession:string|null;maxSession:string|null;membersCopied:boolean;stale:boolean;
}
export function beyondRuleTerminal(fence:JoinedRuleFence,session:unknown,first:unknown,clock?:unknown,ns?:unknown):boolean{
  return String(session)===fence.lastSession&&fence.terminalSeq!==null
    &&(typeof first==='string'?first>fence.terminalSeq
      :fence.terminalClock!==null&&String(clock)===fence.terminalClock&&fence.terminalNs!==null&&typeof ns==='string'&&ns>fence.terminalNs);
}
const JOINED_JOB_EVENTS=['job.configured','job.cleared','job.delivered','job.cancelled','timers.restart','gameTime.regression'];
export const ruleEventType=(type:string)=>type==='trailer.configured'||type==='trailer.cleared'||JOINED_JOB_EVENTS.includes(type);

/** The caller owns the evidence commit. A stale ready pin retains its readable pages and frozen work keeps its bytes. */
export function fenceJoinedRuleEvidence(db:Database.Database,game:string,session:bigint,first:string|null,clock?:bigint|null,ns?:string|null):void{
  if(Number(db.pragma('user_version',{simple:true}))<7)return;
  const pins=db.prepare("SELECT pin_id,snapshot_json FROM upload_projection_pins WHERE state IN ('preparing','ready') LIMIT ?")
    .all(MAX_UPLOAD_PROJECTION_PINS) as {pin_id:string;snapshot_json:string}[];
  for(const pin of pins){
    const {joinedRule}=JSON.parse(pin.snapshot_json) as {joinedRule?:JoinedRuleFence};
    if(!joinedRule||joinedRule.version!==JOINED_RULE_VERSION||joinedRule.stale||game!==joinedRule.game)continue;
    if(joinedRule.membersCopied&&(joinedRule.minSession===null||joinedRule.maxSession===null
      ||session<BigInt(joinedRule.minSession)||session>BigInt(joinedRule.maxSession)))continue;
    if(beyondRuleTerminal(joinedRule,session,first,clock,ns))continue;
    db.prepare("UPDATE upload_projection_pins SET snapshot_json=json_set(snapshot_json,'$.joinedRule.stale',json('true')) WHERE pin_id=?").run(pin.pin_id);
  }
}
