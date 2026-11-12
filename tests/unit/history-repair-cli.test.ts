// ET-112g (REG-014): the history repair tool's arguments, confirmation code and text report. Node-safe: the storage
// orchestration itself is covered by tests/storage/history-repair.test.ts. Every expected value is written by hand.
import {createHash} from 'node:crypto';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import type {RepairPlan, RepairSummary} from '../../packages/storage/src/api';
import {canonicalJson, parseRepairPlan, repairConfirmationCode} from '../../packages/storage/src/history-repair-plan';
import {checkConfirmation, parseArguments, UsageError} from '../../tools/history-repair/src/arguments';
import {planLines, resultLines} from '../../tools/history-repair/src/summary';

const CWD = path.resolve('/repair-work');
const S = '10000000-0000-4000-8000-000000000003', T = '10000000-0000-4000-8000-000000000001', F = 'a'.repeat(64);
const refused = (argv: string[], message: RegExp) => {
  expect(() => parseArguments(argv, CWD)).toThrow(UsageError);
  expect(() => parseArguments(argv, CWD)).toThrow(message);
};

describe('REG-014 history repair arguments', () => {
  it('parses each command with explicit paths resolved against the working directory', () => {
    expect(parseArguments(['copy', '--from', 'a.sqlite', '--to', 'b.sqlite'], CWD)).toEqual({command: 'copy', from: path.join(CWD, 'a.sqlite'), to: path.join(CWD, 'b.sqlite')});
    expect(parseArguments(['dry-run', '--database', 'a.sqlite', '--attest', S, '--out', 'plan.json', '--attest', S, '--attest', T], CWD))
      .toEqual({command: 'dry-run', database: path.join(CWD, 'a.sqlite'), out: path.join(CWD, 'plan.json'), attest: [S, T]});
    expect(parseArguments(['apply', '--database', 'a.sqlite', '--plan', 'plan.json', '--confirm', '0123abcd', '--working-history', '--backups', 'kept'], CWD))
      .toEqual({command: 'apply', database: path.join(CWD, 'a.sqlite'), plan: path.join(CWD, 'plan.json'), confirm: '0123abcd', workingHistory: true, backups: path.join(CWD, 'kept')});
    expect(parseArguments(['apply', '--database', 'a.sqlite', '--plan', 'plan.json', '--confirm', '0123abcd'], CWD)).toMatchObject({workingHistory: false});
  });
  it('refuses apply without --confirm and a confirmation that is not an 8-digit code', () => {
    refused(['apply', '--database', 'a.sqlite', '--plan', 'plan.json'], /--confirm is required/);
    refused(['apply', '--database', 'a.sqlite', '--plan', 'plan.json', '--confirm', '0123ABCD'], /8-digit code/);
  });
  it('refuses --working-history outside apply', () => {
    refused(['dry-run', '--database', 'a.sqlite', '--out', 'plan.json', '--working-history'], /only valid with apply/);
    refused(['copy', '--from', 'a.sqlite', '--to', 'b.sqlite', '--working-history'], /only valid with apply/);
  });
  it('refuses an --attest value that is not a full lowercase trip UUID', () => {
    refused(['dry-run', '--database', 'a.sqlite', '--out', 'plan.json', '--attest', '10000000'], /full lowercase trip UUID/);
    refused(['dry-run', '--database', 'a.sqlite', '--out', 'plan.json', '--attest', 'ABCDEF00-0000-4000-8000-00000000000A'], /full lowercase trip UUID/);
  });
  it('refuses an unknown command, an option of another command, a repeated path and a missing value', () => {
    refused(['restore', '--from', 'a.sqlite'], /^Usage:/);
    refused(['copy', '--from', 'a.sqlite', '--to', 'b.sqlite', '--attest', S], /^Usage:/);
    refused(['copy', '--from', 'a.sqlite', '--from', 'c.sqlite', '--to', 'b.sqlite'], /^Usage:/);
    refused(['copy', '--from', '--to', 'b.sqlite'], /^Usage:/);
    refused(['dry-run', '--database', 'a.sqlite'], /--out is required/);
  });
});

const summary = (overrides: Partial<RepairSummary> = {}): RepairSummary => ({outcome: 'delivered', recordingCompleteness: 'partial', sources: 3,
  distanceM: {available: false, reason: 'not-observed'}, fuelUsedL: {available: false, reason: 'not-observed'}, deliveredDistanceM: {available: true, value: 187342.01049804688},
  revenue: {available: true, value: {raw: '9978', sdkType: 's64'}}, hardMode: {passingChecks: 178, failingChecks: 0, unknownChecks: 74, qualified: true},
  upload: {bound: false, held: false, holdReason: null, identity: 'resolved'}, ...overrides});

