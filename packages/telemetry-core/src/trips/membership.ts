import type {JobConfiguration} from '../../../contracts/src/protocol-v1';
import {continuationFingerprint, U32_DEADLINE_SENTINEL} from './continuation';

/**
 * Another unretired logical trip of the same game, profile scope and job fingerprint as the segment's current reading.
 * `compatible` is false when its learned optional offer fields or its original job contradict the reading.
 */
export interface MembershipCandidate<T> {ref: T; compatible: boolean}
export interface MembershipEvidence<T> {
  /** The reading carries an admitted, source-qualified profile proof. */
  profileVerified: boolean;
  /** The segment's own recorded job; it never changes while the raw trip exists. */
  recordedJob: JobConfiguration;
  currentJob: JobConfiguration;
  /** The recorded and current readings agree on every learned optional offer field. */
  consistent: boolean;
  /** At most two candidates, read only when the current fingerprint is complete; two or more are ambiguous. */
  candidates: readonly MembershipCandidate<T>[];
}
export type MembershipDecision<T> =
  /** Not decided: store no proof and retire nothing, so a later proof-bearing reading of the open raw trip retries. */
  | {state: 'pending'; reason: 'profile-unverified' | 'job-evidence-incomplete'}
  | {state: 'joined'; reason: 'matched'; target: T; fingerprint: string}
  /** The segment is its own root. `interrupt` retires the other unresolved trips of the profile (the replacement rule). */
  | {state: 'root'; reason: 'recorded-job-incomplete' | 'deadline-unavailable'; fingerprint: null; interrupt: false}
  | {state: 'root'; reason: 'job-evidence-conflict'; fingerprint: null; interrupt: true}
  | {state: 'root'; reason: 'no-candidate' | 'ambiguous-candidates'; fingerprint: string; interrupt: true};

const deadlineUnavailable = (job: JobConfiguration) => !job.deliveryDeadline?.available || job.deliveryDeadline.value === U32_DEADLINE_SENTINEL;

/**
 * Pure continuation membership of one segment. Missing evidence never retires anything: an unverified profile or an
 * incomplete current reading stays pending, and an incomplete recorded job makes a root that cannot join or replace.
 * Only complete verified evidence joins exactly one compatible candidate or, otherwise, replaces the other unresolved trips;
 * two matching candidates are ambiguous and never joined.
 */
export function decideMembership<T>(evidence: MembershipEvidence<T>): MembershipDecision<T> {
  if (!evidence.profileVerified) return {state: 'pending', reason: 'profile-unverified'};
  const recorded = continuationFingerprint(evidence.recordedJob);
  // The recorded job is immutable, so a later reading cannot complete it.
  if (recorded === null) return {state: 'root', reason: deadlineUnavailable(evidence.recordedJob) ? 'deadline-unavailable' : 'recorded-job-incomplete', fingerprint: null, interrupt: false};
  const current = continuationFingerprint(evidence.currentJob);
  if (current === null) return {state: 'pending', reason: 'job-evidence-incomplete'};
  if (current !== recorded || !evidence.consistent) return {state: 'root', reason: 'job-evidence-conflict', fingerprint: null, interrupt: true};
  if (evidence.candidates.length > 1) return {state: 'root', reason: 'ambiguous-candidates', fingerprint: current, interrupt: true};
  const candidate = evidence.candidates[0];
  if (candidate?.compatible) return {state: 'joined', reason: 'matched', target: candidate.ref, fingerprint: current};
  return {state: 'root', reason: 'no-candidate', fingerprint: current, interrupt: true};
}
