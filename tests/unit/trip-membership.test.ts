import {describe, expect, it} from 'vitest';
import {compatibleContinuation, continuationFingerprint, continuationIdentityFingerprint} from '../../packages/telemetry-core/src/trips/continuation';
import {decideMembership, decideRepairJoin, decideRetroactive, retroactiveGate, type MembershipCandidate, type MembershipDecision, type MembershipEvidence, type RepairJoinDecision,
  type RepairJoinFacts, type RepairTargetFacts, type RetroactiveDecision, type RetroactiveFacts, type RetroactiveSeparate} from '../../packages/telemetry-core/src/trips/membership';
import {INCIDENT_JOB, INCIDENT_JOB_U32_MAX_DEADLINE, INCIDENT_JOB_WITHOUT_DEADLINE, INCIDENT_OTHER_JOB} from '../shared/trip-continuation-incident';

// Expected decisions are written by hand from the ET-112 agreed continuation rules (docs/trips.md).
const F = continuationFingerprint(INCIDENT_JOB)!;
const match = (ref: string, compatible = true): MembershipCandidate<string> => ({ref, compatible});
const evidence = (overrides: Partial<MembershipEvidence<string>> = {}): MembershipEvidence<string> =>
  ({profileVerified: true, recordedJob: INCIDENT_JOB, currentJob: INCIDENT_JOB, consistent: true, candidates: [], ...overrides});
const missingCargo = {...INCIDENT_JOB, cargoId: {available: false, reason: 'not-observed'}} as const;

describe('REG-003/REG-008 continuation membership decisions', () => {
  it('builds the incident job fingerprint from exact canonical fields only', () => {
    expect(F).toMatch(/^job-v1:/);
    expect(continuationFingerprint({...INCIDENT_JOB, cargo: {available: true, value: 'Localized cargo'}, cargoLoaded: {available: true, value: false}})).toBe(F);
    expect(continuationFingerprint(INCIDENT_OTHER_JOB)).not.toBe(F);
  });
  it('treats a missing deadline and the u32 maximum deadline as unavailable identity evidence', () => {
    expect(continuationIdentityFingerprint(INCIDENT_JOB_WITHOUT_DEADLINE)).toBeNull();
    expect(continuationIdentityFingerprint(INCIDENT_JOB_U32_MAX_DEADLINE)).toBeNull();
    expect(continuationIdentityFingerprint(INCIDENT_JOB)).toBe(F);
    expect(continuationIdentityFingerprint({...INCIDENT_JOB, deliveryDeadline: {available: true, value: '4294967294', unit: 'min'}})).not.toBeNull();
  });
  it('keeps the u32 maximum deadline a same-job value outside continuation identity', () => {
    expect(continuationFingerprint(INCIDENT_JOB_U32_MAX_DEADLINE)).not.toBeNull();
    expect(compatibleContinuation(INCIDENT_JOB_U32_MAX_DEADLINE, INCIDENT_JOB_U32_MAX_DEADLINE)).toBe(true);
    expect(compatibleContinuation(INCIDENT_JOB_U32_MAX_DEADLINE, INCIDENT_JOB)).toBe(false);
  });
  const table: [string, Partial<MembershipEvidence<string>>, MembershipDecision<string>][] = [
    ['unverified profile', {profileVerified: false, candidates: [match('A')]}, {state: 'pending', reason: 'profile-unverified'}],
    ['current reading without a deadline', {currentJob: INCIDENT_JOB_WITHOUT_DEADLINE}, {state: 'pending', reason: 'job-evidence-incomplete'}],
    ['current reading with the u32 maximum deadline', {currentJob: INCIDENT_JOB_U32_MAX_DEADLINE}, {state: 'pending', reason: 'job-evidence-incomplete'}],
    ['current reading without cargo', {currentJob: missingCargo}, {state: 'pending', reason: 'job-evidence-incomplete'}],
    ['recorded job without a deadline', {recordedJob: INCIDENT_JOB_WITHOUT_DEADLINE, candidates: [match('A')]},
      {state: 'root', reason: 'deadline-unavailable', fingerprint: null, interrupt: false}],
    ['recorded job with the u32 maximum deadline', {recordedJob: INCIDENT_JOB_U32_MAX_DEADLINE, currentJob: INCIDENT_JOB_U32_MAX_DEADLINE},
      {state: 'root', reason: 'deadline-unavailable', fingerprint: null, interrupt: false}],
    ['recorded job without cargo', {recordedJob: missingCargo}, {state: 'root', reason: 'recorded-job-incomplete', fingerprint: null, interrupt: false}],
    ['current reading of another complete job', {currentJob: INCIDENT_OTHER_JOB}, {state: 'root', reason: 'job-evidence-conflict', fingerprint: null, interrupt: true}],
    ['conflicting learned offer fields', {consistent: false, candidates: [match('A')]}, {state: 'root', reason: 'job-evidence-conflict', fingerprint: null, interrupt: true}],
    ['exactly one compatible candidate', {candidates: [match('A')]}, {state: 'joined', reason: 'matched', target: 'A', fingerprint: F}],
    ['one candidate with contradicting constraints', {candidates: [match('A', false)]}, {state: 'root', reason: 'no-candidate', fingerprint: F, interrupt: true}],
    ['two matching candidates', {candidates: [match('A'), match('B')]}, {state: 'root', reason: 'ambiguous-candidates', fingerprint: F, interrupt: true}],
    ['no matching candidate', {}, {state: 'root', reason: 'no-candidate', fingerprint: F, interrupt: true}]
  ];
  it.each(table)('decides %s', (_name, overrides, expected) => {
    expect(decideMembership(evidence(overrides))).toEqual(expected);
  });
});

