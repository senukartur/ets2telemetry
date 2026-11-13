import {randomUUID} from 'node:crypto';
import type {CommitOptions} from '../api';
import {fail} from '../errors';
import {beginUploadFold,advanceUploadFold,finishUploadFold,isUploadUuid,UPLOAD_PAGE_KINDS,type UploadFold,type UploadProjection} from '../upload-projection';
import {decodeUploadReceipt,encodeUploadEnvelope,uploadDigest,uploadMaterialDigest,type UploadEnvelope} from '../upload-envelope';
import {UPLOAD_MAX_BYTES,UPLOAD_MAX_EVENTS,type UploadSyncCommands,type UploadWork,type UploadWorkReason,type UploadAttemptResult,type UploadRegistration,type UploadReceiptResult,type UploadCleanup} from '../upload-sync';
import type {StorageConnection} from './connection';
import {all,connection,discoverRevision,get,required,resolveBinding,type Row} from './upload-discovery';
import {beginUploadProjection,advanceUploadProjection,readUploadProjectionPage,recheckUploadMaterialContext,releaseUploadProjection} from './upload-projection';
import {check,pressure,syncTransaction} from './upload-sync';

type Input<K extends keyof UploadSyncCommands>=UploadSyncCommands[K]['args'] extends {input:infer I}?I:never;
const workStatus=(work:Row):UploadWork=>({workId:String(work.work_id),status:work.state as UploadWork['status'],examined:Number(work.examined),eventId:typeof work.event_ref==='string'?work.event_ref:null,reason:work.hold_reason as UploadWorkReason|null});
const transient=(workId:string,status:UploadWork['status'],reason:UploadWorkReason|null=null):UploadWork=>({workId,status,examined:0,eventId:null,reason});
function hold(db:ReturnType<StorageConnection['writer']>,work:Row,reason:UploadWorkReason,status:'held'|'stale'='held'):UploadWork {
  db.prepare('UPDATE upload_materializations SET state=?,hold_reason=?,examined=0 WHERE work_id=?').run(status,reason,work.work_id);
  if(status==='held')db.prepare('UPDATE upload_source_bindings SET held=1,hold_reason=? WHERE root_ref=?').run(reason,work.root_ref);
  return workStatus({...work,state:status,hold_reason:reason,examined:0});
}
/** A changed source-loss highwater can invalidate an unfrozen pin without a recorder revision (closed session loss).
 * Refresh only the existing root/revision's material key; the next work gets a new version and pin, with no source mutation. */
