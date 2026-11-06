import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MIGRATIONS,Storage,type SampleInput} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {StorageClient} from '../../packages/storage/src/client';
import type {UploadWork} from '../../packages/storage/src/upload-sync';
import {encodeUploadEnvelope,uploadDigest,type UploadEnvelope} from '../../packages/storage/src/upload-envelope';
import {UPLOAD_MAX_BYTES,UPLOAD_MAX_EVENTS} from '../../packages/storage/src/upload-sync';
import {recheckUploadProjection} from '../../packages/storage/src/sqlite/upload-projection';
import {tripUuidFor,type ProfileObservation} from '../../packages/telemetry-core/src';
import {ETS2_A,job,r,Script} from '../shared/trip-messages';
import {failed,ok,TEST_CLOSE_GRACE_MS,workspace} from './helpers';
import {storageWorker,terminateWorkers} from './recording-helpers';
let ws:Awaited<ReturnType<typeof workspace>>,opened:Storage[]=[];
beforeEach(async()=>{ws=await workspace();});afterEach(async()=>{await terminateWorkers();for(const s of opened)s.close();opened=[];await ws.dispose();});
const game=<T extends {source:{origin:string}}>(message:T):T=>({...message,source:{...message.source,origin:'game'}});
const mode={mode:'unknown',method:'none',confidence:'none'} as const;
const proof=(s:Script):ProfileObservation=>({version:1,scope:'a'.repeat(64),binding:'b'.repeat(64),game:'ets2',pluginSessionId:s.session,processInstanceId:s.welcome().source.processInstanceId,sourceClockId:s.clockId,afterMonotonicNs:'0',loadGeneration:1});
async function setup(client:Storage|StorageClient){
  const install=ok(await client.ensureUploadInstallation()),registrationId=randomUUID(),runId=randomUUID();
  ok(await client.recordUploadRegistration({registrationId,clientInstallationId:install.clientInstallationId!,origin:'https://dashboard.example',accountId:'A',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));
  ok(await client.confirmUploadOwner({confirmationId:runId,registrationId,credentialGeneration:'generation',expectedVersion:'0'}));
  const s=new Script(ETS2_A),tripUuid=tripUuidFor(s.session,'1');ok(await client.upsertSession({message:game(s.welcome())}));
  ok(await client.commitEvent({message:game(s.event(r.jobConfigured())),profile:proof(s),effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
  return {s,tripUuid,registrationId,runId};
}
async function complete(client:Storage|StorageClient,input:{tripUuid:string;registrationId:string}){
  const workId=randomUUID();let work=ok(await client.beginUploadMaterialization({tripUuid:input.tripUuid,registrationId:input.registrationId,workId}));
  for(let turn=0;['preparing','folding'].includes(work.status)&&turn<1000;turn++){work=ok(await client.advanceUploadMaterialization({workId}));expect(work.examined).toBeLessThanOrEqual(100);}
  expect(work.status).toBe('complete');return workId;
}
const response=(eventId:string,receiptId=randomUUID(),status='stored')=>new TextEncoder().encode(JSON.stringify({contract:{major:1,minor:0},eventId,receiptId,status,firstReceivedAtUtcMs:5000}));
describe('REG-004/005/007/010/011/012 durable frozen queue',()=>{
  it('freezes once through the worker, retries original bytes, commits a full receipt then separately frees capacity',async()=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const source=await setup(client),workId=await complete(client,source);failed(await client.releaseUploadProjection(workId),'STORAGE_BUSY');
    const frozen=ok(await client.freezeUploadMaterialization({workId,producerVersion:'0.1.0',createdUtcMs:1000}));expect(frozen.status).toBe('frozen');
    expect(ok(await client.freezeUploadMaterialization({workId,producerVersion:'changed',createdUtcMs:2000}))).toEqual(frozen);
    const first=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));expect(first.status).toBe('claimed');
    expect(first.registration).toMatchObject({registrationId:source.registrationId,origin:'https://dashboard.example',accountId:'A'});
    const envelope=JSON.parse(new TextDecoder().decode(first.payload!));expect(envelope).toMatchObject({eventId:frozen.eventId,revision:1,type:'trip.started',delivery:{mode:'live',syncRunId:source.runId},source:{tripId:source.tripUuid}});
    ok(await client.recoverUploadAttempt({attemptId:first.attemptId!}));const retry=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:2000}));
    expect(retry.eventId).toBe(first.eventId);expect(retry.payload).toEqual(first.payload);
    expect(ok(await client.recordUploadAttemptOutcome({attemptId:first.attemptId!,kind:'authentication',retryAtMs:9000,nowMs:2000})).status).toBe('stale');expect(ok(await client.getUploadStoreStatus({registrationId:source.registrationId})).paused).toBeNull();
    const before=ok(await client.getUploadStoreStatus({registrationId:source.registrationId}));expect(before.queuedEvents).toBe(1);
    expect(ok(await client.commitUploadReceipt({attemptId:retry.attemptId!,statusCode:200,body:response(retry.eventId!)})).status).toBe('invalid-response');
    expect(ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:3000})).status).toBe('busy');
    const receipt=response(retry.eventId!),received=ok(await client.commitUploadReceipt({attemptId:retry.attemptId!,statusCode:202,body:receipt}));expect(received.status).toBe('delivered');
    expect(ok(await client.getUploadStoreStatus({registrationId:source.registrationId}))).toMatchObject({queuedEvents:1,queuedBytes:before.queuedBytes,deliveredEvents:1});
    expect(ok(await client.commitUploadReceipt({attemptId:retry.attemptId!,statusCode:202,body:receipt})).status).toBe('duplicate');
    expect(ok(await client.reclaimUploadPayloads({limit:100}))).toEqual({examined:1,reclaimed:1,events:0,bytes:0});
    expect(ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:3000})).status).toBe('empty');
    expect(ok(await client.releaseUploadMaterialization({workId})).status).toBe('released');await client.close();
  });
  it('does not starve an owned context on ordinary open counter changes while the old strict projection recheck stays strict',async()=>{
    const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();
    const before=db.prepare('SELECT material_version FROM upload_change_heads').pluck().get();
    ok(storage.commitEvent({message:game(source.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:source.tripUuid,set:{observedDistanceM:{available:true,value:10},fuelUsedL:{available:true,value:1}}}]}));
    const firstChanged=db.prepare('SELECT material_version FROM upload_change_heads').pluck().get();expect(firstChanged).not.toBe(before);
    expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('stale');
    const current=await complete(storage,source),strictPin=JSON.parse(String((db.prepare('SELECT pin_json FROM upload_materializations WHERE work_id=?').get(current) as {pin_json:string}).pin_json)),version=db.prepare('SELECT material_version FROM upload_change_heads').pluck().get();
    for(let i=0;i<10;i++)ok(storage.commitEvent({message:game(source.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:source.tripUuid,set:{observedDistanceM:{available:true,value:20+i},fuelUsedL:{available:true,value:2+i}}}]}));
    expect(db.prepare('SELECT material_version FROM upload_change_heads').pluck().get()).toBe(version);expect(recheckUploadProjection(db,strictPin)).toBe(false);
    expect(ok(storage.freezeUploadMaterialization({workId:current,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');
    const fresh=await completeAfterMaterial(storage,source);
    expect(ok(storage.freezeUploadMaterialization({workId:fresh,producerVersion:'test',createdUtcMs:2000})).status).toBe('equal');
  });
});
async function completeAfterMaterial(storage:Storage,source:Awaited<ReturnType<typeof setup>>){
  // A rule-context availability change that maps to the same already-incomplete context can compare equal.
  ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'sample-loss'}));
  let workId=await complete(storage,source);const work:UploadWork=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1500}));expect(work.status).toBe('frozen');
  ok(storage.releaseUploadMaterialization({workId}));ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'sample-loss'}));
  workId=await complete(storage,source);return workId;
}

