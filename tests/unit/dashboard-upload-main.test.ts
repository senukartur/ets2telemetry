import {it,expect,vi} from 'vitest';
import {initialDashboardUploadStatus,isDashboardUploadStatus,type DashboardUploadStatus,type DashboardOwner} from '../../packages/contracts/src/dashboard-upload';
import {randomUUID} from 'node:crypto';
import {UploadMainController} from '../../apps/desktop/src/dashboard-upload/main-controller';
import {UploadCredentialStore} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {UploadServiceBridge} from '../../apps/desktop/src/dashboard-upload/service-bridge';
import {DashboardUploadService} from '../../apps/desktop/src/dashboard-upload/service';
import type {UploadStorage} from '../../apps/desktop/src/dashboard-upload/scheduler';
import type {UploadActiveConfiguration} from '../../packages/storage/src/upload-sync';
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

it('REG-005/010/012/014 exposes only settled confirmed Journal read scope and retires it across document and utility lifetimes', async () => {
  const f = fixture(); await f.controller.attach(f.rpc); expect(f.controller.journalReadScope).toBeUndefined();
  const candidate = await f.controller.handle('verify', [token]); expect(f.controller.journalReadScope).toBeUndefined();
  await f.controller.handle('confirm', [candidate.candidateId]);
  const scope = f.controller.journalReadScope!; expect(scope).toEqual({owner, connectionVersion: '1', documentEpoch: expect.any(Number), utilityGeneration: f.rpc.generation}); expect(JSON.stringify(scope)).not.toMatch(/credential|token/);
  f.controller.documentChanged(); expect(f.controller.journalReadScope).toBeUndefined(); f.controller.detach(); expect(f.controller.journalReadScope).toBeUndefined(); f.controller.stop();
});

it('REG-010/012 does not present an uncommitted candidate as a connected owner after confirmation failure', async () => {
  const f = fixture(); await f.controller.attach(f.rpc); const candidate = await f.controller.handle('verify', [token]), original = f.rpc.call;
  f.rpc.call = command => command.action === 'prepare' ? Promise.resolve({ok: false, error: 'NETWORK'}) : original(command);
  const failed = await f.controller.handle('confirm', [candidate.candidateId]); expect(failed).toMatchObject({state: 'paused', error: 'NETWORK', owner: null, candidateId: null}); expect(f.controller.journalReadScope).toBeUndefined(); f.controller.stop();
});