function staleMaterial(db:ReturnType<StorageConnection['writer']>,work:Row):UploadWork {
  const head=get(db,'SELECT * FROM upload_change_heads WHERE root_ref=?',work.root_ref);
  const member=get(db,'SELECT logical_ref FROM logical_memberships WHERE trip_ref=?',work.root_ref);
  if(head&&head.material_version===work.material_version&&head.dirty===0n&&member?.logical_ref===work.root_ref){
    discoverRevision(db,work.root_ref as bigint,head.revision_ref);
  }
  return hold(db,work,'material-changed','stale');
}
export function beginUploadMaterialization(conn:StorageConnection,input:Input<'beginUploadMaterialization'>,options?:CommitOptions):UploadWork {
  check('beginUploadMaterialization',input);return syncTransaction(conn,db=>{
    const member=required(get(db,'SELECT m.logical_ref FROM trips t JOIN logical_memberships m ON m.trip_ref=t.id WHERE t.trip_uuid=?',input.tripUuid));
    const prior=get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId);
    if(prior){if(prior.root_ref!==member.logical_ref||prior.registration_ref!==input.registrationId)fail('INVALID_INPUT');return workStatus(prior);}
    const bound=resolveBinding(db,member.logical_ref);
    if(!bound){const reservation=get(db,'SELECT r.hold_reason FROM upload_reservations r JOIN upload_candidates c ON c.ordinal=r.candidate_ref WHERE c.trip_ref=?',member.logical_ref);return transient(input.workId,'held',reservation?.hold_reason==='reconciliation-required'?'reconciliation-required':'identity-pending');}
    if(bound.registration_ref!==input.registrationId||bound.held===1n)return transient(input.workId,'held','reconciliation-required');
    const head=get(db,'SELECT * FROM upload_change_heads WHERE root_ref=?',bound.root_ref);
    if(!head){db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE root_ref=?").run(bound.root_ref);return transient(input.workId,'held','reconciliation-required');}
    if(pressure(db))return transient(input.workId,'pressure','queue-pressure');
    if(get(db,'SELECT 1 FROM upload_materializations WHERE root_ref=? AND material_version=?',bound.root_ref,head.material_version))return transient(input.workId,'held','reconciliation-required');
    beginUploadProjection(conn,{pinId:input.workId,tripUuid:String(bound.trip_uuid)});
    db.prepare("INSERT INTO upload_materializations(work_id,root_ref,registration_ref,material_version,mode,run_ref,pin_id,state) VALUES(?,?,?,?,?,?,?,'preparing')").run(input.workId,bound.root_ref,input.registrationId,head.material_version,head.mode,head.run_ref??bound.run_ref,input.workId);
    return workStatus(required(get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId)));
  },options);
}
export function advanceUploadMaterialization(conn:StorageConnection,input:Input<'advanceUploadMaterialization'>,options?:CommitOptions):UploadWork {
  check('advanceUploadMaterialization',input);return syncTransaction(conn,db=>{
    const work=required(get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId));
    if(['preparing','folding'].includes(String(work.state))&&pressure(db))return transient(input.workId,'pressure','queue-pressure');
    if(work.state==='preparing'){
      const preparation=advanceUploadProjection(conn,String(work.pin_id));
      if(preparation.state==='invalidated')return staleMaterial(db,work);
      if(preparation.projection){db.prepare("UPDATE upload_materializations SET state='folding',pin_json=?,fold_json=?,examined=? WHERE work_id=?")
        .run(JSON.stringify(preparation.projection),JSON.stringify(beginUploadFold(preparation.projection)),preparation.examined,input.workId);}
      else db.prepare('UPDATE upload_materializations SET examined=? WHERE work_id=?').run(preparation.examined,input.workId);
    }else if(work.state==='folding'){
      const pin=JSON.parse(String(work.pin_json)) as UploadProjection,fold=JSON.parse(String(work.fold_json)) as UploadFold,kind=UPLOAD_PAGE_KINDS[fold.kind];
      if(!kind)return hold(db,work,'projection-invalid');
      const page=readUploadProjectionPage(conn,{snapshot:pin.snapshot,kind,cursor:fold.cursor??undefined,limit:100});
      if(kind==='members')for(const member of page.rows){
        const raw=required(get(db,'SELECT id FROM trips WHERE trip_uuid=?',(member as {rawTripUuid:string}).rawTripUuid));
        const saved=get(db,'SELECT r.candidate_ref FROM upload_reservations r JOIN upload_candidates c ON c.ordinal=r.candidate_ref WHERE c.trip_ref=?',raw.id);
        const published=get(db,'SELECT http_revision FROM upload_source_bindings WHERE root_ref=?',raw.id);
        if(!saved||raw.id!==work.root_ref&&published&&(published.http_revision as bigint)>0n)return hold(db,work,'reconciliation-required');
      }
      const next=advanceUploadFold(pin,fold,page,(uuid,session)=>{
        const trip=get(db,'SELECT id FROM trips WHERE trip_uuid=?',uuid);if(!trip)return false;
        const row=get(db,'SELECT row_json FROM upload_projection_members WHERE pin_ref=? AND trip_ref=?',work.pin_id,trip.id);
        return !!row&&(JSON.parse(String(row.row_json)) as {pluginSessionId:string}).pluginSessionId===session;
      });
      db.prepare('UPDATE upload_materializations SET state=?,fold_json=?,examined=? WHERE work_id=?').run(next.kind===3?'complete':'folding',JSON.stringify(next),page.rows.length||1,input.workId);
      if(next.invalid)return hold(db,work,'projection-invalid');
    }
    return workStatus(required(get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId)));
  },options);
}
export function freezeUploadMaterialization(conn:StorageConnection,input:Input<'freezeUploadMaterialization'>,options?:CommitOptions):UploadWork {
  check('freezeUploadMaterialization',input);return syncTransaction(conn,db=>{
    const work=required(get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId));if(work.state!=='complete')return workStatus(work);
    const pin=JSON.parse(String(work.pin_json)) as UploadProjection,head=get(db,'SELECT * FROM upload_change_heads WHERE root_ref=?',work.root_ref),bound=resolveBinding(db,work.root_ref);
    if(!bound||bound.registration_ref!==work.registration_ref||bound.held===1n)return hold(db,work,'reconciliation-required');
    if(!head||head.material_version!==work.material_version||head.dirty!==0n||!recheckUploadMaterialContext(db,pin))return staleMaterial(db,work);
    const registration=get(db,'SELECT * FROM upload_registrations WHERE registration_id=?',work.registration_ref),installation=get(db,'SELECT client_uuid FROM upload_installation WHERE id=1');
    if(!registration||!installation||registration.client_uuid!==installation.client_uuid||!get(db,'SELECT 1 FROM upload_candidates WHERE trip_ref=?',work.root_ref))return hold(db,work,'reconciliation-required');
    const owner=get(db,'SELECT r.* FROM upload_reservations r JOIN upload_candidates c ON c.ordinal=r.candidate_ref WHERE c.trip_ref=?',work.root_ref);
    if(!owner||owner.registration_ref!==bound.registration_ref||owner.run_ref!==bound.run_ref||owner.mode!==bound.mode||owner.hold_reason!==null)return hold(db,work,'reconciliation-required');
    const last=get(db,'SELECT revision FROM upload_envelopes WHERE root_ref=? ORDER BY revision DESC LIMIT 1',work.root_ref);
    if(last?.revision!==bound.http_revision && (last!==undefined||bound.http_revision!==0n) || bound.http_revision!==0n&&bound.material_digest===null)return hold(db,work,'reconciliation-required');
    const mapping=finishUploadFold(pin,JSON.parse(String(work.fold_json)) as UploadFold);
    if(mapping.status==='hold')return hold(db,work,'projection-invalid');
    const digest=uploadMaterialDigest(mapping.summary);
    if(digest===bound.material_digest){
      db.prepare("UPDATE upload_materializations SET state='equal',examined=0 WHERE work_id=?").run(input.workId);
      db.prepare('UPDATE upload_source_bindings SET compared_version=?,pending=0,held=0,hold_reason=NULL WHERE root_ref=?').run(work.material_version,work.root_ref);
      return workStatus({...work,state:'equal',examined:0});
    }
    const outcome=mapping.summary.snapshot.outcome;
    if(bound.terminal===1n&&outcome==='open')return hold(db,work,'reconciliation-required');
    if((bound.http_revision as bigint)>=BigInt(Number.MAX_SAFE_INTEGER))return hold(db,work,'revision-exhausted');
    // The event minor fixes the frozen shape: v1.0 has neither field, v1.1 adds hardModeResult and v1.2 adds accounting.
    const minor = input.contractMinor === 2 ? 2 : input.contractMinor === 1 ? 1 : 0;
    const summary = structuredClone(mapping.summary);
    if (minor === 0) {
      delete summary.snapshot.hardModeResult;
    }
    if (minor < 2) {
      delete summary.snapshot.accounting;
    }
    const envelope:UploadEnvelope={...summary,contract:{major:1,minor},producer:{application:'ets2telemetry',version:input.producerVersion},eventId:randomUUID(),revision:Number(bound.http_revision)+1,
      installationId:String(registration.installation_id),bindingId:String(registration.binding_id),delivery:{mode:work.mode as 'live'|'backfill',syncRunId:String(work.run_ref)},
      type:bound.terminal===1n?'trip.corrected':outcome==='open'?'trip.started':outcome==='delivered'?'trip.completed':outcome==='cancelled'?'trip.cancelled':'trip.closed',createdUtcMs:input.createdUtcMs};
    const bytes=encodeUploadEnvelope(envelope);if(!bytes)return hold(db,work,'projection-invalid');
    const usage=required(get(db,'SELECT * FROM upload_queue_usage WHERE id=1'));
    if(Number(usage.events)+1>UPLOAD_MAX_EVENTS||Number(usage.bytes)+bytes.byteLength>UPLOAD_MAX_BYTES){db.prepare('UPDATE upload_queue_usage SET blocked=1 WHERE id=1').run();return transient(input.workId,'pressure','queue-pressure');}
    db.prepare("INSERT INTO upload_envelopes(event_id,work_ref,root_ref,registration_ref,mode,revision,payload,byte_count,payload_digest,state) VALUES(?,?,?,?,?,?,?,?,?,'queued')")
      .run(envelope.eventId,input.workId,work.root_ref,work.registration_ref,work.mode,envelope.revision,Buffer.from(bytes),bytes.byteLength,uploadDigest(bytes));
    db.prepare("UPDATE upload_materializations SET state='frozen',event_ref=?,examined=0 WHERE work_id=?").run(envelope.eventId,input.workId);
    db.prepare('UPDATE upload_source_bindings SET http_revision=?,material_digest=?,terminal=?,compared_version=?,pending=0,held=0,hold_reason=NULL WHERE root_ref=?')
      .run(envelope.revision,digest,outcome==='open'?0:1,work.material_version,work.root_ref);
    db.prepare('UPDATE upload_queue_usage SET events=events+1,bytes=bytes+? WHERE id=1').run(bytes.byteLength);
    db.prepare('UPDATE upload_owner_counters SET queued_events=queued_events+1,queued_bytes=queued_bytes+? WHERE registration_ref=?').run(bytes.byteLength,work.registration_ref);
    return workStatus({...work,state:'frozen',event_ref:envelope.eventId,examined:0});
  },options);
}
export function releaseUploadMaterialization(conn:StorageConnection,input:Input<'releaseUploadMaterialization'>,options?:CommitOptions):UploadWork {
  check('releaseUploadMaterialization',input);return syncTransaction(conn,db=>{
    const work=required(get(db,'SELECT * FROM upload_materializations WHERE work_id=?',input.workId));
    if(['preparing','folding','complete'].includes(String(work.state)))fail('STORAGE_BUSY');
    const released=releaseUploadProjection(conn,String(work.pin_id));if(released.state==='released')db.prepare('UPDATE upload_materializations SET pin_released=1 WHERE work_id=?').run(input.workId);return {...workStatus(work),status:released.state==='released'?'released':work.state as UploadWork['status'],examined:released.examined};
  },options);
}
const attemptReply=(status:UploadAttemptResult['status'],row?:Row,payload:Uint8Array|null=null,registration:UploadRegistration|null=null):UploadAttemptResult=>({status,attemptId:row?String(row.attempt_id):null,eventId:row?String(row.event_ref):null,registrationId:row?String(row.registration_ref):null,registration,payload});
const freshAttempt=(state:Row,attempt:Row)=>state.active_registration===attempt.registration_ref&&state.version===attempt.connection_version&&state.credential_generation===attempt.credential_generation;
function reconcile(db:ReturnType<StorageConnection['writer']>,registration:unknown):void {db.prepare("UPDATE upload_registrations SET pause_reason='reconciliation' WHERE registration_id=?").run(registration);}
export function claimUploadAttempt(conn:StorageConnection,input:Input<'claimUploadAttempt'>,options?:CommitOptions):UploadAttemptResult {
  check('claimUploadAttempt',input);return syncTransaction(conn,db=>{
    const state=connection(db),registration=get(db,'SELECT * FROM upload_registrations WHERE registration_id=?',input.registrationId),prior=get(db,'SELECT * FROM upload_attempt WHERE attempt_id=?',input.attemptId);
    if(prior&&prior.registration_ref!==input.registrationId)fail('INVALID_INPUT');
    if(prior?.active===1n&&!freshAttempt(state,prior))return attemptReply('stale',prior);
    if(!registration)return attemptReply('reconciliation-required');
    if(state.active_registration!==input.registrationId||String(state.version)!==input.expectedVersion||registration.pause_reason!==null)return attemptReply('paused');
    const active=get(db,'SELECT * FROM upload_attempt WHERE active=1');
    if(active && active.attempt_id!==input.attemptId)return attemptReply('busy');
    if(prior&&prior.active!==1n){const receipt=get(db,'SELECT 1 FROM upload_receipts WHERE event_ref=?',prior.event_ref);if(prior.outcome==='receipt'&&!receipt){reconcile(db,input.registrationId);return attemptReply('reconciliation-required');}return attemptReply(receipt?'delivered':'recorded',prior);}
    const envelope=prior?get(db,'SELECT * FROM upload_envelopes WHERE event_id=?',prior.event_ref):input.mode==='any'?get(db,"SELECT * FROM upload_envelopes WHERE registration_ref=? AND state='queued' AND retry_at<=? ORDER BY retry_at,event_id LIMIT 1",input.registrationId,input.nowMs):get(db,"SELECT * FROM upload_envelopes WHERE registration_ref=? AND state='queued' AND mode=? AND retry_at<=? ORDER BY retry_at,event_id LIMIT 1",input.registrationId,input.mode,input.nowMs);
    if(!envelope)return attemptReply('empty');
    if(!(envelope.payload instanceof Uint8Array)||envelope.payload.byteLength!==Number(envelope.byte_count)||uploadDigest(envelope.payload)!==envelope.payload_digest){reconcile(db,input.registrationId);return attemptReply('reconciliation-required');}
    const row=prior??{attempt_id:input.attemptId,event_ref:envelope.event_id,registration_ref:input.registrationId};
    if(!prior)db.prepare('INSERT INTO upload_attempt(attempt_id,event_ref,registration_ref,credential_generation,connection_version,started_at,active) VALUES(?,?,?,?,?,?,1)')
      .run(input.attemptId,envelope.event_id,input.registrationId,state.credential_generation,state.version,input.nowMs);
    db.prepare("UPDATE upload_envelopes SET state='sending' WHERE event_id=?").run(envelope.event_id);
    return attemptReply('claimed',row,new Uint8Array(envelope.payload),{registrationId:input.registrationId,clientInstallationId:String(registration.client_uuid),origin:String(registration.origin),accountId:String(registration.account_id),companyId:String(registration.company_id),identityEpoch:String(registration.identity_epoch),installationId:String(registration.installation_id),bindingId:String(registration.binding_id)});
  },options);
}
export function recordUploadAttemptOutcome(conn:StorageConnection,input:Input<'recordUploadAttemptOutcome'>,options?:CommitOptions):UploadAttemptResult {
  check('recordUploadAttemptOutcome',input);if(input.retryAtMs<input.nowMs)fail('INVALID_INPUT');return syncTransaction(conn,db=>{
    const attempt=required(get(db,'SELECT * FROM upload_attempt WHERE attempt_id=?',input.attemptId)),receipt=get(db,'SELECT * FROM upload_receipts WHERE event_ref=?',attempt.event_ref),envelope=get(db,'SELECT state,registration_ref FROM upload_envelopes WHERE event_id=?',attempt.event_ref);
    if(receipt){
      if(!isUploadUuid(receipt.receipt_id)||!Number.isSafeInteger(Number(receipt.first_received))||Number(receipt.first_received)<0||envelope?.state!=='delivered'||envelope.registration_ref!==attempt.registration_ref||!get(db,'SELECT 1 FROM upload_registrations WHERE registration_id=?',attempt.registration_ref)){reconcile(db,attempt.registration_ref);return attemptReply('reconciliation-required',attempt);}
      return attemptReply('delivered',attempt);
    }
    if(attempt.outcome==='receipt'||envelope?.state==='delivered'){reconcile(db,attempt.registration_ref);return attemptReply('reconciliation-required',attempt);}
    if(attempt.active!==1n)return attemptReply('stale',attempt);
    if(!freshAttempt(connection(db),attempt)){
      db.prepare("UPDATE upload_envelopes SET state='queued' WHERE event_id=? AND state='sending'").run(attempt.event_ref);
      db.prepare("UPDATE upload_attempt SET active=0,outcome='ambiguous' WHERE attempt_id=?").run(input.attemptId);
      return attemptReply('stale',attempt);
    }
    if(!envelope||!get(db,'SELECT 1 FROM upload_registrations WHERE registration_id=?',attempt.registration_ref)){reconcile(db,attempt.registration_ref);return attemptReply('reconciliation-required',attempt);}
    const queued=input.kind==='retry'||input.kind==='authentication'||input.kind==='configuration';
    db.prepare('UPDATE upload_envelopes SET state=?,retry_at=?,hold_reason=? WHERE event_id=?').run(queued?'queued':'held',input.retryAtMs,input.kind==='retry'?null:input.kind,attempt.event_ref);
    if(['authentication','configuration','reconciliation'].includes(input.kind))db.prepare('UPDATE upload_registrations SET pause_reason=? WHERE registration_id=?').run(input.kind,attempt.registration_ref);
    db.prepare('UPDATE upload_attempt SET active=0,outcome=? WHERE attempt_id=?').run(input.kind,input.attemptId);return attemptReply('recorded',attempt);
  },options);
}
export function recoverUploadAttempt(conn:StorageConnection,input:Input<'recoverUploadAttempt'>,options?:CommitOptions):UploadAttemptResult {
  check('recoverUploadAttempt',input);return syncTransaction(conn,db=>{
    // Startup recovery is explicit: the trusted consumer must first establish that its predecessor has ended.
    // A normal busy claim never invokes this path or preempts an HTTP request that may still be in flight.
    const found='startup' in input?get(db,'SELECT * FROM upload_attempt WHERE active=1'):get(db,'SELECT * FROM upload_attempt WHERE attempt_id=?',input.attemptId);
    if(!found&&'startup' in input)return attemptReply('empty');
    const attempt=required(found),receipt=get(db,'SELECT 1 FROM upload_receipts WHERE event_ref=?',attempt.event_ref),envelope=get(db,'SELECT state,payload FROM upload_envelopes WHERE event_id=?',attempt.event_ref);
    const missing=!get(db,'SELECT 1 FROM upload_registrations WHERE registration_id=?',attempt.registration_ref)||!envelope||!receipt&&(attempt.outcome==='receipt'||envelope.state==='delivered'||!(envelope.payload instanceof Uint8Array));
    if(missing){
      reconcile(db,attempt.registration_ref);
      if(attempt.active===1n){db.prepare("UPDATE upload_envelopes SET state='held',hold_reason='reconciliation' WHERE event_id=?").run(attempt.event_ref);db.prepare("UPDATE upload_attempt SET active=0,outcome='reconciliation' WHERE attempt_id=?").run(attempt.attempt_id);}
      return attemptReply('reconciliation-required',attempt);
    }
    if(attempt.active===1n){db.prepare("UPDATE upload_envelopes SET state='queued' WHERE event_id=? AND state='sending'").run(attempt.event_ref);db.prepare("UPDATE upload_attempt SET active=0,outcome='ambiguous' WHERE attempt_id=?").run(attempt.attempt_id);}
    return attemptReply(receipt?'delivered':'recovered',attempt);
  },options);
}
/**
 * The contract minor of the frozen bytes, which a receipt must echo. The bytes are reclaimed only after a committed
 * receipt, so without them (undefined) the stored receipt identity decides a replay. Unreadable bytes (null) accept no
 * receipt version.
 */