// Seed historical frozen events at the production limits with valid exact v1 bytes, FK-valid headers and counters.
// Each row models a prior material version; no lowered limit or fabricated usage counter is used.
function fillQueue(conn:Awaited<ReturnType<typeof openConnection>>,count:number,padded=false){
  const db=conn.writer(),base=db.prepare('SELECT * FROM upload_envelopes LIMIT 1').get() as Record<string,unknown>;
  const initial=JSON.parse(Buffer.from(base.payload as Uint8Array).toString()) as UploadEnvelope;
  let bytes=Number(base.byte_count);
  db.transaction(()=>{
    for(let revision=2;revision<=count;revision++){
      const eventId=randomUUID(),workId=randomUUID(),envelope={...initial,eventId,revision};let payload=Buffer.from(encodeUploadEnvelope(envelope)!);
      if(padded)payload=Buffer.concat([payload,Buffer.alloc(65536-payload.length,32)]);
      db.prepare("INSERT INTO upload_materializations(work_id,root_ref,registration_ref,material_version,mode,run_ref,pin_id,state,pin_released) VALUES(?,?,?,?,?,?,?,'frozen',1)").run(workId,base.root_ref,base.registration_ref,100000+revision,base.mode,initial.delivery.syncRunId,workId);
      db.prepare("INSERT INTO upload_envelopes(event_id,work_ref,root_ref,registration_ref,mode,revision,payload,byte_count,payload_digest,state) VALUES(?,?,?,?,?,?,?,?,?,'queued')").run(eventId,workId,base.root_ref,base.registration_ref,base.mode,revision,payload,payload.length,uploadDigest(payload));
      db.prepare('UPDATE upload_materializations SET event_ref=? WHERE work_id=?').run(eventId,workId);bytes+=payload.length;
    }
    // The original event was created by T3; for byte pressure fill an additional short valid event to reach the exact cap.
    db.prepare('UPDATE upload_queue_usage SET events=?,bytes=? WHERE id=1').run(count,bytes);
    db.prepare('UPDATE upload_owner_counters SET queued_events=?,queued_bytes=? WHERE registration_ref=?').run(count,bytes,base.registration_ref);
    db.prepare('UPDATE upload_source_bindings SET http_revision=? WHERE root_ref=?').run(count,base.root_ref);
  })();return {bytes,base};
}
it.each(['events','bytes','bytes-near'] as const)('REG-007/011/012 retains T1 and scan position at production %s pressure, drains and resumes',async limit=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),first=await complete(storage,source);
  ok(storage.freezeUploadMaterialization({workId:first,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId:first}));
  // For the byte limit the first wire is short. Fill 1024 padded wires plus that short wire, then one exact residual wire.
  const count=limit==='events'?UPLOAD_MAX_EVENTS:1024,filled=fillQueue(conn,count,limit!=='events'),db=conn.writer();
  if(limit!=='events'){
    // 1023*65536 + firstLength: one valid residual payload reaches exactly 64MiB.
    db.prepare('UPDATE upload_envelopes SET retry_at=20000 WHERE event_id=?').run(filled.base.event_id);
    const remaining=UPLOAD_MAX_BYTES-(limit==='bytes-near'?1:0)-filled.bytes,base=filled.base,eventId=randomUUID(),workId=randomUUID(),e=JSON.parse(Buffer.from(base.payload as Uint8Array).toString()) as UploadEnvelope;
    const raw=Buffer.from(encodeUploadEnvelope({...e,eventId,revision:count+1})!);expect(remaining).toBeGreaterThan(raw.length);
    const payload=Buffer.concat([raw,Buffer.alloc(remaining-raw.length,32)]);
    db.transaction(()=>{db.prepare("INSERT INTO upload_materializations(work_id,root_ref,registration_ref,material_version,mode,run_ref,pin_id,state,pin_released) VALUES(?,?,?,?,?,?,?,'frozen',1)").run(workId,base.root_ref,base.registration_ref,200000,base.mode,e.delivery.syncRunId,workId);
      db.prepare("INSERT INTO upload_envelopes(event_id,work_ref,root_ref,registration_ref,mode,revision,payload,byte_count,payload_digest,state) VALUES(?,?,?,?,?,?,?,?,?,'queued')").run(eventId,workId,base.root_ref,base.registration_ref,base.mode,count+1,payload,payload.length,uploadDigest(payload));
      db.prepare('UPDATE upload_materializations SET event_ref=? WHERE work_id=?').run(eventId,workId);
      db.prepare('UPDATE upload_queue_usage SET events=events+1,bytes=? WHERE id=1').run(UPLOAD_MAX_BYTES-(limit==='bytes-near'?1:0));
      db.prepare('UPDATE upload_owner_counters SET queued_events=queued_events+1,queued_bytes=? WHERE registration_ref=?').run(UPLOAD_MAX_BYTES-(limit==='bytes-near'?1:0),source.registrationId);
      db.prepare('UPDATE upload_source_bindings SET http_revision=?').run(count+1);
    })();
  }
  expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).pressure).toBe(limit!=='bytes-near');let nearWork:string|undefined;
  const confirmation={confirmationId:randomUUID(),registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'};ok(storage.confirmUploadOwner(confirmation));
  const before=db.prepare('SELECT legacy_after,ordinal_after FROM upload_scan_runs WHERE run_id=?').get(confirmation.confirmationId);
  ok(storage.commitEvent({message:game(source.s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).pendingSources).toBe(1);
  if(limit==='bytes-near'){nearWork=await complete(storage,source);const usage=db.prepare('SELECT events,bytes FROM upload_queue_usage').get();expect(ok(storage.freezeUploadMaterialization({workId:nearWork,producerVersion:'test',createdUtcMs:3000})).status).toBe('pressure');expect(db.prepare('SELECT events,bytes FROM upload_queue_usage').get()).toEqual(usage);expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).pressure).toBe(true);}
  expect(ok(storage.advanceUploadScan({runId:confirmation.confirmationId,registrationId:source.registrationId})).phase).toBe('pressure');expect(ok(storage.pageUploadDiscovery({registrationId:source.registrationId,after:'0',limit:100}))).toEqual({after:'0',next:'0',examined:0,items:[]});
  expect(db.prepare('SELECT legacy_after,ordinal_after FROM upload_scan_runs WHERE run_id=?').get(confirmation.confirmationId)).toEqual(before);
  expect(ok(storage.beginUploadMaterialization({workId:randomUUID(),tripUuid:source.tripUuid,registrationId:source.registrationId})).status).toBe('pressure');
  failed(storage.deleteTrip(source.tripUuid,{rejectIfOpen:false}),'STORAGE_BUSY');
  // Choose a padded wire for the byte case so one reclamation creates enough room for the next normal envelope.
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'2',mode:'live',nowMs:5000}));expect(attempt.status).toBe('claimed');
  const status=ok(storage.getUploadStoreStatus({registrationId:source.registrationId}));ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:response(attempt.eventId!)}));
  expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).queuedBytes).toBe(status.queuedBytes);
  expect(ok(storage.reclaimUploadPayloads({limit:1})).reclaimed).toBe(1);
  expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).pressure).toBe(false);
  let scan=ok(storage.advanceUploadScan({runId:confirmation.confirmationId,registrationId:source.registrationId}));while(scan.phase!=='complete')scan=ok(storage.advanceUploadScan({runId:confirmation.confirmationId,registrationId:source.registrationId}));
  const workId=nearWork??await complete(storage,source),frozen=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:3000}));expect(frozen.status).toBe('frozen');
  const row=db.prepare('SELECT revision,payload FROM upload_envelopes WHERE event_id=?').get(frozen.eventId) as {revision:bigint;payload:Uint8Array};
  expect(row.revision).toBe(BigInt(count+(limit==='events'?1:2)));expect(JSON.parse(Buffer.from(row.payload).toString()).type).toBe('trip.completed');
  expect(db.pragma('foreign_key_check')).toEqual([]);
},30_000);

