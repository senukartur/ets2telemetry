// Exact companion counters and quantities. These helpers compare representation, never qualification policy.
import {qualificationSchema} from './qualification-schema';
import type {components} from './qualification-wire';
import {uploadRecord, uploadShape, uploadOne, uploadNull, uploadSafe, isDashboardOwner, type DashboardOwner} from './dashboard-upload';
export type QualificationWire = components['schemas'];
export type QualificationSnapshot = QualificationWire['Qualification'];
export type QualificationPreview = QualificationWire['Preview'];
export type QualificationPreviewInput = QualificationWire['PreviewInput'];
export type QualificationResult = QualificationWire['Result'];
export type QualificationSourceRequest = QualificationWire['SourceRequest'];
export type QualificationResultBatch = QualificationWire['ResultBatch'];
export type QualificationResultMetadata=Pick<QualificationResult,'companyDecision'|'credit'>;
export interface QualificationVerdict {availability:QualificationWire['Assessment']['availability'];outcome:QualificationWire['Assessment']['outcome']}
export const QUALIFICATION_RESPONSE_BYTES = 1_048_576;
export const QUALIFICATION_DETAIL_BYTES=2*QUALIFICATION_RESPONSE_BYTES+4096;
export const QUALIFICATION_REQUEST_BYTES = 16_384;

