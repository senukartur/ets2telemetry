import {strictJson} from '../../../../packages/contracts/src/protocol-v0';
import {uploadShape,uploadOne,uploadText,uploadSafe,uploadUuid,uploadRecord,type DashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
export interface UploadLimits {maxEventBytes:number;maxDepth:number;eventsPerMinute:number;burst:number}
export interface UploadConnection {contract:{major:1;minor:0|1};accountId:string;companyId:string;identityEpoch:string;limits:UploadLimits}
export interface UploadServerRegistration {contract:{major:1;minor:0|1};installationId:string;bindingId:string;identityEpoch:string}
const contract=uploadShape({major:uploadOne(1),minor:uploadOne(0,1)});
// The Dashboard stores identityEpoch as an unsigned integer and sends a JSON number; the owner key keeps its decimal text.
const identityEpoch=(v:unknown):string|undefined=>uploadSafe(v)?String(v):uploadText(v)?v:undefined;
export function jsonBody(body:Uint8Array,limit:number):unknown {if(body.byteLength>limit)throw Error('INVALID_UPLOAD_RESPONSE');return strictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(body));}
export function connectionResponse(body:Uint8Array):UploadConnection|undefined {
  let v:unknown;try{v=jsonBody(body,16384);}catch{return undefined;}
  if(!uploadShape({contract,accountId:uploadText,companyId:uploadText,identityEpoch:v=>identityEpoch(v)!==undefined,limits:uploadShape({maxEventBytes:v=>uploadSafe(v)&&v>0,maxDepth:v=>uploadSafe(v)&&v>0,eventsPerMinute:v=>uploadSafe(v)&&v>0,burst:v=>uploadSafe(v)&&v>0})})(v))return undefined;
  const value=v as UploadConnection;if(value.limits.maxEventBytes<65536||value.limits.maxDepth<16)return undefined;return {...value,identityEpoch:identityEpoch(value.identityEpoch)!,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:Math.min(60,value.limits.eventsPerMinute),burst:Math.min(10,value.limits.burst)}};
}
export function registrationResponse(body:Uint8Array,owner:DashboardOwner):UploadServerRegistration|undefined {
  let v:unknown;try{v=jsonBody(body,16384);}catch{return undefined;}
  return uploadShape({contract,installationId:uploadUuid,bindingId:uploadUuid,identityEpoch:value=>identityEpoch(value)===owner.identityEpoch})(v)?{...v as UploadServerRegistration,identityEpoch:owner.identityEpoch}:undefined;
}
/**
 * The event minor to freeze new events with: the highest of 1.2 and 1.1 that the connection response header
 * `VTC-Telemetry-Event-Versions` lists, else 0. A header with any token that is not a `1.<minor>` version is not a
 * recognized advertisement, so it selects 0 as an absent header does.
 */
export function advertisedEventMinor(header:string|undefined):0|1|2 {
  if(header===undefined||header.length>128)return 0;
  const tokens=header.split(',').map(token=>token.trim());
  if(!tokens.every(token=>/^1\.(0|[1-9][0-9]{0,4})$/.test(token)))return 0;
  return tokens.includes('1.2')?2:tokens.includes('1.1')?1:0;
}
export type UploadFailure='authentication'|'configuration'|'reconciliation'|'validation'|'retry';
export function responseFailure(status:number,body:Uint8Array):UploadFailure {
  let code:unknown;try{const v=jsonBody(body,4096);if(uploadRecord(v)&&Object.keys(v).length===2&&v.contract&&uploadShape({major:uploadOne(1),minor:uploadOne(0)})(v.contract))code=v.code;}catch{/* Never retain raw server text. */}
  if(status===401||status===403)return 'authentication';if(status===404||status===405||status===426)return 'configuration';if(status===409)return 'reconciliation';
  if(status===400||status===413||status===415||status===422)return 'validation';
  if(code==='BINDING_MISMATCH'||code==='IDENTITY_CONFLICT')return 'reconciliation';return 'retry';
}
