// Private utility/worker commands. Registration and connection authority never come from a renderer.
import {isQualificationWire, isQualificationCounter, type QualificationSnapshot, type QualificationResultBatch, type QualificationSourceRequest, type QualificationResult} from '../../contracts/src/qualification';
import {uploadShape as shape, uploadOne as one, uploadNull as nullable, uploadUuid, uploadSafe, uploadRecord} from '../../contracts/src/dashboard-upload';
export interface QualificationAuthority {registrationId: string; connectionVersion: string}
export interface QualificationRefresh {afterEvent: string | null; retryAtMs: number; failureStreak: number; suspended: boolean}
export interface QualificationStoredCache {snapshot: QualificationSnapshot; fetchedUtcMs: number}
export interface QualificationStoredState {active: boolean; securityScope: string | null; caches: QualificationStoredCache[]; refresh: QualificationRefresh}
export interface QualificationLocalSource {request: QualificationSourceRequest; localMaterialDigest: string; result: QualificationResult | null}
type Command<I, V> = {args: {input: I}; value: V};
export interface QualificationCommands {
  readQualificationCache: Command<QualificationAuthority, QualificationStoredState>;
  setQualificationScope: Command<QualificationAuthority & {securityScope: string}, {active: boolean}>;
  saveQualificationCache: Command<QualificationAuthority & {snapshot: QualificationSnapshot; fetchedUtcMs: number}, {saved: boolean}>;
  pageQualificationSources: Command<QualificationAuthority & {securityScope: string; afterEvent: string | null; limit: number}, {items: QualificationLocalSource[]; next: string | null}>;
  commitQualificationResults: Command<QualificationAuthority & {securityScope: string; request: {requestId: string; items: QualificationSourceRequest[]}; batch: QualificationResultBatch; fetchedUtcMs: number}, {saved: number; missingBase: string[]}>;
  saveQualificationRefresh: Command<QualificationAuthority & {securityScope: string; refresh: QualificationRefresh}, {saved: boolean}>;
}
export type QualificationCommandName = keyof QualificationCommands;
export type QualificationCommand = {[K in QualificationCommandName]: {name: K} & QualificationCommands[K]['args']}[QualificationCommandName];
const authority = {registrationId: uploadUuid, connectionVersion: isQualificationCounter};
const scope = (v: unknown) => isQualificationWire('SecurityScope', v);
const refresh = shape({afterEvent: nullable(uploadUuid), retryAtMs: uploadSafe, failureStreak: v => uploadSafe(v) && v <= 9, suspended: one(true,false)});
const requests: Record<QualificationCommandName, (v: unknown) => boolean> = {
  readQualificationCache: shape(authority),
  setQualificationScope: shape({...authority, securityScope: scope}),
  saveQualificationCache: shape({...authority, snapshot: v => isQualificationWire('Qualification', v), fetchedUtcMs: uploadSafe}),
  pageQualificationSources: shape({...authority, securityScope: scope, afterEvent: nullable(uploadUuid), limit: v => uploadSafe(v) && v > 0 && v <= 25}),
  commitQualificationResults: shape({...authority, securityScope: scope, request: v => isQualificationWire('ResultBatchInput', v), batch: v => isQualificationWire('ResultBatch', v), fetchedUtcMs: uploadSafe}),
  saveQualificationRefresh: shape({...authority, securityScope: scope, refresh})
};
export const QUALIFICATION_COMMAND_NAMES = Object.freeze(Object.keys(requests) as QualificationCommandName[]);
export const isQualificationCommandName = (v: string): v is QualificationCommandName => Object.hasOwn(requests, v);
export function isQualificationCommand(v: unknown): v is QualificationCommand {
  return uploadRecord(v) && typeof v.name === 'string' && isQualificationCommandName(v.name) && shape({name: one(v.name), input: requests[v.name]})(v);
}
export function isQualificationCommandValue(command: QualificationCommand, value: unknown): boolean {
  if (command.name === 'readQualificationCache') return shape({active: one(true,false), securityScope: nullable(scope), caches: v => Array.isArray(v) && v.length <= 2 && v.every(shape({snapshot: s => isQualificationWire('Qualification', s), fetchedUtcMs: uploadSafe})), refresh})(value);
  if (command.name === 'setQualificationScope') return shape({active: one(true,false)})(value);
  if (command.name === 'saveQualificationCache' || command.name === 'saveQualificationRefresh') return shape({saved: one(true,false)})(value);
  if (command.name === 'commitQualificationResults') return shape({saved: v => uploadSafe(v) && v <= 25, missingBase: v => Array.isArray(v) && v.length <= 25 && v.every(uploadUuid)})(value);
  return shape({items: v => Array.isArray(v) && v.length <= command.input.limit && v.every(shape({request: r => isQualificationWire('SourceRequest', r), localMaterialDigest: d => typeof d === 'string' && /^[0-9a-f]{64}$/.test(d), result: nullable(r => isQualificationWire('Result', r))})), next: nullable(uploadUuid)})(value);
}
