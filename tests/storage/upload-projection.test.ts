// Hand-authored game-shaped streams in isolated temporary databases, never real game or performance evidence.
import {randomUUID} from 'node:crypto';
import {vi} from 'vitest';
import {Storage} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {revise} from '../../packages/storage/src/sqlite/logical-trips';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {StorageClient} from '../../packages/storage/src/client';
import type {SampleInput, TripEffect} from '../../packages/storage/src/api';
import {mapUploadProjection, UPLOAD_PAGE_KINDS, type UploadProjection, type UploadProjectionPage} from '../../packages/storage/src/upload-projection';
import {recheckUploadProjection} from '../../packages/storage/src/sqlite/upload-projection';
import {attachTripUuidFor, tripUuidFor, type ProfileObservation} from '../../packages/telemetry-core/src';
import {ETS2_A, ETS2_B, job, r, Script, trailer} from '../shared/trip-messages';
import {failed, ok, readOnly, TEST_CLOSE_GRACE_MS, withEventSeq, workspace} from './helpers';
import {storageWorker, terminateWorkers} from './recording-helpers';

const directStorage:Storage[]=[];
function tracked(connection:ConstructorParameters<typeof Storage>[0]){const storage=new Storage(connection);directStorage.push(storage);return storage;}
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => {ws=await workspace();});
afterEach(async () => {await terminateWorkers();for(const storage of directStorage.splice(0))storage.close();await ws.dispose();});
const mode = {mode:'unknown',method:'none',confidence:'none'} as const;
const absent = {available:false,reason:'not-observed'} as const;
const gameShaped = <T extends {source:{origin:string}}>(message:T):T => ({...message,source:{...message.source,origin:'game'}});
function proof(s:Script):ProfileObservation {const source=s.welcome().source;return {version:1,scope:'a'.repeat(64),binding:'b'.repeat(64),game:source.game,
  pluginSessionId:source.pluginSessionId,processInstanceId:source.processInstanceId,sourceClockId:s.clockId,afterMonotonicNs:'0',loadGeneration:1};}
async function start(purpose:'history'|'synthetic'|'replay'='history') {
  const worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});
  ok(await client.open({path:ws.database,purpose,backupsDirectory:ws.backups,appVersion:'0.1.0-test'}));return client;
}
async function open(client:StorageClient,s:Script,verified=true,seq=1,rawTripUuid?:string) {
  ok(await client.upsertSession({message:gameShaped(s.welcome())}));
  if(seq>1)ok(await client.commitGap({message:gameShaped(s.gap(seq-1))}));
  const message=gameShaped(s.event(r.jobConfigured())),uuid=rawTripUuid??tripUuidFor(s.session,message.data.eventSeq);
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
async function appendSample(client:StorageClient,s:Script,uuid:string,second:number,odo:number) {
  const sample:SampleInput={tripUuid:uuid,utcMs:1000+second*1000,sourceClockId:s.clockId,monotonicNs:String(second*1_000_000_000),gameTime:{minutes:{available:true,value:500},clockId:'40000000-0000-4000-8000-000000000001'},
    speed:{available:true,value:20},odometer:{available:true,value:odo},fuel:{available:true,value:500-odo/10000},averageConsumption:absent,estimatedRange:absent,engineRpm:absent,gear:absent,position:{available:true,value:{x:odo/5,y:0,z:0}},
    recording:{profile:proof(s),job:job(),truck:'fixture-truck',processInstanceId:s.welcome().source.processInstanceId,
      previous:{tripUuid:uuid,sourceClockId:s.clockId,monotonicNs:String((second-1)*1_000_000_000)}}};
  ok(await client.appendSamples(s.session,[sample]));
}
async function prepare(client:StorageClient,tripUuid:string) {
  const pinId=randomUUID();let state=ok(await client.beginUploadProjection({pinId,tripUuid}));
  for(let turn=0;state.state==='preparing' && turn<10000;turn++){state=ok(await client.advanceUploadProjection(pinId));expect(state.examined).toBeLessThanOrEqual(100);}
  if(!state.projection)throw new Error(`Preparation ${state.state}`);
  return {ok:true as const,value:state.projection};
}
async function pages(client:StorageClient,pin:UploadProjection,limit=7) {
  const result:UploadProjectionPage[]=[];
  for(const kind of UPLOAD_PAGE_KINDS){let cursor:string|undefined;
    do{const page=ok(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind,cursor,limit}));result.push(page);cursor=page.nextCursor??undefined;}while(cursor);
  }return result;
}
function recheck(pin:UploadProjection) {return readOnly(ws.database,db=>{db.defaultSafeIntegers(true);return recheckUploadProjection(db,pin);});}

