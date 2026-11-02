import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import type {SampleInput, Storage} from '../../packages/storage/src';
import {attachTripUuidFor,tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {validateJournalTripDetail, validateJournalEventPage,validateJournalIntervalPage} from '../../packages/contracts/src/journal';
import {ETS2_A, ETS2_B, job, otherJob, r, Script, trailer} from '../shared/trip-messages';
import {MIGRATIONS,openStorage} from '../../packages/storage/src';
import {ok,failed,digestOf,readOnly,STORAGE_FIXTURES,workspace} from './helpers';
import {runRecording,terminateWorkers} from './recording-helpers';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {scenarioSource,replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {parseJournalReply} from '../../apps/desktop/src/journal-contract';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {StorageClient} from '../../packages/storage/src/client';
import {storageWorker} from './recording-helpers';
import {seedSample} from '../shared/journal-seed';

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await terminateWorkers();await ws.dispose();});
const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
function proof(script: Script): ProfileObservation {
  const source = script.welcome().source;
  return {version: 1, scope: 'a'.repeat(64), binding: 'b'.repeat(64), game: source.game, pluginSessionId: source.pluginSessionId,
    processInstanceId: source.processInstanceId, sourceClockId: script.clockId, afterMonotonicNs: '0', loadGeneration: 1};
}
function open(storage: Storage, script: Script, values = job(), verified = true) {
  ok(storage.upsertSession({message: script.welcome()}));
  const message = script.event(r.jobConfigured(values)), uuid = tripUuidFor(script.session, message.data.eventSeq);
  ok(storage.commitEvent({message, ...(verified ? {profile: proof(script)}:{}), effects: [{kind: 'trip.open', tripUuid: uuid, game: script.game,
    gameMode: mode, jobConfiguration: 'this-event', startedUtcMs: 1000, recordingCompleteness: 'complete'},
  {kind: 'event.attribute', tripUuid: uuid, attribution: 'trip'}]}));
  return uuid;
}
function sample(storage: Storage, script: Script, uuid: string, seconds: number, odometerM: number, values = job(), overrides: Partial<NonNullable<SampleInput['recording']>> = {}) {
  const absent = {available: false, reason: 'not-observed'} as const;
  const row: SampleInput = {tripUuid: uuid, utcMs: 1000 + seconds * 1000, sourceClockId: script.clockId, monotonicNs: String(BigInt(seconds) * 1_000_000_000n),
    odometer: {available: true, value: odometerM}, fuel: {available: true, value: 500 - odometerM / 10000}, speed: absent, gameTime: null,
    averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent, position: absent,
    recording: {profile: proof(script), job: values, truck: 'verified-truck', processInstanceId: script.welcome().source.processInstanceId,
      previous:{tripUuid:uuid,sourceClockId:script.clockId,monotonicNs:String(BigInt(seconds-1)*1_000_000_000n)},...overrides}};
  ok(storage.appendSamples(script.session, [row], {uniqueSeconds: true}));
}
function close(storage: Storage, script: Script, uuid: string, terminal = false) {
  const message = script.event(terminal ? r.cancelled() : r.timersRestart());
  ok(storage.commitEvent({message, effects: [{kind: 'trip.close', tripUuid: uuid, outcome: terminal ? 'cancelled' : 'none',
    closeReason: terminal ? 'outcome' : 'restart', ...(terminal ? {outcomeEvent: 'this-event' as const} : {}), recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
}

describe('REG-003/005/008/012/014 durable logical trips', () => {
  it('counts ordinary driving after historical nonzero counters and a later coalescing advance',async()=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const configuration=s.checkpoint(job()).data.state.configuration;
    const observe=async(odo:number,counter:string,ms=1000)=>{
      const message=s.snapshot({configuration,simulation:'running',odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:100,unit:'L'}},ms);
      message.data.continuity={coalescedSnapshots:counter,offlineTransitions:'5'};
      accepted(recorder.observe(message,context));
      if(recorder.attach.due())accepted(await recorder.attach.open(context));
    };
    await observe(1000000,'5');await observe(1000050,'5');accepted(await recorder.samples.write(3600,true));
    const uuid=tripUuidFor(ETS2_A,'1');expect(ok(await client.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:50});
    await observe(1000050,'6',100);await observe(1000050,'6');await observe(1000100,'6');
    accepted(await recorder.samples.write(3600,true));
    const detail=validateJournalTripDetail(ok(await client.journalTrip(uuid)));
    expect(detail.trip.observedDistanceM).toEqual({available:true,value:100});expect(detail.trip.fuelUsedL).toEqual({available:true,value:0});
    expect(ok(await client.listSamples({tripUuid:uuid},{limit:3600}))).toHaveLength(4);
    expect(await client.close()).toEqual({clean:true});
  });
  it.each([
    {name:'recorded known before unavailable current proof',initial:null,current:null,middle:false,joins:true},
    {name:'missing then recorded known then unavailable member',initial:null,current:null,middle:true,joins:true},
    {name:'conflicting recorded and current facts',initial:null,current:200,middle:false,joins:false},
    {name:'recorded facts conflicting with candidate constraints',initial:200,current:null,middle:false,joins:false}
  ])('retains raw canonical evidence through delayed proof: $name',async({initial,current,middle,joins})=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle);
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const offer=(value:number|null)=>job({plannedDistance:value===null?{available:false,reason:'not-observed',unit:'m'}:{available:true,value:value*1000,unit:'m'}});
    const openRaw=async(s:Script,distance:number|null)=>{
      ok(await client.upsertSession({message:s.welcome()}));const message=s.event(r.jobConfigured(offer(distance))),uuid=tripUuidFor(s.session,'1');
      ok(await client.commitEvent({message,effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',startedUtcMs:1000,recordingCompleteness:'complete'}]}));
      return uuid;
    };
    const observe=async(s:Script,uuid:string,distance:number|null)=>ok(await client.openAttachedTrip({pluginSessionId:s.session,nextEventSeq:'2',job:offer(distance),effects:[],
      observeTripUuid:uuid,profile:proof(s),sourceClockId:s.clockId,monotonicNs:'2000000000000'}));
    const finish=async(s:Script,uuid:string)=>ok(await client.commitEvent({message:s.event(r.timersRestart()),effects:[
      {kind:'trip.close',tripUuid:uuid,outcome:'none',closeReason:'restart',recordingCompleteness:'partial',endedUtcMs:2000}]}));
    const a=new Script(ETS2_A),first=await openRaw(a,initial);await observe(a,first,initial);await finish(a,first);
    const b=new Script(ETS2_B),second=await openRaw(b,100),before=ok(await client.journalTrip(second));
    await observe(b,second,current);expect(ok(await client.journalTrips()).trips).toHaveLength(joins?1:2);await finish(b,second);
    if(middle){
      const d=new Script('10000000-0000-4000-8000-000000000064'),uuid=await openRaw(d,null);
      await observe(d,uuid,null);expect(ok(await client.journalTrips()).trips).toHaveLength(1);await finish(d,uuid);
    }
    const c=new Script('10000000-0000-4000-8000-000000000063'),last=await openRaw(c,200);await observe(c,last,200);
    expect(ok(await client.journalTrips()).trips).toHaveLength(joins?2:3);
    expect(ok(await client.journalEvents(second,{limit:500,cursor:before.exportBounds.snapshot!.events})).events.map(row=>[row.pluginSessionId,row.eventSeq])).toEqual([[ETS2_B,'1']]);
    expect(await client.close()).toEqual({clean:true});
    readOnly(ws.database,db=>{
      expect(db.prepare('SELECT j.planned_distance_m FROM trips t JOIN job_configurations j ON j.id=t.job_configuration_ref WHERE t.trip_uuid=?').pluck().get(second)).toBe(100000);
      if(joins)expect(db.prepare("SELECT json_extract(canonical_constraints,'$.plannedDistance') FROM logical_trips WHERE trip_uuid=?").pluck().get(first)).toBe(100000);
    });
  });
  it('preserves net fuel noise on a continued accounting path',async()=>{
    const storage=await ws.open(),a=new Script(ETS2_A),first=open(storage,a);
    const rows=(s:Script,uuid:string,values:number[])=>values.map((fuel,index)=>({...seedSample(s,uuid,index+1,1000+(index+1)*1000,
      {fuel:{available:true,value:fuel},odometer:{available:true,value:1000000+Math.max(0,index-1)}}),recording:{profile:proof(s),job:job(),truck:'verified-truck',processInstanceId:s.welcome().source.processInstanceId,
      previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:seedSample(s,uuid,index,1000).monotonicNs}}}));
    ok(storage.appendSamples(ETS2_A,rows(a,first,[100,100]),{uniqueSeconds:true}));close(storage,a,first);
    const b=new Script(ETS2_B),second=open(storage,b);
    ok(storage.appendSamples(ETS2_B,rows(b,second,[100,99,99.005,98.005]),{uniqueSeconds:true}));
    const detail=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(detail.trip.fuelUsedL.available && detail.trip.fuelUsedL.value).toBeCloseTo(1.995,9);
  });
  it('does not bridge a same-raw short reconnect without lost events through the recorder and worker',async()=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const configuration=s.checkpoint(job()).data.state.configuration;
    for(const odo of [1000000,1000100]){
      accepted(recorder.observe(s.snapshot({configuration,simulation:'running',odometer:{available:true,value:odo,unit:'m'}},1000),context));
      if(recorder.attach.due())accepted(await recorder.attach.open(context));
    }
    accepted(await recorder.samples.write(3600,true));const uuid=tripUuidFor(ETS2_A,'1');
    expect(ok(await client.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:100});
    accepted(await recorder.openSession(s.welcome()));
    accepted(recorder.observe(s.checkpoint(job(),0,{simulation:'running',boundaryOrder:'200',odometer:{available:true,value:1000150,unit:'m'}}),context));
    accepted(recorder.observe(s.snapshot({configuration,simulation:'running',boundaryOrder:'300',odometer:{available:true,value:1000150,unit:'m'}},2000),context));
    if(recorder.attach.due())accepted(await recorder.attach.open(context));
    accepted(await recorder.samples.write(3600,true));
    const detail=ok(await client.journalTrip(uuid));expect(detail.trip.observedDistanceM.available).toBe(false);
    expect(ok(await client.listTrips()).trips).toHaveLength(1);expect(ok(await client.committedThrough(ETS2_A))).toBe('1');
    expect(await client.close()).toEqual({clean:true});
  });
  it('leaves a reconnect checkpoint unassigned while a replay gap can hide job replacement',async()=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle);
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const config=s.checkpoint(job()).data.state.configuration;
    accepted(recorder.observe(s.snapshot({configuration:config,simulation:'running',odometer:{available:true,value:111000,unit:'m'}},1000),context));
    const first=tripUuidFor(ETS2_A,'1'),gap=s.gap(1);
    accepted(await recorder.openSession(s.welcome()));
    const checkpoint=s.checkpoint(otherJob(),1,{simulation:'running',boundaryOrder:'200',odometer:{available:true,value:222000,unit:'m'}});
    accepted(recorder.observe(checkpoint,context));
    accepted(await recorder.commit(gap,context));
    const configuration=checkpoint.data.state.configuration;
    accepted(recorder.observe(s.snapshot({configuration,simulation:'running',boundaryOrder:'300'},1000),context));
    expect(recorder.attach.due()).toBe(true);accepted(await recorder.attach.open(context));
    accepted(recorder.observe(s.snapshot({configuration,simulation:'running',boundaryOrder:'400',odometer:{available:true,value:333000,unit:'m'}},1000),context));
    accepted(await recorder.samples.write(3600,true));
    const rows=ok(await client.listSamples({pluginSessionId:ETS2_A}));
    const checkpointRow=rows.find(row=>row.odometer.available && row.odometer.value===222000)!;
    expect(checkpointRow.tripUuid).toBeNull();
    const second=attachTripUuidFor(ETS2_A,'3');
    for(const uuid of [first,second])expect(ok(await client.listSamples({tripUuid:uuid},{limit:3600})).some(row=>row.id===checkpointRow.id)).toBe(false);
    expect(rows.find(row=>row.odometer.available && row.odometer.value===333000)?.tripUuid).toBe(second);
    expect(await client.close()).toEqual({clean:true});
  });
  it.each([[null,100,200],[100,null,200]] as const)('vetoes learned optional conflicts across members %j',async(firstDistance,secondDistance,lastDistance)=>{
    const storage=await ws.open();
    const offer=(value:number|null)=>job({plannedDistance:value===null?{available:false,reason:'not-observed',unit:'m'}:{available:true,value:value*1000,unit:'m'}});
    const a=new Script(ETS2_A),first=open(storage,a,offer(firstDistance));close(storage,a,first);
    const b=new Script(ETS2_B),second=open(storage,b,offer(secondDistance));close(storage,b,second);
    const c=new Script('10000000-0000-4000-8000-000000000063');open(storage,c,offer(lastDistance));
    expect(ok(storage.journalTrips()).trips).toHaveLength(2);
    expect(ok(storage.journalTrips()).trips.find(t=>t.tripUuid===first)).toMatchObject({outcome:'none',closeReason:'different-job'});
  });
  it('never lets precise legacy totals override an unresolved rollback with missing truck evidence',async()=>{
    const storage=await ws.open(),s=new Script(ETS2_A),uuid=open(storage,s);
    for(const [second,odo] of [[1,1000000],[2,1000100],[3,1000060],[4,1000100]])sample(storage,s,uuid,second,odo,job(),{truck:null});
    const fine=s.event(r.fined());ok(storage.commitEvent({message:fine,effects:[
      {kind:'event.attribute',tripUuid:uuid,attribution:'trip'},
      {kind:'trip.update',tripUuid:uuid,set:{observedDistanceM:{available:true,value:140},fuelUsedL:{available:true,value:14}}}]}));
    const detail=validateJournalTripDetail(ok(storage.journalTrip(uuid)));
    expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.fuelUsedL.available).toBe(false);
    expect(detail.money).toEqual({incomplete:true,totals:[],unavailable:[]});
    const retained=ok(storage.listSamples({tripUuid:uuid},{limit:3600}));expect(retained).toHaveLength(4);
    expect(retained.map(row=>row.accountingIncluded)).toEqual([false,false,true,true]);
    expect(ok(storage.listSamples({tripUuid:uuid},{limit:300}))).toHaveLength(2);
    ok(storage.close());readOnly(ws.database,db=>expect(db.prepare('SELECT observed_distance_m,fuel_used_l FROM trips').get()).toEqual({observed_distance_m:140,fuel_used_l:14}));
  });
  it.each(['reconnect','dropped-predecessor','member','restart'] as const)('does not bridge a short unobserved %s boundary',async boundary=>{
    let storage=await ws.open();const a=new Script(ETS2_A),first=open(storage,a);
    sample(storage,a,first,1,1000000);sample(storage,a,first,2,1000100);
    let uuid=first;
    if(boundary==='member'){close(storage,a,first);uuid=open(storage,a);}
    if(boundary==='restart'){ok(storage.close());storage=await ws.open();}
    sample(storage,a,uuid,4,1000150,job(),{previous:boundary==='dropped-predecessor'?{tripUuid:uuid,sourceClockId:a.clockId,monotonicNs:'3000000000'}:undefined});
    const detail=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.fuelUsedL.available).toBe(false);
    expect(ok(storage.listSamples({tripUuid:first},{limit:3600}))).toHaveLength(3);
  });
  it('includes later member trailers through bounded snapshot memberships and retains the earlier export detail',async()=>{
    const storage=await ws.open(),a=new Script(ETS2_A),first=open(storage,a);close(storage,a,first);
    const b=new Script(ETS2_B),second=open(storage,b);
    const add=(index:number)=>ok(storage.commitEvent({message:b.event(r.trailerConfigured(trailer(index))),effects:[
      {kind:'trip.update',tripUuid:second,set:{trailerConfigurations:['this-event']}}]}));
    add(1);const before=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(before.trailers.total).toBe(1);expect(before.trailers.items[0]).toMatchObject({pluginSessionId:ETS2_B,rawTripUuid:second,eventSeq:'2'});
    add(2);const after=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(after.trailers.total).toBe(2);expect(after.trailers.items.map(t=>t.eventSeq)).toEqual(['2','3']);
    expect(before.trailers.items.map(t=>t.eventSeq)).toEqual(['2']);
    expect(ok(storage.journalEvents(first,{limit:500,cursor:before.exportBounds.snapshot!.events})).events.filter(e=>e.type==='trailer.configured').map(e=>e.eventSeq)).toEqual(['2']);
  });
  it('continues the next day after reopening, preserving raw sessions and equal event sequences', async () => {
    let storage = await ws.open();
    const a = new Script(ETS2_A), first = open(storage, a);
    sample(storage, a, first, 1, 1000000); sample(storage, a, first, 2, 1000050);
    close(storage, a, first); ok(storage.close());
    ws.advance(86_400_000); storage = await ws.open();
    const b = new Script(ETS2_B), second = open(storage, b, job({cargo: {available: true, value: 'Localized cargo'}}));
    sample(storage, b, second, 1, 1000050); sample(storage, b, second, 2, 1000100);
    expect(ok(storage.listTrips()).trips).toHaveLength(2);
    const list = ok(storage.journalTrips());
    expect(list.trips).toHaveLength(1); expect(list.trips[0].tripUuid).toBe(first);
    expect(list.trips[0].observedDistanceM).toEqual({available: true, value: 100});
    const detail = validateJournalTripDetail(ok(storage.journalTrip(first)));
    const events = validateJournalEventPage(ok(storage.journalEvents(first, {limit: 500, cursor: detail.exportBounds.snapshot!.events})));
    expect(events.events.filter(e => e.eventSeq === '1').map(e => e.pluginSessionId)).toEqual([ETS2_A, ETS2_B]);
    expect(detail.exportBounds.sources?.map(s => s.pluginSessionId)).toEqual([ETS2_A, ETS2_B]);
  });
  it('keeps cancellation followed by an identical offer separate and interrupts a different job', async () => {
    const storage = await ws.open(), a = new Script(ETS2_A), first = open(storage, a);
    close(storage, a, first, true);
    const b = new Script(ETS2_B); open(storage, b);
    expect(ok(storage.journalTrips()).trips).toHaveLength(2);
    close(storage, b, tripUuidFor(ETS2_B, '1'));
    const c = new Script('10000000-0000-4000-8000-0000000000d4'); open(storage, c, otherJob());
    expect(ok(storage.journalTrips()).trips.find(t => t.tripUuid === tripUuidFor(ETS2_B, '1'))).toMatchObject({outcome: 'none', closeReason: 'different-job'});
  });
  it('keeps an earlier singleton snapshot readable after late profile proof changes its membership',async()=>{
    const storage=await ws.open(),a=new Script(ETS2_A),first=open(storage,a);close(storage,a,first);
    const b=new Script(ETS2_B),second=open(storage,b,job(),false);
    const before=validateJournalTripDetail(ok(storage.journalTrip(second)));
    expect(ok(storage.journalTrips()).trips).toHaveLength(2);
    sample(storage,b,second,1,1000000);
    expect(ok(storage.journalTrips()).trips).toHaveLength(1);
    const old=ok(storage.journalEvents(second,{limit:500,cursor:before.exportBounds.snapshot!.events}));
    expect(old.events.map(e=>[e.pluginSessionId,e.eventSeq])).toEqual([[ETS2_B,'1']]);
    const joined=ok(storage.journalEvents(first,{limit:500}));
    expect(joined.events.map(e=>e.pluginSessionId)).toEqual([ETS2_A,ETS2_A,ETS2_B]);
  });
  it('splits an identical job when verified profile scope changes within one plugin session',async()=>{
    const storage=await ws.open(),script=new Script(ETS2_A),first=open(storage,script),next=attachTripUuidFor(ETS2_A,'2');
    const profile={...proof(script),scope:'e'.repeat(64)};
    const input={pluginSessionId:ETS2_A,nextEventSeq:'2',job:job(),profile,profileChange:true,sourceClockId:script.clockId,monotonicNs:'2000000000000',effects:[
      {kind:'trip.close',tripUuid:first,outcome:'none',closeReason:'different-job',recordingCompleteness:'partial',endedUtcMs:2000},
      {kind:'trip.open',tripUuid:next,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:2000}] as import('../../packages/storage/src').TripEffect[]};
    failed(storage.openAttachedTrip({...input,profile:proof(script)}),'INVALID_INPUT');
    ok(storage.openAttachedTrip(input));
    const fine=script.event(r.fined());ok(storage.commitEvent({message:fine,effects:[{kind:'event.attribute',tripUuid:next,attribution:'trip'}]}));
    const trips=ok(storage.journalTrips()).trips;expect(trips).toHaveLength(2);
    expect(trips.find(t=>t.tripUuid===first)).toMatchObject({outcome:'none',closeReason:'different-job'});
    expect(ok(storage.journalEvents(first,{limit:500})).events.map(e=>e.eventSeq)).toEqual(['1']);
    expect(ok(storage.journalEvents(next,{limit:500})).events.map(e=>e.eventSeq)).toEqual(['2']);
  });
  it('replaces the abandoned suffix on rollback, retains raw observations, and freezes the earlier snapshot',async()=>{
    const storage=await ws.open(),a=new Script(ETS2_A),uuid=open(storage,a);
    sample(storage,a,uuid,1,1000000);sample(storage,a,uuid,2,1000050);sample(storage,a,uuid,3,1000100);
    const before=validateJournalTripDetail(ok(storage.journalTrip(uuid)));
    sample(storage,a,uuid,4,1000060);sample(storage,a,uuid,5,1000100);
    const after=validateJournalTripDetail(ok(storage.journalTrip(uuid)));
    expect(after.trip.observedDistanceM).toEqual({available:true,value:100});
    expect(after.trip.fuelUsedL.available).toBe(false);
    expect(after.money).toEqual({incomplete:true,totals:[],unavailable:[]});
    const current=ok(storage.listSamples({tripUuid:uuid},{afterId:after.exportBounds.snapshot!.samples,limit:300}));
    expect(current.map(s=>s.odometer.available?s.odometer.value:null)).toEqual([1000000,1000050,1000060,1000100]);
    const raw=ok(storage.listSamples({tripUuid:uuid},{afterId:after.exportBounds.snapshot!.samples,limit:3600}));
    expect(raw.map(s=>s.accountingIncluded)).toEqual([true,true,false,true,true]);
    const old=ok(storage.listSamples({tripUuid:uuid},{afterId:before.exportBounds.snapshot!.samples,limit:3600}));
    expect(old.map(s=>s.accountingIncluded)).toEqual([true,true,true]);
    expect(before.trip.observedDistanceM).toEqual({available:true,value:100});
  });
  it('pages recording provenance beyond the detail bound without exposing private profile proof',async()=>{
    const storage=await ws.open();let first='';
    for(let i=0;i<260;i++){
      const script=new Script(`10000000-0000-4000-8000-${(i+1000).toString(16).padStart(12,'0')}`),uuid=open(storage,script);
      first ||= uuid;close(storage,script,uuid);
    }
    const detail=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(detail.exportBounds.sourceTotal).toBe(260);expect(detail.exportBounds.sources).toHaveLength(256);
    let cursor:string|null=detail.exportBounds.snapshot!.sources;const sessions:string[]=[],sizes:number[]=[];
    while(cursor!==null){
      const page=validateJournalIntervalPage(ok(storage.journalIntervals(first,{limit:100,cursor})),100);
      expect(page.sourceTotal).toBe(260);expect(page.intervals).toEqual([]);
      sizes.push(page.sources!.length);sessions.push(...page.sources!.map(s=>s.pluginSessionId));cursor=page.nextSourceCursor ?? null;
      expect(JSON.stringify(page)).not.toContain('scope');expect(JSON.stringify(page)).not.toContain('binding');
    }
    expect(sizes).toEqual([100,100,60]);expect(new Set(sessions).size).toBe(260);
  });
  it.each(['driving','paused'] as const)('records next-day %s continuation before the default sample flush through production ingestion and the Journal reply boundary',async driving=>{
    const base=JSON.parse(readFileSync(scenarioPath('normal-delivery'),'utf8'));
    const attributes=[...base.steps[2].attributes,
      {name:'source.company.id',sdkType:'string',value:'synthetic_source'},{name:'destination.company.id',sdkType:'string',value:'synthetic_destination'},
      {name:'cargo.mass',sdkType:'float',value:18000},{name:'job.market',sdkType:'string',value:'freight_market'},{name:'delivery.time',sdkType:'u32',value:13000}];
    const configured={...base.steps[2],attributes};
    const truck={...base.steps[0],attributes:[...base.steps[0].attributes,{name:'license.plate',sdkType:'string',value:'SYN 063'}]};
    const first={...base,id:'logical-before-restart',seed:'et063-before-restart',steps:[truck,base.steps[1],configured,base.steps[3],
      {atMs:100,action:'frame',channels:{speed:20,odometer:1000,'game.time':601}},
      {atMs:1100,action:'frame',channels:{speed:20,odometer:1000.0625,'game.time':602}},
      {atMs:2100,action:'frame',channels:{speed:20,odometer:1000.125,'game.time':603}}],
      transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:2200,action:'disconnect'}]};
    const next={...first,id:'logical-next-day',seed:'et063-next-day',steps:[{atMs:0,action:'utcJump',deltaMs:86_400_000},truck,base.steps[1],configured,base.steps[3],
      {atMs:100,action:'frame',channels:{speed:20,odometer:1000.0625,'game.time':602}},
      {atMs:1100,action:'frame',channels:{speed:20,odometer:1000.125,'game.time':603}},
      {...base.steps[9],atMs:1500},{...base.steps[10],atMs:1510}],transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:1600,action:'disconnect'}]};
    if(driving==='paused')next.steps.splice(5,0,{atMs:50,action:'lifecycle',event:'simulation.paused'});
    let firstUuid='';
    for(const input of [first,next]){
      const source=scenarioSource(replayV1(input).scenario);
      const profile:ProfileObservation={version:1,scope:'c'.repeat(64),binding:'d'.repeat(64),game:'ets2',pluginSessionId:source.pluginSessionId,
        processInstanceId:source.processInstanceId,sourceClockId:seededId(input.seed,'capture-clock'),afterMonotonicNs:'0',loadGeneration:1};
      const run=await runRecording(input,{path:ws.database,backups:ws.backups},{profileEvidence:()=>profile});
      for(const ack of run.acks)expect(ack.through).toBeLessThanOrEqual(ack.coverage);
      const client=run.services.at(-1)!.client,list=ok(await client.journalTrips());expect(run.services.flatMap(s=>s.logs.filter(([event])=>event==='V1_DURABLE_UNAVAILABLE' || event==='V1_SAMPLES_DISCARDED'))).toEqual([]);expect(list.trips).toHaveLength(1);
      firstUuid ||= list.trips[0].tripUuid;expect(list.trips[0].tripUuid).toBe(firstUuid);
      const detail=ok(await client.journalTrip(firstUuid));expect(parseJournalReply({kind:'trip',tripUuid:firstUuid},{ok:true,value:detail})).toEqual({ok:true,value:detail});
      if(input===next){expect(detail.trip).toMatchObject({outcome:'delivered',observedDistanceM:driving==='driving'?{available:true,value:125}:{available:false,reason:'not-observed'}});expect(detail.exportBounds.sourceTotal).toBe(2);}
      expect(await client.close()).toEqual({clean:true});
    }
    const storage=await ws.open();expect(ok(storage.journalTrips()).trips).toHaveLength(1);
    expect(ok(storage.listTrips()).trips).toHaveLength(2);
  },60_000);
});

