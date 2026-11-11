import type {JobConfiguration} from '../../../contracts/src/protocol-v1';
import {canonicalJson} from './identity';

/** Persistent profile scope is private evidence, independent of settings qualification. */
export interface ProfileObservation {
  version: 1; scope: string; binding: string; game: 'ets2' | 'ats'; pluginSessionId: string;
  processInstanceId: string; sourceClockId: string; afterMonotonicNs: string; loadGeneration: number;
}
export const CONTINUATION_FIELDS = ['cargoId', 'sourceCityId', 'sourceCompanyId', 'destinationCityId', 'destinationCompanyId',
  'cargoMass', 'market', 'deliveryDeadline', 'expectedIncome'] as const;
const EXTRA_FIELDS = ['cargoUnitMass', 'cargoUnitCount', 'isSpecialJob', 'plannedDistance'] as const;
export type ContinuationConstraints = Partial<Record<typeof EXTRA_FIELDS[number], unknown>>;
/** Learned canonical values survive later unavailable observations; at most four optional offer fields are retained. */
export function learnContinuationConstraints(known: ContinuationConstraints, job: JobConfiguration): ContinuationConstraints | null {
  const result = {...known};
  for (const field of EXTRA_FIELDS) {
    const reading = job[field];
    if (!reading.available) continue;
    if (Object.hasOwn(result, field) && canonicalJson(result[field]) !== canonicalJson(reading.value)) return null;
    result[field] = structuredClone(reading.value);
  }
  return result;
}
/** The SDK defines no deadline sentinel; the u32 maximum cannot distinguish one job from another, so identity treats it as unavailable. */
export const U32_DEADLINE_SENTINEL = '4294967295';
/** Exact canonical evidence only. Localized labels, cargoLoaded and currency descriptions are deliberately excluded. */
export function continuationFingerprint(job: JobConfiguration): string | null {
  const values: unknown[] = [];
  for (const field of CONTINUATION_FIELDS) {
    const reading = job[field];
    if (!reading?.available) return null;
    const value = reading.value;
    if (field === 'deliveryDeadline' && value === U32_DEADLINE_SENTINEL) return null;
    if (typeof value === 'string' && !value.length || typeof value === 'number' && (!Number.isFinite(value) || value < 0)) return null;
    values.push(field === 'expectedIncome' ? {raw: job.expectedIncome.available ? job.expectedIncome.value.raw : '', sdkType: job.expectedIncome.available ? job.expectedIncome.value.sdkType : ''} : value);
  }
  return `job-v1:${canonicalJson(values)}`;
}
export function compatibleContinuation(a: JobConfiguration, b: JobConfiguration): boolean {
  const key = continuationFingerprint(a);
  return key !== null && key === continuationFingerprint(b) && EXTRA_FIELDS.every(field => {
    const x = a[field], y = b[field];
    return !x.available || !y.available || canonicalJson(x.value) === canonicalJson(y.value);
  });
}
