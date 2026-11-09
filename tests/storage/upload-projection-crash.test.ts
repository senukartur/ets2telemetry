import {Script,ETS2_A,r,trailer} from '../shared/trip-messages';
import {tripUuidFor} from '../../packages/telemetry-core/src';
import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {Storage} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {failed,ok,workspace} from './helpers';

const directStorage:Storage[]=[];
function tracked(connection:ConstructorParameters<typeof Storage>[0]){const storage=new Storage(connection);directStorage.push(storage);return storage;}
let ws:Awaited<ReturnType<typeof workspace>>,child:ChildProcess|undefined;
beforeEach(async()=>{ws=await workspace();});
afterEach(async()=>{if(child && child.exitCode===null && child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}child=undefined;for(const storage of directStorage.splice(0))storage.close();await ws.dispose();});
const root='70000000-0000-4000-8000-000000000001';
async function kill(file:string,pinId:string,operation:'advanceUploadProjection'|'releaseUploadProjection',boundary:string){
  const config=path.join(ws.directory,'projection-child.json');writeFileSync(config,JSON.stringify({open:ws.options({path:file}),pinId,operation,boundary}));
  child=spawn(process.execPath,[path.resolve('tests/storage/fixtures/upload-projection-child.cjs'),config],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LOCALAPPDATA:ws.directory},stdio:['ignore','pipe','pipe'],windowsHide:true});
  const closed=once(child,'close');let output='',errors='';child.stderr!.on('data',data=>{errors+=String(data);});
  // Signals establish the boundary; the timer diagnoses a hang, never chooses a crash moment.
  await new Promise<void>((resolve,reject)=>{
    const guard=setTimeout(()=>reject(new Error(`Missing projection barrier: ${output} ${errors}`)),15_000);
    child!.stdout!.on('data',data=>{output+=String(data);if(output.includes(`barrier ${boundary}`)){clearTimeout(guard);resolve();}});
    child!.once('exit',()=>{clearTimeout(guard);reject(new Error(`Child exited before barrier: ${errors}`));});
  });
  child.kill('SIGKILL');await closed;expect(errors).toBe('');child=undefined;
}
describe('REG-006/012 durable projection worker crash boundaries',()=>{
  it.each(['before-commit','after-commit','after-answer'])('recovers copied rows and cursors atomically at %s',async boundary=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer(),pinId=randomUUID();
    // More than one turn of intervals, all attached to one real frozen trip.
    db.transaction(()=>{for(let i=0;i<160;i++)db.exec("INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,detail_json,created_utc_ms) VALUES(1,1,'sample-loss','{}',1000)");})();
    // Capture the new bound in an immutable logical revision without a fixture change.
    const {revise}=await import('../../packages/storage/src/sqlite/logical-trips');revise(db,1n);
    ok(storage.beginUploadProjection({pinId,tripUuid:root}));
    const before=db.prepare('SELECT * FROM upload_projection_pins WHERE pin_id=?').get(pinId);storage.close();
    await kill(file,pinId,'advanceUploadProjection',boundary);
    const reopenedConn=await openConnection(ws.options({path:file})),reopened=tracked(reopenedConn),writer=reopenedConn.writer();
    const after=writer.prepare('SELECT * FROM upload_projection_pins WHERE pin_id=?').get(pinId);
    if(boundary==='before-commit')expect(after).toEqual(before);else expect(after).not.toEqual(before);
    let state=ok(reopened.getUploadProjectionPreparation(pinId));while(state.state==='preparing')state=ok(reopened.advanceUploadProjection(pinId));
    expect(state.projection!.totals).toEqual({members:1,configurations:0,intervals:160});
    let cursor:string|undefined;const ids:string[]=[];
    do{const page=ok(reopened.readUploadProjectionPage({snapshot:state.projection!.snapshot,kind:'intervals',limit:100,cursor}));ids.push(...page.rows.map(row=>row.id));cursor=page.nextCursor??undefined;}while(cursor);
    expect(ids).toHaveLength(160);expect(new Set(ids).size).toBe(160);reopened.close();
  });
  it.each(['before-commit','after-commit'])('recovers a finalization at %s without a partial ready handle',async boundary=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),pinId=randomUUID();
    ok(storage.beginUploadProjection({pinId,tripUuid:root}));storage.close();await kill(file,pinId,'advanceUploadProjection',boundary);
    const reopened=tracked(await openConnection(ws.options({path:file})));let state=ok(reopened.getUploadProjectionPreparation(pinId));
    expect(state.state).toBe(boundary==='before-commit'?'preparing':'ready');if(state.state==='preparing')state=ok(reopened.advanceUploadProjection(pinId));
    expect(ok(reopened.readUploadProjectionPage({snapshot:state.projection!.snapshot,kind:'members',limit:100})).rows).toHaveLength(1);reopened.close();
  });
  it.each(['before-commit','after-commit'])('retains sources until interrupted release %s finishes',async boundary=>{
    const file=ws.copyFixture('schema-v4-representative.sqlite'),conn=await openConnection(ws.options({path:file})),storage=tracked(conn),db=conn.writer(),pinId=randomUUID();
    db.transaction(()=>{for(let i=0;i<160;i++)db.exec("INSERT INTO completeness_intervals(plugin_session_ref,trip_ref,kind,detail_json,created_utc_ms) VALUES(1,1,'sample-loss','{}',1000)");})();
    const {revise}=await import('../../packages/storage/src/sqlite/logical-trips');revise(db,1n);ok(storage.beginUploadProjection({pinId,tripUuid:root}));
    let state=ok(storage.advanceUploadProjection(pinId));while(state.state==='preparing')state=ok(storage.advanceUploadProjection(pinId));const pin=state.projection!;storage.close();
    await kill(file,pinId,'releaseUploadProjection',boundary);
    const reopened=tracked(await openConnection(ws.options({path:file})));
    expect(ok(reopened.getUploadProjectionPreparation(pinId)).state).toBe(boundary==='before-commit'?'ready':'releasing');
    if(boundary==='after-commit')failed(reopened.readUploadProjectionPage({snapshot:pin.snapshot,kind:'members',limit:1}),'INVALID_INPUT');
    failed(reopened.deleteTrip(root),'STORAGE_BUSY');
    do{state=ok(reopened.releaseUploadProjection(pinId));expect(state.examined).toBeLessThanOrEqual(100);}while(state.state==='releasing');
    ok(reopened.deleteTrip(root));expect(ok(reopened.releaseUploadProjection(pinId)).state).toBe('released');reopened.close();
  });
});


