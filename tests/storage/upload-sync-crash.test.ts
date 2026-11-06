import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MIGRATIONS,Storage,type UploadAttemptResult} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {ETS2_A,r,Script} from '../shared/trip-messages';
import {ok,uploadGame,uploadProof,uploadReceipt,uploadTestOwner,uploadTestSource,uploadTestWork,workspace} from './helpers';
let ws:Awaited<ReturnType<typeof workspace>>,child:ChildProcess|undefined,opened:Storage[]=[];
beforeEach(async()=>{ws=await workspace();});afterEach(async()=>{if(child&&child.exitCode===null&&child.signalCode===null){const ended=once(child,'close');child.kill('SIGKILL');await ended;}child=undefined;for(const storage of opened)storage.close();opened=[];await ws.dispose();});
async function direct(){const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);return {conn,storage,db:conn.writer()};}
async function kill(operation:string,input:unknown,boundary:string){
  const config=path.join(ws.directory,'sync-child.json');writeFileSync(config,JSON.stringify({open:ws.options({purpose:'history'}),operation,input,boundary}));
  child=spawn(process.execPath,[path.resolve('tests/storage/fixtures/upload-sync-child.cjs'),config],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LOCALAPPDATA:ws.directory},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='',errors='';const ended=once(child,'close');child.stderr!.on('data',chunk=>{errors+=String(chunk);});
  const result=await new Promise<unknown>((resolve,reject)=>{
    const guard=setTimeout(()=>reject(Error(`Missing ${boundary} barrier: ${output} ${errors}`)),15_000);
    child!.stdout!.on('data',chunk=>{output+=String(chunk);const prefix=`barrier ${boundary} `,end=output.indexOf('\n');if(output.startsWith(prefix)&&end>=0){clearTimeout(guard);resolve(JSON.parse(output.slice(prefix.length,end)));}});
    child!.once('exit',()=>{clearTimeout(guard);reject(Error(`Child exited: ${errors}`));});
  });child.kill('SIGKILL');await ended;child=undefined;expect(errors).toBe('');return result;
}
describe('REG-006/012 durable upload T1-T4 real process boundaries',()=>{
  it.each(['before-commit','after-commit','after-answer'])('commits source/candidate/reservation/discovery together at %s',async boundary=>{
    let {storage}=await direct();const owner=await uploadTestOwner(storage);ok(storage.confirmUploadOwner({confirmationId:owner.runId,registrationId:owner.registrationId,credentialGeneration:'a',expectedVersion:'0'}));
    const script=new Script(ETS2_A);ok(storage.upsertSession({message:uploadGame(script.welcome())}));const tripUuid='70000000-0000-4000-8000-000000000001';
    const input={message:uploadGame(script.event(r.jobConfigured())),profile:uploadProof(script),effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]};storage.close();
    await kill('commitEvent',input,boundary);const reopened=await direct();storage=reopened.storage;const db=reopened.db;const expected=boundary==='before-commit'?0n:1n;
    for(const table of ['events','trips','upload_candidates','upload_reservations','upload_source_bindings','upload_change_heads'])expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),table).toBe(expected);
    expect(db.prepare('SELECT next_ordinal FROM upload_connection').pluck().get()).toBe(expected+1n);
    expect(ok(storage.commitEvent(input as Parameters<Storage['commitEvent']>[0])).status).toBe(boundary==='before-commit'?'committed':'duplicate');expect(db.pragma('foreign_key_check')).toEqual([]);
  });
  it.each(['before-commit','after-commit'])('commits confirmation ownership claim, connection CAS and scan highwaters together at %s',async boundary=>{
    const legacy=await ws.open({purpose:'history',migrations:MIGRATIONS.slice(0,5)}),s=new Script(ETS2_A);ok(legacy.upsertSession({message:uploadGame(s.welcome())}));ok(legacy.commitEvent({message:uploadGame(s.event(r.jobConfigured())),effects:[{kind:'trip.open',tripUuid:'70000000-0000-4000-8000-000000000001',game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));legacy.close();
    let {storage}=await direct();const owner=await uploadTestOwner(storage),input={confirmationId:owner.runId,registrationId:owner.registrationId,credentialGeneration:'a',expectedVersion:'0'};storage.close();await kill('confirmUploadOwner',input,boundary);const reopened=await direct();storage=reopened.storage;const db=reopened.db;
    const committed=boundary!=='before-commit';expect(db.prepare('SELECT version FROM upload_connection').pluck().get()).toBe(committed?1n:0n);expect(db.prepare('SELECT count(*) FROM upload_history_claims').pluck().get()).toBe(committed?1n:0n);
    expect(ok(storage.confirmUploadOwner(input))).toEqual({status:'confirmed',version:'1',runId:owner.runId});
    expect(ok(storage.advanceUploadScan({runId:owner.runId,registrationId:owner.registrationId})).phase).toBe('complete');expect(db.prepare('SELECT registration_ref FROM upload_reservations').pluck().get()).toBe(owner.registrationId);
  });
  it.each(['before-commit','after-commit'])('commits fold state/cursor atomically at %s and resumes without duplicate rows',async boundary=>{
    let {storage,db}=await direct();const source=await uploadTestSource(storage),workId=randomUUID();ok(storage.beginUploadMaterialization({workId,tripUuid:source.tripUuid,registrationId:source.registrationId}));
    let progress=ok(storage.advanceUploadMaterialization({workId}));while(progress.status==='preparing')progress=ok(storage.advanceUploadMaterialization({workId}));expect(progress.status).toBe('folding');
    const before=db.prepare('SELECT fold_json FROM upload_materializations WHERE work_id=?').pluck().get(workId);storage.close();await kill('advanceUploadMaterialization',{workId},boundary);({storage,db}=await direct());
    const after=db.prepare('SELECT fold_json FROM upload_materializations WHERE work_id=?').pluck().get(workId);if(boundary==='before-commit')expect(after).toBe(before);else expect(after).not.toBe(before);
    progress=ok(storage.advanceUploadMaterialization({workId}));while(progress.status==='preparing'||progress.status==='folding')progress=ok(storage.advanceUploadMaterialization({workId}));expect(progress.status).toBe('complete');
    expect(JSON.parse(String(db.prepare('SELECT fold_json FROM upload_materializations WHERE work_id=?').pluck().get(workId))).counts).toEqual({members:1,configurations:0,intervals:0});
  });
  it.each(['before-commit','after-commit','after-answer'])('freezes T3 exactly once at %s and retries stored identity/bytes after reopen',async boundary=>{
    let {storage}=await direct();const source=await uploadTestSource(storage),workId=await uploadTestWork(storage,source),input={workId,producerVersion:'test',createdUtcMs:1000};storage.close();
    const answer=await kill('freezeUploadMaterialization',input,boundary);const reopened=await direct();storage=reopened.storage;const db=reopened.db;const prior=db.prepare('SELECT event_id,revision,payload FROM upload_envelopes').get();
    if(boundary==='before-commit'){expect(prior).toBeUndefined();expect(db.prepare('SELECT http_revision FROM upload_source_bindings').pluck().get()).toBe(0n);}else expect(answer).toMatchObject({status:'frozen'});
    const frozen=ok(storage.freezeUploadMaterialization(input));expect(frozen.status).toBe('frozen');const stored=db.prepare('SELECT event_id,revision,payload FROM upload_envelopes').get();if(prior)expect(stored).toEqual(prior);
    expect(ok(storage.freezeUploadMaterialization({...input,producerVersion:'other',createdUtcMs:2000}))).toEqual(frozen);expect(db.prepare('SELECT count(*) FROM upload_envelopes').pluck().get()).toBe(1n);expect(db.prepare('SELECT http_revision FROM upload_source_bindings').pluck().get()).toBe(1n);
  });
  it.each(['before-commit','after-commit'])('commits T4 receipt before reclaim at %s; simulated remote commit/lost local receipt retries identical bytes',async boundary=>{
    let {storage,db}=await direct();const source=await uploadTestSource(storage),workId=await uploadTestWork(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
    const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000})),receipt=uploadReceipt(attempt.eventId!),input={attemptId:attempt.attemptId!,statusCode:202,body:Array.from(receipt)};
    const before=db.prepare('SELECT events,bytes FROM upload_queue_usage').get();storage.close();await kill('commitUploadReceipt',input,boundary);({storage,db}=await direct());expect(db.prepare('SELECT events,bytes FROM upload_queue_usage').get()).toEqual(before);
    expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(boundary==='before-commit'?0n:1n);
    if(boundary==='before-commit'){ok(storage.recoverUploadAttempt({attemptId:attempt.attemptId!}));const retry=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:2000}));expect(retry.eventId).toBe(attempt.eventId);expect(retry.payload).toEqual(attempt.payload);}
    expect(ok(storage.commitUploadReceipt({...input,body:receipt})).status).toBe(boundary==='before-commit'?'delivered':'duplicate');
    expect(ok(storage.recoverUploadAttempt({attemptId:attempt.attemptId!})).status).toBe('delivered');expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:3000})).status).toBe('empty');
    expect(ok(storage.reclaimUploadPayloads({limit:1}))).toMatchObject({reclaimed:1,events:0,bytes:0});
  });
  it.each(['before-commit','after-commit'])('reclaims delivered payload/capacity atomically at %s and retains immutable receipt/header',async boundary=>{
    let {storage}=await direct();const source=await uploadTestSource(storage),workId=await uploadTestWork(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
    const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:uploadReceipt(attempt.eventId!)}));storage.close();await kill('reclaimUploadPayloads',{limit:1},boundary);const reopened=await direct();storage=reopened.storage;const db=reopened.db;
    expect(db.prepare('SELECT events FROM upload_queue_usage').pluck().get()).toBe(boundary==='before-commit'?1n:0n);expect(db.prepare('SELECT payload IS NULL FROM upload_envelopes').pluck().get()).toBe(boundary==='before-commit'?0n:1n);
    expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(1n);expect(db.prepare('SELECT http_revision FROM upload_source_bindings').pluck().get()).toBe(1n);
    expect(ok(storage.reclaimUploadPayloads({limit:1}))).toMatchObject({events:0,bytes:0});expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

