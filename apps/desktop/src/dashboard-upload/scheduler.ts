import {randomUUID} from 'node:crypto';
import type {StorageClient} from '../../../../packages/storage/src/client';
import type {Result} from '../../../../packages/storage/src/api';
import type {UploadSyncName,UploadRegistration,RetainedUploadMaterializations,UploadActiveConfiguration} from '../../../../packages/storage/src/upload-sync';
import {initialDashboardUploadStatus,type DashboardUploadStatus} from '../../../../packages/contracts/src/dashboard-upload';
import type {UploadTransport} from './http';
import {responseFailure,type UploadLimits} from './control-response';
import {UploadRate,uploadRetryDelay} from './retry';
export type UploadStorage=Pick<StorageClient,UploadSyncName>;
export async function stored<T>(result:Promise<Result<T>>):Promise<T>{const answer=await result;if(!answer.ok)throw Error('STORAGE_UNAVAILABLE');return answer.value;}
export interface UploadClock {now():number;random():number;schedule(callback:()=>void,ms:number):unknown;cancel(handle:unknown):void}
const clock:UploadClock={now:Date.now,random:Math.random,schedule:(fn,ms)=>setTimeout(fn,ms),cancel:id=>clearTimeout(id as ReturnType<typeof setTimeout>)};
interface Active {configuration:UploadActiveConfiguration;registration:UploadRegistration;token:string}
/** Storage turns and HTTP have independent single flights; neither blocks recorder admission. */
export class UploadScheduler {
  #active:Active|undefined;#stopped=false;#suspended=true;#background=false;#backgroundFlight:Promise<number>|undefined;#sending:Promise<void>|undefined;#timer:unknown;#generation=0;
  #rate:UploadRate;#nextMode:'live'|'backfill'='live';#sendAfter=0;#failureStreak=0;#emptyModes=0;
  #retained:RetainedUploadMaterializations['items']=[];#workCursor=0;#blocked=new Map<string,number>();#maintenance=true;#capacity:string|undefined;
  #phase:'status'|'runs'|'scan'|'discovery'|'begin'|'sources'|'receipts'='status';#runsAfter:string|null=null;#run:string|null=null;#runPending:string[]=[];#discoveryAfter='0';
  #pending:{tripUuid:string;workId:string|null}[]=[];#sourceAfter:string|null=null;#receiptAfter:string|null=null;#sources=0;#delivered=0;#lastReceipt:number|null=null;
  #status:DashboardUploadStatus;#reconstruct=true;#nextRefresh=0;#progressGeneration=0;
  constructor(private readonly db:UploadStorage,private readonly http:UploadTransport,origin:string,private readonly producerVersion:string,private readonly publish:(status:DashboardUploadStatus)=>void,private readonly time:UploadClock=clock){this.#status=initialDashboardUploadStatus(origin);this.#rate=new UploadRate(60,10,time.now());}
  get status():DashboardUploadStatus{return structuredClone(this.#status);}
  async activate(configuration:UploadActiveConfiguration,token:string,limits:UploadLimits):Promise<void>{
    await this.suspend();if(this.#stopped||configuration.status!=='ready'||configuration.purpose!=='history'||!configuration.registration||!configuration.credentialGeneration)return;
    const generation=this.#generation;this.#active={configuration,registration:configuration.registration,token};this.#rate.configure(limits.eventsPerMinute,limits.burst);const hints=await stored(this.db.getUploadSchedulingHints({registrationId:configuration.registration.registrationId}));
    if(this.#stopped||generation!==this.#generation)return;this.#failureStreak=hints.failureStreak;this.#sendAfter=Math.max(this.time.now(),hints.retryAtMs??0);this.#generation++;this.#suspended=false;
    this.#phase='status';this.#runsAfter=null;this.#runPending=[];this.#pending=[];this.#emptyModes=0;this.#resetProgress();this.#status={...initialDashboardUploadStatus(configuration.registration.origin),state:'connected',owner:{origin:configuration.registration.origin,accountId:configuration.registration.accountId,companyId:configuration.registration.companyId,identityEpoch:configuration.registration.identityEpoch}};this.#emit();this.#wake(0);
  }
  async suspend():Promise<void>{this.#suspended=true;this.#generation++;this.time.cancel(this.#timer);this.http.abort();await Promise.all([this.#sending,this.#backgroundFlight?.catch(()=>undefined)]);this.#active=undefined;}
  stop():Promise<void>{this.#stopped=true;this.#status.state='stopping';this.#emit();return this.suspend();}
  #emit(){this.publish(this.status);}
  #wake(ms:number){if(this.#stopped||this.#suspended)return;this.time.cancel(this.#timer);this.#timer=this.time.schedule(()=>{this.#timer=undefined;void this.#tick();},Math.max(0,ms));}
  #resetProgress(){this.#progressGeneration++;this.#sourceAfter=null;this.#receiptAfter=null;this.#sources=0;this.#delivered=0;this.#lastReceipt=null;this.#reconstruct=true;this.#nextRefresh=this.time.now()+5000;this.#status.progress.enumeration='changing';}
  async #tick(){if(this.#stopped||this.#suspended)return;const active=this.#active;if(!active)return;
    if(!this.#sending&&this.time.now()>=this.#sendAfter){this.#sending=this.#send(active).catch(()=>{this.#status.error='STORAGE_UNAVAILABLE';this.#sendAfter=this.time.now()+2000;}).finally(()=>{this.#sending=undefined;this.#wake(10);});}
    if(this.#background)return;this.#background=true;const generation=this.#generation;let delay=10;
    try{this.#backgroundFlight=this.#turn(active,generation);delay=await this.#backgroundFlight;}catch{this.#status.error='STORAGE_UNAVAILABLE';delay=2000;}finally{this.#backgroundFlight=undefined;this.#background=false;if(generation===this.#generation){this.#emit();this.#wake(delay);}}
  }
  async #send(active:Active){
    const generation=this.#generation,rateDelay=this.#rate.delay(this.time.now(),false);if(rateDelay){this.#sendAfter=this.time.now()+rateDelay;return;}
    const attempt=await stored(this.db.claimUploadAttempt({attemptId:randomUUID(),registrationId:active.registration.registrationId,expectedVersion:active.configuration.version,mode:this.#nextMode,nowMs:this.time.now()}));
    if(attempt.status==='empty'){this.#nextMode=this.#nextMode==='live'?'backfill':'live';this.#sendAfter=this.time.now()+(++this.#emptyModes%2===0?1000:0);return;}
    if(attempt.status!=='claimed'){this.#sendAfter=this.time.now()+2000;return;}
    this.#emptyModes=0;
    this.#rate.delay(this.time.now());
    // A transition may have happened while the claim was in storage. Retire its slot without starting HTTP.
    if(this.#suspended||generation!==this.#generation){await stored(this.db.recoverUploadAttempt({attemptId:attempt.attemptId!}));return;}
    this.#nextMode=this.#nextMode==='live'?'backfill':'live';
    const result=await this.http.request('events',active.token,attempt.payload!);
    if(result.ok&&[200,202].includes(result.statusCode)){
      // A complete known ACK must reach SQLite even after rotation/disconnect/stop.
      const receipt=await stored(this.db.commitUploadReceipt({attemptId:attempt.attemptId!,statusCode:result.statusCode,body:result.body}));
      if(receipt.status==='delivered'||receipt.status==='duplicate'){this.#failureStreak=0;this.#sendAfter=this.time.now();this.#resetProgress();this.#phase='sources';return;}
    }
    const kind=result.ok?responseFailure(result.statusCode,result.body):result.code==='REDIRECT'||result.code==='TLS_CONFIGURATION'?'configuration':result.statusCode===401||result.statusCode===403?'authentication':'retry';
    const retryAt=this.time.now()+uploadRetryDelay(++this.#failureStreak,result.ok?result.retryAfter:null,this.time.now(),()=>this.time.random());
    const outcome=await stored(this.db.recordUploadAttemptOutcome({attemptId:attempt.attemptId!,kind,retryAtMs:retryAt,nowMs:this.time.now()}));this.#sendAfter=retryAt;
    if(outcome.status==='recorded'&&kind!=='retry'&&kind!=='validation'){this.#status.state='paused';this.#status.error=kind==='authentication'?'AUTHENTICATION':kind==='configuration'?'CONFIGURATION':'RECONCILIATION';}
  }
  async #turn(active:Active,generation:number):Promise<number>{
    if(this.#maintenance){this.#maintenance=false;const inventory=await stored(this.db.readRetainedUploadMaterializations());if(generation!==this.#generation)return 1000;
      this.#retained=inventory.items;const ids=new Set(inventory.items.map(item=>item.workId));for(const id of this.#blocked.keys())if(!ids.has(id))this.#blocked.delete(id);if(inventory.unmanagedPins)this.#status.error='RECONCILIATION';return 10;}
    if(this.#retained.length){for(let n=0;n<this.#retained.length;n++){const item=this.#retained[this.#workCursor++%this.#retained.length];if((this.#blocked.get(item.workId)??0)>this.time.now())continue;
        const result=item.state==='preparing'||item.state==='folding'?await stored(this.db.advanceUploadMaterialization({workId:item.workId})):item.state==='complete'?await stored(this.db.freezeUploadMaterialization({workId:item.workId,producerVersion:this.producerVersion,createdUtcMs:this.time.now()})):await stored(this.db.releaseUploadMaterialization({workId:item.workId}));
        if(result.status==='pressure')this.#blocked.set(item.workId,this.time.now()+2000);this.#maintenance=true;return 10;
      }}
    this.#maintenance=true;
    const registrationId=active.registration.registrationId;
    switch(this.#phase){
      case 'status':{const status=await stored(this.db.getUploadStoreStatus({registrationId}));if(generation!==this.#generation)return 1000;
        this.#discoveryAfter=status.discoveryAfter;Object.assign(this.#status.progress,{identityPendingSources:status.identityPendingSources,pendingSources:status.pendingSources,heldSources:status.heldSources,queuedEvents:status.queuedEvents,pressure:status.pressure});
        const capacity=`${status.queuedEvents}:${status.queuedBytes}`;if(this.#capacity!==undefined&&this.#capacity!==capacity)this.#blocked.clear();this.#capacity=capacity;this.#phase=status.pressure?'sources':'runs';return 10;}
      case 'runs':{const page=await stored(this.db.pageUploadScanRuns({registrationId,after:this.#runsAfter,limit:100}));this.#runsAfter=page.next;this.#runPending=page.items.filter(item=>item.phase!=='complete').map(item=>item.runId);this.#run=this.#runPending.shift()??null;this.#phase=this.#run?'scan':page.next?'runs':'discovery';return 10;}
      case 'scan':{const result=await stored(this.db.advanceUploadScan({registrationId,runId:this.#run!}));this.#status.progress.enumeration='scanning';if(result.phase==='complete'){this.#run=this.#runPending.shift()??null;this.#phase=this.#run?'scan':'runs';}else this.#phase=result.phase==='pressure'?'sources':'scan';return 10;}
      case 'discovery':{if(this.#status.progress.pressure){this.#phase='sources';return 1000;}const page=await stored(this.db.pageUploadDiscovery({registrationId,after:this.#discoveryAfter,limit:100}));this.#discoveryAfter=page.next;this.#pending=page.items.filter(item=>item.workId===null);this.#phase=this.#pending.length?'begin':'sources';return 10;}
      case 'begin':{const item=this.#pending.shift();if(item)await stored(this.db.beginUploadMaterialization({registrationId,tripUuid:item.tripUuid,workId:randomUUID()}));if(!this.#pending.length)this.#phase='sources';return 10;}
      case 'sources':{if(!this.#reconstruct&&this.time.now()<this.#nextRefresh){await stored(this.db.reclaimUploadPayloads({limit:100}));this.#phase='status';return 500;}
        if(!this.#reconstruct)this.#resetProgress();const progressGeneration=this.#progressGeneration,page=await stored(this.db.pageUploadSources({registrationId,phase:'sources',after:this.#sourceAfter,limit:100}));if(progressGeneration!==this.#progressGeneration||generation!==this.#generation)return 10;this.#sourceAfter=page.next;this.#sources+=page.sources.length;this.#delivered+=page.sources.filter(item=>item.state==='delivered').length;if(page.next===null)this.#phase='receipts';return 10;}
      case 'receipts':{const progressGeneration=this.#progressGeneration,page=await stored(this.db.pageUploadSources({registrationId,phase:'receipts',after:this.#receiptAfter,limit:100}));if(progressGeneration!==this.#progressGeneration||generation!==this.#generation)return 10;this.#receiptAfter=page.next;for(const receipt of page.receipts)this.#lastReceipt=Math.max(this.#lastReceipt??0,receipt.firstReceivedUtcMs);
        if(page.next===null){Object.assign(this.#status.progress,{enumeration:'complete',distinctSources:this.#sources,deliveredSources:this.#delivered,lastDurableUploadUtcMs:this.#lastReceipt});this.#reconstruct=false;this.#phase='status';}return 10;}
    }
  }
}
