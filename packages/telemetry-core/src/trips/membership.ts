import type {JobConfiguration} from '../../../contracts/src/protocol-v1';
import {continuationFingerprint} from './continuation';

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
  | {state: 'root'; reason: 'recorded-job-incomplete'; fingerprint: null; interrupt: false}
  | {state: 'root'; reason: 'job-evidence-conflict'; fingerprint: null; interrupt: true}
  | {state: 'root'; reason: 'no-candidate' | 'ambiguous-candidates'; fingerprint: string; interrupt: true};

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
  if (recorded === null) return {state: 'root', reason: 'recorded-job-incomplete', fingerprint: null, interrupt: false};
  const current = continuationFingerprint(evidence.currentJob);
  if (current === null) return {state: 'pending', reason: 'job-evidence-incomplete'};
  if (current !== recorded || !evidence.consistent) return {state: 'root', reason: 'job-evidence-conflict', fingerprint: null, interrupt: true};
  if (evidence.candidates.length > 1) return {state: 'root', reason: 'ambiguous-candidates', fingerprint: current, interrupt: true};
  const candidate = evidence.candidates[0];
  if (candidate?.compatible) return {state: 'joined', reason: 'matched', target: candidate.ref, fingerprint: current};
  return {state: 'root', reason: 'no-candidate', fingerprint: current, interrupt: true};
}

/** A closed pending segment that a later proof can no longer resolve; it stays its own singleton for good. */
export type RetroactiveSeparate = {state: 'separate'; reason: 'process-ended' | 'profile-boundary' | 'published' | 'out-of-order'};
/** A retroactive root: the live root with the same reason and fingerprint, which never interrupts other trips. */
export type RetroactiveRoot<T> = Extract<MembershipDecision<T>, {state: 'root'}> extends infer R ? R extends {state: 'root'} ? Omit<R, 'interrupt'> & {interrupt: false} : never : never;
/** The result of decideRetroactive. */
export type RetroactiveDecision<T> = Exclude<MembershipDecision<T>, {state: 'root'}> | RetroactiveRoot<T> | RetroactiveSeparate;
/** What storage knows about a closed pending segment S when a later in-process proof arrives. */
export interface RetroactiveFacts {
  /** S was closed by a commit of its own plugin session; a close carried by a later session means the process ended. */
  closedByOwnSession: boolean;
  /** S's close carrier, a 20-digit eventSeq key of its session, or null when it is unknown. */
  rawClosedEventSeq: string | null;
  /** The session's highest profile boundary, a 20-digit eventSeq key, or null when it has none. */
  boundaryThroughEventSeq: string | null;
  /** A root or join decided in the session after the boundary carries another profile scope than the proof. */
  sessionScopeConflict: boolean;
  /** S's own logical root already has an upload source binding. */
  ownRootBound: boolean;
}

/**
 * The gate of a retroactive resolution, in order: a close by another session is process-ended; a profile boundary at or
 * after the close (20-digit keys, so text order is numeric order), an unknown close carrier or a scope conflict is
 * profile-boundary; a bound root is published. A boundary inside the segment, before its close, is ignored, exactly as the
 * live decision ignores it while the raw trip is open. Null means the proof may decide S.
 */
export function retroactiveGate(facts: RetroactiveFacts): RetroactiveSeparate | null {
  if (!facts.closedByOwnSession) return {state: 'separate', reason: 'process-ended'};
  const raw = facts.rawClosedEventSeq, boundary = facts.boundaryThroughEventSeq;
  if (raw === null || (boundary !== null && boundary >= raw) || facts.sessionScopeConflict) return {state: 'separate', reason: 'profile-boundary'};
  if (facts.ownRootBound) return {state: 'separate', reason: 'published'};
  return null;
}

/**
 * Decides a closed pending segment from a later admitted proof of its own session. After the gate, the live rules decide
 * with the recorded job as the current reading, since a closed raw trip has no later reading. A join is allowed only into
 * a target whose latest member precedes the segment (`latest(target) < segment`); otherwise the segment stays separate.
 * A root never interrupts other trips: a proof that arrives after S closed does not verify S's own profile at that time
 * (a profile switch with no trip open and no boundary event is not observable), and only complete, live, verified
 * evidence retires other trips. A later live proof-bearing trip of another job still interrupts them.
 */
