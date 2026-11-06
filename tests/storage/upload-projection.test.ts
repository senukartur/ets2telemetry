// Hand-authored game-shaped streams in isolated temporary databases, never real game or performance evidence.
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient} from '../../packages/storage/src/client';
import type {SampleInput, TripEffect} from '../../packages/storage/src/api';
import {mapUploadProjection, UPLOAD_PAGE_KINDS, type UploadProjection, type UploadProjectionPage} from '../../packages/storage/src/upload-projection';
import {recheckUploadProjection} from '../../packages/storage/src/sqlite/upload-projection';
import {attachTripUuidFor, tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {ETS2_A, ETS2_B, job, r, Script, trailer} from '../shared/trip-messages';
import {failed, ok, readOnly, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
import {storageWorker, terminateWorkers} from './recording-helpers';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws=await workspace();});
afterEach(async () => {await terminateWorkers();await ws.dispose();});
const mode = {mode:'unknown',method:'none',confidence:'none'} as const;
const absent = {available:false,reason:'not-observed'} as const;
const gameShaped = <T extends {source:{origin:string}}>(message:T):T => ({...message,source:{...message.source,origin:'game'}});
function proof(s:Script):ProfileObservation {const source=s.welcome().source;return {version:1,scope:'a'.repeat(64),binding:'b'.repeat(64),game:source.game,
  pluginSessionId:source.pluginSessionId,processInstanceId:source.processInstanceId,sourceClockId:s.clockId,afterMonotonicNs:'0',loadGeneration:1};}
async function start(purpose:'history'|'synthetic'|'replay'='history') {
  const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
  ok(await client.open({path:ws.database,purpose,backupsDirectory:ws.backups,appVersion:'0.1.0-test'}));return client;
}
async function open(client:StorageClient,s:Script,verified=true,seq=1) {
  ok(await client.upsertSession({message:gameShaped(s.welcome())}));
  if(seq>1)ok(await client.commitGap({message:gameShaped(s.gap(seq-1))}));
  const message=gameShaped(s.event(r.jobConfigured())),uuid=tripUuidFor(s.session,message.data.eventSeq);
  const effects:TripEffect[]=[{kind:'trip.open',tripUuid:uuid,game:s.game,gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000},
    {kind:'event.attribute',tripUuid:uuid,attribution:'trip'}];
  ok(await client.commitEvent({message,effects,...(verified?{profile:proof(s)}:{})}));return uuid;
}
async function observe(client:StorageClient,s:Script,uuid:string,values=job()) {
  ok(await client.openAttachedTrip({pluginSessionId:s.session,nextEventSeq:String(s.next),job:values,effects:[],observeTripUuid:uuid,
    profile:proof(s),sourceClockId:s.clockId,monotonicNs:'999999999999999'}));
}
async function close(client:StorageClient,s:Script,uuid:string,outcome:'none'|'delivered'|'cancelled'='none') {
  const message=gameShaped(s.event(outcome==='delivered'?r.delivered():outcome==='cancelled'?r.cancelled():r.timersRestart()));
  ok(await client.commitEvent({message,effects:[{kind:'trip.close',tripUuid:uuid,outcome,closeReason:outcome==='none'?'restart':'outcome',
    ...(outcome==='none'?{}:{outcomeEvent:'this-event' as const}),recordingCompleteness:'partial',endedUtcMs:2000},
    {kind:'event.attribute',tripUuid:uuid,attribution:'trip'}]}));
}
async function pages(client:StorageClient,pin:UploadProjection,limit=7) {
  const result:UploadProjectionPage[]=[];
  for(const kind of UPLOAD_PAGE_KINDS){let cursor:string|undefined;
    do{const page=ok(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind,cursor,limit}));result.push(page);cursor=page.nextCursor??undefined;}while(cursor);
  }return result;
}
function recheck(pin:UploadProjection) {return readOnly(ws.database,db=>{db.defaultSafeIntegers(true);return recheckUploadProjection(db,pin);});}

