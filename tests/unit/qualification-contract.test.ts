import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {compareQualificationCounter, compareQualificationDecimal, isQualificationDecimal, qualificationPercentage, isQualificationWire, qualificationResultMatches, qualificationDecisionJson, type QualificationWire} from '../../packages/contracts/src/qualification';

// Synthetic VTC-164 fixtures, pinned at 0c07292c396c4e093ee7c91eff534f4685fac853.
const fixtures = JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {name:string;schema:keyof QualificationWire;value:unknown}[];
const results=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items);
describe('reviewed companion contract (REG-010)',()=>{
  for(const fixture of fixtures) it(fixture.name,()=>{
    expect(isQualificationWire(fixture.schema,fixture.value)).toBe(true);
    expect(isQualificationWire(fixture.schema,{...fixture.value as object,privateNotes:'forbidden'})).toBe(false);
    if(fixture.schema==='ResultBatch')for(const result of (fixture.value as QualificationWire['ResultBatch']).items){
      // This pinned fictional review claims receipt without its required exact message identity; fail closed.
      expect(qualificationResultMatches(result,{source:result.source,eventId:result.requestedEventId,revision:result.requestedRevision,...(result.unchanged?{ifVersion:result.version}:{})})).toBe(fixture.name!=='fictional-ResultBatch-11');
    }
  });
  it('cannot turn a decision on another canonical source into a current local assessment',()=>{
    const result=structuredClone(results.find(result=>result.assessmentBasis==='current')!);
    const request={source:result.source,eventId:result.requestedEventId,revision:result.requestedRevision};
    expect(qualificationResultMatches(result,request)).toBe(true);
    result.assessment!.assessedSource={...result.source,tripId:'00000000-0000-4000-8000-000000000099'};
    expect(qualificationResultMatches(result,request)).toBe(false);
    result.assessmentBasis='predecessor';
    expect(qualificationResultMatches(result,request)).toBe(true);
  });
  it('compares immutable assessment facts independently of refreshable current-catalog labels',()=>{
    const result=structuredClone(results.find(result=>result.assessment)!);
    const before=qualificationDecisionJson(result),rules=structuredClone(result.assessment!.rules);
    result.assessment!.trailerDisplay=[{id:'00000000-0000-4000-8000-000000000099',basis:'current_catalog',asOf:'2026-11-18T01:00:00.000Z',code:'flatbed',groupCode:null,nameEn:'Current label',nameRu:null}];
    expect(qualificationDecisionJson(result)).toBe(before);
    expect(result.assessment!.rules).toEqual(rules);
    result.assessment!.eventExempt=!result.assessment!.eventExempt;
    expect(qualificationDecisionJson(result)).not.toBe(before);
  });
});

describe('qualification exact quantities (REG-009/010)', () => {
  it('orders counters beyond safe integers without rounding', () => {
    expect(compareQualificationCounter('9007199254740993', '9007199254740992')).toBe(1);
    expect(compareQualificationCounter('10', '9')).toBe(1);
    expect(compareQualificationCounter('0', '0')).toBe(0);
    expect(() => compareQualificationCounter('01', '1')).toThrow();
  });
  it('distinguishes zero, unavailable and minimum exact decimal changes', () => {
    expect(compareQualificationDecimal('0', '0.000000000000000001')).toBe(-1);
    expect(compareQualificationDecimal('99999999999999999999.999999999999999998', '99999999999999999999.999999999999999999')).toBe(-1);
    for (const value of [null, 0, '00', '1.0', '-1', '1e3', '100000000000000000000', '0.0000000000000000001']) expect(isQualificationDecimal(value)).toBe(false);
  });
  it('does not invent a progress target and bounds only the display ratio', () => {
    expect(qualificationPercentage('1', null)).toBeNull();
    expect(qualificationPercentage('0', '0')).toBe(100);
    expect(qualificationPercentage('4', '3')).toBe(100);
    expect(qualificationPercentage('0.999999999999999999', '1')).toBe(99.99);
  });
});
