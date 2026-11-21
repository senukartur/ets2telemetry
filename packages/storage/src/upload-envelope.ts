import {createHash} from 'node:crypto';
import {strictJson} from '../../contracts/src/protocol-v0';
import {isUploadSummary,isUploadUuid,type UploadSummary} from './upload-projection';
import {isUploadEventMinor,one,record,safe,shape,text,type UploadEventMinor} from './upload-sync';

export interface UploadEnvelope extends UploadSummary {
  contract:{major:1;minor:UploadEventMinor};producer:{application:'ets2telemetry';version:string};eventId:string;revision:number;
  installationId:string;bindingId:string;delivery:{mode:'live'|'backfill';syncRunId:string};
  type:'trip.started'|'trip.completed'|'trip.cancelled'|'trip.closed'|'trip.corrected';createdUtcMs:number;
}
/** Receipts echo the version of the event they acknowledge. */
export interface UploadReceipt {contract:{major:1;minor:UploadEventMinor};eventId:string;receiptId:string;status:'stored'|'duplicate';firstReceivedAtUtcMs:number}
const contract=shape({major:one(1),minor:isUploadEventMinor});
export function canonicalUpload(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonicalUpload).join(',')}]`;
  if(record(value))return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalUpload(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const uploadDigest=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
/**
 * Volatile upload metadata is absent; ordinary OPEN counters do not create material revisions. The v1.2 accounting
 * status is not material either: it never mints a revision alone, and each new revision carries the current status.
 */
export function uploadMaterialDigest(summary:UploadSummary):string {
  const value=structuredClone(summary);
  delete value.snapshot.accounting;
  delete value.snapshot.cargoClassification;
  if(value.snapshot.outcome==='open'){
    if(value.snapshot.observedDistance.available)value.snapshot.observedDistance.value=0;
    if(value.snapshot.fuelUsed.available)value.snapshot.fuelUsed.value=0;
  }
  return uploadDigest(canonicalUpload(value));
}

/** The base stays byte-compatible with existing bindings. The optional stamp records only known v1.3 evidence. */
export function uploadMaterialStamp(summary:UploadSummary,minor:UploadEventMinor):string {
  const base=uploadMaterialDigest(summary),cargo=summary.snapshot.cargoClassification;
  return minor===3 && cargo ? `${base}:cargo-v1:${uploadDigest(canonicalUpload(cargo))}` : base;
}
export function readUploadMaterialStamp(value:unknown):{base:string;cargo:string|null}|undefined {
  if(typeof value!=='string')return undefined;
  const match=/^([0-9a-f]{64})(?::cargo-v1:([0-9a-f]{64}))?$/.exec(value);
  return match && match[0]===value ? {base:match[1],cargo:match[2]??null} : undefined;
}
export function validateUploadEnvelope(value:unknown):value is UploadEnvelope {
  if(!shape({contract,producer:shape({application:one('ets2telemetry'),version:v=>text(v)&&Buffer.byteLength(v)<=64}),eventId:isUploadUuid,
    revision:v=>safe(v)&&v>0,installationId:isUploadUuid,bindingId:isUploadUuid,
    source:()=>true,snapshot:()=>true,delivery:shape({mode:one('live','backfill'),syncRunId:isUploadUuid}),
    type:one('trip.started','trip.completed','trip.cancelled','trip.closed','trip.corrected'),createdUtcMs:safe})(value))return false;
  const envelope=value as UploadEnvelope;
  if(!isUploadSummary({source:envelope.source,snapshot:envelope.snapshot}, envelope.contract.minor))return false;
  const outcome=envelope.snapshot.outcome;
  if(envelope.type==='trip.started'?outcome!=='open':envelope.type==='trip.corrected'?outcome==='open':outcome!==({'trip.completed':'delivered','trip.cancelled':'cancelled','trip.closed':'none'} as const)[envelope.type])return false;
  try{strictJson(canonicalUpload(envelope));return Buffer.byteLength(canonicalUpload(envelope))<=65_536;}catch{return false;}
}
export function encodeUploadEnvelope(envelope:UploadEnvelope):Uint8Array|undefined {
  return validateUploadEnvelope(envelope)?new Uint8Array(Buffer.from(canonicalUpload(envelope),'utf8')):undefined;
}
/**
 * `minor`, when given, is the frozen event's version, which the receipt must echo; any other version is not an ACK.
 * Null (an unreadable frozen version) accepts no receipt.
 */
export function decodeUploadReceipt(bytes:Uint8Array,statusCode:number,eventId:string,minor?:UploadEventMinor|null):UploadReceipt|undefined {
  if(bytes.byteLength>4096||statusCode!==200&&statusCode!==202)return undefined;
  let parsed:unknown;
  try{parsed=strictJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));}catch{return undefined;}
  if(!shape({contract:minor===undefined?contract:shape({major:one(1),minor:minor===null?one():one(minor)}),eventId:one(eventId),receiptId:isUploadUuid,status:one(statusCode===202?'stored':'duplicate'),firstReceivedAtUtcMs:safe})(parsed))return undefined;
  return parsed as UploadReceipt;
}
