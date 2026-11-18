import {randomUUID} from 'node:crypto';
import {initialQualificationState,isQualificationWire,compareQualificationCounter,type QualificationState,type QualificationGame,type QualificationWire} from '../../../../packages/contracts/src/qualification';
import type {StorageClient} from '../../../../packages/storage/src/client';
import type {QualificationAuthority,QualificationCommandName,QualificationRefresh} from '../../../../packages/storage/src/qualification';
import type {UploadActiveConfiguration} from '../../../../packages/storage/src/upload-sync';
import type {DashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
import {jsonBody} from '../dashboard-upload/control-response';
import {stored} from '../dashboard-upload/scheduler';
import {qualificationLeaseCue,type QualificationLease} from '../overlay-qualification';
import {QualificationPreviewFacts,type PreviewStorage,type QualificationLive} from './preview-facts';
import {QualificationScheduler,qualificationRetry,qualificationClock,type QualificationClock,type QualificationTask} from './scheduler';
import type {QualificationTransport,QualificationRoute,QualificationHttpResult} from './http';
export type QualificationStorage=Pick<StorageClient,QualificationCommandName>&PreviewStorage;
interface Active {authority:QualificationAuthority;owner:DashboardOwner;token:string;scope:string|null;capabilities:QualificationWire['Capabilities']|null;refresh:QualificationRefresh;facts:QualificationPreviewFacts;scheduler:QualificationScheduler;resultLimit:number;resultsHeld:boolean}
/** Companion lifecycle is independent of recorder admission, upload requests and durable receipts. */
export class QualificationService {
  #active:Active|null=null;#states={ets2:initialQualificationState('ets2'),ats:initialQualificationState('ats')};#generation=0;#abort=new AbortController();
  #live:QualificationLive|null=null;#lease:QualificationLease|null=null;#sampleTimer:unknown;#sampling=false;#stopped=false;
  #leaseTimer:unknown;
  #startup:Promise<void>;
  constructor(private readonly db:QualificationStorage,private readonly http:QualificationTransport,private readonly publish:(state:QualificationState,connectionVersion:string|null)=>void,private readonly clock:QualificationClock=qualificationClock,private readonly monotonic:()=>number=()=>performance.now()){this.#startup=this.#recoverPins();this.#startup.catch(()=>undefined);}
  async #recoverPins():Promise<void>{const retained=await stored(this.db.readQualificationPreviewPins({}));for(const pin of retained.items){let complete=false;for(let turn=0;turn<64;turn++){const released=await stored(this.db.releaseQualificationPreview(pin));if(released.state==='released'){complete=true;break;}}if(!complete)throw Error('PREVIEW_RELEASE_PENDING');}}
  get(game:QualificationGame):QualificationState{return structuredClone(this.#states[game]);}
  get connectionVersion():string|null{return this.#active?.authority.connectionVersion??null;}
  refresh(game:QualificationGame):QualificationState{const active=this.#active;if(active?.capabilities?.qualificationEnabled&&!active.refresh.suspended){this.#emit(game,{refreshing:true});active.scheduler.request(game);}return this.get(game);}
  uploaded():void{this.#active?.scheduler.request('results');}
  #emit(game:QualificationGame,change:Partial<QualificationState>):void{this.#states[game]={...this.#states[game],...change};this.publish(this.get(game),this.connectionVersion);}
  #revision(scope:string):string|null{let latest:string|null=null;for(const state of Object.values(this.#states)){const snapshot=state.snapshot;if(snapshot?.securityScope===scope&&(latest===null||compareQualificationCounter(snapshot.progressRevision,latest)>0))latest=snapshot.progressRevision;}return latest;}
  observe(live:QualificationLive|null):void{this.#live=live;this.#active?.facts.observe(live);if(!this.#active?.facts.current)this.#clearPreview();if(this.#active)for(const game of ['ets2','ats'] as const){const activeJob=live?.source.game===game&&live.state.configuration.job.available;if(this.#states[game].activeJob!==activeJob)this.#emit(game,{activeJob});}}
  #clearPreview():void{this.clock.clearTimeout(this.#leaseTimer);this.#lease=null;for(const game of ['ets2','ats'] as const)if(this.#states[game].preview)this.#emit(game,{preview:null});}
  async activate(configuration:UploadActiveConfiguration,token:string):Promise<void>{
    await this.retire();await this.#startup;if(this.#stopped||configuration.status!=='ready'||configuration.purpose!=='history'||!configuration.registration)return;
    const registration=configuration.registration,authority={registrationId:registration.registrationId,connectionVersion:configuration.version};
    const owner:DashboardOwner={origin:registration.origin,accountId:registration.accountId,companyId:registration.companyId,identityEpoch:registration.identityEpoch};
    const generation=++this.#generation;this.#abort=new AbortController();
    const facts=new QualificationPreviewFacts(this.db,authority),scheduler=new QualificationScheduler(task=>this.#run(task,generation),this.clock);
    const active:Active={authority,owner,token,scope:null,capabilities:null,refresh:{afterEvent:null,retryAtMs:0,failureStreak:0,suspended:false},facts,scheduler,resultLimit:25,resultsHeld:false};this.#active=active;facts.observe(this.#live);
    for(const game of ['ets2','ats'] as const)this.#emit(game,{...initialQualificationState(game,owner),refreshing:true});
    try{
      const cached=await stored(this.db.readQualificationCache(authority));if(this.#active!==active||!cached.active)return;
      active.scope=cached.securityScope;active.refresh={...cached.refresh,suspended:false};
      for(const cache of cached.caches)this.#emit(cache.snapshot.game,{snapshot:cache.snapshot,fetchedUtcMs:cache.fetchedUtcMs,availability:'offline',stale:true,refreshing:false});
      // An explicit activation is an access/configuration change and may resume a previously suspended lane.
      scheduler.request('capabilities');this.#sample(generation);
    }catch{if(this.#active===active)for(const game of ['ets2','ats'] as const)this.#emit(game,{availability:'unavailable',refreshing:false});}
  }
  async #request(route:QualificationRoute,body:unknown,active:Active):Promise<QualificationHttpResult>{
    const encoded=body===undefined?undefined:new TextEncoder().encode(JSON.stringify(body));return this.http.request(route,active.token,encoded,this.#abort.signal);
  }
  async #failed(response:QualificationHttpResult,active:Active):Promise<number>{
    const status=response.statusCode;
    const suspend=status!==null&&[400,401,403,404,413,415].includes(status);
    const delay=suspend?Infinity:Math.max(5000,qualificationRetry(++active.refresh.failureStreak,response.retryAfter,this.clock.now(),this.clock.random()));
    let availability:QualificationState['availability']='offline';
    if(status===401||status===403)availability='permission-required';else if(status===404)availability='unsupported';else if(suspend)availability='unavailable';
    this.#clearPreview();
    for(const game of ['ets2','ats'] as const)this.#emit(game,{availability,stale:true,refreshing:false});
    active.refresh={...active.refresh,failureStreak:Math.min(9,active.refresh.failureStreak),retryAtMs:Number.isFinite(delay)?Math.min(Number.MAX_SAFE_INTEGER,this.clock.now()+delay):0,suspended:suspend};
    if(active.scope)await stored(this.db.saveQualificationRefresh({...active.authority,securityScope:active.scope,refresh:active.refresh}));
    if(suspend)active.scheduler.stop();return delay;
  }
  async #run(task:QualificationTask,generation:number):Promise<number>{
    const active=this.#active;if(!active||generation!==this.#generation)return Infinity;
    if(active.refresh.suspended)return Infinity;
    if(active.refresh.retryAtMs>this.clock.now())return active.refresh.retryAtMs-this.clock.now();
    try{
      if(task==='capabilities'){
        const response=await this.#request('capabilities',undefined,active);if(this.#active!==active)return Infinity;
        if(!response.ok||response.statusCode!==200)return this.#failed(response,active);
        const value=jsonBody(response.body,1048576);if(!isQualificationWire('Capabilities',value))throw Error('INVALID_COMPANION_RESPONSE');
        if(active.scope!==value.securityScope){this.#clearPreview();for(const game of ['ets2','ats'] as const)this.#emit(game,{snapshot:null,fetchedUtcMs:null,stale:true});active.refresh.afterEvent=null;}
        const scope=await stored(this.db.setQualificationScope({...active.authority,securityScope:value.securityScope}));if(this.#active!==active||!scope.active)return Infinity;
        active.scope=value.securityScope;active.capabilities=value;active.refresh.suspended=false;active.refresh.failureStreak=0;active.refresh.retryAtMs=0;
        for(const game of ['ets2','ats'] as const){if(value.qualificationEnabled&&value.games.includes(game))active.scheduler.request(game);else this.#emit(game,{availability:'disabled',stale:true,refreshing:false});}
        if(value.resultsEnabled)active.scheduler.request('results');if(value.previewEnabled)active.scheduler.request('preview');return 60000;
      }
      if(!active.scope||!active.capabilities)return Infinity;
      if(task==='ets2'||task==='ats'){
        if(!active.capabilities.qualificationEnabled)return Infinity;this.#emit(task,{refreshing:true});
        const response=await this.#request(`qualification/${task}`,undefined,active);if(this.#active!==active)return Infinity;
        if(!response.ok||response.statusCode!==200)return this.#failed(response,active);
        const value=jsonBody(response.body,1048576);if(!isQualificationWire('Qualification',value)||value.game!==task||value.securityScope!==active.scope||value.ownerId!==active.owner.accountId)throw Error('INVALID_COMPANION_RESPONSE');
        const old=this.#states[task].snapshot;if(old&&compareQualificationCounter(value.progressRevision,old.progressRevision)<0)throw Error('INVALID_COMPANION_RESPONSE');
        const saved=await stored(this.db.saveQualificationCache({...active.authority,snapshot:value,fetchedUtcMs:this.clock.now()}));if(this.#active!==active||!saved.saved)return Infinity;
        if(old?.progressRevision!==value.progressRevision)this.#clearPreview();
        this.#emit(task,{snapshot:value,fetchedUtcMs:this.clock.now(),availability:value.state==='unavailable'?'disabled':'ready',stale:false,refreshing:false});return Math.max(5000,value.refreshAfterSeconds*1000);
      }
      if(task==='results'){
        if(!active.capabilities.resultsEnabled||active.resultsHeld)return Infinity;
        const page=await stored(this.db.pageQualificationSources({...active.authority,securityScope:active.scope,afterEvent:active.refresh.afterEvent,limit:active.resultLimit}));if(this.#active!==active)return Infinity;
        if(!page.items.length){active.refresh.afterEvent=null;return 5000;}
        const request={requestId:randomUUID(),items:page.items.map(item=>item.request)};
        const response=await this.#request('results',request,active);if(this.#active!==active)return Infinity;
        if(response.ok&&response.statusCode===422&&response.retryAfter===null){
          const error=jsonBody(response.body,4096);
          if(isQualificationWire('Error',error)&&error.error.code==='RESULT_BATCH_TOO_LARGE'&&!error.error.retryable){
            // Keep the same durable cursor: a rejected batch consumed none of its sources.
            if(page.items.length===1){active.resultsHeld=true;return Infinity;}
            active.resultLimit=Math.max(1,Math.floor(page.items.length/2));return 5000;
          }
        }
        if(!response.ok||response.statusCode!==200)return this.#failed(response,active);
        const batch=jsonBody(response.body,1048576);if(!isQualificationWire('ResultBatch',batch)||batch.securityScope!==active.scope)throw Error('INVALID_COMPANION_RESPONSE');
        const saved=await stored(this.db.commitQualificationResults({...active.authority,securityScope:active.scope,expectedHeads:page.items.map(item=>({eventId:item.request.eventId,generation:item.generation})),request,batch,fetchedUtcMs:this.clock.now()}));if(this.#active!==active)return Infinity;
        // A conditional response without a base is retried unconditionally on the next bounded sweep.
        active.refresh.afterEvent=saved.missingBase.length?null:page.next;active.refresh.failureStreak=0;active.refresh.retryAtMs=0;
        await stored(this.db.saveQualificationRefresh({...active.authority,securityScope:active.scope,refresh:active.refresh}));return Math.max(5000,batch.refreshAfterSeconds*1000);
      }
      if(!active.capabilities.previewEnabled)return Infinity;
      const input=await active.facts.read();if(this.#active!==active)return Infinity;if(!input){this.#clearPreview();return 5000;}
      const dispatched=this.monotonic(),response=await this.#request('preview',input,active);if(this.#active!==active)return Infinity;
      if(!response.ok||response.statusCode!==200)return this.#failed(response,active);
      const reply=jsonBody(response.body,1048576);if(!isQualificationWire('Preview',reply)||reply.securityScope!==active.scope||reply.requestId!==input.requestId||reply.contextRevision!==input.contextRevision||reply.evidenceRevision!==input.evidenceRevision)throw Error('INVALID_COMPANION_RESPONSE');
      const current=await active.facts.refresh();if(this.#active!==active)return Infinity;
      const lease:QualificationLease={reply,input,dispatchMonotonicMs:dispatched,authority:active.scope};
      const cue=qualificationLeaseCue(lease,current,active.scope,this.#revision(active.scope),this.monotonic());
      if(cue!=='neutral'||reply.outcome==='unknown'&&current?.contextRevision===input.contextRevision){
        this.clock.clearTimeout(this.#leaseTimer);this.#lease=lease;this.#emit(input.game,{preview:reply});
        const ttl=Math.min(5000,Date.parse(reply.applicability.expiresAt)-Date.parse(reply.evaluatedAt));
        this.#leaseTimer=this.clock.setTimeout(()=>{if(this.#lease===lease)this.#clearPreview();},Math.max(0,dispatched+ttl-this.monotonic()));
      }else this.#clearPreview();
      if(reply.applicability.requiresQualificationRefresh)active.scheduler.request(input.game);return 5000;
    }catch{if(this.#active!==active)return Infinity;return this.#failed({ok:false,code:'INVALID_RESPONSE',statusCode:null,retryAfter:null},active);}
  }
  #sample(generation:number):void {
    this.#sampleTimer=this.clock.setTimeout(()=>{
      const active=this.#active;if(!active||generation!==this.#generation)return;
      const sample=async()=>{
        if(this.#sampling)return;this.#sampling=true;
        try{const current=await active.facts.read();if(this.#active!==active)return;
          if(this.#lease&&(!current||current.contextRevision!==this.#lease.input.contextRevision))this.#clearPreview();
          if(this.#lease&&qualificationLeaseCue(this.#lease,current,active.scope??'',this.#revision(active.scope??''),this.monotonic())==='neutral'&&this.#lease.reply.outcome!=='unknown')this.#clearPreview();
          if(this.#lease&&this.monotonic()>=this.#lease.dispatchMonotonicMs+5000)this.#clearPreview();
        }catch{if(this.#active===active)this.#clearPreview();}finally{this.#sampling=false;if(this.#active===active)this.#sample(generation);}
      };void sample();
    },1000);
  }
  async retire():Promise<void>{this.#generation++;this.#abort.abort();this.http.abort();this.clock.clearTimeout(this.#sampleTimer);this.clock.clearTimeout(this.#leaseTimer);const active=this.#active;this.#active=null;active?.scheduler.stop();this.#lease=null;for(const game of ['ets2','ats'] as const)this.#emit(game,initialQualificationState(game));await active?.facts.close();}
  async stop():Promise<void>{this.#stopped=true;await this.retire();this.http.close();}
}