it.each([['verify', 'AUTHENTICATION'], ['confirm', 'NETWORK']] as const)('REG-010/012 keeps the failed %s reason visible after owner-free recovery settles', async (action, error) => {
  const published: DashboardUploadStatus[] = [], recovered = deferred<void>();
  const f = fixture(status => {published.push(status); if (status.state === 'disconnected' && status.error) recovered.resolve();}); await f.controller.attach(f.rpc); const original = f.rpc.call;
  let candidateId: string | null = null;
  if (action === 'confirm') candidateId = (await f.controller.handle('verify', [token])).candidateId;
  f.rpc.call = command => command.action === (action === 'verify' ? 'verify' : 'prepare') ? Promise.resolve({ok: false, error}) : original(command);
  try {
    expect(await f.controller.handle(action, action === 'verify' ? [token] : [candidateId])).toMatchObject({state: 'paused', error, owner: null, candidateId: null});
    await recovered.promise; expect(f.controller.status).toMatchObject({state: 'disconnected', error, owner: null, candidateId: null}); expect(published.at(-1)).toMatchObject({state: 'disconnected', error});
    await new Promise(done => setTimeout(done, 0)); f.rpc.call = original; expect(await f.controller.handle('verify', [token])).toMatchObject({state: 'confirmation-required', error: null});
  } finally {f.controller.stop();}
});
it.each(['busy-retry', 'reconciliation'] as const)('REG-010/012 pins verify-reason precedence against a newer recovery failure: %s', async boundary => {
  vi.useFakeTimers(); const f = fixture(); const original = f.rpc.call; let probes = 0;
  try {
    await f.controller.attach(f.rpc);
    f.rpc.call = command => command.action === 'verify' ? Promise.resolve({ok: false, error: 'AUTHENTICATION'}) : command.action === 'configuration' && ++probes === 1 ? Promise.resolve(boundary === 'busy-retry' ? {ok: false, error: 'BUSY'} : {ok: true, value: {kind: 'configuration', configuration: {...f.configuration(), status: 'reconciliation-required'} as never}}) : original(command);
    await f.controller.handle('verify', [token]); await vi.advanceTimersByTimeAsync(0);
    // The recovery failure is newer, so it is shown in place of the verify reason.
    expect(f.controller.status).toMatchObject({state: 'paused', error: boundary === 'busy-retry' ? 'BUSY' : 'RECONCILIATION', owner: null});
    await vi.advanceTimersByTimeAsync(300000);
    // A bounded BUSY retry that settles owner-free shows the still-unconsumed reason once; fail-closed reconciliation is never retried or replaced.
    expect(probes).toBe(boundary === 'busy-retry' ? 2 : 1); expect(f.controller.status).toMatchObject(boundary === 'busy-retry' ? {state: 'disconnected', error: 'AUTHENTICATION'} : {state: 'paused', error: 'RECONCILIATION'});
  } finally {f.controller.stop(); vi.useRealTimers();}
});
it.each([false, true])('REG-010/012 keeps reconciliation fail-closed and preserves credentials with disconnect intent=%s', async intent => {
  const f = fixture(); await f.controller.attach(f.rpc); const candidate = await f.controller.handle('verify', [token]); await f.controller.handle('confirm', [candidate.candidateId]);
  f.setConfiguration({...f.configuration(), status: 'reconciliation-required', ...(intent ? {version: '2', registration: {...f.configuration().registration as object, accountId: 'new-owner'}} : {})});
  if (intent) await f.store.disconnectIntent({version: 1, channel: 'staging', origin, expectedVersion: '1'});
  const before = new Map(f.files), load = vi.spyOn(f.store, 'load'), start = f.calls.length;
  const restarted = f.controller;
  try {
    await restarted.attach(f.rpc); expect(restarted.status).toMatchObject({state: 'paused', error: 'RECONCILIATION', owner: null, candidateId: null});
    expect(f.files).toEqual(before); expect(await f.store.readDisconnect()).toEqual(intent ? {version: 1, channel: 'staging', origin, expectedVersion: '1'} : undefined);
    expect(load).not.toHaveBeenCalled(); expect(f.calls.slice(start).map(call => call.action)).toEqual(['configuration']); expect(restarted.journalReadScope).toBeUndefined();
  } finally {restarted.stop(); f.controller.stop();}
});
it.each(['reconciliation-owner', 'reconciliation-orphan', 'committed-disconnect'] as const)('REG-010/012 completes only the explicit version-bound disconnect during %s without secret loading', async boundary => {
  const f = fixture(); await f.controller.attach(f.rpc); const candidate = await f.controller.handle('verify', [token]); await f.controller.handle('confirm', [candidate.candidateId]);
  await f.store.disconnectIntent({version: 1, channel: 'staging', origin, expectedVersion: '1'});
  f.setConfiguration({...f.configuration(), status: boundary === 'committed-disconnect' ? 'ready' : 'reconciliation-required', ...(boundary === 'committed-disconnect' ? {version: '2', registration: null, credentialGeneration: null, runId: null} : boundary === 'reconciliation-orphan' ? {registration: null} : {})});
  const original = f.rpc.call, calls: UploadServiceCommand[] = [], load = vi.spyOn(f.store, 'load');
  const restarted = new UploadMainController(origin, 'staging', () => f.store, () => {});
  try {
    await restarted.attach({...f.rpc, async call(command) {
      calls.push(command);
      if (command.action === 'disconnect') {
        expect(command.expectedVersion).toBe('1'); expect(f.configuration().version).toBe('1');
        f.setConfiguration({...f.configuration(), status: 'ready', version: '2', registration: null, credentialGeneration: null, runId: null});
        return {ok: true, value: {kind: 'connection', connection: {status: 'disconnected', version: '2', runId: null}}};
      }
      return original(command);
    }});
    expect(restarted.status).toEqual(initialDashboardUploadStatus(origin)); expect(restarted.journalReadScope).toBeUndefined(); expect(f.files.size).toBe(0); expect(await f.store.readDisconnect()).toBeUndefined(); expect(load).not.toHaveBeenCalled();
    expect(calls.map(call => call.action)).toEqual(boundary === 'committed-disconnect' ? ['configuration'] : ['configuration', 'disconnect']);
  } finally {restarted.stop(); f.controller.stop();}
});
it('REG-010/012 keeps a valid owner-free recovery context while the exact reconciliation disconnect settles', async () => {
  const f = fixture(); await f.controller.attach(f.rpc); const candidate = await f.controller.handle('verify', [token]); await f.controller.handle('confirm', [candidate.candidateId]);
  await f.store.disconnectIntent({version: 1, channel: 'staging', origin, expectedVersion: '1'}); f.setConfiguration({...f.configuration(), status: 'reconciliation-required'});
  let entered!: () => void, settle!: (reply: UploadServiceReply) => void;
  const reached = new Promise<void>(done => {entered = done;}), reply = new Promise<UploadServiceReply>(done => {settle = done;}), original = f.rpc.call, load = vi.spyOn(f.store, 'load');
  const pending = f.controller.attach({...f.rpc, call(command) {if (command.action === 'disconnect') {entered(); return reply;} return original(command);}});
  try {
    await reached; const context = await f.controller.handle('context', []); expect(isDashboardUploadStatus(context)).toBe(true); expect(context).toMatchObject({state: 'paused', owner: null, candidateId: null});
    expect(await f.store.readDisconnect()).toBeDefined(); expect(load).not.toHaveBeenCalled();
    f.setConfiguration({...f.configuration(), status: 'ready', version: '2', registration: null, credentialGeneration: null, runId: null});
    settle({ok: true, value: {kind: 'connection', connection: {status: 'disconnected', version: '2', runId: null}}}); await pending;
    expect(f.controller.status).toEqual(initialDashboardUploadStatus(origin)); expect(f.files.size).toBe(0);
  } finally {f.controller.stop();}
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;}); return {promise, resolve};
}
function controlledService(initial?: UploadActiveConfiguration) {
  const state: {configuration: UploadActiveConfiguration} = {configuration: initial ?? {status: 'reconciliation-required', purpose: 'history', version: '1', registration: null, credentialGeneration: null, runId: null}};
  const configuration = vi.fn<UploadStorage['getUploadConfiguration']>(() => Promise.resolve({ok: true, value: state.configuration}));
  const recover = vi.fn<UploadStorage['recoverUploadAttempt']>(() => Promise.resolve({ok: true, value: {status: 'empty', attemptId: null, eventId: null, registrationId: null, registration: null, payload: null}}));
  const disconnect = vi.fn<UploadStorage['disconnectUploadOwner']>(input => {
    if (input.expectedVersion !== state.configuration.version) return Promise.resolve({ok: true, value: {status: 'stale', version: state.configuration.version, runId: null}});
    state.configuration = {...state.configuration, status: 'ready', version: String(BigInt(input.expectedVersion) + 1n), registration: null, credentialGeneration: null, runId: null};
    return Promise.resolve({ok: true, value: {status: 'disconnected', version: state.configuration.version, runId: null}});
  });
  const db = new Proxy({} as UploadStorage, {get(_target, key) {
    if (key === 'getUploadConfiguration') return configuration;
    if (key === 'recoverUploadAttempt') return recover;
    if (key === 'disconnectUploadOwner') return disconnect;
    throw Error('UNEXPECTED_STORAGE_OPERATION');
  }});
  const request = vi.fn(() => Promise.reject(Error('UNEXPECTED_HTTP')));
  const service = new DashboardUploadService(db, {request, abort() {}, close() {}}, origin, 'test', () => {});
  return {state, configuration, recover, disconnect, request, service};
}
it('REG-010/012 serializes reconciliation controls behind one conservative startup recovery and preserves stale disconnect', async () => {
  const f = controlledService(), gate = deferred<Awaited<ReturnType<UploadStorage['recoverUploadAttempt']>>>(), entered = deferred<void>();
  f.recover.mockImplementationOnce(() => {entered.resolve(); return gate.promise;});
  try {
    const pending = f.service.execute({action: 'configuration'}); await entered.promise;
    expect(await f.service.execute({action: 'disconnect', expectedVersion: '1'})).toEqual({ok: false, error: 'BUSY'});
    expect(f.configuration).toHaveBeenCalledTimes(1); expect(f.disconnect).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    gate.resolve({ok: true, value: {status: 'empty', attemptId: null, eventId: null, registrationId: null, registration: null, payload: null}});
    expect(await pending).toEqual({ok: true, value: {kind: 'configuration', configuration: f.state.configuration}});
    expect(await f.service.execute({action: 'disconnect', expectedVersion: '0'})).toEqual({ok: true, value: {kind: 'connection', connection: {status: 'stale', version: '1', runId: null}}});
    expect(f.state.configuration).toMatchObject({status: 'reconciliation-required', version: '1'});
    expect(await f.service.execute({action: 'suspend'})).toEqual({ok: true, value: {kind: 'settled'}});
    expect(f.recover.mock.calls).toEqual([[{startup: true}]]); expect(f.request).not.toHaveBeenCalled();
  } finally {await f.service.stop();}
});
it.each(['synthetic', 'replay'] as const)('REG-010/012 rechecks current %s purpose even for inert suspend', async purpose => {
  const f = controlledService();
  try {
    expect((await f.service.execute({action: 'configuration'})).ok).toBe(true);
    f.state.configuration = {...f.state.configuration, purpose};
    for (const command of [{action: 'configuration'}, {action: 'suspend'}, {action: 'disconnect', expectedVersion: '1'}, {action: 'verify', token}, {action: 'prepare', token, owner}, {action: 'activate', token, generation: randomUUID(), version: '1'}, {action: 'confirm', confirmationId: randomUUID(), registrationId: randomUUID(), credentialGeneration: randomUUID(), expectedVersion: '1'}] as UploadServiceCommand[]) expect(await f.service.execute(command)).toEqual({ok: false, error: 'RECONCILIATION'});
    expect(f.recover.mock.calls).toEqual([[{startup: true}]]); expect(f.disconnect).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  } finally {await f.service.stop();}
});
it.each(['startup', 'configuration', 'disconnect'] as const)('REG-010/012 fences cancellation while awaiting %s without a second startup recovery', async boundary => {
  const f = controlledService(), entered = deferred<void>(), gate = deferred<void>();
  const originalConfiguration = f.configuration.getMockImplementation()!, originalDisconnect = f.disconnect.getMockImplementation()!, originalRecovery = f.recover.getMockImplementation()!;
  if (boundary === 'startup') f.recover.mockImplementationOnce(async input => {entered.resolve(); await gate.promise; return originalRecovery(input);});
  else if (boundary === 'configuration') f.configuration.mockImplementationOnce(async () => {entered.resolve(); await gate.promise; return originalConfiguration();});
  else f.disconnect.mockImplementationOnce(async input => {const result = await originalDisconnect(input); entered.resolve(); await gate.promise; return result;});
  try {
    const pending = f.service.execute({action: 'disconnect', expectedVersion: '1'}); await entered.promise;
    f.service.cancel(); gate.resolve(); expect(await pending).toEqual({ok: false, error: 'RETIRED'});
    expect(f.disconnect).toHaveBeenCalledTimes(boundary === 'disconnect' ? 1 : 0); expect(f.state.configuration.version).toBe(boundary === 'disconnect' ? '2' : '1');
    expect((await f.service.execute({action: 'configuration'})).ok).toBe(true); expect(f.recover.mock.calls).toEqual([[{startup: true}]]); expect(f.request).not.toHaveBeenCalled();
  } finally {gate.resolve(); await f.service.stop();}
});
it.each(['startup', 'configuration', 'disconnect'] as const)('REG-010/012 fences stop while awaiting %s before acknowledging a control', async boundary => {
  const f = controlledService(), entered = deferred<void>(), gate = deferred<void>();
  const originalConfiguration = f.configuration.getMockImplementation()!, originalDisconnect = f.disconnect.getMockImplementation()!, originalRecovery = f.recover.getMockImplementation()!;
  if (boundary === 'startup') f.recover.mockImplementationOnce(async input => {entered.resolve(); await gate.promise; return originalRecovery(input);});
  else if (boundary === 'configuration') f.configuration.mockImplementationOnce(async () => {entered.resolve(); await gate.promise; return originalConfiguration();});
  else f.disconnect.mockImplementationOnce(async input => {const result = await originalDisconnect(input); entered.resolve(); await gate.promise; return result;});
  try {
    const pending = f.service.execute({action: 'disconnect', expectedVersion: '1'}); await entered.promise;
    await f.service.stop(); gate.resolve(); expect(await pending).toEqual({ok: false, error: 'RETIRED'});
    expect(await f.service.execute({action: 'configuration'})).toEqual({ok: false, error: 'RETIRED'});
    expect(f.disconnect).toHaveBeenCalledTimes(boundary === 'disconnect' ? 1 : 0); expect(f.recover).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  } finally {gate.resolve(); await f.service.stop();}
});
it('REG-010/012 fails closed on startup storage refusal before admitting private controls', async () => {
  const f = controlledService(); f.recover.mockResolvedValue({ok: false, error: {code: 'IO_ERROR', message: 'private-storage-detail', retryable: true}});
  try {
    for (const command of [{action: 'configuration'}, {action: 'disconnect', expectedVersion: '1'}, {action: 'suspend'}, {action: 'verify', token}] as UploadServiceCommand[]) expect(await f.service.execute(command)).toEqual({ok: false, error: 'STORAGE_UNAVAILABLE'});
    expect(f.recover).toHaveBeenCalledTimes(1); expect(f.configuration).toHaveBeenCalledTimes(1); expect(f.disconnect).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  } finally {await f.service.stop();}
});
it.each(['cancel', 'stop'] as const)('REG-010/012 retains disconnect intent and ciphertext after %s races a committed service disconnect', async boundary => {
  const f = fixture(); await f.controller.attach(f.rpc); const candidate = await f.controller.handle('verify', [token]); await f.controller.handle('confirm', [candidate.candidateId]);
  await f.store.disconnectIntent({version: 1, channel: 'staging', origin, expectedVersion: '1'});
  const before = new Map(f.files), load = vi.spyOn(f.store, 'load'), controlled = controlledService({...f.configuration(), status: 'reconciliation-required'} as UploadActiveConfiguration);
  const entered = deferred<void>(), gate = deferred<void>(), original = controlled.disconnect.getMockImplementation()!;
  controlled.disconnect.mockImplementationOnce(async input => {const result = await original(input); entered.resolve(); await gate.promise; return result;});
  const main = new UploadMainController(origin, 'staging', () => f.store, () => {}), commands: string[] = [];
  const attach = main.attach({generation: randomUUID(), call(command) {commands.push(command.action); return controlled.service.execute(command);}, retire() {}});
  let resumed: UploadMainController | undefined;
  try {
    await entered.promise; if (boundary === 'cancel') controlled.service.cancel(); else await controlled.service.stop(); gate.resolve(); await attach;
    expect(main.status).toMatchObject({state: 'paused', owner: null, error: 'RETIRED'}); expect(f.files).toEqual(before); expect(await f.store.readDisconnect()).toBeDefined(); expect(load).not.toHaveBeenCalled(); expect(commands).toEqual(['configuration', 'disconnect']);
    const next = controlledService(controlled.state.configuration);
    try {
      resumed = new UploadMainController(origin, 'staging', () => f.store, () => {});
      await resumed.attach({generation: randomUUID(), call: command => next.service.execute(command), retire() {}});
      expect(resumed.status).toEqual(initialDashboardUploadStatus(origin)); expect(f.files.size).toBe(0); expect(await f.store.readDisconnect()).toBeUndefined(); expect(next.disconnect).not.toHaveBeenCalled(); expect(load).not.toHaveBeenCalled(); expect(next.request).not.toHaveBeenCalled();
    } finally {resumed?.stop(); await next.service.stop();}
    expect(controlled.recover.mock.calls).toEqual([[{startup: true}]]); expect(controlled.request).not.toHaveBeenCalled();
  } finally {gate.resolve(); main.stop(); f.controller.stop(); await controlled.service.stop();}
});
/** A service whose Dashboard answers the connection with `bodyMinor` in the body and `eventVersions` as the header, if any. */
function advertisingService(bodyMinor: 0 | 1, eventVersions?: string) {
  const registration = {...owner, registrationId: randomUUID(), clientInstallationId: randomUUID(), installationId: randomUUID(), bindingId: randomUUID()};
  const configuration: UploadActiveConfiguration = {status: 'ready', purpose: 'history', version: '1', registration, credentialGeneration: randomUUID(), runId: randomUUID()};
  const db = new Proxy({} as UploadStorage, {get(_target, key) {
    if (key === 'getUploadConfiguration') return () => Promise.resolve({ok: true, value: configuration});
    if (key === 'recoverUploadAttempt') return () => Promise.resolve({ok: true, value: {status: 'empty', attemptId: null, eventId: null, registrationId: null, registration: null, payload: null}});
    throw Error('UNEXPECTED_STORAGE_OPERATION');
  }});
  const limits = {maxEventBytes: 65536, maxDepth: 16, eventsPerMinute: 60, burst: 10}, json = (value: unknown) => new Uint8Array(Buffer.from(JSON.stringify(value)));
  const request = vi.fn((route: string) => Promise.resolve(route === 'connection'
    ? {ok: true as const, statusCode: 200, body: json({contract: {major: 1, minor: bodyMinor}, accountId: 'a', companyId: 'c', identityEpoch: 'e', limits}), retryAfter: null, ...(eventVersions === undefined ? {} : {eventVersions})}
    : {ok: true as const, statusCode: 201, body: json({contract: {major: 1, minor: 0}, installationId: registration.installationId, bindingId: registration.bindingId, identityEpoch: 'e'}), retryAfter: null}));
  const service = new DashboardUploadService(db, {request, abort() {}, close() {}}, origin, 'test', () => {});
  const activate = vi.spyOn(service.scheduler, 'activate').mockResolvedValue();
  return {service, configuration, limits, activate};
}
// ET-113: the Dashboard keeps the v1.0 control body and lists its event versions only in VTC-Telemetry-Event-Versions.
it.each([
  [0, '1.0, 1.1, 1.2', 2], [0, '1.0, 1.1', 1], [0, undefined, 0], [1, undefined, 0], [1, '1.0', 0]
] as const)('REG-010 activates with the event minor of the connection header, not the body: body minor %s, header %j', async (bodyMinor, header, minor) => {
  const f = advertisingService(bodyMinor, header);
  try {
    const reply = await f.service.execute({action: 'activate', token, generation: f.configuration.credentialGeneration!, version: '1'});
    expect(reply).toMatchObject({ok: true, value: {kind: 'settled'}});
    expect(f.activate.mock.calls).toEqual([[f.configuration, token, f.limits, minor]]);
  } finally {await f.service.stop();}
});
// ET-113: a verify reply with any private field is dropped by the main-process bridge, which then times out after 65 s.
it('REG-010/012 answers verify through the real private bridge with only the owner and limits', async () => {
  const f = advertisingService(0, '1.0, 1.1, 1.2');
  let answered: Promise<void> | undefined, settled: UploadServiceReply | undefined;
  const bridge = new UploadServiceBridge(value => {
    const message = value as {id: string; generation: string; command: UploadServiceCommand};
    answered = f.service.execute(message.command).then(reply => {bridge.receive({type: 'dashboard-upload:answer', id: message.id, generation: message.generation, reply});});
  }, () => {});
  try {
    const pending = bridge.call({action: 'verify', token}).then(reply => {settled = reply;});
    await answered; await Promise.resolve();
    expect(settled).toEqual({ok: true, value: {kind: 'verified', owner, limits: f.limits}});
    await pending;
  } finally {bridge.retire(); await f.service.stop();}
});
