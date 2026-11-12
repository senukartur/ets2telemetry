import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {Storage,MIGRATIONS,type SampleInput} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {attachTripUuidFor} from '../../packages/telemetry-core/src';
import {unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {job,r,Script} from '../shared/trip-messages';
import {failed,ok,uploadGame,uploadProof,uploadTestSource,uploadTestOwner,workspace} from './helpers';
let ws:Awaited<ReturnType<typeof workspace>>,opened:Storage[]=[];
beforeEach(async()=>{ws=await workspace();});afterEach(async()=>{for(const storage of opened)storage.close();opened=[];await ws.dispose();});
async function direct(accountingEngine?:0){const conn=await openConnection(ws.options({purpose:'history',...(accountingEngine===undefined?{}:{accountingEngine})})),storage=new Storage(conn);opened.push(storage);return {conn,storage,db:conn.writer()};}
describe('REG-003/004/005/006/007/008/009/012/014 same-commit discovery',()=>{
  it('captures every recorder entry point atomically, coalesces ordinary counters and retains terminal/correction/uncertainty references under pressure',async()=>{
    // The counters and the correction come from trip.update totals, the raw-total selection of legacy engine 0 (ET-112c, D14).
    const {storage,db}=await direct(0),source=await uploadTestSource(storage),{script,tripUuid}=source;
    const head=()=>db.prepare('SELECT revision_ref,material_version,position FROM upload_change_heads').get() as {revision_ref:bigint;material_version:bigint;position:bigint};
    const initial=head();ok(storage.commitEvent({message:uploadGame(script.event(r.trailerConfigured())),effects:[{kind:'trip.update',tripUuid,set:{trailerConfigurations:['this-event']}}]}));expect(head().material_version).toBeGreaterThan(initial.material_version);expect(db.prepare('SELECT registration_ref FROM upload_reservations').pluck().get()).toBe(source.registrationId);
    ok(storage.commitGap({message:uploadGame(script.gap(1)),effects:[{kind:'completeness.add',interval:{tripUuid,kind:'event-loss'}}]}));expect(head().material_version).toBeGreaterThan(initial.material_version);
    const afterGap=head();ok(storage.recordCompleteness(script.session,{tripUuid,kind:'sample-loss'}));expect(head().material_version).toBeGreaterThan(afterGap.material_version);
    const beforeObserve=head();ok(storage.openAttachedTrip({pluginSessionId:script.session,nextEventSeq:String(script.next),job:job(),effects:[],observeTripUuid:tripUuid,profile:uploadProof(script),sourceClockId:script.clockId,monotonicNs:'9000000000'}));expect(head().position).toBeGreaterThan(beforeObserve.position);
    const absent={available:false,reason:'not-observed'} as const;
    const row:SampleInput={tripUuid,utcMs:10000,sourceClockId:script.clockId,monotonicNs:'10000000000',gameTime:null,speed:absent,fuel:absent,averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,odometer:absent,position:absent,recording:{profile:uploadProof(script),job:job(),truck:null,processInstanceId:script.welcome().source.processInstanceId}};
    const beforeSamples=head();ok(storage.appendSamples(script.session,[row]));expect(head().position).toBeGreaterThan(beforeSamples.position);
    const beforeHardMode=head();ok(storage.observeHardMode('ets2',{assessment:unknownHardMode(10000,'historical'),binding:'b'.repeat(64),pluginSessionId:script.session,sourceMonotonicNs:'10000000000'}));expect(head().position).toBeGreaterThan(beforeHardMode.position);
    ok(storage.commitEvent({message:uploadGame(script.event(r.paused())),effects:[{kind:'trip.update',tripUuid,set:{observedDistanceM:{available:true,value:1},fuelUsedL:{available:true,value:1}}}]}));const available=head();
    const transitions=Number(db.prepare('SELECT count(*) FROM upload_source_transitions').pluck().get());
    for(let i=2;i<=20;i++)ok(storage.commitEvent({message:uploadGame(script.event(r.paused())),effects:[{kind:'trip.update',tripUuid,set:{observedDistanceM:{available:true,value:i},fuelUsedL:{available:true,value:i}}}]}));
    expect(head().material_version).toBe(available.material_version);expect(Number(db.prepare('SELECT count(*) FROM upload_source_transitions').pluck().get())).toBe(transitions);expect(head().position).toBeGreaterThan(available.position);
    db.prepare('UPDATE upload_queue_usage SET blocked=1').run();
    ok(storage.commitEvent({message:uploadGame(script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'partial',endedUtcMs:20000}]}));
    ok(storage.commitEvent({message:uploadGame(script.event(r.paused())),effects:[{kind:'trip.update',tripUuid,set:{observedDistanceM:{available:true,value:99}}}]}));
    expect(db.prepare("SELECT kind FROM upload_source_transitions WHERE kind IN ('terminal','correction') ORDER BY position").pluck().all()).toEqual(['terminal','correction']);
    expect(db.prepare('SELECT count(*) FROM upload_source_transitions t LEFT JOIN logical_revisions r ON r.id=t.revision_ref WHERE r.id IS NULL').pluck().get()).toBe(0n);
    const before=head(),bad=uploadGame(script.event(r.paused()));failed(storage.commitEvent({message:bad,effects:[{kind:'trip.update',tripUuid,set:{observedDistanceM:{available:true,value:123}}}]},{testHooks:{beforeCommit:()=>{throw Error('rollback');}}}),'INTERNAL');expect(head()).toEqual(before);
  });
  it('persists hand-derived scan cursor milestones, overlaps live discovery and examines rejected owners before filtering',async()=>{
    const old=await ws.open({purpose:'history',migrations:MIGRATIONS.slice(0,5)}),s=new Script('10000000-0000-4000-8000-000000000001');ok(old.upsertSession({message:uploadGame(s.welcome())}));
    for(let i=1;i<=151;i++){const tripUuid=`70000000-0000-4000-8000-${String(i).padStart(12,'0')}`;ok(old.commitEvent({message:uploadGame(s.event(r.jobConfigured())),effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));ok(old.commitEvent({message:uploadGame(s.event(r.delivered())),effects:[{kind:'trip.close',tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));}old.close();
    let {storage}=await direct();const a=await uploadTestOwner(storage);ok(storage.confirmUploadOwner({confirmationId:a.runId,registrationId:a.registrationId,credentialGeneration:'a',expectedVersion:'0'}));
    const b={...a,registrationId:randomUUID(),runId:randomUUID()};const installation=ok(storage.ensureUploadInstallation());ok(storage.recordUploadRegistration({registrationId:b.registrationId,clientInstallationId:installation.clientInstallationId!,origin:'https://dashboard.example',accountId:'B',companyId:'company',identityEpoch:'epoch',installationId:randomUUID(),bindingId:randomUUID()}));ok(storage.confirmUploadOwner({confirmationId:b.runId,registrationId:b.registrationId,credentialGeneration:'b',expectedVersion:'1'}));
    let scan=ok(storage.advanceUploadScan({runId:a.runId,registrationId:a.registrationId}));expect(scan).toMatchObject({phase:'legacy',examined:100,cursor:{legacy:'100',ordinal:'0'}});
    storage.close();const reopened=await direct();storage=reopened.storage;const db=reopened.db;scan=ok(storage.advanceUploadScan({runId:a.runId,registrationId:a.registrationId}));expect(scan).toMatchObject({phase:'candidates',examined:100,cursor:{legacy:'151',ordinal:'48'}});
    scan=ok(storage.advanceUploadScan({runId:a.runId,registrationId:a.registrationId}));expect(scan).toMatchObject({phase:'candidates',examined:100,cursor:{legacy:'151',ordinal:'148'}});
    scan=ok(storage.advanceUploadScan({runId:a.runId,registrationId:a.registrationId}));expect(scan).toMatchObject({phase:'complete',examined:4,cursor:{legacy:'151',ordinal:'151'}});
    const rejected=ok(storage.pageUploadDiscovery({registrationId:b.registrationId,after:'0',limit:100}));expect(rejected.items).toEqual([]);expect(rejected.examined).toBe(100);expect(rejected.next).toBe('100');expect(ok(storage.getUploadStoreStatus({registrationId:b.registrationId})).discoveryAfter).toBe('100');failed(storage.pageUploadDiscovery({registrationId:b.registrationId,after:'101',limit:100}),'INVALID_INPUT');
    const owned=ok(storage.pageUploadDiscovery({registrationId:a.registrationId,after:'0',limit:100}));expect(owned.items).toHaveLength(100);expect(new Set(owned.items.map(x=>x.tripUuid)).size).toBe(100);
    for(const [sql,args] of [["SELECT id FROM trips WHERE id>? AND id<=? ORDER BY id LIMIT 100",[0,151]],["SELECT * FROM upload_candidates WHERE ordinal>? AND ordinal<=? ORDER BY ordinal LIMIT 100",[0,151]],["SELECT * FROM upload_source_transitions WHERE position>? ORDER BY position LIMIT 100",[0]],["SELECT * FROM upload_history_claims WHERE first_ordinal<=? ORDER BY first_ordinal DESC LIMIT 1",[100]],["SELECT root_ref FROM upload_source_bindings WHERE registration_ref=? AND pending=1 AND held=0 ORDER BY root_ref LIMIT 100",[a.registrationId]],["SELECT work_id FROM upload_materializations WHERE registration_ref=? AND pin_released=0 ORDER BY work_id LIMIT 100",[a.registrationId]],["SELECT * FROM upload_envelopes WHERE registration_ref=? AND state='queued' AND mode=? AND retry_at<=? ORDER BY retry_at,event_id LIMIT 1",[a.registrationId,'live',1000]] ] as [string,unknown[]][]){
      const plan=(db.prepare('EXPLAIN QUERY PLAN '+sql).all(...args) as {detail:string}[]).map(x=>x.detail).join(';');expect(plan).toMatch(/SEARCH/);expect(plan).not.toMatch(/SCAN|TEMP B-TREE/);
    }
    expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId})).pendingSources).toBe(151);expect(ok(storage.getUploadStoreStatus({registrationId:a.registrationId})).discoveryAfter).toBe('0');expect(db.pragma('foreign_key_check')).toEqual([]);storage.close();const resumed=await direct();expect(ok(resumed.storage.getUploadStoreStatus({registrationId:a.registrationId})).discoveryAfter).toBe('0');
  });
});

