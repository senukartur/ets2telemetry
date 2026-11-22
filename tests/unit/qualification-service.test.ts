import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {QualificationService,type QualificationStorage} from '../../apps/desktop/src/qualification/service';
import type {QualificationHttpResult,QualificationRoute} from '../../apps/desktop/src/qualification/http';
import type {UploadActiveConfiguration} from '../../packages/storage/src/upload-sync';
import type {QualificationWire,QualificationState} from '../../packages/contracts/src/qualification';
import type {QualificationLocalSource} from '../../packages/storage/src/qualification';
import {Script,ETS2_A,job} from '../shared/trip-messages';
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
const cap=fixtures.find(f=>f.schema==='Capabilities')!.value as QualificationWire['Capabilities'];
const snapshot=fixtures.find(f=>f.schema==='Qualification')!.value as QualificationWire['Qualification'];
const owner={origin:'https://dashboard.example',accountId:snapshot.ownerId,companyId:'c',identityEpoch:'e'};
const configuration:UploadActiveConfiguration={status:'ready',purpose:'history',version:'1',registration:{...owner,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()},credentialGeneration:'saved-generation',runId:randomUUID()};
const success=(value:unknown):Extract<QualificationHttpResult,{ok:true}>=>({ok:true,statusCode:200,body:new TextEncoder().encode(JSON.stringify(value)),retryAfter:null});
const stored=<T>(value:T)=>Promise.resolve({ok:true as const,value});
afterEach(()=>vi.useRealTimers());
function harness(request:(route:QualificationRoute,body?:Uint8Array)=>Promise<QualificationHttpResult>,overrides:Partial<QualificationStorage>={}){
  const updates:QualificationState[]=[],saveQualificationRefresh=vi.fn((input:Parameters<QualificationStorage['saveQualificationRefresh']>[0])=>{void input;return Promise.resolve({ok:true as const,value:{saved:true}});});
  const db={readQualificationPreviewPins:()=>stored({items:[]}),readQualificationCache:()=>stored({active:true,securityScope:cap.securityScope,caches:[{snapshot,fetchedUtcMs:100}],refresh:{afterEvent:null,retryAtMs:0,failureStreak:0,suspended:false}}),setQualificationScope:()=>stored({active:true}),saveQualificationCache:()=>stored({saved:true}),pageQualificationSources:()=>stored({items:[],next:null}),saveQualificationRefresh,...overrides} as unknown as QualificationStorage;
  const http={request:vi.fn((route:QualificationRoute,_token:string,body?:Uint8Array)=>request(route,body)),abort:vi.fn(),close:vi.fn()};
  const service=new QualificationService(db,http,value=>updates.push(value));return {service,http,updates,saveQualificationRefresh};
}
type ResultsRequest=QualificationWire['ResultBatchInput'];
function resultHarness(reply:(request:ResultsRequest)=>QualificationHttpResult|undefined,count=30){
  const template=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
  const sources:QualificationLocalSource[]=Array.from({length:count},(_,index)=>({request:{source:{...template.source,tripId:`00000000-0000-4000-8000-${String(index+100).padStart(12,'0')}`},eventId:`00000000-0000-4000-8000-${String(index+1000).padStart(12,'0')}`,revision:1},generation:'0',localMaterialDigest:'a'.repeat(64),result:null}));
  const page=vi.fn((input:Parameters<QualificationStorage['pageQualificationSources']>[0])=>{
    const items=sources.filter(item=>input.afterEvent===null||item.request.eventId>input.afterEvent).slice(0,input.limit);
    return stored({items,next:items.length===input.limit?items.at(-1)!.request.eventId:null});
  });
  const commit=vi.fn((input:Parameters<QualificationStorage['commitQualificationResults']>[0])=>stored({saved:input.batch.items.length,missingBase:[]}));
  const requests:ResultsRequest[]=[],times:number[]=[];
  const f=harness((route,body)=>{
    if(route!=='results')return Promise.resolve(success(route==='capabilities'?cap:{...snapshot,game:route.endsWith('ats')?'ats':'ets2'}));
    const request=JSON.parse(new TextDecoder().decode(body)) as ResultsRequest;requests.push(request);times.push(Date.now());
    return Promise.resolve(reply(request)??success({contract:'1.0',securityScope:cap.securityScope,requestId:request.requestId,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,items:request.items.map(item=>({...template,source:item.source,requestedRevision:item.revision,requestedEventId:item.eventId,assessment:{...template.assessment,assessedSource:item.source,sourceRevision:item.revision,sourceEventId:item.eventId}}))}));
  },{pageQualificationSources:page,commitQualificationResults:commit});
  return {...f,sources,page,commit,requests,times};
}
function sizeError():QualificationHttpResult {
  const fixture=fixtures.find(f=>f.schema==='Error'&&String((f.value as QualificationWire['Error']).error.code)==='RESULT_BATCH_TOO_LARGE');
  if(!fixture)throw Error('MISSING_REVIEWED_SIZE_ERROR_FIXTURE');return {...success(fixture.value),statusCode:422};
}
describe('companion recovery and retirement (REG-010/011/012/014)',()=>{
  it('checks a trip on start and resume and keeps its preview visible between checks',async()=>{
    vi.useFakeTimers();
    let root=randomUUID(),jobConfig=job();
    const script=new Script(ETS2_A),checkpoint=script.checkpoint(jobConfig);
    const live={source:{...checkpoint.source,origin:'game' as const},capture:checkpoint.capture,state:checkpoint.data.state};
    const template=fixtures.find(f=>f.schema==='Preview')!.value as QualificationWire['Preview'];
    let metres='99999',materialVersion='1',missingLocalReads=1,previewFailures=0;
    let pendingCapabilities:Promise<QualificationHttpResult>|null=null;
    const f=harness((route,body)=>{
      if(route==='capabilities')return pendingCapabilities??Promise.resolve(success(cap));
      if(route!=='preview')return Promise.resolve(success({...snapshot,game:route.endsWith('ats')?'ats':'ets2'}));
      if(previewFailures>0){previewFailures--;return Promise.resolve({...success({}),statusCode:503});}
      const input=JSON.parse(new TextDecoder().decode(body)) as QualificationWire['PreviewInput'];
      return Promise.resolve(success({...template,requestId:input.requestId,contextRevision:input.contextRevision,evidenceRevision:input.evidenceRevision,
        applicability:{...template.applicability,contextRevision:input.contextRevision,qualificationRevision:snapshot.progressRevision}}));
    },{
      readQualificationPreview:()=>{
        if(missingLocalReads>0){missingLocalReads--;return stored({current:null});}
        return stored({current:{tripUuid:root,rawTripUuid:root,materialVersion,actualDistance:{availability:'known',metres,support:'whole-trip',final:false}}});
      },
      beginQualificationPreview:({pinId})=>stored({pinId,state:'ready',examined:1,projection:{rootTripUuid:root,purpose:'history',facts:{job:jobConfig,opening:{utcMs:1000}}} as import('../../packages/storage/src/upload-projection').UploadProjection}),
      releaseQualificationPreview:({pinId})=>stored({pinId,state:'released',examined:1,projection:null})
    });
    const observe=(simulation:'running'|'paused')=>f.service.observe({...live,state:{...live.state,simulation}});
    const previews=()=>f.http.request.mock.calls.filter(([route])=>route==='preview');
    try{
      await f.service.activate(configuration,'protected-token');
      f.service.observe({...live,state:script.checkpoint(null).data.state});
      await vi.advanceTimersByTimeAsync(10000);expect(previews()).toHaveLength(0);
      observe('running');await vi.advanceTimersByTimeAsync(4000);expect(previews()).toHaveLength(0);expect(missingLocalReads).toBe(0);
      await vi.advanceTimersByTimeAsync(6000);expect(previews()).toHaveLength(1);
      const first=f.service.get('ets2').preview;expect(first).not.toBeNull();
      missingLocalReads=1;await vi.advanceTimersByTimeAsync(1000);
      expect(missingLocalReads).toBe(0);expect(f.service.get('ets2').preview).toEqual(first);
      metres='100000';materialVersion='2';observe('running');await vi.advanceTimersByTimeAsync(20000);
      expect(f.service.get('ets2').preview).toEqual(first);expect(previews()).toHaveLength(1);
      observe('paused');observe('running');await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(2);expect(f.service.get('ets2').preview?.requestId).not.toBe(first?.requestId);
      metres='500001';await vi.advanceTimersByTimeAsync(1000);
      expect(f.service.get('ets2').preview).toBeNull();expect(previews()).toHaveLength(2);
      observe('paused');observe('running');f.service.observe(null);
      const replacement={...live,source:{...live.source,pluginSessionId:randomUUID()}};
      f.service.observe({...replacement,state:script.checkpoint(null).data.state});
      await vi.advanceTimersByTimeAsync(10000);expect(previews()).toHaveLength(2);
      metres='100002';previewFailures=2;
      f.service.observe(replacement);await vi.advanceTimersByTimeAsync(30000);
      expect(previews()).toHaveLength(4);expect(f.service.get('ets2').preview).toBeNull();
      f.service.refresh('ets2');await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(5);expect(f.service.get('ets2').preview).not.toBeNull();
      const previous=f.service.get('ets2').preview;
      jobConfig=job({cargoId:{available:true,value:'next-cargo'},cargoLoaded:{available:true,value:true}});root=randomUUID();
      const next={...replacement,state:script.checkpoint(jobConfig).data.state};
      f.service.observe(next);expect(f.service.get('ets2').preview).toBeNull();
      await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(6);
      const current=f.service.get('ets2').preview;
      expect(current).not.toBeNull();expect(current?.requestId).not.toBe(previous?.requestId);
      f.service.observe({...next,state:script.checkpoint({...jobConfig,cargoLoaded:{available:true,value:false}}).data.state});
      await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(6);expect(f.service.get('ets2').preview).toEqual(current);
      const capabilities=Promise.withResolvers<QualificationHttpResult>();pendingCapabilities=capabilities.promise;
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(6);
      capabilities.resolve(success(cap));pendingCapabilities=null;await vi.advanceTimersByTimeAsync(10000);
      expect(previews()).toHaveLength(7);expect(f.service.get('ets2').preview).not.toBeNull();
      f.service.observe(null);expect(f.service.get('ets2').preview).toBeNull();
    }finally{await f.service.stop();}
  });
  it('retains and persists the current sweep cursor when a response duplicates one source and omits another',async()=>{
    vi.useFakeTimers();let responses=0;const template=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
    const f=resultHarness(request=>{
      if(++responses===1)return undefined;const source=request.items[0],result={...template,source:source.source,requestedRevision:source.revision,requestedEventId:source.eventId,assessment:{...template.assessment!,assessedSource:source.source,sourceRevision:source.revision,sourceEventId:source.eventId}};
      return success({contract:'1.0',securityScope:cap.securityScope,requestId:request.requestId,asOf:'2026-11-18T01:00:00.000Z',refreshAfterSeconds:5,items:request.items.map(()=>structuredClone(result))});
    });
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(60000);
      const cursor=f.requests[0].items.at(-1)!.eventId;expect(f.requests.length).toBeGreaterThan(1);expect(f.commit).toHaveBeenCalledTimes(1);
      expect(f.page.mock.calls.slice(1).every(([input])=>input.afterEvent===cursor)).toBe(true);expect(f.saveQualificationRefresh.mock.calls.every(([input])=>input.refresh.afterEvent===cursor)).toBe(true);
    }finally{await f.service.stop();}
  });
  it('reduces an oversized batch without skipping its cursor or starving progress and resets on activation',async()=>{
    vi.useFakeTimers();const f=resultHarness(request=>request.items.length>6?sizeError():undefined);
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(60000);
      expect(f.requests.slice(0,3).map(request=>request.items.length)).toEqual([25,12,6]);
      expect(new Set(f.requests.slice(0,3).map(request=>request.items[0].eventId)).size).toBe(1);
      const saved=new Set(f.commit.mock.calls.flatMap(([input])=>input.request.items.map(item=>item.eventId)));
      expect([...saved].sort()).toEqual(f.sources.map(source=>source.request.eventId));
      expect(f.http.request.mock.calls.filter(([route])=>route==='qualification/ets2').length).toBeGreaterThan(2);
      expect(f.http.request.mock.calls.filter(([route])=>route==='qualification/ats').length).toBeGreaterThan(2);
      expect(f.times.slice(1).every((time,index)=>time-f.times[index]>=5000)).toBe(true);
      const before=f.requests.length;await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(5000);expect(f.requests[before].items).toHaveLength(25);
    }finally{await f.service.stop();}
  });
  it('holds an unexpected single-item size failure through upload hints until activation',async()=>{
    vi.useFakeTimers();const f=resultHarness(()=>sizeError());
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(120000);
      expect(f.requests.map(request=>request.items.length)).toEqual([25,12,6,3,1]);expect(f.commit).not.toHaveBeenCalled();
      for(let index=0;index<10;index++)f.service.uploaded();await vi.advanceTimersByTimeAsync(30000);expect(f.requests).toHaveLength(5);
      expect(f.service.get('ets2')).toMatchObject({availability:'ready',preview:null});expect(f.page.mock.calls.every(([input])=>input.afterEvent===null)).toBe(true);
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(5000);expect(f.requests[5].items).toHaveLength(25);
    }finally{await f.service.stop();}
  });
  it('reduces the actual short final page and retains every source across its split',async()=>{
    vi.useFakeTimers();const f=resultHarness(request=>request.items.length>1?sizeError():undefined,2);
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(15000);
      expect(f.requests.slice(0,3).map(request=>request.items.length)).toEqual([2,1,1]);
      expect(f.requests[1].items[0].eventId).toBe(f.sources[0].request.eventId);expect(f.requests[2].items[0].eventId).toBe(f.sources[1].request.eventId);
      expect(f.commit.mock.calls.flatMap(([input])=>input.request.items.map(item=>item.eventId))).toEqual(f.sources.map(source=>source.request.eventId));
    }finally{await f.service.stop();}
  });
  it.each(['status','code','retryable','shape','retry-after'])('does not split a response with an invalid size-hint %s',async variant=>{
    vi.useFakeTimers();const reviewed=sizeError();if(!reviewed.ok)throw Error('INVALID_FIXTURE');const error=JSON.parse(new TextDecoder().decode(reviewed.body)) as QualificationWire['Error'];
    const malformed=variant==='shape'?{...error,privateMessage:'not allowed'}:structuredClone(error);
    if(variant==='code')malformed.error.code='INVALID_PAYLOAD';if(variant==='retryable')malformed.error.retryable=true;
    const response={...success(malformed),statusCode:variant==='status'?503:422,retryAfter:variant==='retry-after'?'5':null};
    const f=resultHarness(()=>response);
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(120000);
      expect(f.requests.length).toBeGreaterThan(1);expect(f.requests.every(request=>request.items.length===25)).toBe(true);expect(f.commit).not.toHaveBeenCalled();
      expect(f.times.slice(1).every((time,index)=>time-f.times[index]>=5000)).toBe(true);
    }finally{await f.service.stop();}
  });
  it('retries an ordinary transient 503 without splitting or advancing the source cursor',async()=>{
    vi.useFakeTimers();const transient=fixtures.find(f=>f.schema==='Error'&&(f.value as QualificationWire['Error']).error.code==='TEMPORARILY_UNAVAILABLE')!.value;
    const f=resultHarness(()=>({...success(transient),statusCode:503}));
    try{
      await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(120000);
      expect(f.requests.length).toBeGreaterThan(1);expect(f.requests.every(request=>request.items.length===25)).toBe(true);expect(f.commit).not.toHaveBeenCalled();
      expect(f.page.mock.calls.every(([input])=>input.afterEvent===null)).toBe(true);expect(f.times.slice(1).every((time,index)=>time-f.times[index]>=5000)).toBe(true);
    }finally{await f.service.stop();}
  });
  it('recovers scoped offline cache before networking, refreshes both games and preserves saved data on capability revocation',async()=>{
    vi.useFakeTimers();let revoked=false;
    const f=harness(route=>Promise.resolve(revoked?{ok:true,statusCode:403,body:new TextEncoder().encode('{}'),retryAfter:null}:success(route==='capabilities'?cap:{...snapshot,game:route.endsWith('ats')?'ats':'ets2'})));
    try{
      await f.service.activate(configuration,'protected-token');expect(f.service.get('ets2')).toMatchObject({availability:'offline',snapshot,stale:true});
      await vi.advanceTimersByTimeAsync(8000);expect(f.service.get('ets2')).toMatchObject({availability:'ready',stale:false});expect(f.service.get('ats').snapshot?.game).toBe('ats');
      revoked=true;await vi.advanceTimersByTimeAsync(65000);expect(f.service.get('ets2')).toMatchObject({availability:'permission-required',stale:true,snapshot,preview:null});
      expect(f.saveQualificationRefresh).toHaveBeenCalled();const calls=f.http.request.mock.calls.length;await vi.advanceTimersByTimeAsync(60000);expect(f.http.request).toHaveBeenCalledTimes(calls);
    }finally{await f.service.stop();}
  });
  it('retirement aborts only companion work and drops a delayed scoped reply',async()=>{
    vi.useFakeTimers();let resolve!:(response:QualificationHttpResult)=>void;
    const f=harness(()=>new Promise(done=>{resolve=done;}));
    await f.service.activate(configuration,'protected-token');await vi.advanceTimersByTimeAsync(0);await f.service.retire();
    resolve(success(cap));await vi.advanceTimersByTimeAsync(1000);expect(f.service.get('ets2').owner).toBeNull();expect(f.service.get('ats').snapshot).toBeNull();expect(f.http.abort).toHaveBeenCalled();await f.service.stop();
  });
});