it.each([false,true])('REG-005/008/011 classifies each material version independently, overlap=%s, and selects eligible classes without consuming empty attempts',async overlap=>{
  const legacy=await ws.open({purpose:'history',migrations:MIGRATIONS.slice(0,5)}),script=new Script(ETS2_A),tripUuid=tripUuidFor(script.session,'1');
  ok(legacy.upsertSession({message:game(script.welcome())}));ok(legacy.commitEvent({message:game(script.event(r.jobConfigured())),profile:proof(script),effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));legacy.close();
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const installation=ok(storage.ensureUploadInstallation()),registrationId=randomUUID(),runId=randomUUID();
  const register=(id:string,account:string)=>ok(storage.recordUploadRegistration({registrationId:id,clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:account,companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));register(registrationId,'A');
  ok(storage.confirmUploadOwner({confirmationId:runId,registrationId,credentialGeneration:'a',expectedVersion:'0'}));
  const source={tripUuid,registrationId};
  if(overlap)ok(storage.recordCompleteness(script.session,{tripUuid,kind:'sample-loss'}));
  // T2 captured its highwater before the live change; it must not retag that newer T1 head.
  ok(storage.advanceUploadScan({runId,registrationId}));const initial=await complete(storage,source),first=ok(storage.freezeUploadMaterialization({workId:initial,producerVersion:'test',createdUtcMs:1000}));expect(first.status).toBe('frozen');ok(storage.releaseUploadMaterialization({workId:initial}));
  const firstWire=conn.writer().prepare('SELECT payload FROM upload_envelopes WHERE event_id=?').pluck().get(first.eventId) as Uint8Array;
  expect(JSON.parse(Buffer.from(firstWire).toString()).delivery).toEqual({mode:overlap?'live':'backfill',syncRunId:runId});
  const emptyId=randomUUID();expect(ok(storage.claimUploadAttempt({attemptId:emptyId,registrationId,expectedVersion:'1',mode:overlap?'backfill':'live',nowMs:0})).status).toBe('empty');
  expect(conn.writer().prepare('SELECT 1 FROM upload_attempt WHERE attempt_id=?').get(emptyId)).toBeUndefined();
  const b=randomUUID(),bRun=randomUUID();register(b,'B');ok(storage.confirmUploadOwner({confirmationId:bRun,registrationId:b,credentialGeneration:'b',expectedVersion:'1'}));
  ok(storage.commitEvent({message:game(script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  const terminal=await complete(storage,source),second=ok(storage.freezeUploadMaterialization({workId:terminal,producerVersion:'test',createdUtcMs:2000}));expect(second.status).toBe('frozen');
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId,credentialGeneration:'a-rotated',expectedVersion:'2'}));
  const live=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'3',mode:'live',nowMs:0}));expect(live.status).toBe('claimed');
  const liveEnvelope=JSON.parse(Buffer.from(live.payload!).toString());expect(liveEnvelope.delivery).toEqual({mode:'live',syncRunId:runId});expect(liveEnvelope.bindingId).not.toBeNull();
  // Only the non-overlap run has an older backfill. Retry/held live entries must not obstruct it.
  ok(storage.recordUploadAttemptOutcome({attemptId:live.attemptId!,kind:'retry',retryAtMs:10000,nowMs:0}));
  if(!overlap){
    expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'3',mode:'live',nowMs:0})).status).toBe('empty');
    const backfill=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'3',mode:'backfill',nowMs:0}));expect(backfill.eventId).toBe(first.eventId);expect(backfill.payload).toEqual(new Uint8Array(firstWire));
    ok(storage.recordUploadAttemptOutcome({attemptId:backfill.attemptId!,kind:'authentication',retryAtMs:0,nowMs:0}));expect(ok(storage.getUploadStoreStatus({registrationId})).paused).toBe('authentication');
    expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'3',mode:'any',nowMs:20000})).status).toBe('paused');
    ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId,credentialGeneration:'a-revalidated',expectedVersion:'3'}));
    const again=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'4',mode:'backfill',nowMs:0}));expect(again.payload).toEqual(new Uint8Array(firstWire));expect(again.eventId).toBe(first.eventId);
    ok(storage.recordUploadAttemptOutcome({attemptId:again.attemptId!,kind:'validation',retryAtMs:0,nowMs:0}));expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId,expectedVersion:'4',mode:'backfill',nowMs:0})).status).toBe('empty');
  }
});

