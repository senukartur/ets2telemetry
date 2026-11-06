import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MIGRATIONS,Storage} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {StorageClient} from '../../packages/storage/src/client';
import {tripUuidFor,type ProfileObservation} from '../../packages/telemetry-core/src';
import {ETS2_A,job,r,Script} from '../shared/trip-messages';
import {failed,ok,readOnly,TEST_CLOSE_GRACE_MS,workspace} from './helpers';
import {storageWorker,terminateWorkers} from './recording-helpers';
let ws:Awaited<ReturnType<typeof workspace>>,direct:Storage[]=[];
beforeEach(async()=>{ws=await workspace();});
afterEach(async()=>{await terminateWorkers();for(const storage of direct)storage.close();direct=[];await ws.dispose();});
const mode={mode:'unknown',method:'none',confidence:'none'} as const;
const game=<T extends {source:{origin:string}}>(message:T):T=>({...message,source:{...message.source,origin:'game'}});
async function legacyHistory(){
  const storage=await ws.open({purpose:'history',migrations:MIGRATIONS.slice(0,5)}),s=new Script(ETS2_A);
  ok(storage.upsertSession({message:game(s.welcome())}));
  for(let index=1;index<=4;index++){
    const uuid=`70000000-0000-4000-8000-${String(index).padStart(12,'0')}`;
    ok(storage.commitEvent({message:game(s.event(r.jobConfigured())),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    ok(storage.commitEvent({message:game(s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:uuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  }
  storage.close();return ws.database;
}

async function owner(storage:Storage|StorageClient,account:string){
  const installation=ok(await storage.ensureUploadInstallation());expect(installation.status).toBe('ready');
  const input={registrationId:randomUUID(),clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:account,companyId:'company',identityEpoch:'epoch-1',installationId:randomUUID(),bindingId:randomUUID()};
  const registered=ok(await storage.recordUploadRegistration(input));return {...input,registrationId:registered.registrationId};
}
describe('REG-003/005/008/012 opening ownership and historical confirmation claims',()=>{
  it('keeps A historical ownership after B confirms before any enumeration and resumes A original run',async()=>{
    const file=await legacyHistory(),worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
    ok(await client.open({path:file,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const a=await owner(client,'A'),b=await owner(client,'B'),aRun=randomUUID(),bRun=randomUUID();
    const input={confirmationId:aRun,registrationId:a.registrationId,credentialGeneration:'a-generation',expectedVersion:'0'};
    expect(ok(await client.confirmUploadOwner(input))).toMatchObject({status:'confirmed',version:'1',runId:aRun});
    ok(await client.confirmUploadOwner({confirmationId:bRun,registrationId:b.registrationId,credentialGeneration:'b-generation',expectedVersion:'1'}));
    expect(ok(await client.confirmUploadOwner(input))).toEqual({status:'confirmed',version:'1',runId:aRun});
    failed(await client.deleteTrip('70000000-0000-4000-8000-000000000004',{rejectIfOpen:false}),'STORAGE_BUSY');
    expect(ok(await client.advanceUploadScan({runId:aRun,registrationId:a.registrationId}))).toMatchObject({phase:'complete'});
    expect(ok(await client.getUploadStoreStatus({registrationId:a.registrationId})).pendingSources).toBe(4);
    expect(ok(await client.getUploadStoreStatus({registrationId:b.registrationId})).pendingSources).toBe(0);
    await client.close();
    readOnly(file,db=>{expect(db.prepare('SELECT DISTINCT registration_ref FROM upload_reservations').pluck().all()).toEqual([a.registrationId]);expect(db.prepare('SELECT DISTINCT run_ref FROM upload_reservations').pluck().all()).toEqual([aRun]);});
  });
  it('allocates future ordinals above the legacy boundary even when a deleted raw rowid is reused',async()=>{
    const file=await legacyHistory(),conn=await openConnection(ws.options({path:file,purpose:'history'})),storage=new Storage(conn);direct.push(storage);
    ok(storage.deleteTrip('70000000-0000-4000-8000-000000000004',{rejectIfOpen:false}));
    const a=await owner(storage,'A'),b=await owner(storage,'B'),aRun=randomUUID();
    ok(storage.confirmUploadOwner({confirmationId:aRun,registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'}));
    ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'1'}));
    const s=new Script('10000000-0000-4000-8000-000000000099');ok(storage.upsertSession({message:game(s.welcome())}));
    const message=game(s.event(r.jobConfigured())),uuid=tripUuidFor(s.session,'1');
    ok(storage.commitEvent({message,effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    const db=conn.writer();expect(db.prepare('SELECT id FROM trips WHERE trip_uuid=?').pluck().get(uuid)).toBe(4n);
    expect(db.prepare('SELECT ordinal FROM upload_candidates WHERE trip_uuid=?').pluck().get(uuid)).toBe(5n);
    expect(db.prepare('SELECT registration_ref FROM upload_reservations WHERE candidate_ref=5').pluck().get()).toBe(b.registrationId);
    ok(storage.advanceUploadScan({runId:aRun,registrationId:a.registrationId}));
    expect(db.prepare('SELECT registration_ref FROM upload_reservations WHERE candidate_ref=5').pluck().get()).toBe(b.registrationId);
  });
  it('keeps disconnected openings explicitly unbound until confirmation and refuses stale versions and retained deletion',async()=>{
    const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),s=new Script(ETS2_A);
    ok(storage.upsertSession({message:game(s.welcome())}));const uuid=tripUuidFor(s.session,'1');
    ok(storage.commitEvent({message:game(s.event(r.jobConfigured())),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    expect(conn.writer().prepare('SELECT mode FROM upload_reservations').pluck().all()).toEqual(['unbound']);
    const confirmation={confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'generation-1',expectedVersion:'0'};
    ok(storage.confirmUploadOwner(confirmation));expect(ok(storage.disconnectUploadOwner({expectedVersion:'0'})).status).toBe('stale');
    ok(storage.advanceUploadScan({runId:confirmation.confirmationId,registrationId:a.registrationId}));
    expect(conn.writer().prepare('SELECT registration_ref FROM upload_reservations').pluck().get()).toBe(a.registrationId);
    failed(storage.deleteTrip(uuid,{rejectIfOpen:false}),'STORAGE_BUSY');
    const corrupt={...a,bindingId:randomUUID()};expect(ok(storage.recordUploadRegistration(corrupt)).status).toBe('reconciliation-required');
    expect(conn.writer().prepare('SELECT binding_id FROM upload_registrations').pluck().get()).toBe(a.bindingId);
  });
});

const proof=(script:Script):ProfileObservation=>({version:1,scope:'a'.repeat(64),binding:'b'.repeat(64),game:'ets2',pluginSessionId:script.session,processInstanceId:script.welcome().source.processInstanceId,sourceClockId:script.clockId,afterMonotonicNs:'0',loadGeneration:1});
function opening(storage:Storage,script:Script,verified=false){
  ok(storage.upsertSession({message:game(script.welcome())}));const message=game(script.event(r.jobConfigured())),uuid=tripUuidFor(script.session,message.data.eventSeq);
  ok(storage.commitEvent({message,...(verified?{profile:proof(script)}:{}),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));return uuid;
}
function observe(storage:Storage,script:Script,uuid:string){ok(storage.openAttachedTrip({pluginSessionId:script.session,nextEventSeq:String(script.next),job:job(),effects:[],observeTripUuid:uuid,profile:proof(script),sourceClockId:script.clockId,monotonicNs:'999999999999999'}));}
it.each([true,false])('REG-003/005/008 preserves assigned=%s reservation through switch, restart and first terminal readiness',async assigned=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),b=await owner(storage,'B');
  let version='0';if(assigned){ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:version}));version='1';}
  const script=new Script(ETS2_A),uuid=opening(storage,script);expect(conn.writer().prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(0n);
  if(!assigned){const confirmed=ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:version}));version=confirmed.version;}
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:version}));storage.close();
  conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);direct.push(storage);
  const beforeRun=randomUUID();ok(storage.confirmUploadOwner({confirmationId:beforeRun,registrationId:b.registrationId,credentialGeneration:'b-refreshed',expectedVersion:'2'}));ok(storage.advanceUploadScan({runId:beforeRun,registrationId:b.registrationId}));expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId})).identityPendingSources).toBe(1);
  ok(storage.commitEvent({message:game(script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:uuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  expect(conn.writer().prepare('SELECT registration_ref,http_revision FROM upload_source_bindings').all()).toEqual([{registration_ref:a.registrationId,http_revision:0n}]);expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:1});
  expect(ok(storage.beginUploadMaterialization({workId:randomUUID(),tripUuid:uuid,registrationId:b.registrationId}))).toMatchObject({status:'held',reason:'reconciliation-required'});
});
it.each([true,false])('REG-005/008 keeps A target ownership when incoming B joins, alreadyBound=%s, and preserves incoming B reservation',async alreadyBound=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),b=await owner(storage,'B');
  if(alreadyBound)ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'}));
  const first=new Script(ETS2_A),root=opening(storage,first,true);
  if(!alreadyBound){expect(conn.writer().prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(0n);ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'}));}
  else ok(storage.commitEvent({message:game(first.event(r.timersRestart())),effects:[{kind:'trip.close',tripUuid:root,outcome:'none',closeReason:'restart',recordingCompleteness:'partial',endedUtcMs:2000}]}));
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'1'}));
  const second=new Script('10000000-0000-4000-8000-000000000002'),child=opening(storage,second,true),db=conn.writer();
  expect(db.prepare('SELECT logical_ref FROM logical_memberships WHERE trip_ref=2').pluck().get()).toBe(1n);
  expect(db.prepare('SELECT registration_ref FROM upload_source_bindings WHERE root_ref=1').pluck().get()).toBe(a.registrationId);
  expect(db.prepare('SELECT registration_ref FROM upload_reservations WHERE candidate_ref=2').pluck().get()).toBe(b.registrationId);
  expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:1});expect(ok(storage.getUploadStoreStatus({registrationId:b.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:0,heldSources:0});
  const before=contentDigest(db);failed(storage.deleteTrip(child,{rejectIfOpen:false}),'STORAGE_BUSY');failed(storage.deleteTrip(root,{rejectIfOpen:false}),'STORAGE_BUSY');expect(contentDigest(db)).toEqual(before);
  expect(ok(storage.beginUploadMaterialization({workId:randomUUID(),tripUuid:child,registrationId:a.registrationId})).status).toBe('preparing');
});
it('REG-005/008 holds an unassigned target when an earlier B opening redirects into it, including after restart',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const b=await owner(storage,'B');
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'0'}));
  const incoming=new Script(ETS2_A),child=opening(storage,incoming);ok(storage.disconnectUploadOwner({expectedVersion:'1'}));
  const targetScript=new Script('10000000-0000-4000-8000-000000000002'),target=opening(storage,targetScript,true);
  observe(storage,incoming,child);expect(conn.writer().prepare('SELECT logical_ref FROM logical_memberships WHERE trip_ref=1').pluck().get()).toBe(2n);
  expect(conn.writer().prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(0n);storage.close();
  conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);direct.push(storage);
  expect(ok(storage.beginUploadMaterialization({workId:randomUUID(),tripUuid:target,registrationId:b.registrationId}))).toMatchObject({status:'held',reason:'reconciliation-required'});
  expect(conn.writer().prepare('SELECT mode,registration_ref FROM upload_reservations WHERE candidate_ref=2').all()).toEqual([{mode:'unbound',registration_ref:null}]);
  expect(ok(storage.getUploadStoreStatus({registrationId:b.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:0,heldSources:0});
  const runId=randomUUID();ok(storage.confirmUploadOwner({confirmationId:runId,registrationId:b.registrationId,credentialGeneration:'b-confirmed',expectedVersion:'2'}));expect(ok(storage.advanceUploadScan({runId,registrationId:b.registrationId})).phase).toBe('complete');
  // Two raw reservations now belong to B, but only the held logical self-root contributes to its identity backlog.
  expect(conn.writer().prepare('SELECT identity_state FROM upload_reservations ORDER BY candidate_ref').pluck().all()).toEqual(['redirected','held']);
  expect(ok(storage.getUploadStoreStatus({registrationId:b.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:0,heldSources:1});expect(conn.writer().prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(0n);
});
it('REG-005/012 rotates one owner without reassignment and isolates a new identity epoch',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),firstRun=randomUUID();
  ok(storage.confirmUploadOwner({confirmationId:firstRun,registrationId:a.registrationId,credentialGeneration:'a1',expectedVersion:'0'}));const uuid=opening(storage,new Script(ETS2_A),true);
  const replay=ok(storage.recordUploadRegistration({...a,registrationId:randomUUID()}));expect(replay.registrationId).toBe(a.registrationId);
  const epoch={...a,registrationId:randomUUID(),identityEpoch:'epoch-2',bindingId:randomUUID()};ok(storage.recordUploadRegistration(epoch));
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a2',expectedVersion:'1'}));
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:epoch.registrationId,credentialGeneration:'epoch2',expectedVersion:'2'}));
  expect(conn.writer().prepare('SELECT registration_ref,run_ref FROM upload_source_bindings').all()).toEqual([{registration_ref:a.registrationId,run_ref:firstRun}]);
  expect(ok(storage.beginUploadMaterialization({workId:randomUUID(),tripUuid:uuid,registrationId:epoch.registrationId})).status).toBe('held');
});

