import {it,expect,vi} from 'vitest';
import {initialDashboardUploadStatus,type DashboardUploadStatus,type DashboardOwner} from '../../packages/contracts/src/dashboard-upload';
import {randomUUID} from 'node:crypto';
import {UploadMainController} from '../../apps/desktop/src/dashboard-upload/main-controller';
import {UploadCredentialStore} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {UploadServiceBridge} from '../../apps/desktop/src/dashboard-upload/service-bridge';
import {DashboardUploadService} from '../../apps/desktop/src/dashboard-upload/service';
import type {UploadStorage} from '../../apps/desktop/src/dashboard-upload/scheduler';
import type {UploadServiceReply,UploadServiceCommand} from '../../apps/desktop/src/dashboard-upload/service-contract';
const origin='https://dashboard.example',owner={origin,accountId:'a',companyId:'c',identityEpoch:'e'},token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`;
function activeStatus(configuration:Record<string,unknown>):DashboardUploadStatus {const reg=configuration.registration as DashboardOwner;return {...initialDashboardUploadStatus(origin),state:'connected',owner:{origin:reg.origin,accountId:reg.accountId,companyId:reg.companyId,identityEpoch:reg.identityEpoch}};}
function fixture(publish:(status:DashboardUploadStatus)=>void=()=>{}){
  const files=new Map<string,Uint8Array>(),calls:UploadServiceCommand[]=[],generation=randomUUID();let configuration:Record<string,unknown>={status:'ready',purpose:'history',version:'0',registration:null,credentialGeneration:null,runId:null};
  const store=new UploadCredentialStore({async read(name){await Promise.resolve();return files.get(name);},async write(name,bytes){await Promise.resolve();files.set(name,bytes);},async remove(name){await Promise.resolve();files.delete(name);},async names(limit){await Promise.resolve();return [...files.keys()].slice(0,limit);}},{async available(){await Promise.resolve();return true;},async encrypt(v){await Promise.resolve();return Buffer.from(v);},async decrypt(v){await Promise.resolve();return {result:v.toString(),shouldReEncrypt:false};}});
  const registration={...owner,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()};let lost=false;
  const rpc={generation,retire(){},async call(command:UploadServiceCommand):Promise<UploadServiceReply>{await Promise.resolve();calls.push(command);switch(command.action){case 'configuration':return {ok:true,value:{kind:'configuration',configuration:configuration as never}};case 'verify':return {ok:true,value:{kind:'verified',owner,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}}};case 'prepare':return {ok:true,value:{kind:'prepared',owner,registration,expectedVersion:'0'}};case 'confirm':configuration={...configuration,version:'1',registration,credentialGeneration:command.credentialGeneration,runId:command.confirmationId};return lost?{ok:false,error:'TIMEOUT'}:{ok:true,value:{kind:'connection',connection:{status:'confirmed',version:'1',runId:command.confirmationId}}};default:return {ok:true,value:command.action==='activate'?{kind:'settled',status:activeStatus(configuration)}:{kind:'settled'}};}}};
  const controller=new UploadMainController(origin,'staging',()=>store,publish);return {controller,rpc,files,calls,store,configuration:()=>configuration,setConfiguration(value:Record<string,unknown>){configuration=value;},lose(){lost=true;}};
}
it('REG-006/010/012 keeps committed ciphertext after lost confirmation reply and resumes from authoritative DB configuration',async()=>{
  const f=fixture();await f.controller.attach(f.rpc);const verified=await f.controller.handle('verify',[token]);f.lose();expect((await f.controller.handle('confirm',[verified.candidateId])).error).toBe('TIMEOUT');expect([...f.files.keys()].filter(k=>k.endsWith('.bin'))).toHaveLength(1);
  const reopened=new UploadMainController(origin,'staging',()=>f.store,()=>{});await reopened.attach(f.rpc);expect(reopened.status.state).toBe('connected');expect(f.calls.at(-1)?.action).toBe('activate');
});
it('REG-010/012 retires a document candidate and never loads credentials with absent origin',async()=>{
  const f=fixture();await f.controller.attach(f.rpc);const verified=await f.controller.handle('verify',[token]);f.controller.documentChanged();expect((await f.controller.handle('confirm',[verified.candidateId])).error).toBe('RETIRED');expect(f.calls.some(c=>c.action==='confirm')).toBe(false);
  let reads=0;const disabled=new UploadMainController(null,'staging',()=>{reads++;return f.store;},()=>{});await disabled.attach(f.rpc);await disabled.handle('verify',[token]);expect(reads).toBe(0);expect(disabled.status.state).toBe('unavailable');
});
it('REG-010/012 rejects late verification from a retired document without creating a candidate or ciphertext',async()=>{
  const f=fixture();await f.controller.attach(f.rpc);let resolve!:(reply:UploadServiceReply)=>void;const answer=new Promise<UploadServiceReply>(done=>{resolve=done;});f.rpc.call=()=>answer;
  const pending=f.controller.handle('verify',[token]);f.controller.documentChanged();resolve({ok:true,value:{kind:'verified',owner,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}}});expect(await pending).toMatchObject({candidateId:null,error:'RETIRED'});expect(f.files.size).toBe(0);
});
it('REG-010/012 private RPC ignores old utility generations, rejects mismatched replies and retires pending authority',async()=>{
  let request:{id:string;generation:string}|undefined;const bridge=new UploadServiceBridge(value=>{request=value as typeof request;},()=>{}),pending=bridge.call({action:'verify',token});
  expect(await bridge.call({action:'suspend'})).toEqual({ok:false,error:'BUSY'});
  bridge.receive({type:'dashboard-upload:answer',id:request!.id,generation:randomUUID(),reply:{ok:true,value:{kind:'settled'}}});
  bridge.receive({type:'dashboard-upload:answer',id:request!.id,generation:request!.generation,reply:{ok:true,value:{kind:'settled'}}});expect(await pending).toEqual({ok:false,error:'RECONCILIATION'});
  const next=bridge.call({action:'verify',token});bridge.retire();expect(await next).toEqual({ok:false,error:'RETIRED'});expect(await bridge.call({action:'verify',token})).toEqual({ok:false,error:'RETIRED'});
});
async function resumeGate(work:(publish:(status:DashboardUploadStatus)=>void)=>Promise<void>){let resolve!:()=>void,timer:ReturnType<typeof setTimeout>|undefined;const resumed=new Promise<void>(done=>{resolve=done;});try{await work(status=>{if(status.state==='connected')resolve();});await Promise.race([resumed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CONFIRMED_GENERATION_RESUME_HANG_GUARD')),1000);})]);}finally{clearTimeout(timer);}}
it.each(['idle-navigation','candidate-navigation','candidate-cancel','failed-replacement'] as const)('REG-005/006/010/012 resumes authoritative A after %s without adopting candidate B',async mode=>{
  let observe:(status:DashboardUploadStatus)=>void=()=>{};const f=fixture(status=>observe(status));await f.controller.attach(f.rpc);const first=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[first.candidateId]);const confirmed=f.configuration(),original=f.rpc.call;
  const b={...owner,accountId:'b'},replacement=`vtc1_${randomUUID()}_${'b'.repeat(43)}`;f.rpc.call=command=>command.action==='verify'?Promise.resolve(mode==='failed-replacement'?{ok:false,error:'AUTHENTICATION'}:{ok:true,value:{kind:'verified',owner:b,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}}}):original(command);
  await resumeGate(async publish=>{observe=publish;if(mode==='idle-navigation')f.controller.documentChanged();else{const candidate=await f.controller.handle('verify',[replacement]);if(mode==='candidate-cancel')await f.controller.handle('cancel',[candidate.candidateId]);else if(mode==='candidate-navigation')f.controller.documentChanged();}});
  expect(f.configuration()).toEqual(confirmed);expect(f.controller.status).toMatchObject({state:'connected',owner,candidateId:null});expect(f.calls.filter(c=>c.action==='activate').at(-1)).toMatchObject({token,generation:confirmed.credentialGeneration});expect(f.files.size).toBe(2);f.controller.stop();
});
it.each(['orphan','committed-lost-answer'] as const)('REG-006/010/012 navigation recovers DB authority after %s rather than blindly resuming A',async boundary=>{
  let observe:(status:DashboardUploadStatus)=>void=()=>{};const f=fixture(status=>observe(status));await f.controller.attach(f.rpc);const first=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[first.candidateId]);const original=f.rpc.call,b={...owner,accountId:'b'},registration={...b,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()},replacement=`vtc1_${randomUUID()}_${'b'.repeat(43)}`;
  f.rpc.call=command=>{if(command.action==='verify')return Promise.resolve({ok:true,value:{kind:'verified',owner:b,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}}});if(command.action==='prepare')return Promise.resolve({ok:true,value:{kind:'prepared',owner:b,registration,expectedVersion:'1'}});if(command.action==='confirm'){f.setConfiguration({status:'ready',purpose:'history',version:'2',registration,credentialGeneration:command.credentialGeneration,runId:command.confirmationId});f.controller.documentChanged();return Promise.resolve({ok:false,error:'TIMEOUT'});}return original(command);};
  if(boundary==='orphan'){const save=f.store.save.bind(f.store);f.store.save=async(...args)=>{await save(...args);f.controller.documentChanged();};}
  const candidate=await f.controller.handle('verify',[replacement]);await resumeGate(async publish=>{observe=publish;await f.controller.handle('confirm',[candidate.candidateId]);});
  const active=f.calls.filter(c=>c.action==='activate').at(-1);expect(f.controller.status.owner?.accountId).toBe(boundary==='orphan'?'a':'b');expect(active).toMatchObject({token:boundary==='orphan'?token:replacement,generation:f.configuration().credentialGeneration});expect([...f.files.keys()].filter(k=>k.endsWith('.bin'))).toHaveLength(2);f.controller.stop();
});
it('REG-005/006/010/012 offline startup retries only the authoritative committed generation with bounded backoff',async()=>{
  vi.useFakeTimers();vi.spyOn(Math,'random').mockReturnValue(.5);const f=fixture();let restarted:UploadMainController|undefined;
  try{
    await f.controller.attach(f.rpc);const candidate=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[candidate.candidateId]);const confirmed=f.configuration(),before=f.calls.filter(c=>c.action==='confirm').length;let attempts=0;
    const rpc={...f.rpc,call(command:UploadServiceCommand){if(command.action==='activate'&&++attempts===1)return Promise.resolve({ok:false as const,error:'NETWORK' as const});return f.rpc.call(command);}};
    restarted=new UploadMainController(origin,'staging',()=>f.store,()=>{});await restarted.attach(rpc);expect(restarted.status).toMatchObject({state:'paused',error:'NETWORK',owner});expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(999);expect(attempts).toBe(1);await vi.advanceTimersByTimeAsync(1);expect(attempts).toBe(2);expect(restarted.status.state).toBe('connected');expect(f.configuration()).toEqual(confirmed);expect(f.calls.filter(c=>c.action==='confirm')).toHaveLength(before);expect(f.calls.filter(c=>c.action==='activate').at(-1)).toMatchObject({token,generation:confirmed.credentialGeneration});
    restarted.stop();await vi.advanceTimersByTimeAsync(300000);expect(attempts).toBe(2);
  }finally{restarted?.stop();f.controller.stop();vi.restoreAllMocks();vi.useRealTimers();}
});
it.each(['AUTHENTICATION','CONFIGURATION'] as const)('REG-010/012 startup %s remains paused without transient revalidation retries',async error=>{
  vi.useFakeTimers();const f=fixture();let restarted:UploadMainController|undefined;
  try{await f.controller.attach(f.rpc);const candidate=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[candidate.candidateId]);let attempts=0;restarted=new UploadMainController(origin,'staging',()=>f.store,()=>{});await restarted.attach({...f.rpc,call(command){if(command.action==='activate'){attempts++;return Promise.resolve({ok:false,error});}return f.rpc.call(command);}});await vi.advanceTimersByTimeAsync(300000);expect(attempts).toBe(1);expect(restarted.status).toMatchObject({state:'paused',error});}
  finally{restarted?.stop();f.controller.stop();vi.useRealTimers();}
});
it('REG-005/010/012 navigation waits on a busy old control with a bounded timer before loading the committed credential',async()=>{
  vi.useFakeTimers();const f=fixture();try{await f.controller.attach(f.rpc);const first=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[first.candidateId]);const original=f.rpc.call;let probes=0;
    f.rpc.call=command=>command.action==='configuration'&&++probes<=2?Promise.resolve({ok:false,error:'BUSY'}):original(command);f.controller.documentChanged();await vi.advanceTimersByTimeAsync(0);expect(probes).toBe(1);await vi.advanceTimersByTimeAsync(999);expect(probes).toBe(1);await vi.advanceTimersByTimeAsync(1001);expect(probes).toBe(3);expect(f.controller.status.state).toBe('connected');f.controller.stop();expect(vi.getTimerCount()).toBe(0);
  }finally{f.controller.stop();vi.useRealTimers();}
});
it('REG-010/012 out-of-band utility cancellation fences a control still waiting on startup storage before it can start HTTP',async()=>{
  let open!:(value:unknown)=>void,first=true,requests=0;const configuration={status:'ready',purpose:'history',version:'0',registration:null,credentialGeneration:null,runId:null};
  const pending=new Promise(done=>{open=done;}),db=new Proxy({} as UploadStorage,{get(_target,key){if(key==='getUploadConfiguration')return ()=>{if(first){first=false;return pending;}return Promise.resolve({ok:true,value:configuration});};if(key==='recoverUploadAttempt')return ()=>Promise.resolve({ok:true,value:{status:'empty',attemptId:null,eventId:null,registrationId:null,registration:null,payload:null}});throw Error('UNEXPECTED_STORAGE_OPERATION');}});
  const service=new DashboardUploadService(db,{request(){requests++;return Promise.resolve({ok:true,statusCode:200,body:Buffer.from(JSON.stringify({contract:{major:1,minor:0},accountId:'a',companyId:'c',identityEpoch:'e',limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}})),retryAfter:null});},abort(){},close(){}},origin,'test',()=>{});
  const retired=service.execute({action:'verify',token});service.cancel();open({ok:true,value:configuration});expect(await retired).toEqual({ok:false,error:'RETIRED'});expect(requests).toBe(0);expect(await service.execute({action:'verify',token})).toMatchObject({ok:true,value:{kind:'verified',owner}});expect(requests).toBe(1);await service.stop();
});
it.each(['confirm','restart'] as const)('REG-005/010/012 keeps authoritative activation pause status through main %s',async boundary=>{
  const f=fixture(),original=f.rpc.call;let restarted:UploadMainController|undefined;
  try{f.rpc.call=command=>command.action==='activate'?Promise.resolve({ok:true,value:{kind:'settled',status:{...activeStatus(f.configuration()),state:'paused',error:'VALIDATION'}}}):original(command);
    await f.controller.attach(f.rpc);const candidate=await f.controller.handle('verify',[token]);const confirmed=await f.controller.handle('confirm',[candidate.candidateId]);expect(confirmed).toMatchObject({state:'paused',error:'VALIDATION',owner,candidateId:null});
    if(boundary==='restart'){restarted=new UploadMainController(origin,'staging',()=>f.store,()=>{});await restarted.attach(f.rpc);expect(restarted.status).toMatchObject({state:'paused',error:'VALIDATION',owner,candidateId:null});}
  }finally{restarted?.stop();f.controller.stop();}
});
it.each(['owner','origin'] as const)('REG-010/012 rejects activation status for another %s',async mismatch=>{
  const f=fixture(),original=f.rpc.call;try{await f.controller.attach(f.rpc);const candidate=await f.controller.handle('verify',[token]);await f.controller.handle('confirm',[candidate.candidateId]);
    const wrong=activeStatus(f.configuration());if(mismatch==='owner')wrong.owner={...owner,accountId:'other'};else{wrong.origin='https://other.example';wrong.owner={...owner,origin:wrong.origin};}
    f.rpc.call=command=>command.action==='activate'?Promise.resolve({ok:true,value:{kind:'settled',status:wrong}}):original(command);
    const restarted=new UploadMainController(origin,'staging',()=>f.store,()=>{});await restarted.attach(f.rpc);expect(restarted.status).toMatchObject({state:'paused',error:'RECONCILIATION',owner});restarted.stop();
  }finally{f.controller.stop();}
});