it.each(['before-commit','after-commit'])('REG-006/012 commits scan cursor/highwater progress atomically at %s',async boundary=>{
  let {storage,db}=await direct();const source=await uploadTestSource(storage),runId=randomUUID();ok(storage.confirmUploadOwner({confirmationId:runId,registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'}));const before=db.prepare('SELECT legacy_after,ordinal_after,phase FROM upload_scan_runs WHERE run_id=?').get(runId);storage.close();
  await kill('advanceUploadScan',{runId,registrationId:source.registrationId},boundary);({storage,db}=await direct());const after=db.prepare('SELECT legacy_after,ordinal_after,phase FROM upload_scan_runs WHERE run_id=?').get(runId);
  if(boundary==='before-commit')expect(after).toEqual(before);else expect(after).toEqual({legacy_after:0n,ordinal_after:1n,phase:'complete'});
  expect(ok(storage.advanceUploadScan({runId,registrationId:source.registrationId}))).toMatchObject({phase:'complete',cursor:{legacy:'0',ordinal:'1'}});expect(db.prepare('SELECT count(*) FROM upload_source_bindings').pluck().get()).toBe(1n);
});

it('REG-006/012 recovers lost page and begin answers with the original work/pin, skips held roots, releases bounded work then reaches later sources',async()=>{
  let {storage,db}=await direct();const source=await uploadTestSource(storage);
  db.prepare("UPDATE upload_source_bindings SET held=1,hold_reason='reconciliation-required' WHERE trip_uuid=?").run(source.tripUuid);
  const add=(id:string,scope:string)=>{const script=new Script(id),tripUuid=`70000000-0000-4000-8000-${scope==='c'?'000000000002':'000000000003'}`;ok(storage.upsertSession({message:uploadGame(script.welcome())}));ok(storage.commitEvent({message:uploadGame(script.event(r.jobConfigured())),profile:{...uploadProof(script),scope:scope.repeat(64)},effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));return tripUuid;};
  const second=add('10000000-0000-4000-8000-000000000002','c'),input={registrationId:source.registrationId,after:'0',limit:1};storage.close();
  expect(await kill('pageUploadDiscovery',input,'after-commit')).toMatchObject({examined:1,items:[{tripUuid:second,workId:null}]});storage=(await direct()).storage;
  const after=ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).discoveryAfter,resumed=ok(storage.pageUploadDiscovery({...input,after}));expect(resumed.items).toEqual([{tripUuid:second,materialVersion:resumed.items[0].materialVersion,workId:null}]);
  const workId=randomUUID();storage.close();await kill('beginUploadMaterialization',{workId,tripUuid:second,registrationId:source.registrationId},'after-commit');({storage,db}=await direct());
  const incarnation=db.prepare('SELECT incarnation_uuid FROM upload_projection_pins WHERE pin_id=?').pluck().get(workId);
  const recovered=ok(storage.pageUploadDiscovery({...input,after}));expect(recovered.items).toEqual([{tripUuid:second,materialVersion:recovered.items[0].materialVersion,workId}]);
  let work=ok(storage.advanceUploadMaterialization({workId}));while(['preparing','folding'].includes(work.status))work=ok(storage.advanceUploadMaterialization({workId}));expect(work.status).toBe('complete');
  expect(db.prepare('SELECT incarnation_uuid FROM upload_projection_pins WHERE pin_id=?').pluck().get(workId)).toBe(incarnation);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  do{work=ok(storage.releaseUploadMaterialization({workId}));expect(work.examined).toBeLessThanOrEqual(100);}while(work.status!=='released');
  let page=ok(storage.pageUploadDiscovery({...input,after,limit:100}));expect(page.items).toEqual([]);expect(page.examined).toBeGreaterThan(0);
  const cursor=ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).discoveryAfter;expect(cursor).toBe(page.next);
  const third=add('10000000-0000-4000-8000-000000000003','d');storage.close();await kill('pageUploadDiscovery',{...input,after:cursor},'after-commit');({storage,db}=await direct());
  page=ok(storage.pageUploadDiscovery({...input,after:ok(storage.getUploadStoreStatus({registrationId:source.registrationId})).discoveryAfter}));expect(page.items).toMatchObject([{tripUuid:third,workId:null}]);
  expect(db.prepare('SELECT pin_released FROM upload_materializations WHERE work_id=?').pluck().get(workId)).toBe(1n);
});

it('REG-006/012 recovers a claim committed before its answer without retaining the caller attempt UUID, then keeps A and B bytes isolated',async()=>{
  let {storage,db}=await direct();const a=await uploadTestSource(storage),workId=await uploadTestWork(storage,a),frozen=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  const original=db.prepare('SELECT payload FROM upload_envelopes WHERE event_id=?').pluck().get(frozen.eventId) as Uint8Array;
  storage.close();
  // The restarted consumer retains no claim UUID or answer. The only identifier it has is the durable source/owner.
  await kill('claimUploadAttempt',{attemptId:randomUUID(),registrationId:a.registrationId,expectedVersion:'1',mode:'any',nowMs:1000},'after-commit');storage=(await direct()).storage;
  const install=ok(storage.ensureUploadInstallation()),b=randomUUID();ok(storage.recordUploadRegistration({registrationId:b,clientInstallationId:install.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b,credentialGeneration:'b',expectedVersion:'1'}));
  const script=new Script('10000000-0000-4000-8000-000000000002'),tripUuid='70000000-0000-4000-8000-000000000002';ok(storage.upsertSession({message:uploadGame(script.welcome())}));ok(storage.commitEvent({message:uploadGame(script.event(r.jobConfigured())),profile:{...uploadProof(script),scope:'c'.repeat(64)},effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:2000}]}));
  const bWork=await uploadTestWork(storage,{tripUuid,registrationId:b}),bEvent=ok(storage.freezeUploadMaterialization({workId:bWork,producerVersion:'test',createdUtcMs:2000}));
  expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}))).toMatchObject({status:'busy',attemptId:null,eventId:null,registrationId:null,payload:null});
  storage.close();const recovered=await kill('recoverUploadAttempt',{startup:true},'after-answer') as UploadAttemptResult;({storage,db}=await direct());expect(recovered).toMatchObject({status:'recovered',eventId:frozen.eventId,registrationId:a.registrationId,registration:null,payload:null});expect(recovered.attemptId).not.toBeNull();
  expect(ok(storage.recoverUploadAttempt({startup:true}))).toMatchObject({status:'empty',attemptId:null,eventId:null});
  expect(ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:a.registrationId,expectedVersion:'2',mode:'any',nowMs:2000})).status).toBe('paused');
  const sentB=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}));expect(sentB.eventId).toBe(bEvent.eventId);expect(sentB.registration?.accountId).toBe('B');ok(storage.recoverUploadAttempt({attemptId:sentB.attemptId!}));
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'rotated-a',expectedVersion:'2'}));const sentA=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:a.registrationId,expectedVersion:'3',mode:'any',nowMs:3000}));expect(sentA.eventId).toBe(frozen.eventId);expect(sentA.payload).toEqual(new Uint8Array(original));expect(sentA.registration?.accountId).toBe('A');
  expect(db.prepare('SELECT credential_generation FROM upload_attempt WHERE attempt_id=?').pluck().get(sentA.attemptId)).toBe('rotated-a');expect(db.prepare('SELECT credential_generation,active,outcome FROM upload_attempt WHERE attempt_id=?').get(recovered.attemptId)).toEqual({credential_generation:'generation',active:0n,outcome:'ambiguous'});
  expect(db.prepare('SELECT count(*) FROM upload_attempt WHERE active=1').pluck().get()).toBe(1n);expect(db.prepare('SELECT count(*) FROM upload_envelopes').pluck().get()).toBe(2n);
});