describe('immutable private upload projections through the SQLite worker', () => {
  it('waits for committed proof, redirects an abandoned singleton, retains original anchors and session-qualified terminal references', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,true,1200);
    expect(ok(await client.pinUploadProjection(root)).readiness).toBe('ready');
    await close(client,a,root);const resumable=ok(await client.pinUploadProjection(root));
    const rootPages=await pages(client,resumable);
    expect(resumable.facts).toMatchObject({outcome:'open',closeReason:null,opening:{eventSeq:'1200',pluginSessionId:ETS2_A}});
    const b=new Script(ETS2_B),child=await open(client,b,false),pending=ok(await client.pinUploadProjection(child)),oldPages=await pages(client,pending);
    expect(pending.readiness).toBe('identity-pending');await observe(client,b,child);
    const redirect=ok(await client.pinUploadProjection(child));expect(redirect).toMatchObject({readiness:'redirected',rootReadiness:'ready',rootTripUuid:root});
    expect(await pages(client,pending)).toEqual(oldPages);
    expect(await pages(client,resumable)).toEqual(rootPages);
    ok(await client.commitEvent({message:gameShaped(b.event(r.paused()))}));await close(client,b,child,'delivered');
    const final=ok(await client.pinUploadProjection(child)),mapped=mapUploadProjection(final,await pages(client,final));
    expect(final.facts).toMatchObject({pluginSessionId:ETS2_A,opening:{pluginSessionId:ETS2_A,rawTripUuid:root,eventSeq:'1200'},outcomeOccurrence:{pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'3'}});
    expect(mapped.status).toBe('projected');if(mapped.status==='projected'){expect(mapped.summary.source.tripId).toBe(root);expect(mapped.summary.snapshot.outcomeEventSeq).toBe('3');}
    const finalPages=await pages(client,final);
    expect(await client.close()).toEqual({clean:true});expect(recheck(pending)).toBe(false);expect(recheck(redirect)).toBe(false);expect(recheck(final)).toBe(true);
    const reopened=await start();expect(await pages(reopened,final)).toEqual(finalPages);expect(ok(await reopened.pinUploadProjection(root)).snapshot).toBe(final.snapshot);
    await reopened.close();
  });
  it('keeps all historical trailers and more than fifty intervals fixed while later closure/configuration/intervals commit', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s);
    for(let index=0;index<12;index++)ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured(trailer(index%10)))),effects:[{kind:'trip.update',tripUuid:uuid,set:{trailerConfigurations:['this-event']}}]}));
    for(let index=0;index<53;index++)ok(await client.recordCompleteness(s.session,{tripUuid:uuid,kind:'sample-loss',detail:{fixtureIndex:index}}));
    const pin=ok(await client.pinUploadProjection(uuid)),before=await pages(client,pin,5);expect(pin.totals).toEqual({members:1,configurations:12,intervals:53});
    ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured())),effects:[{kind:'trip.update',tripUuid:uuid,set:{trailerConfigurations:['this-event']}}]}));
    await close(client,s,uuid,'cancelled');ok(await client.recordCompleteness(s.session,{tripUuid:uuid,kind:'event-loss'}));
    expect(await pages(client,pin,5)).toEqual(before);expect(pin.facts.outcome).toBe('open');
    const result=mapUploadProjection(pin,before);expect(result.status).toBe('projected');if(result.status==='projected')expect(result.summary.snapshot.trailers).toEqual({complete:false,items:[]});
    const fresh=ok(await client.pinUploadProjection(uuid));expect(fresh.totals).toEqual({members:1,configurations:13,intervals:54});
    failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'members',limit:101}),'INVALID_INPUT');
    failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'intervals',limit:1,cursor:`${pin.snapshot}:members:1`}),'INVALID_INPUT');
    await client.close();expect(recheck(pin)).toBe(false);expect(recheck(fresh)).toBe(true);
  });
  it('keeps proof-committed, closed and retired roots stable when matching observations arrive', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,false);
    expect(ok(await client.pinUploadProjection(root)).readiness).toBe('identity-pending');await observe(client,a,root);
    const ready=ok(await client.pinUploadProjection(root));expect(ready.readiness).toBe('ready');await observe(client,a,root,job({plannedDistance:{available:true,value:1,unit:'m'}}));
    const retired=ok(await client.pinUploadProjection(root));expect(retired.rootTripUuid).toBe(root);expect(retired.facts.outcome).toBe('open');
    await close(client,a,root);const closed=ok(await client.pinUploadProjection(root));expect(closed.readiness).toBe('ready');
    const b=new Script(ETS2_B),other=await open(client,b);expect(ok(await client.pinUploadProjection(other)).rootTripUuid).toBe(other);
    await client.close();
  });
  it('keeps unproven closed self-roots ready without claiming proof, and checkpoint starts unobserved', async () => {
    const client=await start(),s=new Script(ETS2_A);ok(await client.upsertSession({message:gameShaped(s.welcome())}));
    const uuid=attachTripUuidFor(s.session,'1');ok(await client.openAttachedTrip({pluginSessionId:s.session,nextEventSeq:'1',job:job(),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,
      jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000}]}));
    expect(ok(await client.pinUploadProjection(uuid)).readiness).toBe('identity-pending');await close(client,s,uuid,'delivered');
    const pin=ok(await client.pinUploadProjection(uuid)),result=mapUploadProjection(pin,await pages(client,pin));expect(pin.readiness).toBe('ready');
    expect(result.status).toBe('projected');if(result.status==='projected'){expect(result.summary.snapshot.start).toEqual({utcMs:1000,basis:'checkpoint',eventSeq:null});expect(result.summary.snapshot.evidence.startObserved).toBe(false);}
    await client.close();
  });
  it('preserves selected save accounting and unavailable fuel instead of summing member totals', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s);
    const append=async(second:number,odo:number)=>{
      const sample:SampleInput={tripUuid:uuid,utcMs:1000+second*1000,sourceClockId:s.clockId,monotonicNs:String(second*1_000_000_000),gameTime:{minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},
        speed:{available:true,value:20},odometer:{available:true,value:odo},fuel:{available:true,value:500-odo/10000},averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,position:{available:true,value:{x:odo/5,y:0,z:0}},
        recording:{profile:proof(s),job:job(),truck:'fixture-truck',processInstanceId:s.welcome().source.processInstanceId,
          previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:String((second-1)*1_000_000_000)}}};
      ok(await client.appendSamples(s.session,[sample]));
    };
    await append(1,1000000);await append(2,1000050);await append(3,1000100);
    const first=ok(await client.pinUploadProjection(uuid)),oldPages=await pages(client,first);
    expect(first.facts.observedDistance).toEqual({available:true,value:100,unit:'m'});
    await append(4,1000060);await append(5,1000100);
    // A legacy raw total does not override a rebased selected save path.
    ok(await client.commitEvent({message:gameShaped(s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:uuid,set:{observedDistanceM:{available:true,value:999},fuelUsedL:{available:true,value:999}}}]}));
    const next=ok(await client.pinUploadProjection(uuid));expect(next.facts.observedDistance).toEqual({available:true,value:100,unit:'m'});
    expect(next.facts.fuelUsed).toEqual({...absent,unit:'L'});expect(next.facts.moneyIncomplete).toBe(true);
    expect(ok(await client.listSamples({tripUuid:uuid})).map(row=>row.id)).toEqual(['1','2','4','5']);
    expect(next.bounds.accountingHead).not.toBe(first.bounds.accountingHead);expect(await pages(client,first)).toEqual(oldPages);
    const mapped=mapUploadProjection(next,await pages(client,next));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){expect(mapped.summary.snapshot.observedDistance).toEqual({available:true,value:100,unit:'m'});expect(mapped.summary.snapshot.fuelUsed).toEqual({...absent,unit:'L'});}
    await client.close();expect(recheck(first)).toBe(false);
  });
  it('retains a checkpoint opening in A when an event in B supplies the logical delivery', async () => {
    const client=await start(),a=new Script(ETS2_A);ok(await client.upsertSession({message:gameShaped(a.welcome())}));
    const root=attachTripUuidFor(a.session,'1');ok(await client.openAttachedTrip({pluginSessionId:a.session,nextEventSeq:'1',job:job(),profile:proof(a),sourceClockId:a.clockId,monotonicNs:'1000000000',
      effects:[{kind:'trip.open',tripUuid:root,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000}]}));
    await close(client,a,root);const b=new Script(ETS2_B),child=await open(client,b);
    ok(await client.commitEvent({message:gameShaped(b.event(r.paused()))}));await close(client,b,child,'delivered');
    const pin=ok(await client.pinUploadProjection(child));expect(pin.rootTripUuid).toBe(root);expect(pin.facts).toMatchObject({openedBy:'checkpoint',opening:null,checkpointNextEventSeq:'1',outcomeOccurrence:{pluginSessionId:ETS2_B,eventSeq:'3'}});
    const mapped=mapUploadProjection(pin,await pages(client,pin));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){expect(mapped.summary.source.pluginSessionId).toBe(ETS2_A);expect(mapped.summary.snapshot.evidence.startObserved).toBe(false);expect(mapped.summary.snapshot.openedEventSeq).toBeNull();}
    await client.close();
  });
  it.each(['synthetic','replay'] as const)('never maps a %s database into game evidence', async purpose => {
    const client=await start(purpose),s=new Script(ETS2_A),welcome=s.welcome();welcome.source.origin=purpose;
    ok(await client.upsertSession({message:welcome}));const message=s.event(r.jobConfigured());message.source.origin=purpose;
    const uuid=tripUuidFor(s.session,'1');ok(await client.commitEvent({message,profile:proof(s),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    const pin=ok(await client.pinUploadProjection(uuid));expect(mapUploadProjection(pin,await pages(client,pin))).toEqual({status:'hold',reason:'source-ineligible'});await client.close();
  });
  it('fails explicitly when a pinned trip is deleted in staging', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s),pin=ok(await client.pinUploadProjection(uuid));
    ok(await client.deleteTrip(uuid,{rejectIfOpen:false}));failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'members',limit:1}),'UNKNOWN_TRIP');await client.close();expect(recheck(pin)).toBe(false);
  });
});