it('REG-003/006/008 discovers checkpoint attachment in its source transaction and rolls back a failed attachment completely',async()=>{
  const {storage,db}=await direct(),owner=await uploadTestOwner(storage);ok(storage.confirmUploadOwner({confirmationId:owner.runId,registrationId:owner.registrationId,credentialGeneration:'a',expectedVersion:'0'}));
  const script=new Script('10000000-0000-4000-8000-000000000099');ok(storage.upsertSession({message:uploadGame(script.welcome())}));const tripUuid=attachTripUuidFor(script.session,'1');
  const input:Parameters<Storage['openAttachedTrip']>[0]={pluginSessionId:script.session,nextEventSeq:'1',job:job(),profile:uploadProof(script),sourceClockId:script.clockId,monotonicNs:'1000000000',effects:[{kind:'trip.open',tripUuid,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000},{kind:'completeness.add',interval:{tripUuid,kind:'not-connected'}}]};
  failed(storage.openAttachedTrip(input,{testHooks:{beforeCommit:()=>{throw Error('rollback');}}}),'INTERNAL');
  for(const table of ['trips','job_configurations','upload_candidates','upload_reservations','upload_source_bindings','upload_change_heads'])expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0n);
  ok(storage.openAttachedTrip(input));expect(db.prepare('SELECT opened_by FROM trips').pluck().get()).toBe('checkpoint');expect(db.prepare('SELECT registration_ref FROM upload_source_bindings').pluck().get()).toBe(owner.registrationId);expect(db.prepare('SELECT count(*) FROM upload_change_heads').pluck().get()).toBe(1n);expect(db.pragma('foreign_key_check')).toEqual([]);
});