export function decideRetroactive<T>(facts: RetroactiveFacts, evidence: {recordedJob: JobConfiguration; consistent: boolean; candidates: readonly MembershipCandidate<T>[]},
  latest: (target: T) => bigint, segment: bigint): RetroactiveDecision<T> {
  const gate = retroactiveGate(facts);
  if (gate) return gate;
  const decision = decideMembership({profileVerified: true, recordedJob: evidence.recordedJob, currentJob: evidence.recordedJob, consistent: evidence.consistent, candidates: evidence.candidates});
  if (decision.state === 'joined' && latest(decision.target) >= segment) return {state: 'separate', reason: 'out-of-order'};
  return decision.state === 'root' ? {...decision, interrupt: false} : decision;
}

/** What storage knows about a closed, proof-less singleton segment S that the history repair may join (ET-112g). */
export interface RepairJoinFacts {
  /** S's schema 9 membership decision, or null when S has none (closed legacy rows). */
  decision: {state: 'pending' | 'joined' | 'root' | 'separate'; reason: string} | null;
  /** The owner attested S by its full UUID; it stands in for S's missing profile proof and for nothing else. */
  attested: boolean;
  /** S's own logical root already has an upload source binding. */
  ownRootBound: boolean;
}
/** What storage knows about one candidate target T of a repair join. */
export interface RepairTargetFacts {
  /** T's latest raw member. */
  latest: bigint;
  /** T's latest raw member is still open. */
  latestOpen: boolean;
  /** Another raw trip of the same game lies between T's latest member and S. */
  intervening: boolean;
}
export type RepairIneligibleReason = 'decided' | 'out-of-order' | 'target-open' | 'intervening-trip' | Exclude<MembershipDecision<unknown>['reason'], 'matched'>;
/** The result of decideRepairJoin. Only `joined` becomes a repair action. */
export type RepairJoinDecision<T> =
  /** Every rule holds and the owner attested S. */
  | {state: 'joined'; target: T; fingerprint: string}
  /** Every rule holds, but S is not attested: a candidate that needs the owner's evidence. */
  | {state: 'needs-attestation'; target: T; fingerprint: string}
  /** S was published separately: the join is listed and never applied (F-D7). */
  | {state: 'reconciliation-required'; target: T; fingerprint: string}
  /** S's decision is still pending; a later proof of its own session may still decide it. */
  | {state: 'wait'; reason: 'pending'}
  | {state: 'not-eligible'; reason: RepairIneligibleReason};

/**
 * The owner-attested repair join of a closed, proof-less singleton segment S (ET-112g). Only S without a decision row or
 * with `separate/process-ended` is eligible; a pending S waits. The live rules decide with the recorded job as the current
 * reading and the attestation in place of the profile proof, over the live candidates of any profile scope. The one
 * compatible target must precede S (`latest(target) < segment`), have its latest member closed and have no other raw trip
 * of the game between its latest member and S. A published S (its root is bound, or its decision is `separate/published`)
 * passes the decision veto so that such a join is listed: it is reconciliation-required, attested or not, and never joined.
 */
export function decideRepairJoin<T>(facts: RepairJoinFacts, evidence: {recordedJob: JobConfiguration; consistent: boolean; candidates: readonly MembershipCandidate<T>[]},
  target: (target: T) => RepairTargetFacts, segment: bigint): RepairJoinDecision<T> {
  if (facts.decision?.state === 'pending') return {state: 'wait', reason: 'pending'};
  const published = facts.ownRootBound || (facts.decision?.state === 'separate' && facts.decision.reason === 'published');
  if (facts.decision && !published && !(facts.decision.state === 'separate' && facts.decision.reason === 'process-ended')) return {state: 'not-eligible', reason: 'decided'};
  const decision = decideMembership({profileVerified: true, recordedJob: evidence.recordedJob, currentJob: evidence.recordedJob, consistent: evidence.consistent, candidates: evidence.candidates});
  if (decision.state !== 'joined') return {state: 'not-eligible', reason: decision.reason};
  const t = target(decision.target);
  if (t.latest >= segment) return {state: 'not-eligible', reason: 'out-of-order'};
  if (t.latestOpen) return {state: 'not-eligible', reason: 'target-open'};
  if (t.intervening) return {state: 'not-eligible', reason: 'intervening-trip'};
  const join = {target: decision.target, fingerprint: decision.fingerprint};
  if (published) return {state: 'reconciliation-required', ...join};
  return facts.attested ? {state: 'joined', ...join} : {state: 'needs-attestation', ...join};
}
