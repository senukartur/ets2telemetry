import type Database from 'better-sqlite3';
import {V1_MAX_MINOR, validateServerMessage} from '../../../contracts/src/protocol-v1';
import type {TrailerBaselineInput} from '../api';
import {canonicalJson, u64Key} from '../codec';
import {fail} from '../errors';
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
export function ruleNativeBounds(db:Database.Database,session:unknown):{configured:string;cleared:string;gaps:string}{
  const event=(type:string)=>{
    const row=db.prepare('SELECT id FROM events WHERE plugin_session_id=? AND type=? ORDER BY id DESC LIMIT 1').get(session,type) as {id:bigint}|undefined;
    return String(row?.id??0n);
  };
  const gap=db.prepare('SELECT id FROM event_gaps WHERE plugin_session_ref=? ORDER BY id DESC LIMIT 1').get(session) as {id:bigint}|undefined;
  return {configured:event('trailer.configured'),cleared:event('trailer.cleared'),gaps:String(gap?.id??0n)};
}