it('REG-005/012 refuses observed missing confirmed claim metadata instead of assigning its covered history to B',async()=>{
  await legacyHistory();const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),b=await owner(storage,'B'),aRun=randomUUID(),bRun=randomUUID();
  const confirmation={confirmationId:aRun,registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'};ok(storage.confirmUploadOwner(confirmation));
  expect(ok(storage.confirmUploadOwner({expectedVersion:'0',credentialGeneration:'a',registrationId:a.registrationId,confirmationId:aRun}))).toEqual({status:'confirmed',version:'1',runId:aRun});
  const db=conn.writer();expect(()=>db.prepare("UPDATE upload_history_claims SET registration_ref=?").run(b.registrationId)).toThrow('immutable upload claim');expect(()=>db.prepare('DELETE FROM upload_history_claims').run()).toThrow('retained upload claim');
  // Explicit partial metadata loss, rather than an API cleanup. The redundant committed claim highwater must veto transfer.
  db.exec('DROP TRIGGER upload_claim_retained');db.prepare('DELETE FROM upload_history_claims').run();
  expect(ok(storage.confirmUploadOwner({confirmationId:bRun,registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'1'}))).toEqual({status:'reconciliation-required',version:'1',runId:null});
  expect(db.prepare('SELECT count(*) FROM upload_scan_runs').pluck().get()).toBe(1n);ok(storage.advanceUploadScan({runId:aRun,registrationId:a.registrationId}));
  expect(db.prepare('SELECT DISTINCT registration_ref,hold_reason FROM upload_reservations').all()).toEqual([{registration_ref:null,hold_reason:'reconciliation-required'}]);expect(db.prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(0n);
});

it('REG-003/005/008/012 exposes assigned identity-pending self-roots after scan completion without allocating a permanent source',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);direct.push(storage);const a=await owner(storage,'A'),b=await owner(storage,'B'),script=new Script(ETS2_A),uuid=opening(storage,script);
  expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:0,heldSources:0,queuedEvents:0});
  const runId=randomUUID();ok(storage.confirmUploadOwner({confirmationId:runId,registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'}));expect(ok(storage.advanceUploadScan({runId,registrationId:a.registrationId})).phase).toBe('complete');
  expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:1,pendingSources:0,heldSources:0,queuedEvents:0});
  for(const table of ['upload_source_bindings','upload_envelopes'])expect(conn.writer().prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0n);
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'1'}));storage.close();conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);direct.push(storage);
  expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:1,pendingSources:0});expect(ok(storage.getUploadStoreStatus({registrationId:b.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:0});
  observe(storage,script,uuid);expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId}))).toMatchObject({identityPendingSources:0,pendingSources:1});expect(conn.writer().prepare('SELECT registration_ref,http_revision FROM upload_source_bindings').all()).toEqual([{registration_ref:a.registrationId,http_revision:0n}]);
});
