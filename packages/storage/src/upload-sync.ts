// Private storage/service contract. No credentials, renderer authority or network operations.
import {MAX_UPLOAD_PROJECTION_PINS,isUploadUuid} from './upload-projection';

export const UPLOAD_MAX_EVENTS=10_000,UPLOAD_MAX_BYTES=64*1024*1024;
export type Check=(value:unknown)=>boolean;
export const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object' && value!==null && !Array.isArray(value);
export const shape=(fields:Record<string,Check>):Check=>value=>record(value) && Object.keys(value).length===Object.keys(fields).length && Object.entries(fields).every(([key,check])=>Object.hasOwn(value,key)&&check(value[key]));
export const one=(...values:unknown[]):Check=>value=>values.includes(value);
export const nullable=(check:Check):Check=>value=>value===null||check(value);
export const safe=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0;
export const decimal=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value)&&BigInt(value)<=9_223_372_036_854_775_807n;
export const text=(value:unknown):value is string=>typeof value==='string'&&Buffer.byteLength(value)>0&&Buffer.byteLength(value)<=128&&Array.from(value).every(c=>c.charCodeAt(0)>31&&c.charCodeAt(0)!==127);
const bounded:Check=value=>safe(value)&&value<=100;
const origin:Check=value=>{if(!text(value))return false;try{const url=new URL(value);return url.protocol==='https:'&&url.origin===value;}catch{return false;}};
const payload:Check=value=>value instanceof Uint8Array&&value.byteLength>0&&value.byteLength<=65_536;
export interface UploadRegistration {registrationId:string;clientInstallationId:string;origin:string;accountId:string;companyId:string;identityEpoch:string;installationId:string;bindingId:string}
export interface UploadConfirmation {confirmationId:string;registrationId:string;credentialGeneration:string;expectedVersion:string}
export interface UploadInstallation {status:'ready'|'reconciliation-required';clientInstallationId:string|null}
export interface UploadRegistrationResult {status:'recorded'|'reconciliation-required';registrationId:string}
export interface UploadConnectionResult {status:'confirmed'|'disconnected'|'stale'|'reconciliation-required';version:string;runId:string|null}
export interface UploadScanProgress {runId:string;phase:'legacy'|'candidates'|'complete'|'pressure';examined:number;cursor:{legacy:string;ordinal:string}}
export interface UploadDiscoveryPage {after:string;next:string;examined:number;items:{tripUuid:string;materialVersion:string;workId:string|null}[]}
export type UploadWorkState='preparing'|'folding'|'complete'|'frozen'|'equal'|'held'|'stale'|'pressure'|'released';
export type UploadWorkReason='source-ineligible'|'identity-pending'|'unbound'|'reconciliation-required'|'projection-invalid'|'material-changed'|'revision-exhausted'|'queue-pressure';
export interface UploadWork {workId:string;status:UploadWorkState;examined:number;eventId:string|null;reason:UploadWorkReason|null}
export interface UploadAttemptResult {status:'claimed'|'empty'|'paused'|'busy'|'reconciliation-required'|'recorded'|'recovered'|'delivered'|'stale';attemptId:string|null;eventId:string|null;registrationId:string|null;registration:UploadRegistration|null;payload:Uint8Array|null}
export interface UploadReceiptResult {status:'delivered'|'duplicate'|'reconciliation-required'|'invalid-response';eventId:string;receiptId:string|null}
export interface UploadCleanup {examined:number;reclaimed:number;events:number;bytes:number}
export interface UploadStoreStatus {registrationId:string;version:string;active:boolean;paused:'authentication'|'configuration'|'reconciliation'|null;
  discoveryAfter:string;identityPendingSources:number;pendingSources:number;heldSources:number;queuedEvents:number;queuedBytes:number;deliveredEvents:number;pressure:boolean}