it('REG-004/005/010 allocates first terminal revision 1 and a later terminal correction without reopening',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),db=conn.writer();
  ok(storage.commitEvent({message:game(source.s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  let workId=await complete(storage,source),frozen=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:2000}));expect(frozen.status).toBe('frozen');ok(storage.releaseUploadMaterialization({workId}));
  const wire=(id:string|null)=>JSON.parse(Buffer.from(db.prepare('SELECT payload FROM upload_envelopes WHERE event_id=?').pluck().get(id) as Uint8Array).toString()) as UploadEnvelope;
  expect(()=>db.prepare("UPDATE upload_materializations SET mode='backfill' WHERE work_id=?").run(workId)).toThrow('immutable upload work');expect(wire(frozen.eventId)).toMatchObject({revision:1,type:'trip.completed',snapshot:{outcome:'delivered'}});
  ok(storage.commitEvent({message:game(source.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:source.tripUuid,set:{observedDistanceM:{available:true,value:125}}}]}));
  workId=await complete(storage,source);frozen=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:3000}));expect(wire(frozen.eventId)).toMatchObject({revision:2,type:'trip.corrected',snapshot:{outcome:'delivered',observedDistance:{available:true,value:125,unit:'m'}}});
  expect(db.prepare('SELECT terminal,http_revision FROM upload_source_bindings').all()).toEqual([{terminal:1n,http_revision:2n}]);
});
it.each(['installation','reservation','allocator'] as const)('REG-005/010 holds observed missing %s metadata without allocating replacement identity',async fault=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();
  if(fault==='installation')db.prepare('DELETE FROM upload_installation').run();if(fault==='reservation')db.prepare('DELETE FROM upload_reservations').run();if(fault==='allocator')db.prepare('UPDATE upload_source_bindings SET http_revision=1').run();
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}))).toMatchObject({status:'held',reason:'reconciliation-required'});expect(db.prepare('SELECT count(*) FROM upload_envelopes').pluck().get()).toBe(0n);
  if(fault==='installation'){expect(ok(storage.ensureUploadInstallation())).toEqual({status:'reconciliation-required',clientInstallationId:null});expect(db.prepare('SELECT client_uuid FROM upload_connection').pluck().get()).toBeTruthy();}
});
it('REG-005/010 preserves immutable receipt identity and refuses contradictory or observed-missing receipt replay',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000})),body=response(attempt.eventId!),receipt=ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body}));
  expect(()=>db.prepare('UPDATE upload_receipts SET first_received=6000').run()).toThrow('immutable upload receipt');
  expect(()=>db.prepare("UPDATE upload_envelopes SET payload_digest='different'").run()).toThrow('immutable upload envelope');
  expect(ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:response(attempt.eventId!)}))).toMatchObject({status:'reconciliation-required',receiptId:receipt.receiptId});
  expect(db.prepare('SELECT receipt_id FROM upload_receipts').pluck().get()).toBe(receipt.receiptId);
  // Simulate externally missing observed receipt metadata; delivered/attempt evidence must prevent regeneration.
  db.prepare('DELETE FROM upload_receipts').run();expect(ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body}))).toEqual({status:'reconciliation-required',eventId:attempt.eventId,receiptId:null});
  expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(0n);expect(ok(storage.reclaimUploadPayloads({limit:100}))).toMatchObject({reclaimed:0,events:1});
});
it('REG-004/010 holds the safe HTTP revision boundary without rounding or allocating a new event',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),initial=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId:initial,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId:initial}));
  const base=db.prepare('SELECT * FROM upload_envelopes').get() as Record<string,unknown>,eventId=randomUUID(),workId=randomUUID(),e=JSON.parse(Buffer.from(base.payload as Uint8Array).toString()) as UploadEnvelope,bytes=encodeUploadEnvelope({...e,eventId,revision:Number.MAX_SAFE_INTEGER})!;
  db.transaction(()=>{db.prepare("INSERT INTO upload_materializations(work_id,root_ref,registration_ref,material_version,mode,run_ref,pin_id,state,pin_released) VALUES(?,?,?,?,?,?,?,'frozen',1)").run(workId,base.root_ref,base.registration_ref,100000,base.mode,e.delivery.syncRunId,workId);
    db.prepare("INSERT INTO upload_envelopes(event_id,work_ref,root_ref,registration_ref,mode,revision,payload,byte_count,payload_digest,state) VALUES(?,?,?,?,?,?,?,?,?,'queued')").run(eventId,workId,base.root_ref,base.registration_ref,base.mode,Number.MAX_SAFE_INTEGER,Buffer.from(bytes),bytes.length,uploadDigest(bytes));db.prepare('UPDATE upload_materializations SET event_ref=? WHERE work_id=?').run(eventId,workId);
    db.prepare('UPDATE upload_source_bindings SET http_revision=?').run(Number.MAX_SAFE_INTEGER);db.prepare('UPDATE upload_queue_usage SET events=events+1,bytes=bytes+?').run(bytes.length);db.prepare('UPDATE upload_owner_counters SET queued_events=queued_events+1,queued_bytes=queued_bytes+?').run(bytes.length);
  })();ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'sample-loss'}));const next=await complete(storage,source);
  expect(ok(storage.freezeUploadMaterialization({workId:next,producerVersion:'test',createdUtcMs:2000}))).toMatchObject({status:'held',reason:'revision-exhausted'});expect(db.prepare('SELECT count(*) FROM upload_envelopes').pluck().get()).toBe(2n);
});

