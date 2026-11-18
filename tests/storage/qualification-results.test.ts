import path from 'node:path';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {MIGRATIONS, openStorage, restoreBackup, type Migration} from '../../packages/storage/src';
import {digestOf, failed, ok, readOnly, sha256, workspace, uploadTestSource, uploadTestOwner, uploadProof, uploadTestWork, uploadGame,uploadReceipt, TEST_CLOSE_GRACE_MS} from './helpers';
import {StorageClient} from '../../packages/storage/src/client';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import type {QualificationWire} from '../../packages/contracts/src/qualification';
import {QUALIFICATION_DETAIL_BYTES} from '../../packages/contracts/src/qualification';
import {validateJournalTripDetail,validateJournalTripPage} from '../../packages/contracts/src/journal';
import {TripExportSerializer,tripExportHeader} from '../../apps/desktop/src/journal-export';
import {storageWorker, terminateWorkers} from './recording-helpers';
import {r,job,Script,ETS2_A,ETS2_B,run,sessionInput} from '../shared/trip-messages';
import {canonicalJson,initialTripState,jobKey,tripUuidFor} from '../../packages/telemetry-core/src';
import {QualificationPreviewFacts,type QualificationLive} from '../../apps/desktop/src/qualification/preview-facts';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await terminateWorkers();await ws.dispose();});
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
const scope='a'.repeat(43);

describe('qualification schema 11 (REG-013/014)', () => {
  it('adds empty companion tables to the frozen schema10 fixture without changing existing rows', async () => {
    const file = ws.copyFixture('schema-v10-representative.sqlite');
    const prior = readOnly(file, db => {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' ORDER BY name").pluck().all() as string[];
      return tables.map(name => ({name, rows: db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()}));
    });
    const storage = await ws.open({path: file});
    expect(storage.summary).toMatchObject({schemaVersion: 11, migratedFrom: 10});
    const backup = storage.summary.backupFileName!;
    storage.close();
    readOnly(file, db => {
      for (const {name, rows} of prior) expect(db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all(), name).toEqual(rows);
      for (const name of ['qualification_cache', 'qualification_result_versions', 'qualification_result_heads', 'qualification_refresh_state']) {
        expect(db.prepare(`SELECT count(*) FROM ${name}`).pluck().get()).toBe(0);
      }
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', {simple: true})).toBe('ok');
    });
    expect(digestOf(path.join(ws.backups, backup))).toEqual(digestOf(path.join('tests/fixtures/storage/schema-v10-representative.sqlite')));
    const restored = ok(await restoreBackup(path.join(ws.backups, backup.replace(/\.sqlite$/, '.json')), ws.options({path: path.join(ws.directory, 'restored.sqlite')})));
    expect(restored.summary.schemaVersion).toBe(11);
    restored.close();
  });
  it('rolls the entire migration back on failure and refuses schema11 in the prior build', async () => {
    const file = ws.copyFixture('schema-v10-representative.sqlite'), before = digestOf(file);
    const failure: Migration = {version: 12, name: '0012-test-failure', up: () => {throw Error('injected');}};
    failed(await openStorage(ws.options({path: file, migrations: [...MIGRATIONS, failure]})), 'MIGRATION_FAILED');
    expect(digestOf(file)).toEqual(before);
    (await ws.open({path: file})).close();
    const hash = sha256(file);
    failed(await openStorage(ws.options({path: file, migrations: MIGRATIONS.slice(0, 10)})), 'SCHEMA_NEWER');
    expect(sha256(file)).toBe(hash);
  });
});