describe('REG-013 logical singleton migration',()=>{
  it.each([1,2,3])('preserves IDs and raw facts from frozen schema v%i without inferring membership',async version=>{
    const file=ws.copyFixture(`schema-v${version}-representative.sqlite`);
    const before=readOnly(file,db=>db.prepare('SELECT * FROM trips ORDER BY id').all()) as Record<string,unknown>[];
    const storage=await ws.open({path:file});expect(storage.summary.schemaVersion).toBe(4);
    const list=ok(storage.journalTrips()).trips;
    expect(list.map(t=>t.tripUuid).sort()).toEqual(before.map(t=>t.trip_uuid).sort());
    ok(storage.close());
    readOnly(file,db=>{
      const after=db.prepare('SELECT * FROM trips ORDER BY id').all() as Record<string,unknown>[];
      expect(after.map(row=>Object.fromEntries(Object.keys(before[0]).map(key=>[key,row[key]])))).toEqual(before);
      expect(db.prepare('SELECT trip_ref,logical_ref FROM logical_memberships ORDER BY trip_ref').all()).toEqual(before.map(row=>({trip_ref:row.id,logical_ref:row.id})));
      expect(db.prepare('SELECT count(*) FROM logical_trips WHERE profile_scope IS NOT NULL OR retired<>1').pluck().get()).toBe(0);
      expect(db.pragma('integrity_check',{simple:true})).toBe('ok');expect(db.pragma('foreign_key_check')).toEqual([]);
    });
    if(version===3){
      const expected=JSON.parse(readFileSync(path.join(STORAGE_FIXTURES,'schema-v3-representative.expected.json'),'utf8'));
      expect(list.map(t=>t.tripUuid).sort()).toEqual(expected.tripUuids);
      expect(before.map(t=>t.outcome)).toEqual(expected.outcomes);
    }
  });
  it('rolls back all v4 grouping tables after an interrupted migration and reuses the verified backup',async()=>{
    const file=ws.copyFixture('schema-v3-representative.sqlite'),before=digestOf(file);
    const migrations=[...MIGRATIONS.slice(0,3),{...MIGRATIONS[3],up(db:Parameters<typeof MIGRATIONS[3]['up']>[0]){MIGRATIONS[3].up(db);throw new Error('Injected after v4 projection');}}];
    const error=failed(await openStorage(ws.options({path:file,migrations})),'MIGRATION_FAILED');
    expect(digestOf(file)).toEqual(before);
    const storage=await ws.open({path:file});expect(storage.summary.backupFileName).toBe(error.backupFileName);
    expect(ok(storage.journalTrips()).trips).toHaveLength(4);
  });
});