describe('REG-005/REG-008 retroactive resolution of a closed pending segment', () => {
  const key = (eventSeq: number) => String(eventSeq).padStart(20, '0');
  const clear: RetroactiveFacts = {closedByOwnSession: true, rawClosedEventSeq: key(2), boundaryThroughEventSeq: null, sessionScopeConflict: false, ownRootBound: false};
  const separate = (reason: RetroactiveSeparate['reason']): RetroactiveSeparate => ({state: 'separate', reason});
  const gates: [string, Partial<RetroactiveFacts>, RetroactiveSeparate | null][] = [
    ['a close by another session, even with a boundary and a binding', {closedByOwnSession: false, boundaryThroughEventSeq: key(9), ownRootBound: true}, separate('process-ended')],
    ['a boundary at the close carrier', {boundaryThroughEventSeq: key(2)}, separate('profile-boundary')],
    ['a boundary after the close carrier', {boundaryThroughEventSeq: key(10)}, separate('profile-boundary')],
    ['an unknown close carrier', {rawClosedEventSeq: null}, separate('profile-boundary')],
    ['a later decision of another scope in the session', {sessionScopeConflict: true}, separate('profile-boundary')],
    ['a boundary inside the segment, before its close', {boundaryThroughEventSeq: key(1)}, null],
    ['a bound own root', {ownRootBound: true}, separate('published')],
    ['a boundary before the close and a bound own root', {boundaryThroughEventSeq: key(1), ownRootBound: true}, separate('published')],
    ['no boundary, conflict or binding', {}, null]
  ];
  it.each(gates)('gates %s', (_name, overrides, expected) => {
    expect(retroactiveGate({...clear, ...overrides})).toEqual(expected);
  });
  const latest = (values: Record<string, bigint>) => (ref: string) => values[ref];
  const decide = (overrides: Partial<{recordedJob: typeof INCIDENT_JOB; consistent: boolean; candidates: MembershipCandidate<string>[]}>, values: Record<string, bigint> = {A: 5n}) =>
    decideRetroactive(clear, {recordedJob: INCIDENT_JOB, consistent: true, candidates: [match('A')], ...overrides}, latest(values), 7n);
  it('joins the one compatible candidate whose latest member precedes the segment', () => {
    expect(decide({})).toEqual({state: 'joined', reason: 'matched', target: 'A', fingerprint: F});
  });
  it('keeps the segment separate when the target already continued at or after it', () => {
    expect(decide({}, {A: 7n})).toEqual(separate('out-of-order'));
    expect(decide({}, {A: 9n})).toEqual(separate('out-of-order'));
  });
  it.each([
    ['no candidate', {candidates: []}, {state: 'root', reason: 'no-candidate', fingerprint: F, interrupt: false}],
    ['two candidates', {candidates: [match('A'), match('B')]}, {state: 'root', reason: 'ambiguous-candidates', fingerprint: F, interrupt: false}],
    ['an incomplete recorded job', {recordedJob: missingCargo}, {state: 'root', reason: 'recorded-job-incomplete', fingerprint: null, interrupt: false}],
    ['inconsistent learned offer fields', {consistent: false}, {state: 'root', reason: 'job-evidence-conflict', fingerprint: null, interrupt: false}]
  ] as [string, Parameters<typeof decide>[0], RetroactiveDecision<string>][])('decides %s as a root that interrupts no other trip', (_name, overrides, expected) => {
    expect(decide(overrides)).toEqual(expected);
  });
  it('returns the gate result before any candidate is considered', () => {
    expect(decideRetroactive({...clear, ownRootBound: true}, {recordedJob: INCIDENT_JOB, consistent: true, candidates: [match('A')]}, () => { throw new Error('not read'); }, 7n))
      .toEqual(separate('published'));
  });
});

