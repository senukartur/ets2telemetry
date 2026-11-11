import {describe, expect, it} from 'vitest';
import {continuationFingerprint} from '../../packages/telemetry-core/src/trips/continuation';
import {decideMembership, type MembershipCandidate, type MembershipDecision, type MembershipEvidence} from '../../packages/telemetry-core/src/trips/membership';
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
    expect(continuationFingerprint(INCIDENT_JOB_WITHOUT_DEADLINE)).toBeNull();
    expect(continuationFingerprint(INCIDENT_JOB_U32_MAX_DEADLINE)).toBeNull();
    expect(continuationFingerprint({...INCIDENT_JOB, deliveryDeadline: {available: true, value: '4294967294', unit: 'min'}})).not.toBeNull();
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
