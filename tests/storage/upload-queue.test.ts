import {contentDigest} from '../../packages/storage/src/sqlite/digest';
import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {MIGRATIONS,Storage,type SampleInput} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {StorageClient} from '../../packages/storage/src/client';
import {UploadScheduler,type UploadStorage,type UploadClock} from '../../apps/desktop/src/dashboard-upload/scheduler';
import type {UploadHttpResult} from '../../apps/desktop/src/dashboard-upload/http';
import type {UploadWork} from '../../packages/storage/src/upload-sync';
import {encodeUploadEnvelope,uploadDigest,type UploadEnvelope} from '../../packages/storage/src/upload-envelope';
import {UPLOAD_MAX_BYTES,UPLOAD_MAX_EVENTS} from '../../packages/storage/src/upload-sync';
import {recheckUploadProjection} from '../../packages/storage/src/sqlite/upload-projection';
import {tripUuidFor,type ProfileObservation} from '../../packages/telemetry-core/src';
import {ETS2_A,ETS2_B,job,r,Script,trailer} from '../shared/trip-messages';
import {failed,ok,TEST_CLOSE_GRACE_MS,workspace} from './helpers';
import {storageWorker,terminateWorkers} from './recording-helpers';
let ws:Awaited<ReturnType<typeof workspace>>,opened:Storage[]=[];
beforeEach(async()=>{ws=await workspace();});afterEach(async()=>{await terminateWorkers();for(const s of opened)s.close();opened=[];await ws.dispose();});
const game=<T extends {source:{origin:string}}>(message:T):T=>({...message,source:{...message.source,origin:'game'}});
const mode={mode:'unknown',method:'none',confidence:'none'} as const;
const proof=(s:Script):ProfileObservation=>({version:1,scope:'a'.repeat(64),binding:'b'.repeat(64),game:'ets2',pluginSessionId:s.session,processInstanceId:s.welcome().source.processInstanceId,sourceClockId:s.clockId,afterMonotonicNs:'0',loadGeneration:1});
async function setup(client:Storage|StorageClient,baseline=false){
  const install=ok(await client.ensureUploadInstallation()),registrationId=randomUUID(),runId=randomUUID();
  ok(await client.recordUploadRegistration({registrationId,clientInstallationId:install.clientInstallationId!,origin:'https://dashboard.example',accountId:'A',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));
  ok(await client.confirmUploadOwner({confirmationId:runId,registrationId,credentialGeneration:'generation',expectedVersion:'0'}));
  const s=new Script(ETS2_A),tripUuid=tripUuidFor(s.session,'1');ok(await client.upsertSession({message:game(s.welcome())}));
  if(baseline){
    const checkpoint=game(s.checkpoint(null));checkpoint.data.state.boundaryOrder='0';
    checkpoint.data.state.configuration.trailers=Array.from({length:10},(_,index)=>index===0?{available:true,value:trailer(0,{bodyType:{available:true,value:'curtainsider'}})}:{available:false,reason:'not-observed'});
    ok(await client.recordTrailerBaseline({message:checkpoint}));
  }
  ok(await client.commitEvent({message:game(s.event(r.jobConfigured())),profile:proof(s),effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
  return {s,tripUuid,registrationId,runId};
}
async function complete(client:Storage|StorageClient,input:{tripUuid:string;registrationId:string}){
  const workId=randomUUID();let work=ok(await client.beginUploadMaterialization({tripUuid:input.tripUuid,registrationId:input.registrationId,workId}));
  for(let turn=0;['preparing','folding'].includes(work.status)&&turn<1000;turn++){work=ok(await client.advanceUploadMaterialization({workId}));expect(work.examined).toBeLessThanOrEqual(100);}
  expect(work.status).toBe('complete');return workId;
}
const response=(eventId:string,receiptId=randomUUID(),status='stored')=>new TextEncoder().encode(JSON.stringify({contract:{major:1,minor:0},eventId,receiptId,status,firstReceivedAtUtcMs:5000}));
function schedulerTurns(){
  let now=1000,pending:{run:()=>void;at:number}|undefined,scheduled:(()=>void)|undefined;
  const time:UploadClock={now:()=>now,random:()=>.5,schedule(run,ms){pending={run,at:now+ms};scheduled?.();return run;},cancel(id){if(pending?.run===id)pending=undefined;}};
  return {time,async turn(at?:number){expect(pending).toBeDefined();const next=pending!;pending=undefined;now=Math.max(at??now,next.at);let guard:ReturnType<typeof setTimeout>|undefined;
    try{await new Promise<void>((resolve,reject)=>{scheduled=resolve;guard=setTimeout(()=>reject(Error('SCHEDULER_TURN_HANG_GUARD')),5000);next.run();});await new Promise(resolve=>setImmediate(resolve));}finally{scheduled=undefined;clearTimeout(guard);}
  }};
}
it.each([false,true])('REG-005/010/011/012 keeps local cancellation ambiguous without adding retry backoff (prior network retry %s)',async priorRetry=>{
  let worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));const source=await setup(client),workId=await complete(client,source),frozen=ok(await client.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(await client.releaseUploadMaterialization({workId}));
  if(priorRetry){const attempt=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(await client.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'retry',retryAtMs:2000,nowMs:1000}));}
  const turns=schedulerTurns(),payloads:Uint8Array[]=[];let finish:((value:UploadHttpResult)=>void)|undefined;
  const scheduler=new UploadScheduler(client,{request(_route,_token,payload){payloads.push(new Uint8Array(payload!));return new Promise(resolve=>{finish=resolve;});},abort(){finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});},close(){}},'https://dashboard.example','test',()=>{},turns.time);
  try{for(let transition=0;transition<3;transition++){await scheduler.activate(ok(await client.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});for(let turn=0;turn<12;turn++)await turns.turn(priorRetry?2000:1000);expect(payloads).toHaveLength(transition+1);await scheduler.suspend();expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({status:'ready',failureStreak:priorRetry?1:0,retryEventId:priorRetry?frozen.eventId:null,retryAtMs:priorRetry?2000:0,paused:null});}}
  finally{await scheduler.stop();await client.close();}
  const inspect=await openConnection(ws.options({purpose:'history'}));try{expect(inspect.reader().prepare('SELECT outcome,active FROM upload_attempt ORDER BY rowid').all()).toEqual([...(priorRetry?[{outcome:'retry',active:0n}]:[]),...Array.from({length:3},()=>({outcome:'ambiguous',active:0n}))]);expect(inspect.reader().prepare('SELECT state,retry_at,payload FROM upload_envelopes').get()).toEqual({state:'queued',retry_at:priorRetry?2000n:0n,payload:Buffer.from(payloads[0])});}finally{inspect.close();}
  worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
  try{expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:priorRetry?1:0,retryEventId:priorRetry?frozen.eventId:null});const retry=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:priorRetry?2000:1000}));expect(retry.status).toBe('claimed');expect(retry.eventId).toBe(frozen.eventId);expect(retry.payload).toEqual(payloads[0]);expect(payloads.every(payload=>Buffer.from(payload).equals(Buffer.from(retry.payload!)))).toBe(true);ok(await client.recoverUploadAttempt({attemptId:retry.attemptId!}));expect(ok(await client.commitUploadReceipt({attemptId:retry.attemptId!,statusCode:202,body:response(retry.eventId!)})).status).toBe('delivered');expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:0,retryEventId:null});}finally{await client.close();}
});
it('REG-005/010/011/012 keeps missing-dependent reconciliation across real worker status and hints turns',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));fillQueue(conn,2);
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'retry',retryAtMs:1000,nowMs:1000}));
  const db=conn.writer();db.pragma('foreign_keys=OFF');db.prepare('DELETE FROM upload_envelopes WHERE event_id=?').run(attempt.eventId);db.pragma('foreign_keys=ON');storage.close();
  const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
  const calls:string[]=[],port=new Proxy(client,{get(target,key){const method=Reflect.get(target,key);return typeof method==='function'?(...args:unknown[])=>{calls.push(String(key));return Reflect.apply(method,target,args);}:method;}}),turns=schedulerTurns();let requests=0,finish:((value:UploadHttpResult)=>void)|undefined;
  const scheduler=new UploadScheduler(port,{request(){requests++;return new Promise(resolve=>{finish=resolve;});},abort(){finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});},close(){}},'https://dashboard.example','test',()=>{},turns.time);
  const statuses:(string|null)[]=[];
  try{await scheduler.activate(ok(await client.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});for(let turn=0;turn<40;turn++){await turns.turn();statuses.push(scheduler.status.error);}expect(calls.filter(name=>name==='getUploadStoreStatus').length).toBeGreaterThan(1);expect(calls.filter(name=>name==='getUploadSchedulingHints').length).toBeGreaterThan(1);expect(calls).not.toContain('claimUploadAttempt');expect(requests).toBe(0);expect(statuses).toEqual(Array(40).fill('RECONCILIATION'));}
  finally{await scheduler.stop();await client.close();}
  const inspect=await openConnection(ws.options({purpose:'history'}));try{expect(inspect.reader().prepare('SELECT active,outcome FROM upload_attempt').all()).toEqual([{active:0n,outcome:'retry'}]);expect(inspect.reader().prepare('SELECT state FROM upload_envelopes').all()).toEqual([{state:'queued'}]);}finally{inspect.close();}
});
it.each(['NETWORK','TIMEOUT'] as const)('REG-005/010/011/012 retains %s during a real SQLite active retry until its matching receipt',async failure=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);
  const client=new Proxy({} as UploadStorage,{get(_target,key){return (...args:unknown[])=>Promise.resolve(Reflect.apply(storage[key as keyof Storage] as (...a:unknown[])=>unknown,storage,args));}}),source=await setup(storage),workId=await complete(storage,source),frozen=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));
  const turns=schedulerTurns();let requests=0,finish:((value:UploadHttpResult)=>void)|undefined;
  const scheduler=new UploadScheduler(client,{request(){if(++requests===1)return Promise.resolve({ok:false,code:failure,statusCode:null,retryAfter:null});return new Promise(resolve=>{finish=resolve;});},abort(){finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});},close(){}},'https://dashboard.example','test',()=>{},turns.time);
  try{await scheduler.activate(ok(await client.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});for(let turn=0;turn<8;turn++)await turns.turn();expect(scheduler.status.error).toBe(failure);for(let turn=0;turn<40;turn++)await turns.turn(2000);expect(requests).toBe(2);expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:0,retryEventId:frozen.eventId});expect(scheduler.status).toMatchObject({state:'paused',error:failure});
    expect(conn.reader().prepare('SELECT event_ref,active,outcome FROM upload_attempt WHERE active=1').get()).toEqual({event_ref:frozen.eventId,active:1n,outcome:null});
    finish!({ok:true,statusCode:202,body:response(frozen.eventId!),retryAfter:null});for(let turn=0;turn<4;turn++)await turns.turn();expect(scheduler.status).toMatchObject({state:'connected',error:null});expect(ok(await client.getUploadStoreStatus({registrationId:source.registrationId})).deliveredEvents).toBe(1);
  }finally{await scheduler.stop();}
});
it('REG-005/010/011/012 correlates an unresolved retry across another event receipt and clears only its own ACK',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));fillQueue(conn,2);
  const failedAttempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.recordUploadAttemptOutcome({attemptId:failedAttempt.attemptId!,kind:'retry',retryAtMs:2000,nowMs:1000}));storage.close();
  const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));const turns=schedulerTurns(),events:string[]=[];let finish:((value:UploadHttpResult)=>void)|undefined;
  const scheduler=new UploadScheduler(client,{request(_route,_token,payload){events.push(JSON.parse(Buffer.from(payload!).toString()).eventId);return new Promise(resolve=>{finish=resolve;});},abort(){finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});},close(){}},'https://dashboard.example','test',()=>{},turns.time);
  try{await scheduler.activate(ok(await client.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});for(let turn=0;turn<12;turn++)await turns.turn(2000);expect(events).toHaveLength(1);expect(events[0]).not.toBe(failedAttempt.eventId);
    finish!({ok:true,statusCode:202,body:response(events[0]),retryAfter:null});for(let turn=0;turn<20;turn++)await turns.turn();expect(events).toEqual([events[0],failedAttempt.eventId]);expect(scheduler.status).toMatchObject({state:'paused',error:'NETWORK'});expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:0,retryEventId:failedAttempt.eventId});
    finish!({ok:true,statusCode:202,body:response(failedAttempt.eventId!),retryAfter:null});for(let turn=0;turn<4;turn++)await turns.turn();expect(scheduler.status).toMatchObject({state:'connected',error:null});expect(ok(await client.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:0,retryEventId:null});expect(ok(await client.getUploadStoreStatus({registrationId:source.registrationId})).deliveredEvents).toBe(2);
  }finally{await scheduler.stop();await client.close();}
});
it('REG-005/010/012 pages distinct sources separately from older durable receipts and bounds reads despite released work history',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));let db=conn.writer();fillQueue(conn,151);
  const latest=String(db.prepare('SELECT event_id FROM upload_envelopes WHERE revision=151').pluck().get()),events=(db.prepare('SELECT event_id FROM upload_envelopes ORDER BY event_id').all() as {event_id:string}[]).filter(row=>row.event_id!==latest);
  db.transaction(()=>{for(let index=1;index<150;index++){db.prepare("UPDATE upload_envelopes SET state='delivered' WHERE event_id=?").run(events[index].event_id);db.prepare('INSERT INTO upload_receipts VALUES(?,?,?)').run(events[index].event_id,randomUUID(),5000+index);}})();
  const sourcePage=ok(storage.pageUploadSources({registrationId:source.registrationId,phase:'sources',after:null,limit:100}));expect(sourcePage.examined).toBe(1);expect(sourcePage.sources).toHaveLength(1);expect(sourcePage.sources[0]).toMatchObject({state:'queued',latestRevision:151,lastReceiptUtcMs:null});
  const first=ok(storage.pageUploadSources({registrationId:source.registrationId,phase:'receipts',after:null,limit:100}));expect(first.examined).toBe(100);expect(first.receipts).toHaveLength(100);expect(first.next).toBe(`r:0:${events[100].event_id}`);
  storage.close();conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);opened.push(storage);db=conn.writer();
  const second=ok(storage.pageUploadSources({registrationId:source.registrationId,phase:'receipts',after:first.next,limit:100}));expect(second.examined).toBe(49);expect(second.receipts).toHaveLength(49);expect(second.receipts.at(-1)?.firstReceivedUtcMs).toBe(5149);
  // A receipt committed behind the already traversed key is visible when reconstruction is invalidated/restarted.
  db.prepare("UPDATE upload_envelopes SET state='delivered' WHERE event_id=?").run(events[0].event_id);db.prepare('INSERT INTO upload_receipts VALUES(?,?,?)').run(events[0].event_id,randomUUID(),9000);expect(ok(storage.pageUploadSources({registrationId:source.registrationId,phase:'receipts',after:null,limit:1})).receipts[0].firstReceivedUtcMs).toBe(9000);
  expect(ok(storage.readRetainedUploadMaterializations())).toEqual({examined:0,unmanagedPins:0,items:[]});
  const plans=[db.prepare('EXPLAIN QUERY PLAN SELECT * FROM upload_materializations WHERE pin_id=?').all(randomUUID()),db.prepare("EXPLAIN QUERY PLAN SELECT event_id,retry_at FROM upload_envelopes WHERE registration_ref=? AND state='delivered' AND (retry_at,event_id)>(?,?) ORDER BY retry_at,event_id LIMIT 100").all(source.registrationId,0,'')];
  for(const plan of plans){const text=plan.map(row=>(row as {detail:string}).detail).join('\n');expect(text).toContain('SEARCH');expect(text).not.toMatch(/SCAN|TEMP B-TREE/);}
});
it('REG-005/010/012 treats a standalone retained pin as unmanaged without traversing materialization history',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),pinId=randomUUID();ok(storage.beginUploadProjection({pinId,tripUuid:source.tripUuid}));
  expect(ok(storage.readRetainedUploadMaterializations())).toEqual({examined:1,unmanagedPins:1,items:[]});expect(ok(storage.getUploadConfiguration())).toMatchObject({status:'ready',version:'1',registration:{registrationId:source.registrationId}});
  conn.writer().pragma('foreign_keys=OFF');conn.writer().prepare('DELETE FROM upload_scan_runs').run();conn.writer().pragma('foreign_keys=ON');expect(ok(storage.getUploadConfiguration()).status).toBe('reconciliation-required');
});
it('REG-005/010/011/012 recovers all eight old-owner preparations after restart without transferring their bytes',async()=>{
  let worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
  const a=await setup(client),ids:string[]=[];
  for(let index=0;index<8;index++){
    let tripUuid=a.tripUuid;
    if(index){const s=new Script(randomUUID());tripUuid=tripUuidFor(s.session,'1');ok(await client.upsertSession({message:game(s.welcome())}));ok(await client.commitEvent({message:game(s.event(r.jobConfigured())),profile:{...proof(s),scope:String(index).repeat(64)},effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));}
    const workId=randomUUID();expect(ok(await client.beginUploadMaterialization({workId,tripUuid,registrationId:a.registrationId})).status).toBe('preparing');ids.push(workId);
  }
  const installation=ok(await client.ensureUploadInstallation()),b=randomUUID();ok(await client.recordUploadRegistration({registrationId:b,clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));ok(await client.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b,credentialGeneration:'b',expectedVersion:'1'}));
  await client.close();worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
  const retained=ok(await client.readRetainedUploadMaterializations());expect(retained.examined).toBe(8);expect(retained.unmanagedPins).toBe(0);expect(retained.items.map(item=>item.workId).sort()).toEqual(ids.sort());expect(retained.items.every(item=>item.registrationId===a.registrationId)).toBe(true);
  const bScript=new Script(randomUUID()),bTrip=tripUuidFor(bScript.session,'1');ok(await client.upsertSession({message:game(bScript.welcome())}));ok(await client.commitEvent({message:game(bScript.event(r.jobConfigured())),profile:{...proof(bScript),scope:'c'.repeat(64)},effects:[{kind:'trip.open',tripUuid:bTrip,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));const bWork=randomUUID();failed(await client.beginUploadMaterialization({workId:bWork,tripUuid:bTrip,registrationId:b}),'STORAGE_BUSY');
  for(const item of retained.items){let work=ok(await client.advanceUploadMaterialization({workId:item.workId}));for(let turn=0;['preparing','folding'].includes(work.status)&&turn<30;turn++)work=ok(await client.advanceUploadMaterialization({workId:item.workId}));expect(work.status).toBe('complete');expect(ok(await client.freezeUploadMaterialization({workId:item.workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');for(let turn=0;turn<30;turn++){if(ok(await client.releaseUploadMaterialization({workId:item.workId})).status==='released')break;}}
  expect(ok(await client.readRetainedUploadMaterializations())).toEqual({examined:0,unmanagedPins:0,items:[]});
  expect(ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}))).toMatchObject({status:'empty',payload:null});
  expect(ok(await client.beginUploadMaterialization({workId:bWork,tripUuid:bTrip,registrationId:b})).status).toBe('preparing');let bProgress=ok(await client.advanceUploadMaterialization({workId:bWork}));for(let turn=0;['preparing','folding'].includes(bProgress.status)&&turn<30;turn++)bProgress=ok(await client.advanceUploadMaterialization({workId:bWork}));expect(bProgress.status).toBe('complete');expect(ok(await client.freezeUploadMaterialization({workId:bWork,producerVersion:'test',createdUtcMs:2000})).status).toBe('frozen');
  const bAttempt=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:b,expectedVersion:'2',mode:'any',nowMs:2000}));expect(JSON.parse(Buffer.from(bAttempt.payload!).toString()).source.tripId).toBe(bTrip);expect(bAttempt.registration?.accountId).toBe('B');ok(await client.recoverUploadAttempt({attemptId:bAttempt.attemptId!}));
  expect(ok(await client.getUploadStoreStatus({registrationId:a.registrationId})).queuedEvents).toBe(8);
  ok(await client.confirmUploadOwner({confirmationId:randomUUID(),registrationId:a.registrationId,credentialGeneration:'a-again',expectedVersion:'2'}));const attempt=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:a.registrationId,expectedVersion:'3',mode:'any',nowMs:2000}));
  expect(attempt.registration?.accountId).toBe('A');expect(JSON.parse(Buffer.from(attempt.payload!).toString())).toMatchObject({delivery:{mode:'live',syncRunId:a.runId}});await client.close();
});
it('REG-005/010/011/012 caps restart scheduling history at nine connection-scoped transient attempts',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));
  for(let index=0;index<12;index++){const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000+index*1000}));expect(attempt.status).toBe('claimed');ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'retry',retryAtMs:2000+index*1000,nowMs:1000+index*1000}));}
  storage.close();conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);opened.push(storage);expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:9,retryAtMs:13000,version:'1',credentialGeneration:'generation'});
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'}));expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({failureStreak:0,retryAtMs:13000,version:'2'});
});
it('REG-005/010/011/012 preserves a connection Retry-After hold across restart when a second envelope is eligible',async()=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));fillQueue(conn,2);
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'retry',retryAtMs:301000,nowMs:1000}));storage.close();
  conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);opened.push(storage);let now=2000,next=0,pending:{id:number;at:number;run:()=>void}|undefined,finish:(()=>void)|undefined;const requests:Uint8Array[]=[];
  const time:UploadClock={now:()=>now,random:()=>.5,schedule(run,ms){pending={id:++next,at:now+ms,run};return next;},cancel(id){if(pending?.id===id)pending=undefined;}};
  const client=new Proxy({} as UploadStorage,{get(_target,key){return (...args:unknown[])=>Promise.resolve(Reflect.apply(storage[key as keyof Storage] as (...a:unknown[])=>unknown,storage,args));}});
  const scheduler=new UploadScheduler(client,{request(_route,_token,payload){requests.push(new Uint8Array(payload!));return new Promise(resolve=>{finish=()=>resolve({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});});},abort(){finish?.();},close(){}},'https://dashboard.example','test',()=>{},time);
  const step=async(at:number)=>{now=at;const turn=pending;if(turn&&turn.at<=now){pending=undefined;turn.run();}await new Promise(resolve=>setImmediate(resolve));};
  try{await scheduler.activate(ok(storage.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});await step(300999);expect(requests).toHaveLength(0);expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId})).retryAtMs).toBe(301000);await step(301009);expect(requests).toHaveLength(1);}
  finally{await scheduler.stop();}
  expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({retryAtMs:301000,failureStreak:1,retryEventId:attempt.eventId});expect(conn.reader().prepare('SELECT retry_at FROM upload_envelopes WHERE event_id=?').pluck().get(attempt.eventId)).toBe(301000n);
  ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:source.registrationId,credentialGeneration:'rotated',expectedVersion:'1'}));expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId})).failureStreak).toBe(0);
  // The aborted second event retains retry_at=0; the old generation's connection hold does not fence the rotated one.
  expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId})).retryAtMs).toBe(0);
  const installation=ok(storage.ensureUploadInstallation()),b=randomUUID();ok(storage.recordUploadRegistration({registrationId:b,clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));ok(storage.confirmUploadOwner({confirmationId:randomUUID(),registrationId:b,credentialGeneration:'b',expectedVersion:'2'}));expect(ok(storage.getUploadSchedulingHints({registrationId:b}))).toMatchObject({retryAtMs:null,failureStreak:0,paused:null,held:null});
});
it('REG-005/010/012 scheduling hints hold missing dependent metadata without repairing or transferring it',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));ok(storage.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind:'retry',retryAtMs:301000,nowMs:1000}));
  const db=conn.writer();db.pragma('foreign_keys=OFF');db.prepare('DELETE FROM upload_envelopes WHERE event_id=?').run(attempt.eventId);db.pragma('foreign_keys=ON');const before=contentDigest(db);expect(ok(storage.getUploadSchedulingHints({registrationId:source.registrationId}))).toMatchObject({status:'reconciliation-required'});expect(contentDigest(db)).toEqual(before);
});
it.each(['NETWORK','TIMEOUT',500,400,413,415,422] as const)('REG-005/010/011/012 commits %s outcome and restores its truthful public status after SQLite reopen',async failure=>{
  let conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),workId=await complete(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));ok(storage.releaseUploadMaterialization({workId}));const payload=conn.writer().prepare('SELECT payload FROM upload_envelopes').pluck().get() as Uint8Array;
  let pending:(()=>void)|undefined,signal!:()=>void,guard:ReturnType<typeof setTimeout>|undefined;const validation=typeof failure==='number'&&failure<500,error=validation?'VALIDATION':failure==='TIMEOUT'?'TIMEOUT':'NETWORK';const published=new Promise<void>(resolve=>{signal=resolve;});
  const time:UploadClock={now:()=>1000,random:()=>.5,schedule(run){pending=run;return 1;},cancel(){pending=undefined;}};
  const client=new Proxy({} as UploadStorage,{get(_target,key){return (...args:unknown[])=>Promise.resolve(Reflect.apply(storage[key as keyof Storage] as (...a:unknown[])=>unknown,storage,args));}});
  const response:UploadHttpResult=typeof failure==='string'?{ok:false,code:failure,statusCode:null,retryAfter:null}:{ok:true,statusCode:failure,body:Buffer.from('{}'),retryAfter:null};
  const scheduler=new UploadScheduler(client,{request:()=>Promise.resolve(response),abort(){},close(){}},'https://dashboard.example','test',status=>{if(status.error===error)signal();},time);
  try{await scheduler.activate(ok(storage.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});pending!();await Promise.race([published,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('DURABLE_FAILURE_STATUS_HANG_GUARD')),5000);})]);
    expect(scheduler.status).toMatchObject({state:'paused',error});const row=conn.writer().prepare('SELECT e.state,e.retry_at,e.hold_reason,a.outcome FROM upload_envelopes e JOIN upload_attempt a ON a.event_ref=e.event_id').get();expect(row).toEqual({state:validation?'held':'queued',retry_at:2000n,hold_reason:validation?'validation':null,outcome:validation?'validation':'retry'});expect(conn.writer().prepare('SELECT payload FROM upload_envelopes').pluck().get()).toEqual(payload);
  }finally{clearTimeout(guard);await scheduler.stop();}
  storage.close();conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);opened.push(storage);const restarted=new UploadScheduler(client,{request(){throw Error('UNEXPECTED_EARLY_HTTP');},abort(){},close(){}},'https://dashboard.example','test',()=>{},time);
  try{await restarted.activate(ok(storage.getUploadConfiguration()),`vtc1_${randomUUID()}_${'a'.repeat(43)}`,{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});expect(restarted.status).toMatchObject({state:'paused',error:validation?'VALIDATION':'NETWORK'});}finally{await restarted.stop();}
});
it('REG-005/010/012 limits scan-run inputs before owner rejection and resumes across rejected pages',async()=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),installation=ok(storage.ensureUploadInstallation()),b=randomUUID();ok(storage.recordUploadRegistration({registrationId:b,clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));
  for(let index=1;index<=101;index++)ok(storage.confirmUploadOwner({confirmationId:`00000000-0000-0000-0000-${String(index).padStart(12,'0')}`,registrationId:b,credentialGeneration:'b',expectedVersion:String(index)}));
  const first=ok(storage.pageUploadScanRuns({registrationId:source.registrationId,after:null,limit:100}));expect(first).toEqual({after:null,next:'00000000-0000-0000-0000-000000000100',examined:100,items:[]});
  const second=ok(storage.pageUploadScanRuns({registrationId:source.registrationId,after:first.next,limit:100}));expect(second.examined).toBe(2);expect(second.items.map(item=>item.runId)).toEqual([source.runId]);
});
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
  // The correction comes from a trip.update total, the raw-total selection of legacy engine 0 (ET-112c).
  const conn=await openConnection(ws.options({purpose:'history',accountingEngine:0})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),db=conn.writer();
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