export interface UploadActiveConfiguration {status:'ready'|'reconciliation-required';purpose:'history'|'synthetic'|'replay';version:string;registration:UploadRegistration|null;credentialGeneration:string|null;runId:string|null}
export interface UploadRunPage {after:string|null;next:string|null;examined:number;items:UploadScanProgress[]}
export interface UploadSourceState {tripUuid:string;state:'identity-pending'|'held'|'pending'|'queued'|'delivered';latestRevision:number;lastReceiptUtcMs:number|null}
export interface UploadSourcePage {phase:'sources'|'receipts';after:string|null;next:string|null;examined:number;sources:UploadSourceState[];receipts:{eventId:string;firstReceivedUtcMs:number}[]}
export interface UploadSchedulingHints {status:'ready'|'reconciliation-required';registrationId:string;version:string;credentialGeneration:string|null;retryAtMs:number|null;failureStreak:number;retryEventId:string|null;paused:'authentication'|'configuration'|'reconciliation'|null;held:'validation'|'reconciliation'|null}
const receiptCursor:Check=v=>typeof v==='string'&&v.length<=64&&/^r:(0|[1-9][0-9]{0,15}):[0-9a-f-]{36}$/.test(v)&&safe(Number(v.split(':')[1]))&&isUploadUuid(v.split(':')[2]);
const receiptCursorAfter=(next:string,after:string)=>{const n=next.split(':'),a=after.split(':');return BigInt(n[1])>BigInt(a[1])||n[1]===a[1]&&n[2]>a[2];};
export interface RetainedUploadMaterializations {examined:number;unmanagedPins:number;items:{workId:string;registrationId:string;state:'preparing'|'folding'|'complete'|'frozen'|'equal'|'held'|'stale'}[]}
export interface UploadSyncCommands {
  readRetainedUploadMaterializations:{args:{input:Record<never,never>};value:RetainedUploadMaterializations};
  getUploadConfiguration:{args:Record<never,never>;value:UploadActiveConfiguration};
  pageUploadScanRuns:{args:{input:{registrationId:string;after:string|null;limit:number}};value:UploadRunPage};
  pageUploadSources:{args:{input:{registrationId:string;phase:'sources'|'receipts';after:string|null;limit:number}};value:UploadSourcePage};
  getUploadSchedulingHints:{args:{input:{registrationId:string}};value:UploadSchedulingHints};
  ensureUploadInstallation:{args:Record<never,never>;value:UploadInstallation};
  recordUploadRegistration:{args:{input:UploadRegistration};value:UploadRegistrationResult};
  confirmUploadOwner:{args:{input:UploadConfirmation};value:UploadConnectionResult};
  disconnectUploadOwner:{args:{input:{expectedVersion:string}};value:UploadConnectionResult};
  getUploadStoreStatus:{args:{input:{registrationId:string}};value:UploadStoreStatus};
  advanceUploadScan:{args:{input:{runId:string;registrationId:string}};value:UploadScanProgress};
  pageUploadDiscovery:{args:{input:{registrationId:string;after:string;limit:number}};value:UploadDiscoveryPage};
  beginUploadMaterialization:{args:{input:{workId:string;tripUuid:string;registrationId:string}};value:UploadWork};
  advanceUploadMaterialization:{args:{input:{workId:string}};value:UploadWork};
  freezeUploadMaterialization:{args:{input:{workId:string;producerVersion:string;createdUtcMs:number;contractMinor?:0|1|2}};value:UploadWork};
  releaseUploadMaterialization:{args:{input:{workId:string}};value:UploadWork};
  claimUploadAttempt:{args:{input:{attemptId:string;registrationId:string;expectedVersion:string;mode:'live'|'backfill'|'any';nowMs:number}};value:UploadAttemptResult};
  recordUploadAttemptOutcome:{args:{input:{attemptId:string;kind:'retry'|'authentication'|'configuration'|'reconciliation'|'validation';retryAtMs:number;nowMs:number}};value:UploadAttemptResult};
  recoverUploadAttempt:{args:{input:{attemptId:string}|{startup:true}};value:UploadAttemptResult};
  commitUploadReceipt:{args:{input:{attemptId:string;statusCode:number;body:Uint8Array}};value:UploadReceiptResult};
  reclaimUploadPayloads:{args:{input:{limit:number}};value:UploadCleanup};
}
export type UploadSyncName=keyof UploadSyncCommands;
export type UploadSyncCommand={[K in UploadSyncName]:{name:K}&UploadSyncCommands[K]['args']}[UploadSyncName];
export const registrationCheck=shape({registrationId:isUploadUuid,clientInstallationId:isUploadUuid,origin,accountId:text,companyId:text,identityEpoch:text,installationId:isUploadUuid,bindingId:isUploadUuid});
const requestChecks:Record<UploadSyncName,Check>={
  readRetainedUploadMaterializations:shape({}),
  ensureUploadInstallation:shape({name:one('ensureUploadInstallation')}),getUploadConfiguration:shape({name:one('getUploadConfiguration')}),
  pageUploadScanRuns:shape({registrationId:isUploadUuid,after:nullable(isUploadUuid),limit:v=>bounded(v)&&v!==0}),
  pageUploadSources:v=>shape({registrationId:isUploadUuid,phase:one('sources','receipts'),after:nullable(v=>decimal(v)||receiptCursor(v)),limit:v=>bounded(v)&&v!==0})(v)&&record(v)&&(v.after===null||(v.phase==='sources'?decimal(v.after):receiptCursor(v.after))),
  getUploadSchedulingHints:shape({registrationId:isUploadUuid}),
  recordUploadRegistration:registrationCheck,
  confirmUploadOwner:shape({confirmationId:isUploadUuid,registrationId:isUploadUuid,credentialGeneration:text,expectedVersion:decimal}),
  disconnectUploadOwner:shape({expectedVersion:decimal}),getUploadStoreStatus:shape({registrationId:isUploadUuid}),
  advanceUploadScan:shape({runId:isUploadUuid,registrationId:isUploadUuid}),
  pageUploadDiscovery:shape({registrationId:isUploadUuid,after:decimal,limit:v=>bounded(v)&&v!==0}),
  beginUploadMaterialization:shape({workId:isUploadUuid,tripUuid:isUploadUuid,registrationId:isUploadUuid}),
  advanceUploadMaterialization:shape({workId:isUploadUuid}),releaseUploadMaterialization:shape({workId:isUploadUuid}),
  freezeUploadMaterialization:v=>{
    if(!record(v))return false;
    const {contractMinor,...rest}=v;
    if(contractMinor!==undefined&&!one(0,1,2)(contractMinor))return false;
    return shape({workId:isUploadUuid,producerVersion:v=>text(v)&&Buffer.byteLength(v)<=64,createdUtcMs:safe})(rest);
  },
  claimUploadAttempt:shape({attemptId:isUploadUuid,registrationId:isUploadUuid,expectedVersion:decimal,mode:one('live','backfill','any'),nowMs:safe}),
  recordUploadAttemptOutcome:shape({attemptId:isUploadUuid,kind:one('retry','authentication','configuration','reconciliation','validation'),retryAtMs:safe,nowMs:safe}),
  recoverUploadAttempt:v=>shape({attemptId:isUploadUuid})(v)||shape({startup:one(true)})(v),commitUploadReceipt:shape({attemptId:isUploadUuid,statusCode:v=>safe(v)&&v<=599,body:v=>v instanceof Uint8Array&&v.byteLength<=4096}),
  reclaimUploadPayloads:shape({limit:v=>bounded(v)&&v!==0})
};
export const UPLOAD_SYNC_NAMES=Object.freeze(Object.keys(requestChecks) as UploadSyncName[]);
export const isUploadSyncName=(value:string):value is UploadSyncName=>Object.hasOwn(requestChecks,value);
export function isUploadSyncRequest(command:unknown):command is UploadSyncCommand {
  if(!record(command)||typeof command.name!=='string'||!isUploadSyncName(command.name))return false;
  return command.name==='ensureUploadInstallation'||command.name==='getUploadConfiguration'?requestChecks[command.name](command):shape({name:one(command.name),input:requestChecks[command.name]})(command);
}
const work=shape({workId:isUploadUuid,status:one('preparing','folding','complete','frozen','equal','held','stale','pressure','released'),examined:bounded,eventId:nullable(isUploadUuid),reason:nullable(one('source-ineligible','identity-pending','unbound','reconciliation-required','projection-invalid','material-changed','revision-exhausted','queue-pressure'))});
const attempt=shape({status:one('claimed','empty','paused','busy','reconciliation-required','recorded','recovered','delivered','stale'),attemptId:nullable(isUploadUuid),eventId:nullable(isUploadUuid),registrationId:nullable(isUploadUuid),registration:nullable(registrationCheck),payload:nullable(payload)});
const resultChecks:Record<UploadSyncName,Check>={
  readRetainedUploadMaterializations:shape({examined:v=>safe(v)&&v<=MAX_UPLOAD_PROJECTION_PINS,unmanagedPins:v=>safe(v)&&v<=MAX_UPLOAD_PROJECTION_PINS,items:v=>Array.isArray(v)&&v.length<=MAX_UPLOAD_PROJECTION_PINS&&v.every(shape({workId:isUploadUuid,registrationId:isUploadUuid,state:one('preparing','folding','complete','frozen','equal','held','stale')}))}),
  getUploadConfiguration:shape({status:one('ready','reconciliation-required'),purpose:one('history','synthetic','replay'),version:decimal,registration:nullable(registrationCheck),credentialGeneration:nullable(text),runId:nullable(isUploadUuid)}),
  pageUploadScanRuns:shape({after:nullable(isUploadUuid),next:nullable(isUploadUuid),examined:bounded,items:v=>Array.isArray(v)&&v.length<=100&&v.every(shape({runId:isUploadUuid,phase:one('legacy','candidates','complete','pressure'),examined:bounded,cursor:shape({legacy:decimal,ordinal:decimal})}))}),
  pageUploadSources:shape({phase:one('sources','receipts'),after:nullable(v=>decimal(v)||receiptCursor(v)),next:nullable(v=>decimal(v)||receiptCursor(v)),examined:bounded,sources:v=>Array.isArray(v)&&v.length<=100&&v.every(shape({tripUuid:isUploadUuid,state:one('identity-pending','held','pending','queued','delivered'),latestRevision:safe,lastReceiptUtcMs:nullable(safe)})),receipts:v=>Array.isArray(v)&&v.length<=100&&v.every(shape({eventId:isUploadUuid,firstReceivedUtcMs:safe}))}),
  getUploadSchedulingHints:shape({status:one('ready','reconciliation-required'),registrationId:isUploadUuid,version:decimal,credentialGeneration:nullable(text),retryAtMs:nullable(safe),failureStreak:v=>safe(v)&&v<=9,retryEventId:nullable(isUploadUuid),paused:nullable(one('authentication','configuration','reconciliation')),held:nullable(one('validation','reconciliation'))}),
  ensureUploadInstallation:shape({status:one('ready','reconciliation-required'),clientInstallationId:nullable(isUploadUuid)}),
  recordUploadRegistration:shape({status:one('recorded','reconciliation-required'),registrationId:isUploadUuid}),
  confirmUploadOwner:shape({status:one('confirmed','stale','reconciliation-required'),version:decimal,runId:nullable(isUploadUuid)}),
  disconnectUploadOwner:shape({status:one('disconnected','stale'),version:decimal,runId:nullable(isUploadUuid)}),
  getUploadStoreStatus:shape({registrationId:isUploadUuid,version:decimal,active:one(true,false),paused:nullable(one('authentication','configuration','reconciliation')),
    discoveryAfter:decimal,identityPendingSources:safe,pendingSources:safe,heldSources:safe,queuedEvents:safe,queuedBytes:safe,deliveredEvents:safe,pressure:one(true,false)}),
  advanceUploadScan:shape({runId:isUploadUuid,phase:one('legacy','candidates','complete','pressure'),examined:bounded,cursor:shape({legacy:decimal,ordinal:decimal})}),
  pageUploadDiscovery:shape({after:decimal,next:decimal,examined:bounded,items:v=>Array.isArray(v)&&v.length<=100&&v.every(shape({tripUuid:isUploadUuid,materialVersion:decimal,workId:nullable(isUploadUuid)}))}),
  beginUploadMaterialization:work,advanceUploadMaterialization:work,freezeUploadMaterialization:work,releaseUploadMaterialization:work,
  claimUploadAttempt:attempt,recordUploadAttemptOutcome:attempt,recoverUploadAttempt:attempt,
  commitUploadReceipt:shape({status:one('delivered','duplicate','reconciliation-required','invalid-response'),eventId:isUploadUuid,receiptId:nullable(isUploadUuid)}),
  reclaimUploadPayloads:shape({examined:bounded,reclaimed:bounded,events:v=>safe(v)&&v<=UPLOAD_MAX_EVENTS,bytes:v=>safe(v)&&v<=UPLOAD_MAX_BYTES})
};
export function isUploadSyncResult(command:UploadSyncCommand,value:unknown):boolean {
  if(!resultChecks[command.name](value)||!record(value))return false;
  if(command.name==='readRetainedUploadMaterializations')return (value.items as {workId:string}[]).length+(value.unmanagedPins as number)===value.examined&&new Set((value.items as {workId:string}[]).map(item=>item.workId)).size===(value.items as unknown[]).length;
  if(command.name==='getUploadConfiguration')return value.status==='reconciliation-required'||((value.registration===null)===(value.credentialGeneration===null)&&(value.registration===null)===(value.runId===null));
  if(command.name==='getUploadSchedulingHints'&&(value.registrationId!==command.input.registrationId||value.failureStreak!==0&&value.retryEventId===null))return false;
  if(command.name==='pageUploadScanRuns'){
    const page=value as unknown as UploadRunPage;
    if(page.after!==command.input.after||page.examined>command.input.limit||page.items.length>page.examined||(page.examined===0)!==(page.next===null)||page.next!==null&&page.next<=(page.after??''))return false;
    if(new Set(page.items.map(item=>item.runId)).size!==page.items.length||page.items.some(item=>item.runId<=(page.after??'')||page.next===null||item.runId>page.next))return false;
  }
  if(command.name==='pageUploadSources'){
    const page=value as unknown as UploadSourcePage,source=command.input.phase==='sources',cursor=source?decimal:receiptCursor;
    if(page.phase!==command.input.phase||page.after!==command.input.after||page.examined>command.input.limit||page.sources.length+page.receipts.length>page.examined||(source?page.receipts.length!==0:page.sources.length!==0)||(page.examined===0)!==(page.next===null)||page.next!==null&&!cursor(page.next))return false;
    if(page.next!==null&&page.after!==null){
      if(source?BigInt(page.next)<=BigInt(page.after):!receiptCursorAfter(page.next,page.after))return false;
    }
    if(new Set(page.sources.map(item=>item.tripUuid)).size!==page.sources.length||new Set(page.receipts.map(item=>item.eventId)).size!==page.receipts.length)return false;
    if(page.sources.some(item=>item.lastReceiptUtcMs!==null&&item.latestRevision===0||item.state==='delivered'&&item.lastReceiptUtcMs===null))return false;
  }
  if('input' in command&&'workId' in command.input&&value.workId!==command.input.workId)return false;
  if(command.name==='ensureUploadInstallation'&&((value.status==='ready')!==(value.clientInstallationId!==null)))return false;
  if(command.name==='confirmUploadOwner'&&value.status==='confirmed'&&(value.runId!==command.input.confirmationId||value.version!==String(BigInt(command.input.expectedVersion)+1n)))return false;
  if(command.name==='getUploadStoreStatus'&&(value.registrationId!==command.input.registrationId||(value.queuedEvents as number)>UPLOAD_MAX_EVENTS||(value.queuedBytes as number)>UPLOAD_MAX_BYTES))return false;
  if('workId' in value&&(value.status==='frozen'?value.eventId===null:value.status!=='released'&&value.eventId!==null))return false;
  if(command.name==='advanceUploadScan'&&value.runId!==command.input.runId)return false;
  if(command.name==='pageUploadDiscovery'&&(value.after!==command.input.after||(value.examined as number)>command.input.limit||(value.items as unknown[]).length>(value.examined as number)||BigInt(value.next as string)<BigInt(command.input.after)||value.examined===0&&value.next!==command.input.after))return false;
  if(command.name==='reclaimUploadPayloads'&&((value.examined as number)>command.input.limit||(value.reclaimed as number)>(value.examined as number)))return false;
  if(command.name==='recordUploadAttemptOutcome'&&(!['recorded','stale','delivered','reconciliation-required'].includes(value.status as string)||value.attemptId!==command.input.attemptId||value.eventId===null||value.registrationId===null||value.payload!==null||value.registration!==null))return false;
  if(command.name==='recoverUploadAttempt'){
    if(value.payload!==null||value.registration!==null)return false;
    if(value.status==='empty')return 'startup' in command.input&&value.attemptId===null&&value.eventId===null&&value.registrationId===null;
    return ['recovered','delivered','reconciliation-required'].includes(value.status as string)&&value.attemptId!==null&&value.eventId!==null&&value.registrationId!==null&&(!('attemptId' in command.input)||value.attemptId===command.input.attemptId);
  }
  if(command.name==='commitUploadReceipt'&&((value.status==='delivered'||value.status==='duplicate')?value.receiptId===null:value.status==='invalid-response'&&value.receiptId!==null))return false;
  if(command.name==='claimUploadAttempt')return value.status==='claimed'?value.attemptId===command.input.attemptId&&value.registrationId===command.input.registrationId&&value.eventId!==null&&record(value.registration)&&value.registration.registrationId===command.input.registrationId&&payload(value.payload):value.registration===null&&value.payload===null&&(['empty','paused','busy','reconciliation-required'].includes(value.status as string)?value.attemptId===null&&value.eventId===null&&value.registrationId===null:['recorded','delivered','stale'].includes(value.status as string)&&value.attemptId===command.input.attemptId&&value.eventId!==null&&value.registrationId===command.input.registrationId);
  return true;
}