it('REG-007/009/012 durably folds a large copied interval stream with bounded accumulator and recorder turns between advances',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage);let db=conn.writer();
  for(let index=0;index<251;index++)ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'sample-loss'}));
  const progress=(value:number)=>ok(storage.commitEvent({message:game(source.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:source.tripUuid,set:{observedDistanceM:{available:true,value},fuelUsedL:{available:true,value}}}]}));progress(1);
  const workId=randomUUID();let work=ok(storage.beginUploadMaterialization({workId,tripUuid:source.tripUuid,registrationId:source.registrationId})),turn=0;const intervalMilestones:number[]=[];
  while(['preparing','folding'].includes(work.status)&&turn<100){
    const before=db.prepare('SELECT fold_json FROM upload_materializations WHERE work_id=?').pluck().get(workId) as string|null;progress(++turn+1);work=ok(storage.advanceUploadMaterialization({workId}));expect(work.examined).toBeLessThanOrEqual(100);
    const after=db.prepare('SELECT fold_json FROM upload_materializations WHERE work_id=?').pluck().get(workId) as string|null;
    if(after){const fold=JSON.parse(String(after));expect(String(after).length).toBeLessThan(2500);if(before){const prior=JSON.parse(String(before));expect(fold.counts.intervals-prior.counts.intervals).toBeLessThanOrEqual(100);if(fold.counts.intervals!==prior.counts.intervals)intervalMilestones.push(fold.counts.intervals);}}
    if(turn%2===0){const persisted=db.prepare('SELECT state,fold_json FROM upload_materializations WHERE work_id=?').get(workId);storage.close();conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);opened.push(storage);db=conn.writer();expect(db.prepare('SELECT state,fold_json FROM upload_materializations WHERE work_id=?').get(workId)).toEqual(persisted);}
  }
  expect(work.status).toBe('complete');expect(intervalMilestones).toEqual([100,200,251]);expect(db.prepare('SELECT count(*) FROM upload_projection_intervals WHERE pin_ref=?').pluck().get(workId)).toBe(251n);
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');
});