describe('REG-005/REG-008 owner-attested repair join of a closed proof-less segment', () => {
  const attested: RepairJoinFacts = {decision: null, attested: true, ownRootBound: false};
  const target = (values: Record<string, Partial<RepairTargetFacts>>) => (ref: string): RepairTargetFacts => ({latest: 5n, latestOpen: false, intervening: false, ...values[ref]});
  const decide = (facts: Partial<RepairJoinFacts> = {}, evidence: Partial<{recordedJob: typeof INCIDENT_JOB; consistent: boolean; candidates: MembershipCandidate<string>[]}> = {},
    targets: Record<string, Partial<RepairTargetFacts>> = {}) =>
    decideRepairJoin({...attested, ...facts}, {recordedJob: INCIDENT_JOB, consistent: true, candidates: [match('A')], ...evidence}, target(targets), 7n);
  const notEligible = (reason: Extract<RepairJoinDecision<string>, {state: 'not-eligible'}>['reason']): RepairJoinDecision<string> => ({state: 'not-eligible', reason});
  it('joins the one compatible candidate of an attested segment without a decision row', () => {
    expect(decide()).toEqual({state: 'joined', target: 'A', fingerprint: F});
  });
  it('joins an attested separate/process-ended segment', () => {
    expect(decide({decision: {state: 'separate', reason: 'process-ended'}})).toEqual({state: 'joined', target: 'A', fingerprint: F});
  });
  it('lists an unattested segment as a candidate that needs the owner evidence', () => {
    expect(decide({attested: false})).toEqual({state: 'needs-attestation', target: 'A', fingerprint: F});
  });
  it('lists a bound segment as reconciliation-required, attested or not, and never joins it', () => {
    expect(decide({ownRootBound: true})).toEqual({state: 'reconciliation-required', target: 'A', fingerprint: F});
    expect(decide({ownRootBound: true, attested: false})).toEqual({state: 'reconciliation-required', target: 'A', fingerprint: F});
  });
  it('lists a separate/published segment and a bound segment with another decision as reconciliation-required, attested or not', () => {
    for (const attested of [true, false]) {
      expect(decide({attested, decision: {state: 'separate', reason: 'published'}})).toEqual({state: 'reconciliation-required', target: 'A', fingerprint: F});
      expect(decide({attested, ownRootBound: true, decision: {state: 'root', reason: 'no-candidate'}})).toEqual({state: 'reconciliation-required', target: 'A', fingerprint: F});
    }
  });
  it('lets a pending segment wait before any candidate is read', () => {
    expect(decideRepairJoin({...attested, decision: {state: 'pending', reason: 'profile-unverified'}}, {recordedJob: INCIDENT_JOB, consistent: true, candidates: [match('A')]},
      () => { throw new Error('not read'); }, 7n)).toEqual({state: 'wait', reason: 'pending'});
  });
  it.each([
    ['another separate reason', {decision: {state: 'separate', reason: 'profile-boundary'}}, {}, {}, notEligible('decided')],
    ['a separate/published segment without a candidate', {decision: {state: 'separate', reason: 'published'}}, {candidates: []}, {}, notEligible('no-candidate')],
    ['a root decision', {decision: {state: 'root', reason: 'no-candidate'}}, {}, {}, notEligible('decided')],
    ['two candidates', {}, {candidates: [match('A'), match('B')]}, {}, notEligible('ambiguous-candidates')],
    ['no candidate', {}, {candidates: []}, {}, notEligible('no-candidate')],
    ['an incompatible candidate', {}, {candidates: [match('A', false)]}, {}, notEligible('no-candidate')],
    ['inconsistent learned offer fields', {}, {consistent: false}, {}, notEligible('job-evidence-conflict')],
    ['a recorded job without a deadline', {}, {recordedJob: INCIDENT_JOB_WITHOUT_DEADLINE}, {}, notEligible('deadline-unavailable')],
    ['a recorded job with the u32 maximum deadline', {}, {recordedJob: INCIDENT_JOB_U32_MAX_DEADLINE}, {}, notEligible('deadline-unavailable')],
    ['a recorded job without cargo', {}, {recordedJob: missingCargo}, {}, notEligible('recorded-job-incomplete')],
    ['a target that continued at the segment', {}, {}, {A: {latest: 7n}}, notEligible('out-of-order')],
    ['a target that continued after the segment', {}, {}, {A: {latest: 9n}}, notEligible('out-of-order')],
    ['a target whose latest member is open', {}, {}, {A: {latestOpen: true}}, notEligible('target-open')],
    ['another trip between the target and the segment', {}, {}, {A: {intervening: true}}, notEligible('intervening-trip')],
    ['an out-of-order bound segment', {ownRootBound: true}, {}, {A: {latest: 9n}}, notEligible('out-of-order')]
  ] as [string, Partial<RepairJoinFacts>, Parameters<typeof decide>[1], Record<string, Partial<RepairTargetFacts>>, RepairJoinDecision<string>][])(
    'does not join %s', (_name, facts, evidence, targets, expected) => {
      expect(decide(facts, evidence, targets)).toEqual(expected);
    });
});
