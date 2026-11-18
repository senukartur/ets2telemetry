import {spawn,type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {writeFileSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import {Storage} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {r} from '../shared/trip-messages';
import {ok,failed,uploadGame,uploadTestSource,uploadTestWork,workspace} from './helpers';
import type {QualificationWire} from '../../packages/contracts/src/qualification';
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
describe('REG-006/012 immutable qualification transaction recovery',()=>{
  it.each(['before-commit','after-commit'])('recovers only its explicitly owned preview pin after claim at %s',async boundary=>{
    let {storage}=await direct();const source=await uploadTestSource(storage),authority={registrationId:source.registrationId,connectionVersion:'1'};
    ok(storage.setQualificationScope({...authority,securityScope:'a'.repeat(43)}));const pinId=randomUUID(),input={...authority,pinId,tripUuid:source.tripUuid};storage.close();
    await kill('beginQualificationPreview',input,boundary);const reopened=await direct();storage=reopened.storage;
    const retained=ok(storage.readQualificationPreviewPins({}));expect(retained.items).toHaveLength(boundary==='before-commit'?0:1);
    if(boundary==='before-commit')ok(storage.beginQualificationPreview(input));
    expect(ok(storage.readRetainedUploadMaterializations()).unmanagedPins).toBe(0);
    const foreign=randomUUID();ok(storage.beginUploadProjection({pinId:foreign,tripUuid:source.tripUuid}));
    failed(storage.releaseQualificationPreview({...authority,pinId:foreign}),'INVALID_INPUT');
    ok(storage.disconnectUploadOwner({expectedVersion:'1'}));failed(storage.advanceQualificationPreview({...authority,pinId}),'INVALID_INPUT');
    let released=ok(storage.releaseQualificationPreview({...authority,pinId}));for(let turn=0;released.state!=='released'&&turn<64;turn++)released=ok(storage.releaseQualificationPreview({...authority,pinId}));
    expect(released.state).toBe('released');expect(ok(storage.readQualificationPreviewPins({})).items).toEqual([]);
    failed(storage.beginQualificationPreview(input),'INVALID_INPUT');expect(reopened.db.prepare('SELECT pin_id FROM upload_projection_pins').pluck().all()).toEqual([foreign]);
  });
  it.each(['before-commit','after-commit'])('keeps release reference and pin deletion atomic at %s',async boundary=>{
    let {storage}=await direct();const source=await uploadTestSource(storage),authority={registrationId:source.registrationId,connectionVersion:'1'},pinId=randomUUID();
    ok(storage.setQualificationScope({...authority,securityScope:'a'.repeat(43)}));ok(storage.beginQualificationPreview({...authority,pinId,tripUuid:source.tripUuid}));storage.close();
    await kill('releaseQualificationPreview',{...authority,pinId},boundary);const reopened=await direct();storage=reopened.storage;
    expect(ok(storage.readQualificationPreviewPins({})).items).toHaveLength(boundary==='before-commit'?1:0);
    expect(reopened.db.prepare('SELECT count(*) FROM upload_projection_pins').pluck().get()).toBe(boundary==='before-commit'?1n:0n);expect(reopened.db.pragma('foreign_key_check')).toEqual([]);
  });
  it.each(['before-commit','after-commit','after-answer'])('recovers result/head together at %s without creating a receipt',async boundary=>{
    let {storage}=await direct();const source=await uploadTestSource(storage);
    ok(storage.commitEvent({message:uploadGame(source.script.event(r.delivered())),effects:[{kind:'trip.close',tripUuid:source.tripUuid,outcome:'delivered',closeReason:'outcome',outcomeEvent:'this-event',recordingCompleteness:'complete',endedUtcMs:3000}]}));
    const workId=await uploadTestWork(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:4000}));
    const authority={registrationId:source.registrationId,connectionVersion:'1',securityScope:'a'.repeat(43)};ok(storage.setQualificationScope(authority));
    const local=ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items[0].request;
    const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
    const result=structuredClone(fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!);
    Object.assign(result,{source:local.source,requestedRevision:local.revision,requestedEventId:local.eventId});Object.assign(result.assessment!,{assessedSource:local.source,sourceRevision:local.revision,sourceEventId:local.eventId,sourceMessageId:result.requestedSourceMessageId});
    const request={requestId:randomUUID(),items:[local]},batch:QualificationWire['ResultBatch']={contract:'1.0',securityScope:authority.securityScope,requestId:request.requestId,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,items:[result]};
    const input={...authority,request,batch,fetchedUtcMs:5000};storage.close();await kill('commitQualificationResults',input,boundary);
    const reopened=await direct();storage=reopened.storage;const db=reopened.db;
    for(const table of ['qualification_result_versions','qualification_result_heads'])expect(db.prepare(`SELECT count(*) FROM ${table}`).pluck().get(),table).toBe(boundary==='before-commit'?0n:1n);
    expect(ok(storage.commitQualificationResults(input)).saved).toBe(boundary==='before-commit'?1:0);
    expect(ok(storage.pageQualificationSources({...authority,afterEvent:null,limit:25})).items[0].result).toEqual(result);
    expect(db.prepare('SELECT count(*) FROM upload_receipts').pluck().get()).toBe(0n);expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});