it('REG-007/009/012 does not starve an owned projection while actual one-second recorder samples advance its selected accounting head',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),db=conn.writer(),absent={available:false,reason:'not-observed'} as const;
  const sample=(second:number)=>{const row:SampleInput={tripUuid:source.tripUuid,utcMs:1000+second*1000,sourceClockId:source.s.clockId,monotonicNs:String(second*1_000_000_000),gameTime:{minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},speed:{available:true,value:20},fuel:{available:true,value:100-(second-1)*.1},odometer:{available:true,value:1000+(second-1)*20},position:{available:true,value:{x:(second-1)*20,y:0,z:0}},averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,
    recording:{profile:proof(source.s),job:job(),truck:'upload-test',processInstanceId:source.s.welcome().source.processInstanceId,...(second>1?{previous:{tripUuid:source.tripUuid,sourceClockId:source.s.clockId,monotonicNs:String((second-1)*1_000_000_000)}}:{})}};ok(storage.appendSamples(source.s.session,[row],{uniqueSeconds:true}));};
  sample(1);sample(2);const workId=await complete(storage,source),version=db.prepare('SELECT material_version FROM upload_change_heads').pluck().get();
  for(let second=3;second<=12;second++)sample(second);expect(db.prepare('SELECT material_version FROM upload_change_heads').pluck().get()).toBe(version);expect(db.prepare('SELECT distance_m FROM logical_progress ORDER BY id DESC LIMIT 1').pluck().get()).toBe(220);
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');
});

