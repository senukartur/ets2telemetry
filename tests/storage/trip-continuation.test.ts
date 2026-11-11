import Database from 'better-sqlite3';
import {setTimeout as nativeSetTimeout,clearTimeout as nativeClearTimeout} from 'node:timers';
import {performance as nativePerformance} from 'node:perf_hooks';
import {snapshot as logicalSnapshot} from '../../packages/storage/src/sqlite/logical-snapshot';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {mkdir,writeFile,rename,symlink,opendir,appendFile,realpath,stat,utimes,rm} from 'node:fs/promises';
import {decodePayload,encodeFrame,type ClientMessage,type ServerMessage,type CurrentState} from '../../packages/contracts/src/protocol-v1';
import {HardModeReader,readStableFile} from '../../apps/desktop/src/hard-mode/reader';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import {ProfileObserver} from '../../apps/desktop/src/profile-observation';
import {advanceHardMode, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {V1_CLIENT_MAX_MINOR,V1Ingestion} from '../../apps/desktop/src/v1-ingestion';
import {serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it,vi} from 'vitest';
import {readFileSync,type BigIntStats} from 'node:fs';
import path from 'node:path';
import type {SampleInput, Storage} from '../../packages/storage/src';
import {attachTripUuidFor,tripUuidFor, type EventMessage, type ProfileObservation} from '../../packages/telemetry-core/src';
import {validateJournalTripDetail, validateJournalEventPage,validateJournalIntervalPage} from '../../packages/contracts/src/journal';
import {ETS2_A, ETS2_B, GAME_CLOCK_1, job, otherJob, r, Script, trailer} from '../shared/trip-messages';
import {FINAL_PROCESS_PROFILE_DELAY_MS, INCIDENT_EXPECTED, INCIDENT_JOB, INCIDENT_JOB_U32_MAX_DEADLINE, INCIDENT_JOB_WITHOUT_DEADLINE, INCIDENT_OTHER_JOB,
  INCIDENT_OTHER_JOB_WITHOUT_DEADLINE, INCIDENT_SEGMENTS, incidentDelivered, type IncidentSegment} from '../shared/trip-continuation-incident';
import type {JobConfiguration} from '../../packages/contracts/src/protocol-v1';
import {MIGRATIONS,openStorage} from '../../packages/storage/src';
import {ok,failed,digestOf,readOnly,STORAGE_FIXTURES,TEST_CLOSE_GRACE_MS,workspace} from './helpers';
import {ClientSocket,guarded,runRecording,terminateWorkers} from './recording-helpers';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {scenarioSource,replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {parseJournalReply} from '../../apps/desktop/src/journal-contract';
import {recorderClient} from '../../apps/desktop/src/history-storage';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {StorageClient} from '../../packages/storage/src/client';
import {storageWorker} from './recording-helpers';
import {seedSample} from '../shared/journal-seed';
import {JournalService} from '../../apps/desktop/src/journal-service';
import {TripExportSerializer,tripExportHeader} from '../../apps/desktop/src/journal-export';
import {tripExportProblems} from '../shared/trip-export-validator';
import {JournalExporter} from '../../apps/desktop/src/journal-export-writer';

let ws: Awaited<ReturnType<typeof workspace>>;
// Capture before scenario fake timers. These bounds diagnose a missing stage; they never advance game or service time.
const realSetTimeout=nativeSetTimeout,realClearTimeout=nativeClearTimeout,realNow=nativePerformance.now.bind(nativePerformance);
class WiredHangGuardError extends Error {}
async function wiredGuarded<T>(work:Promise<T>,stage:string,deadline:number,signal?:AbortSignal):Promise<T>{
  let timer:ReturnType<typeof realSetTimeout>|undefined;
  let abort:(()=>void)|undefined;
  const failed=new Promise<never>((_,reject)=>{
    abort=()=>{const reason:unknown=signal?.reason;reject(reason instanceof Error?reason:new Error('Wired case retired',{cause:reason}));};
    if(signal?.aborted){abort();return;}
    signal?.addEventListener('abort',abort,{once:true});
    timer=realSetTimeout(()=>reject(new WiredHangGuardError(`Hang guard: ${stage} did not settle before the wired deadline`)),Math.max(0,deadline-realNow()));
  });
  try{return await Promise.race([work,failed]);}
  finally{realClearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);}
}
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {vi.useRealTimers();await terminateWorkers();await ws.dispose();});
const mode = {mode: 'unknown', method: 'none', confidence: 'none'} as const;
const succeeded=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
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
    odometer: {available: true, value: odometerM}, fuel: {available: true, value: 500 - odometerM / 10000}, speed: {available:true,value:20}, gameTime: {minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},
    averageConsumption: absent, estimatedRange: absent, engineRpm: absent, gear: absent, position: {available:true,value:{x:odometerM/5,y:0,z:0}},
    recording: {profile: proof(script), job: values, truck: 'verified-truck', processInstanceId: script.welcome().source.processInstanceId,
      previous:{tripUuid:uuid,sourceClockId:script.clockId,monotonicNs:String(BigInt(seconds-1)*1_000_000_000n)},...overrides}};
  ok(storage.appendSamples(script.session, [row], {uniqueSeconds: true}));
}
// Independently authored ordinary-motion channels, rather than the immutable snapshot fixture's unavailable speed.
const motion = (odo:number) => ({speed:{available:true as const,value:20,unit:'m/s' as const},gameTime:{available:true as const,value:'500',unit:'min' as const,clockId:'40000000-0000-4000-8000-000000000001'},
  worldPlacement:{available:true as const,value:{position:{x:odo/5,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}});
function close(storage: Storage, script: Script, uuid: string, terminal = false) {
  const message = script.event(terminal ? r.cancelled() : r.timersRestart());
  ok(storage.commitEvent({message, effects: [{kind: 'trip.close', tripUuid: uuid, outcome: terminal ? 'cancelled' : 'none',
    closeReason: terminal ? 'outcome' : 'restart', ...(terminal ? {outcomeEvent: 'this-event' as const} : {}), recordingCompleteness: 'partial', endedUtcMs: 2000}]}));
}

describe('REG-003/005/008/012/014 durable logical trips', () => {
  it.each([1,3])('sums v2 member check counts across %s sessions and worker/database reopen', async sessions => {
    let worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),original='';
    try {
      ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test-v2'}));
      const ids=[ETS2_A,ETS2_B,'10000000-0000-4000-8000-0000000000d4'];
      for(let i=0;i<sessions;i++) {
        if(i>0) {expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
          ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test-v2'}));}
        const script=new Script(ids[i]);ok(await client.upsertSession({message:script.welcome()}));
        const configured=script.event(r.jobConfigured()),uuid=tripUuidFor(script.session,configured.data.eventSeq);original ||= uuid;
        ok(await client.commitEvent({message:configured,profile:proof(script),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,
          jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
        const counts=sessions===1?{passingChecks:95,failingChecks:5,unknownChecks:7}:i===0?{passingChecks:1,failingChecks:5,unknownChecks:0}:i===1?{passingChecks:94,failingChecks:0,unknownChecks:0}:{passingChecks:0,failingChecks:0,unknownChecks:7};
        const observation={assessment:evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),1000+i,'fixture'),binding:'b'.repeat(64),pluginSessionId:script.session,sourceMonotonicNs:'0',
          batch:{tripUuid:uuid,producer:'90000000-0000-4000-8000-000000000001',sequence:counts.passingChecks+counts.failingChecks+counts.unknownChecks,...counts}};
        ok(await client.observeHardMode('ets2',observation,true));ok(await client.observeHardMode('ets2',observation,true));
        if(i===sessions-1) {
          let published:import('../../packages/contracts/src/hard-mode').HardModeDetails|null=null;
          const recorder=new TripRecorderSink(recorderClient({client}),{hardModeEvidence:()=>observation,onHardModeTrip:value=>{published=value;}});
          succeeded(await recorder.openSession(script.welcome()));await recorder.flushHardMode();
          expect(published).toMatchObject({version:2,passingChecks:95,failingChecks:5,unknownChecks:7});
        }

        const message=script.event(i===sessions-1?r.delivered():r.timersRestart());
        ok(await client.commitEvent({message,effects:[{kind:'trip.close',tripUuid:uuid,outcome:i===sessions-1?'delivered':'none',closeReason:i===sessions-1?'outcome':'restart',
          ...(i===sessions-1?{outcomeEvent:'this-event' as const}:{}),recordingCompleteness:'partial',endedUtcMs:2000}]}));
      }
      const list=ok(await client.journalTrips());expect(list.trips).toHaveLength(1);
      const detail=ok(await client.journalTrip(original));expect(detail.trip).toMatchObject({outcome:'delivered',isHardMode:true,
        hardModeDetails:{version:2,passingChecks:95,failingChecks:5,unknownChecks:7,firstLoss:null}});
      expect(detail.exportBounds.sourceTotal).toBe(sessions);
    } finally {expect(await client.close()).toEqual({clean:true});}
    readOnly(ws.database, db=> {
      const rows=db.prepare("SELECT json_extract(hard_mode_details,'$.passingChecks') AS p,json_extract(hard_mode_details,'$.failingChecks') AS f FROM trips").all() as {p:number;f:number}[];
      expect(rows.reduce((sum,row)=>sum+row.p,0)).toBe(95);expect(rows.reduce((sum,row)=>sum+row.f,0)).toBe(5);
    });
  });
  it('preserves a pre-change checkpoint null audit through a qualifying v2 continuation and export',async()=>{
    let storage=await ws.open();const a=new Script(ETS2_A),first=attachTripUuidFor(a.session,'1');ok(storage.upsertSession({message:a.welcome()}));
    ok(storage.openAttachedTrip({pluginSessionId:a.session,nextEventSeq:'1',job:job(),profile:proof(a),sourceClockId:a.clockId,monotonicNs:'0',effects:[
      {kind:'trip.open',tripUuid:first,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000}]}));close(storage,a,first);ok(storage.close());
    const db=new Database(ws.database);try{db.prepare('UPDATE trips SET hard_mode_details=NULL,is_hard_mode=0 WHERE trip_uuid=?').run(first);}finally{db.close();}
    storage=await ws.open();const b=new Script(ETS2_B),second=open(storage,b),assessment=evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),2000,'fixture');
    ok(storage.observeHardMode('ets2',{assessment,binding:'b'.repeat(64),pluginSessionId:b.session,sourceMonotonicNs:'0',batch:{tripUuid:second,producer:'90000000-0000-4000-8000-000000000001',sequence:1,passingChecks:1,failingChecks:0,unknownChecks:0}},true));
    ok(storage.commitEvent({message:b.event(r.delivered()),effects:[{kind:'trip.close',tripUuid:second,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'partial',endedUtcMs:3000}]}));
    const detail=validateJournalTripDetail(ok(storage.journalTrip(first)));expect(detail.trip).toMatchObject({isHardMode:false,hardModeDetails:null});expect(ok(storage.journalTrips()).trips).toHaveLength(1);
    const serializer=new TripExportSerializer(detail,tripExportHeader({uuid:'30000000-0000-4000-8000-000000000001',purpose:'synthetic',schemaVersion:8},'test',4000));
    const exported=JSON.parse(serializer.begin()+serializer.rows('sources',ok(storage.journalIntervals(first,{limit:500,cursor:detail.exportBounds.snapshot!.sources})).sources!)+serializer.rows('intervals',ok(storage.journalIntervals(first,{limit:500,cursor:detail.exportBounds.snapshot!.intervals})).intervals)+serializer.rows('events',ok(storage.journalEvents(first,{limit:500,cursor:detail.exportBounds.snapshot!.events})).events)+serializer.end());
    expect(tripExportProblems(exported)).toEqual([]);expect(exported.trip).toMatchObject({is_hard_mode:false,hard_mode_details:null});ok(storage.close());
    readOnly(ws.database,sql=>expect(sql.prepare('SELECT hard_mode_details,is_hard_mode FROM trips WHERE trip_uuid=?').get(first)).toEqual({hard_mode_details:null,is_hard_mode:0}));
  });
  it('keeps a legacy original on its strict policy when a new recording continues it', async () => {
    let storage=await ws.open();const a=new Script(ETS2_A),first=open(storage,a);close(storage,a,first);ok(storage.close());
    const assessment=evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),1000,'fixture');
    const legacy=advanceHardMode(null,assessment);legacy.binding='b'.repeat(64);const bytes=JSON.stringify(legacy);
    const db=new Database(ws.database);
    try {db.prepare('UPDATE trips SET hard_mode_details=? WHERE trip_uuid=?').run(bytes,first);db.prepare('UPDATE logical_trips SET hard_mode_lost=0,first_loss_json=NULL').run();} finally {db.close();}
    storage=await ws.open();const b=new Script(ETS2_B),second=open(storage,b);
    ok(storage.observeHardMode('ets2',{assessment,binding:'b'.repeat(64),pluginSessionId:b.session,sourceMonotonicNs:'0',
      batch:{tripUuid:second,producer:'90000000-0000-4000-8000-000000000001',sequence:100,passingChecks:100,failingChecks:0,unknownChecks:0}},true));
    const message=b.event(r.delivered());ok(storage.commitEvent({message,effects:[{kind:'trip.close',tripUuid:second,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'partial',endedUtcMs:3000}]}));
    expect(ok(storage.journalTrip(first)).trip).toMatchObject({isHardMode:false,hardModeDetails:{version:1,firstLoss:{reason:'historical'}}});
    ok(storage.close());readOnly(ws.database,sql=>expect(sql.prepare('SELECT hard_mode_details FROM trips WHERE trip_uuid=?').pluck().get(first)).toBe(bytes));
  });
  it.each(['version','private-profile','phase','sequence'] as const)('rejects malformed acceptance details atomically without exporting private evidence: %s',async fault=>{
    const storage=await ws.open(),s=new Script(ETS2_A),uuid=open(storage,s);
    const detail:Record<string,unknown>={annotation:true,cause:'observed-acceptance',phase:'pending',version:1,clearEventSeq:'1',throughEventSeq:'1',
      configurationRevision:'1',absenceMonotonicNs:'1',absenceBoundaryOrder:'1',loadGeneration:0};
    if(fault==='version')detail.version=2;if(fault==='private-profile')detail.profileScope='a'.repeat(64);
    if(fault==='phase')detail.phase='admitted';if(fault==='sequence')detail.throughEventSeq='-1';
    const message=s.event(r.fined());
    expect(storage.commitEvent({message,effects:[{kind:'completeness.add',interval:{tripUuid:uuid,kind:'discontinuity',detail}}]})).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    expect(ok(storage.committedThrough(s.session))).toBe('1');expect(ok(storage.getEvent(s.session,'2'))).toBeUndefined();ok(storage.close());
  });
  it.each(['after-driving','before-first-start','chain-break'] as const)('retains 750m and 1.5L through menu acceptance, sleep and three saved sources: %s',async scenario=>{
    const values=job({market:{available:true,value:'external_contracts'}}),signals=new EventEmitter(),coverage=new Map<string,string>(),acks:{stored:string;through:string}[]=[];
    let worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),ingestion:V1Ingestion|undefined,currentProof:ProfileObservation|undefined,qualified=true;
    const token={};let currentSink:TripRecorderSink;const prestart=scenario!=='after-driving',broken=scenario==='chain-break';let coalesced=false;
    const create=()=>{
      const commit=client.commitEvent.bind(client),gap=client.commitGap.bind(client),attach=client.openAttachedTrip.bind(client);
      client.commitEvent=async input=>{const result=await commit(input);if(result.ok)coverage.set((input.message as ServerMessage).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      client.commitGap=async input=>{const result=await gap(input);if(result.ok)coverage.set((input.message as ServerMessage).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      client.openAttachedTrip=async input=>{const result=await attach(input);if(result.ok&&input.endpoint)signals.emit('endpoint',input.monotonicNs);return result;};
      const sink=new TripRecorderSink(client,{profileEvidence:()=>qualified?currentProof:undefined,profileStatus:()=>qualified?{phase:'admitted',token}:{phase:'pending',token}}),observe=sink.observe.bind(sink);
      currentSink=sink;sink.observe=(message,context)=>{const result=observe(message,context);signals.emit('reading',message.capture.monotonicNs);return result;};
      ingestion=new V1Ingestion({sink,connect:endpoint=>{const socket=new ClientSocket(net.connect(endpoint),undefined,error=>{throw error;});
        socket.once('close',()=>{signals.emit('closed');});return socket;}});
    };
    let summary=ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));create();
    let original='',savedFuel=100,savedX=0,oldSnapshot='',minuteOffset=0;
    const minutes=(step:number)=>String(500+step+minuteOffset);
    const waitSignal=async(event:string,predicate:(value:string)=>boolean,send:()=>void)=>{
      let receive!:(value:string)=>void;
      const done=new Promise<void>(resolve=>{receive=value=>{if(predicate(value))resolve();};signals.on(event,receive);});
      try{send();await guarded(done,`continuity ${event}`,30000);}finally{signals.off(event,receive);}
    };
    try{
      for(let index=0;index<3;index++){
        if(index===2){await ingestion!.stop();expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
          summary=ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));create();}
        const s=new Script([ETS2_A,ETS2_B,'10000000-0000-4000-8000-0000000000d4'][index]),welcome=s.welcome();currentProof=proof(s);
        const endpoint=`\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${s.session}`;
        let peer:net.Socket|undefined,wire=0n,boundary=100n,last=welcome as ServerMessage,firstRunningSeen=false;
        const send=(message:ServerMessage)=>{message=structuredClone(message);message.seq=String(++wire);
          if(message.kind==='checkpoint'){message.data.boundarySeq=message.seq;message.data.state.boundaryOrder=String(++boundary);}
          if(message.kind==='snapshot')message.data.state.boundaryOrder=String(++boundary);
          if(message.kind==='event')message.data.occurred.boundaryOrder=String(++boundary);
          last=message;peer!.write(encodeFrame(message));};
        const checkpoint=s.checkpoint(null,0,{simulation:'paused'},'1');
        const server=net.createServer(socket=>{peer=socket;let buffered=Buffer.alloc(0);
          socket.on('data',chunk=>{buffered=Buffer.concat([buffered,chunk]);if(buffered.length>65536)throw new Error('Synthetic client frame overflow');
            while(buffered.length>=4&&buffered.length>=buffered.readUInt32LE()+4){const size=buffered.readUInt32LE(),message=decodePayload(buffered.subarray(4,size+4),'client') as ClientMessage;buffered=buffered.subarray(size+4);
              if(message.kind==='hello'){send(welcome);send(checkpoint);}
              if(message.kind==='ack'){acks.push({through:message.data.throughEventSeq,stored:coverage.get(message.data.pluginSessionId)??'0'});signals.emit('ack',message.data.throughEventSeq);}
              // A probe can arrive after peer.end(): the half-closed source does not answer, because a write after end is an uncaught stream error.
              if(message.kind==='clock.probe'&&!socket.writableEnded){const ns=BigInt(last.capture.monotonicNs)+3n;send({...welcome,kind:'clock.reply',capture:{clockId:s.clockId,monotonicNs:String(ns)},data:{probeId:message.data.probeId,receivedMonotonicNs:String(ns-2n),sentMonotonicNs:String(ns-1n)}});}
            }
          });
        });
        await new Promise<void>(resolve=>server.listen(endpoint,resolve));
        const event=async(record:Parameters<Script['event']>[0],simulation:'running'|'paused'='paused',revision='1',minute?:string)=>{
          const message=s.event(record,{simulation,configurationRevision:revision,advanceMs:10});
          if(prestart&&index===0&&!firstRunningSeen)message.data.occurred.gameTime.minutes={available:false,reason:'not-observed'};
          if(record.type==='simulation.started')firstRunningSeen=true;
          if(minute)message.data.occurred.gameTime={minutes:{available:true,value:minute},clockId:s.clockId};
          await waitSignal('ack',seq=>BigInt(seq)>=BigInt(message.data.eventSeq),()=>send(message));return message;
        };
        const capture=async(odo:number,fuel:number,x:number,minutes:string,simulation:'running'|'paused',ms:number,persist=false,hasJob=true,stationary=false)=>{
          const configuration=s.checkpoint(values).data.state.configuration;
          const message=s.snapshot({configuration:{...configuration,revision:hasJob?'2':'1',job:hasJob?{available:true,value:values}:{available:false,reason:'not-observed'}},simulation,
            odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},speed:{available:true,value:simulation==='paused'||stationary?0:13.44,unit:'m/s'},
            gameTime:{available:true,value:minutes,unit:'min',clockId:s.clockId},worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},ms);
          if(prestart&&!firstRunningSeen)message.data.state.gameTime={available:false,reason:'not-observed',unit:'min',clockId:s.clockId};
          if(broken&&index===0){if(odo===1000250&&simulation==='running')coalesced=true;message.data.continuity.coalescedSnapshots=coalesced?'1':'0';}
          await waitSignal(persist?'endpoint':'reading',ns=>ns===message.capture.monotonicNs,()=>send(message));return message;
        };
        try{
          await waitSignal('reading',ns=>ns===checkpoint.capture.monotonicNs,()=>ingestion!.select('synthetic',endpoint));
          const gap=s.gap(2);await waitSignal('ack',seq=>BigInt(seq)>=2n,()=>send(gap));
          if(index===0){
            await event(r.jobCleared());await event(r.truckConfigured());await event(r.timersRestart());await event(r.gameMode(mode));
            if(scenario==='after-driving')for(let n=0;n<3;n++){await event(r.started(),'running');await event(r.paused());}
            qualified=false;await capture(1000000,100,0,'500','paused',100,false,false);
            const opened=await event(r.jobConfigured(values),'paused','2');original=tripUuidFor(s.session,opened.data.eventSeq);
            currentProof={...proof(s),afterMonotonicNs:opened.capture.monotonicNs};qualified=true;
            await event(r.started(),'running','2');await capture(1000000,100,0,'500','running',1000);
            await event(r.paused(),'paused','2');await capture(1000000,100.015625,0.001953125,'500','paused',100,true);
            for(let n=0;n<7;n++)await capture(1000000,100.015625,0.001953125,'500','paused',1000);
            qualified=false;await capture(1000000,100.015625,0.001953125,'500','paused',10);qualified=true;
            savedFuel=100.015625;savedX=0.001953125;
          }else{
            await event(r.jobConfigured(values),'paused','2');
            savedFuel+=0.01171875;savedX+=prestart?(index===1?0.017:0.009):0.001953125;
            await capture(1000000+index*250,savedFuel,savedX,minutes(index),'paused',100,true);
          }
          if(broken&&index===0)succeeded(await currentSink!.samples.write(3600,true));
          await event(r.started(),'running','2');
          if(prestart&&index>0)await capture(1000000+index*250,savedFuel,savedX,minutes(index),'running',1000,false,true,true);
          savedFuel-=0.5;savedX+=13.318;
          await capture(1000000+(index+1)*250,savedFuel,savedX,minutes(index+1),'running',1007);
          if(prestart&&index===0){
            await event(r.paused(),'paused','2',minutes(1));await capture(1000250,savedFuel,savedX,minutes(1),'paused',100,true);
            await event(r.started(),'running','2');minuteOffset+=540;
            await capture(1000250,savedFuel,savedX,minutes(1),'running',1000,false,true,true);
          }
          if(scenario==='before-first-start') {
            // The saved-endpoint/stationary resume and Hard Mode member totals survive the same worker restart.
            const member=currentSink!.view('ets2').current!.tripUuid,unknownChecks=index===1?2:0;
            ok(await client.observeHardMode('ets2',{assessment:evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG),1000+index,'fixture'),
              binding:'b'.repeat(64),pluginSessionId:s.session,sourceMonotonicNs:'0',member,
              batch:{tripUuid:member,producer:'90000000-0000-4000-8000-000000000001',sequence:1+unknownChecks,passingChecks:1,failingChecks:0,unknownChecks}},true));
          }
          if(index<2){
            if(prestart&&index===1){
              await capture(1000500,savedFuel,savedX,minutes(2),'running',1000,false,true,true);
              minuteOffset++;await event(r.paused(),'paused','2',minutes(2));
            }else{
              await event(r.paused(),'paused','2',minutes(index+1));savedFuel+=0.0087890625;savedX+=0.001953125;
              await capture(1000000+(index+1)*250,savedFuel,savedX,minutes(index+1),'paused',100,true);
            }
            await event(r.fined(),'paused','2');
          }
          else {await event(r.delivered(),'paused','2');await ingestion!.stop();}
          if(prestart&&index===1)succeeded(await currentSink!.samples.write(3600,true));
          const detail=validateJournalTripDetail(ok(await client.journalTrip(original)));
          expect(detail.trip.recordingCompleteness,`source ${index}`).toBe('complete');if(broken){expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.fuelUsedL.available).toBe(false);}
          else{expect(detail.trip.observedDistanceM).toEqual({available:true,value:(index+1)*250});expect(detail.trip.fuelUsedL.available&&detail.trip.fuelUsedL.value).toBeCloseTo((index+1)*0.5,9);}
          expect(ok(await client.journalTrips()).trips.map(row=>row.tripUuid)).toEqual([original]);if(index===0)oldSnapshot=detail.exportBounds.snapshot!.samples;
          if(index<2)await waitSignal('closed',()=>true,()=>peer!.end());
        }finally{peer?.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
      }
      await ingestion!.stop();
      const detail=ok(await client.journalTrip(original));expect(detail.trip.outcome).toBe('delivered');expect(ok(await client.listTrips()).trips).toHaveLength(3);
      if(scenario==='before-first-start')expect(detail.trip).toMatchObject({isHardMode:true,hardModeDetails:{version:2,passingChecks:3,failingChecks:0,unknownChecks:2}});
      expect(ok(await client.listSamples({tripUuid:original},{afterId:oldSnapshot,includeExcluded:true}))).toHaveLength(prestart?3:2);
      const service=new JournalService({history:{state:'open',failureCode:null,client,database:{purpose:'synthetic',schemaVersion:8},databaseUuid:summary.databaseUuid},stopping:()=>false,log:()=>undefined});
      const filename=path.join(ws.directory,'continuity.json'),exporter=new JournalExporter({read:query=>service.query(query),showSaveDialog:()=>Promise.resolve({canceled:false,filePath:filename}),documents:()=>undefined,localAppData:ws.directory,appVersion:'test',log:()=>undefined});
      expect(await exporter.export(original)).toMatchObject({ok:true,value:{outcome:'saved'}});
      const exported=JSON.parse(readFileSync(filename,'utf8')) as {formatVersion:number;trip:unknown;intervals:unknown[];sources:unknown[];events:{type:string}[];samples:unknown[]};
      expect(exported.formatVersion).toBe(5);expect(exported.intervals.length).toBeGreaterThan(0);expect(JSON.stringify(exported.intervals)).not.toMatch(/[a-f0-9]{64}/);
      expect(exported.trip).toMatchObject({outcome:'delivered',recordingCompleteness:'complete',observedDistanceM:broken?{available:false}:{available:true,value:750},fuelUsedL:broken?{available:false}:{available:true,value:1.5}});
      const breaks=(exported.intervals as {cause:string;detail:unknown}[]).filter(note=>note.cause==='accounting-chain-break');
      if(broken)expect(breaks).toMatchObject([{detail:{version:1,reason:'missing-predecessor',recorderReset:'snapshot-coalesced',distanceLost:true,fuelLost:true}}]);else expect(breaks.map(note=>note.detail)).toEqual([]);
      if(scenario==='before-first-start')expect(exported.trip).toMatchObject({is_hard_mode:true,hard_mode_details:{version:2,passingChecks:3,failingChecks:0,unknownChecks:2}});
      expect(exported.sources).toHaveLength(3);expect(exported.events.filter(event=>event.type==='job.delivered')).toHaveLength(1);expect(exported.samples).toHaveLength(prestart?8:4);
      for(const ack of acks)expect(BigInt(ack.through)).toBeLessThanOrEqual(BigInt(ack.stored));
      expect(await client.close()).toEqual({clean:true});
    }finally{await ingestion?.stop();}
  },60_000);
  it('persists one bounded accounting diagnostic with the sample, including distinct source and storage UTC',async()=>{
    const storage=await ws.open(),s=new Script(ETS2_A),base=ws.now()-10000;
    ok(storage.upsertSession({message:s.welcome()}));ok(storage.commitEvent({message:s.event(r.started())}));const uuid=open(storage,s);
    for(let second=3;second<=6;second++){
      const row=seedSample(s,uuid,second,base+second*1000,{speed:{available:true,value:20},odometer:{available:true,value:1000000+(second-3)*100},
        fuel:{available:true,value:100-(second-3)*0.2},position:{available:true,value:{x:(second-3)*5,y:0,z:0}},gameTime:{minutes:{available:true,value:500},clockId:s.clockId},
        recording:{profile:proof(s),job:job(),truck:'same-truck',processInstanceId:s.welcome().source.processInstanceId,
          ...(second===5?{predecessorReset:'snapshot-coalesced' as const}:{}),
          ...(second===4||second===6?{previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:String(5_000_000_000_000n+BigInt(second-1)*1_000_000_000n)}}:{})}});
      ok(storage.appendSamples(s.session,[row],{uniqueSeconds:true}));
      expect(ok(storage.appendSamples(s.session,[row],{uniqueSeconds:true})).appended).toBe(0);
    }
    const notes=ok(storage.journalIntervals(uuid,{limit:100})).intervals.filter(note=>note.cause==='accounting-chain-break');
    expect(notes).toHaveLength(1);expect(notes[0]).toMatchObject({annotation:true,endUtcMs:base+5000,detail:{reason:'missing-predecessor',recorderReset:'snapshot-coalesced',sameTruck:true,sameGameClock:true,odometerStep:'continuous',odometerDeltaM:100,positionDeltaM:5}});
    expect(ok(storage.journalTrip(uuid)).trip.recordingCompleteness).toBe('complete');storage.close();
    readOnly(ws.database,db=>expect(db.prepare("SELECT created_utc_ms FROM completeness_intervals WHERE json_extract(detail_json,'$.cause')='accounting-chain-break'").pluck().get()).toBe(ws.now()));
  });
  it('rejects arbitrary recorder reset data atomically instead of retaining it in diagnostics',async()=>{
    const storage=await ws.open(),script=new Script(ETS2_A);ok(storage.upsertSession({message:script.welcome()}));const uuid=open(storage,script);
    const first=seedSample(script,uuid,1,1000,{recording:{profile:proof(script),job:job(),truck:'same-truck',processInstanceId:script.welcome().source.processInstanceId}});
    const invalid=structuredClone(first);invalid.monotonicNs='6000000000000';
    (invalid.recording as unknown as Record<string,unknown>).predecessorReset='synthetic/private-profile';
    failed(storage.appendSamples(script.session,[first,invalid]),'INVALID_INPUT');expect(ok(storage.listSamples({tripUuid:uuid}))).toHaveLength(0);storage.close();
  });
  it.each(['confirmed','missing-pause','wrong-clock','old-pause','moving','too-far','two-minutes','another-source','after-resume','null-pause','missing-pause-time'] as const)(
    'requires an actual stationary pause witness for a saved minute tick: %s',async variant=>{
      const storage=await ws.open(),a=new Script(ETS2_A),b=new Script(ETS2_B);
      ok(storage.upsertSession({message:a.welcome()}));ok(storage.commitEvent({message:a.event(r.started())}));const uuid=open(storage,a);
      for(const [second,odo,x,fuel] of [[1003,1000000,0,100],[1004,1000250,13,99.5]]){
        const row=seedSample(a,uuid,second,1000+second*1000,{
          speed:{available:true,value:second===1003||variant==='moving'?20:0},odometer:{available:true,value:odo},fuel:{available:true,value:fuel},
          position:{available:true,value:{x,y:0,z:0}},gameTime:{minutes:{available:true,value:500},clockId:a.clockId},
          recording:{profile:proof(a),job:job(),truck:'same-truck',processInstanceId:a.welcome().source.processInstanceId,
            ...(second===1004?{previous:{tripUuid:uuid,sourceClockId:a.clockId,monotonicNs:'1003000000000'}}:{})}});row.monotonicNs=String(BigInt(second)*1_000_000_000n);ok(storage.appendSamples(a.session,[row]));
      }
      if(variant!=='missing-pause'){
        const source=variant==='another-source'?new Script('10000000-0000-4000-8000-000000000099'):a;
        if(source!==a)ok(storage.upsertSession({message:source.welcome()}));
        if(variant==='after-resume')ok(storage.commitEvent({message:a.event(r.started(),{advanceMs:2200})}));
        const paused=source.event(r.paused(),{simulation:'paused',advanceMs:variant==='old-pause'?6000:variant==='after-resume'?300:2501});
        paused.data.occurred.gameTime={minutes:{available:true,value:'501'},clockId:variant==='wrong-clock'?b.clockId:a.clockId};
        ok(storage.commitEvent({message:paused}));
      }
      close(storage,a,uuid);ok(storage.upsertSession({message:b.welcome()}));ok(storage.commitGap({message:b.gap(2)}));
      const event=b.event(r.jobConfigured(),{simulation:'paused'}),next=tripUuidFor(b.session,event.data.eventSeq);
      ok(storage.commitEvent({message:event,profile:proof(b),effects:[{kind:'trip.open',tripUuid:next,game:b.game,gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'unknown',startedUtcMs:2000}]}));
      const prepareOriginal=Database.prototype.prepare;
      const malformed=variant==='null-pause'||variant==='missing-pause-time';
      const spy=malformed?vi.spyOn(Database.prototype,'prepare').mockImplementation(function(this:Database.Database,sql:string){
        const statement=prepareOriginal.call(this,sql);
        if(sql.includes("e.type='simulation.paused'")){
          const get=statement.get.bind(statement) as (...parameters:unknown[])=>unknown;
          statement.get=(...parameters:unknown[])=>{const row=get(...parameters) as Record<string,unknown>|undefined;
            return row?{...row,payload_json:variant==='null-pause'?'null':'{}'}:undefined;};
        }
        return statement;
      }):undefined;
      try{ok(storage.openAttachedTrip({pluginSessionId:b.session,nextEventSeq:'4',job:job(),effects:[],observeTripUuid:next,profile:proof(b),sourceClockId:b.clockId,monotonicNs:'1003500000000',
        endpoint:{version:1,simulation:'paused',truck:'same-truck',odometerM:1000250,fuelL:99.509,speedMps:0.004,gameClockId:b.clockId,
          gameMinutes:variant==='two-minutes'?'502':'501',position:{x:variant==='too-far'?13.051:13.017,y:0,z:0}}}));}finally{spy?.mockRestore();}
      ok(storage.commitEvent({message:b.event(r.started(),{advanceMs:2000})}));
      const result=ok(storage.journalTrip(uuid));
      if(variant==='confirmed'){expect(result.trip.recordingCompleteness).toBe('complete');expect(result.trip.observedDistanceM).toEqual({available:true,value:250});expect(result.trip.fuelUsedL).toEqual({available:true,value:0.5});}
      else expect(result.trip.recordingCompleteness).not.toBe('complete');storage.close();
    });
  it.each(['never-matches','later-continuous-match','delayed-minute','delayed-minute-reopen','delayed-movement','delayed-hole','delayed-missing-predecessor','delayed-never-matches','delayed-lost-profile','incomplete-fuel','incomplete-position','incomplete-fuel-pause-match','incomplete-fuel-pause-moved','unqualified-profile','absent-profile'] as const)('bounds saved-baseline search while awaiting complete stationary evidence: %s',async variant=>{
    let storage=await ws.open();const a=new Script(ETS2_A),b=new Script(ETS2_B),delayed=variant.startsWith('delayed-');
    ok(storage.upsertSession({message:a.welcome()}));ok(storage.commitEvent({message:a.event(r.started())}));const uuid=open(storage,a);
    const append=(source:Script,trip:string,second:number,x:number,fuel:number,previous?:string,minute:number|null=500,speed=second===1003?20:0)=>{
      const row=seedSample(source,trip,second,1000+second*1000,{speed:{available:true,value:speed},
        odometer:{available:true,value:second===1003?1000000:1000250},fuel:{available:true,value:fuel},position:{available:true,value:{x,y:0,z:0}},
        gameTime:{minutes:minute===null?{available:false,reason:'not-observed'}:{available:true,value:minute},clockId:source.clockId},recording:{profile:proof(source),job:job(),truck:'same-truck',
          processInstanceId:source.welcome().source.processInstanceId,...(previous?{previous:{tripUuid:trip,sourceClockId:source.clockId,monotonicNs:previous}}:{})}});
      if(source===b && second===2001){
        if(variant.startsWith('incomplete-fuel'))row.fuel={available:false,reason:'not-observed'};
        if(variant==='incomplete-position')row.position={available:false,reason:'not-observed'};
        if(variant==='absent-profile')delete row.recording!.profile;
        if(variant==='unqualified-profile')row.recording!.profile={...proof(b),afterMonotonicNs:'9999000000000'};
      }
      if(source===b && second===2002 && variant==='delayed-lost-profile')delete row.recording!.profile;
      row.monotonicNs=String(BigInt(second)*1_000_000_000n);ok(storage.appendSamples(source.session,[row]));
    };
    append(a,uuid,1003,0,100);append(a,uuid,1004,13,99.5,'1003000000000');close(storage,a,uuid);
    ok(storage.upsertSession({message:b.welcome()}));ok(storage.commitGap({message:b.gap(2)}));
    const configured=b.event(r.jobConfigured(),{simulation:'paused'}),next=tripUuidFor(b.session,configured.data.eventSeq);
    ok(storage.commitEvent({message:configured,profile:proof(b),effects:[{kind:'trip.open',tripUuid:next,game:b.game,gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'unknown',startedUtcMs:2000}]}));
    ok(storage.commitEvent({message:b.event(r.started())}));
    const prepare=vi.spyOn(Database.prototype,'prepare');
    const searches=()=>prepare.mock.calls.filter(([sql])=>sql.includes('ORDER BY p.id DESC LIMIT 65')).length;
    try{
      if(variant.startsWith('incomplete-')||variant==='absent-profile'||variant==='unqualified-profile'){
        append(b,next,2001,13.017,99.509);expect(searches()).toBe(0);
        const first=ok(storage.journalTrip(uuid));expect(first.trip.recordingCompleteness).not.toBe('complete');expect(first.trip.fuelUsedL.available).toBe(false);
        const pause=variant.includes('-pause-');
        if(pause){
          ok(storage.openAttachedTrip({pluginSessionId:b.session,nextEventSeq:'5',job:job(),effects:[],observeTripUuid:next,profile:proof(b),sourceClockId:b.clockId,monotonicNs:'2002000000000',
            endpoint:{version:1,simulation:'paused',truck:'same-truck',odometerM:variant.endsWith('-moved')?1000350:1000250,fuelL:99.5,speedMps:0,gameClockId:b.clockId,gameMinutes:'500',position:{x:13,y:0,z:0}}}));
          const after=ok(storage.journalTrip(uuid));
          if(variant.endsWith('-match')){expect(after.trip.recordingCompleteness).toBe('complete');expect(after.trip.fuelUsedL).toEqual({available:true,value:0.5});}
          else expect(after.trip.recordingCompleteness).not.toBe('complete');
        }
        ok(storage.close());
        // Missing evidence keeps the durable resume decision pending; it must not latch a real loss.
        readOnly(ws.database,db=>{
          const coverage=JSON.parse(db.prepare('SELECT row_json FROM logical_projection_states WHERE id=(SELECT state_ref FROM logical_revisions WHERE logical_ref=(SELECT id FROM logical_trips WHERE trip_uuid=?) ORDER BY id DESC LIMIT 1)').pluck().get(uuid) as string)._coverage;
          expect(coverage).toMatchObject({phase:variant.endsWith('-match')?'resumed':'pending',losses:variant.endsWith('-moved')?16:0,sampleResumePending:false});
        });
        return;
      }
      if(delayed){
        append(b,next,2001,13.017,99.509,undefined,null);expect(searches()).toBe(0);
        const second=variant==='delayed-hole'?2007:2002;
        append(b,next,second,13.017,99.509,variant==='delayed-missing-predecessor'?undefined:'2001000000000',null,variant==='delayed-movement'?1:0);expect(searches()).toBe(0);
        if(variant==='delayed-minute-reopen'||variant==='delayed-lost-profile'){
          ok(storage.close());
          if(variant==='delayed-lost-profile')readOnly(ws.database,db=>{
            const coverage=JSON.parse(db.prepare('SELECT row_json FROM logical_projection_states WHERE id=(SELECT state_ref FROM logical_revisions WHERE logical_ref=(SELECT id FROM logical_trips WHERE trip_uuid=?) ORDER BY id DESC LIMIT 1)').pluck().get(uuid) as string)._coverage;
            expect(coverage).toMatchObject({phase:'pending',losses:0,sampleResumePending:false});
          });
          storage=await ws.open();
        }
        append(b,next,second+1,13.017,99.509,String(BigInt(second)*1_000_000_000n),variant==='delayed-never-matches'?501:500);
        expect(searches()).toBeLessThanOrEqual(1);prepare.mockClear();
        for(let n=2;n<=9;n++)append(b,next,second+n,13.017,99.509,String(BigInt(second+n-1)*1_000_000_000n));
        expect(searches()).toBe(0);const result=ok(storage.journalTrip(uuid));
        if(variant==='delayed-minute'||variant==='delayed-minute-reopen'){
          expect(result.trip.recordingCompleteness).toBe('complete');expect(result.trip.observedDistanceM).toEqual({available:true,value:250});expect(result.trip.fuelUsedL).toEqual({available:true,value:0.5});
        }else{expect(result.trip.recordingCompleteness).not.toBe('complete');expect(result.trip.fuelUsedL.available).toBe(false);}
        return;
      }
      append(b,next,2001,13.1,99.5);expect(searches()).toBe(1);prepare.mockClear();
      for(let second=2002;second<=2009;second++)append(b,next,second,variant==='later-continuous-match'?13.017:13.1+(second-2001)*0.01,99.509,String(BigInt(second-1)*1_000_000_000n));
      expect(searches()).toBe(0);
      const detail=ok(storage.journalTrip(uuid));expect(detail.trip.recordingCompleteness).not.toBe('complete');
      expect(detail.trip.fuelUsedL.available).toBe(false);expect(detail.trip.observedDistanceM).toEqual({available:true,value:250});
    }finally{prepare.mockRestore();storage.close();}
  });
  it.each(['observed','running','no-absence-reading','before-first-start','prestart-gap','prestart-replayed','prestart-regression','prestart-reset','prestart-previous-job','prestart-checkpoint','first-job','first-job-with-gap','configured-before-timer','reset-before-config','replayed','replayed-clear','gap-after-absence','gap-before-clear','gap-before-clear-recovered','previous-configuration','regression-before-config','no-profile','pending-profile','late-profile'] as const)(
    'recognizes a contiguous new job independently of pause and profile timing: %s', async variant=>{
      const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
      ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
      let currentProof=proof(s),qualified=true,clock=s.clockId,order=100;const token={};
      const recorder=new TripRecorderSink(client,{profileEvidence:()=>qualified?currentProof:undefined,
        profileStatus:()=>qualified?{phase:'admitted',token}:{phase:'pending',token}});
      succeeded(await recorder.openSession(s.welcome()));
      const checkpoint=s.checkpoint(null,0,{simulation:'paused'},'1');succeeded(recorder.observe(checkpoint,context));
      if(variant!=='first-job')succeeded(await recorder.commit(s.gap(2),context));
      const event=async(record:Parameters<Script['event']>[0],simulation:'running'|'paused'='paused',revision='1')=>{
        const message=s.event(record,{simulation,configurationRevision:revision,advanceMs:100});message.capture.clockId=clock;message.data.occurred.boundaryOrder=String(++order);
        if((variant==='replayed'||variant==='prestart-replayed') && record.type==='job.configured' || variant==='replayed-clear' && record.type==='job.cleared')message.data.redelivered=true;
        succeeded(await recorder.commit(message,context));return message;
      };
      if(variant!=='first-job'&&variant!=='first-job-with-gap')await event(r.jobCleared());else await event(r.gameMode(mode));
      await event(r.truckConfigured());
      clock='30000000-0000-4000-8000-000000000099';currentProof={...currentProof,sourceClockId:clock,loadGeneration:1};
      await event(r.timersRestart());await event(r.gameMode(mode));
      if(variant!=='before-first-start'&&!variant.startsWith('prestart-'))for(let n=0;n<3;n++){await event(r.started(),'running');await event(r.paused());}
      const values=job(),configuration=s.checkpoint(values).data.state.configuration;
      const capture=async(odo:number,fuel:number,x:number,simulation:'running'|'paused',hasJob:boolean,ms=1000)=>{
        const message=s.snapshot({configuration:{...configuration,revision:hasJob?'2':'1',job:hasJob?{available:true,value:values}:{available:false,reason:'not-observed'}},simulation,
          odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},speed:{available:true,value:simulation==='paused'?0:13,unit:'m/s'},
          gameTime:{available:true,value:odo===1000000?'500':'501',unit:'min',clockId:clock},
          worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}},boundaryOrder:String(++order)},ms);
        message.capture.clockId=clock;succeeded(recorder.observe(message,context));if(recorder.attach.due())succeeded(await recorder.attach.open(context));
      };
      if(variant==='pending-profile'||variant==='late-profile'||variant==='no-profile')qualified=false;
      if(variant!=='no-absence-reading')await capture(1000000,100,0,'paused',false);
      if(variant==='reset-before-config'||variant==='prestart-reset')await event(r.timersRestart());
      if(variant==='regression-before-config'||variant==='prestart-regression')await event(r.regression('500','400'));
      if(variant==='prestart-previous-job'){await event(r.jobConfigured(otherJob()));await event(r.cancelled());await event(r.jobCleared());}
      if(variant==='prestart-checkpoint'){succeeded(recorder.observe(s.checkpoint(null,0,{simulation:'paused'},'1'),context));await event(r.jobCleared());}
      if(variant==='gap-before-clear'||variant==='gap-before-clear-recovered'){
        // The missing range can contain a save load. A clear alone cannot restore the older start's trust.
        succeeded(await recorder.commit(s.gap(4),context));await event(r.jobCleared());
        if(variant==='gap-before-clear-recovered'){await event(r.started(),'running');await event(r.paused());}
      }
      if(variant==='previous-configuration'){await event(r.jobConfigured(otherJob()),'running','2');await event(r.cancelled(),'running','2');}
      if(variant==='gap-after-absence'||variant==='prestart-gap')succeeded(await recorder.commit(s.gap(1),context));
      const configured=await event(r.jobConfigured(values),variant==='running'?'running':'paused','2'),uuid=tripUuidFor(s.session,configured.data.eventSeq);
      if(variant==='late-profile')currentProof={...currentProof,afterMonotonicNs:configured.capture.monotonicNs};
      if(variant==='configured-before-timer')await event(r.timersRestart());
      qualified=variant!=='no-profile';
      await event(r.started(),'running','2');
      await capture(1000000,100,0,'running',true);await capture(1000250,99.5,13,'running',true);
      succeeded(await recorder.samples.write(3600,true));await event(r.fined(),'running','2');
      const detail=ok(await client.journalTrip(uuid));
      if(variant==='before-first-start')expect(ok(await client.journalIntervals(uuid,{limit:100})).intervals).toEqual(expect.arrayContaining([expect.objectContaining({cause:'menu-job-acceptance'})]));
      if(['observed','running','no-absence-reading','pending-profile','late-profile','gap-before-clear-recovered','first-job','before-first-start'].includes(variant))expect(detail.trip.recordingCompleteness).toBe('complete');
      else expect(detail.trip.recordingCompleteness).not.toBe('complete');
      expect(await client.close()).toEqual({clean:true});
      if(variant==='no-profile'||variant==='first-job'||variant==='first-job-with-gap')readOnly(ws.database,db=>{
        const row=db.prepare(`SELECT l.profile_scope,s.row_json FROM logical_trips l JOIN logical_memberships m ON m.logical_ref=l.id
          JOIN trips t ON t.id=m.trip_ref JOIN logical_revisions r ON r.id=(SELECT max(id) FROM logical_revisions WHERE logical_ref=l.id)
          JOIN logical_projection_states s ON s.id=r.state_ref WHERE t.trip_uuid=?`).get(uuid) as {profile_scope:string|null;row_json:string};
        if(variant==='no-profile')expect(row.profile_scope).toBeNull();else expect(row.profile_scope).not.toBeNull();
        expect(JSON.parse(row.row_json)._coverage.start).toBe(variant==='first-job-with-gap'?'unproven':'observed');
      });
    });
  it.each(['plain','intermediate','same-second-pending','steady-pause','steady-pause-pending','stale-qualified','long-pending','profile-change','load-change','revoked','coalesced','offline'] as const)(
    'keeps the owned predecessor of a corroborated 250m step: %s', async variant => {
      const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
      ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
      let qualified=true,token={},captured=proof(s);const written:SampleInput[]=[];
      const append=client.appendSamples.bind(client);client.appendSamples=(session,rows,options)=>{written.push(...structuredClone(rows));return append(session,rows,options);};
      const recorder=new TripRecorderSink(client,{profileEvidence:()=>qualified?captured:undefined,
        profileStatus:()=>qualified?{phase:'admitted',token}:{phase:'pending',token}});
      succeeded(await recorder.openSession(s.welcome()));succeeded(recorder.observe(s.checkpoint(null),context));
      succeeded(await recorder.commit(s.event(r.started()),context));const configured=s.event(r.jobConfigured());succeeded(await recorder.commit(configured,context));
      const uuid=tripUuidFor(s.session,configured.data.eventSeq),configuration=s.checkpoint(job()).data.state.configuration;
      const capture=async(odo:number,fuel:number,x:number,minutes:string,simulation:'running'|'paused',ms:number,open=true)=>{
        const message=s.snapshot({configuration,simulation,odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},
          speed:{available:true,value:simulation==='paused'?0:odo===1000000?13.44:12.81,unit:'m/s'},gameTime:{available:true,value:minutes,unit:'min',clockId:s.clockId},
          worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},ms);
        if(variant==='coalesced' && !qualified)message.data.continuity.coalescedSnapshots='1';
        if(variant==='offline' && !qualified)message.data.continuity.offlineTransitions='1';
        succeeded(recorder.observe(message,context));if(open && recorder.attach.due())succeeded(await recorder.attach.open(context));return message;
      };
      const first=await capture(1000000,100,0,'500','running',1000);
      if(variant==='intermediate')await capture(1000000,100,0,'500','running',100);
      if(variant==='same-second-pending'){
        qualified=false;await capture(1000000,100,0,'500','running',100);qualified=true;
      }
      let predecessor=first.capture.monotonicNs;
      if(!['plain','intermediate','same-second-pending'].includes(variant)){
        succeeded(await recorder.commit(s.event(r.paused(),{simulation:'paused',advanceMs:100}),context));
        predecessor=(await capture(1000000,100,0,'500','paused',0)).capture.monotonicNs;
        for(let second=0;second<7;second++)await capture(1000000,100,0,'500','paused',1000);
        if(variant!=='steady-pause'){
          qualified=false;await capture(1000000,100,0,'500','paused',variant==='stale-qualified'?6010:10);
          if(variant==='long-pending')await capture(1000000,100,0,'500','paused',5000);
          if(variant==='profile-change')captured={...captured,scope:'c'.repeat(64),binding:'d'.repeat(64)};
          if(variant==='load-change')captured={...captured,loadGeneration:2};
          if(variant==='revoked')token={};
          qualified=true;
        }
        succeeded(await recorder.commit(s.event(r.started(),{advanceMs:10}),context));
      }
      await capture(1000250,99.5,13.318,'501','running',variant==='intermediate'||variant==='same-second-pending'?906:1006);
      succeeded(await recorder.samples.write(3600,true));
      succeeded(await recorder.commit(s.event(r.fined(),{advanceMs:0}),context));
      const raw=ok(await client.getTrip(uuid))!;expect(raw.observedDistanceM).toEqual({available:true,value:variant==='profile-change'?0:250});
      if(variant==='profile-change')expect(ok(await client.listTrips()).trips).toHaveLength(2);
      const veto=['stale-qualified','long-pending','profile-change','load-change','revoked','coalesced','offline'].includes(variant);
      if(!veto)expect(written.at(-1)?.recording?.previous?.monotonicNs).toBe(predecessor);
      expect(await client.close()).toEqual({clean:true});
      readOnly(ws.database,db=>{
        const head=db.prepare('SELECT p.distance_m,p.fuel_used_l FROM logical_trips t JOIN logical_progress p ON p.id=t.progress_head WHERE t.trip_uuid=?').get(uuid) as {distance_m:number|null;fuel_used_l:number|null};
        if(variant==='profile-change')expect(head.distance_m).toBe(0);
        else if(veto)expect(head.distance_m).toBeNull();
        else {expect(head.distance_m,`${variant}: sampled predecessor ${first.capture.monotonicNs}`).toBe(250);expect(head.fuel_used_l).toBe(0.5);}
      });
    });
  it('names a missing wired stage with real timers while scenario time is stopped',async()=>{
    vi.useFakeTimers();
    await expect(wiredGuarded(new Promise<void>(()=>undefined),'synthetic: missing callback',realNow()+1)).rejects.toThrow('Hang guard: synthetic: missing callback');
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['discovery-empty-account','discovery-cloud','partial-byte-timeout','partial-byte-utf8','partial-byte-unbounded','partial-bytes','partial-byte-missing','partial-config','partial-delete','identity-root','identity-profile','identity-load','identity-namespace','identity-load-after-settings-error','identity-unchanged','identity-append','identity-replaced','identity-missing','identity-redirect','identity-settings','identity-settings-error','watchdog-timer','watchdog-getter','unchanged','witness','admitted-consumption','admitted-refuel','admitted-refuel-recheck','admitted-regression','admitted-long-unchanged','admitted-long-motion','admitted-persist-revoked','revoked','profile','load','gap','clock','truck','job','refuel','teleport','missing','unqualified-sample','over-limit'] as const)('retains only a qualified predecessor through wired lifecycle verification: %s',async variant=>{
    vi.useFakeTimers();const deadline=realNow()+25_000,retirement=new AbortController(),launched:Promise<unknown>[]=[];
    let retired=false,primary:unknown,hasPrimary=false;
    const active=()=>{if(retired){const reason:unknown=retirement.signal.reason;throw reason;}};
    const retire=(reason:unknown)=>{if(!retired){retired=true;retirement.abort(reason);}};
    const wait=async<T>(work:T,stage:string):Promise<Awaited<T>>=>{
      active();
      try{const value=await wiredGuarded(Promise.resolve(work),`${variant}: ${stage}`,deadline,retirement.signal);active();return value;}
      catch(error){if(error instanceof WiredHangGuardError&&!retired){console.error(error.message);retire(error);}throw error;}
    };
    const launch=<T>(work:Promise<T>)=>{launched.push(work);void work.catch(()=>undefined);return work;};
    const watchdog=variant.startsWith('watchdog-');let clientNs=0n,wireSeq=0n,boundary=100n;const revision='1';const now=()=>++clientNs;const diagnostics:string[]=[];
    // The production close grace stays: this case asserts no clean close, and its cleanup has its own 4 s budget below TEST_CLOSE_GRACE_MS.
    const worker=storageWorker(),client=new StorageClient(worker.handle),script=new Script(ETS2_A),welcome=script.welcome();
    let holdPersist=false,persistHeld=false,enterPersist!:()=>void,releasePersist!:()=>void;
    const persistEntered=new Promise<void>(resolve=>{enterPersist=resolve;}),persistRelease=new Promise<void>(resolve=>{releasePersist=resolve;}),persist=client.openAttachedTrip.bind(client);
    const endpointScopes:string[]=[];
    client.openAttachedTrip=async input=>{if(input.endpoint&&input.profile)endpointScopes.push(input.profile.scope);if(holdPersist&&!persistHeld&&input.endpoint){persistHeld=true;enterPersist();await persistRelease;}return persist(input);};
    let fixtureInput=ws.directory;
    if(variant==='discovery-cloud'||variant==='partial-config'){
      const target=path.join(ws.directory,'profile-fixture'),alias=path.join(ws.directory,'profile-fixture-alias');
      await mkdir(target);await symlink(target,alias,'junction');fixtureInput=alias;
    }
    // All exact file gates share the reader's canonical basis, including aliased Windows TEMP roots.
    const fixtureRoot=await realpath(fixtureInput);
    if(fixtureInput!==ws.directory)expect(fixtureRoot).not.toBe(fixtureInput);
    const documents=path.join(fixtureRoot,'Documents'),game=path.join(documents,'Euro Truck Simulator 2'),id=Buffer.from('Synthetic').toString('hex').toUpperCase(),directory=path.join(game,variant.startsWith('discovery-')?'steam_profiles':'profiles',id);
    await mkdir(directory,{recursive:true});
    const log=`log created on : Wednesday October 21 2026 @ 12:00:00\nNew profile selected: Synthetic\nLoading save. /home/profiles/${id}/save/autosave/game.sii\n`;
    const steam=path.join(fixtureRoot,'Steam'),userdata=path.join(steam,'userdata'),remote=path.join(userdata,'100','227300','remote','profiles',id);
    if(variant.startsWith('discovery-')){await mkdir(remote,{recursive:true});await writeFile(path.join(remote,'config.cfg'),HARD_MODE_CONFIG);await utimes(userdata,new Date('2026-10-20T12:00:00Z'),new Date('2026-10-20T12:00:00Z'));}
    await writeFile(path.join(game,'game.log.txt'),variant.startsWith('discovery-')?log.replace('/home/','/steam/'):log);await writeFile(path.join(game,'config.cfg'),'uset g_traffic "1"');
    await writeFile(path.join(directory,'config_local.cfg'),'uset g_brake_intensity "0.75"');await writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG);
    let holdGuard=false,guardHeld=false,holdSettings=false,holdLocation=false,failSettings=false,partialMetadata=false,partialBytes=false,preserveMetadata=false,bytesDeleted=false,metadataObserved!:()=>void,enterGuard!:()=>void,releaseGuard!:()=>void,watchdogWork:Promise<void>|undefined,physicalStarts=0;
    let emptyDiscovery=false,emptyPhase=0;let discovery=false,discoveryPhase=0;const metadataBaseline=new Map<string,BigIntStats>();
    const guardEntered=new Promise<void>(resolve=>{enterGuard=resolve;}),guardRelease=new Promise<void>(resolve=>{releaseGuard=resolve;});
    const observedMetadata=new Promise<void>(resolve=>{metadataObserved=resolve;});
    const reader=new HardModeReader({documents,steamRoot:steam,diagnostic:value=>diagnostics.push(value.code),fixtureOrigin:'synthetic',nowNs:now,
      profileDirectory:async parent=>{if(holdLocation){enterGuard();await guardRelease;}return opendir(parent);},
      metadata:{realpath:async filename=>{if(emptyDiscovery&&filename===userdata&&++emptyPhase===2){await mkdir(path.join(userdata,'101','227300','remote','profiles'),{recursive:true});await utimes(userdata,new Date('2026-10-22T12:00:00Z'),new Date('2026-10-22T12:00:00Z'));}if(discovery&&filename===userdata){discoveryPhase++;if(discoveryPhase===3){const duplicate=path.join(userdata,'101','227300','remote','profiles',id);await mkdir(duplicate,{recursive:true});await writeFile(path.join(duplicate,'config.cfg'),HARD_MODE_CONFIG);await utimes(userdata,new Date('2026-10-22T12:00:00Z'),new Date('2026-10-22T12:00:00Z'));}}if(discovery&&discoveryPhase===3&&filename===path.join(game,'config.cfg')){enterGuard();await guardRelease;}if(partialMetadata&&filename===path.join(game,'config.cfg')){enterGuard();await guardRelease;}try{return await realpath(filename);}catch(error){if(partialMetadata&&filename===path.join(directory,'config.cfg')&&(error as NodeJS.ErrnoException).code==='ENOENT')metadataObserved();throw error;}},
        stat:async filename=>{if(preserveMetadata&&metadataBaseline.has(filename))return metadataBaseline.get(filename)!;const value=await stat(filename,{bigint:true});const previous=metadataBaseline.get(filename);metadataBaseline.set(filename,value);if(discovery&&discoveryPhase===3&&filename===userdata){expect(value.mtimeNs).not.toBe(previous!.mtimeNs);metadataObserved();}if(partialMetadata&&filename===path.join(directory,'config.cfg'))metadataObserved();return value;}},
      file:async(filename,limit,signal)=>{if(filename.endsWith('game.log.txt'))physicalStarts++;if(failSettings&&filename===path.join(directory,'config.cfg'))throw new Error('Settings read unavailable');if(holdGuard&&!guardHeld&&filename.endsWith('game.log.txt')||holdSettings&&filename===path.join(directory,'config.cfg')||partialBytes&&filename===path.join(directory,'config_local.cfg')){guardHeld=true;enterGuard();await guardRelease;}
        if(partialBytes&&filename===path.join(directory,'config.cfg')){if(!bytesDeleted){bytesDeleted=true;if(variant==='partial-byte-missing')await rm(filename);if(variant==='partial-byte-utf8')await writeFile(filename,Buffer.from([0xc3,0x28]));if(variant==='partial-byte-unbounded')await writeFile(filename,'x'.repeat(256*1024+1));}try{return await readStableFile(filename,limit,signal);}finally{metadataObserved();}}
        return readStableFile(filename,limit,signal);},
      process:s=>Promise.resolve({pid:s.processId,createdUtcMs:new Date(2026,9,21,12).getTime(),executable:'C:/Synthetic/eurotrucks2.exe',homeDirectory:null})});
    const observer=new ProfileObserver(()=>reader,now,false,value=>diagnostics.push(value.code));let recorder!:TripRecorderSink,settings:Promise<unknown>|undefined,readCompleted:(()=>void)|undefined;const publications:string[]=[];
    const monitor=new HardModeMonitor((s,ns,at,signal,force)=>{const work=observer.readSettings(reader,s,ns,at,signal,force).finally(()=>{if(!retired)readCompleted?.();});settings=work.catch(()=>undefined);return work;},value=>{if(!retired){publications.push(value.assessment.state);recorder.observeHardMode('ets2',value);}},now,()=>reader.requestFull(),()=>reader.canRetain(),undefined,()=>reader.drain(),
      {eligible:()=>reader.guardEligible(),select:key=>reader.selectGuardSource(key),deadline:s=>reader.deadline(s)});
    reader.onInvalidate((_profileChanged,diagnostic)=>monitor.invalidate(diagnostic));
    recorder=new TripRecorderSink(client,{profileEvidence:()=>observer.evidence(),profileStatus:()=>observer.status(),hardModeEvidence:()=>monitor.evidence()});
    let committed:(()=>void)|undefined,observed:(()=>void)|undefined,attached:(()=>void)|undefined,replyEnabled=false,boundaryWork:Promise<void>|undefined;let lastServer:ServerMessage=welcome;
    const commit=recorder.commit.bind(recorder),observe=recorder.observe.bind(recorder);
    recorder.commit=async(...args)=>{const result=await commit(...args);if(!retired)committed?.();return result;};
    recorder.observe=(...args)=>{const result=observe(...args);if(!retired)observed?.();return result;};
    const attach=recorder.attach.open.bind(recorder.attach);
    recorder.attach.open=async context=>{const result=await attach(context);if(!retired)attached?.();return result;};
    let pendingProbe:Extract<ClientMessage,{kind:'clock.probe'}>|undefined;
    const answerProbe=(message:Extract<ClientMessage,{kind:'clock.probe'}>)=>{if(retired)return;const ns=BigInt(lastServer.capture.monotonicNs)+3n;pendingProbe=undefined;send({...welcome,kind:'clock.reply',capture:{clockId:script.clockId,monotonicNs:ns.toString()},data:{probeId:message.data.probeId,receivedMonotonicNs:(ns-2n).toString(),sentMonotonicNs:(ns-1n).toString()}});};
    const acks:string[]=[],socket=Object.assign(new EventEmitter(),{destroy:()=>undefined,write:(bytes:Uint8Array)=>{
      const message=decodePayload(bytes.subarray(4),'client') as ClientMessage;
      if(message.kind==='ack')acks.push(message.data.throughEventSeq);
      if(message.kind==='clock.probe'){pendingProbe=message;if(replyEnabled)answerProbe(message);}
    }});
    const send=(input:ServerMessage)=>{
      active();
      const message=structuredClone(input);message.seq=(++wireSeq).toString();
      if(message.kind==='checkpoint'){message.data.boundarySeq=message.seq;message.data.state.boundaryOrder=(++boundary).toString();message.data.state.configuration.revision=revision;}
      if(message.kind==='snapshot'){message.data.state.boundaryOrder=(++boundary).toString();message.data.state.configuration.revision=revision;}
      if(message.kind==='event'){message.data.occurred.boundaryOrder=(++boundary).toString();message.data.occurred.configurationRevision=revision;}
      lastServer=message;socket.emit('data',encodeFrame(message));
    };
    const ingestion=new V1Ingestion({sink:recorder,connect:()=>socket,diagnose:event=>diagnostics.push(event),now:()=>Number(clientNs)/1e6,nowNs:now,staleMs:1e9,
      onState:state=>{if(retired)return;const value=state.fresh&&state.observation?{source:state.observation.source,monotonicNs:state.observation.capture.monotonicNs,clockId:state.observation.capture.clockId,gameClockId:state.observation.state.gameTime.clockId,boundary:state.clockBoundary}:null;observer.select(value);monitor.select(value);}});
    ingestion.onProfileBoundary=()=>{if(!retired)boundaryWork=observer.boundary();};
    const event=async(record:Parameters<Script['event']>[0],simulation:'running'|'paused'='running',advanceMs=10)=>{
      active();const done=new Promise<void>(resolve=>{committed=resolve;});send(script.event(record,{simulation,advanceMs,configurationRevision:revision}));await wait(done,`event ${record.type} committed`);committed=undefined;
    };
    const snapshot=async(odo:number,fuel:number,simulation:'running'|'paused',advanceMs:number,changes:Partial<CurrentState>={})=>{
      active();const configuration=script.checkpoint(job(),0,{},revision).data.state.configuration;
      const message=script.snapshot({configuration,simulation,odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},gameTime:{available:true,value:'500',unit:'min',clockId:script.gameTime.clockId},worldPlacement:{available:true,value:{position:{x:(odo-1000000)/5,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}},...changes},advanceMs);
      const done=new Promise<void>(resolve=>{observed=resolve;});send(message);await wait(done,`snapshot ${simulation} ${odo}/${fuel} observed`);observed=undefined;return message;
    };
    const admit=async()=>{active();await wait(boundaryWork,'profile boundary completed');await wait(settings,'settings read completed');await wait(observer.refresh(),'observer.refresh');replyEnabled=true;clientNs+=1_000_000n;if(pendingProbe)answerProbe(pendingProbe);await wait(vi.advanceTimersByTimeAsync(1000),'vi.advanceTimersByTimeAsync');expect(observer.evidence(),JSON.stringify({diagnostics,status:ingestion.current.status,reason:ingestion.current.reason,phase:observer.status().phase})).toBeDefined();};
    const admittedSnapshot=async(odo:number,fuel:number,advanceMs=100,changes:Partial<CurrentState>={})=>{
      active();expect(observer.status().phase).toBe('admitted');
      const done=new Promise<void>(resolve=>{attached=resolve;});await snapshot(odo,fuel,'paused',advanceMs,changes);await wait(done,`paused endpoint ${odo}/${fuel} persisted`);attached=undefined;
    };
    const cleanup=async()=>{
      const reason=hasPrimary?primary:new Error(`Wired case retired: ${variant}`);retire(reason);
      committed=undefined;observed=undefined;attached=undefined;readCompleted=undefined;
      releasePersist();releaseGuard();monitor.close();observer.close();
      const stopped=ingestion.stop();vi.useRealTimers();
      const cleanupDeadline=realNow()+4_000,errors:unknown[]=[];
      const drains=Promise.allSettled([watchdogWork,settings,boundaryWork,reader.drain(),stopped,...launched]);
      const inspect=(results:PromiseSettledResult<unknown>[])=>{for(const result of results)if(result.status==='rejected'&&result.reason!==reason)errors.push(result.reason);};
      try{inspect(await wiredGuarded(drains,`${variant}: cleanup drain`,cleanupDeadline-2_000));}catch(error){errors.push(error);}
      if(!errors.length){try{await wiredGuarded(client.close(),`${variant}: cleanup storage close`,cleanupDeadline-500);}catch(error){errors.push(error);}}
      if(errors.length){
        // Only failed cleanup forces the owned worker. Closing it also releases any storage command blocking intake.
        const forced=Promise.allSettled([worker.handle.terminate(),client.close(),stopped,drains]);
        try{inspect(await wiredGuarded(forced,`${variant}: cleanup worker termination`,cleanupDeadline));}catch(error){errors.push(error);}
        throw new AggregateError(hasPrimary?[primary,...errors]:errors,`Wired cleanup failed: ${variant}`,hasPrimary?{cause:primary}:undefined);
      }
    };
    try{
      ok(await wait(client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}),'client.open'));
      ingestion.select('synthetic','\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-1-00000000-0000-4000-8000-000000000000');socket.emit('connect');send(welcome);
      const checkpointDone=new Promise<void>(resolve=>{observed=resolve;});send(script.checkpoint(null,0,{},revision));await wait(checkpointDone,'initial checkpoint observed');observed=undefined;await admit();
      await event(r.started());await event(r.jobConfigured());await admit();
      const uuid=tripUuidFor(script.session,'2');
      await snapshot(1000000,100,'running',1000);await snapshot(1000100,99,'running',1000);succeeded(await wait(recorder.samples.write(3600,true),'recorder.samples.write'));
      const before=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));expect(before.trip.observedDistanceM).toEqual({available:true,value:100});expect(before.trip.fuelUsedL).toEqual({available:true,value:1});
      if(variant==='discovery-empty-account'){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        const original=observer.evidence()!;clientNs+=5_000_000_000n;emptyDiscovery=true;replyEnabled=false;
        watchdogWork=monitor.refresh(true);await wait(settings,'settings read completed');await wait(observer.refresh(),'observer.refresh');replyEnabled=true;clientNs+=1_000_000n;if(pendingProbe)answerProbe(pendingProbe);await wait(vi.advanceTimersByTimeAsync(1000),'vi.advanceTimersByTimeAsync');
        emptyDiscovery=false;await wait(watchdogWork,'Hard Mode scan completed');await wait(reader.drain(),'reader.drain');expect(emptyPhase).toBeGreaterThanOrEqual(2);
        const parent=path.join(userdata,'101','227300','remote','profiles'),beforeHint=await wait(stat(parent,{bigint:true}),'stat'),userdataHint=await wait(stat(userdata,{bigint:true}),'stat');
        await wait(mkdir(path.join(parent,id)),'mkdir');await wait(writeFile(path.join(parent,id,'config.cfg'),HARD_MODE_CONFIG),'writeFile');await wait(utimes(parent,new Date('2026-10-23T12:00:00Z'),new Date('2026-10-23T12:00:00Z')),'utimes');
        expect((await wait(stat(parent,{bigint:true}),'stat')).mtimeNs).not.toBe(beforeHint.mtimeNs);expect((await wait(stat(userdata,{bigint:true}),'stat')).mtimeNs).toBe(userdataHint.mtimeNs);
        clientNs+=5_000_000_000n;await wait(monitor.refresh(),'monitor.refresh');const count=endpointScopes.length;
        await snapshot(1000150,98,'paused',100);expect(endpointScopes.slice(count)).not.toContain(original.scope);
        const during=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));expect(during.trip.observedDistanceM).toEqual({available:true,value:125});expect(during.trip.fuelUsedL).toEqual({available:true,value:1.5});
        expect(observer.evidence()).toBeUndefined();expect(monitor.evidence().assessment.state).toBe('unknown');return;
      }
      if(variant==='discovery-cloud'){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        const token=observer.status().token,original=observer.evidence()!,count=endpointScopes.length;
        discovery=true;watchdogWork=monitor.refresh(true);await wait(guardEntered,'reader gate entered');await wait(observedMetadata,'changed metadata or byte evidence observed');await Promise.resolve();await Promise.resolve();
        expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);expect(monitor.evidence().assessment.state).toBe('unknown');
        await snapshot(1000150,98,'paused',100);expect(endpointScopes.slice(count)).not.toContain(original.scope);
        const during=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));expect(during.trip.observedDistanceM).toEqual({available:true,value:125});expect(during.trip.fuelUsedL).toEqual({available:true,value:1.5});
        discovery=false;releaseGuard();await wait(watchdogWork,'Hard Mode scan completed');await wait(reader.drain(),'reader.drain');expect(observer.evidence()).toBeUndefined();
        await wait(monitor.refresh(true),'monitor.refresh');expect(observer.evidence()).toBeUndefined();expect(monitor.evidence().assessment.state).toBe('unknown');return;
      }
      if(variant.startsWith('partial-')){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails!.firstLoss).toBeNull();const token=observer.status().token,original=observer.evidence();
        const target=path.join(directory,'config.cfg');
        if(variant==='partial-delete')await wait(rm(target),'rm');else if(variant==='partial-config'||variant==='partial-bytes'||variant==='partial-byte-timeout'){await wait(writeFile(target,HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"')),'writeFile');const changed=new Date('2026-10-22T12:00:00Z');await wait(utimes(target,changed,changed),'utimes');}
        partialBytes=variant.startsWith('partial-byte');preserveMetadata=partialBytes&&variant!=='partial-byte-timeout';partialMetadata=!partialBytes;
        watchdogWork=monitor.refresh(true);await wait(guardEntered,'reader gate entered');await wait(observedMetadata,'changed metadata or byte evidence observed');
        await Promise.resolve();await Promise.resolve();const during=monitor.evidence().assessment.state;let drained=false;void reader.drain().then(()=>{drained=true;});
        const delivered=r.delivered();if(delivered.type!=='job.delivered')throw new Error('Fixture delivery');await event({...delivered,autoParkUsed:{available:true,value:false}},'paused',100);
        const closed=ok(await wait(client.getTrip(uuid),'client.getTrip'))!;expect(closed).toMatchObject({outcome:'delivered',isHardMode:true,hardModeDetails:{version:2,firstLoss:null}});expect(closed.hardModeDetails).toHaveProperty('firstDiagnostic');
        expect(during).toBe('unknown');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);expect(drained).toBe(false);
        if(variant==='partial-byte-timeout'){
          clientNs+=2_000_000_000n;await wait(vi.advanceTimersByTimeAsync(2000),'vi.advanceTimersByTimeAsync');await wait(settings,'settings read completed');
          expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);expect(drained).toBe(false);
          clientNs+=5_001_000_000n;await wait(vi.advanceTimersByTimeAsync(5000),'vi.advanceTimersByTimeAsync');expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
        }
        partialMetadata=false;partialBytes=false;releaseGuard();await wait(watchdogWork,'Hard Mode scan completed');await wait(reader.drain(),'reader.drain');preserveMetadata=false;
        if(variant==='partial-byte-timeout')expect(observer.evidence()).toBeUndefined();else{expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);}
        expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails!.firstLoss).toEqual(closed.hardModeDetails!.firstLoss);return;
      }
      if(variant.startsWith('identity-')){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        const token=observer.status().token,original=observer.evidence()!,endpointCount=endpointScopes.length;expect(original).toBeDefined();const baseline=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));
        expect(baseline.trip.observedDistanceM).toEqual({available:true,value:125});expect(baseline.trip.fuelUsedL).toEqual({available:true,value:1.5});
        const settingsOnly=variant==='identity-settings'||variant==='identity-settings-error'||variant==='identity-unchanged'||variant==='identity-append';
        if(variant==='identity-load-after-settings-error'){
          await wait(rename(path.join(directory,'config.cfg'),path.join(directory,'config.old')),'rename');await wait(writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG),'writeFile');failSettings=true;
          await wait(monitor.refresh(true),'monitor.refresh');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);clientNs+=1_000_000_000n;
        }
        if(variant==='identity-root'){
          const replacement=path.join(fixtureRoot,'OtherGameRoot');await wait(mkdir(path.join(replacement,'profiles',id),{recursive:true}),'mkdir');
          await wait(writeFile(path.join(replacement,'game.log.txt'),log),'writeFile');await wait(writeFile(path.join(replacement,'config.cfg'),'uset g_traffic "1"'),'writeFile');
          await wait(writeFile(path.join(replacement,'profiles',id,'config.cfg'),HARD_MODE_CONFIG),'writeFile');await wait(writeFile(path.join(replacement,'profiles',id,'config_local.cfg'),'uset g_brake_intensity "0.75"'),'writeFile');
          await wait(rename(game,game+'.old'),'rename');await wait(symlink(replacement,game,'junction'),'symlink');holdGuard=true;
        }else if(variant==='identity-profile'){
          const other=Buffer.from('OtherSynthetic').toString('hex').toUpperCase();await wait(mkdir(path.join(game,'profiles',other)),'mkdir');
          await wait(appendFile(path.join(game,'game.log.txt'),`New profile selected: OtherSynthetic\nLoading save. /home/profiles/${other}/save/autosave/game.sii\n`),'appendFile');
        }else if(variant==='identity-load'||variant==='identity-load-after-settings-error')await wait(appendFile(path.join(game,'game.log.txt'),`Loading save. /home/profiles/${id}/save/autosave/game.sii\n`),'appendFile');
        else if(variant==='identity-namespace'){
          await wait(mkdir(path.join(game,'steam_profiles',id),{recursive:true}),'mkdir');await wait(mkdir(path.join(steam,'userdata','100','227300','remote','profiles',id),{recursive:true}),'mkdir');
          await wait(appendFile(path.join(game,'game.log.txt'),`Loading save. /steam/profiles/${id}/save/autosave/game.sii\n`),'appendFile');
        }else if(variant==='identity-append')await wait(appendFile(path.join(game,'game.log.txt'),'Unrelated log append\n'),'appendFile');
        else if(variant==='identity-unchanged'){
          // The forced verification below must leave the already qualified profile intact.
        }
        else if(settingsOnly){await wait(rename(path.join(directory,'config.cfg'),path.join(directory,'config.old')),'rename');await wait(writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG),'writeFile');failSettings=variant==='identity-settings-error';}
        else{
          await wait(rename(directory,directory+'.old'),'rename');
          if(variant==='identity-replaced'){await wait(mkdir(directory),'mkdir');await wait(writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG),'writeFile');await wait(writeFile(path.join(directory,'config_local.cfg'),'uset g_brake_intensity "0.75"'),'writeFile');}
          if(variant==='identity-redirect')await wait(symlink(directory+'.old',directory,'junction'),'symlink');
        }
        const completed=new Promise<void>(resolve=>{readCompleted=resolve;});holdLocation=variant!=='identity-root'&&variant!=='identity-replaced'&&variant!=='identity-missing'&&variant!=='identity-redirect';
        replyEnabled=false;watchdogWork=monitor.refresh(true);
        if(holdLocation||holdGuard)await wait(guardEntered,'reader gate entered');else await wait(completed,'profile reread completed');
        const during=observer.evidence(),duringToken=observer.status().token,duringState=monitor.evidence().assessment.state;
        await snapshot(1000125,98,'paused',100,{speed:{available:true,value:1,unit:'m/s'}});await event(r.fined(),'paused',0);
        const held=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));
        expect(held.trip.observedDistanceM).toEqual({available:true,value:125});expect(held.trip.fuelUsedL).toEqual({available:true,value:settingsOnly?2:1.5});
        expect(endpointScopes.slice(endpointCount)).toEqual(settingsOnly?[original.scope]:[]);
        if(!settingsOnly)expect(duringState).toBe('unknown');
        if(variant==='identity-unchanged'||variant==='identity-append'){expect(duringState).toBe('pass');expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails!.firstLoss).toBeNull();}
        if(settingsOnly){expect(during).toEqual(original);expect(duringToken).toBe(token);}else{expect(during).toBeUndefined();expect(duringToken).not.toBe(token);}
        holdLocation=false;releaseGuard();await wait(completed,'profile reread completed');
        if(settingsOnly){await admit();await wait(watchdogWork,'Hard Mode scan completed');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);}
        else{monitor.close();await wait(watchdogWork,'Hard Mode scan completed');expect(observer.evidence()).toBeUndefined();}
        expect(ok(await wait(client.listSamples({tripUuid:uuid}),'client.listSamples'))).toHaveLength(2);return;
      }
      if(watchdog){
        expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails!.firstLoss).toBeNull();
        const origin=clientNs;
        for(let second=5;second<60;second+=5){clientNs=origin+BigInt(second)*1_000_000_000n;await wait(reader.resolveProfile(welcome.source,Date.now(),new AbortController().signal,true),'reader.resolveProfile');}
        clientNs=origin+60_000_000_000n;holdSettings=true;watchdogWork=monitor.refresh();await wait(guardEntered,'reader gate entered');const token=observer.status().token,starts=physicalStarts;
        clientNs+=2_000_000_000n;await wait(vi.advanceTimersByTimeAsync(2000),'vi.advanceTimersByTimeAsync');await wait(settings,'settings read completed');
        expect(monitor.evidence().assessment.state).toBe('pass');expect(observer.evidence()).toBeDefined();expect(observer.status().token).toBe(token);
        for(let second=1;second<5;second++){clientNs+=1_000_000_000n;monitor.heartbeat();await snapshot(1000100,99,'running',1000);}
        clientNs=origin+67_001_000_000n;
        if(variant==='watchdog-timer'){await wait(vi.advanceTimersByTimeAsync(5000),'vi.advanceTimersByTimeAsync');expect(publications.at(-1)).toBe('unknown');}
        // The getter case deliberately leaves timer callbacks pending at the same monotonic deadline.
        expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
        expect(physicalStarts).toBe(starts);await event(r.fined());const lost=ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails;expect(lost).toMatchObject({version:2,firstLoss:null,latestDiagnostic:{code:'guard-deadline'}});
        const recoveredRead=new Promise<void>(resolve=>{readCompleted=resolve;});holdSettings=false;releaseGuard();await wait(reader.drain(),'reader.drain');
        expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();
        await wait(recoveredRead,'recovery settings read completed');await wait(settings,'settings read completed');await wait(observer.refresh(),'observer.refresh');expect(monitor.evidence().assessment.state).toBe('unknown');await admit();await wait(watchdogWork,'Hard Mode scan completed');
        expect(monitor.evidence().assessment.state).toBe('pass');await snapshot(1000100,99,'running',1000);await event(r.delivered());
        const recovered=ok(await wait(client.getTrip(uuid),'client.getTrip'))!;expect(recovered.hardModeDetails).toMatchObject({firstLoss:null});expect(recovered.isHardMode).toBe(true);return;
      }
      if(variant==='witness'){
        replyEnabled=false;await event(r.paused(),'paused',10);await snapshot(1000110,98.9,'paused',10);await admit();await snapshot(1000110,98.9,'paused',10);
        expect(ok(await wait(client.journalTrip(uuid),'client.journalTrip')).trip.observedDistanceM).toEqual({available:true,value:110});
        replyEnabled=false;await event(r.started(),'running',10);await admit();await snapshot(1000120,98.7,'running',10);
      }
      const token=observer.status().token;replyEnabled=false;holdGuard=variant==='unchanged';await event(r.paused(),'paused',100);
      if(variant==='unchanged')await wait(guardEntered,'reader gate entered');
      expect(observer.evidence()).toBeUndefined();expect(observer.status()).toEqual({phase:'pending',token});
      const changes:Partial<CurrentState>={};
      if(variant==='clock')changes.gameTime={available:true,value:'500',unit:'min',clockId:'40000000-0000-4000-8000-000000000099'};
      if(variant==='truck'){const configuration=script.checkpoint(job()).data.state.configuration;if(configuration.truck.available)configuration.truck.value.licensePlate={available:true,value:'OTHER'};changes.configuration=configuration;}
      if(variant==='job')changes.configuration=script.checkpoint(otherJob()).data.state.configuration;
      if(variant==='missing')changes.worldPlacement={available:false,reason:'not-observed'};
      if(variant==='teleport')changes.worldPlacement={available:true,value:{position:{x:10000,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}};
      await snapshot(1000125,variant==='refuel'?110:98.5,'paused',variant==='over-limit'?5000:100,changes);
      expect(ok(await wait(client.listSamples({tripUuid:uuid}),'client.listSamples'))).toHaveLength(2);
      if(variant==='unchanged'){await event(r.paused(),'paused',0);releaseGuard();}
      if(variant==='revoked')observer.suspend();
      if(variant==='load')await wait(writeFile(path.join(game,'game.log.txt'),log+`Loading save. /home/profiles/${id}/save/autosave/game.sii\n`),'writeFile');
      if(variant==='profile')await wait(writeFile(path.join(game,'game.log.txt'),log+'New profile selected: Other\n'),'writeFile');
      if(variant==='gap'){
        const done=new Promise<void>(resolve=>{committed=resolve;});send(script.gap(1,'queueCount',10));await wait(done,'semantic callback');committed=undefined;
      }
      if(variant==='unqualified-sample')await snapshot(1000130,98.4,'running',1000);
      await wait(boundaryWork,'profile boundary completed');
      if(variant==='load'||variant==='profile'||variant==='revoked'){
        clientNs+=5_000_000_000n;await wait(observer.refresh(),'observer.refresh');
      }
      if(variant!=='profile'){
        await admit();
        if(variant.startsWith('admitted-')){
          if(variant==='admitted-persist-revoked'){
            holdPersist=true;const capturedToken=observer.status().token,capturedProof=observer.evidence()!;
            const pendingWrite=launch(admittedSnapshot(1000125,98.5));await wait(persistEntered,'paused endpoint write held');
            observer.suspend();boundaryWork=observer.boundary();await admit();
            expect(observer.status().token).not.toBe(capturedToken);expect(observer.evidence()!.binding).toBe(capturedProof.binding);
            releasePersist();await wait(pendingWrite,'paused endpoint write released');
          }else await admittedSnapshot(1000125,98.5);
          const first=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));expect(first.trip.observedDistanceM).toEqual({available:true,value:125});expect(first.trip.fuelUsedL).toEqual({available:true,value:1.5});
          if(variant==='admitted-persist-revoked'){
            await admittedSnapshot(1000125,98.4);
          }else if(variant==='admitted-regression'){
            await admittedSnapshot(1000150,98,100,{speed:{available:true,value:20,unit:'m/s'}});
            expect(ok(await wait(client.journalTrip(uuid),'client.journalTrip')).trip.observedDistanceM).toEqual({available:true,value:150});
            await admittedSnapshot(1000140,97.5,100,{speed:{available:true,value:20,unit:'m/s'}});
          }else if(variant==='admitted-long-unchanged'||variant==='admitted-long-motion'){
            // Change only the speed hint to persist the same physical endpoint after each long admitted pause.
            await admittedSnapshot(1000125,98.5,6000,{speed:{available:true,value:1,unit:'m/s'}});
            expect(ok(await wait(client.journalTrip(uuid),'client.journalTrip')).trip.fuelUsedL).toEqual({available:true,value:1.5});
            if(variant==='admitted-long-motion')await admittedSnapshot(1000150,98,6000,{speed:{available:true,value:20,unit:'m/s'}});
            else await admittedSnapshot(1000125,98.5,6000,{speed:{available:true,value:2,unit:'m/s'}});
          }else{
            const refuel=variant==='admitted-refuel'||variant==='admitted-refuel-recheck';
            await admittedSnapshot(1000125,refuel?96:98);
            expect(ok(await wait(client.journalTrip(uuid),'client.journalTrip')).trip.fuelUsedL).toEqual({available:true,value:refuel?4:2});
            await admittedSnapshot(1000125,refuel?97:97.5);
            if(variant==='admitted-refuel-recheck'){
              expect(ok(await wait(client.journalTrip(uuid),'client.journalTrip')).trip.fuelUsedL).toEqual({available:false,reason:'not-observed'});
              replyEnabled=false;await event(r.paused(),'paused',10);await snapshot(1000125,96.5,'paused',10);await admit();await admittedSnapshot(1000125,96.5);
            }
          }
        }else await snapshot(1000125,98.5,'paused',100);
      }
      succeeded(await wait(recorder.samples.write(3600,true),'recorder.samples.write'));
      const detail=ok(await wait(client.journalTrip(uuid),'client.journalTrip'));
      if(variant==='unchanged'||variant==='witness'||variant==='admitted-consumption'||variant==='admitted-long-unchanged'){
        expect(detail.trip.observedDistanceM).toEqual({available:true,value:125});expect(detail.trip.fuelUsedL).toEqual({available:true,value:variant==='admitted-consumption'?2.5:1.5});expect(detail.trip.recordingCompleteness).toBe('complete');
        const samples=ok(await wait(client.listSamples({tripUuid:uuid}),'client.listSamples'));expect(samples).toHaveLength(2);expect(samples.map(sample=>sample.speed.available?sample.speed.value:null)).toEqual([20,20]);
        expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails!.firstLoss).toBeNull();
      }else{
        // No newly admitted endpoint exists after profile/clock uncertainty:
        // its already supported prefix remains 100 m/1 L. An admitted but unsupported new leg is unavailable.
        if(variant==='profile'||variant==='clock'){
          expect(detail.trip.observedDistanceM).toEqual({available:true,value:100});expect(detail.trip.fuelUsedL).toEqual({available:true,value:1});
        }else{
          expect(detail.trip.observedDistanceM).toEqual({available:false,reason:'not-observed'});expect(detail.trip.fuelUsedL).toEqual({available:false,reason:'not-observed'});
        }
        if(variant==='gap')expect(detail.trip.recordingCompleteness).toBe('partial');
        if(variant==='profile'||variant==='load'||variant==='clock')expect(ok(await wait(client.getTrip(uuid),'client.getTrip'))!.hardModeDetails).toMatchObject({version:2,firstLoss:null});
      }
      expect(acks).toContain('3');
    }catch(error){primary=error;hasPrimary=true;throw error;}
    finally{await cleanup();}
  });
  it.each(['before','long-before','after','foreign-source','foreign-clock','unknown-time','overflow'] as const)('bounds and source-qualifies persisted transfer checks: %s',async variant=>{
    const storage=await ws.open(),s=new Script(ETS2_A);ok(storage.upsertSession({message:s.welcome()}));ok(storage.commitEvent({message:s.event(r.started())}));const uuid=open(storage,s);
    const commitTransfer=()=>{const event=s.event(r.ferry(),{advanceMs:500});
      if(variant==='foreign-clock')event.capture.clockId='40000000-0000-4000-8000-000000000099';
      if(variant==='unknown-time')event.data.occurred.monotonicNs={available:false,reason:'not-observed'};
      ok(storage.commitEvent({message:event}));};
    if(variant==='before')commitTransfer();
    if(variant==='long-before')for(let n=0;n<70;n++)ok(storage.commitEvent({message:s.event(r.fined(),{advanceMs:1})}));
    let previous:string|undefined;
    const append=(message:ReturnType<Script['snapshot']>,odo:number,fuel:number,x:number)=>{
      const row={...seedSample(s,uuid,0,1000,{odometer:{available:true,value:odo},fuel:{available:true,value:fuel},speed:{available:true,value:20},
        position:{available:true,value:{x,y:0,z:0}},gameTime:{minutes:{available:true,value:500},clockId:s.clockId}}),monotonicNs:message.capture.monotonicNs,
        recording:{profile:proof(s),job:job(),truck:'verified-truck',processInstanceId:s.welcome().source.processInstanceId,
          ...(previous?{previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:previous}}:{})}};
      ok(storage.appendSamples(s.session,[row],{uniqueSeconds:true}));previous=message.capture.monotonicNs;
    };
    append(s.snapshot({},variant==='before'?500:variant==='long-before'?930:1000),1000000,100,0);append(s.snapshot({},1000),1000100,99,20);
    if(variant==='foreign-source'){const other=new Script(ETS2_B);ok(storage.upsertSession({message:other.welcome()}));ok(storage.commitEvent({message:other.event(r.ferry())}));}
    if(variant==='foreign-clock'||variant==='unknown-time')commitTransfer();
    if(variant==='overflow')for(let n=0;n<70;n++)ok(storage.commitEvent({message:s.event(r.fined(),{advanceMs:1})}));
    const message=s.snapshot({},variant==='foreign-clock'||variant==='unknown-time'?500:variant==='overflow'?930:1000);
    if(variant==='after')commitTransfer(); // buffered reading predates an event already committed before its sample flush
    append(message,1000443.75,98,40);
    const trip=ok(storage.journalTrip(uuid)).trip;
    if(variant==='unknown-time'||variant==='overflow'){expect(trip.observedDistanceM.available).toBe(false);expect(trip.fuelUsedL.available).toBe(false);}
    else {expect(trip.observedDistanceM).toEqual({available:true,value:443.75});expect(trip.fuelUsedL).toEqual({available:true,value:2});}
    expect(trip.recordingCompleteness).toBe('complete');storage.close();
  });
  it.each(['ferry-sampled','train-sampled','ferry-captured','train-captured'] as const)('does not bridge an explicit transfer through the recorder and real worker: %s',async variant=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    succeeded(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    succeeded(await recorder.openSession(s.welcome()));succeeded(recorder.observe(s.checkpoint(null),context));succeeded(await recorder.commit(s.event(r.started()),context));
    const configured=s.event(r.jobConfigured());succeeded(await recorder.commit(configured,context));const uuid=tripUuidFor(s.session,configured.data.eventSeq),configuration=s.checkpoint(job()).data.state.configuration;
    const capture=async(odo:number,fuel:number,x:number,simulation:'running'|'paused',advanceMs:number)=>{
      succeeded(recorder.observe(s.snapshot({configuration,simulation,odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},
        speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},gameTime:{available:true,value:'500',unit:'min',clockId:s.clockId},
        worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},advanceMs),context));
      if(recorder.attach.due())succeeded(await recorder.attach.open(context));
    };
    await capture(1000000,100,0,'running',1000);await capture(1000100,99,20,'running',1000);
    succeeded(await recorder.commit(s.event(variant.startsWith('ferry')?r.ferry():r.train(),{advanceMs:500}),context));
    if(variant.endsWith('captured'))succeeded(await recorder.commit(s.event(r.paused(),{simulation:'paused',advanceMs:250}),context));
    await capture(1000443.75,98,40,variant.endsWith('captured')?'paused':'running',variant.endsWith('captured')?250:500);
    succeeded(await recorder.samples.write(3600,true));succeeded(await recorder.commit(s.event(r.fined(),{simulation:variant.endsWith('captured')?'paused':'running'}),context));
    const detail=succeeded(await client.journalTrip(uuid));expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.fuelUsedL.available).toBe(false);
    expect(detail.trip.recordingCompleteness).toBe('complete');
    const raw=succeeded(await client.getTrip(uuid))!;expect(raw.observedDistanceM).toEqual({available:true,value:100});expect(raw.fuelUsedL).toEqual({available:true,value:1});
    expect(succeeded(await client.listSamples({tripUuid:uuid},{includeExcluded:true}))).toHaveLength(variant.endsWith('captured')?2:3);
    expect(await client.close()).toEqual({clean:true});
  });
  it.each(['clean','counter','unqualified','foreign-trip','foreign-plugin','foreign-clock','foreign-proof','foreign-process','foreign-scope','foreign-load','late-proof','stale','ahead','ferry-first','train-second','gap','profile-change','clock-change','intermediate-regression','intermediate-teleport','intermediate-refuel'] as const)('advances two captured pauses through an unsampled running reading only with owned continuous evidence: %s',async variant=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    let currentProof:ProfileObservation|undefined=proof(s);succeeded(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>currentProof});succeeded(await recorder.openSession(s.welcome()));succeeded(recorder.observe(s.checkpoint(null),context));
    succeeded(await recorder.commit(s.event(r.started()),context));const event=s.event(r.jobConfigured());succeeded(await recorder.commit(event,context));
    const uuid=tripUuidFor(s.session,event.data.eventSeq),configuration=s.checkpoint(job()).data.state.configuration;
    const originalAttach=client.openAttachedTrip.bind(client);let alter=false,writes=0;
    client.openAttachedTrip=input=>{
      writes++;
      if(alter && input.endpoint?.running){const endpoint=structuredClone(input.endpoint),witness=structuredClone(input.endpoint.running);endpoint.running=witness;input={...input,endpoint};
        if(variant==='foreign-trip')witness.tripUuid='10000000-0000-4000-8000-000000000099';
        if(variant==='foreign-plugin')witness.pluginSessionId='10000000-0000-4000-8000-000000000099';
        if(variant==='foreign-clock')witness.sourceClockId='40000000-0000-4000-8000-000000000099';
        if(variant==='foreign-proof')witness.profile.binding='9'.repeat(64);
        if(variant==='foreign-process')witness.profile.processInstanceId='20000000-0000-4000-8000-000000000099';
        if(variant==='foreign-scope')witness.profile.scope='8'.repeat(64);
        if(variant==='foreign-load')witness.profile.loadGeneration=2;
        if(variant==='late-proof')witness.profile.afterMonotonicNs=(BigInt(witness.monotonicNs)+1n).toString();
        if(variant==='stale')witness.monotonicNs=endpoint.previous!.monotonicNs;
        if(variant==='ahead')witness.monotonicNs=input.monotonicNs!;
      }
      return originalAttach(input);
    };
    const capture=async(odo:number,fuel:number,x:number,simulation:'running'|'paused',advanceMs:number)=>{
      const message=s.snapshot({configuration,simulation,odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},
        gameTime:{available:true,value:'500',unit:'min',clockId:s.clockId},worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},advanceMs);
      if(variant==='clock-change' && odo===1000150 && message.data.state.gameTime.available)message.data.state.gameTime.clockId='40000000-0000-4000-8000-000000000099';
      if(variant==='counter' && odo===1000150)message.data.continuity.coalescedSnapshots='1';
      succeeded(recorder.observe(message,context));if(recorder.attach.due())succeeded(await recorder.attach.open(context));return message;
    };
    await capture(1000000,100,0,'running',1000);await capture(1000100,99,20,'running',1000);
    succeeded(await recorder.commit(s.event(r.paused(),{simulation:'paused',advanceMs:250}),context));await capture(1000125,98.5,25,'paused',0);
    const first=succeeded(await client.journalTrip(uuid));expect(first.trip.observedDistanceM).toEqual({available:true,value:125});
    succeeded(await recorder.commit(s.event(r.started(),{advanceMs:50}),context));
    if(variant==='ferry-first')succeeded(await recorder.commit(s.event(r.ferry(),{advanceMs:25}),context));
    if(variant==='unqualified')currentProof=undefined;
    if(variant==='intermediate-regression')await capture(1000060,99.4,12,'running',25);
    if(variant==='intermediate-teleport')await capture(1000125,98.5,1000,'running',25);
    if(variant==='intermediate-refuel')await capture(1000130,120,26,'running',25);
    const running=await capture(1000140,98.2,28,'running',100);alter=true;
    if(variant==='train-second')succeeded(await recorder.commit(s.event(r.train(),{advanceMs:25}),context));
    if(variant==='gap')succeeded(await recorder.commit(s.gap(1,'queueCount',0),context));
    // The next refresh advances its causal lower bound; the already-qualified running witness must remain usable.
    currentProof={...proof(s),...(variant==='profile-change'?{binding:'8'.repeat(64)}:{}),afterMonotonicNs:(BigInt(running.capture.monotonicNs)+1n).toString()};
    succeeded(await recorder.commit(s.event(r.paused(),{simulation:'paused',advanceMs:100}),context));await capture(1000150,98,30,'paused',0);
    const second=succeeded(await client.journalTrip(uuid));
    if(variant==='clean'){expect(second.trip.observedDistanceM).toEqual({available:true,value:150});expect(second.trip.fuelUsedL).toEqual({available:true,value:2});}
    else {expect(second.trip.observedDistanceM.available).toBe(false);expect(second.trip.fuelUsedL.available).toBe(false);}
    if(variant==='clean'){
      const before=writes;for(let n=0;n<20;n++)await capture(1000150,98,30,'paused',10);
      expect(writes).toBe(before); // no repeated pause commands or projection churn after the meaningful boundary
    }
    expect(succeeded(await client.listSamples({tripUuid:uuid}))).toHaveLength(2);expect(await client.close()).toEqual({clean:true});
    const reopened=await ws.open();expect(succeeded(reopened.journalTrip(uuid)).trip.observedDistanceM).toEqual(second.trip.observedDistanceM);reopened.close();
    readOnly(ws.database,db=>{db.defaultSafeIntegers(true);expect(logicalSnapshot(db,uuid,BigInt(first.exportBounds.snapshot!.samples.split(':')[3])).row.observed_distance_m).toBe(125);
      if(variant==='clean'){
        const stored=JSON.parse(db.prepare('SELECT row_json FROM logical_projection_states WHERE id=(SELECT state_ref FROM logical_revisions ORDER BY id DESC LIMIT 1)').pluck().get() as string)._coverage.endpoint.running;
        expect(stored.monotonicNs).toBe(running.capture.monotonicNs);expect(stored.profile.afterMonotonicNs).toBe('0');
      }
    });
  });
  it.each(['truck-change','odometer-jump','position-jump','game-time-jump'] as const)('separates an observed configuration annotation from unexplained recording discontinuity: %s',async cause=>{
    const storage=await ws.open(),script=new Script(ETS2_A);ok(storage.upsertSession({message:script.welcome()}));
    const message=script.event(r.jobConfigured()),uuid=tripUuidFor(script.session,message.data.eventSeq);
    ok(storage.commitEvent({message,effects:[{kind:'trip.open',tripUuid:uuid,game:script.game,gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'unknown',startedUtcMs:1000}]}));
    ok(storage.commitEvent({message:script.event(r.truckConfigured()),effects:[{kind:'completeness.add',interval:{tripUuid:uuid,kind:'discontinuity',detail:{cause,annotation:true}}}]}));
    expect(ok(storage.journalTrip(uuid)).trip.recordingCompleteness).toBe(cause==='truck-change'?'unknown':'partial');storage.close();
  });
  it('rejects malformed captured boundaries at the real worker without changing coverage or samples',async()=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),script=new Script(ETS2_A);
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    ok(await client.upsertSession({message:script.welcome()}));
    const event=script.event(r.jobConfigured()),uuid=tripUuidFor(script.session,event.data.eventSeq);
    ok(await client.commitEvent({message:event,profile:proof(script),effects:[{kind:'trip.open',tripUuid:uuid,game:script.game,gameMode:mode,
      jobConfiguration:'this-event',startedUtcMs:1000,recordingCompleteness:'complete'}]}));
    const before=ok(await client.journalTrip(uuid));
    const endpoint={version:1,simulation:'paused',truck:'verified-truck',odometerM:1000000,fuelL:100,speedMps:0,gameClockId:script.clockId,gameMinutes:'500',position:{x:0,y:0,z:0}};
    const running={truck:'verified-truck',odometerM:1000000,fuelL:100,speedMps:20,gameClockId:script.clockId,gameMinutes:'500',position:{x:0,y:0,z:0},
      tripUuid:uuid,pluginSessionId:script.session,sourceClockId:script.clockId,monotonicNs:'2000000000',profile:proof(script)};
    for(const invalid of [{...endpoint,running:{...running,extra:true}},{...endpoint,running:{...running,profile:{...running.profile,extra:true}}},
      {...endpoint,running:{...running,monotonicNs:'18446744073709551616'}},{...endpoint,version:2},{...endpoint,extra:true},{...endpoint,position:{x:NaN,y:0,z:0}},{...endpoint,fuelL:-1},
      {...endpoint,gameMinutes:'18446744073709551616'},{...endpoint,previous:{tripUuid:uuid,sourceClockId:script.clockId,monotonicNs:'0',extra:true}},
      {...endpoint,previous:null}]){
      const result=await client.openAttachedTrip({pluginSessionId:script.session,nextEventSeq:'2',job:job(),effects:[],profile:proof(script),sourceClockId:script.clockId,
        monotonicNs:'3000000000',observeTripUuid:uuid,endpoint:invalid as never});
      expect(result).toMatchObject({ok:false,error:{code:'INVALID_INPUT'}});
    }
    expect(ok(await client.journalTrip(uuid))).toEqual(before);expect(ok(await client.listSamples({tripUuid:uuid}))).toEqual([]);
    expect(await client.close()).toEqual({clean:true});
  });
  it.each(['trip','clock','time'] as const)('cannot add a pause tail from an unowned captured predecessor: %s',async field=>{
    const storage=await ws.open(),script=new Script(ETS2_A);ok(storage.upsertSession({message:script.welcome()}));ok(storage.commitEvent({message:script.event(r.started())}));
    const uuid=open(storage,script);sample(storage,script,uuid,3,1000000);sample(storage,script,uuid,4,1000100);
    const previous={tripUuid:uuid,sourceClockId:script.clockId,monotonicNs:'4000000000'};
    if(field==='trip')previous.tripUuid='10000000-0000-4000-8000-000000000099';
    if(field==='clock')previous.sourceClockId='40000000-0000-4000-8000-000000000099';
    if(field==='time')previous.monotonicNs='3000000000';
    ok(storage.openAttachedTrip({pluginSessionId:script.session,nextEventSeq:'3',job:job(),effects:[],profile:proof(script),sourceClockId:script.clockId,
      monotonicNs:'4500000000',observeTripUuid:uuid,endpoint:{version:1,simulation:'paused',truck:'verified-truck',odometerM:1000125,fuelL:399.9875,speedMps:0,
        gameClockId:'40000000-0000-4000-8000-000000000001',gameMinutes:'500',position:{x:200025,y:0,z:0},previous}}));
    expect(ok(storage.journalTrip(uuid)).trip.observedDistanceM.available).toBe(false);
    expect(ok(storage.listSamples({tripUuid:uuid}))).toHaveLength(2);storage.close();
  });
  it.each(['absent','unsupported','malformed','extra','pending-type','pending-true','pending-false','resume-type','resume-active','resume-false'] as const)('distinguishes legacy absent coverage from present-invalid metadata: %s',async kind=>{
    let storage=await ws.open();const script=new Script(ETS2_A),uuid=open(storage,script);ok(storage.close());
    const db=new Database(ws.database);let row:{id:number;row_json:string};
    try{row=db.prepare('SELECT s.id,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref ORDER BY r.id DESC LIMIT 1').get() as {id:number;row_json:string};
      const metadata=JSON.parse(row.row_json);if(kind==='absent')delete metadata._coverage;else metadata._coverage=kind==='unsupported'?{...metadata._coverage,version:99}:kind==='extra'?{...metadata._coverage,unknown:true}:kind.startsWith('pending')?{...metadata._coverage,acceptancePending:kind==='pending-type'?'false':kind==='pending-true'}:kind.startsWith('resume')?{...metadata._coverage,sampleResumePending:kind==='resume-type'?'false':kind==='resume-active'}:{version:1};
      row.row_json=JSON.stringify(metadata);db.prepare('UPDATE logical_projection_states SET row_json=? WHERE id=?').run(row.row_json,row.id);
    }finally{db.close();}
    storage=await ws.open();expect(ok(storage.journalTrip(uuid)).trip.recordingCompleteness).toBe(kind==='absent'||kind==='pending-false'||kind==='resume-false'?'complete':'partial');storage.close();
    expect(readOnly(ws.database,db=>db.prepare('SELECT row_json FROM logical_projection_states WHERE id=?').pluck().get(row.id))).toBe(row.row_json);
  });
  it('deduplicates coverage metadata while ordinary samples advance existing immutable revision bounds',async()=>{
    const script=new Script(ETS2_A);let storage=await ws.open();ok(storage.upsertSession({message:script.welcome()}));ok(storage.commitEvent({message:script.event(r.started())}));
    const uuid=open(storage,script);storage.close();
    const before=readOnly(ws.database,db=>({states:db.prepare('SELECT count(*) FROM logical_projection_states').pluck().get(),metadata:db.prepare('SELECT row_json FROM logical_projection_states ORDER BY id DESC LIMIT 1').pluck().get()}));
    storage=await ws.open();for(let n=0;n<50;n++)sample(storage,script,uuid,n+3,1000000+n*10);
    expect(ok(storage.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:490});storage.close();
    readOnly(ws.database,db=>{expect(db.prepare('SELECT count(*) FROM logical_projection_states').pluck().get()).toBe(before.states);
      expect(db.prepare('SELECT row_json FROM logical_projection_states ORDER BY id DESC LIMIT 1').pluck().get()).toBe(before.metadata);
      expect(Number(db.prepare('SELECT count(*) FROM logical_revisions').pluck().get())).toBeGreaterThan(50);});
  });
  it('keeps one complete delivered UUID through real pipes, a game-only restart, and a full service restart at the default flush',async()=>{
    const base=JSON.parse(readFileSync(scenarioPath('normal-delivery'),'utf8'));
    const configured={...base.steps[2],attributes:[...base.steps[2].attributes,
      {name:'source.company.id',sdkType:'string',value:'synthetic_source'},{name:'destination.company.id',sdkType:'string',value:'synthetic_destination'},
      {name:'cargo.mass',sdkType:'float',value:18000},{name:'job.market',sdkType:'string',value:'freight_market'},{name:'delivery.time',sdkType:'u32',value:13000}]};
    const truck={...base.steps[0],attributes:[...base.steps[0].attributes,{name:'license.plate',sdkType:'string',value:'SYN COVERAGE'}]};
    const frame=(atMs:number,distance:number,fuel:number,x:number,minutes:number,speed=20)=>({atMs,action:'frame',channels:{speed,odometer:1000+distance/1000,'fuel.amount':fuel,'game.time':minutes,
      'world.placement':{x,y:0,z:0,heading:0,pitch:0,roll:0}}});
    const pause=(atMs:number)=>({atMs,action:'lifecycle',event:'simulation.paused'}),start=(atMs:number)=>({atMs,action:'lifecycle',event:'simulation.started'});
    const first={...base,id:'coverage-first',seed:'coverage-first',steps:[truck,base.steps[1],start(30),{...configured,atMs:40},frame(100,0,100,0,500),frame(1100,62.5,99,20,500),frame(2100,125,98,40,500),
      pause(2200),frame(2250,156.25,97.5,45,501,0),{atMs:2280,action:'gameplay',id:'player.fined',attributes:[{name:'fine',sdkType:'s64',value:'1'}]}],
      transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:2300,action:'disconnect'}]};
    const second={...first,id:'coverage-second',seed:'coverage-second',steps:[pause(5),truck,base.steps[1],configured,frame(50,156.25,97.5,45,501,0),start(100),
      frame(200,187.5,97,50,501),frame(1200,250,96,70,501),frame(2200,312.5,95,90,501),pause(2300),frame(2350,343.75,94.5,95,502,0),
      {atMs:2380,action:'gameplay',id:'player.fined',attributes:[{name:'fine',sdkType:'s64',value:'1'}]}],transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:2400,action:'disconnect'}]};
    const third={...second,id:'coverage-third',seed:'coverage-third',steps:[pause(5),truck,base.steps[1],configured,frame(50,343.75,94.5,95,502,0),start(100),
      frame(200,375,94,100,502),frame(1200,437.5,93,120,502),frame(2200,500,92,140,502),{...base.steps[9],atMs:2300},{...base.steps[10],atMs:2310}],
      transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:2400,action:'disconnect'}]};
    let currentProof:ProfileObservation|undefined,worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),ingestion:V1Ingestion;
    const acks:{through:string;stored:string}[]=[];let original='';let closed:()=>void=()=>undefined;const coverage=new Map<string,string>();
    const create=()=>{
      const event=client.commitEvent.bind(client),gap=client.commitGap.bind(client);
      client.commitEvent=async input=>{const result=await event(input);if(result.ok)coverage.set((input.message as {source:{pluginSessionId:string}}).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      client.commitGap=async input=>{const result=await gap(input);if(result.ok)coverage.set((input.message as {source:{pluginSessionId:string}}).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      const sink=new TripRecorderSink(client,{profileEvidence:()=>currentProof});
      ingestion=new V1Ingestion({sink,connect:endpoint=>{
        const socket=new ClientSocket(net.connect(endpoint),undefined,error=>{throw error;});
        const write=socket.write.bind(socket);
        // The ACKs carry the minor the chain negotiates, the service's offer against the simulator's highest (3 since ET-071).
        socket.write=(bytes,...rest)=>{const message=decodePayload(bytes.subarray(4),'client',{maxMinor:V1_CLIENT_MAX_MINOR}) as ClientMessage;
          if(message.kind==='ack')acks.push({through:message.data.throughEventSeq,stored:coverage.get(message.data.pluginSessionId) ?? '0'});
          return write(bytes,...rest);};
        socket.once('close',()=>{ingestion.select('game');closed();});return socket;
      }});
    };
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));create();
    for(const [index,input] of [first,second,third].entries()){
      if(index===2){await ingestion!.stop();expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
        ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));create();}
      const source=scenarioSource(replayV1(input).scenario);
      currentProof={version:1,scope:'e'.repeat(64),binding:'f'.repeat(64),game:'ets2',pluginSessionId:source.pluginSessionId,processInstanceId:source.processInstanceId,
        sourceClockId:seededId(input.seed,'capture-clock'),afterMonotonicNs:'0',loadGeneration:1};
      const server=await serveV1Reactive(input,{scale:0,awaitScriptedAcks:true}),gone=new Promise<void>(resolve=>{closed=resolve;});
      try{ingestion!.select('synthetic',server.endpoint);await guarded(server.done,'three-session source ACK completion',30000);await guarded(gone,'three-session source close',30000);}
      finally{await server.stop();}
      if(index===2)await ingestion!.stop();
      const list=ok(await client.journalTrips()).trips;expect(list).toHaveLength(1);original ||= list[0].tripUuid;expect(list[0].tripUuid).toBe(original);
      const detail=ok(await client.journalTrip(original));
      expect(detail.trip.recordingCompleteness,'pipe session '+index).toBe('complete');
      expect(detail.trip.observedDistanceM).toEqual({available:true,value:index===0?156.25:index===1?343.75:500});
    }
    expect(ok(await client.journalTrip(original)).trip.outcome).toBe('delivered');expect(ok(await client.listTrips()).trips).toHaveLength(3);
    for(const ack of acks)expect(BigInt(ack.through)).toBeLessThanOrEqual(BigInt(ack.stored));
    expect(await client.close()).toEqual({clean:true});
  },60_000);
  it.each(['sample-conflict','captured-conflict','sample-equivalent','captured-equivalent','restart-equivalent','candidate-overflow','captured-overflow','path-overflow'] as const)('requires a unique retained saved accounting prefix: %s',async variant=>{
    let worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});const a=new Script(ETS2_A),b=new Script(ETS2_B),context={receivedUtcMs:1000};
    let lastBoundary:Parameters<StorageClient['openAttachedTrip']>[0]|undefined;
    const attach=client.openAttachedTrip.bind(client);client.openAttachedTrip=input=>{if(input.endpoint)lastBoundary=structuredClone(input);return attach(input);};
    let currentProof=proof(a);ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    let recorder=new TripRecorderSink(client,{profileEvidence:()=>currentProof});
    const capture=async(s:Script,odo:number,fuel:number,x:number,simulation:'running'|'paused',advance=1000)=>{
      const message=s.snapshot({configuration:s.checkpoint(job()).data.state.configuration,simulation,speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},
        odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},gameTime:{available:true,value:'500',unit:'min',clockId:s.clockId},
        worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},advance);
      succeeded(recorder.observe(message,context));if(recorder.attach.due())succeeded(await recorder.attach.open(context));return message;
    };
    succeeded(await recorder.openSession(a.welcome()));succeeded(recorder.observe(a.checkpoint(null),context));succeeded(await recorder.commit(a.event(r.started()),context));
    const configured=a.event(r.jobConfigured());succeeded(await recorder.commit(configured,context));const uuid=tripUuidFor(a.session,configured.data.eventSeq);
    const captured=variant.startsWith('captured'),conflict=variant.endsWith('conflict')||variant.endsWith('overflow'),secondFuel=variant.endsWith('conflict')?(captured?99.37:99.39):99.4;
    await capture(a,1000000,100,0,'running');await capture(a,1000060,99.4,12,'running');
    if(captured){succeeded(await recorder.commit(a.event(r.paused(),{simulation:'paused',advanceMs:50}),context));await capture(a,1000060,99.4,12,'paused',0);succeeded(await recorder.commit(a.event(r.started(),{advanceMs:50}),context));}
    await capture(a,1000060,secondFuel,12,'running');
    if(variant==='candidate-overflow')for(let n=0;n<63;n++)await capture(a,1000060,secondFuel,12,'running');
    if(captured){succeeded(await recorder.commit(a.event(r.paused(),{simulation:'paused',advanceMs:50}),context));await capture(a,1000060,secondFuel,12,'paused',0);succeeded(await recorder.commit(a.event(r.started(),{advanceMs:50}),context));}
    if(variant==='captured-overflow'){
      const boundary=lastBoundary!;expect(boundary.endpoint).toBeDefined();const base=boundary.monotonicNs!,nextEventSeq=String(BigInt(ok(await client.committedThrough(a.session)))+1n);let previous=base;
      for(let n=1;n<=257;n++){
        const ns=(BigInt(base)+BigInt(n)*1000n).toString();
        ok(await client.openAttachedTrip({pluginSessionId:a.session,nextEventSeq,job:job(),effects:[],observeTripUuid:uuid,
          profile:proof(a),sourceClockId:a.clockId,monotonicNs:ns,endpoint:{...boundary.endpoint!,version:1,simulation:'paused',odometerM:1000060,fuelL:99.4+(n%2?0.001:0),speedMps:0,
            gameClockId:a.clockId,gameMinutes:'500',position:{x:12,y:0,z:0},previous:{tripUuid:uuid,sourceClockId:a.clockId,monotonicNs:previous}}}));previous=ns;
      }
    }
    await capture(a,1000100,99,20,'running');
    if(captured){succeeded(await recorder.commit(a.event(r.paused(),{simulation:'paused',advanceMs:50}),context));await capture(a,1000100,99,20,'paused',0);}
    succeeded(await recorder.samples.write(3600,true));const before=ok(await client.journalTrip(uuid));
    if(variant==='path-overflow'){
      expect(await client.close()).toEqual({clean:true});
      const db=new Database(ws.database);db.defaultSafeIntegers(true);
      try{
        // Synthetic valid selected run aliases exceed the recursive path budget; no fixture/history bytes are used.
        let head=db.prepare('SELECT progress_head FROM logical_trips WHERE trip_uuid=?').pluck().get(uuid) as bigint;
        const append=db.prepare(`INSERT INTO logical_progress(logical_ref,trip_ref,anchor_sample_ref,sample_ref,bound_sample_ref,prefix_ref,start_ref,cut_odometer_m,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l)
          SELECT logical_ref,trip_ref,anchor_sample_ref,NULL,bound_sample_ref,?,NULL,cut_odometer_m,truck_ref,odometer_m,start_odometer_m,distance_m,fuel_used_l FROM logical_progress WHERE id=?`);
        for(let n=0;n<257;n++)head=append.run(head,head).lastInsertRowid as bigint;
        db.prepare('UPDATE logical_trips SET progress_head=? WHERE trip_uuid=?').run(head,uuid);
      }finally{db.close();}
      worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
      recorder=new TripRecorderSink(client,{profileEvidence:()=>currentProof});
    }
    currentProof=proof(b);succeeded(await recorder.openSession(b.welcome()));succeeded(recorder.observe(b.checkpoint(null),context));succeeded(await recorder.commit(b.gap(2),context));
    succeeded(await recorder.commit(b.event(r.jobConfigured(),{simulation:'paused'}),context));const savedFuel=(99.4+secondFuel)/2;
    await capture(b,1000060,savedFuel,12,'paused',10);succeeded(await recorder.commit(b.event(r.started()),context));
    await capture(b,1000060,savedFuel,12,'running');
    let last=b;
    if(variant==='restart-equivalent'){
      succeeded(await recorder.commit(b.event(r.paused(),{simulation:'paused',advanceMs:50}),context));await capture(b,1000060,savedFuel,12,'paused',0);
      const c=new Script('10000000-0000-4000-8000-0000000000c3');currentProof=proof(c);succeeded(await recorder.openSession(c.welcome()));succeeded(recorder.observe(c.checkpoint(null),context));
      succeeded(await recorder.commit(c.gap(2),context));succeeded(await recorder.commit(c.event(r.jobConfigured(),{simulation:'paused'}),context));
      await capture(c,1000060,savedFuel,12,'paused',10);succeeded(await recorder.commit(c.event(r.started()),context));await capture(c,1000060,savedFuel,12,'running');last=c;
    }
    await capture(last,1000085,savedFuel-0.5,17,'running');succeeded(await recorder.samples.write(3600,true));
    succeeded(await recorder.commit(last.event(r.delivered(),{simulation:'paused'}),context));const detail=ok(await client.journalTrip(uuid));
    if(conflict){expect(detail.trip.fuelUsedL.available).toBe(false);expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.recordingCompleteness).toBe('partial');}
    else {expect(detail.trip.fuelUsedL.available&&detail.trip.fuelUsedL.value).toBeCloseTo(1.1,9);expect(detail.trip.observedDistanceM).toEqual({available:true,value:85});expect(detail.trip.recordingCompleteness).toBe('complete');}
    expect(ok(await client.listSamples({tripUuid:uuid},{includeExcluded:true}))).toHaveLength(6+(variant==='candidate-overflow'?63:variant==='restart-equivalent'?1:0));
    expect(ok(await client.listSamples({tripUuid:uuid},{afterId:before.exportBounds.snapshot!.samples,includeExcluded:true}))).toHaveLength(4+(variant==='candidate-overflow'?63:0));
    expect(await client.close()).toEqual({clean:true});
  });
  it.each(['between-ticks','earlier-prefix','between-ticks-noisy','earlier-prefix-noisy'] as const)('resumes a captured PAUSED save before its first advancing running sample: %s',async variant=>{
    const earlier=variant.startsWith('earlier-prefix'),noisy=variant.endsWith('noisy');
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});let currentProof:ProfileObservation|undefined;
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>currentProof}),context={receivedUtcMs:1000},a=new Script(ETS2_A),b=new Script(ETS2_B);
    const capture=async(s:Script,odo:number,fuel:number,minutes:string,x:number,simulation:'running'|'paused',advance=1000)=>{
      const configuration=s.checkpoint(job()).data.state.configuration;
      const message=s.snapshot({configuration,simulation,speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},
        gameTime:{available:true,value:minutes,unit:'min',clockId:s.clockId},worldPlacement:{available:true,value:{position:{x,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},advance);
      accepted(recorder.observe(message,context));if(recorder.attach.due())accepted(await recorder.attach.open(context));return message;
    };
    currentProof=proof(a);accepted(await recorder.openSession(a.welcome()));accepted(recorder.observe(a.checkpoint(null),context));
    accepted(await recorder.commit(a.event(r.started()),context));const configured=a.event(r.jobConfigured());accepted(await recorder.commit(configured,context));
    const uuid=tripUuidFor(a.session,configured.data.eventSeq);
    await capture(a,1000000,100,'500',0,'running');await capture(a,1000060,99.4,'500',12,'running');await capture(a,1000100,99,'500',20,'running');
    accepted(await recorder.commit(a.event(r.paused(),{simulation:'paused',advanceMs:250}),context));
    await capture(a,1000125,97.5,'501',25,'paused',0);
    const paused=ok(await client.journalTrip(uuid));
    expect(paused.trip.observedDistanceM).toEqual({available:true,value:125});
    expect(ok(await client.listSamples({tripUuid:uuid}))).toHaveLength(3);
    currentProof=proof(b);accepted(await recorder.openSession(b.welcome()));accepted(recorder.observe(b.checkpoint(null),context));accepted(await recorder.commit(b.gap(2),context));
    accepted(await recorder.commit(b.event(r.jobConfigured(),{simulation:'paused'}),context));
    const odo=earlier?1000060:1000125,fuel=(earlier?99.4:97.5)+(noisy?0.015:0),minutes=earlier?'500':'501',x=(earlier?12:25)+(noisy?0.003:0);
    await capture(b,odo,fuel,minutes,x,'paused',10);
    expect(ok(await client.journalTrip(uuid)).trip.recordingCompleteness).toBe('partial'); // ordered start is still outstanding
    await capture(b,odo,fuel,minutes,x,'paused',10_000); // repeated unchanged pause does not create a sample or a new boundary
    expect(ok(await client.listSamples({pluginSessionId:b.session}))).toHaveLength(0);
    accepted(await recorder.commit(b.event(r.started()),context));
    await capture(b,odo+25,fuel-0.5,minutes,x+5,'running');accepted(await recorder.samples.write(3600,true));
    accepted(await recorder.commit(b.event(r.delivered(),{simulation:'paused'}),context));
    const detail=ok(await client.journalTrip(uuid));expect(detail.trip).toMatchObject({outcome:'delivered',recordingCompleteness:'complete',observedDistanceM:{available:true,value:earlier?85:150}});
    expect(detail.trip.fuelUsedL.available && detail.trip.fuelUsedL.value).toBeCloseTo(earlier?1.1:3,9);
    expect(ok(await client.listTrips()).trips).toHaveLength(2);expect(ok(await client.listSamples({tripUuid:uuid},{includeExcluded:true}))).toHaveLength(4);
    expect(ok(await client.listSamples({tripUuid:uuid}))).toHaveLength(earlier?3:4);
    const oldSamples=ok(await client.listSamples({tripUuid:uuid},{afterId:paused.exportBounds.snapshot!.samples,includeExcluded:true}));expect(oldSamples).toHaveLength(3);
    expect(await client.close()).toEqual({clean:true});
    readOnly(ws.database,db=>{db.defaultSafeIntegers(true);const old=logicalSnapshot(db,uuid,BigInt(paused.exportBounds.snapshot!.samples.split(':')[3]));
      expect(old.row.recording_completeness).toBe('complete');expect(old.row.observed_distance_m).toBe(125);});
  });
  it.each(['clean', 'advanced', 'fuel', 'position', 'game-time', 'unobserved-start', 'ambiguous-bootstrap', 'late-event-loss', 'late-sample-loss', 'late-restore-loss', 'late-discontinuity'] as const)(
    'keeps three-session completeness evidence-dependent across a persistent recorder and full restart: %s', async variant => {
    const accepted = <T>(result: {ok:true;value:T}|{ok:false;error:{code:string}}):T => {if(!result.ok)throw new Error(result.error.code);return result.value;};
    let currentProof: ProfileObservation | undefined;
    let worker=storageWorker(), client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
    const createRecorder=()=>new TripRecorderSink(client,{profileEvidence:()=>currentProof});
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    let recorder=createRecorder(), original=''; const context={receivedUtcMs:1000};
    const scripts=[new Script(ETS2_A),new Script(ETS2_B),new Script('10000000-0000-4000-8000-000000000009')];
    for(const [index,script] of scripts.entries()) {
      if(index===2){expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
        ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));recorder=createRecorder();}
      currentProof=proof(script); accepted(await recorder.openSession(script.welcome()));accepted(recorder.observe(script.checkpoint(null),context));
      if(index===0 && variant!=='unobserved-start')accepted(await recorder.commit(script.event(r.started()),context));
      else if(index>0)accepted(await recorder.commit(script.gap(variant==='ambiguous-bootstrap'?3:2),context));
      const configured=script.event(r.jobConfigured(),{simulation:index===0 && variant!=='unobserved-start'?'running':'paused'});
      accepted(await recorder.commit(configured,context));original ||= tripUuidFor(script.session,configured.data.eventSeq);
      if(index>0 || variant==='unobserved-start')accepted(await recorder.commit(script.event(r.started()),context));
      const configuration=script.checkpoint(job()).data.state.configuration;
      for(let n=0;n<3;n++){
        const step=index*2+n;
        const snapshot=script.snapshot({configuration,simulation:'running',speed:{available:true,value:20,unit:'m/s'},
          odometer:{available:true,value:1000000+step*100+(index>0 && variant==='advanced'?50:0),unit:'m'},fuel:{available:true,value:100-step-(index===1 && n===0 && variant==='fuel'?1:0),unit:'L'},
          gameTime:{available:true,value:index===1 && n===0 && variant==='game-time'?'501':'500',unit:'min',clockId:script.clockId},
          worldPlacement:{available:true,value:{position:{x:step*20+(index===1 && n===0 && variant==='position'?1:0),y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}}},1000);
        accepted(recorder.observe(snapshot,context)); if(recorder.attach.due())accepted(await recorder.attach.open(context));
      }
      accepted(await recorder.samples.write(3600,true));
      if(index<2)accepted(await recorder.commit(script.event(r.paused(),{simulation:'paused'}),context));
      else accepted(await recorder.commit(script.event(r.delivered(),{simulation:'paused'}),context));
      if(index===1 && variant.startsWith('late-'))ok(await client.recordCompleteness(scripts[0].session,{tripUuid:original,
        kind:variant==='late-event-loss'?'event-loss':variant==='late-sample-loss'?'sample-loss':variant==='late-restore-loss'?'restore-loss':'discontinuity',
        ...(variant==='late-event-loss'||variant==='late-restore-loss'?{firstEventSeq:'4',lastEventSeq:'5'}:{}),detail:{cause:'synthetic-retained-loss'}}));
      const detail=ok(await client.journalTrip(original));
      expect(ok(await client.journalTrips()).trips.map(row=>row.tripUuid)).toEqual([original]);
      expect(detail.trip.recordingCompleteness, 'session '+index).toBe(index===0 && variant==='unobserved-start'?'unknown':variant==='clean' || index===0?'complete':'partial');
      if(variant==='clean')expect(detail.trip.observedDistanceM).toEqual({available:true,value:(index+1)*200});
    }
    const detail=ok(await client.journalTrip(original));expect(detail.trip.outcome).toBe('delivered');expect(detail.exportBounds.sourceTotal).toBe(3);
    expect(ok(await client.listTrips()).trips).toHaveLength(3);expect(await client.close()).toEqual({clean:true});
    readOnly(ws.database,db=>{expect(db.prepare("SELECT count(*) FROM trips WHERE outcome='delivered'").pluck().get()).toBe(1);expect(db.pragma('integrity_check',{simple:true})).toBe('ok');});
  });
  it.each([
    {name:'same-second stable snapshot',firstMs:100,advanced:false,missingEndpoint:false},
    {name:'later-second stable snapshot',firstMs:1000,advanced:false,missingEndpoint:false},
    {name:'same-second counter advance',firstMs:100,advanced:true,missingEndpoint:false},
    {name:'later-second counter advance',firstMs:1000,advanced:true,missingEndpoint:false},
    {name:'unsupported reconnect endpoint',firstMs:1000,advanced:false,missingEndpoint:true}
  ])('uses the owned running checkpoint counter baseline: $name',async({firstMs,advanced,missingEndpoint})=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const configuration=s.checkpoint(job()).data.state.configuration;
    let order=100;
    const snapshot=async(odo:number,fuel:number,counter:string,ms=1000)=>{
      const message=s.snapshot({...motion(odo),configuration,simulation:'running',boundaryOrder:String(++order),odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'}},ms);
      message.data.continuity={coalescedSnapshots:counter,offlineTransitions:'7'};
      accepted(recorder.observe(message,context));
      if(recorder.attach.due())accepted(await recorder.attach.open(context));
    };
    await snapshot(1000000,100,'5');await snapshot(1000100,90,'5');accepted(await recorder.samples.write(3600,true));
    const uuid=tripUuidFor(ETS2_A,'1');expect(ok(await client.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:100});
    // Advance into a fresh source second without claiming any observation during the disconnected interval.
    s.snapshot({},1000);accepted(await recorder.openSession(s.welcome()));
    const endpoint=missingEndpoint?1000125:1000100;
    const checkpoint=s.checkpoint(job(),0,{...motion(endpoint),configuration,simulation:'running',boundaryOrder:String(++order),odometer:{available:true,value:endpoint,unit:'m'},fuel:{available:true,value:90,unit:'L'}});
    checkpoint.data.continuity={coalescedSnapshots:'5',offlineTransitions:'7'};
    accepted(recorder.observe(checkpoint,context));
    if(recorder.attach.due())accepted(await recorder.attach.open(context));
    accepted(await recorder.samples.write(3600,true));
    const checkpointRow=ok(await client.listSamples({pluginSessionId:ETS2_A})).find(row=>row.monotonicNs===checkpoint.capture.monotonicNs)!;
    expect(checkpointRow.tripUuid).toBe(uuid);expect(checkpointRow.odometer).toEqual({available:true,value:endpoint});
    const counter=advanced?'6':'5';await snapshot(endpoint+25,89,counter,firstMs);await snapshot(endpoint+50,88,counter);
    accepted(await recorder.samples.write(3600,true));
    const detail=validateJournalTripDetail(ok(await client.journalTrip(uuid)));
    if(!advanced && !missingEndpoint){expect(detail.trip.observedDistanceM).toEqual({available:true,value:150});expect(detail.trip.fuelUsedL).toEqual({available:true,value:12});}
    else {expect(detail.trip.observedDistanceM.available).toBe(false);expect(detail.trip.fuelUsedL.available).toBe(false);}
    expect(ok(await client.listSamples({pluginSessionId:ETS2_A}))).toHaveLength(firstMs===100?4:5);
    expect(ok(await client.committedThrough(ETS2_A))).toBe('1');expect(await client.close()).toEqual({clean:true});
  });
  it('counts ordinary driving after historical nonzero counters and a later coalescing advance',async()=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const configuration=s.checkpoint(job()).data.state.configuration;
    const observe=async(odo:number,counter:string,ms=1000)=>{
      const message=s.snapshot({...motion(odo),configuration,simulation:'running',odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:100,unit:'L'}},ms);
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
    expect(ok(await client.listSamples({tripUuid:uuid},{limit:3600,includeExcluded:true}))).toHaveLength(4);
    expect(await client.close()).toEqual({clean:true});
  });
  it.each([
    {name:'recorded known before unavailable current proof',initial:null,current:null,middle:false,joins:true},
    {name:'missing then recorded known then unavailable member',initial:null,current:null,middle:true,joins:true},
    {name:'conflicting recorded and current facts',initial:null,current:200,middle:false,joins:false},
    {name:'recorded facts conflicting with candidate constraints',initial:200,current:null,middle:false,joins:false}
  ])('retains raw canonical evidence through delayed proof: $name',async({initial,current,middle,joins})=>{
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
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
      {speed:{available:true,value:20},gameTime:{minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},position:{available:true,value:{x:Math.max(0,index-1),y:0,z:0}},fuel:{available:true,value:fuel},odometer:{available:true,value:1000000+Math.max(0,index-1)}}),recording:{profile:proof(s),job:job(),truck:'verified-truck',processInstanceId:s.welcome().source.processInstanceId,
      previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:seedSample(s,uuid,index,1000).monotonicNs}}}));
    ok(storage.appendSamples(ETS2_A,rows(a,first,[100,100]),{uniqueSeconds:true}));close(storage,a,first);
    const b=new Script(ETS2_B),second=open(storage,b);
    ok(storage.appendSamples(ETS2_B,rows(b,second,[100,99,99.005,98.005]),{uniqueSeconds:true}));
    const detail=validateJournalTripDetail(ok(storage.journalTrip(first)));
    expect(detail.trip.fuelUsedL.available && detail.trip.fuelUsedL.value).toBeCloseTo(1.995,9);
  });
  it('does not bridge a same-raw short reconnect without lost events through the recorder and worker',async()=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS}),s=new Script(ETS2_A),context={receivedUtcMs:1000};
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const recorder=new TripRecorderSink(client,{profileEvidence:()=>proof(s)});
    accepted(await recorder.openSession(s.welcome()));accepted(recorder.observe(s.checkpoint(null),context));
    accepted(await recorder.commit(s.event(r.jobConfigured()),context));
    const configuration=s.checkpoint(job()).data.state.configuration;
    for(const odo of [1000000,1000100]){
      accepted(recorder.observe(s.snapshot({...motion(odo),configuration,simulation:'running',odometer:{available:true,value:odo,unit:'m'}},1000),context));
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
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
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
    for(const uuid of [first,second])expect(ok(await client.listSamples({tripUuid:uuid},{limit:3600,includeExcluded:true})).some(row=>row.id===checkpointRow.id)).toBe(false);
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
    const retained=ok(storage.listSamples({tripUuid:uuid},{limit:3600,includeExcluded:true}));expect(retained).toHaveLength(4);
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
    expect(ok(storage.listSamples({tripUuid:first},{limit:3600,includeExcluded:true}))).toHaveLength(3);
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
    expect(ok(storage.listSamples({tripUuid:uuid})).map(s=>s.id)).toEqual(current.map(s=>s.id));
    expect(ok(storage.listSamples({tripUuid:uuid},{limit:3600})).map(s=>s.id)).toEqual(current.map(s=>s.id));
    const raw=ok(storage.listSamples({tripUuid:uuid},{afterId:after.exportBounds.snapshot!.samples,limit:3600,includeExcluded:true}));
    expect(raw.map(s=>s.accountingIncluded)).toEqual([true,true,false,true,true]);
    const old=ok(storage.listSamples({tripUuid:uuid},{afterId:before.exportBounds.snapshot!.samples,limit:3600,includeExcluded:true}));
    expect(old.map(s=>s.accountingIncluded)).toEqual([true,true,true]);
    expect(before.trip.observedDistanceM).toEqual({available:true,value:100});
    for(const includeExcluded of [false,true]) {
      let cursor=after.exportBounds.snapshot!.samples;
      const ids:string[]=[];
      for (;;) {
        const page=ok(storage.listSamples({tripUuid:uuid},{afterId:cursor,limit:2,includeExcluded}));
        ids.push(...page.map(row=>row.id));
        if(page.length<2)break;
        cursor=cursor.slice(0,cursor.lastIndexOf(':')+1)+page.at(-1)!.id;
      }
      expect(ids).toEqual((includeExcluded?raw:current).map(row=>row.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
    sample(storage,a,uuid,6,1000150);
    expect(ok(storage.listSamples({tripUuid:uuid},{afterId:after.exportBounds.snapshot!.samples,limit:2,includeExcluded:true})).map(row=>row.id)).toEqual(raw.slice(0,2).map(row=>row.id));
    expect(ok(storage.listSamples({tripUuid:uuid},{afterId:before.exportBounds.snapshot!.samples})).map(row=>row.id)).toEqual(old.map(row=>row.id));
  });
  it('keeps ordinary single-member exact-endpoint breaks supported and advanced gaps unavailable after later driving',async()=>{
    const storage=await ws.open(),s=new Script(ETS2_A),uuid=open(storage,s);
    sample(storage,s,uuid,1,1000000);sample(storage,s,uuid,2,1000100);
    // A pause/reconnect with the exact observed truck, odometer and fuel endpoint can resume its supported prefix.
    sample(storage,s,uuid,8,1000100,job(),{previous:undefined});sample(storage,s,uuid,9,1000150);
    const supported=validateJournalTripDetail(ok(storage.journalTrip(uuid)));
    expect(supported.trip.observedDistanceM).toEqual({available:true,value:150});
    expect(supported.trip.fuelUsedL.available).toBe(true);
    sample(storage,s,uuid,11,1000200,job(),{previous:undefined});sample(storage,s,uuid,12,1000250);
    const unavailable=validateJournalTripDetail(ok(storage.journalTrip(uuid)));
    expect(unavailable.trip.observedDistanceM.available).toBe(false);expect(unavailable.trip.fuelUsedL.available).toBe(false);
    expect(ok(storage.listSamples({tripUuid:uuid},{includeExcluded:true}))).toHaveLength(6);
    ok(storage.close());readOnly(ws.database,db=>{
      expect(db.prepare('SELECT count(*) AS n FROM trips').get()).toEqual({n:1});
      expect(db.prepare('SELECT count(*) AS n FROM logical_memberships').get()).toEqual({n:1});
      expect(db.prepare('SELECT count(*) AS n FROM samples').get()).toEqual({n:6});
    });
  });
  it('passes explicit raw mode through the real worker and Journal export independently of page size',async()=>{
    const storage=await ws.open(),s=new Script(ETS2_A),uuid=open(storage,s);
    for(const [second,odo] of [[1,1000000],[2,1000050],[3,1000100],[4,1000060],[5,1000100]])sample(storage,s,uuid,second,odo);
    ok(storage.close());
    const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
    const summary=ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const database={purpose:'synthetic',schemaVersion:8} as const;
    const service=new JournalService({history:{state:'open',failureCode:null,client,database,databaseUuid:summary.databaseUuid},stopping:()=>false,log:()=>undefined});
    const selected=ok(await client.listSamples({tripUuid:uuid}));expect(selected.map(row=>row.id)).toEqual(['1','2','4','5']);
    for(const limit of [300,3600]){
      const query={kind:'samples',tripUuid:uuid,page:{limit},includeExcluded:true} as const;
      const page=await service.query(query);expect(page.ok).toBe(true);
      expect(parseJournalReply(query,page)).toEqual(page);
      if(page.ok)expect((page.value as {samples:{id:string}[]}).samples.map(row=>row.id)).toEqual(['1','2','3','4','5']);
    }
    const file=path.join(ws.directory,'raw-trip.json');
    const exporter=new JournalExporter({read:query=>service.query(query),showSaveDialog:()=>Promise.resolve({canceled:false,filePath:file}),
      documents:()=>undefined,localAppData:ws.directory,appVersion:'test',log:()=>undefined});
    const result=await exporter.export(uuid);expect(result).toMatchObject({ok:true,value:{outcome:'saved',samples:5}});
    const exported=JSON.parse(readFileSync(file,'utf8')) as {samples:{id:string;accountingIncluded:boolean}[]};
    expect(exported.samples.map(row=>row.accountingIncluded)).toEqual([true,true,false,true,true]);
    expect(ok(await client.listSamples({tripUuid:uuid},{limit:1,includeExcluded:true}))).toHaveLength(1);
    expect(await client.close()).toEqual({clean:true});await worker.handle.terminate();
  });
  describe('recording provenance fixture',()=>{
    // 260 sessions require 780 real core commands; build the read fixture outside the ordinary 30 s assertion case.
    const PROVENANCE_BUILD_BUDGET_MS=120_000;
    let provenanceWs:Awaited<ReturnType<typeof workspace>>,storage:Storage,first='';
    beforeAll(async()=>{
      provenanceWs=await workspace();storage=await provenanceWs.open();
      for(let i=0;i<260;i++){
        const script=new Script(`10000000-0000-4000-8000-${(i+1000).toString(16).padStart(12,'0')}`),uuid=open(storage,script);
        first ||= uuid;close(storage,script,uuid);
      }
    },PROVENANCE_BUILD_BUDGET_MS);
    afterAll(async()=>{await provenanceWs?.dispose();});
    it('pages recording provenance beyond the detail bound without exposing private profile proof',()=>{
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
  });
  it.each(['driving','paused'] as const)('records next-day %s continuation before the default sample flush through production ingestion and the Journal reply boundary',async driving=>{
    const base=JSON.parse(readFileSync(scenarioPath('normal-delivery'),'utf8'));
    const attributes=[...base.steps[2].attributes,
      {name:'source.company.id',sdkType:'string',value:'synthetic_source'},{name:'destination.company.id',sdkType:'string',value:'synthetic_destination'},
      {name:'cargo.mass',sdkType:'float',value:18000},{name:'job.market',sdkType:'string',value:'freight_market'},{name:'delivery.time',sdkType:'u32',value:13000}];
    const configured={...base.steps[2],attributes};
    const truck={...base.steps[0],attributes:[...base.steps[0].attributes,{name:'license.plate',sdkType:'string',value:'SYN 063'}]};
    const first={...base,id:'logical-before-restart',seed:'et063-before-restart',steps:[truck,base.steps[1],configured,base.steps[3],
      {atMs:100,action:'frame',channels:{speed:20,odometer:1000,'game.time':601,'world.placement':{x:0,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {atMs:1100,action:'frame',channels:{speed:20,odometer:1000.0625,'game.time':602,'world.placement':{x:20,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {atMs:2100,action:'frame',channels:{speed:20,odometer:1000.125,'game.time':603,'world.placement':{x:40,y:0,z:0,heading:0,pitch:0,roll:0}}},
      // Its ACK proves the preceding readings passed the recorder FIFO before the source closes.
      {atMs:2150,action:'gameplay',id:'player.fined',attributes:[{name:'fine',sdkType:'s64',value:'0'}]}],
      transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:2200,action:'disconnect'}]};
    const next={...first,id:'logical-next-day',seed:'et063-next-day',steps:[{atMs:0,action:'utcJump',deltaMs:86_400_000},truck,base.steps[1],configured,base.steps[3],
      {atMs:100,action:'frame',channels:{speed:20,odometer:1000.0625,'game.time':602,'world.placement':{x:20,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {atMs:1100,action:'frame',channels:{speed:20,odometer:1000.125,'game.time':603,'world.placement':{x:40,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {...base.steps[9],atMs:1500},{...base.steps[10],atMs:1510}],transport:[{atMs:0,action:'connect',client:{durable:true}},{atMs:1600,action:'disconnect'}]};
    if(driving==='paused')next.steps.splice(5,0,{atMs:50,action:'lifecycle',event:'simulation.paused'});
    let firstUuid='';
    for(const input of [first,next]){
      const source=scenarioSource(replayV1(input).scenario);
      const profile:ProfileObservation={version:1,scope:'c'.repeat(64),binding:'d'.repeat(64),game:'ets2',pluginSessionId:source.pluginSessionId,
        processInstanceId:source.processInstanceId,sourceClockId:seededId(input.seed,'capture-clock'),afterMonotonicNs:'0',loadGeneration:1};
      let gated=false,held=false,release!:()=>void;
      const membershipAnswer=new Promise<void>(resolve=>{release=resolve;});
      const run=await runRecording(input,{path:ws.database,backups:ws.backups},{profileEvidence:()=>profile,onState:(_state,service)=>{
        if(input!==first || gated)return;gated=true;
        const attach=service.client.openAttachedTrip.bind(service.client),capture=service.recorder.capture.bind(service.recorder),flush=service.ingestion.flush.bind(service.ingestion);
        // Gate one membership answer on tail-event intake instead of relying on host scheduling.
        service.client.openAttachedTrip=async request=>{if(held)return attach(request);held=true;const result=await attach(request);await guarded(membershipAnswer,'next-day tail marker intake',15_000);return result;};
        service.recorder.capture=message=>{if(message.kind==='event' && message.data.record.type==='player.fined')release();return capture(message);};
        // On a source without a tail ACK barrier, stop legitimately drops the queued readings before this answer returns.
        service.ingestion.flush=()=>{const pending=flush();release();return pending;};
      }}).finally(release);
      if(input===first)expect(held).toBe(true);
      for(const ack of run.acks)expect(ack.through).toBeLessThanOrEqual(ack.coverage);
      const client=run.services.at(-1)!.client,list=ok(await client.journalTrips());expect(run.services.flatMap(s=>s.logs.filter(([event])=>event==='V1_DURABLE_UNAVAILABLE' || event==='V1_SAMPLES_DISCARDED'))).toEqual([]);expect(list.trips).toHaveLength(1);
      if(input===first){
        expect(run.served(0).at(-1),'tail event acknowledged before disconnect').toBe('5');
        const samples=ok(await client.listSamples({pluginSessionId:source.pluginSessionId}));
        expect(samples.map(sample=>sample.odometer.available?sample.odometer.value:null),'all original endpoints persisted, including the 62.5 m save point')
          .toEqual([1000000,1000062.5,1000125]);
      }
      firstUuid ||= list.trips[0].tripUuid;expect(list.trips[0].tripUuid).toBe(firstUuid);
      const detail=ok(await client.journalTrip(firstUuid));expect(parseJournalReply({kind:'trip',tripUuid:firstUuid},{ok:true,value:detail})).toEqual({ok:true,value:detail});
      if(input===next){expect(detail.trip).toMatchObject({outcome:'delivered',observedDistanceM:driving==='driving'?{available:true,value:125}:{available:false,reason:'not-observed'}});expect(detail.exportBounds.sourceTotal).toBe(2);}
      expect(await client.close()).toEqual({clean:true});
    }
    const storage=await ws.open();expect(ok(storage.journalTrips()).trips).toHaveLength(1);
    expect(ok(storage.listTrips()).trips).toHaveLength(2);
  },60_000);
});

describe('REG-001/003/005/008/012/014 ET-112b incident continuation corpus',()=>{
  const scope='a'.repeat(64),otherScope='c'.repeat(64);
  const extra=['10000000-0000-4000-8000-000000112004','10000000-0000-4000-8000-000000112005'] as const;
  const atNs=(atMs:number)=>(1_000_000_000_000n+BigInt(atMs)*1_000_000n).toString();
  const absent={available:false,reason:'not-observed'} as const;
  interface SegmentOptions {job?:JobConfiguration;scope?:string;readingJob?:(reading:number)=>JobConfiguration;end?:IncidentSegment['end']|'open';afterReading?:(reading:number)=>void}
  /** One process of the corpus through the storage API: job.configured opens eventSeq 1, readings follow at 1 Hz, then the segment ends. */
  interface Driven {uuid:string;close?:{message:EventMessage;effects:import('../../packages/storage/src').TripEffect[]};script:Script}
  function drive(storage:Storage,segment:IncidentSegment,options:SegmentOptions={}):Driven{
    const script=new Script(segment.session,'ets2',{utcMs:segment.startUtcMs}),values=options.job??INCIDENT_JOB,process=script.welcome().source.processInstanceId;
    const profile:ProfileObservation={...proof(script),scope:options.scope??scope,afterMonotonicNs:atNs(segment.profileFromMs)};
    ok(storage.upsertSession({message:script.welcome()}));
    // The opening event occurs 999 ms into the process; it carries proof only when the proof already exists then.
    const configured=script.event(r.jobConfigured(values)),uuid=tripUuidFor(script.session,configured.data.eventSeq);
    ok(storage.commitEvent({message:configured,...(segment.profileFromMs<=999?{profile}:{}),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,
      jobConfiguration:'this-event',startedUtcMs:segment.startUtcMs+1_000,recordingCompleteness:'complete'},{kind:'event.attribute',tripUuid:uuid,attribution:'trip'}]}));
    for(const [index,reading] of segment.readings.entries()){
      const row:SampleInput={tripUuid:uuid,utcMs:segment.startUtcMs+reading.atMs,sourceClockId:script.clockId,monotonicNs:atNs(reading.atMs),
        odometer:{available:true,value:reading.odometerM},fuel:{available:true,value:reading.fuelL},speed:{available:true,value:reading.speedMps},
        gameTime:{minutes:{available:true,value:reading.gameMinutes},clockId:GAME_CLOCK_1},position:{available:true,value:{x:reading.x,y:0,z:0}},
        averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,
        recording:{...(reading.atMs>=segment.profileFromMs?{profile}:{}),job:options.readingJob?.(index)??values,truck:'verified-truck',processInstanceId:process,
          ...(index>0?{previous:{tripUuid:uuid,sourceClockId:script.clockId,monotonicNs:atNs(segment.readings[index-1].atMs)}}:{})}};
      ok(storage.appendSamples(script.session,[row],{uniqueSeconds:true}));options.afterReading?.(index);
    }
    const end=options.end??segment.end,last=segment.readings.at(-1)!.atMs;
    if(end==='open')return {uuid,script};
    const delivered=end==='delivered',message=script.event(delivered?incidentDelivered():r.timersRestart(),{advanceMs:last});
    const effects:import('../../packages/storage/src').TripEffect[]=[{kind:'trip.close',tripUuid:uuid,outcome:delivered?'delivered':'none',closeReason:delivered?'outcome':'restart',
      ...(delivered?{outcomeEvent:'this-event' as const}:{}),recordingCompleteness:'partial',endedUtcMs:segment.startUtcMs+last+1_000}];
    ok(storage.commitEvent({message,effects}));
    return {uuid,close:{message,effects},script};
  }
  async function reopen(storage:Storage,body?:(db:Database.Database)=>void):Promise<Storage>{
    ok(storage.close());
    if(body){const db=new Database(ws.database);try{body(db);}finally{db.close();}}
    return ws.open();
  }
  /** The hand-written incident expectation: one delivered root with three sources, one delivery and its exact values. */
  function expectIncident(storage:Storage){
    const detail=validateJournalTripDetail(ok(storage.journalTrip(INCIDENT_EXPECTED.rootTripUuid)));
    expect(detail.trip).toMatchObject({tripUuid:INCIDENT_EXPECTED.rootTripUuid,outcome:INCIDENT_EXPECTED.outcome});
    expect(detail.exportBounds.sources?.map(source=>source.pluginSessionId)).toEqual(INCIDENT_EXPECTED.sources);
    expect(detail.outcomeDetails?.record).toMatchObject({type:'job.delivered',revenue:{available:true,value:INCIDENT_EXPECTED.revenue},
      distance:{available:true,value:INCIDENT_EXPECTED.deliveredDistanceM,unit:'m'}});
    const events=validateJournalEventPage(ok(storage.journalEvents(INCIDENT_EXPECTED.rootTripUuid,{limit:500}))).events;
    expect(events.filter(event=>event.type==='job.delivered')).toHaveLength(INCIDENT_EXPECTED.deliveredEvents);
  }
  const trip=(storage:Storage,uuid:string)=>ok(storage.journalTrips()).trips.find(row=>row.tripUuid===uuid);
  /** Drives the corpus from segment `from`; `before` replaces the corpus' own service restart before each segment. */
  async function incident(storage:Storage,from=0,before?:(current:Storage)=>Promise<Storage>,options:(index:number,current:Storage)=>SegmentOptions=()=>({})){
    let last:Driven|undefined;
    for(const [index,segment] of INCIDENT_SEGMENTS.entries()){
      if(index<from)continue;
      storage=before?await before(storage):segment.serviceRestartBefore?await reopen(storage):storage;
      last=drive(storage,segment,options(index,storage));
    }
    return {storage,last:last!};
  }

  it('M1 joins the three incident segments into one delivered trip across a service restart',async()=>{
    expect(FINAL_PROCESS_PROFILE_DELAY_MS).toBe(5_114);
    const {storage}=await incident(await ws.open());
    expectIncident(storage);
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid)).toEqual([INCIDENT_EXPECTED.rootTripUuid]);
    expect(ok(storage.listTrips()).trips).toHaveLength(INCIDENT_EXPECTED.rawTrips);
  });
  it.each(['recorded-incomplete','left-unresolved'] as const)('M2 continues among matching candidates while another job of the profile is unresolved: %s',async variant=>{
    let storage=await ws.open();drive(storage,INCIDENT_SEGMENTS[0]);
    // A recorded job without deadline evidence never retires; the second variant isolates the candidate lookup itself.
    const other=drive(storage,{...INCIDENT_SEGMENTS[0],session:extra[0]},{job:variant==='recorded-incomplete'?INCIDENT_OTHER_JOB_WITHOUT_DEADLINE:INCIDENT_OTHER_JOB,
      scope:variant==='left-unresolved'?otherScope:scope}).uuid;
    if(variant==='left-unresolved')storage=await reopen(storage,db=>db.prepare('UPDATE logical_trips SET profile_scope=? WHERE trip_uuid=?').run(scope,other));
    expect(trip(storage,other)).toMatchObject({outcome:'open'});
    ({storage}=await incident(storage,1));
    expectIncident(storage);
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid).sort()).toEqual([INCIDENT_EXPECTED.rootTripUuid,other].sort());
    expect(trip(storage,other)).toMatchObject({outcome:'open'});
  });
  it.each(['missing','u32-max'] as const)('M3 keeps the candidate when a proof-bearing reading has no current deadline: %s',async variant=>{
    const incomplete=variant==='missing'?INCIDENT_JOB_WITHOUT_DEADLINE:INCIDENT_JOB_U32_MAX_DEADLINE;
    let checked=false;const {storage}=await incident(await ws.open(),0,undefined,(index,current)=>index<2?{}:{
      // Reading 2 is the first one after the delayed proof; reading 3 carries the complete job again.
      readingJob:reading=>reading===2?incomplete:INCIDENT_JOB,
      afterReading:reading=>{if(reading!==2)return;checked=true;
        expect(trip(current,INCIDENT_EXPECTED.rootTripUuid)).toMatchObject({outcome:'open',closeReason:null});
        expect(ok(current.journalTrips()).trips).toHaveLength(2);}
    });
    expect(checked).toBe(true);expectIncident(storage);
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid)).toEqual([INCIDENT_EXPECTED.rootTripUuid]);
  });
  it('M9 keeps an identical new job after the delivery separate',async()=>{
    const {storage}=await incident(await ws.open());
    const next=drive(storage,{...INCIDENT_SEGMENTS[2],session:extra[0]},{end:'open'}).uuid;
    expectIncident(storage);
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid).sort()).toEqual([INCIDENT_EXPECTED.rootTripUuid,next].sort());
    expect(trip(storage,next)).toMatchObject({outcome:'open'});
    expect(validateJournalTripDetail(ok(storage.journalTrip(next))).exportBounds.sources?.map(source=>source.pluginSessionId)).toEqual([extra[0]]);
  });
  it('M10 joins neither of two matching candidates and interrupts both',async()=>{
    let storage=await ws.open();const first=drive(storage,INCIDENT_SEGMENTS[0]).uuid;
    const second=drive(storage,{...INCIDENT_SEGMENTS[1],session:extra[0]},{scope:otherScope}).uuid;
    storage=await reopen(storage,db=>db.prepare('UPDATE logical_trips SET profile_scope=? WHERE trip_uuid=?').run(scope,second));
    const last=drive(storage,{...INCIDENT_SEGMENTS[2],session:extra[1]},{end:'open'}).uuid;
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid).sort()).toEqual([first,second,last].sort());
    for(const uuid of [first,second])expect(trip(storage,uuid)).toMatchObject({outcome:'none',closeReason:'different-job'});
    expect(trip(storage,last)).toMatchObject({outcome:'open'});
  });
  it('M11 interrupts the unresolved incident job when a verified different job starts',async()=>{
    const storage=await ws.open();drive(storage,INCIDENT_SEGMENTS[0]);drive(storage,INCIDENT_SEGMENTS[1]);
    const other=drive(storage,{...INCIDENT_SEGMENTS[2],session:extra[0]},{job:INCIDENT_OTHER_JOB,end:'open'}).uuid;
    expect(trip(storage,INCIDENT_EXPECTED.rootTripUuid)).toMatchObject({outcome:'none',closeReason:'different-job'});
    expect(trip(storage,other)).toMatchObject({outcome:'open'});
    expect(ok(storage.journalTrips()).trips).toHaveLength(2);
  });
  it('M12 counts a duplicate and a redelivered delivery once after a service restart',async()=>{
    const driven=await incident(await ws.open()),delivery=driven.last.close!,storage=await reopen(driven.storage);
    expect(ok(storage.commitEvent(delivery))).toMatchObject({status:'duplicate'});
    expect(ok(storage.commitEvent({...delivery,message:driven.last.script.redeliver(delivery.message)}))).toMatchObject({status:'duplicate'});
    expectIncident(storage);
    expect(ok(storage.journalTrips()).trips).toHaveLength(1);
  });
  it('M14 keeps one trip across a next-day resume and an app restart before every segment',async()=>{
    const {storage}=await incident(await ws.open(),0,current=>{ws.advance(86_400_000);return reopen(current);});
    expectIncident(storage);
    expect(ok(storage.journalTrips()).trips.map(row=>row.tripUuid)).toEqual([INCIDENT_EXPECTED.rootTripUuid]);
  });
});

