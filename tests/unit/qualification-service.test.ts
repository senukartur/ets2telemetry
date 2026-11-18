import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {QualificationService,type QualificationStorage} from '../../apps/desktop/src/qualification/service';
import type {QualificationHttpResult,QualificationRoute} from '../../apps/desktop/src/qualification/http';
import type {UploadActiveConfiguration} from '../../packages/storage/src/upload-sync';
import type {QualificationWire,QualificationState} from '../../packages/contracts/src/qualification';
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
const cap=fixtures.find(f=>f.schema==='Capabilities')!.value as QualificationWire['Capabilities'];
const snapshot=fixtures.find(f=>f.schema==='Qualification')!.value as QualificationWire['Qualification'];
const owner={origin:'https://dashboard.example',accountId:snapshot.ownerId,companyId:'c',identityEpoch:'e'};
const configuration:UploadActiveConfiguration={status:'ready',purpose:'history',version:'1',registration:{...owner,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()},credentialGeneration:'saved-generation',runId:randomUUID()};
const success=(value:unknown):QualificationHttpResult=>({ok:true,statusCode:200,body:new TextEncoder().encode(JSON.stringify(value)),retryAfter:null});
const stored=<T>(value:T)=>Promise.resolve({ok:true as const,value});
afterEach(()=>vi.useRealTimers());
function harness(request:(route:QualificationRoute)=>Promise<QualificationHttpResult>){
  const updates:QualificationState[]=[],saveQualificationRefresh=vi.fn(()=>Promise.resolve({ok:true as const,value:{saved:true}}));
  const db={readQualificationPreviewPins:()=>stored({items:[]}),readQualificationCache:()=>stored({active:true,securityScope:cap.securityScope,caches:[{snapshot,fetchedUtcMs:100}],refresh:{afterEvent:null,retryAtMs:0,failureStreak:0,suspended:false}}),setQualificationScope:()=>stored({active:true}),saveQualificationCache:()=>stored({saved:true}),pageQualificationSources:()=>stored({items:[],next:null}),saveQualificationRefresh} as unknown as QualificationStorage;
  const http={request:vi.fn((route:QualificationRoute)=>request(route)),abort:vi.fn(),close:vi.fn()};
  const service=new QualificationService(db,http,value=>updates.push(value));return {service,http,updates,saveQualificationRefresh};
}
describe('companion recovery and retirement (REG-010/011/012/014)',()=>{
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