describe('native job identity through preview and SQLite (REG-003/008/010)',()=>{
  it('accepts sorted native keys and cargo-market pickup on the same recorded trip, while rejecting changed evidence',async()=>{
    const client=new StorageClient(storageWorker().handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const owner=await uploadTestOwner(client);ok(await client.confirmUploadOwner({confirmationId:owner.runId,registrationId:owner.registrationId,credentialGeneration:'generation',expectedVersion:'0'}));
    const script=new Script(ETS2_A),welcome=uploadGame(script.welcome()),offered=job({market:{available:true,value:'cargo_market'},cargoLoaded:{available:true,value:false}}),tripUuid=tripUuidFor(script.session,'1');
    let state=run(initialTripState(),[sessionInput(welcome)]).state;ok(await client.upsertSession({message:welcome}));
    const opening=uploadGame(script.event(r.jobConfigured(offered))),opened=run(state,[opening]);state=opened.state;
    ok(await client.commitEvent({message:opening,effects:opened.effects[0],profile:uploadProof(script)}));
    await uploadTestWork(client,{registrationId:owner.registrationId,tripUuid});
    const authority={registrationId:owner.registrationId,connectionVersion:'1'};ok(await client.setQualificationScope({...authority,securityScope:scope}));
    const native=(configuration:ReturnType<typeof job>):QualificationLive=>{const message=uploadGame(script.checkpoint(configuration));return JSON.parse(canonicalJson({source:message.source,capture:message.capture,state:message.data.state})) as QualificationLive;};
    const live=native(offered),facts=new QualificationPreviewFacts(client,authority);
    try{
      const persisted=ok(await client.journalTrip(tripUuid)).job.values;
      expect(JSON.stringify(persisted)).not.toBe(JSON.stringify(live.state.configuration.job.available?live.state.configuration.job.value:null));expect(jobKey(persisted)).toBe(jobKey(offered));
      facts.observe(live);const first=await facts.read();expect(first).not.toBeNull();expect(first!.cargoMassKg.value).toBe(String(offered.cargoMass.available?offered.cargoMass.value:null));
      const loaded=job({...offered,cargoLoaded:{available:true,value:true}}),pickup=uploadGame(script.event(r.jobConfigured(loaded))),picked=run(state,[pickup]);state=picked.state;
      expect(picked.effects[0].some(effect=>effect.kind==='trip.open'||effect.kind==='trip.close')).toBe(false);ok(await client.commitEvent({message:pickup,effects:picked.effects[0],profile:uploadProof(script)}));
      const pickupLive=native(loaded);facts.observe(pickupLive);expect(facts.current).toBeNull();const afterPickup=await facts.read();expect(afterPickup).not.toBeNull();expect(afterPickup!.contextRevision).toBeGreaterThan(first!.contextRevision);
      expect(ok(await client.journalTrips({})).trips.map(trip=>trip.tripUuid)).toEqual([tripUuid]);expect(ok(await client.journalTrip(tripUuid)).job.values.cargoLoaded).toEqual({available:true,value:false});
      for(const mutation of [job({...loaded,cargoId:{available:true,value:'other-cargo'}}),job({...loaded,cargoMass:{available:true,value:19001,unit:'kg'}}),job({...loaded,destinationCompanyId:{available:true,value:'other-company'}})]){
        facts.observe(native(mutation));expect(facts.current).toBeNull();expect(await facts.read()).toBeNull();facts.observe(pickupLive);const restored=await facts.read();expect(restored).not.toBeNull();expect(restored!.contextRevision).toBeGreaterThan(afterPickup!.contextRevision);
      }
      const foreign=structuredClone(pickupLive);foreign.source.pluginSessionId=ETS2_B;facts.observe(foreign);expect(await facts.read()).toBeNull();facts.observe(pickupLive);expect(await facts.read()).not.toBeNull();
    }finally{await facts.close();await client.close();}
  });
});

describe('exact batch coverage (REG-008/010/012)',()=>{
  it('rejects duplicate, missing and extra responses atomically for distinct sources, including idempotent and unchanged duplicates',async()=>{
    const storage=await ws.open({purpose:'history'}),first=await uploadTestSource(storage),secondScript=new Script(ETS2_B),secondTrip=tripUuidFor(secondScript.session,'1');
    ok(storage.commitEvent({message:uploadGame(first.script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:first.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',endedUtcMs:3000,recordingCompleteness:'complete'}]}));
    ok(storage.upsertSession({message:uploadGame(secondScript.welcome())}));ok(storage.commitEvent({message:uploadGame(secondScript.event(r.jobConfigured())),profile:uploadProof(secondScript),effects:[{kind:'trip.open',tripUuid:secondTrip,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    ok(storage.commitEvent({message:uploadGame(secondScript.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:secondTrip,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',endedUtcMs:3000,recordingCompleteness:'complete'}]}));
    for(const tripUuid of [first.tripUuid,secondTrip]){const workId=await uploadTestWork(storage,{registrationId:first.registrationId,tripUuid});ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:4000}));}
    const authority={registrationId:first.registrationId,connectionVersion:'1',securityScope:scope};ok(storage.setQualificationScope(authority));const locals=ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items;expect(locals).toHaveLength(2);
    const template=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
    const results=locals.map((local,index)=>{const result=structuredClone(template);Object.assign(result,{source:local.request.source,requestedRevision:local.request.revision,requestedEventId:local.request.eventId,resultRevision:'1',version:`source-${index}`});Object.assign(result.assessment!,{assessedSource:result.source,sourceRevision:result.requestedRevision,sourceEventId:result.requestedEventId,sourceMessageId:result.requestedSourceMessageId});return result;});
    const request={requestId:randomUUID(),items:locals.map(item=>item.request)},input={...authority,expectedHeads:locals.map(item=>({eventId:item.request.eventId,generation:item.generation})),request,batch:{contract:'1.0' as const,securityScope:scope,requestId:request.requestId,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,items:results},fetchedUtcMs:5000};
    for(const items of [[results[0],results[0]],[results[0]],[...results,results[1]],[results[0],{...results[1],requestedEventId:randomUUID()}]]){
      failed(storage.commitQualificationResults({...input,batch:{...input.batch,items}}),'INVALID_INPUT');expect(ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items).toEqual(locals);
    }
    expect(ok(storage.commitQualificationResults({...input,batch:{...input.batch,items:[results[1],results[0]]}})).saved).toBe(2);
    const saved=ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items,current={...input,request:{...request,items:saved.map(item=>item.request)},expectedHeads:saved.map(item=>({eventId:item.request.eventId,generation:item.generation}))};
    const changed={...results[0],version:'changed-a',resultRevision:'2',assessment:{...results[0].assessment!,decisionId:randomUUID()}},unchanged={...results[0],unchanged:true,assessment:null,credit:null};
    for(const items of [[results[0],results[0]],[changed,changed],[unchanged,unchanged],[changed,unchanged]]){
      failed(storage.commitQualificationResults({...current,batch:{...current.batch,items}}),'INVALID_INPUT');expect(ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items).toEqual(saved);
    }
    expect(ok(storage.commitQualificationResults({...current,batch:{...current.batch,items:[{...results[1],version:'counter-b',resultRevision:'2'},{...results[0],version:'counter-a',resultRevision:'2'}]}})).saved).toBe(2);
    storage.close();readOnly(ws.database,db=>{expect(db.prepare('SELECT count(*) FROM qualification_result_versions').pluck().get()).toBe(2);expect(db.prepare('SELECT count(*) FROM qualification_result_heads').pluck().get()).toBe(4);expect(db.pragma('foreign_key_check')).toEqual([]);});
  });
});

describe('complete maximum qualification snapshots (REG-008/012/014)',()=>{
  it('keeps both full explanations in details while a fifty-row list remains compact and rejects detail/list shape substitution',async()=>{
    const client=new StorageClient(storageWorker().handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const source=await uploadTestSource(client);ok(await client.commitEvent({message:uploadGame(source.script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',endedUtcMs:3000,recordingCompleteness:'complete'}]}));
    const workId=await uploadTestWork(client,source);ok(await client.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:4000}));
    const authority={registrationId:source.registrationId,connectionVersion:'1',securityScope:scope};ok(await client.setQualificationScope(authority));
    const page=ok(await client.pageQualificationSources({...authority,afterEvent:null,limit:25})),local=page.items[0];
    const maximum=fixtures.find(f=>(f as {name?:string}).name==='single-result-maximum-arrays-and-json-escaping')!;
    const result=structuredClone((maximum.value as QualificationWire['ResultBatch']).items[0]);Object.assign(result,{source:local.request.source,requestedRevision:local.request.revision,requestedEventId:local.request.eventId,resultRevision:'100',version:'maximum-a'});
    Object.assign(result.assessment!,{assessedSource:result.source,sourceRevision:result.requestedRevision,sourceEventId:result.requestedEventId,sourceMessageId:result.requestedSourceMessageId});
    const request={requestId:randomUUID(),items:[local.request]},input={...authority,expectedHeads:[{eventId:local.request.eventId,generation:local.generation}],request,batch:{contract:'1.0' as const,securityScope:scope,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,requestId:request.requestId,items:[result]},fetchedUtcMs:5000};
    expect(ok(await client.commitQualificationResults(input)).saved).toBe(1);
    const attempt=ok(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:6000}));ok(await client.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:uploadReceipt(result.requestedEventId)}));
    const next=ok(await client.pageQualificationSources({...authority,afterEvent:null,limit:25})).items[0],second=structuredClone(input);second.request.items=[next.request];second.expectedHeads=[{eventId:next.request.eventId,generation:next.generation}];Object.assign(second.batch.items[0],{version:'maximum-b',resultRevision:'101'});second.batch.items[0].assessment!.decisionId=randomUUID();
    expect(ok(await client.commitQualificationResults(second)).saved).toBe(1);
    const detail=validateJournalTripDetail(ok(await client.journalTrip(source.tripUuid))),saved=detail.qualification!.row.qualification!;
    expect(saved.current!.assessment!.trailerComparison).toEqual(second.batch.items[0].assessment!.trailerComparison);expect(saved.previous!.assessment!.trailerComparison).toEqual(result.assessment!.trailerComparison);
    for(const snapshot of [saved.current!,saved.previous!]){expect(snapshot.assessment!.trailerComparison!.entries).toHaveLength(1010);expect(snapshot.assessment!.trailerDisplay).toHaveLength(110);}
    const detailBytes=Buffer.byteLength(JSON.stringify(detail.qualification));expect(detailBytes).toBeGreaterThan(1_048_576);expect(detailBytes).toBeLessThan(QUALIFICATION_DETAIL_BYTES);
    const header=tripExportHeader({uuid:randomUUID(),purpose:'history',schemaVersion:11},'test',5000),plain={...detail};delete plain.qualification;
    expect(new TripExportSerializer(detail,header).begin()).toBe(new TripExportSerializer(plain,header).begin());
    const list=validateJournalTripPage(ok(await client.journalTrips({}))),summary=list.sync!.rows[0].qualification!;expect(summary.current).toEqual({availability:result.assessment!.availability,outcome:result.assessment!.outcome});expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThan(1024);
    const repeated=structuredClone(list);repeated.trips=Array.from({length:50},()=>({...list.trips[0],tripUuid:randomUUID()}));repeated.sync!.rows=repeated.trips.map(trip=>({...list.sync!.rows[0],tripUuid:trip.tripUuid}));repeated.nextCursor='50';validateJournalTripPage(repeated);expect(Buffer.byteLength(JSON.stringify(repeated.sync!.rows.map(row=>row.qualification)))).toBeLessThan(50*1024);
    const wrongList=structuredClone(list);Object.assign(wrongList.sync!.rows[0],{qualification:saved});expect(()=>validateJournalTripPage(wrongList)).toThrow();
    const wrongDetail=structuredClone(detail);Object.assign(wrongDetail.qualification!.row,{qualification:summary});expect(()=>validateJournalTripDetail(wrongDetail)).toThrow();
    const changedMap=structuredClone(second),current=ok(await client.pageQualificationSources({...authority,afterEvent:null,limit:25})).items[0];changedMap.request.items=[current.request];changedMap.expectedHeads=[{eventId:current.request.eventId,generation:current.generation}];changedMap.batch.items[0].version='mapping-must-not-change';changedMap.batch.items[0].assessment!.trailerComparison!.entries[0].comparisonIdentity='undefined';
    failed(await client.commitQualificationResults(changedMap),'INVALID_INPUT');
    await client.close();const reopened=await ws.open({purpose:'history'});expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.current!.assessment!.trailerComparison).toEqual(result.assessment!.trailerComparison);reopened.close();
  });
});

for(const worker of [false,true]) describe(`qualification immutable results ${worker?'worker':'writer'} (REG-005/008/012/014)`,()=>{
  it('accepts only exact frozen local sources, survives restart, and never fabricates a receipt',async()=>{
    const client=worker?new StorageClient(storageWorker().handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}):await ws.open({purpose:'history'});
    if(worker)ok(await (client as StorageClient).open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));
    const source=await uploadTestSource(client);
    ok(await client.commitEvent({message:uploadGame(source.script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',endedUtcMs:3000,recordingCompleteness:'complete'}]}));
    const workId=await uploadTestWork(client,source),frozen=ok(await client.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:4000}));
    const authority={registrationId:source.registrationId,connectionVersion:'1'};
    expect(ok(await client.setQualificationScope({...authority,securityScope:scope}))).toEqual({active:true});
    const page=ok(await client.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25}));
    expect(page.items).toHaveLength(1);expect(page.items[0].request.eventId).toBe(frozen.eventId);
    const request={requestId:randomUUID(),items:[page.items[0].request]};
    const template=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
    const result=structuredClone(template),identity=request.items[0];
    Object.assign(result,{source:identity.source,requestedEventId:identity.eventId,requestedRevision:identity.revision,resultRevision:'9007199254740993',version:'retained-1'});
    Object.assign(result.assessment!,{assessedSource:identity.source,sourceEventId:identity.eventId,sourceRevision:identity.revision,sourceMessageId:result.requestedSourceMessageId});
    const batch:QualificationWire['ResultBatch']={contract:'1.0',securityScope:scope,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,requestId:request.requestId,items:[result]};
    const input={...authority,securityScope:scope,expectedHeads:page.items.map(item=>({eventId:item.request.eventId,generation:item.generation})),request,batch,fetchedUtcMs:5000};
    const fence=async(target:typeof input,reader=client)=>{const current=ok(await reader.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items.find(item=>item.request.eventId===identity.eventId)!;
      target.expectedHeads=[{eventId:identity.eventId,generation:current.generation}];if(current.result)target.request.items[0].ifVersion=current.result.version;else delete target.request.items[0].ifVersion;};
    const noBase=structuredClone(input);noBase.request.items[0].ifVersion=result.version;Object.assign(noBase.batch.items[0],{unchanged:true,assessment:null,credit:null});
    expect(ok(await client.commitQualificationResults(noBase))).toEqual({saved:0,missingBase:[identity.eventId]});
    expect(ok(await client.commitQualificationResults(input))).toEqual({saved:1,missingBase:[]});
    expect(ok(await client.commitQualificationResults(noBase))).toEqual({saved:0,missingBase:[]});
    const falseUnchanged=structuredClone(noBase);falseUnchanged.batch.items[0].companyDecision='rejected';
    failed(await client.commitQualificationResults(falseUnchanged),'INVALID_INPUT');
    const refreshed=structuredClone(input);refreshed.batch.items[0].assessment!.trailerDisplay=[];
    expect(ok(await client.commitQualificationResults(refreshed))).toEqual({saved:0,missingBase:[]});
    const viewB=structuredClone(input);viewB.request.items[0].ifVersion=result.version;viewB.batch.items[0].version='catalog-view-b';
    viewB.batch.items[0].assessment!.trailerDisplay=[{id:randomUUID(),basis:'current_catalog',identityKind:'variant',classification:{state:'unavailable'},asOf:'2026-11-18T01:00:00.000Z',code:'flatbed',groupCode:null,nameEn:'Current label B',nameRu:null}];
    await fence(viewB);
    expect(ok(await client.commitQualificationResults(viewB))).toEqual({saved:1,missingBase:[]});
    expect(ok(await client.commitQualificationResults(viewB))).toEqual({saved:0,missingBase:[]});
    const sameViewLater=structuredClone(viewB);sameViewLater.batch.items[0].assessment!.trailerDisplay[0].asOf='2026-11-18T02:00:00.000Z';
    expect(ok(await client.commitQualificationResults(sameViewLater))).toEqual({saved:0,missingBase:[]});
    const falseView=structuredClone(viewB);falseView.batch.items[0].assessment!.trailerDisplay[0].nameEn='Contradictory same hash';
    failed(await client.commitQualificationResults(falseView),'INVALID_INPUT');
    const staleA=structuredClone(input);staleA.request.items[0].ifVersion=result.version;failed(await client.commitQualificationResults(staleA),'INVALID_INPUT');
    const returnA=structuredClone(input);returnA.request.items[0].ifVersion=viewB.batch.items[0].version;
    await fence(returnA);
    expect(ok(await client.commitQualificationResults(returnA))).toEqual({saved:1,missingBase:[]});
    expect(ok(await client.commitQualificationResults(returnA))).toEqual({saved:0,missingBase:[]});
    failed(await client.commitQualificationResults(viewB),'INVALID_INPUT');
    const falseRetainedView=structuredClone(viewB);falseRetainedView.batch.items[0].assessment!.trailerDisplay[0].nameEn='Changed retained view';
    await fence(falseRetainedView);
    failed(await client.commitQualificationResults(falseRetainedView),'INVALID_INPUT');
    for(const changed of ['policy','mapping','fact'] as const){
      const contradiction=structuredClone(viewB);
      if(changed==='policy')contradiction.batch.items[0].assessment!.limits!.massMaxKg='24001';
      else if(changed==='mapping')contradiction.batch.items[0].canonicalTripId=randomUUID();
      else contradiction.batch.items[0].assessment!.materialIdentity=randomUUID();
      failed(await client.commitQualificationResults(contradiction),'INVALID_INPUT');
    }
    const contradiction=structuredClone(input);contradiction.batch.items[0].assessment!.eventExempt=!result.assessment!.eventExempt;
    failed(await client.commitQualificationResults(contradiction),'INVALID_INPUT');
    const lower=structuredClone(input);lower.batch.items[0].resultRevision='9007199254740992';lower.batch.items[0].version='older';
    failed(await client.commitQualificationResults(lower),'INVALID_INPUT');
    const foreign=structuredClone(input);foreign.batch.items[0].source.tripId=randomUUID();
    failed(await client.commitQualificationResults(foreign),'INVALID_INPUT');
    await client.close();
    let reopened=await ws.open({purpose:'history'});
    const saved=ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0].result;
    expect(saved).toEqual(result);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification?.row.qualification?.current).toBeNull();
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification?.row.qualification?.previous).toBeNull();
    const attempt=ok(reopened.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:6000}));
    ok(reopened.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:202,body:uploadReceipt(identity.eventId)}));
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification?.row.qualification?.current).toEqual(result);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification?.row.qualification?.previous).toBeNull();
    const review=structuredClone(input);Object.assign(review.batch.items[0],{version:'review-2',resultRevision:'9007199254740994',state:'review',companyDecision:'pending_review',assessmentPending:true,assessmentBasis:'none',assessment:null,credit:null});
    await fence(review,reopened);
    expect(ok(reopened.commitQualificationResults(review)).saved).toBe(1);
    const reviewing=ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!;
    expect(reviewing.current).toBeNull();expect(reviewing.previous).toEqual(result);expect(reviewing.latest).toEqual({companyDecision:'pending_review',credit:null});expect(reviewing.awaiting).toBe(true);
    const companyOnly=structuredClone(input);Object.assign(companyOnly.batch.items[0],{version:'company-only',resultRevision:'9007199254740995',companyDecision:'rejected',credit:{credited:false,trips:0,actualDistanceM:'0',assignmentId:result.credit?.assignmentId??null}});await fence(companyOnly,reopened);
    expect(ok(reopened.commitQualificationResults(companyOnly)).saved).toBe(1);expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.previous).toBeNull();
    const merged=structuredClone(input);Object.assign(merged.batch.items[0],{version:'merge-3',resultRevision:'9007199254740996',assessmentBasis:'predecessor',companyDecision:'rejected'});
    merged.batch.items[0].assessment!.assessedSource={...identity.source,tripId:randomUUID()};
    await fence(merged,reopened);
    expect(ok(reopened.commitQualificationResults(merged)).saved).toBe(1);
    const mapped=ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!;
    expect(mapped.current).toBeNull();expect(mapped.previous).toEqual(merged.batch.items[0]);expect(mapped.latest!.companyDecision).toBe('rejected');
    const unmerged=structuredClone(input);Object.assign(unmerged.batch.items[0],{version:'unmerge-4',resultRevision:'9007199254740997'});
    await fence(unmerged,reopened);
    expect(ok(reopened.commitQualificationResults(unmerged)).saved).toBe(1);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.current).toEqual(unmerged.batch.items[0]);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.previous).toEqual(merged.batch.items[0]);
    let transport=structuredClone(unmerged.batch.items[0]);
    for(let index=0;index<40;index++){
      const counterOnly=structuredClone(unmerged);transport={...transport,version:`owner-counter-${index}`,resultRevision:(BigInt(transport.resultRevision)+1n).toString()};counterOnly.batch.items=[transport];await fence(counterOnly,reopened);
      expect(ok(reopened.commitQualificationResults(counterOnly)).saved).toBe(1);
    }
    reopened.close();reopened=await ws.open({purpose:'history'});
    expect(ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0].result).toEqual(transport);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.current).toEqual(transport);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.previous).toEqual(merged.batch.items[0]);
    const lateSource=ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0];
    ok(reopened.recordCompleteness(source.script.session,{tripUuid:source.tripUuid,kind:'discontinuity',startUtcMs:7000,endUtcMs:7000,detail:{cause:'qualification-correction'}}));
    const correction=ok(reopened.journalTrip(source.tripUuid)).qualification?.row.qualification;
    expect(correction?.current).toBeNull();expect(correction?.previous).toEqual(result);
    const correctionWork=await uploadTestWork(reopened,source);ok(reopened.freezeUploadMaterialization({workId:correctionWork,producerVersion:'test',createdUtcMs:8000}));
    const latestSource=ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0];expect(latestSource.request.revision).toBe(2);
    const currentInput=structuredClone(input);currentInput.request={requestId:randomUUID(),items:[latestSource.request]};currentInput.expectedHeads=[{eventId:latestSource.request.eventId,generation:latestSource.generation}];currentInput.batch.requestId=currentInput.request.requestId;
    const currentResult=currentInput.batch.items[0];Object.assign(currentResult,{source:latestSource.request.source,requestedEventId:latestSource.request.eventId,requestedRevision:2,requestedSourceMessageId:randomUUID(),resultRevision:(BigInt(transport.resultRevision)+1n).toString(),version:'new-material'});
    Object.assign(currentResult.assessment!,{assessedSource:currentResult.source,sourceEventId:currentResult.requestedEventId,sourceRevision:2,sourceMessageId:currentResult.requestedSourceMessageId,materialIdentity:randomUUID(),decisionId:randomUUID()});
    expect(ok(reopened.commitQualificationResults(currentInput)).saved).toBe(1);
    const correctionAttempt=ok(reopened.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:9000}));
    ok(reopened.commitUploadReceipt({attemptId:correctionAttempt.attemptId!,statusCode:202,body:uploadReceipt(currentResult.requestedEventId)}));
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.current).toEqual(currentResult);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.previous).toEqual(result);
    const late=structuredClone(input);late.request={requestId:randomUUID(),items:[lateSource.request]};late.expectedHeads=[{eventId:lateSource.request.eventId,generation:lateSource.generation}];late.batch.requestId=late.request.requestId;
    Object.assign(late.batch.items[0],{resultRevision:(BigInt(currentResult.resultRevision)+1n).toString(),version:'late-old-material'});late.batch.items[0].assessment!.decisionId=randomUUID();
    expect(ok(reopened.commitQualificationResults(late)).saved).toBe(1);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.current).toEqual(currentResult);
    expect(ok(reopened.journalTrip(source.tripUuid)).qualification!.row.qualification!.previous).toEqual(result);
    const atomic=structuredClone(currentInput),fresh=ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0];atomic.request.items=[fresh.request,lateSource.request];atomic.expectedHeads=[{eventId:fresh.request.eventId,generation:fresh.generation},...late.expectedHeads];
    atomic.batch.items=[{...currentResult,version:'must-rollback',resultRevision:(BigInt(late.batch.items[0].resultRevision)+1n).toString()},late.batch.items[0]];
    // Make the stale second item state-changing rather than an idempotent exact-current repeat.
    atomic.batch.items[1]={...atomic.batch.items[1],version:'stale-old-material',resultRevision:atomic.batch.items[0].resultRevision};
    failed(reopened.commitQualificationResults(atomic),'INVALID_INPUT');expect(ok(reopened.pageQualificationSources({...authority,securityScope:scope,afterEvent:null,limit:25})).items[0]).toEqual(fresh);
    ok(reopened.disconnectUploadOwner({expectedVersion:'1'}));expect(ok(reopened.journalTrip(source.tripUuid)).qualification).toBeUndefined();
    expect(ok(reopened.readQualificationCache(authority)).active).toBe(false);
    failed(reopened.deleteTrip(source.tripUuid),'STORAGE_BUSY');
    reopened.close();
    readOnly(ws.database,db=>{
      expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(2);
      // Five initial contents plus two genuinely new assessments; forty counter refreshes add none.
      expect(db.prepare('SELECT count(*) FROM qualification_result_versions').pluck().get()).toBe(7);
      expect(db.prepare('SELECT count(*) FROM qualification_result_heads').pluck().get()).toBe(3);expect(db.pragma('foreign_key_check')).toEqual([]);
      const rootPlan=db.prepare("EXPLAIN QUERY PLAN SELECT * FROM qualification_result_heads WHERE kind='root' AND registration_ref=? AND security_scope=? AND root_ref=?").all(source.registrationId,scope,1);
      expect(JSON.stringify(rootPlan)).toContain('qualification_root_head');
    });
    const foreignKeyProbe=await openConnection(ws.options({purpose:'history'}));try{
      expect(()=>foreignKeyProbe.writer().prepare("UPDATE qualification_result_heads SET latest_view_key=? WHERE kind='root'").run('f'.repeat(64))).toThrow(/FOREIGN KEY constraint failed/);
    }finally{foreignKeyProbe.close();}
  });
});
