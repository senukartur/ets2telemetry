// Main/utility only. Never exported by packages/contracts or exposed to a renderer.
import {isDashboardOwner,isDashboardToken,sameDashboardOwner,uploadShape,uploadOne,uploadUuid,uploadNull,DASHBOARD_UPLOAD_ERRORS,type DashboardOwner,type DashboardUploadError} from '../../../../packages/contracts/src/dashboard-upload';
import {isUploadSyncResult,registrationCheck,decimal,type UploadRegistration,type UploadActiveConfiguration,type UploadConnectionResult} from '../../../../packages/storage/src/upload-sync';
import type {UploadLimits} from './control-response';
export type UploadServiceCommand=
 |{action:'configuration'}|{action:'verify';token:string}|{action:'prepare';token:string;owner:DashboardOwner}
 |{action:'confirm';confirmationId:string;registrationId:string;credentialGeneration:string;expectedVersion:string}
 |{action:'activate';token:string;generation:string;version:string}
 |{action:'disconnect';expectedVersion:string}|{action:'suspend'};
export type UploadServiceValue={kind:'configuration';configuration:UploadActiveConfiguration}|{kind:'verified';owner:DashboardOwner;limits:UploadLimits}|{kind:'prepared';owner:DashboardOwner;registration:UploadRegistration;expectedVersion:string}|{kind:'connection';connection:UploadConnectionResult}|{kind:'settled'};
export type UploadServiceReply={ok:true;value:UploadServiceValue}|{ok:false;error:DashboardUploadError};
export interface UploadServiceRequest {type:'dashboard-upload:request';id:string;generation:string;command:UploadServiceCommand}
export interface UploadServiceAnswer {type:'dashboard-upload:answer';id:string;generation:string;reply:UploadServiceReply}
export const isUploadServiceCancel=uploadShape({type:uploadOne('dashboard-upload:cancel'),generation:uploadUuid});
const limits=uploadShape({maxEventBytes:uploadOne(65536),maxDepth:uploadOne(16),eventsPerMinute:v=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=60,burst:v=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=10});
export function isUploadServiceCommand(v:unknown):v is UploadServiceCommand {
  return uploadShape({action:uploadOne('configuration','suspend')})(v)||uploadShape({action:uploadOne('verify'),token:isDashboardToken})(v)||uploadShape({action:uploadOne('prepare'),token:isDashboardToken,owner:isDashboardOwner})(v)||uploadShape({action:uploadOne('confirm'),confirmationId:uploadUuid,registrationId:uploadUuid,credentialGeneration:uploadUuid,expectedVersion:decimal})(v)||uploadShape({action:uploadOne('activate'),token:isDashboardToken,generation:uploadUuid,version:decimal})(v)||uploadShape({action:uploadOne('disconnect'),expectedVersion:decimal})(v);
}
export function isUploadServiceRequest(v:unknown):v is UploadServiceRequest{return uploadShape({type:uploadOne('dashboard-upload:request'),id:uploadUuid,generation:uploadUuid,command:isUploadServiceCommand})(v);}
export function isUploadServiceReply(v:unknown):v is UploadServiceReply {
  const value=(x:unknown)=>uploadShape({kind:uploadOne('configuration'),configuration:y=>isUploadSyncResult({name:'getUploadConfiguration'},y)})(x)||uploadShape({kind:uploadOne('verified'),owner:isDashboardOwner,limits})(x)||uploadShape({kind:uploadOne('prepared'),owner:isDashboardOwner,registration:registrationCheck,expectedVersion:decimal})(x)||uploadShape({kind:uploadOne('connection'),connection:uploadShape({status:uploadOne('confirmed','disconnected','stale','reconciliation-required'),version:decimal,runId:uploadNull(uploadUuid)})})(x)||uploadShape({kind:uploadOne('settled')})(x);
  return uploadShape({ok:uploadOne(true),value})(v)||uploadShape({ok:uploadOne(false),error:uploadOne(...DASHBOARD_UPLOAD_ERRORS)})(v);
}
export function isUploadServiceAnswer(v:unknown):v is UploadServiceAnswer{return uploadShape({type:uploadOne('dashboard-upload:answer'),id:uploadUuid,generation:uploadUuid,reply:isUploadServiceReply})(v);}
export const replyKind=(command:UploadServiceCommand):UploadServiceValue['kind']=>command.action==='configuration'?'configuration':command.action==='verify'?'verified':command.action==='prepare'?'prepared':command.action==='confirm'||command.action==='disconnect'?'connection':'settled';
export function uploadReplyMatches(command:UploadServiceCommand,reply:UploadServiceReply):boolean {
  if(!reply.ok)return true;const value=reply.value;if(value.kind!==replyKind(command))return false;
  if(command.action==='prepare'&&value.kind==='prepared')return sameDashboardOwner(command.owner,value.owner)&&sameDashboardOwner(value.owner,value.registration);
  if(command.action==='confirm'&&value.kind==='connection')return value.connection.status==='confirmed'?value.connection.runId===command.confirmationId&&value.connection.version===String(BigInt(command.expectedVersion)+1n):['stale','reconciliation-required'].includes(value.connection.status);
  if(command.action==='disconnect'&&value.kind==='connection')return value.connection.runId===null&&(value.connection.status==='stale'||value.connection.status==='disconnected'&&value.connection.version===String(BigInt(command.expectedVersion)+1n));
  return true;
}