it('REG-005/010/012 startup recovery holds observed missing registration metadata, frees only the attempt slot and never transfers its bytes',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000})),before=db.prepare('SELECT events,bytes FROM upload_queue_usage').get();
  // Explicit external partial metadata loss in an isolated fixture; recovery must not invent the observed identity.
  db.pragma('foreign_keys=OFF');db.prepare('DELETE FROM upload_registrations WHERE registration_id=?').run(source.registrationId);db.pragma('foreign_keys=ON');
  const result=ok(storage.recoverUploadAttempt({startup:true}));expect(result).toMatchObject({status:'reconciliation-required',attemptId:attempt.attemptId,eventId:attempt.eventId,registrationId:source.registrationId,payload:null,registration:null});
  expect(db.prepare('SELECT count(*) FROM upload_attempt WHERE active=1').pluck().get()).toBe(0n);expect(db.prepare('SELECT state,registration_ref,payload FROM upload_envelopes').get()).toEqual({state:'held',registration_ref:source.registrationId,payload:Buffer.from(attempt.payload!)});expect(db.prepare('SELECT events,bytes FROM upload_queue_usage').get()).toEqual(before);
  expect(db.prepare('SELECT count(*) FROM upload_registrations WHERE registration_id=?').pluck().get(source.registrationId)).toBe(0n);expect(ok(storage.recoverUploadAttempt({startup:true})).status).toBe('empty');
  const install=ok(storage.ensureUploadInstallation()),b=randomUUID();ok(storage.recordUploadRegistration({registrationId:b,clientInstallationId:install.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b,credentialGeneration:'b',expectedVersion:'1'}));
  expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}))).toMatchObject({status:'empty',payload:null});expect(db.prepare('SELECT registration_ref FROM upload_source_bindings').pluck().get()).toBe(source.registrationId);
});

