import Database from 'better-sqlite3';
import {snapshot as logicalSnapshot} from '../../packages/storage/src/sqlite/logical-snapshot';
import net from 'node:net';
import {EventEmitter} from 'node:events';
import {mkdir,writeFile,rename,symlink,opendir,appendFile,realpath,stat,utimes,rm} from 'node:fs/promises';
import {decodePayload,encodeFrame,type ClientMessage,type ServerMessage,type CurrentState} from '../../packages/contracts/src/protocol-v1';
import {HardModeReader,readStableFile} from '../../apps/desktop/src/hard-mode/reader';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import {ProfileObserver} from '../../apps/desktop/src/profile-observation';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {V1Ingestion} from '../../apps/desktop/src/v1-ingestion';
import {serveV1Reactive} from '../../tools/telemetry-simulator/src/v1/reactive';
import {afterEach, beforeEach, describe, expect, it,vi} from 'vitest';
import {readFileSync,type BigIntStats} from 'node:fs';
import path from 'node:path';
import type {SampleInput, Storage} from '../../packages/storage/src';
import {attachTripUuidFor,tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {validateJournalTripDetail, validateJournalEventPage,validateJournalIntervalPage} from '../../packages/contracts/src/journal';
import {ETS2_A, ETS2_B, job, otherJob, r, Script, trailer} from '../shared/trip-messages';
import {MIGRATIONS,openStorage} from '../../packages/storage/src';
import {ok,failed,digestOf,readOnly,STORAGE_FIXTURES,workspace} from './helpers';
import {ClientSocket,guarded,runRecording,terminateWorkers} from './recording-helpers';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {scenarioSource,replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {parseJournalReply} from '../../apps/desktop/src/journal-contract';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import {StorageClient} from '../../packages/storage/src/client';
import {storageWorker} from './recording-helpers';
import {seedSample} from '../shared/journal-seed';
import {JournalService} from '../../apps/desktop/src/journal-service';
import {JournalExporter} from '../../apps/desktop/src/journal-export-writer';

let ws: Awaited<ReturnType<typeof workspace>>;
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
  it.each(['partial-byte-timeout','partial-byte-utf8','partial-byte-unbounded','partial-bytes','partial-byte-missing','partial-config','partial-delete','identity-root','identity-profile','identity-load','identity-namespace','identity-load-after-settings-error','identity-unchanged','identity-append','identity-replaced','identity-missing','identity-redirect','identity-settings','identity-settings-error','watchdog-timer','watchdog-getter','unchanged','witness','admitted-consumption','admitted-refuel','admitted-refuel-recheck','admitted-regression','admitted-long-unchanged','admitted-long-motion','admitted-persist-revoked','revoked','profile','load','gap','clock','truck','job','refuel','teleport','missing','unqualified-sample','over-limit'] as const)('retains only a qualified predecessor through wired lifecycle verification: %s',async variant=>{
    vi.useFakeTimers();const watchdog=variant.startsWith('watchdog-');let clientNs=0n,wireSeq=0n,boundary=100n;const revision='1';const now=()=>++clientNs;const diagnostics:string[]=[];
    const worker=storageWorker(),client=new StorageClient(worker.handle),script=new Script(ETS2_A),welcome=script.welcome();
    let holdPersist=false,persistHeld=false,enterPersist!:()=>void,releasePersist!:()=>void;
    const persistEntered=new Promise<void>(resolve=>{enterPersist=resolve;}),persistRelease=new Promise<void>(resolve=>{releasePersist=resolve;}),persist=client.openAttachedTrip.bind(client);
    const endpointScopes:string[]=[];
    client.openAttachedTrip=async input=>{if(input.endpoint&&input.profile)endpointScopes.push(input.profile.scope);if(holdPersist&&!persistHeld&&input.endpoint){persistHeld=true;enterPersist();await persistRelease;}return persist(input);};
    const documents=path.join(ws.directory,'Documents'),game=path.join(documents,'Euro Truck Simulator 2'),id=Buffer.from('Synthetic').toString('hex').toUpperCase(),directory=path.join(game,'profiles',id);
    await mkdir(directory,{recursive:true});
    const log=`log created on : Wednesday October 21 2026 @ 12:00:00\nNew profile selected: Synthetic\nLoading save. /home/profiles/${id}/save/autosave/game.sii\n`;
    await writeFile(path.join(game,'game.log.txt'),log);await writeFile(path.join(game,'config.cfg'),'uset g_traffic "1"');
    await writeFile(path.join(directory,'config_local.cfg'),'uset g_brake_intensity "0.75"');await writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG);
    let holdGuard=false,guardHeld=false,holdSettings=false,holdLocation=false,failSettings=false,partialMetadata=false,partialBytes=false,preserveMetadata=false,bytesDeleted=false,metadataObserved!:()=>void,enterGuard!:()=>void,releaseGuard!:()=>void,watchdogWork:Promise<void>|undefined,physicalStarts=0;
    const metadataBaseline=new Map<string,BigIntStats>();
    const guardEntered=new Promise<void>(resolve=>{enterGuard=resolve;}),guardRelease=new Promise<void>(resolve=>{releaseGuard=resolve;});
    const observedMetadata=new Promise<void>(resolve=>{metadataObserved=resolve;});
    const reader=new HardModeReader({documents,steamRoot:path.join(ws.directory,'Steam'),diagnostic:value=>diagnostics.push(value.code),fixtureOrigin:'synthetic',nowNs:now,
      profileDirectory:async parent=>{if(holdLocation){enterGuard();await guardRelease;}return opendir(parent);},
      metadata:{realpath:async filename=>{if(partialMetadata&&filename===path.join(game,'config.cfg')){enterGuard();await guardRelease;}try{return await realpath(filename);}catch(error){if(partialMetadata&&filename===path.join(directory,'config.cfg')&&(error as NodeJS.ErrnoException).code==='ENOENT')metadataObserved();throw error;}},
        stat:async filename=>{if(preserveMetadata&&metadataBaseline.has(filename))return metadataBaseline.get(filename)!;const value=await stat(filename,{bigint:true});metadataBaseline.set(filename,value);if(partialMetadata&&filename===path.join(directory,'config.cfg'))metadataObserved();return value;}},
      file:async(filename,limit,signal)=>{if(filename.endsWith('game.log.txt'))physicalStarts++;if(failSettings&&filename===path.join(directory,'config.cfg'))throw new Error('Settings read unavailable');if(holdGuard&&!guardHeld&&filename.endsWith('game.log.txt')||holdSettings&&filename===path.join(directory,'config.cfg')||partialBytes&&filename===path.join(directory,'config_local.cfg')){guardHeld=true;enterGuard();await guardRelease;}
        if(partialBytes&&filename===path.join(directory,'config.cfg')){if(!bytesDeleted){bytesDeleted=true;if(variant==='partial-byte-missing')await rm(filename);if(variant==='partial-byte-utf8')await writeFile(filename,Buffer.from([0xc3,0x28]));if(variant==='partial-byte-unbounded')await writeFile(filename,'x'.repeat(256*1024+1));}try{return await readStableFile(filename,limit,signal);}finally{metadataObserved();}}
        return readStableFile(filename,limit,signal);},
      process:s=>Promise.resolve({pid:s.processId,createdUtcMs:new Date(2026,9,21,12).getTime(),executable:'C:/Synthetic/eurotrucks2.exe',homeDirectory:null})});
    const observer=new ProfileObserver(()=>reader,now,false,value=>diagnostics.push(value.code));let recorder!:TripRecorderSink,settings:Promise<unknown>|undefined,readCompleted:(()=>void)|undefined;const publications:string[]=[];
    const monitor=new HardModeMonitor((s,ns,at,signal,force)=>{const work=observer.readSettings(reader,s,ns,at,signal,force).finally(()=>readCompleted?.());settings=work.catch(()=>undefined);return work;},value=>{publications.push(value.assessment.state);recorder.observeHardMode('ets2',value);},now,()=>reader.requestFull(),()=>reader.canRetain(),undefined,()=>reader.drain(),
      {eligible:()=>reader.guardEligible(),select:key=>reader.selectGuardSource(key)});
    reader.onInvalidate(()=>monitor.invalidate());
    recorder=new TripRecorderSink(client,{profileEvidence:()=>observer.evidence(),profileStatus:()=>observer.status(),hardModeEvidence:()=>monitor.evidence()});
    let committed:(()=>void)|undefined,observed:(()=>void)|undefined,attached:(()=>void)|undefined,replyEnabled=false,boundaryWork:Promise<void>|undefined;let lastServer:ServerMessage=welcome;
    const commit=recorder.commit.bind(recorder),observe=recorder.observe.bind(recorder);
    recorder.commit=async(...args)=>{const result=await commit(...args);committed?.();return result;};
    recorder.observe=(...args)=>{const result=observe(...args);observed?.();return result;};
    const attach=recorder.attach.open.bind(recorder.attach);
    recorder.attach.open=async context=>{const result=await attach(context);attached?.();return result;};
    let pendingProbe:Extract<ClientMessage,{kind:'clock.probe'}>|undefined;
    const answerProbe=(message:Extract<ClientMessage,{kind:'clock.probe'}>)=>{const ns=BigInt(lastServer.capture.monotonicNs)+3n;pendingProbe=undefined;send({...welcome,kind:'clock.reply',capture:{clockId:script.clockId,monotonicNs:ns.toString()},data:{probeId:message.data.probeId,receivedMonotonicNs:(ns-2n).toString(),sentMonotonicNs:(ns-1n).toString()}});};
    const acks:string[]=[],socket=Object.assign(new EventEmitter(),{destroy:()=>undefined,write:(bytes:Uint8Array)=>{
      const message=decodePayload(bytes.subarray(4),'client') as ClientMessage;
      if(message.kind==='ack')acks.push(message.data.throughEventSeq);
      if(message.kind==='clock.probe'){pendingProbe=message;if(replyEnabled)answerProbe(message);}
    }});
    const send=(input:ServerMessage)=>{
      const message=structuredClone(input);message.seq=(++wireSeq).toString();
      if(message.kind==='checkpoint'){message.data.boundarySeq=message.seq;message.data.state.boundaryOrder=(++boundary).toString();message.data.state.configuration.revision=revision;}
      if(message.kind==='snapshot'){message.data.state.boundaryOrder=(++boundary).toString();message.data.state.configuration.revision=revision;}
      if(message.kind==='event'){message.data.occurred.boundaryOrder=(++boundary).toString();message.data.occurred.configurationRevision=revision;}
      lastServer=message;socket.emit('data',encodeFrame(message));
    };
    const ingestion=new V1Ingestion({sink:recorder,connect:()=>socket,diagnose:event=>diagnostics.push(event),now:()=>Number(clientNs)/1e6,nowNs:now,staleMs:1e9,
      onState:state=>{const value=state.fresh&&state.observation?{source:state.observation.source,monotonicNs:state.observation.capture.monotonicNs,clockId:state.observation.capture.clockId,gameClockId:state.observation.state.gameTime.clockId,boundary:state.clockBoundary}:null;observer.select(value);monitor.select(value);}});
    ingestion.onProfileBoundary=()=>{boundaryWork=observer.boundary();};
    const event=async(record:Parameters<Script['event']>[0],simulation:'running'|'paused'='running',advanceMs=10)=>{
      const done=new Promise<void>(resolve=>{committed=resolve;});send(script.event(record,{simulation,advanceMs,configurationRevision:revision}));await done;committed=undefined;
    };
    const snapshot=async(odo:number,fuel:number,simulation:'running'|'paused',advanceMs:number,changes:Partial<CurrentState>={})=>{
      const configuration=script.checkpoint(job(),0,{},revision).data.state.configuration;
      const message=script.snapshot({configuration,simulation,odometer:{available:true,value:odo,unit:'m'},fuel:{available:true,value:fuel,unit:'L'},speed:{available:true,value:simulation==='running'?20:0,unit:'m/s'},gameTime:{available:true,value:'500',unit:'min',clockId:script.gameTime.clockId},worldPlacement:{available:true,value:{position:{x:(odo-1000000)/5,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}},...changes},advanceMs);
      const done=new Promise<void>(resolve=>{observed=resolve;});send(message);await done;observed=undefined;return message;
    };
    const admit=async()=>{await boundaryWork;await settings;await observer.refresh();replyEnabled=true;clientNs+=1_000_000n;if(pendingProbe)answerProbe(pendingProbe);await vi.advanceTimersByTimeAsync(1000);expect(observer.evidence(),JSON.stringify({diagnostics,status:ingestion.current.status,reason:ingestion.current.reason,phase:observer.status().phase})).toBeDefined();};
    const admittedSnapshot=async(odo:number,fuel:number,advanceMs=100,changes:Partial<CurrentState>={})=>{
      expect(observer.status().phase).toBe('admitted');
      const done=new Promise<void>(resolve=>{attached=resolve;});await snapshot(odo,fuel,'paused',advanceMs,changes);await done;attached=undefined;
    };
    try{
      ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
      ingestion.select('synthetic','\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-1-00000000-0000-4000-8000-000000000000');socket.emit('connect');send(welcome);
      const checkpointDone=new Promise<void>(resolve=>{observed=resolve;});send(script.checkpoint(null,0,{},revision));await checkpointDone;observed=undefined;await admit();
      await event(r.started());await event(r.jobConfigured());await admit();
      const uuid=tripUuidFor(script.session,'2');
      await snapshot(1000000,100,'running',1000);await snapshot(1000100,99,'running',1000);succeeded(await recorder.samples.write(3600,true));
      const before=ok(await client.journalTrip(uuid));expect(before.trip.observedDistanceM).toEqual({available:true,value:100});expect(before.trip.fuelUsedL).toEqual({available:true,value:1});
      if(variant.startsWith('partial-')){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).toBeNull();const token=observer.status().token,original=observer.evidence();
        const target=path.join(directory,'config.cfg');
        if(variant==='partial-delete')await rm(target);else if(variant==='partial-config'||variant==='partial-bytes'||variant==='partial-byte-timeout'){await writeFile(target,HARD_MODE_CONFIG.replace('g_fatigue "1"','g_fatigue "0"'));const changed=new Date('2026-10-22T12:00:00Z');await utimes(target,changed,changed);}
        partialBytes=variant.startsWith('partial-byte');preserveMetadata=partialBytes&&variant!=='partial-byte-timeout';partialMetadata=!partialBytes;
        watchdogWork=monitor.refresh(true);await guardEntered;await observedMetadata;
        await Promise.resolve();await Promise.resolve();const during=monitor.evidence().assessment.state;let drained=false;void reader.drain().then(()=>{drained=true;});
        const delivered=r.delivered();if(delivered.type!=='job.delivered')throw new Error('Fixture delivery');await event({...delivered,autoParkUsed:{available:true,value:false}},'paused',100);
        const closed=ok(await client.getTrip(uuid))!;expect(closed).toMatchObject({outcome:'delivered',isHardMode:false});expect(closed.hardModeDetails!.firstLoss).not.toBeNull();
        expect(during).toBe('unknown');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);expect(drained).toBe(false);
        if(variant==='partial-byte-timeout'){
          clientNs+=2_000_000_000n;await vi.advanceTimersByTimeAsync(2000);await settings;
          expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);expect(drained).toBe(false);
          clientNs+=5_001_000_000n;await vi.advanceTimersByTimeAsync(5000);expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
        }
        partialMetadata=false;partialBytes=false;releaseGuard();await watchdogWork;await reader.drain();preserveMetadata=false;
        if(variant==='partial-byte-timeout')expect(observer.evidence()).toBeUndefined();else{expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);}
        expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).toEqual(closed.hardModeDetails!.firstLoss);return;
      }
      if(variant.startsWith('identity-')){
        replyEnabled=false;await event(r.paused(),'paused',100);await snapshot(1000125,98.5,'paused',100);await admit();await admittedSnapshot(1000125,98.5);
        const token=observer.status().token,original=observer.evidence()!,endpointCount=endpointScopes.length;expect(original).toBeDefined();const baseline=ok(await client.journalTrip(uuid));
        expect(baseline.trip.observedDistanceM).toEqual({available:true,value:125});expect(baseline.trip.fuelUsedL).toEqual({available:true,value:1.5});
        const settingsOnly=variant==='identity-settings'||variant==='identity-settings-error'||variant==='identity-unchanged'||variant==='identity-append';
        if(variant==='identity-load-after-settings-error'){
          await rename(path.join(directory,'config.cfg'),path.join(directory,'config.old'));await writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG);failSettings=true;
          await monitor.refresh(true);expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);clientNs+=1_000_000_000n;
        }
        if(variant==='identity-root'){
          const replacement=path.join(ws.directory,'OtherGameRoot');await mkdir(path.join(replacement,'profiles',id),{recursive:true});
          await writeFile(path.join(replacement,'game.log.txt'),log);await writeFile(path.join(replacement,'config.cfg'),'uset g_traffic "1"');
          await writeFile(path.join(replacement,'profiles',id,'config.cfg'),HARD_MODE_CONFIG);await writeFile(path.join(replacement,'profiles',id,'config_local.cfg'),'uset g_brake_intensity "0.75"');
          await rename(game,game+'.old');await symlink(replacement,game,'junction');holdGuard=true;
        }else if(variant==='identity-profile'){
          const other=Buffer.from('OtherSynthetic').toString('hex').toUpperCase();await mkdir(path.join(game,'profiles',other));
          await appendFile(path.join(game,'game.log.txt'),`New profile selected: OtherSynthetic\nLoading save. /home/profiles/${other}/save/autosave/game.sii\n`);
        }else if(variant==='identity-load'||variant==='identity-load-after-settings-error')await appendFile(path.join(game,'game.log.txt'),`Loading save. /home/profiles/${id}/save/autosave/game.sii\n`);
        else if(variant==='identity-namespace'){
          await mkdir(path.join(game,'steam_profiles',id),{recursive:true});await mkdir(path.join(ws.directory,'Steam','userdata','100','227300','remote','profiles',id),{recursive:true});
          await appendFile(path.join(game,'game.log.txt'),`Loading save. /steam/profiles/${id}/save/autosave/game.sii\n`);
        }else if(variant==='identity-append')await appendFile(path.join(game,'game.log.txt'),'Unrelated log append\n');
        else if(variant==='identity-unchanged'){
          // The forced verification below must leave the already qualified profile intact.
        }
        else if(settingsOnly){await rename(path.join(directory,'config.cfg'),path.join(directory,'config.old'));await writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG);failSettings=variant==='identity-settings-error';}
        else{
          await rename(directory,directory+'.old');
          if(variant==='identity-replaced'){await mkdir(directory);await writeFile(path.join(directory,'config.cfg'),HARD_MODE_CONFIG);await writeFile(path.join(directory,'config_local.cfg'),'uset g_brake_intensity "0.75"');}
          if(variant==='identity-redirect')await symlink(directory+'.old',directory,'junction');
        }
        const completed=new Promise<void>(resolve=>{readCompleted=resolve;});holdLocation=variant!=='identity-root'&&variant!=='identity-replaced'&&variant!=='identity-missing'&&variant!=='identity-redirect';
        replyEnabled=false;watchdogWork=monitor.refresh(true);
        if(holdLocation||holdGuard)await guardEntered;else await completed;
        const during=observer.evidence(),duringToken=observer.status().token,duringState=monitor.evidence().assessment.state;
        await snapshot(1000125,98,'paused',100,{speed:{available:true,value:1,unit:'m/s'}});await event(r.fined(),'paused',0);
        const held=ok(await client.journalTrip(uuid));
        expect(held.trip.observedDistanceM).toEqual({available:true,value:125});expect(held.trip.fuelUsedL).toEqual({available:true,value:settingsOnly?2:1.5});
        expect(endpointScopes.slice(endpointCount)).toEqual(settingsOnly?[original.scope]:[]);
        if(!settingsOnly)expect(duringState).toBe('unknown');
        if(variant==='identity-unchanged'||variant==='identity-append'){expect(duringState).toBe('pass');expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).toBeNull();}
        if(settingsOnly){expect(during).toEqual(original);expect(duringToken).toBe(token);}else{expect(during).toBeUndefined();expect(duringToken).not.toBe(token);}
        holdLocation=false;releaseGuard();await completed;
        if(settingsOnly){await admit();await watchdogWork;expect(observer.evidence()).toEqual(original);expect(observer.status().token).toBe(token);}
        else{monitor.close();await watchdogWork;expect(observer.evidence()).toBeUndefined();}
        expect(ok(await client.listSamples({tripUuid:uuid}))).toHaveLength(2);return;
      }
      if(watchdog){
        expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).toBeNull();
        const origin=clientNs;
        for(let second=5;second<60;second+=5){clientNs=origin+BigInt(second)*1_000_000_000n;await reader.resolveProfile(welcome.source,Date.now(),new AbortController().signal,true);}
        clientNs=origin+60_000_000_000n;holdSettings=true;watchdogWork=monitor.refresh();await guardEntered;const token=observer.status().token,starts=physicalStarts;
        clientNs+=2_000_000_000n;await vi.advanceTimersByTimeAsync(2000);await settings;
        expect(monitor.evidence().assessment.state).toBe('pass');expect(observer.evidence()).toBeDefined();expect(observer.status().token).toBe(token);
        for(let second=1;second<5;second++){clientNs+=1_000_000_000n;monitor.heartbeat();await snapshot(1000100,99,'running',1000);}
        clientNs=origin+67_001_000_000n;
        if(variant==='watchdog-timer'){await vi.advanceTimersByTimeAsync(5000);expect(publications.at(-1)).toBe('unknown');}
        // The getter case deliberately leaves timer callbacks pending at the same monotonic deadline.
        expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();expect(observer.status().token).not.toBe(token);
        expect(physicalStarts).toBe(starts);await event(r.fined());const lost=ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss;expect(lost).not.toBeNull();
        const recoveredRead=new Promise<void>(resolve=>{readCompleted=resolve;});holdSettings=false;releaseGuard();await reader.drain();
        expect(monitor.evidence().assessment.state).toBe('unknown');expect(observer.evidence()).toBeUndefined();
        await recoveredRead;await settings;await observer.refresh();expect(monitor.evidence().assessment.state).toBe('unknown');await admit();await watchdogWork;
        expect(monitor.evidence().assessment.state).toBe('pass');await snapshot(1000100,99,'running',1000);await event(r.delivered());
        const recovered=ok(await client.getTrip(uuid))!;expect(recovered.hardModeDetails!.firstLoss).toEqual(lost);expect(recovered.isHardMode).toBe(false);return;
      }
      if(variant==='witness'){
        replyEnabled=false;await event(r.paused(),'paused',10);await snapshot(1000110,98.9,'paused',10);await admit();await snapshot(1000110,98.9,'paused',10);
        expect(ok(await client.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:110});
        replyEnabled=false;await event(r.started(),'running',10);await admit();await snapshot(1000120,98.7,'running',10);
      }
      const token=observer.status().token;replyEnabled=false;holdGuard=variant==='unchanged';await event(r.paused(),'paused',100);
      if(variant==='unchanged')await guardEntered;
      expect(observer.evidence()).toBeUndefined();expect(observer.status()).toEqual({phase:'pending',token});
      const changes:Partial<CurrentState>={};
      if(variant==='clock')changes.gameTime={available:true,value:'500',unit:'min',clockId:'40000000-0000-4000-8000-000000000099'};
      if(variant==='truck'){const configuration=script.checkpoint(job()).data.state.configuration;if(configuration.truck.available)configuration.truck.value.licensePlate={available:true,value:'OTHER'};changes.configuration=configuration;}
      if(variant==='job')changes.configuration=script.checkpoint(otherJob()).data.state.configuration;
      if(variant==='missing')changes.worldPlacement={available:false,reason:'not-observed'};
      if(variant==='teleport')changes.worldPlacement={available:true,value:{position:{x:10000,y:0,z:0},orientation:{heading:0,pitch:0,roll:0}}};
      await snapshot(1000125,variant==='refuel'?110:98.5,'paused',variant==='over-limit'?5000:100,changes);
      expect(ok(await client.listSamples({tripUuid:uuid}))).toHaveLength(2);
      if(variant==='unchanged'){await event(r.paused(),'paused',0);releaseGuard();}
      if(variant==='revoked')observer.suspend();
      if(variant==='load')await writeFile(path.join(game,'game.log.txt'),log+`Loading save. /home/profiles/${id}/save/autosave/game.sii\n`);
      if(variant==='profile')await writeFile(path.join(game,'game.log.txt'),log+'New profile selected: Other\n');
      if(variant==='gap'){
        const done=new Promise<void>(resolve=>{committed=resolve;});send(script.gap(1,'queueCount',10));await done;committed=undefined;
      }
      if(variant==='unqualified-sample')await snapshot(1000130,98.4,'running',1000);
      await boundaryWork;
      if(variant==='load'||variant==='profile'||variant==='revoked'){
        clientNs+=5_000_000_000n;await observer.refresh();
      }
      if(variant!=='profile'){
        await admit();
        if(variant.startsWith('admitted-')){
          if(variant==='admitted-persist-revoked'){
            holdPersist=true;const capturedToken=observer.status().token,capturedProof=observer.evidence()!;
            const pendingWrite=admittedSnapshot(1000125,98.5);await persistEntered;
            observer.suspend();boundaryWork=observer.boundary();await admit();
            expect(observer.status().token).not.toBe(capturedToken);expect(observer.evidence()!.binding).toBe(capturedProof.binding);
            releasePersist();await pendingWrite;
          }else await admittedSnapshot(1000125,98.5);
          const first=ok(await client.journalTrip(uuid));expect(first.trip.observedDistanceM).toEqual({available:true,value:125});expect(first.trip.fuelUsedL).toEqual({available:true,value:1.5});
          if(variant==='admitted-persist-revoked'){
            await admittedSnapshot(1000125,98.4);
          }else if(variant==='admitted-regression'){
            await admittedSnapshot(1000150,98,100,{speed:{available:true,value:20,unit:'m/s'}});
            expect(ok(await client.journalTrip(uuid)).trip.observedDistanceM).toEqual({available:true,value:150});
            await admittedSnapshot(1000140,97.5,100,{speed:{available:true,value:20,unit:'m/s'}});
          }else if(variant==='admitted-long-unchanged'||variant==='admitted-long-motion'){
            // Change only the speed hint to persist the same physical endpoint after each long admitted pause.
            await admittedSnapshot(1000125,98.5,6000,{speed:{available:true,value:1,unit:'m/s'}});
            expect(ok(await client.journalTrip(uuid)).trip.fuelUsedL).toEqual({available:true,value:1.5});
            if(variant==='admitted-long-motion')await admittedSnapshot(1000150,98,6000,{speed:{available:true,value:20,unit:'m/s'}});
            else await admittedSnapshot(1000125,98.5,6000,{speed:{available:true,value:2,unit:'m/s'}});
          }else{
            const refuel=variant==='admitted-refuel'||variant==='admitted-refuel-recheck';
            await admittedSnapshot(1000125,refuel?96:98);
            expect(ok(await client.journalTrip(uuid)).trip.fuelUsedL).toEqual({available:true,value:refuel?4:2});
            await admittedSnapshot(1000125,refuel?97:97.5);
            if(variant==='admitted-refuel-recheck'){
              expect(ok(await client.journalTrip(uuid)).trip.fuelUsedL).toEqual({available:false,reason:'not-observed'});
              replyEnabled=false;await event(r.paused(),'paused',10);await snapshot(1000125,96.5,'paused',10);await admit();await admittedSnapshot(1000125,96.5);
            }
          }
        }else await snapshot(1000125,98.5,'paused',100);
      }
      succeeded(await recorder.samples.write(3600,true));
      const detail=ok(await client.journalTrip(uuid));
      if(variant==='unchanged'||variant==='witness'||variant==='admitted-consumption'||variant==='admitted-long-unchanged'){
        expect(detail.trip.observedDistanceM).toEqual({available:true,value:125});expect(detail.trip.fuelUsedL).toEqual({available:true,value:variant==='admitted-consumption'?2.5:1.5});expect(detail.trip.recordingCompleteness).toBe('complete');
        const samples=ok(await client.listSamples({tripUuid:uuid}));expect(samples).toHaveLength(2);expect(samples.map(sample=>sample.speed.available?sample.speed.value:null)).toEqual([20,20]);
        expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).toBeNull();
      }else{
        // No newly admitted endpoint exists after profile/clock uncertainty:
        // its already supported prefix remains 100 m/1 L. An admitted but unsupported new leg is unavailable.
        if(variant==='profile'||variant==='clock'){
          expect(detail.trip.observedDistanceM).toEqual({available:true,value:100});expect(detail.trip.fuelUsedL).toEqual({available:true,value:1});
        }else{
          expect(detail.trip.observedDistanceM).toEqual({available:false,reason:'not-observed'});expect(detail.trip.fuelUsedL).toEqual({available:false,reason:'not-observed'});
        }
        if(variant==='gap')expect(detail.trip.recordingCompleteness).toBe('partial');
        if(variant==='profile'||variant==='load'||variant==='clock')expect(ok(await client.getTrip(uuid))!.hardModeDetails!.firstLoss).not.toBeNull();
      }
      expect(acks).toContain('3');
    }finally{releasePersist();releaseGuard();monitor.close();observer.close();await watchdogWork;await ingestion.stop();await client.close();}
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),script=new Script(ETS2_A);
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
  it.each(['absent','unsupported','malformed','extra'] as const)('distinguishes legacy absent coverage from present-invalid metadata: %s',async kind=>{
    let storage=await ws.open();const script=new Script(ETS2_A),uuid=open(storage,script);ok(storage.close());
    const db=new Database(ws.database);let row:{id:number;row_json:string};
    try{row=db.prepare('SELECT s.id,s.row_json FROM logical_revisions r JOIN logical_projection_states s ON s.id=r.state_ref ORDER BY r.id DESC LIMIT 1').get() as {id:number;row_json:string};
      const metadata=JSON.parse(row.row_json);if(kind==='absent')delete metadata._coverage;else metadata._coverage=kind==='unsupported'?{...metadata._coverage,version:99}:kind==='extra'?{...metadata._coverage,unknown:true}:{version:1};
      row.row_json=JSON.stringify(metadata);db.prepare('UPDATE logical_projection_states SET row_json=? WHERE id=?').run(row.row_json,row.id);
    }finally{db.close();}
    storage=await ws.open();expect(ok(storage.journalTrip(uuid)).trip.recordingCompleteness).toBe(kind==='absent'?'complete':'partial');storage.close();
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
    let currentProof:ProfileObservation|undefined,worker=storageWorker(),client=new StorageClient(worker.handle),ingestion:V1Ingestion;
    const acks:{through:string;stored:string}[]=[];let original='';let closed:()=>void=()=>undefined;const coverage=new Map<string,string>();
    const create=()=>{
      const event=client.commitEvent.bind(client),gap=client.commitGap.bind(client);
      client.commitEvent=async input=>{const result=await event(input);if(result.ok)coverage.set((input.message as {source:{pluginSessionId:string}}).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      client.commitGap=async input=>{const result=await gap(input);if(result.ok)coverage.set((input.message as {source:{pluginSessionId:string}}).source.pluginSessionId,result.value.committedThroughEventSeq);return result;};
      const sink=new TripRecorderSink(client,{profileEvidence:()=>currentProof});
      ingestion=new V1Ingestion({sink,connect:endpoint=>{
        const socket=new ClientSocket(net.connect(endpoint),undefined,error=>{throw error;});
        const write=socket.write.bind(socket);
        socket.write=(bytes,...rest)=>{const message=decodePayload(bytes.subarray(4),'client',{maxMinor:2}) as ClientMessage;
          if(message.kind==='ack')acks.push({through:message.data.throughEventSeq,stored:coverage.get(message.data.pluginSessionId) ?? '0'});
          return write(bytes,...rest);};
        socket.once('close',()=>{ingestion.select('game');closed();});return socket;
      }});
    };
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));create();
    for(const [index,input] of [first,second,third].entries()){
      if(index===2){await ingestion!.stop();expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle);
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
  it.each(['between-ticks','earlier-prefix'] as const)('resumes a captured PAUSED save before its first advancing running sample: %s',async variant=>{
    const accepted=<T>(result:{ok:true;value:T}|{ok:false;error:{code:string}}):T=>{if(!result.ok)throw new Error(result.error.code);return result.value;};
    const worker=storageWorker(),client=new StorageClient(worker.handle);let currentProof:ProfileObservation|undefined;
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
    const odo=variant==='earlier-prefix'?1000060:1000125,fuel=variant==='earlier-prefix'?99.4:97.5,minutes=variant==='earlier-prefix'?'500':'501',x=variant==='earlier-prefix'?12:25;
    await capture(b,odo,fuel,minutes,x,'paused',10);
    expect(ok(await client.journalTrip(uuid)).trip.recordingCompleteness).toBe('partial'); // ordered start is still outstanding
    await capture(b,odo,fuel,minutes,x,'paused',10_000); // repeated unchanged pause does not create a sample or a new boundary
    expect(ok(await client.listSamples({pluginSessionId:b.session}))).toHaveLength(0);
    accepted(await recorder.commit(b.event(r.started()),context));
    await capture(b,odo+25,fuel-0.5,minutes,x+5,'running');accepted(await recorder.samples.write(3600,true));
    accepted(await recorder.commit(b.event(r.delivered(),{simulation:'paused'}),context));
    const detail=ok(await client.journalTrip(uuid));expect(detail.trip).toMatchObject({outcome:'delivered',recordingCompleteness:'complete',observedDistanceM:{available:true,value:variant==='earlier-prefix'?85:150}});
    expect(detail.trip.fuelUsedL.available && detail.trip.fuelUsedL.value).toBeCloseTo(variant==='earlier-prefix'?1.1:3,9);
    expect(ok(await client.listTrips()).trips).toHaveLength(2);expect(ok(await client.listSamples({tripUuid:uuid},{includeExcluded:true}))).toHaveLength(4);
    expect(ok(await client.listSamples({tripUuid:uuid}))).toHaveLength(variant==='earlier-prefix'?3:4);
    const oldSamples=ok(await client.listSamples({tripUuid:uuid},{afterId:paused.exportBounds.snapshot!.samples,includeExcluded:true}));expect(oldSamples).toHaveLength(3);
    expect(await client.close()).toEqual({clean:true});
    readOnly(ws.database,db=>{db.defaultSafeIntegers(true);const old=logicalSnapshot(db,uuid,BigInt(paused.exportBounds.snapshot!.samples.split(':')[3]));
      expect(old.row.recording_completeness).toBe('complete');expect(old.row.observed_distance_m).toBe(125);});
  });
  it.each(['clean', 'advanced', 'fuel', 'position', 'game-time', 'unobserved-start', 'ambiguous-bootstrap', 'late-event-loss', 'late-sample-loss', 'late-restore-loss', 'late-discontinuity'] as const)(
    'keeps three-session completeness evidence-dependent across a persistent recorder and full restart: %s', async variant => {
    const accepted = <T>(result: {ok:true;value:T}|{ok:false;error:{code:string}}):T => {if(!result.ok)throw new Error(result.error.code);return result.value;};
    let currentProof: ProfileObservation | undefined;
    let worker=storageWorker(), client=new StorageClient(worker.handle);
    const createRecorder=()=>new TripRecorderSink(client,{profileEvidence:()=>currentProof});
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    let recorder=createRecorder(), original=''; const context={receivedUtcMs:1000};
    const scripts=[new Script(ETS2_A),new Script(ETS2_B),new Script('10000000-0000-4000-8000-000000000009')];
    for(const [index,script] of scripts.entries()) {
      if(index===2){expect(await client.close()).toEqual({clean:true});worker=storageWorker();client=new StorageClient(worker.handle);
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
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
    const worker=storageWorker(),client=new StorageClient(worker.handle),s=new Script(ETS2_A),context={receivedUtcMs:1000};
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
    const worker=storageWorker(),client=new StorageClient(worker.handle);
    const summary=ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'synthetic',appVersion:'test'}));
    const database={purpose:'synthetic',schemaVersion:4} as const;
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
      {atMs:100,action:'frame',channels:{speed:20,odometer:1000,'game.time':601,'world.placement':{x:0,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {atMs:1100,action:'frame',channels:{speed:20,odometer:1000.0625,'game.time':602,'world.placement':{x:20,y:0,z:0,heading:0,pitch:0,roll:0}}},
      {atMs:2100,action:'frame',channels:{speed:20,odometer:1000.125,'game.time':603,'world.placement':{x:40,y:0,z:0,heading:0,pitch:0,roll:0}}}],
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