it('TEL-034 does not starve a proven baseline-backed OPEN preparation or freeze on ordinary native/counter progress',async()=>{
  // The counter progress is a trip.update total, the raw-total selection of legacy engine 0 (ET-112c).
  const conn=await openConnection(ws.options({purpose:'history',accountingEngine:0})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage,true),db=conn.writer();
  // Seed cursor filler atomically; the progress commits between materialization advances remain independent.
  db.transaction(()=>{
    for(let i=0;i<180;i++)ok(storage.commitEvent({message:game(source.s.event(r.paused()))}));
    for(let i=0;i<120;i++)ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'sample-loss'}));
  }).immediate();
  const progress=(value:number)=>ok(storage.commitEvent({message:game(source.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:source.tripUuid,set:{observedDistanceM:{available:true,value},fuelUsedL:{available:true,value}}}]}));
  progress(1);const workId=randomUUID();let work=ok(storage.beginUploadMaterialization({tripUuid:source.tripUuid,registrationId:source.registrationId,workId})),turn=0;
  while(['preparing','folding'].includes(work.status)&&turn<100){progress(++turn+1);work=ok(storage.advanceUploadMaterialization({workId}));expect(work.examined).toBeLessThanOrEqual(100);}
  expect(turn).toBeGreaterThan(3);expect(work.status).toBe('complete');
  const pin=JSON.parse(db.prepare('SELECT pin_json FROM upload_materializations WHERE work_id=?').pluck().get(workId) as string);
  expect(pin.ruleContext).toMatchObject({status:'proven',recordingLoss:false});expect(recheckUploadProjection(db,pin)).toBe(false);
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));
  expect(attempt.status).toBe('claimed');const envelope=JSON.parse(Buffer.from(attempt.payload!).toString()) as UploadEnvelope;
  expect(envelope.snapshot.evidence).toMatchObject({ruleContextComplete:true,reasons:[]});expect(envelope.snapshot.trailers.complete).toBe(true);
  expect(envelope.snapshot.observedDistance).toEqual({available:true,value:1,unit:'m'});
});
it.each(['configured','cleared','gap','loss','prefix'] as const)('TEL-034 invalidates a proven OPEN material context on new unlinked %s evidence',async kind=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage,true),workId=await complete(storage,source),db=conn.writer();
  const pin=JSON.parse(db.prepare('SELECT pin_json FROM upload_materializations WHERE work_id=?').pluck().get(workId) as string);expect(pin.ruleContext.status).toBe('proven');
  if(kind==='gap')ok(storage.commitGap({message:game(source.s.gap(1))}));
  else if(kind==='prefix')ok(storage.recordCompleteness(source.s.session,{tripUuid:source.tripUuid,kind:'discontinuity',detail:{cause:'reload',decision:'not-merged'}}));
  else if(kind==='loss')ok(storage.recordCompleteness(source.s.session,{kind:'restore-loss',firstEventSeq:source.s.next.toString(),lastEventSeq:source.s.next.toString()}));
  else ok(storage.commitEvent({message:game(source.s.event(kind==='cleared'?r.trailerCleared():r.trailerConfigured(trailer(0,{id:{available:true,value:'different'}}))))}));
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('stale');
  ok(storage.releaseUploadMaterialization({workId}));const replacement=await complete(storage,source);
  expect(ok(storage.freezeUploadMaterialization({workId:replacement,producerVersion:'test',createdUtcMs:1001})).status).toBe('frozen');
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1001}));
  expect(attempt.status).toBe('claimed');const summary=(JSON.parse(Buffer.from(attempt.payload!).toString()) as UploadEnvelope).snapshot;
  expect(summary.evidence.ruleContextComplete).toBe(false);
  expect(summary.evidence.reasons).toContain(kind==='gap'||kind==='loss'?'recording-intervals':kind==='prefix'?'trailer-context-unproven':'trailer-context-changed');
});