interface Schema {
  $ref?: string; oneOf?: Schema[]; type?: string; const?: unknown; enum?: unknown[];
  minimum?: number; maximum?: number; minLength?: number; maxLength?: number; pattern?: string; format?: string;
  minItems?: number; maxItems?: number; items?: Schema; properties?: Record<string, Schema>; required?: string[]; additionalProperties?: boolean;
}
const definitions = qualificationSchema.$defs as unknown as Record<string, Schema>;
/** Interpreter for the pinned closed companion schema; no coercion, defaults, stripping or policy inference. */
function matches(schema: Schema, value: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (schema.$ref) {const target = definitions[schema.$ref.replace('#/$defs/', '')]; return target !== undefined && matches(target, value, depth);}
  if (schema.oneOf) return schema.oneOf.filter(branch => matches(branch, value, depth)).length === 1;
  if (Object.hasOwn(schema, 'const') && value !== schema.const || schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
  case 'null': return value === null;
  case 'boolean': return typeof value === 'boolean';
  case 'integer': return typeof value === 'number' && Number.isSafeInteger(value) && value >= (schema.minimum ?? -Number.MAX_SAFE_INTEGER) && value <= (schema.maximum ?? Number.MAX_SAFE_INTEGER);
  case 'string': {
    if (typeof value !== 'string' || Array.from(value).length < (schema.minLength ?? 0) || Array.from(value).length > (schema.maxLength ?? Infinity) || schema.pattern && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) return false;
    return schema.format !== 'date-time' || /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value) && Number.isFinite(Date.parse(value));
  }
  case 'array': return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) && !!schema.items && value.every(item => matches(schema.items!, item, depth + 1));
  case 'object': return uploadRecord(value) && (schema.required ?? []).every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => schema.properties?.[key] ? matches(schema.properties[key], value[key], depth + 1) : schema.additionalProperties !== false);
  default: return false;
  }
}
export function isQualificationWire<K extends keyof QualificationWire>(kind: K, value: unknown): value is QualificationWire[K] {
  try {return !!definitions[kind] && matches(definitions[kind], value, 0) && new TextEncoder().encode(JSON.stringify(value)).byteLength <= QUALIFICATION_RESPONSE_BYTES;} catch {return false;}
}
export const isQualificationVerdict=(value:unknown):value is QualificationVerdict=>uploadShape({availability:uploadOne('retained','historical_unavailable'),outcome:uploadNull(uploadOne('pass','fail','unknown'))})(value)&&((value as QualificationVerdict).availability!=='historical_unavailable'||(value as QualificationVerdict).outcome===null);
export function isQualificationResultMetadata(value:unknown):value is QualificationResultMetadata {
  const properties=definitions.Result.properties!;
  return matches({type:'object',properties:{companyDecision:properties.companyDecision,credit:properties.credit},required:['companyDecision','credit'],additionalProperties:false},value,0);
}
export function sameQualificationSource(left: QualificationWire['SourceIdentity'], right: QualificationWire['SourceIdentity']): boolean {
  return left.provider === right.provider && left.game === right.game && left.pluginSessionId === right.pluginSessionId && left.tripId === right.tripId;
}
export function qualificationResultMatches(result: QualificationResult, request: QualificationSourceRequest): boolean {
  if (!sameQualificationSource(result.source, request.source) || result.requestedRevision !== request.revision || result.requestedEventId !== request.eventId) return false;
  if (result.unchanged) return request.ifVersion === result.version && result.assessment === null && result.credit === null;
  const assessment = result.assessment;
  if ((result.assessmentBasis === 'none') !== (assessment === null)) return false;
  if (result.receipt === 'not_received' && (result.state !== 'not_received' || result.requestedSourceMessageId !== null)) return false;
  if (result.receipt === 'received' && (result.state === 'not_received' || result.requestedSourceMessageId === null || result.canonicalTripId === null || result.latestSourceRevision === null || result.latestSourceRevision < request.revision)) return false;
  if (assessment?.availability === 'historical_unavailable' && (assessment.level !== null || assessment.limits !== null || assessment.outcome !== null || assessment.rules.length !== 0)) return false;
  if (result.assessmentBasis === 'current' && assessment && (!assessment.assessedSource || !sameQualificationSource(assessment.assessedSource, request.source) || assessment.sourceRevision !== request.revision || assessment.sourceEventId !== request.eventId || assessment.sourceMessageId === null || assessment.sourceMessageId !== result.requestedSourceMessageId)) return false;
  return true;
}
const qualificationCanonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(qualificationCanonical).join(',')}]` : uploadRecord(value) ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${qualificationCanonical(value[key])}`).join(',')}}` : JSON.stringify(value);
/** Opaque view identity and current catalog labels cannot rewrite immutable domain facts. */
export function qualificationDecisionJson(value: QualificationResult): string {
  const result:Partial<QualificationResult> = structuredClone(value);delete result.version;delete result.resultRevision;result.unchanged=false;
  if (result.assessment) result.assessment.trailerDisplay = [];
  return qualificationCanonical(result);
}
/** The server view version excludes only catalog read timestamps from its current presentation. */
export function qualificationPresentationJson(value:QualificationResult):string {
  return qualificationCanonical((value.assessment?.trailerDisplay??[]).map(label=>Object.fromEntries(Object.entries(label).filter(([key])=>key!=='asOf'))));
}
export const qualificationStoredViewJson=(value:QualificationResult):string=>`[${qualificationDecisionJson(value)},${qualificationPresentationJson(value)}]`;
export function qualificationAssessmentJson(value:QualificationResult):string|null {
  if(!value.assessment)return null;const assessment=structuredClone(value.assessment);assessment.trailerDisplay=[];return qualificationCanonical(assessment);
}
export type QualificationAvailability = 'disconnected' | 'loading' | 'ready' | 'offline' | 'unsupported' | 'disabled' | 'permission-required' | 'unavailable';
export interface QualificationState {
  owner: DashboardOwner | null; game: QualificationGame; availability: QualificationAvailability;
  snapshot: QualificationSnapshot | null; preview: QualificationPreview | null; fetchedUtcMs: number | null;
  stale: boolean; refreshing: boolean;
  activeJob:boolean;
}
export interface QualificationBridge {
  getQualification(game: QualificationGame): Promise<QualificationState>;
  refreshQualification(game: QualificationGame): Promise<QualificationState>;
  subscribeQualification(listener: (state: QualificationState) => void): () => void;
}
export function initialQualificationState(game: QualificationGame, owner: DashboardOwner | null = null): QualificationState {
  return {owner, game, availability: owner ? 'loading' : 'disconnected', snapshot: null, preview: null, fetchedUtcMs: null, stale: true, refreshing: false,activeJob:false};
}
export function isQualificationState(value: unknown): value is QualificationState {
  if (!uploadShape({owner: uploadNull(isDashboardOwner), game: isQualificationGame, availability: uploadOne('disconnected','loading','ready','offline','unsupported','disabled','permission-required','unavailable'), snapshot: uploadNull(v => isQualificationWire('Qualification', v)), preview: uploadNull(v => isQualificationWire('Preview', v)), fetchedUtcMs: uploadNull(uploadSafe), stale: uploadOne(true,false), refreshing: uploadOne(true,false),activeJob:uploadOne(true,false)})(value)) return false;
  const state = value as QualificationState;
  return state.owner !== null ? (!state.snapshot || state.snapshot.game === state.game&&state.snapshot.ownerId===state.owner.accountId) && (!state.preview || !!state.snapshot && state.snapshot.securityScope === state.preview.securityScope) : state.availability === 'disconnected' && state.snapshot === null && state.preview === null && state.fetchedUtcMs === null&&!state.activeJob;
}
export type QualificationGame = 'ets2' | 'ats';
export type QualificationCue = 'pass' | 'fail' | 'neutral';
export const isQualificationGame = (value: unknown): value is QualificationGame => value === 'ets2' || value === 'ats';
export const isQualificationCounter = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
export const isQualificationDecimal = (value: unknown): value is string => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})(\.[0-9]{0,17}[1-9])?$/.test(value);
export function compareQualificationCounter(left: string, right: string): -1 | 0 | 1 {
  if (!isQualificationCounter(left) || !isQualificationCounter(right)) throw Error('INVALID_QUALIFICATION_COUNTER');
  return left.length < right.length ? -1 : left.length > right.length ? 1 : left < right ? -1 : left > right ? 1 : 0;
}
const scaled = (value: string): bigint => {
  if (!isQualificationDecimal(value)) throw Error('INVALID_QUALIFICATION_DECIMAL');
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
};
export function compareQualificationDecimal(left: string, right: string): -1 | 0 | 1 {
  const a = scaled(left), b = scaled(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
/** A display-only percentage; exact bounds are compared before rounding the bounded ratio. */
export function qualificationPercentage(credited: string, required: string | null): number | null {
  if (required === null) return null;
  if(!isQualificationWire('AggregateDecimal',credited)||!isQualificationDecimal(required))throw Error('INVALID_QUALIFICATION_DECIMAL');
  const [currentWhole,currentFraction='']=credited.split('.'),[totalWhole,totalFraction='']=required.split('.'),places=Math.max(currentFraction.length,totalFraction.length);
  const total=BigInt(totalWhole+totalFraction.padEnd(places,'0')),current=BigInt(currentWhole+currentFraction.padEnd(places,'0'));
  if (total === 0n || current >= total) return 100;
  return Number(current * 10_000n / total) / 100;
}