describe('REG-013 logical singleton migration',()=>{
  it.each([1,2,3])('preserves IDs and raw facts from frozen schema v%i without inferring membership',async version=>{
    const file=ws.copyFixture(`schema-v${version}-representative.sqlite`);
    const before=readOnly(file,db=>db.prepare('SELECT * FROM trips ORDER BY id').all()) as Record<string,unknown>[];
    const storage=await ws.open({path:file});expect(storage.summary.schemaVersion).toBe(8);
    const list=ok(storage.journalTrips()).trips;
    expect(list.map(t=>t.tripUuid).sort()).toEqual(before.map(t=>t.trip_uuid).sort());
    for(const trip of before)expect(ok(storage.journalTrip(String(trip.trip_uuid))).trip.recordingCompleteness).toBe(trip.recording_completeness);
    if(version===3)expect(ok(storage.journalTrip('70000000-0000-4000-8000-000000000001')).trip.recordingCompleteness).toBe('complete');
    ok(storage.close());
    readOnly(file,db=>{
      const after=db.prepare('SELECT * FROM trips ORDER BY id').all() as Record<string,unknown>[];
      expect(after.map(row=>Object.fromEntries(Object.keys(before[0]).map(key=>[key,row[key]])))).toEqual(before);
      expect(db.prepare('SELECT trip_ref,logical_ref FROM logical_memberships ORDER BY trip_ref').all()).toEqual(before.map(row=>({trip_ref:row.id,logical_ref:row.id})));
      expect(db.prepare('SELECT count(*) FROM logical_trips WHERE profile_scope IS NOT NULL OR retired<>1').pluck().get()).toBe(0);
      expect(db.prepare("SELECT count(*) FROM logical_projection_states WHERE json_type(row_json,'$._coverage') IS NOT NULL").pluck().get()).toBe(0);
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