it.each(['after-terminal','unknown','overlap','hidden-overlap'] as const)('TEL-034 safely replaces a closed pending pin after %s session loss evidence',async kind=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage,true),db=conn.writer();
  ok(storage.commitEvent({message:game(source.s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',outcomeEvent:'this-event',closeReason:'outcome',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  const workId=await complete(storage,source),priorVersion=db.prepare('SELECT material_version FROM upload_change_heads').pluck().get();
  if(kind==='unknown')ok(storage.recordCompleteness(source.s.session,{kind:'restore-loss'}));
  else {
    if(kind==='overlap'||kind==='hidden-overlap')ok(storage.recordCompleteness(source.s.session,{kind:'restore-loss',firstEventSeq:'2',lastEventSeq:'2'}));
    if(kind==='after-terminal'||kind==='hidden-overlap')ok(storage.recordCompleteness(source.s.session,{kind:'restore-loss',firstEventSeq:'3',lastEventSeq:'3'}));
  }
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('stale');
  expect(db.prepare('SELECT material_version FROM upload_change_heads').pluck().get()).not.toBe(priorVersion);
  ok(storage.releaseUploadMaterialization({workId}));const replacement=await complete(storage,source);
  expect(ok(storage.freezeUploadMaterialization({workId:replacement,producerVersion:'test',createdUtcMs:1001})).status).toBe('frozen');
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1001}));
  expect(attempt.status).toBe('claimed');const summary=(JSON.parse(Buffer.from(attempt.payload!).toString()) as UploadEnvelope).snapshot;
  expect(summary.evidence.ruleContextComplete).toBe(kind==='after-terminal');
  expect(summary.evidence.reasons).toEqual(kind==='after-terminal'?[]:['recording-intervals','trailer-context-unproven']);
});


