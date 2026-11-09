// Renderer-safe upload boundary. No private credentials, filesystem or service authority.
export const DASHBOARD_UPLOAD_ERRORS=['UNCONFIGURED','ENCRYPTION_UNAVAILABLE','CREDENTIAL_UNAVAILABLE','AUTHENTICATION','CONFIGURATION','RECONCILIATION','VALIDATION','NETWORK','TIMEOUT','BUSY','CANCELLED','RETIRED','STORAGE_UNAVAILABLE','UNSUPPORTED_CONTRACT'] as const;
export type DashboardUploadError=typeof DASHBOARD_UPLOAD_ERRORS[number];
export interface DashboardOwner {origin:string;accountId:string;companyId:string;identityEpoch:string}
export interface DashboardUploadStatus {
  state:'unavailable'|'disconnected'|'verifying'|'confirmation-required'|'connecting'|'connected'|'paused'|'stopping';
  origin:string|null;owner:DashboardOwner|null;candidateId:string|null;scope:'all-retained-game-trips';error:DashboardUploadError|null;
  progress:{enumeration:'calculating'|'scanning'|'complete'|'changing';distinctSources:number|null;deliveredSources:number|null;identityPendingSources:number;pendingSources:number;heldSources:number;queuedEvents:number;pressure:boolean;lastDurableUploadUtcMs:number|null};
}
export interface DashboardUploadBridge {
  getDashboardUploadContext():Promise<DashboardUploadStatus>;
  verifyDashboardUploadToken(token:string):Promise<DashboardUploadStatus>;
  confirmDashboardUpload(candidateId:string):Promise<DashboardUploadStatus>;
  cancelDashboardUpload(candidateId:string):Promise<DashboardUploadStatus>;
  disconnectDashboardUpload():Promise<DashboardUploadStatus>;
  subscribeDashboardUpload(listener:(status:DashboardUploadStatus)=>void):()=>void;
}
export const uploadRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);
type Check=(v:unknown)=>boolean;
export const uploadShape=(fields:Record<string,Check>):Check=>v=>uploadRecord(v)&&Object.keys(v).length===Object.keys(fields).length&&Object.entries(fields).every(([k,check])=>Object.hasOwn(v,k)&&check(v[k]));
export const uploadOne=(...values:unknown[]):Check=>v=>values.includes(v);
export const uploadNull=(check:Check):Check=>v=>v===null||check(v);
export const uploadSafe=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0;
export const uploadUuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
export const uploadText=(v:unknown):v is string=>typeof v==='string'&&new TextEncoder().encode(v).byteLength>0&&new TextEncoder().encode(v).byteLength<=128&&Array.from(v).every(c=>c.charCodeAt(0)>31&&c.charCodeAt(0)!==127);
export const dashboardOrigin=(v:unknown):v is string=>{if(!uploadText(v))return false;try{const u=new URL(v);return u.protocol==='https:'&&u.origin===v;}catch{return false;}};
export function isReleaseDashboardOrigin(value: unknown): value is string {
  if (!dashboardOrigin(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  return !(host === 'localhost' || host === '[::1]' || host === '0.0.0.0' || host.startsWith('127.') || host.endsWith('.localhost'));
}
export const isDashboardToken=(v:unknown):v is string=>typeof v==='string'&&v.length<=128&&/^vtc1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(v);
export const isDashboardOwner=uploadShape({origin:dashboardOrigin,accountId:uploadText,companyId:uploadText,identityEpoch:uploadText});
export const sameDashboardOwner=(a:DashboardOwner,b:DashboardOwner)=>a.origin===b.origin&&a.accountId===b.accountId&&a.companyId===b.companyId&&a.identityEpoch===b.identityEpoch;
export function isDashboardUploadStatus(v:unknown):v is DashboardUploadStatus {
  if(!uploadShape({state:uploadOne('unavailable','disconnected','verifying','confirmation-required','connecting','connected','paused','stopping'),origin:uploadNull(dashboardOrigin),owner:uploadNull(isDashboardOwner),candidateId:uploadNull(uploadUuid),scope:uploadOne('all-retained-game-trips'),error:uploadNull(uploadOne(...DASHBOARD_UPLOAD_ERRORS)),
    progress:uploadShape({enumeration:uploadOne('calculating','scanning','complete','changing'),distinctSources:uploadNull(uploadSafe),deliveredSources:uploadNull(uploadSafe),identityPendingSources:uploadSafe,pendingSources:uploadSafe,heldSources:uploadSafe,queuedEvents:v=>uploadSafe(v)&&v<=10000,pressure:uploadOne(true,false),lastDurableUploadUtcMs:uploadNull(uploadSafe)})})(v))return false;
  const status=v as DashboardUploadStatus;
  if(status.owner&&status.owner.origin!==status.origin||status.candidateId!==null&&!['confirmation-required','connecting'].includes(status.state)||status.state==='confirmation-required'&&(!status.candidateId||!status.owner)||status.state==='connected'&&!status.owner)return false;
  if(status.progress.enumeration==='complete'&&(status.progress.distinctSources===null||status.progress.deliveredSources===null||status.progress.deliveredSources>status.progress.distinctSources))return false;
  return true;
}
export function initialDashboardUploadStatus(origin:string|null):DashboardUploadStatus {return {state:origin?'disconnected':'unavailable',origin,owner:null,candidateId:null,scope:'all-retained-game-trips',error:origin?null:'UNCONFIGURED',progress:{enumeration:'calculating',distinctSources:null,deliveredSources:null,identityPendingSources:0,pendingSources:0,heldSources:0,queuedEvents:0,pressure:false,lastDurableUploadUtcMs:null}};}
