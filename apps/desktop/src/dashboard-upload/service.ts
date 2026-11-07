import {randomUUID} from 'node:crypto';
import {sameDashboardOwner,type DashboardOwner,type DashboardUploadStatus,type DashboardUploadError} from '../../../../packages/contracts/src/dashboard-upload';
import {UploadScheduler,stored,type UploadStorage,type UploadClock} from './scheduler';
import {connectionResponse,registrationResponse,responseFailure,type UploadLimits} from './control-response';
import type {UploadTransport,UploadHttpResult} from './http';
import type {UploadServiceCommand,UploadServiceReply} from './service-contract';
const failure=(error:DashboardUploadError):UploadServiceReply=>({ok:false,error});
function controlFailure(result:UploadHttpResult):DashboardUploadError {
  if(!result.ok)return result.statusCode===401||result.statusCode===403?'AUTHENTICATION':result.code==='TIMEOUT'?'TIMEOUT':result.code==='ABORTED'?'CANCELLED':result.code==='NETWORK'?'NETWORK':'CONFIGURATION';
  const kind=responseFailure(result.statusCode,result.body);return kind==='authentication'?'AUTHENTICATION':kind==='reconciliation'?'RECONCILIATION':kind==='retry'?'NETWORK':'CONFIGURATION';
}
/** Trusted utility composition; this object is never constructed when the channel origin is absent. */
export class DashboardUploadService {
  readonly scheduler:UploadScheduler;#control=false;#stopped=false;#startup:Promise<void>;#abort=new AbortController();#controlEpoch=0;
  constructor(private readonly db:UploadStorage,private readonly http:UploadTransport,private readonly origin:string,producerVersion:string,publish:(status:DashboardUploadStatus)=>void,time?:UploadClock){this.scheduler=new UploadScheduler(db,http,origin,producerVersion,publish,time);this.#startup=stored(db.getUploadConfiguration()).then(async configuration=>{if(configuration.purpose!=='history')throw Error('RECONCILIATION');await stored(db.recoverUploadAttempt({startup:true}));});this.#startup.catch(()=>undefined);}
  async #verify(token:string):Promise<{owner:DashboardOwner;limits:UploadLimits}|DashboardUploadError>{
    const result=await this.http.request('connection',token,undefined,this.#abort.signal);if(!result.ok||result.statusCode!==200)return controlFailure(result);
    const value=connectionResponse(result.body);return value?{owner:{origin:this.origin,accountId:value.accountId,companyId:value.companyId,identityEpoch:value.identityEpoch},limits:value.limits}:'UNSUPPORTED_CONTRACT';
  }
  async execute(command:UploadServiceCommand):Promise<UploadServiceReply>{
    if(this.#stopped)return failure('RETIRED');if(this.#control)return failure('BUSY');this.#control=true;const epoch=this.#controlEpoch;
    try{await this.#startup;if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');await this.scheduler.suspend();if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');this.#abort=new AbortController();
      const configuration=await stored(this.db.getUploadConfiguration());
      if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');
      if(configuration.purpose!=='history')return failure('RECONCILIATION');
      if(command.action==='suspend')return {ok:true,value:{kind:'settled'}};
      if(command.action==='configuration')return {ok:true,value:{kind:'configuration',configuration}};
      if(command.action==='disconnect'){const connection=await stored(this.db.disconnectUploadOwner({expectedVersion:command.expectedVersion}));if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');return {ok:true,value:{kind:'connection',connection}};}
      if(configuration.status!=='ready')return failure('RECONCILIATION');
      if(command.action==='confirm'){const connection=await stored(this.db.confirmUploadOwner({confirmationId:command.confirmationId,registrationId:command.registrationId,credentialGeneration:command.credentialGeneration,expectedVersion:command.expectedVersion}));return {ok:true,value:{kind:'connection',connection}};}
      const verified=await this.#verify(command.token);if(typeof verified==='string')return failure(verified);if(this.#stopped||this.#abort.signal.aborted||epoch!==this.#controlEpoch)return failure('RETIRED');
      if(command.action==='verify')return {ok:true,value:{kind:'verified',...verified}};
      if(command.action==='activate'){
        const reg=configuration.registration;if(!reg||configuration.version!==command.version||configuration.credentialGeneration!==command.generation||!sameDashboardOwner(verified.owner,reg))return failure('RECONCILIATION');
        const registered=await this.http.request('installations',command.token,new TextEncoder().encode(JSON.stringify({contract:{major:1,minor:0},clientInstallationId:reg.clientInstallationId})),this.#abort.signal);
        if(!registered.ok||registered.statusCode!==200&&registered.statusCode!==201)return failure(controlFailure(registered));
        const response=registrationResponse(registered.body,verified.owner);if(!response||response.installationId!==reg.installationId||response.bindingId!==reg.bindingId)return failure('RECONCILIATION');
        if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');await this.scheduler.activate(configuration,command.token,verified.limits);if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');return {ok:true,value:{kind:'settled',status:this.scheduler.status}};
      }
      if(!sameDashboardOwner(command.owner,verified.owner))return failure('RECONCILIATION');
      const installation=await stored(this.db.ensureUploadInstallation());if(installation.status!=='ready'||!installation.clientInstallationId)return failure('RECONCILIATION');
      if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');
      const registered=await this.http.request('installations',command.token,new TextEncoder().encode(JSON.stringify({contract:{major:1,minor:0},clientInstallationId:installation.clientInstallationId})),this.#abort.signal);
      if(!registered.ok||registered.statusCode!==200&&registered.statusCode!==201)return failure(controlFailure(registered));
      const response=registrationResponse(registered.body,verified.owner);if(!response)return failure('UNSUPPORTED_CONTRACT');
      if(this.#stopped||epoch!==this.#controlEpoch)return failure('RETIRED');
      const registration:import('../../../../packages/storage/src/upload-sync').UploadRegistration={registrationId:randomUUID(),clientInstallationId:installation.clientInstallationId,...verified.owner,installationId:response.installationId,bindingId:response.bindingId};const recorded=await stored(this.db.recordUploadRegistration(registration));
      if(recorded.status!=='recorded')return failure('RECONCILIATION');registration.registrationId=recorded.registrationId;
      return {ok:true,value:{kind:'prepared',owner:verified.owner,registration,expectedVersion:configuration.version}};
    }catch{return failure(this.#stopped||epoch!==this.#controlEpoch?'RETIRED':'STORAGE_UNAVAILABLE');}finally{this.#control=false;}
  }
  stop():Promise<void>{this.#stopped=true;this.#abort.abort();this.http.abort();return this.scheduler.stop().finally(()=>this.http.close());}
  cancel():void {this.#controlEpoch++;this.#abort.abort();this.http.abort();void this.scheduler.suspend().catch(()=>undefined);}
}