it.each([[1,false],[1,true],[2,false],[2,true]] as const)('TEL-034 re-evaluates retained version%s complete folds while preserving already frozen bytes (%s)',async(version,frozen)=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage,true),workId=await complete(storage,source),db=conn.writer();
  if(frozen)expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000})).status).toBe('frozen');
  const original=db.prepare('SELECT event_id,payload FROM upload_envelopes WHERE work_ref=?').get(workId);
  const pin=JSON.parse(db.prepare('SELECT pin_json FROM upload_materializations WHERE work_id=?').pluck().get(workId) as string);
  pin.ruleContext.version=version;
  if(version===2)pin.ruleContext.items.push({...pin.ruleContext.items[0],index:2});
  const saved=JSON.parse(db.prepare('SELECT snapshot_json FROM upload_projection_pins WHERE pin_id=?').pluck().get(workId) as string);if(version===1)delete saved.rulePrefix;
  db.prepare('UPDATE upload_projection_pins SET metadata_json=?,snapshot_json=? WHERE pin_id=?').run(JSON.stringify(pin),JSON.stringify(saved),workId);
  db.prepare('UPDATE upload_materializations SET pin_json=? WHERE work_id=?').run(JSON.stringify(pin),workId);
  expect(ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1001})).status).toBe('frozen');
  if(frozen)expect(db.prepare('SELECT event_id,payload FROM upload_envelopes WHERE work_ref=?').get(workId)).toEqual(original);
  const attempt=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:1001}));
  expect(attempt.status).toBe('claimed');const snapshot=(JSON.parse(Buffer.from(attempt.payload!).toString()) as UploadEnvelope).snapshot;
  expect(snapshot.trailers.complete).toBe(frozen);expect(snapshot.evidence).toMatchObject({ruleContextComplete:frozen,reasons:frozen?[]:['trailer-context-unproven']});
});

