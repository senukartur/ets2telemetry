import {randomUUID} from 'node:crypto';
import {initialDashboardUploadStatus,isDashboardUploadStatus,sameDashboardOwner,type DashboardUploadStatus,type DashboardOwner,type DashboardUploadError} from '../../../../packages/contracts/src/dashboard-upload';
import type {ReleaseChannel} from '../channel';
import {validUploadArguments,type UploadAction} from './contract';
import {UploadCredentialStore,type CredentialContext} from './credential-store';
import type {UploadRpc} from './service-bridge';
import type {UploadServiceValue} from './service-contract';
import {uploadRetryDelay} from './retry';
import type {JournalUploadScope} from './journal-sync-guard';
/** Main-only authority: candidates belong to one document and one utility generation. */
export class UploadMainController {
  #rpc:UploadRpc|undefined;#store:UploadCredentialStore|undefined;#status:DashboardUploadStatus;#epoch=0;#operations=0;#stopping=false;#abort=new AbortController();
  #candidate:{id:string;token:string;owner:DashboardOwner;epoch:number;generation:string}|undefined;
  #recoveryRequested=false;#recoveryTimer:ReturnType<typeof setTimeout>|undefined;#recoveryAttempts=0;#revalidationFailures=0;
  #connectionVersion:string|undefined;
  constructor(private readonly origin:string|null,private readonly channel:ReleaseChannel,private readonly createStore:()=>UploadCredentialStore,private readonly publish:(status:DashboardUploadStatus)=>void){this.#status=initialDashboardUploadStatus(origin);}
  get status(){return structuredClone(this.#status);}
  get journalReadScope():JournalUploadScope|undefined {
    if(!this.origin||!this.#rpc||this.#stopping||this.#candidate||this.#operations>0||!this.#connectionVersion||!this.#status.owner||!['connected','paused'].includes(this.#status.state))return;
    return {owner:structuredClone(this.#status.owner),connectionVersion:this.#connectionVersion,documentEpoch:this.#epoch,utilityGeneration:this.#rpc.generation};
  }
  #emit(){this.publish(this.status);}
  #error(error:DashboardUploadError){const owner=['verifying','confirmation-required','connecting'].includes(this.#status.state)?null:this.#status.owner;this.#status={...this.#status,owner,state:this.origin?'paused':'unavailable',candidateId:null,error};this.#emit();return this.status;}
  async #call(command:Parameters<UploadRpc['call']>[0]):Promise<UploadServiceValue>{const rpc=this.#rpc;if(!rpc)throw Error('RETIRED');const answer=await rpc.call(command);if(this.#rpc!==rpc||this.#stopping)throw Error('RETIRED');if(!answer.ok)throw Error(answer.error);return answer.value;}
  #credentials(){return this.#store??=this.createStore();}
  #activated(status:unknown,owner:DashboardOwner){if(!isDashboardUploadStatus(status)||status.origin!==this.origin||!status.owner||!sameDashboardOwner(status.owner,owner)||!['connected','paused'].includes(status.state)||status.candidateId!==null)throw Error('RECONCILIATION');this.#status=structuredClone(status);this.#emit();}
  #current(epoch:number,rpc:UploadRpc){if(this.#stopping||epoch!==this.#epoch||this.#rpc!==rpc||this.#abort.signal.aborted)throw Error('RETIRED');}
  async attach(rpc:UploadRpc):Promise<void>{this.#clearRecovery();this.#rpc?.retire();this.#rpc=rpc;this.#retireCandidate();if(!this.origin||this.#stopping)return;const epoch=this.#epoch,authority={committed:false};this.#operations++;try{await this.#recover(authority);}catch(error){this.#recoveryFailure(error,rpc,epoch,authority.committed);}finally{this.#operations--;this.#drainRecovery();}}
  detach():void {this.#clearRecovery();this.#rpc?.retire();this.#rpc=undefined;this.#retireCandidate();if(this.origin&&!this.#stopping)this.#error('RETIRED');}
  documentChanged():void {this.#clearRecovery();this.#retireCandidate();if(!this.origin||this.#stopping)return;this.#rpc?.cancel?.();if(this.#status.state==='confirmation-required'||this.#status.state==='verifying'){this.#status={...this.#status,state:'disconnected',owner:null,candidateId:null,error:null};this.#emit();}this.#requestRecovery();}
  #retireCandidate(){this.#connectionVersion=undefined;this.#epoch++;this.#abort.abort();this.#abort=new AbortController();this.#candidate=undefined;this.#status.candidateId=null;}
  acceptStatus(status:DashboardUploadStatus):void {if(this.origin&&status.origin===this.origin&&!this.#candidate&&this.#operations===0&&!this.#stopping){this.#status=status;this.#emit();}}
  stop():void {this.#stopping=true;this.#clearRecovery();this.#retireCandidate();this.#status.state='stopping';this.#emit();this.#rpc?.retire();this.#rpc=undefined;}
  #clearRecovery(){clearTimeout(this.#recoveryTimer);this.#recoveryTimer=undefined;this.#recoveryRequested=false;this.#recoveryAttempts=0;this.#revalidationFailures=0;}
  #recoveryFailure(error:unknown,rpc:UploadRpc,epoch:number,committed:boolean){
    if(this.#rpc!==rpc||epoch!==this.#epoch||this.#stopping)return;
    const code=this.#fixed(error);this.#error(code);
    const busy=code==='BUSY'&&this.#recoveryAttempts++<60,transient=committed&&(code==='NETWORK'||code==='TIMEOUT');
    if(busy||transient){this.#recoveryRequested=true;const delay=busy?1000:Math.max(250,uploadRetryDelay(++this.#revalidationFailures,null,Date.now()));this.#recoveryTimer=setTimeout(()=>{this.#recoveryTimer=undefined;this.#drainRecovery();},delay);this.#recoveryTimer.unref?.();}
  }
  #requestRecovery(){if(!this.origin||!this.#rpc||this.#stopping)return;this.#recoveryRequested=true;this.#drainRecovery();}
  #drainRecovery(){
    if(!this.#recoveryRequested||this.#recoveryTimer||this.#operations>0||!this.#rpc||this.#stopping)return;
    this.#recoveryRequested=false;this.#operations++;const rpc=this.#rpc,epoch=this.#epoch,authority={committed:false};
    void this.#recover(authority).then(()=>{this.#recoveryAttempts=0;this.#revalidationFailures=0;},error=>this.#recoveryFailure(error,rpc,epoch,authority.committed)).finally(()=>{this.#operations--;this.#drainRecovery();});
  }
  async #recover(authority={committed:false}):Promise<void>{
    const rpc=this.#rpc!,epoch=this.#epoch;const store=this.#credentials(),intent=await store.readDisconnect();this.#current(epoch,rpc);
    this.#connectionVersion=undefined;
    const config=await this.#call({action:'configuration'});this.#current(epoch,rpc);if(config.kind!=='configuration')throw Error('RECONCILIATION');const c=config.configuration;this.#status={...this.#status,state:'paused',owner:null,candidateId:null};
    if(intent){if(intent.channel!==this.channel||intent.origin!==this.origin||c.registration&&c.registration.origin!==intent.origin)throw Error('RECONCILIATION');
      // The explicit intent authorizes only its exact connection version, including reconciliation repair.
      if(c.version===intent.expectedVersion){const disconnected=await this.#call({action:'disconnect',expectedVersion:intent.expectedVersion});if(disconnected.kind!=='connection'||disconnected.connection.status!=='disconnected')throw Error('RECONCILIATION');}
      else if(c.status!=='ready'||c.registration!==null||c.credentialGeneration!==null||c.runId!==null||BigInt(c.version)!==BigInt(intent.expectedVersion)+1n)throw Error('RECONCILIATION');
      await this.#removeCredentials(store);await store.clearDisconnect();this.#current(epoch,rpc);this.#status=initialDashboardUploadStatus(this.origin);this.#emit();return;
    }
    if(c.status!=='ready')throw Error('RECONCILIATION');
    if(!c.registration){this.#status=initialDashboardUploadStatus(this.origin);this.#emit();return;}
    if(c.registration.origin!==this.origin||!c.credentialGeneration)throw Error('RECONCILIATION');
    authority.committed=true;this.#status.owner={origin:c.registration.origin,accountId:c.registration.accountId,companyId:c.registration.companyId,identityEpoch:c.registration.identityEpoch};
    const context:CredentialContext={generation:c.credentialGeneration,channel:this.channel,owner:{origin:c.registration.origin,accountId:c.registration.accountId,companyId:c.registration.companyId,identityEpoch:c.registration.identityEpoch},registration:c.registration};const token=await store.load(context);this.#current(epoch,rpc);
    const activated=await this.#call({action:'activate',token,generation:context.generation,version:c.version});if(activated.kind!=='settled')throw Error('RECONCILIATION');this.#current(epoch,rpc);await store.activate(context);this.#current(epoch,rpc);this.#activated(activated.status,context.owner);this.#connectionVersion=c.version;
  }
  async #removeCredentials(store:UploadCredentialStore){for(let turns=0;turns<128;turns++){const result=await store.cleanup([],8);if(!result.more){await store.removeActivation();return;}}throw Error('CREDENTIAL_UNAVAILABLE');}
  async handle(action:UploadAction,args:unknown[]):Promise<DashboardUploadStatus>{
    if(!validUploadArguments(action,args))throw Error('INVALID_UPLOAD_REQUEST');if(action==='context')return this.status;if(!this.origin)return this.status;if(this.#stopping)return this.#error('RETIRED');if((action==='confirm'||action==='cancel')&&this.#candidate?.id!==args[0])return {...this.status,error:'RETIRED'};if(this.#operations>0)return {...this.status,error:'BUSY'};
    if(!this.#rpc)return this.#error('RETIRED');this.#clearRecovery();this.#operations++;const rpc=this.#rpc;let operationEpoch=this.#epoch;
    try{
      if(action==='verify'){
        this.#retireCandidate();const epoch=operationEpoch=this.#epoch,token=args[0] as string;this.#status={...initialDashboardUploadStatus(this.origin),state:'verifying'};this.#emit();
        const verified=await this.#call({action:'verify',token});this.#current(epoch,rpc);if(verified.kind!=='verified'||verified.owner.origin!==this.origin)throw Error('RECONCILIATION');
        this.#candidate={id:randomUUID(),token,owner:verified.owner,epoch,generation:rpc.generation};this.#status={...this.#status,state:'confirmation-required',owner:verified.owner,candidateId:this.#candidate.id};this.#emit();return this.status;
      }
      if(action==='cancel'){if(this.#candidate?.id!==args[0])throw Error('RETIRED');this.#retireCandidate();operationEpoch=this.#epoch;this.#rpc.cancel?.();await this.#recover();return this.status;}
      if(action==='disconnect'){
        this.#retireCandidate();operationEpoch=this.#epoch;const config=await this.#call({action:'configuration'});if(config.kind!=='configuration')throw Error('RECONCILIATION');const store=this.#credentials();
        await store.disconnectIntent({version:1,channel:this.channel,origin:this.origin,expectedVersion:config.configuration.version});
        const answer=await this.#call({action:'disconnect',expectedVersion:config.configuration.version});if(answer.kind!=='connection'||answer.connection.status!=='disconnected')throw Error('RECONCILIATION');
        await this.#removeCredentials(store);await store.clearDisconnect();this.#status=initialDashboardUploadStatus(this.origin);this.#emit();return this.status;
      }
      const candidate=this.#candidate;if(!candidate||candidate.id!==args[0]||candidate.generation!==rpc.generation)throw Error('RETIRED');this.#current(candidate.epoch,rpc);this.#status.state='connecting';this.#emit();
      const prepared=await this.#call({action:'prepare',token:candidate.token,owner:candidate.owner});this.#current(candidate.epoch,rpc);if(prepared.kind!=='prepared'||!sameDashboardOwner(prepared.owner,candidate.owner))throw Error('RECONCILIATION');
      const context:CredentialContext={generation:randomUUID(),channel:this.channel,owner:candidate.owner,registration:prepared.registration},store=this.#credentials();await store.save(context,candidate.token,this.#abort.signal);this.#current(candidate.epoch,rpc);
      const confirmed=await this.#call({action:'confirm',confirmationId:randomUUID(),registrationId:context.registration.registrationId,credentialGeneration:context.generation,expectedVersion:prepared.expectedVersion});
      // Never remove this generation on timeout/retirement: the confirm may have committed.
      if(confirmed.kind!=='connection'||confirmed.connection.status!=='confirmed')throw Error('RECONCILIATION');this.#current(candidate.epoch,rpc);await store.activate(context);this.#current(candidate.epoch,rpc);
      const active=await this.#call({action:'activate',token:candidate.token,generation:context.generation,version:confirmed.connection.version});if(active.kind!=='settled')throw Error('RECONCILIATION');this.#current(candidate.epoch,rpc);
      this.#candidate=undefined;this.#activated(active.status,context.owner);this.#connectionVersion=confirmed.connection.version;await store.cleanup([context.generation],8);return this.status;
    }catch(error){this.#candidate=undefined;if(['verify','confirm','disconnect'].includes(action))this.#recoveryRequested=true;if(this.#rpc!==rpc||operationEpoch!==this.#epoch)return {...this.status,candidateId:null,error:'RETIRED'};return this.#error(this.#fixed(error));}finally{this.#operations--;this.#drainRecovery();}
  }
  #fixed(error:unknown):DashboardUploadError {const code=error instanceof Error?error.message:'';return ['ENCRYPTION_UNAVAILABLE','CREDENTIAL_UNAVAILABLE','RETIRED','AUTHENTICATION','CONFIGURATION','RECONCILIATION','TIMEOUT','BUSY','NETWORK','UNSUPPORTED_CONTRACT','CANCELLED','STORAGE_UNAVAILABLE'].includes(code)?code as DashboardUploadError:'CREDENTIAL_UNAVAILABLE';}
}