describe('immutable private upload projections through the SQLite worker', () => {
  it('invalidates preparation when unrelated deletion lets a new interval reuse an ID inside the captured bound',async()=>{
    ws.copyFixture('schema-v4-representative.sqlite',ws.database);
    const client=await start('synthetic'),root='70000000-0000-4000-8000-000000000001',unrelated='70000000-0000-4000-8000-000000000004';
    const ready=ok(await prepare(client,root)),before=await pages(client,ready),pinId=randomUUID();
    expect(ready.revision).toBe('1');expect(ready.bounds.intervals).toBe('2');expect(ready.totals.intervals).toBe(0);
    expect(ok(await client.beginUploadProjection({pinId,tripUuid:root})).state).toBe('preparing');
    ok(await client.deleteTrip(unrelated,{rejectIfOpen:false}));
    ok(await client.recordCompleteness('10000000-0000-4000-8000-000000000001',{tripUuid:root,kind:'sample-loss'}));
    await client.close();
    expect(readOnly(ws.database,db=>db.prepare('SELECT id FROM completeness_intervals WHERE trip_ref=1').pluck().all())).toEqual([2]);
    const reopened=await start('synthetic');
    expect(ok(await reopened.advanceUploadProjection(pinId))).toMatchObject({state:'invalidated',examined:0,projection:null});
    expect(await pages(reopened,ready)).toEqual(before);await reopened.close();expect(recheck(ready)).toBe(false);
  });
  it('tracks interval insert/update/delete through current and previous roots without inventing a root for unassigned intervals',async()=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer();
    const generations=()=>[1,2,3].map(id=>db.prepare('SELECT generation FROM upload_projection_evidence_versions WHERE root_ref=?').pluck().get(id)??0n);
    db.prepare('UPDATE logical_memberships SET previous_logical_ref=3,joined_after_revision=1 WHERE trip_ref=2').run();
    expect(generations()).toEqual([0n,1n,1n]);
    const interval=db.prepare("INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,created_utc_ms) VALUES(1,2,'sample-loss',1000)").run().lastInsertRowid;
    expect(generations()).toEqual([0n,2n,2n]);
    db.prepare('UPDATE completeness_intervals SET trip_ref=1 WHERE id=?').run(interval);expect(generations()).toEqual([1n,3n,3n]);
    // An in-place content change also invalidates captured evidence, with the same root counted once.
    db.prepare("UPDATE completeness_intervals SET kind='event-loss' WHERE id=?").run(interval);expect(generations()).toEqual([2n,3n,3n]);
    db.prepare('UPDATE completeness_intervals SET trip_ref=NULL WHERE id=?').run(interval);expect(generations()).toEqual([3n,3n,3n]);
    db.prepare('DELETE FROM completeness_intervals WHERE id=?').run(interval);expect(generations()).toEqual([3n,3n,3n]);
    const unassigned=db.prepare("INSERT INTO completeness_intervals(plugin_session_ref,kind,created_utc_ms) VALUES(1,'sample-loss',1000)").run().lastInsertRowid;
    db.prepare("UPDATE completeness_intervals SET kind='event-loss' WHERE id=?").run(unassigned);
    db.prepare('DELETE FROM completeness_intervals WHERE id=?').run(unassigned);expect(generations()).toEqual([3n,3n,3n]);
    const previous=db.prepare("INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,created_utc_ms) VALUES(1,2,'sample-loss',1000)").run().lastInsertRowid;
    expect(generations()).toEqual([3n,4n,4n]);
    db.prepare('DELETE FROM completeness_intervals WHERE id=?').run(previous);expect(generations()).toEqual([3n,5n,5n]);
    // Group deletion removes membership first, so interval cleanup must not reference a deleted logical root.
    ok(storage.deleteTrip('70000000-0000-4000-8000-000000000002'));
    expect(db.pragma('foreign_key_check')).toEqual([]);storage.close();
  });
  it.each([false,true])('never resurrects a released handle when caller UUID/root/revision repeat (changed old link: %s)',async changed=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer();
    const tripUuid='70000000-0000-4000-8000-000000000001',pinId=randomUUID();
    ok(storage.commitEvent({message:withEventSeq('event-trailer-configured',7n)}));revise(db,1n);
    ok(storage.beginUploadProjection({pinId,tripUuid}));const first=ok(storage.advanceUploadProjection(pinId)).projection!;
    expect(recheckUploadProjection(db,first)).toBe(true);
    expect(ok(storage.beginUploadProjection({pinId,tripUuid})).projection).toEqual(first);
    expect(ok(storage.releaseUploadProjection(pinId)).state).toBe('released');
    if(changed)db.prepare('INSERT INTO trip_trailers VALUES(1,1)').run();
    ok(storage.beginUploadProjection({pinId,tripUuid}));const second=ok(storage.advanceUploadProjection(pinId)).projection!;
    expect(second.revision).toBe(first.revision);expect(second.facts).toEqual(first.facts);expect(second.snapshot).not.toBe(first.snapshot);
    expect(second.snapshot.split(':')[3]).not.toBe(first.snapshot.split(':')[3]);expect(second.totals.configurations).toBe(changed?1:0);
    failed(storage.readUploadProjectionPage({snapshot:first.snapshot,kind:'members',limit:1}),'INVALID_INPUT');
    expect(recheckUploadProjection(db,first)).toBe(false);expect(recheckUploadProjection(db,second)).toBe(true);
    expect(ok(storage.readUploadProjectionPage({snapshot:second.snapshot,kind:'members',limit:1})).rows).toHaveLength(1);storage.close();
  });
  it('persists a >100 member cursor, counts empty traversal work, yields to recorder commits and uses indexed source plans',async()=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer();
    const root='70000000-0000-4000-8000-000000000001',pinId=randomUUID();
    ok(storage.commitEvent({message:withEventSeq('event-trailer-configured',7n)}));
    db.transaction(()=>{
      db.exec('CREATE TEMP TABLE member_seed AS SELECT * FROM trips WHERE id=1');
      for(let id=20;id<=520;id+=2){
        db.prepare('UPDATE member_seed SET id=?,trip_uuid=?').run(id,`71000000-0000-4000-8000-${String(id).padStart(12,'0')}`);
        db.exec('INSERT INTO trips SELECT * FROM member_seed');
        db.prepare('INSERT INTO logical_memberships(trip_ref,logical_ref,decision_key) VALUES(?,1,?)').run(id,`fixture-member-${id}`);
      }
      // One shared event has hundreds of links, but must produce one deterministic configuration.
      db.exec('INSERT INTO trip_trailers SELECT trip_ref,1 FROM logical_memberships WHERE logical_ref=1');
      db.exec("INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,created_utc_ms) SELECT 1,trip_ref,'sample-loss',1000 FROM logical_memberships WHERE logical_ref=1");
      // Interleave 151 rejected previous memberships below the current-member bound, so each is examined.
      for(let id=21;id<=321;id+=2){
        db.prepare('UPDATE member_seed SET id=?,trip_uuid=?').run(id,`72000000-0000-4000-8000-${String(id).padStart(12,'0')}`);db.exec('INSERT INTO trips SELECT * FROM member_seed');
        db.prepare('INSERT INTO logical_memberships(trip_ref,logical_ref,previous_logical_ref,joined_after_revision,decision_key) VALUES(?,2,1,1,?)').run(id,`old-member-${id}`);
      }
      db.prepare('UPDATE logical_trips SET member_count=252 WHERE id=1').run();revise(db,1n);
    })();
    for(const sql of [
      'SELECT trip_ref FROM logical_memberships WHERE logical_ref=1 AND trip_ref>0 ORDER BY trip_ref LIMIT 1',
      'SELECT trip_ref FROM logical_memberships WHERE previous_logical_ref=1 AND trip_ref>0 ORDER BY trip_ref LIMIT 1',
      'SELECT trailer_configuration_ref FROM trip_trailers WHERE trip_ref=1 AND trailer_configuration_ref>0 ORDER BY trailer_configuration_ref LIMIT 1',
      'SELECT id FROM completeness_intervals WHERE trip_ref=1 AND id>0 ORDER BY id LIMIT 1']){
      const plan=db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as {detail:string}[];
      expect(plan.some(p=>/SEARCH .* (?:COVERING )?INDEX/.test(p.detail)),sql).toBe(true);
      expect(plan.some(p=>/TEMP B-TREE|SCAN /.test(p.detail)),sql).toBe(false);
    }
    // INTEGER PRIMARY KEY id is already the rowid tiebreaker in the existing trip index.
    const intervalPlan=(db.prepare('EXPLAIN QUERY PLAN SELECT id,kind,plugin_session_ref FROM completeness_intervals WHERE trip_ref=? AND id>? AND id<=? ORDER BY id LIMIT ?')
      .all(1n,0n,9_223_372_036_854_775_807n,1) as {detail:string}[]).map(row=>row.detail);
    expect(intervalPlan).toEqual(['SEARCH completeness_intervals USING INDEX completeness_intervals_trip (trip_ref=? AND rowid>? AND rowid<?)']);
    // Observe persisted copies and cursors independently of the worker's examined counter or SQL spellings.
    const observe=(connection:typeof db)=>{
      const prepare=connection.prepare.bind(connection);
      return ()=>({
        cursor:prepare('SELECT phase,member_after,item_after,source_after FROM upload_projection_pins WHERE pin_id=?').get(pinId),
        copies:Object.fromEntries(['members','configurations','intervals'].map(kind=>[kind,Number(prepare(`SELECT count(*) FROM upload_projection_${kind} WHERE pin_ref=?`).pluck().get(pinId))])) as Record<'members'|'configurations'|'intervals',number>
      });
    };
    // From the fixture: 252 current rows, 151 rejected previous rows, and one phase-end transition each.
    // Each member then costs entry + one link/interval + empty end; each stream adds one phase-end.
    // Total: 252+1+151+1 + (252*3+1)*2 + finalization = 1920 units, or 19 full turns and 20 units.
    const milestones={
      1:{cursor:{phase:'current',member_after:216n,item_after:0n,source_after:0n},copies:{members:100,configurations:0,intervals:0}},
      2:{cursor:{phase:'current',member_after:416n,item_after:0n,source_after:0n},copies:{members:200,configurations:0,intervals:0}},
      3:{cursor:{phase:'previous',member_after:113n,item_after:0n,source_after:0n},copies:{members:252,configurations:0,intervals:0}},
      4:{cursor:{phase:'previous',member_after:313n,item_after:0n,source_after:0n},copies:{members:252,configurations:0,intervals:0}},
      5:{cursor:{phase:'configurations',member_after:78n,item_after:1n,source_after:80n},copies:{members:252,configurations:1,intervals:0}},
      12:{cursor:{phase:'intervals',member_after:40n,item_after:15n,source_after:42n},copies:{members:252,configurations:1,intervals:13}},
      19:{cursor:{phase:'intervals',member_after:508n,item_after:248n,source_after:0n},copies:{members:252,configurations:1,intervals:246}},
      20:{cursor:{phase:'finalize',member_after:0n,item_after:0n,source_after:0n},copies:{members:252,configurations:1,intervals:252}}
    };
    const initialProgress=observe(db),prepareSpy=vi.spyOn(db,'prepare');
    let state=ok(storage.beginUploadProjection({pinId,tripUuid:root}));expect(state).toMatchObject({state:'preparing',examined:0,projection:null});
    failed(storage.readUploadProjectionPage({snapshot:`u2:${storage.summary.databaseUuid}:${pinId}:80000000-0000-4000-8000-000000000001:${root}:1`,kind:'members',limit:1}),'INVALID_INPUT');
    state=ok(storage.advanceUploadProjection(pinId));expect(state).toMatchObject({state:'preparing',examined:100,projection:null});
    let previous=initialProgress();expect(previous).toEqual(milestones[1]);
    storage.close();const reopenedConn=await openConnection(ws.options({path:file}));
    const reopened=tracked(reopenedConn),writer=reopenedConn.writer(),resumedProgress=observe(writer);
    expect(resumedProgress()).toEqual(previous);
    const resumedSpy=vi.spyOn(writer,'prepare');
    let turns=1,totalExamined=100;
    while(state.state==='preparing'){
      // A real ordinary recorder write can commit between every background turn.
      ok(reopened.recordCompleteness('10000000-0000-4000-8000-000000000001',{kind:'sample-loss'}));
      state=ok(reopened.advanceUploadProjection(pinId));expect(state.examined).toBeLessThanOrEqual(100);totalExamined+=state.examined;turns++;
      const current=resumedProgress();
      const deltas=Object.entries(current.copies).map(([kind,count])=>count-previous.copies[kind as keyof typeof previous.copies]);
      expect(deltas.every(delta=>delta>=0)).toBe(true);expect(deltas.reduce((sum,delta)=>sum+delta,0)).toBeLessThanOrEqual(100);
      expect(current.cursor).not.toEqual(previous.cursor);
      if(Object.hasOwn(milestones,turns))expect(current).toEqual(milestones[turns as keyof typeof milestones]);
      previous=current;
    }
    expect(turns).toBe(20);expect(totalExamined).toBe(1920);expect(state).toMatchObject({state:'ready',examined:20});
    expect(state.projection!.totals).toEqual({members:252,configurations:1,intervals:252});
    expect(ok(reopened.readUploadProjectionPage({snapshot:state.projection!.snapshot,kind:'members',limit:100})).rows).toHaveLength(100);
    expect(ok(reopened.readUploadProjectionPage({snapshot:state.projection!.snapshot,kind:'configurations',limit:100})).rows[0]).toMatchObject({occurrence:{rawTripUuid:root}});
    expect(recheckUploadProjection(writer,state.projection!)).toBe(true);
    // All preparation, finalization, page and recheck queries have no context-wide aggregate or grouping.
    expect([...prepareSpy.mock.calls,...resumedSpy.mock.calls].map(([sql])=>sql).filter(sql=>/count\(|GROUP BY|sha256/i.test(sql))).toEqual([]);
    prepareSpy.mockRestore();resumedSpy.mockRestore();reopened.close();
  });
  it.each([false,true])('invalidates preparation on an older link mutation including equal distinct counts (%s)',async counted=>{
    const client=await start(),s=new Script(ETS2_A),root=await open(client,s),pinId=randomUUID();
    ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured())),effects:counted?[{kind:'trip.update',tripUuid:root,set:{trailerConfigurations:['this-event']}}]:[]}));
    for(let index=0;index<120;index++)ok(await client.recordCompleteness(s.session,{tripUuid:root,kind:'sample-loss'}));
    await close(client,s,root);const child=await open(client,s);
    ok(await client.beginUploadProjection({pinId,tripUuid:root}));expect(ok(await client.advanceUploadProjection(pinId)).state).toBe('preparing');
    ok(await client.commitEvent({message:gameShaped(s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:child,set:{trailerConfigurations:[{eventSeq:'2'}]}}]}));
    expect(ok(await client.advanceUploadProjection(pinId))).toMatchObject({state:'invalidated',projection:null,examined:0});
    failed(await client.deleteTrip(root,{rejectIfOpen:false}),'STORAGE_BUSY');await client.close();
  });
  it('retains invalidated and releasing pins in the eight-header limit, validates idempotent begin and rejects old u1 handles',async()=>{
    const client=await start(),s=new Script(ETS2_A),root=await open(client,s),ids=Array.from({length:8},()=>randomUUID());
    for(let index=0;index<250;index++)ok(await client.recordCompleteness(s.session,{tripUuid:root,kind:'sample-loss'}));
    const first=ok(await client.beginUploadProjection({pinId:ids[0],tripUuid:root}));expect(ok(await client.beginUploadProjection({pinId:ids[0],tripUuid:root}))).toEqual(first);
    failed(await client.beginUploadProjection({pinId:ids[0],tripUuid:ETS2_B}),'INVALID_INPUT');
    for(const pinId of ids.slice(1))ok(await client.beginUploadProjection({pinId,tripUuid:root}));
    ok(await client.advanceUploadProjection(ids[0]));ok(await client.advanceUploadProjection(ids[0]));
    let second=ok(await client.advanceUploadProjection(ids[1]));while(second.state==='preparing')second=ok(await client.advanceUploadProjection(ids[1]));expect(second.state).toBe('ready');
    ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured())),effects:[{kind:'trip.update',tripUuid:root,set:{trailerConfigurations:['this-event']}}]}));
    expect(ok(await client.advanceUploadProjection(ids[0])).state).toBe('invalidated');
    failed(await client.beginUploadProjection({pinId:randomUUID(),tripUuid:root}),'STORAGE_BUSY');
    failed(await client.readUploadProjectionPage({snapshot:`u1:${root}`,kind:'members',limit:1}),'INVALID_INPUT');
    let releasing=ok(await client.releaseUploadProjection(ids[0]));expect(releasing.state).toBe('releasing');
    failed(await client.beginUploadProjection({pinId:randomUUID(),tripUuid:root}),'STORAGE_BUSY');
    while(releasing.state==='releasing')releasing=ok(await client.releaseUploadProjection(ids[0]));expect(releasing.state).toBe('released');
    ok(await client.beginUploadProjection({pinId:randomUUID(),tripUuid:root}));await client.close();
  });
  it('tracks count-stable link updates/deletes and deduplicates the fixed OLD/NEW membership root set',async()=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer();
    ok(storage.commitEvent({message:withEventSeq('event-trailer-configured',7n)}));
    const gen=(id:number)=>db.prepare('SELECT generation FROM upload_projection_evidence_versions WHERE root_ref=?').pluck().get(id)??0n;
    expect([gen(1),gen(2),gen(3)]).toEqual([0n,0n,0n]);
    db.prepare('INSERT INTO trip_trailers VALUES(1,1)').run();expect([gen(1),gen(2)]).toEqual([1n,0n]);
    db.prepare('UPDATE trip_trailers SET trip_ref=2 WHERE trip_ref=1').run();expect([gen(1),gen(2)]).toEqual([2n,1n]);
    db.prepare('DELETE FROM trip_trailers WHERE trip_ref=2').run();expect([gen(1),gen(2)]).toEqual([2n,2n]);
    db.prepare('UPDATE logical_memberships SET logical_ref=2,previous_logical_ref=3,joined_after_revision=1 WHERE trip_ref=3').run();
    expect([gen(1),gen(2),gen(3)]).toEqual([2n,3n,1n]);
    db.prepare('DELETE FROM logical_memberships WHERE trip_ref=3').run();expect([gen(1),gen(2),gen(3)]).toEqual([2n,4n,2n]);storage.close();
  });
  it('waits for committed proof, redirects an abandoned singleton, retains original anchors and session-qualified terminal references', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,true,1200);
    expect(ok(await prepare(client,root)).readiness).toBe('ready');
    await close(client,a,root);const resumable=ok(await prepare(client,root));
    const rootPages=await pages(client,resumable);
    expect(resumable.facts).toMatchObject({outcome:'open',closeReason:null,opening:{eventSeq:'1200',pluginSessionId:ETS2_A}});
    const b=new Script(ETS2_B),child=await open(client,b,false),pending=ok(await prepare(client,child)),oldPages=await pages(client,pending);
    expect(pending.readiness).toBe('identity-pending');await observe(client,b,child);
    const redirect=ok(await prepare(client,child));expect(redirect).toMatchObject({readiness:'redirected',rootReadiness:'ready',rootTripUuid:root});
    expect(await pages(client,pending)).toEqual(oldPages);
    expect(await pages(client,resumable)).toEqual(rootPages);
    ok(await client.commitEvent({message:gameShaped(b.event(r.paused()))}));await close(client,b,child,'delivered');
    const final=ok(await prepare(client,child)),mapped=mapUploadProjection(final,await pages(client,final));
    expect(final.facts).toMatchObject({pluginSessionId:ETS2_A,opening:{pluginSessionId:ETS2_A,rawTripUuid:root,eventSeq:'1200'},outcomeOccurrence:{pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'3'}});
    expect(mapped.status).toBe('projected');if(mapped.status==='projected'){expect(mapped.summary.source.tripId).toBe(root);expect(mapped.summary.snapshot.outcomeEventSeq).toBe('3');}
    const finalPages=await pages(client,final);
    failed(await client.readUploadProjectionPage({snapshot:final.snapshot.replace(final.databaseUuid,ETS2_A),kind:'members',limit:1}),'INVALID_INPUT');
    expect(await client.close()).toEqual({clean:true});expect(recheck(pending)).toBe(false);expect(recheck(redirect)).toBe(false);expect(recheck(final)).toBe(true);
    const reopened=await start();expect(await pages(reopened,final)).toEqual(finalPages);expect(ok(await reopened.getUploadProjectionPreparation(final.snapshot.split(':')[2])).projection).toEqual(final);
    await reopened.close();
  });
  it('keeps all historical trailers and more than fifty intervals fixed while later closure/configuration/intervals commit', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s);
    for(let index=0;index<12;index++)ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured(trailer(index%10)))),effects:[{kind:'trip.update',tripUuid:uuid,set:{trailerConfigurations:['this-event']}}]}));
    for(let index=0;index<53;index++)ok(await client.recordCompleteness(s.session,{tripUuid:uuid,kind:'sample-loss',detail:{fixtureIndex:index}}));
    const pin=ok(await prepare(client,uuid)),before=await pages(client,pin,5);expect(pin.totals).toEqual({members:1,configurations:12,intervals:53});
    ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured())),effects:[{kind:'trip.update',tripUuid:uuid,set:{trailerConfigurations:['this-event']}}]}));
    await close(client,s,uuid,'cancelled');ok(await client.recordCompleteness(s.session,{tripUuid:uuid,kind:'event-loss'}));
    expect(await pages(client,pin,5)).toEqual(before);expect(pin.facts.outcome).toBe('open');
    const result=mapUploadProjection(pin,before);expect(result.status).toBe('projected');if(result.status==='projected')expect(result.summary.snapshot.trailers).toEqual({complete:false,items:[]});
    const fresh=ok(await prepare(client,uuid));expect(fresh.totals).toEqual({members:1,configurations:13,intervals:54});
    failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'members',limit:101}),'INVALID_INPUT');
    failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'intervals',limit:1,cursor:`${pin.snapshot}:members:1`}),'INVALID_INPUT');
    await client.close();expect(recheck(pin)).toBe(false);expect(recheck(fresh)).toBe(true);
  });
  it.each([false,true])('keeps ready copies immutable and recheck stale when an old configuration gains a link (already counted: %s)', async counted => {
    const client=await start(),s=new Script(ETS2_A),root=await open(client,s,true,1,'f0000000-0000-4000-8000-000000000001');
    ok(await client.commitEvent({message:gameShaped(s.event(r.trailerConfigured())),
      effects:counted?[{kind:'trip.update',tripUuid:root,set:{trailerConfigurations:['this-event']}}]:[]}));
    await close(client,s,root);
    const child=await open(client,s,true,1,'10000000-0000-4000-8000-000000000001');
    const pin=ok(await prepare(client,root)),before=await pages(client,pin);
    expect(pin.totals).toMatchObject({members:2,configurations:counted?1:0});
    if(counted)expect(before.find(p=>p.kind==='configurations')!.rows[0]).toMatchObject({occurrence:{rawTripUuid:root}});
    ok(await client.commitEvent({message:gameShaped(s.event(r.paused())),effects:[
      {kind:'trip.update',tripUuid:child,set:{trailerConfigurations:[{eventSeq:'2'}]}}]}));
    const reread=await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'configurations',limit:7});
    if(reread.ok)expect(reread.value).toEqual(before.find(p=>p.kind==='configurations'));
    expect(ok(reread)).toEqual(before.find(p=>p.kind==='configurations'));
    expect(await pages(client,pin)).toEqual(before);
    const fresh=ok(await prepare(client,root));expect(fresh.totals.configurations).toBe(1);
    expect((await pages(client,fresh)).find(p=>p.kind==='configurations')!.rows[0]).toMatchObject({occurrence:{rawTripUuid:child}});
    await client.close();expect(recheck(pin)).toBe(false);expect(recheck(fresh)).toBe(true);
  });
  it('rejects a mismatched durable handle even at the current root and revision', async () => {
    const client=await start(),s=new Script(ETS2_A),root=await open(client,s),pin=ok(await prepare(client,root));
    await client.close();expect(recheck(pin)).toBe(true);
    expect(recheck({...pin,snapshot:pin.snapshot.replace(pin.snapshot.split(':')[2],'11111111-1111-4111-8111-111111111111')})).toBe(false);
  });
  it('qualifies a shared configuration with a linked member from the configuration event session', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,true,1,'10000000-0000-4000-8000-000000000001'),b=new Script(ETS2_B);
    ok(await client.upsertSession({message:gameShaped(b.welcome())}));
    ok(await client.commitEvent({message:gameShaped(b.event(r.trailerConfigured())),effects:[
      {kind:'trip.update',tripUuid:root,set:{trailerConfigurations:['this-event']}}]}));
    const unqualified=ok(await prepare(client,root)),unqualifiedPages=await pages(client,unqualified);
    expect(mapUploadProjection(unqualified,unqualifiedPages)).toEqual({status:'hold',reason:'evidence-contradictory'});
    const child='f0000000-0000-4000-8000-000000000001';
    ok(await client.commitEvent({message:gameShaped(b.event(r.jobConfigured())),profile:proof(b),effects:[
      {kind:'trip.close',tripUuid:root,outcome:'none',closeReason:'restart',recordingCompleteness:'partial',endedUtcMs:2000},
      {kind:'trip.open',tripUuid:child,game:'ets2',gameMode:mode,jobConfiguration:'this-event',trailerConfigurations:[{eventSeq:'1'}],recordingCompleteness:'partial',startedUtcMs:2000},
      {kind:'event.attribute',tripUuid:child,attribution:'trip'}]}));
    const pin=ok(await prepare(client,child)),complete=await pages(client,pin);
    expect(pin.rootTripUuid).toBe(root);expect(pin.totals).toMatchObject({members:2,configurations:1});
    expect(complete.find(p=>p.kind==='configurations')!.rows[0]).toMatchObject({occurrence:{pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'1'}});
    expect(mapUploadProjection(pin,complete).status).toBe('projected');
    expect(await pages(client,unqualified)).toEqual(unqualifiedPages);
    await client.close();
  });
  it('qualifies an unknown-outcome close by its continued raw member and preserves it after later commits', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a);await close(client,a,root);
    const b=new Script(ETS2_B),child=await open(client,b);
    ok(await client.commitEvent({message:gameShaped(b.event(r.jobConfigured())),effects:[
      {kind:'trip.close',tripUuid:child,outcome:'none',closeReason:'different-job',recordingCompleteness:'partial',endedUtcMs:2000}]}));
    const pin=ok(await prepare(client,root)),before=await pages(client,pin);
    expect(pin.facts).toMatchObject({outcome:'none',outcomeOccurrence:null,close:{rawTripUuid:child,pluginSessionId:ETS2_B,eventSeq:'2',type:'job.configured'}});
    const mapped=mapUploadProjection(pin,before);expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){expect(mapped.provenance.close).toEqual(pin.facts.close);expect(mapped.summary.snapshot.evidence.endObserved).toBe(false);}
    ok(await client.recordCompleteness(b.session,{tripUuid:child,kind:'sample-loss'}));
    expect(await pages(client,pin)).toEqual(before);expect(ok(await prepare(client,root)).facts.close).toEqual(pin.facts.close);
    await client.close();
  });
  it('keeps observation closure time unknown after the next unrelated event and a later closed-trip revision', async () => {
    const client=await start(),s=new Script(ETS2_A),root=await open(client,s),next=attachTripUuidFor(s.session,'2');
    ok(await client.openAttachedTrip({pluginSessionId:s.session,nextEventSeq:'2',job:job(),profile:{...proof(s),scope:'e'.repeat(64)},
      profileChange:true,sourceClockId:s.clockId,monotonicNs:'2000000000000',effects:[
        {kind:'trip.close',tripUuid:root,outcome:'none',closeReason:'different-job',recordingCompleteness:'partial',endedUtcMs:2000},
        {kind:'trip.open',tripUuid:next,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:2000}]}));
    const before=ok(await prepare(client,root));expect(before.facts.close).toBeNull();
    ok(await client.commitEvent({message:gameShaped(s.event(r.fined(),{utcMs:9000})),effects:[{kind:'event.attribute',tripUuid:next,attribution:'trip'}]}));
    ok(await client.recordCompleteness(s.session,{tripUuid:root,kind:'sample-loss'}));
    const pin=ok(await prepare(client,root));expect(pin.revision).not.toBe(before.revision);expect(pin.facts.close).toBeNull();
    const mapped=mapUploadProjection(pin,await pages(client,pin));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected')expect(mapped.summary.snapshot.end).toEqual({utcMs:null,basis:'unknown',eventSeq:null});
    await client.close();
  });
  it('preserves a real restart close carrier from a session outside the closed member set', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,false),b=new Script(ETS2_B);
    ok(await client.upsertSession({message:gameShaped(b.welcome())}));
    ok(await client.commitEvent({message:gameShaped(b.event(r.jobConfigured())),effects:[
      {kind:'trip.close',tripUuid:root,outcome:'none',closeReason:'restart',recordingCompleteness:'partial',endedUtcMs:2000}]}));
    const pin=ok(await prepare(client,root));
    expect(pin.facts.close).toMatchObject({rawTripUuid:root,pluginSessionId:ETS2_B,eventSeq:'1',type:'job.configured'});
    const mapped=mapUploadProjection(pin,await pages(client,pin));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected')expect(mapped.provenance.close).toEqual(pin.facts.close);
    await client.close();
  });
  it('keeps proof-committed, closed and retired roots stable when matching observations arrive', async () => {
    const client=await start(),a=new Script(ETS2_A),root=await open(client,a,false);
    expect(ok(await prepare(client,root)).readiness).toBe('identity-pending');await observe(client,a,root);
    const ready=ok(await prepare(client,root));expect(ready.readiness).toBe('ready');await observe(client,a,root,job({plannedDistance:{available:true,value:1,unit:'m'}}));
    const retired=ok(await prepare(client,root));expect(retired.rootTripUuid).toBe(root);expect(retired.facts.outcome).toBe('open');
    await close(client,a,root);const closed=ok(await prepare(client,root));expect(closed.readiness).toBe('ready');
    const b=new Script(ETS2_B),other=await open(client,b);expect(ok(await prepare(client,other)).rootTripUuid).toBe(other);
    await client.close();
  });
  it('keeps unproven closed self-roots ready without claiming proof, and checkpoint starts unobserved', async () => {
    const client=await start(),s=new Script(ETS2_A);ok(await client.upsertSession({message:gameShaped(s.welcome())}));
    const uuid=attachTripUuidFor(s.session,'1');ok(await client.openAttachedTrip({pluginSessionId:s.session,nextEventSeq:'1',job:job(),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,
      jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000}]}));
    expect(ok(await prepare(client,uuid)).readiness).toBe('identity-pending');await close(client,s,uuid,'delivered');
    const pin=ok(await prepare(client,uuid)),result=mapUploadProjection(pin,await pages(client,pin));expect(pin.readiness).toBe('ready');
    expect(result.status).toBe('projected');if(result.status==='projected'){expect(result.summary.snapshot.start).toEqual({utcMs:1000,basis:'checkpoint',eventSeq:null});expect(result.summary.snapshot.evidence.startObserved).toBe(false);}
    await client.close();
  });
  it('preserves selected save accounting and unavailable fuel instead of summing member totals', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s);
    const append=(second:number,odo:number)=>appendSample(client,s,uuid,second,odo);
    await append(1,1000000);await append(2,1000050);await append(3,1000100);
    const first=ok(await prepare(client,uuid)),oldPages=await pages(client,first);
    expect(first.facts.observedDistance).toEqual({available:true,value:100,unit:'m'});
    await append(4,1000060);await append(5,1000100);
    // A legacy raw total does not override a rebased selected save path.
    ok(await client.commitEvent({message:gameShaped(s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:uuid,set:{observedDistanceM:{available:true,value:999},fuelUsedL:{available:true,value:999}}}]}));
    const next=ok(await prepare(client,uuid));expect(next.facts.observedDistance).toEqual({available:true,value:100,unit:'m'});
    expect(next.facts.fuelUsed).toEqual({...absent,unit:'L'});expect(next.facts.moneyIncomplete).toBe(true);
    expect(ok(await client.listSamples({tripUuid:uuid})).map(row=>row.id)).toEqual(['1','2','4','5']);
    expect(next.bounds.accountingHead).not.toBe(first.bounds.accountingHead);expect(await pages(client,first)).toEqual(oldPages);
    const mapped=mapUploadProjection(next,await pages(client,next));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){expect(mapped.summary.snapshot.observedDistance).toEqual({available:true,value:100,unit:'m'});expect(mapped.summary.snapshot.fuelUsed).toEqual({...absent,unit:'L'});}
    await client.close();expect(recheck(first)).toBe(false);
  });
  it.each([
    ['delivered','0'],['delivered','-9223372036854775808'],['delivered','9223372036854775807'],
    ['cancelled','0'],['cancelled','-9223372036854775808'],['cancelled','9223372036854775807']
  ] as const)('preserves native %s money %s after a selected-accounting rollback', async (outcome,raw) => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s);
    await appendSample(client,s,uuid,1,1000000);await appendSample(client,s,uuid,2,1000050);await appendSample(client,s,uuid,3,1000100);
    await appendSample(client,s,uuid,4,1000060);await appendSample(client,s,uuid,5,1000100);
    ok(await client.commitEvent({message:gameShaped(s.event(r.fined('300'))),effects:[{kind:'event.attribute',tripUuid:uuid,attribution:'trip'}]}));
    const native={available:true,value:{raw,sdkType:'s64',currency:{status:'unknown'}}} as const;
    const key=outcome==='delivered'?'revenue':'penalty';
    const record=outcome==='delivered'?{...r.delivered(raw),revenue:native}:{...r.cancelled(raw),penalty:native};
    ok(await client.commitEvent({message:gameShaped(s.event(record)),effects:[
      {kind:'trip.close',tripUuid:uuid,outcome,closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'partial',endedUtcMs:2000},
      {kind:'event.attribute',tripUuid:uuid,attribution:'trip'}]}));
    const pin=ok(await prepare(client,uuid));expect(pin.facts.moneyIncomplete).toBe(true);expect(pin.facts[key]).toEqual(native);
    const mapped=mapUploadProjection(pin,await pages(client,pin));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){
      expect(mapped.summary.snapshot[key]).toEqual(native);expect(mapped.summary.snapshot[key==='revenue'?'penalty':'revenue']).toEqual(absent);
      expect(mapped.summary.snapshot.observedDistance).toEqual({available:true,value:100,unit:'m'});
      expect(mapped.summary.snapshot.evidence.reasons).toContain('accounting-unavailable');
    }
    await client.close();
  });
  it('retains a checkpoint opening in A when an event in B supplies the logical delivery', async () => {
    const client=await start(),a=new Script(ETS2_A);ok(await client.upsertSession({message:gameShaped(a.welcome())}));
    const root=attachTripUuidFor(a.session,'1');ok(await client.openAttachedTrip({pluginSessionId:a.session,nextEventSeq:'1',job:job(),profile:proof(a),sourceClockId:a.clockId,monotonicNs:'1000000000',
      effects:[{kind:'trip.open',tripUuid:root,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'partial',startedUtcMs:1000}]}));
    await close(client,a,root);const b=new Script(ETS2_B),child=await open(client,b);
    ok(await client.commitEvent({message:gameShaped(b.event(r.paused()))}));await close(client,b,child,'delivered');
    const pin=ok(await prepare(client,child));expect(pin.rootTripUuid).toBe(root);expect(pin.facts).toMatchObject({openedBy:'checkpoint',opening:null,checkpointNextEventSeq:'1',outcomeOccurrence:{pluginSessionId:ETS2_B,eventSeq:'3'}});
    const mapped=mapUploadProjection(pin,await pages(client,pin));expect(mapped.status).toBe('projected');
    if(mapped.status==='projected'){expect(mapped.summary.source.pluginSessionId).toBe(ETS2_A);expect(mapped.summary.snapshot.evidence.startObserved).toBe(false);expect(mapped.summary.snapshot.openedEventSeq).toBeNull();}
    await client.close();
  });
  it.each(['synthetic','replay'] as const)('never maps a %s database into game evidence', async purpose => {
    const client=await start(purpose),s=new Script(ETS2_A),welcome=s.welcome();welcome.source.origin=purpose;
    ok(await client.upsertSession({message:welcome}));const message=s.event(r.jobConfigured());message.source.origin=purpose;
    const uuid=tripUuidFor(s.session,'1');ok(await client.commitEvent({message,profile:proof(s),effects:[{kind:'trip.open',tripUuid:uuid,game:'ets2',gameMode:mode,jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
    const pin=ok(await prepare(client,uuid));expect(mapUploadProjection(pin,await pages(client,pin))).toEqual({status:'hold',reason:'source-ineligible'});await client.close();
  });
  it('releases its pin boundedly while schema6 opening synchronization evidence still retains a new history/game trip', async () => {
    const client=await start(),s=new Script(ETS2_A),uuid=await open(client,s),pin=ok(await prepare(client,uuid));
    failed(await client.deleteTrip(uuid,{rejectIfOpen:false}),'STORAGE_BUSY');const retained=ok(await client.getTrip(uuid));
    let released=ok(await client.releaseUploadProjection(pin.snapshot.split(':')[2]));
    while(released.state==='releasing')released=ok(await client.releaseUploadProjection(released.pinId));
    expect(released.state).toBe('released');failed(await client.deleteTrip(uuid,{rejectIfOpen:false}),'STORAGE_BUSY');expect(ok(await client.getTrip(uuid))).toEqual(retained);failed(await client.readUploadProjectionPage({snapshot:pin.snapshot,kind:'members',limit:1}),'INVALID_INPUT');await client.close();expect(recheck(pin)).toBe(false);
    readOnly(ws.database,db=>{for(const table of ['upload_projection_pins','upload_projection_members','upload_projection_configurations','upload_projection_intervals'])expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get()).toBe(0);
      expect(db.prepare('SELECT mode,registration_ref,run_ref FROM upload_reservations').all()).toEqual([{mode:'unbound',registration_ref:null,run_ref:null}]);expect(db.prepare('SELECT trip_uuid FROM trips').pluck().all()).toEqual([uuid]);});
  });
});