describe('REG-014 history repair plan', () => {
  it('derives the confirmation code from the canonical JSON of the actions, keys sorted at every level', () => {
    // sha256("[]") = 4f53cda18c2baa0c...: the code of a plan without actions.
    expect(repairConfirmationCode([])).toBe('4f53cda1');
    const action = {kind: 'join', segmentTripUuid: S, targetTripUuid: T, fingerprint: F, before: {}, after: {b: 1, a: [2, {d: null, c: 'x'}]}} as unknown as RepairPlan['actions'][number];
    const canonical = `[{"after":{"a":[2,{"c":"x","d":null}],"b":1},"before":{},"fingerprint":"${F}","kind":"join","segmentTripUuid":"${S}","targetTripUuid":"${T}"}]`;
    expect(canonicalJson([action])).toBe(canonical);
    expect(repairConfirmationCode([action])).toBe(createHash('sha256').update(canonical).digest('hex').slice(0, 8));
  });
  const plan = (): RepairPlan => {
    const actions: RepairPlan['actions'] = [{kind: 'join', segmentTripUuid: S, targetTripUuid: T, fingerprint: F,
      before: {segment: summary({sources: 1, hardMode: {passingChecks: 0, failingChecks: 0, unknownChecks: 74, qualified: false}}),
        target: summary({outcome: 'open', recordingCompleteness: 'complete', sources: 2, deliveredDistanceM: null, revenue: null,
          hardMode: {passingChecks: 178, failingChecks: 0, unknownChecks: 0, qualified: false}, upload: {bound: true, held: false, holdReason: null, identity: 'resolved'}})},
      after: summary({upload: {bound: true, held: true, holdReason: 'reconciliation-required', identity: 'resolved'}})}];
    return {format: 'ets2telemetry-history-repair-1', databaseUuid: 'f0000000-0000-4000-8000-000000000009', schemaVersion: 10, createdUtcMs: 1, appVersion: 'test', attested: [S],
      actions, listings: [{segmentTripUuid: '10000000-0000-4000-8000-000000000006', targetTripUuid: '10000000-0000-4000-8000-000000000004', state: 'needs-attestation', reason: null},
        {segmentTripUuid: '10000000-0000-4000-8000-000000000007', targetTripUuid: null, state: 'not-eligible', reason: 'intervening-trip'}],
      confirmation: repairConfirmationCode(actions)};
  };
  it('accepts its own plan text and refuses a wrong or forged confirmation code', () => {
    const p = plan(), text = JSON.stringify(p);
    expect(parseRepairPlan(text)).toEqual(p);
    expect(() => checkConfirmation(text, p.confirmation)).not.toThrow();
    expect(() => checkConfirmation(text, p.confirmation === 'ffffffff' ? '00000000' : 'ffffffff')).toThrow(/does not match the plan/);
    const edited = {...p, actions: [{...p.actions[0], targetTripUuid: '10000000-0000-4000-8000-000000000002'}]};
    expect(() => checkConfirmation(JSON.stringify(edited), p.confirmation)).toThrow(/does not match the plan/);
    expect(() => checkConfirmation('{"format":"other"}', p.confirmation)).toThrow(/not a history repair plan/);
    expect(parseRepairPlan(JSON.stringify({...p, actions: [{...p.actions[0], fingerprint: 'short'}]}))).toBeUndefined();
  });
  it('reports the joins with their before and after values, the listings and the code', () => {
    const p = plan();
    expect(planLines(p)).toEqual([
      'Database f0000000-0000-4000-8000-000000000009, schema 10',
      'Joins to apply: 1',
      `  ${S} -> ${T}`,
      '    before, segment: delivered, recording partial, 1 recording, distance not-observed, fuel not-observed, game distance 187342.01049804688 m, revenue 9978 (s64), Hard Mode 0/0/74 not qualified, upload unbound, identity resolved',
      '    before, target:  open, recording complete, 2 recordings, distance not-observed, fuel not-observed, game distance none, revenue none, Hard Mode 178/0/0 not qualified, upload bound, identity resolved',
      '    after:           delivered, recording partial, 3 recordings, distance not-observed, fuel not-observed, game distance 187342.01049804688 m, revenue 9978 (s64), Hard Mode 178/0/74 qualified, upload bound, held (reconciliation-required), identity resolved',
      'Join candidates that need your evidence (rerun the dry run with --attest <segment uuid>): 1',
      '  10000000-0000-4000-8000-000000000006 -> 10000000-0000-4000-8000-000000000004',
      'Not eligible: 1',
      '  10000000-0000-4000-8000-000000000007 (intervening-trip)',
      `Confirmation code: ${p.confirmation}`
    ]);
    expect(resultLines({format: 'ets2telemetry-history-repair-result-1', databaseUuid: p.databaseUuid, backupFileName: 'repair-f0000000-v10-20261112T120000000Z.sqlite', confirmation: p.confirmation,
      completedUtcMs: 2, actions: [{segmentTripUuid: S, targetTripUuid: T, status: 'already-applied'}]})).toEqual([
      'Database f0000000-0000-4000-8000-000000000009, pre-repair backup repair-f0000000-v10-20261112T120000000Z.sqlite',
      `  ${S} -> ${T}: already-applied`
    ]);
  });
});
