import {MAX_UPLOAD_PROJECTION_PINS,isUploadUuid} from '../upload-projection';
import {randomUUID} from 'node:crypto';
import type {CommitOptions} from '../api';
import {fail} from '../errors';
import {isUploadSyncRequest,UPLOAD_MAX_BYTES,UPLOAD_MAX_EVENTS,type UploadConfirmation,type UploadConnectionResult,type UploadDiscoveryPage,type UploadInstallation,
  type UploadRegistration,type UploadRegistrationResult,type UploadScanProgress,type UploadStoreStatus,type UploadSyncCommands,type UploadSyncName} from '../upload-sync';
import type {StorageConnection} from './connection';
import {all,candidate,connection,discoverRevision,get,required,reservation,resolveBinding,type Row} from './upload-discovery';

export function check<K extends UploadSyncName>(name:K,input?:UploadSyncCommands[K]['args'] extends {input:infer I}?I:never):void {
  if(!isUploadSyncRequest(name==='ensureUploadInstallation'?{name}:{name,input}))fail('INVALID_INPUT');
}
export function syncTransaction<T>(conn:StorageConnection,body:(db:ReturnType<StorageConnection['writer']>)=>T,options?:CommitOptions):T {
  const db=conn.writer();return db.transaction(()=>{const result=body(db);options?.testHooks?.beforeCommit?.();return result;}).immediate();
}
export function pressure(db:ReturnType<StorageConnection['reader']>):boolean {
  const usage=required(get(db,'SELECT events,bytes,blocked FROM upload_queue_usage WHERE id=1'));return usage.blocked===1n||Number(usage.events)>=UPLOAD_MAX_EVENTS||Number(usage.bytes)>=UPLOAD_MAX_BYTES;
}
export function ensureUploadInstallation(conn:StorageConnection,options?:CommitOptions):UploadInstallation {
  return syncTransaction(conn,db=>{
    const state=connection(db),found=get(db,'SELECT client_uuid FROM upload_installation WHERE id=1');
    if(found)return found.client_uuid===state.client_uuid?{status:'ready',clientInstallationId:String(found.client_uuid)}:{status:'reconciliation-required',clientInstallationId:null};
    if(state.client_uuid!==null)return {status:'reconciliation-required',clientInstallationId:null};
    const uuid=randomUUID();db.prepare('INSERT INTO upload_installation VALUES(1,?)').run(uuid);db.prepare('UPDATE upload_connection SET client_uuid=? WHERE id=1').run(uuid);
    return {status:'ready',clientInstallationId:uuid};
  },options);
}
export function recordUploadRegistration(conn:StorageConnection,input:UploadRegistration,options?:CommitOptions):UploadRegistrationResult {
  check('recordUploadRegistration',input);
  return syncTransaction(conn,db=>{
    if(get(db,'SELECT client_uuid FROM upload_installation WHERE id=1')?.client_uuid!==input.clientInstallationId)return {status:'reconciliation-required',registrationId:input.registrationId};
    const prior=get(db,'SELECT * FROM upload_registrations WHERE registration_id=?',input.registrationId)
      ??get(db,'SELECT * FROM upload_registrations WHERE origin=? AND account_id=? AND company_id=? AND identity_epoch=?',input.origin,input.accountId,input.companyId,input.identityEpoch);
    const fields={client_uuid:input.clientInstallationId,origin:input.origin,account_id:input.accountId,company_id:input.companyId,identity_epoch:input.identityEpoch,installation_id:input.installationId,binding_id:input.bindingId};
    if(prior){
      if(Object.entries(fields).some(([key,value])=>prior[key]!==value)){
        db.prepare("UPDATE upload_registrations SET pause_reason='reconciliation' WHERE registration_id=?").run(prior.registration_id);
        return {status:'reconciliation-required',registrationId:String(prior.registration_id)};
      }
      return {status:'recorded',registrationId:String(prior.registration_id)};
    }
    db.prepare(`INSERT INTO upload_registrations(registration_id,client_uuid,origin,account_id,company_id,identity_epoch,installation_id,binding_id) VALUES(?,?,?,?,?,?,?,?)`)
      .run(input.registrationId,...Object.values(fields));
    db.prepare('INSERT INTO upload_owner_counters(registration_ref) VALUES(?)').run(input.registrationId);
    return {status:'recorded',registrationId:input.registrationId};
  },options);
}
export function confirmUploadOwner(conn:StorageConnection,input:UploadConfirmation,options?:CommitOptions):UploadConnectionResult {
  check('confirmUploadOwner',input);
  return syncTransaction(conn,db=>{
    const state=connection(db),prior=get(db,'SELECT * FROM upload_scan_runs WHERE run_id=?',input.confirmationId),request=JSON.stringify([input.confirmationId,input.registrationId,input.credentialGeneration,input.expectedVersion]);
    if(prior){if(prior.request_json!==request)return {status:'reconciliation-required',version:String(state.version),runId:input.confirmationId};
      return {status:'confirmed',version:String(BigInt(input.expectedVersion)+1n),runId:input.confirmationId};}
    if(String(state.version)!==input.expectedVersion)return {status:'stale',version:String(state.version),runId:null};
    const registration=required(get(db,'SELECT * FROM upload_registrations WHERE registration_id=?',input.registrationId));
    if(registration.pause_reason==='reconciliation'||registration.client_uuid!==state.client_uuid||!get(db,'SELECT 1 FROM upload_installation WHERE id=1'))return {status:'reconciliation-required',version:String(state.version),runId:null};
    const through=(state.next_ordinal as bigint)-1n,change=(state.next_change as bigint)-1n;
    const last=get(db,'SELECT last_ordinal FROM upload_history_claims ORDER BY first_ordinal DESC LIMIT 1');
    if((last?.last_ordinal??0n)!==state.claimed_through)return {status:'reconciliation-required',version:String(state.version),runId:null};
    const first=(state.claimed_through as bigint)+1n;
    db.prepare('INSERT INTO upload_scan_runs(run_id,registration_ref,request_json,ordinal_through,change_through) VALUES(?,?,?,?,?)').run(input.confirmationId,input.registrationId,request,through,change);
    if(first<=through)db.prepare('INSERT INTO upload_history_claims VALUES(?,?,?,?)').run(first,through,input.registrationId,input.confirmationId);
    db.prepare('UPDATE upload_connection SET version=version+1,claimed_through=?,active_registration=?,credential_generation=?,active_run=? WHERE id=1').run(through,input.registrationId,input.credentialGeneration,input.confirmationId);
    db.prepare('UPDATE upload_registrations SET pause_reason=NULL WHERE registration_id=?').run(input.registrationId);
    return {status:'confirmed',version:String((state.version as bigint)+1n),runId:input.confirmationId};
  },options);
}
export function disconnectUploadOwner(conn:StorageConnection,input:{expectedVersion:string},options?:CommitOptions):UploadConnectionResult {
  check('disconnectUploadOwner',input);return syncTransaction(conn,db=>{
    const state=connection(db);if(String(state.version)!==input.expectedVersion)return {status:'stale',version:String(state.version),runId:null};
    db.prepare('UPDATE upload_connection SET version=version+1,active_registration=NULL,credential_generation=NULL,active_run=NULL WHERE id=1').run();
    return {status:'disconnected',version:String((state.version as bigint)+1n),runId:null};
  },options);
}
export function getUploadStoreStatus(conn:StorageConnection,input:{registrationId:string}):UploadStoreStatus {
  check('getUploadStoreStatus',input);const db=conn.reader(),state=connection(db),counts=required(get(db,'SELECT * FROM upload_owner_counters WHERE registration_ref=?',input.registrationId));
  const registration=required(get(db,'SELECT pause_reason FROM upload_registrations WHERE registration_id=?',input.registrationId));
  return {registrationId:input.registrationId,version:String(state.version),active:state.active_registration===input.registrationId,paused:registration.pause_reason as UploadStoreStatus['paused'],
    discoveryAfter:String(counts.change_after),identityPendingSources:Number(counts.identity_pending_sources),pendingSources:Number(counts.pending_sources),heldSources:Number(counts.held_sources)+Number(counts.identity_held_sources),queuedEvents:Number(counts.queued_events),queuedBytes:Number(counts.queued_bytes),deliveredEvents:Number(counts.delivered_events),pressure:pressure(db)};
}
function scanStatus(run:Row,full=false):UploadScanProgress {
  return {runId:String(run.run_id),phase:full?'pressure':run.phase as UploadScanProgress['phase'],examined:Number(run.examined),cursor:{legacy:String(run.legacy_after),ordinal:String(run.ordinal_after)}};
}
function discoverCandidate(db:ReturnType<StorageConnection['writer']>,entry:Row|undefined,run:Row):void {
  if(!entry)return;const owner=reservation(db,entry);
  const member=get(db,'SELECT logical_ref FROM logical_memberships WHERE trip_ref=?',entry.trip_ref);if(!member)return;
  const revision=get(db,'SELECT id FROM logical_revisions WHERE logical_ref=? ORDER BY id DESC LIMIT 1',member.logical_ref);
  const head=get(db,'SELECT run_ref FROM upload_change_heads WHERE root_ref=?',member.logical_ref),bound=resolveBinding(db,member.logical_ref);
  if(revision&&!head)discoverRevision(db,member.logical_ref as bigint,revision.id,{mode:'backfill',runId:String(bound?.run_ref??owner.run_ref??run.run_id)});
  else if(head?.run_ref===null&&bound)db.prepare("UPDATE upload_change_heads SET mode='backfill',run_ref=? WHERE root_ref=?").run(bound.run_ref,member.logical_ref);
}
export function advanceUploadScan(conn:StorageConnection,input:{runId:string;registrationId:string},options?:CommitOptions):UploadScanProgress {
  check('advanceUploadScan',input);return syncTransaction(conn,db=>{
    const run=required(get(db,'SELECT * FROM upload_scan_runs WHERE run_id=? AND registration_ref=?',input.runId,input.registrationId));
    if(run.phase==='complete')return scanStatus({...run,examined:0});
    if(pressure(db))return scanStatus({...run,examined:0},true);
    let examined=0;
    while(examined<100&&run.phase!=='complete'){
      examined++;
      if(run.phase==='legacy'){
        const row=get(db,'SELECT id FROM trips WHERE id>? AND id<=? ORDER BY id LIMIT 1',run.legacy_after,connection(db).legacy_boundary);
        if(!row){run.phase='candidates';continue;}
        run.legacy_after=row.id;const entry=candidate(db,row.id);
        if(entry&&(entry.ordinal as bigint)<=(run.ordinal_through as bigint))discoverCandidate(db,entry,run);
      }else{
        const entry=get(db,'SELECT * FROM upload_candidates WHERE ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 1',run.ordinal_after,run.ordinal_through);
        if(!entry){run.phase='complete';continue;}run.ordinal_after=entry.ordinal;discoverCandidate(db,entry,run);
      }
    }
    db.prepare('UPDATE upload_scan_runs SET legacy_after=?,ordinal_after=?,phase=?,examined=? WHERE run_id=?').run(run.legacy_after,run.ordinal_after,run.phase,examined,input.runId);
    return scanStatus({...run,examined});
  },options);
}
export function pageUploadDiscovery(conn:StorageConnection,input:{registrationId:string;after:string;limit:number},options?:CommitOptions):UploadDiscoveryPage {
  check('pageUploadDiscovery',input);return syncTransaction(conn,db=>{
    const cursor=required(get(db,'SELECT change_after FROM upload_owner_counters WHERE registration_ref=?',input.registrationId));
    if(BigInt(input.after)>(cursor.change_after as bigint))fail('INVALID_INPUT');
    if(pressure(db))return {after:input.after,next:input.after,examined:0,items:[]};
    // Durable work and pending bindings remain independently enumerable after a lost feed/begin answer.
    // Each stream selects before inspecting rows. An empty indexed probe examines zero inputs; the first nonempty
    // stream owns this turn's entire <=100 budget, including rejected/held rows.
    const works=all(db,'SELECT * FROM upload_materializations WHERE registration_ref=? AND pin_released=0 ORDER BY work_id LIMIT ?',input.registrationId,input.limit);
    if(works.length){const items:UploadDiscoveryPage['items']=[];for(const work of works){const bound=get(db,'SELECT trip_uuid FROM upload_source_bindings WHERE root_ref=?',work.root_ref);if(bound)items.push({tripUuid:String(bound.trip_uuid),materialVersion:String(work.material_version),workId:String(work.work_id)});}
      return {after:input.after,next:input.after,examined:works.length,items};}
    const pending=all(db,'SELECT root_ref FROM upload_source_bindings WHERE registration_ref=? AND pending=1 AND held=0 ORDER BY root_ref LIMIT ?',input.registrationId,input.limit);
    if(pending.length){const items:UploadDiscoveryPage['items']=[];for(const row of pending){const bound=resolveBinding(db,row.root_ref),head=get(db,'SELECT material_version FROM upload_change_heads WHERE root_ref=?',row.root_ref);
      if(bound&&!head){db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE root_ref=?").run(row.root_ref);continue;}
      if(bound&&head)items.push({tripUuid:String(bound.trip_uuid),materialVersion:String(head.material_version),workId:null});}
      return {after:input.after,next:input.after,examined:pending.length,items};}
    const rows=all(db,'SELECT * FROM upload_source_transitions WHERE position>? ORDER BY position LIMIT ?',BigInt(input.after),input.limit),items:UploadDiscoveryPage['items']=[];
    for(const row of rows){const bound=resolveBinding(db,row.root_ref);if(bound?.registration_ref===input.registrationId&&bound.pending===1n&&bound.held===0n)items.push({tripUuid:String(bound.trip_uuid),materialVersion:String(row.material_version),workId:null});}
    const next=String(rows.at(-1)?.position as bigint|undefined??input.after);
    db.prepare('UPDATE upload_owner_counters SET change_after=max(change_after,?) WHERE registration_ref=?').run(BigInt(next),input.registrationId);
    return {after:input.after,next,examined:rows.length,items};
  },options);
}

const registrationDto=(row:Row):import('../upload-sync').UploadRegistration=>({registrationId:String(row.registration_id),clientInstallationId:String(row.client_uuid),origin:String(row.origin),accountId:String(row.account_id),companyId:String(row.company_id),identityEpoch:String(row.identity_epoch),installationId:String(row.installation_id),bindingId:String(row.binding_id)});
const nullableReference=(value:unknown):string|null=>{if(value===null||typeof value==='string')return value;fail('DATABASE_CORRUPT');};
export function getUploadConfiguration(conn:StorageConnection):import('../upload-sync').UploadActiveConfiguration {
  const db=conn.reader(),state=connection(db),info=required(get(db,'SELECT purpose FROM database_info WHERE id=1')),registration=state.active_registration===null?undefined:get(db,'SELECT * FROM upload_registrations WHERE registration_id=?',state.active_registration);
  const run=state.active_run===null?undefined:get(db,'SELECT registration_ref FROM upload_scan_runs WHERE run_id=?',state.active_run);
  const consistent=state.active_registration===null?state.credential_generation===null&&state.active_run===null:!!registration&&state.credential_generation!==null&&run?.registration_ref===state.active_registration;
  return {status:consistent?'ready':'reconciliation-required',purpose:info.purpose as 'history'|'synthetic'|'replay',version:String(state.version),registration:registration?registrationDto(registration):null,credentialGeneration:nullableReference(state.credential_generation),runId:nullableReference(state.active_run)};
}
export function pageUploadScanRuns(conn:StorageConnection,input:{registrationId:string;after:string|null;limit:number}):import('../upload-sync').UploadRunPage {
  check('pageUploadScanRuns',input);const rows=all(conn.reader(),'SELECT * FROM upload_scan_runs WHERE run_id>? ORDER BY run_id LIMIT ?',input.after??'',input.limit);
  return {after:input.after,next:rows.length?String(rows.at(-1)!.run_id):null,examined:rows.length,items:rows.filter(row=>row.registration_ref===input.registrationId).map(row=>scanStatus(row))};
}
export function pageUploadSources(conn:StorageConnection,input:{registrationId:string;phase:'sources'|'receipts';after:string|null;limit:number}):import('../upload-sync').UploadSourcePage {
  check('pageUploadSources',input);const db=conn.reader();const page:import('../upload-sync').UploadSourcePage={phase:input.phase,after:input.after,next:null,examined:0,sources:[],receipts:[]};
  if(input.phase==='receipts'){
    const parts=input.after?.split(':'),rows=all(db,"SELECT event_id,retry_at FROM upload_envelopes WHERE registration_ref=? AND state='delivered' AND (retry_at,event_id)>(?,?) ORDER BY retry_at,event_id LIMIT ?",input.registrationId,parts?Number(parts[1]):-1,parts?.[2]??'',input.limit);
    page.examined=rows.length;for(const row of rows){const receipt=get(db,'SELECT first_received FROM upload_receipts WHERE event_ref=?',row.event_id);if(receipt)page.receipts.push({eventId:String(row.event_id),firstReceivedUtcMs:Number(receipt.first_received)});}
    if(rows.length){const last=rows.at(-1)!;page.next=`r:${String(last.retry_at)}:${String(last.event_id)}`;}return page;
  }
  const rows=all(db,'SELECT * FROM upload_reservations WHERE registration_ref=? AND candidate_ref>? ORDER BY candidate_ref LIMIT ?',input.registrationId,BigInt(input.after??'0'),input.limit);page.examined=rows.length;
  for(const row of rows){const candidate=get(db,'SELECT trip_ref,trip_uuid FROM upload_candidates WHERE ordinal=?',row.candidate_ref);if(!candidate)continue;const member=get(db,'SELECT logical_ref FROM logical_memberships WHERE trip_ref=?',candidate.trip_ref);if(member?.logical_ref!==candidate.trip_ref)continue;
    const binding=get(db,'SELECT held,pending FROM upload_source_bindings WHERE root_ref=?',candidate.trip_ref),event=get(db,'SELECT event_id,revision,state FROM upload_envelopes WHERE root_ref=? ORDER BY revision DESC LIMIT 1',candidate.trip_ref),receipt=event?get(db,'SELECT first_received FROM upload_receipts WHERE event_ref=?',event.event_id):undefined;
    const state:import('../upload-sync').UploadSourceState['state']=binding?.held===1n||row.identity_state==='held'?'held':!binding?'identity-pending':event?.state==='held'?'held':binding.pending===1n?'pending':event&&receipt?'delivered':event?'queued':'pending';
    page.sources.push({tripUuid:String(candidate.trip_uuid),state,latestRevision:Number(event?.revision??0),lastReceiptUtcMs:receipt?Number(receipt.first_received):null});
  }
  if(rows.length)page.next=String(rows.at(-1)!.candidate_ref);return page;
}
export function getUploadSchedulingHints(conn:StorageConnection,input:{registrationId:string}):import('../upload-sync').UploadSchedulingHints {
  check('getUploadSchedulingHints',input);const db=conn.reader(),state=connection(db),owner=get(db,'SELECT pause_reason FROM upload_registrations WHERE registration_id=?',input.registrationId);let streak=0,streakOpen=true,connectionRetry=0,reconciliation=!owner,retryEventId:string|null=null;
  if(state.active_registration===input.registrationId)for(const attempt of all(db,'SELECT * FROM upload_attempt ORDER BY rowid DESC LIMIT 9')){
    if(attempt.registration_ref!==input.registrationId||attempt.connection_version!==state.version||attempt.credential_generation!==state.credential_generation)break;
    const envelope=get(db,'SELECT registration_ref,state,retry_at FROM upload_envelopes WHERE event_id=?',attempt.event_ref),receipt=get(db,'SELECT receipt_id,first_received FROM upload_receipts WHERE event_ref=?',attempt.event_ref);
    if(!envelope||!isUploadUuid(attempt.event_ref)||envelope.registration_ref!==input.registrationId||!Number.isSafeInteger(Number(envelope.retry_at))||Number(envelope.retry_at)<0||attempt.outcome==='receipt'&&!receipt||receipt&&(!isUploadUuid(receipt.receipt_id)||!Number.isSafeInteger(Number(receipt.first_received))||Number(receipt.first_received)<0||envelope.state!=='delivered')){reconciliation=true;break;}
    const transient=attempt.outcome==='retry',pending=['queued','sending'].includes(String(envelope.state));
    if(streakOpen){if(receipt||!transient&&attempt.outcome!=='ambiguous')streakOpen=false;else if(transient){if(!pending){reconciliation=true;break;}connectionRetry=Math.max(connectionRetry,Number(envelope.retry_at));streak++;}}
    // A new active attempt has no outcome; another event's receipt does not resolve this retry.
    if(!receipt&&transient&&pending)retryEventId??=String(attempt.event_ref);
  }
  const queued=get(db,"SELECT retry_at FROM upload_envelopes WHERE registration_ref=? AND state='queued' ORDER BY retry_at,event_id LIMIT 1",input.registrationId),held=get(db,"SELECT event_id,hold_reason FROM upload_envelopes WHERE registration_ref=? AND state='held' ORDER BY retry_at,event_id LIMIT 1",input.registrationId);
  const queuedRetry=queued?Number(queued.retry_at):null;if(queuedRetry!==null&&(!Number.isSafeInteger(queuedRetry)||queuedRetry<0)||held&&(!['validation','reconciliation'].includes(String(held.hold_reason))||get(db,'SELECT 1 FROM upload_receipts WHERE event_ref=?',held.event_id)))reconciliation=true;
  const pause=owner?.pause_reason,paused=pause==='authentication'||pause==='configuration'||pause==='reconciliation'?pause:null;if(pause!==null&&paused===null)reconciliation=true;
  return {status:reconciliation?'reconciliation-required':'ready',registrationId:input.registrationId,version:String(state.version),credentialGeneration:nullableReference(state.credential_generation),retryAtMs:queuedRetry!==null&&Number.isSafeInteger(queuedRetry)&&queuedRetry>=0?Math.max(connectionRetry,queuedRetry):null,failureStreak:streak,retryEventId,paused,held:held?held.hold_reason==='validation'?'validation':'reconciliation':null};
}

export function readRetainedUploadMaterializations(conn:StorageConnection):import('../upload-sync').RetainedUploadMaterializations {
  const db=conn.reader(),pins=all(db,'SELECT pin_id,root_ref,state FROM upload_projection_pins ORDER BY pin_id LIMIT ?',MAX_UPLOAD_PROJECTION_PINS),items:import('../upload-sync').RetainedUploadMaterializations['items']=[];let unmanagedPins=0;
  for(const pin of pins){const work=get(db,'SELECT * FROM upload_materializations WHERE pin_id=?',pin.pin_id),binding=get(db,'SELECT registration_ref FROM upload_source_bindings WHERE root_ref=?',pin.root_ref);
    if(!work||work.pin_released!==0n||work.root_ref!==pin.root_ref||work.registration_ref!==binding?.registration_ref||!isUploadUuid(work.work_id)||!isUploadUuid(work.registration_ref)||!['preparing','folding','complete','frozen','equal','held','stale'].includes(String(work.state))||['folding','complete'].includes(String(work.state))&&pin.state!=='ready'){unmanagedPins++;continue;}
    items.push({workId:String(work.work_id),registrationId:String(work.registration_ref),state:work.state as typeof items[number]['state']});
  }
  return {examined:pins.length,unmanagedPins,items};
}