function frozenMinor(payload:unknown):0|1|2|null|undefined {
  if(!(payload instanceof Uint8Array))return undefined;
  try{const minor=(JSON.parse(Buffer.from(payload).toString('utf8')) as {contract?:{minor?:unknown}}).contract?.minor;if(minor===0||minor===1||minor===2)return minor;}catch{/* Unreadable bytes: no version matches. */}
  return null;
}
export function commitUploadReceipt(conn:StorageConnection,input:Input<'commitUploadReceipt'>,options?:CommitOptions):UploadReceiptResult {
  check('commitUploadReceipt',input);return syncTransaction(conn,db=>{
    const attempt=required(get(db,'SELECT * FROM upload_attempt WHERE attempt_id=?',input.attemptId)),eventId=String(attempt.event_ref);
    const receipt=decodeUploadReceipt(input.body,input.statusCode,eventId,frozenMinor(get(db,'SELECT payload FROM upload_envelopes WHERE event_id=?',eventId)?.payload));if(!receipt)return {status:'invalid-response',eventId,receiptId:null};
    const prior=get(db,'SELECT * FROM upload_receipts WHERE event_ref=?',eventId);
    if(prior){if(prior.receipt_id!==receipt.receiptId||Number(prior.first_received)!==receipt.firstReceivedAtUtcMs){reconcile(db,attempt.registration_ref);return {status:'reconciliation-required',eventId,receiptId:String(prior.receipt_id)};}
      return {status:'duplicate',eventId,receiptId:receipt.receiptId};}
    if(attempt.outcome==='receipt'||get(db,'SELECT state FROM upload_envelopes WHERE event_id=?',eventId)?.state==='delivered'){reconcile(db,attempt.registration_ref);return {status:'reconciliation-required',eventId,receiptId:null};}
    if(get(db,'SELECT 1 FROM upload_receipts WHERE receipt_id=?',receipt.receiptId)){reconcile(db,attempt.registration_ref);return {status:'reconciliation-required',eventId,receiptId:null};}
    db.prepare('INSERT INTO upload_receipts VALUES(?,?,?)').run(eventId,receipt.receiptId,receipt.firstReceivedAtUtcMs);
    db.prepare("UPDATE upload_envelopes SET state='delivered',hold_reason=NULL WHERE event_id=?").run(eventId);
    db.prepare("UPDATE upload_attempt SET active=0,outcome='receipt' WHERE event_ref=? AND active=1").run(eventId);
    db.prepare('UPDATE upload_owner_counters SET delivered_events=delivered_events+1 WHERE registration_ref=?').run(attempt.registration_ref);
    return {status:'delivered',eventId,receiptId:receipt.receiptId};
  },options);
}
export function reclaimUploadPayloads(conn:StorageConnection,input:Input<'reclaimUploadPayloads'>,options?:CommitOptions):UploadCleanup {
  check('reclaimUploadPayloads',input);return syncTransaction(conn,db=>{
    const rows=all(db,"SELECT event_id,registration_ref,byte_count FROM upload_envelopes WHERE state='delivered' AND payload IS NOT NULL ORDER BY event_id LIMIT ?",input.limit);let reclaimed=0;
    for(const row of rows){if(!get(db,'SELECT 1 FROM upload_receipts WHERE event_ref=?',row.event_id)){reconcile(db,row.registration_ref);continue;}
      db.prepare('UPDATE upload_envelopes SET payload=NULL WHERE event_id=?').run(row.event_id);db.prepare('UPDATE upload_queue_usage SET events=events-1,bytes=bytes-? WHERE id=1').run(row.byte_count);
      db.prepare('UPDATE upload_owner_counters SET queued_events=queued_events-1,queued_bytes=queued_bytes-? WHERE registration_ref=?').run(row.byte_count,row.registration_ref);reclaimed++;
    }
    if(reclaimed)db.prepare('UPDATE upload_queue_usage SET blocked=0 WHERE id=1').run();
    const usage=required(get(db,'SELECT events,bytes FROM upload_queue_usage WHERE id=1'));return {examined:rows.length,reclaimed,events:Number(usage.events),bytes:Number(usage.bytes)};
  },options);
}