it.each(['rotation','disconnect','owner-switch'] as const)('REG-005/010/011/012 fences stale claim replay and late negatives after %s',async change=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000})),before=db.prepare('SELECT payload,retry_at FROM upload_envelopes').get(),capacity=db.prepare('SELECT events,bytes FROM upload_queue_usage').get();
  if(change==='rotation')ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'}));
  if(change==='disconnect')ok(storage.disconnectUploadOwner({expectedVersion:'1'}));
  if(change==='owner-switch'){const install=ok(storage.ensureUploadInstallation()),b=randomUUID();ok(storage.recordUploadRegistration({registrationId:b,clientInstallationId:install.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b,credentialGeneration:'b',expectedVersion:'1'}));failed(storage.claimUploadAttempt({attemptId:attempt.attemptId!,registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}),'INVALID_INPUT');}
  const sending=contentDigest(db);expect(ok(storage.claimUploadAttempt({attemptId:attempt.attemptId!,registrationId:source.registrationId,expectedVersion:'2',mode:'any',nowMs:2000}))).toMatchObject({status:'stale',eventId:attempt.eventId,registrationId:source.registrationId,payload:null,registration:null});expect(contentDigest(db)).toEqual(sending);
  expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'authentication',retryAtMs:9000,nowMs:2000}))).toMatchObject({status:'stale',attemptId:attempt.attemptId,registration:null,payload:null});
  expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).paused).toBeNull();expect(db.prepare('SELECT payload,retry_at FROM upload_envelopes').get()).toEqual(before);expect(db.prepare('SELECT events,bytes FROM upload_queue_usage').get()).toEqual(capacity);expect(db.prepare('SELECT active,outcome FROM upload_attempt').get()).toEqual({active:0n,outcome:'ambiguous'});
  const receipt=response(attempt.eventId!);expect(ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:receipt})).status).toBe('delivered');expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'configuration',retryAtMs:10000,nowMs:3000})).status).toBe('delivered');expect(db.prepare('SELECT events,bytes FROM upload_queue_usage').get()).toEqual(capacity);
});
it('REG-005/010/012 lets a durable receipt through a recovered attempt outrank a later negative outcome',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.recoverUploadAttempt({attemptId:attempt.attemptId!}));
  const recovered=contentDigest(db);for(const kind of ['authentication','configuration'] as const){expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind,retryAtMs:9000,nowMs:2000})).status).toBe('stale');expect(contentDigest(db)).toEqual(recovered);}
  const retry=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:2000}));expect(retry.eventId).toBe(attempt.eventId);ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'}));
  ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:response(attempt.eventId!)}));expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'authentication',retryAtMs:9000,nowMs:3000})).status).toBe('delivered');expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).paused).toBeNull();expect(db.prepare('SELECT state,retry_at FROM upload_envelopes').get()).toEqual({state:'delivered',retry_at:0n});
});

it.each(['authentication','validation'] as const)('REG-005/010/011/012 records a fresh active %s outcome and ignores its later inactive response',async kind=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source),db=conn.writer();ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));
  expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind,retryAtMs:9000,nowMs:2000})).status).toBe('recorded');expect(db.prepare('SELECT state,retry_at,hold_reason FROM upload_envelopes').get()).toEqual({state:kind==='authentication'?'queued':'held',retry_at:9000n,hold_reason:kind});expect(ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).paused).toBe(kind==='authentication'?'authentication':null);
  const before=contentDigest(db);expect(ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'configuration',retryAtMs:10000,nowMs:3000})).status).toBe('stale');expect(contentDigest(db)).toEqual(before);
});
