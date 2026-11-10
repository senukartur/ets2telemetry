import {randomUUID} from 'node:crypto';
import {it,expect,vi,afterEach} from 'vitest';
import {UploadScheduler,type UploadStorage,type UploadClock} from '../../apps/desktop/src/dashboard-upload/scheduler';
import {UploadRate,uploadRetryDelay,retryAfter} from '../../apps/desktop/src/dashboard-upload/retry';
import type {UploadActiveConfiguration} from '../../packages/storage/src/upload-sync';
import type {UploadTransport,UploadHttpResult} from '../../apps/desktop/src/dashboard-upload/http';
const origin='https://dashboard.example',registration={registrationId:randomUUID(),clientInstallationId:randomUUID(),origin,accountId:'a',companyId:'c',identityEpoch:'e',installationId:randomUUID(),bindingId:randomUUID()};
const configuration:UploadActiveConfiguration={status:'ready',purpose:'history',version:'1',registration,credentialGeneration:randomUUID(),runId:randomUUID()},token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`,limits={maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10};
const result=<T>(value:T)=>Promise.resolve({ok:true as const,value});
function fixture(){
  const calls:string[]=[],db=new Proxy({} as UploadStorage,{get(_target,name){return vi.fn((input:Record<string,unknown>)=>{calls.push(String(name));switch(name){
    case 'getUploadSchedulingHints':return result({status:'ready',registrationId:registration.registrationId,version:'1',credentialGeneration:configuration.credentialGeneration,retryAtMs:null,failureStreak:0,retryEventId:null,paused:null,held:null});
    case 'readRetainedUploadMaterializations':return result({examined:0,unmanagedPins:0,items:[]});
    case 'claimUploadAttempt':return result({status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null});
    case 'getUploadStoreStatus':return result({registrationId:registration.registrationId,version:'1',active:true,paused:null,discoveryAfter:'0',identityPendingSources:0,pendingSources:0,heldSources:0,queuedEvents:0,queuedBytes:0,deliveredEvents:0,pressure:false});
    case 'pageUploadScanRuns':return result({after:input.after,next:null,examined:0,items:[]});
    case 'pageUploadDiscovery':return result({after:'0',next:'0',examined:0,items:[]});
    case 'pageUploadSources':return result({phase:input.phase,after:input.after,next:null,examined:0,sources:[],receipts:[]});
    default:return result({examined:0,reclaimed:0,events:0,bytes:0});
  }});}});
  const http:UploadTransport={request:vi.fn(()=>Promise.resolve({ok:true as const,statusCode:202,body:Buffer.from('{}'),retryAfter:null})),abort:vi.fn(),close:vi.fn()};return {db,http,calls};
}
afterEach(()=>vi.useRealTimers());
const controlled:UploadClock={now:()=>Date.now(),random:()=>.5,schedule:(run,ms)=>setTimeout(run,ms),cancel:id=>clearTimeout(id as ReturnType<typeof setTimeout>)};
it.each(['NETWORK','TIMEOUT',500,400,413,415,422] as const)('REG-005/010/011 surfaces durable %s as actionable backoff or validation status',async failure=>{
  vi.useFakeTimers();const f=fixture(),attemptId=randomUUID(),eventId=randomUUID();
  const claim=vi.fn(()=>result({status:'claimed',attemptId,eventId,registrationId:registration.registrationId,registration,payload:Buffer.from('{}')})),outcome=vi.fn(()=>result({status:'recorded',attemptId,eventId,registrationId:registration.registrationId,registration:null,payload:null}));
  const db=new Proxy(f.db,{get(target,key){return key==='claimUploadAttempt'?claim:key==='recordUploadAttemptOutcome'?outcome:Reflect.get(target,key);}});
  const response:UploadHttpResult=typeof failure==='string'?{ok:false,code:failure,statusCode:null,retryAfter:null}:{ok:true,statusCode:failure,body:Buffer.from('{}'),retryAfter:null};f.http.request=vi.fn(()=>Promise.resolve(response));
  const scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},controlled);try{await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(1);expect(outcome).toHaveBeenCalledWith(expect.objectContaining({attemptId,kind:typeof failure==='number'&&failure<500?'validation':'retry'}));expect(scheduler.status).toMatchObject({state:'paused',error:typeof failure==='number'&&failure<500?'VALIDATION':failure==='TIMEOUT'?'TIMEOUT':'NETWORK'});}finally{await scheduler.stop();}
});
it('REG-005/010/011 keeps a persisted validation hold visible through activation, counter refresh and another event success',async()=>{
  vi.useFakeTimers();const f=fixture();let claimed=false;const hints=()=>result({status:'ready',registrationId:registration.registrationId,version:'1',credentialGeneration:configuration.credentialGeneration,retryAtMs:0,failureStreak:0,retryEventId:null,paused:null,held:'validation'});
  const claim=()=>{if(claimed)return result({status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null});claimed=true;return result({status:'claimed',attemptId:randomUUID(),eventId:randomUUID(),registrationId:registration.registrationId,registration,payload:Buffer.from('{}')});},commit=vi.fn(()=>result({status:'delivered',eventId:randomUUID(),receiptId:randomUUID()}));
  const db=new Proxy(f.db,{get(target,key){return key==='getUploadSchedulingHints'?hints:key==='claimUploadAttempt'?claim:key==='commitUploadReceipt'?commit:Reflect.get(target,key);}}),scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},controlled);
  try{await scheduler.activate(configuration,token,limits);expect(scheduler.status).toMatchObject({state:'paused',error:'VALIDATION'});await vi.advanceTimersByTimeAsync(1500);expect(commit).toHaveBeenCalledOnce();expect(f.calls).toContain('getUploadStoreStatus');expect(scheduler.status).toMatchObject({state:'paused',error:'VALIDATION'});}finally{await scheduler.stop();}
});
it('REG-005/010/011 clears a transient diagnostic after the matching retry receives a durable receipt',async()=>{
  vi.useFakeTimers();const f=fixture(),eventId=randomUUID();let failed=false,active=false,delivered=false,deadline:number|null=null;
  const hints=()=>result({status:'ready',registrationId:registration.registrationId,version:'1',credentialGeneration:configuration.credentialGeneration,retryAtMs:deadline,failureStreak:failed&&!active&&!delivered?1:0,retryEventId:failed&&!active&&!delivered?eventId:null,paused:null,held:null});
  const claim=(input:{attemptId:string})=>{active=!delivered;return result(delivered?{status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null}:{status:'claimed',attemptId:input.attemptId,eventId,registrationId:registration.registrationId,registration,payload:Buffer.from('{}')});};
  const outcome=(input:{retryAtMs:number})=>{failed=true;active=false;deadline=input.retryAtMs;return result({status:'recorded',attemptId:randomUUID(),eventId,registrationId:registration.registrationId,registration:null,payload:null});},commit=vi.fn(()=>{delivered=true;active=false;deadline=null;return result({status:'delivered',eventId,receiptId:randomUUID()});});
  const db=new Proxy(f.db,{get(target,key){return key==='getUploadSchedulingHints'?hints:key==='claimUploadAttempt'?claim:key==='recordUploadAttemptOutcome'?outcome:key==='commitUploadReceipt'?commit:Reflect.get(target,key);}});
  let finish!: (answer:UploadHttpResult)=>void;f.http.request=vi.fn(()=>failed?new Promise<UploadHttpResult>(resolve=>{finish=resolve;}):Promise.resolve({ok:false as const,code:'NETWORK' as const,statusCode:null,retryAfter:null}));f.http.abort=()=>finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});
  const scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},controlled);try{await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(500);expect(scheduler.status).toMatchObject({state:'paused',error:'NETWORK'});expect(f.calls).toContain('getUploadStoreStatus');await vi.advanceTimersByTimeAsync(2000);expect(active).toBe(true);expect((await hints()).value.failureStreak).toBe(0);expect(scheduler.status.error).toBe('NETWORK');finish({ok:true,statusCode:202,body:Buffer.from('{}'),retryAfter:null});await vi.advanceTimersByTimeAsync(10);expect(commit).toHaveBeenCalledOnce();expect(scheduler.status).toMatchObject({state:'connected',error:null});}finally{await scheduler.stop();}
});
it.each(['authentication','configuration','reconciliation'] as const)('REG-005/010/012 restores an authoritative %s pause before any claim or HTTP',async paused=>{
  vi.useFakeTimers();const f=fixture(),db=new Proxy(f.db,{get(target,key){if(key==='getUploadSchedulingHints')return ()=>result({status:'ready',registrationId:registration.registrationId,version:'1',credentialGeneration:configuration.credentialGeneration,retryAtMs:0,failureStreak:0,retryEventId:null,paused,held:null});if(key==='getUploadStoreStatus')return ()=>result({registrationId:registration.registrationId,version:'1',active:true,paused,discoveryAfter:'0',identityPendingSources:0,pendingSources:0,heldSources:0,queuedEvents:1,queuedBytes:2,deliveredEvents:0,pressure:false});return Reflect.get(target,key);}}),scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},controlled);
  try{await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(3000);expect(scheduler.status).toMatchObject({state:'paused',error:paused==='authentication'?'AUTHENTICATION':paused==='configuration'?'CONFIGURATION':'RECONCILIATION'});expect(f.calls).not.toContain('claimUploadAttempt');expect(f.http.request).not.toHaveBeenCalled();}finally{await scheduler.stop();}
});
it('REG-005/010/011/012 clears a hints reconciliation hold only after same-scope ready hints',async()=>{
  vi.useFakeTimers();const f=fixture();let repaired=false;const hints=vi.fn(()=>result({status:repaired?'ready':'reconciliation-required',registrationId:registration.registrationId,version:'1',credentialGeneration:configuration.credentialGeneration,retryAtMs:null,failureStreak:0,retryEventId:null,paused:null,held:null}));
  const db=new Proxy(f.db,{get(target,key){return key==='getUploadSchedulingHints'?hints:Reflect.get(target,key);}}),scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},controlled);
  try{await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(2500);expect(hints.mock.calls.length).toBeGreaterThan(1);expect(f.calls.filter(name=>name==='getUploadStoreStatus').length).toBeGreaterThan(1);expect(f.calls).not.toContain('claimUploadAttempt');expect(scheduler.status.error).toBe('RECONCILIATION');repaired=true;await vi.advanceTimersByTimeAsync(2000);expect(f.calls).toContain('claimUploadAttempt');expect(scheduler.status).toMatchObject({state:'connected',error:null});}finally{await scheduler.stop();}
});
it('REG-011 uses capped advertised token bucket, full jitter and bounded Retry-After',()=>{
  const rate=new UploadRate(60,10,0);for(let i=0;i<10;i++)expect(rate.delay(0)).toBe(0);expect(rate.delay(0)).toBe(1000);expect(rate.delay(1000)).toBe(0);rate.configure(500,50);expect(rate.delay(1000)).toBe(1000);
  expect(uploadRetryDelay(1,null,0,()=>.5)).toBe(1000);expect(uploadRetryDelay(100,null,0,()=>1)).toBe(300000);expect(retryAfter('600',0)).toBe(300000);expect(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT',1000)).toBe(2000);expect(retryAfter('nonsense',0)).toBe(0);
});
it('REG-005/010/011 yields between storage turns and avoids hot loops on an empty queue',async()=>{
  vi.useFakeTimers();const f=fixture(),scheduler=new UploadScheduler(f.db,f.http,origin,'test',()=>{});await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls.filter(c=>c==='claimUploadAttempt').length).toBeLessThanOrEqual(2);expect(f.calls.filter(c=>c==='readRetainedUploadMaterializations').length).toBeLessThan(20);expect(f.http.request).not.toHaveBeenCalled();expect(scheduler.status.progress.distinctSources).toBe(0);await scheduler.stop();const count=f.calls.length;await vi.advanceTimersByTimeAsync(5000);expect(f.calls).toHaveLength(count);
});
it('REG-005/010/011 round-robins past a pressure entry to release a later old-owner pin',async()=>{
  vi.useFakeTimers();const f=fixture(),a=randomUUID(),b=randomUUID(),released:string[]=[];const db={...f.db,readRetainedUploadMaterializations:vi.fn(()=>Promise.resolve({ok:true as const,value:{examined:2,unmanagedPins:0,items:[{workId:a,registrationId:randomUUID(),state:'complete' as const},...(released.length?[]:[{workId:b,registrationId:randomUUID(),state:'held' as const}])]}})),freezeUploadMaterialization:vi.fn(()=>Promise.resolve({ok:true as const,value:{workId:a,status:'pressure' as const,examined:0,eventId:null,reason:'queue-pressure' as const}})),releaseUploadMaterialization:vi.fn(async(input:{workId:string})=>{await Promise.resolve();released.push(input.workId);return {ok:true as const,value:{workId:input.workId,status:'released' as const,examined:1,eventId:null,reason:null}};})} as UploadStorage;
  // Proxy methods are not own properties: retain the defaults through a second bounded adapter.
  const port=new Proxy(db,{get(target,key){return Reflect.get(target,key)??Reflect.get(f.db,key);}}),scheduler=new UploadScheduler(port,f.http,origin,'test',()=>{});await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(300);
  expect(released).toEqual([b]);expect(db.freezeUploadMaterialization).toHaveBeenCalledOnce();expect(f.calls).toContain('claimUploadAttempt');await scheduler.stop();
});
it('REG-005/010/011 alternates eligible live/backfill, falls back without consuming a persisted attempt, and keeps one HTTP flight',async()=>{
  vi.useFakeTimers();const f=fixture(),modes:string[]=[],sent:string[]=[],remaining={live:2,backfill:2};
  const claim=vi.fn((input:{attemptId:string;mode:'live'|'backfill'})=>{modes.push(input.mode);if(remaining[input.mode]===0)return result({status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null});remaining[input.mode]--;return result({status:'claimed',attemptId:input.attemptId,eventId:randomUUID(),registrationId:registration.registrationId,registration,payload:Buffer.from(input.mode)});});
  const commit=vi.fn(()=>result({status:'delivered',eventId:randomUUID(),receiptId:randomUUID()}));
  const db=new Proxy(f.db,{get(target,key){return key==='claimUploadAttempt'?claim:key==='commitUploadReceipt'?commit:Reflect.get(target,key);}});
  f.http.request=vi.fn((_route,_token,body)=>{sent.push(Buffer.from(body).toString());return Promise.resolve({ok:true as const,statusCode:202,body:Buffer.from('{}'),retryAfter:null});});
  const scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{});await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(250);expect(sent).toEqual(['live','backfill','live','backfill']);expect(modes.slice(-2)).toEqual(['live','backfill']);expect(commit).toHaveBeenCalledTimes(4);await scheduler.stop();
});
it('REG-005/010/012 commits an already complete matching ACK before rotation settles, with the original attempt',async()=>{
  vi.useFakeTimers();const f=fixture(),attemptId=randomUUID(),eventId=randomUUID();let resolve!: (value:Awaited<ReturnType<UploadTransport['request']>>)=>void;
  const response=new Promise<Awaited<ReturnType<UploadTransport['request']>>>(done=>{resolve=done;});f.http.request=vi.fn(()=>response);
  const claim=vi.fn(()=>result({status:'claimed',attemptId,eventId,registrationId:registration.registrationId,registration,payload:Buffer.from('{}')})),commit=vi.fn(()=>result({status:'delivered',eventId,receiptId:randomUUID()}));
  const db=new Proxy(f.db,{get(target,key){return key==='claimUploadAttempt'?claim:key==='commitUploadReceipt'?commit:Reflect.get(target,key);}}),scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{});
  await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(200);expect(f.http.request).toHaveBeenCalledOnce();expect(f.calls).toContain('readRetainedUploadMaterializations');
  resolve({ok:true,statusCode:202,body:Buffer.from('{}'),retryAfter:null});await scheduler.suspend();expect(commit).toHaveBeenCalledExactlyOnceWith({attemptId,statusCode:202,body:Buffer.from('{}')});await scheduler.stop();
});
it('REG-005/010/011/012 recovers a locally aborted attempt without a fabricated negative outcome or jitter',async()=>{
  vi.useFakeTimers();const f=fixture(),attemptId=randomUUID(),eventId=randomUUID(),recover=vi.fn(()=>result({status:'recovered',attemptId,eventId,registrationId:registration.registrationId,registration:null,payload:null})),outcome=vi.fn(),random=vi.fn(()=>.5);let finish!:(answer:UploadHttpResult)=>void;
  const claim=()=>result({status:'claimed',attemptId,eventId,registrationId:registration.registrationId,registration,payload:Buffer.from('{}')}),db=new Proxy(f.db,{get(target,key){return key==='claimUploadAttempt'?claim:key==='recoverUploadAttempt'?recover:key==='recordUploadAttemptOutcome'?outcome:Reflect.get(target,key);}});
  f.http.request=vi.fn(()=>new Promise<UploadHttpResult>(resolve=>{finish=resolve;}));f.http.abort=()=>finish?.({ok:false,code:'ABORTED',statusCode:null,retryAfter:null});const scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{},{...controlled,random});
  try{await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(1);expect(f.http.request).toHaveBeenCalledOnce();await scheduler.suspend();expect(recover).toHaveBeenCalledExactlyOnceWith({attemptId});expect(outcome).not.toHaveBeenCalled();expect(random).not.toHaveBeenCalled();expect(scheduler.status.error).toBeNull();}finally{await scheduler.stop();}
});
it('REG-005/010/011 persists a TLS configuration pause for the active attempt instead of treating it as transient',async()=>{
  vi.useFakeTimers();const f=fixture(),attemptId=randomUUID(),eventId=randomUUID(),outcome=vi.fn(()=>result({status:'recorded',attemptId,eventId,registrationId:registration.registrationId,registration:null,payload:null}));
  const claim=vi.fn(()=>result({status:'claimed',attemptId,eventId,registrationId:registration.registrationId,registration,payload:Buffer.from('{}')}));const db=new Proxy(f.db,{get(target,key){return key==='claimUploadAttempt'?claim:key==='recordUploadAttemptOutcome'?outcome:Reflect.get(target,key);}});
  f.http.request=vi.fn(()=>Promise.resolve({ok:false as const,code:'TLS_CONFIGURATION' as const,statusCode:null,retryAfter:null}));const scheduler=new UploadScheduler(db,f.http,origin,'test',()=>{});await scheduler.activate(configuration,token,limits);await vi.advanceTimersByTimeAsync(1);expect(outcome).toHaveBeenCalledWith(expect.objectContaining({attemptId,kind:'configuration'}));expect(scheduler.status).toMatchObject({state:'paused',error:'CONFIGURATION'});await scheduler.stop();
});
it('passes verified contractMinor when freezing upload materializations',async()=>{
  vi.useFakeTimers();const f=fixture(),workId=randomUUID();
  const db={...f.db,readRetainedUploadMaterializations:vi.fn(()=>Promise.resolve({ok:true as const,value:{examined:1,unmanagedPins:0,items:[{workId,registrationId:registration.registrationId,state:'complete' as const}]}})),freezeUploadMaterialization:vi.fn(()=>Promise.resolve({ok:true as const,value:{workId,status:'frozen' as const,examined:0,eventId:randomUUID(),reason:null}})),releaseUploadMaterialization:vi.fn((input:{workId:string})=>Promise.resolve({ok:true as const,value:{workId:input.workId,status:'released' as const,examined:1,eventId:null,reason:null}}))} as UploadStorage;
  const port=new Proxy(db,{get(target,key){return Reflect.get(target,key)??Reflect.get(f.db,key);}}),scheduler=new UploadScheduler(port,f.http,origin,'test',()=>{});
  await scheduler.activate(configuration,token,limits,1);
  await vi.advanceTimersByTimeAsync(300);
  expect(db.freezeUploadMaterialization).toHaveBeenCalledWith(expect.objectContaining({workId,contractMinor:1}));
  await scheduler.stop();
});