it.each(['before-commit','after-commit','after-answer'])('REG-006/012 commits raw proof cursor atomically at %s',async boundary=>{
  const conn=await openConnection(ws.options()),storage=tracked(conn),db=conn.writer(),s=new Script(ETS2_A);
  ok(storage.upsertSession({message:s.welcome()}));const baseline=s.checkpoint(null);baseline.data.state.boundaryOrder='0';
  baseline.data.state.configuration.trailers=Array.from({length:10},(_,index)=>index===0?{available:true,value:trailer(0,{bodyType:{available:true,value:'curtainsider'}})}:{available:false,reason:'not-observed'});
  ok(storage.recordTrailerBaseline({message:baseline}));const opening=s.event(r.jobConfigured()),root=tripUuidFor(s.session,opening.data.eventSeq);
  ok(storage.commitEvent({message:opening,effects:[{kind:'trip.open',tripUuid:root,game:'ets2',gameMode:{mode:'unknown',method:'none',confidence:'none'},jobConfiguration:'this-event',recordingCompleteness:'complete',startedUtcMs:1000}]}));
  for(let i=0;i<250;i++)ok(storage.commitEvent({message:s.event(r.paused())}));
  ok(storage.commitEvent({message:s.event(r.delivered()),effects:[{kind:'trip.close',tripUuid:root,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:2000}]}));
  const pinId=randomUUID();ok(storage.beginUploadProjection({pinId,tripUuid:root}));expect(ok(storage.advanceUploadProjection(pinId))).toMatchObject({state:'preparing',examined:100});
  const snapshot=()=>String(db.prepare('SELECT snapshot_json FROM upload_projection_pins WHERE pin_id=?').pluck().get(pinId)),before=snapshot();
  expect(JSON.parse(before).ruleReplay.phase).toBe('events');storage.close();await kill(ws.database,pinId,'advanceUploadProjection',boundary);
  const reopenedConn=await openConnection(ws.options()),reopened=tracked(reopenedConn),writer=reopenedConn.writer();
  const after=String(writer.prepare('SELECT snapshot_json FROM upload_projection_pins WHERE pin_id=?').pluck().get(pinId));
  if(boundary==='before-commit')expect(after).toBe(before);else expect(BigInt(JSON.parse(after).ruleReplay.eventAfter)).toBeGreaterThan(BigInt(JSON.parse(before).ruleReplay.eventAfter));
  let state=ok(reopened.getUploadProjectionPreparation(pinId));while(state.state==='preparing'){state=ok(reopened.advanceUploadProjection(pinId));expect(state.examined).toBeLessThanOrEqual(100);}
  expect(state.projection!.ruleContext).toMatchObject({version:2,status:'proven',recordingLoss:false});reopened.close();
});