it('preserves minor 0 payloads and emits minor 1 envelopes with hardModeResult when negotiated',async()=>{
  const conn1=await openConnection(ws.options({purpose:'history'})),storage1=new Storage(conn1);opened.push(storage1);
  const source1=await setup(storage1);const db1=conn1.writer();
  ok(storage1.commitEvent({message:game(source1.s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source1.tripUuid,outcome:'delivered',outcomeEvent:'this-event',closeReason:'outcome',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  
  // 1. Freeze with contractMinor 1 (negotiated)
  const workId1=await complete(storage1,source1);
  expect(ok(storage1.freezeUploadMaterialization({workId:workId1,producerVersion:'test',createdUtcMs:1000,contractMinor:1})).status).toBe('frozen');
  const payload1=db1.prepare('SELECT payload FROM upload_envelopes WHERE work_ref=?').pluck().get(workId1) as Buffer;
  const envelope1=JSON.parse(payload1.toString()) as UploadEnvelope;
  expect(envelope1.contract).toEqual({major:1,minor:1});
  expect(envelope1.snapshot.hardModeResult).toBe('not-qualified');
  ok(storage1.releaseUploadMaterialization({workId:workId1}));

  // 2. Separate trip in new database workspace to test minor 0 (older dashboard negotiation)
  const ws0=await workspace();
  const conn0=await openConnection(ws0.options({purpose:'history'})),storage0=new Storage(conn0);
  try {
    const source0=await setup(storage0);const db0=conn0.writer();
    ok(storage0.commitEvent({message:game(source0.s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source0.tripUuid,outcome:'delivered',outcomeEvent:'this-event',closeReason:'outcome',recordingCompleteness:'complete',endedUtcMs:2000}]}));
    const workId0=await complete(storage0,source0);
    expect(ok(storage0.freezeUploadMaterialization({workId:workId0,producerVersion:'test',createdUtcMs:1001,contractMinor:0})).status).toBe('frozen');
    const payload0=db0.prepare('SELECT payload FROM upload_envelopes WHERE work_ref=?').pluck().get(workId0) as Buffer;
    const envelope0=JSON.parse(payload0.toString()) as UploadEnvelope;
    expect(envelope0.contract).toEqual({major:1,minor:0});
    expect(envelope0.snapshot).not.toHaveProperty('hardModeResult');
    
    // 3. Queued minor 0 envelope is claimed and retryable without payload mutation
    const attempt=ok(storage0.claimUploadAttempt({attemptId:randomUUID(),registrationId:source0.registrationId,expectedVersion:'1',mode:'any',nowMs:1002}));
    expect(attempt.status).toBe('claimed');
    expect(attempt.payload).toEqual(new Uint8Array(payload0));
    const claimedEnvelope=JSON.parse(Buffer.from(attempt.payload!).toString()) as UploadEnvelope;
    expect(claimedEnvelope.contract).toEqual({major:1,minor:0});
    expect(claimedEnvelope.snapshot).not.toHaveProperty('hardModeResult');
  } finally {
    storage0.close();
    await ws0.dispose();
  }
});
// ET-112c: an engine-1 root's frozen upload keeps its bytes. The retroactive join of a later segment revises the root, so
// it is the next material change, and the upload materialized after it carries the spliced head's accounting state. A
// drives 40 m on 20 ml and stops; B's first reading is its junction, then B drives 20 m on 10 ml: 60 m either way.
it.each([['a forward gap',1_000_100,true],['the same save point',1_000_040,false]] as const)('REG-005/010 engine 1 shows a retroactive splice at %s in the next upload',async(_name,odometer,unavailable)=>{
  const conn=await openConnection(ws.options({purpose:'history'})),storage=new Storage(conn);opened.push(storage);const source=await setup(storage),db=conn.writer(),b=new Script(ETS2_B),second=tripUuidFor(ETS2_B,'1');
  const absent={available:false,reason:'not-observed'} as const;
  const point=(s:Script,uuid:string,at:number,odo:number,fuel:number,speed:number,withProof:boolean):SampleInput=>({tripUuid:uuid,utcMs:1000+at*1000,sourceClockId:s.clockId,
    monotonicNs:String(BigInt(at)*1_000_000_000n),gameTime:{minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},speed:{available:true,value:speed},
    fuel:{available:true,value:fuel},averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,position:{available:true,value:{x:odo-1_000_000,y:0,z:0}},
    odometer:{available:true,value:odo},recording:{...(withProof?{profile:proof(s)}:{}),job:job(),truck:'verified-truck',processInstanceId:s.welcome().source.processInstanceId,
      ...(at>1?{previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:String(BigInt(at-1)*1_000_000_000n)}}:{})}});
  const payload=(id:string|null)=>db.prepare('SELECT payload FROM upload_envelopes WHERE event_id=?').pluck().get(id) as Uint8Array;
  const wire=(id:string|null)=>JSON.parse(Buffer.from(payload(id)).toString()) as UploadEnvelope;
  ok(storage.appendSamples(source.s.session,[point(source.s,source.tripUuid,1,1_000_000,100,20,true),point(source.s,source.tripUuid,2,1_000_020,99.99,20,true),
    point(source.s,source.tripUuid,3,1_000_040,99.98,0,true)],{uniqueSeconds:true}));
  ok(storage.commitEvent({message:game(source.s.event(r.timersRestart())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'none',closeReason:'restart',recordingCompleteness:'partial',endedUtcMs:2000}]}));
  let workId=await complete(storage,source);const before=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:2000}));expect(before.status).toBe('frozen');
  ok(storage.releaseUploadMaterialization({workId}));const bytes=new Uint8Array(payload(before.eventId));
  expect(wire(before.eventId).snapshot.evidence.reasons).not.toContain('accounting-unavailable');
  ok(storage.upsertSession({message:game(b.welcome())}));
  ok(storage.commitEvent({message:game(b.event(r.jobConfigured())),effects:[{kind:'trip.open',tripUuid:second,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:3000}]}));
  ok(storage.appendSamples(b.session,[point(b,second,1,odometer,99.98,0,false),point(b,second,2,odometer+20,99.97,20,false)],{uniqueSeconds:true}));
  ok(storage.commitEvent({message:game(b.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:second,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'partial',endedUtcMs:4000}]}));
  expect(ok(storage.resolvePendingMemberships({pluginSessionId:b.session,nextEventSeq:b.next.toString(),profile:{...proof(b),afterMonotonicNs:'3000000000'},sourceClockId:b.clockId,
    monotonicNs:'3000000000'}))).toEqual({status:'resolved',resolved:1,remaining:0});
  workId=await complete(storage,source);const after=ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:5000}));expect(after.status).toBe('frozen');
  expect(new Uint8Array(payload(before.eventId))).toEqual(bytes);
  const snapshot=wire(after.eventId).snapshot;
  expect(snapshot.observedDistance).toEqual({available:true,value:60,unit:'m'});
  expect(snapshot.evidence.reasons.includes('accounting-unavailable')).toBe(unavailable);
});
