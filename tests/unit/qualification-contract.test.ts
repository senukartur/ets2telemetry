import {describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {compareQualificationCounter, compareQualificationDecimal, isQualificationDecimal, qualificationPercentage, isQualificationWire, qualificationResultMatches, qualificationDecisionJson, qualificationPresentationJson, type QualificationWire} from '../../packages/contracts/src/qualification';

// Synthetic VTC-164 fixtures, pinned at be706fc329ed360e26e9a98c690fca8d30384101.
const fixtures = JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {name:string;schema:keyof QualificationWire;value:unknown}[];
const results=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as QualificationWire['ResultBatch']).items);
describe('reviewed companion contract (REG-010)',()=>{
  for(const fixture of fixtures) it(fixture.name,()=>{
    expect(isQualificationWire(fixture.schema,fixture.value)).toBe(true);
    expect(isQualificationWire(fixture.schema,{...fixture.value as object,privateNotes:'forbidden'})).toBe(false);
    if(fixture.schema==='ResultBatch')for(const result of (fixture.value as QualificationWire['ResultBatch']).items){
      expect(qualificationResultMatches(result,{source:result.source,eventId:result.requestedEventId,revision:result.requestedRevision,...(result.unchanged?{ifVersion:result.version}:{})})).toBe(true);
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
  it('requires exact receipt lineage even before a decision is complete',()=>{
    const original=results.find(result=>result.state==='processing')!,request={source:original.source,eventId:original.requestedEventId,revision:original.requestedRevision};
    expect(qualificationResultMatches(original,request)).toBe(true);
    for(const change of [{requestedSourceMessageId:null},{canonicalTripId:null},{latestSourceRevision:null},{latestSourceRevision:request.revision-1}])expect(qualificationResultMatches({...original,...change},request)).toBe(false);
  });
  it('rejects a claimed review receipt with missing exact lineage',()=>{
    const original=results.find(result=>result.state==='review'&&result.assessmentBasis==='none')!;
    const malformed={...original,requestedSourceMessageId:null,latestSourceRevision:null,canonicalTripId:null};
    expect(isQualificationWire('Result',malformed)).toBe(true);
    expect(qualificationResultMatches(malformed,{source:original.source,eventId:original.requestedEventId,revision:original.requestedRevision})).toBe(false);
  });
  it('accepts 110 display labels, rejects 111, and independently enforces the 1 MiB response ceiling',()=>{
    const result=structuredClone(results.find(result=>result.assessmentBasis==='current'&&result.assessment?.availability==='retained')!);
    const label={id:'00000000-0000-4000-8000-000000000099',basis:'current_catalog' as const,identityKind:'variant' as const,classification:{state:'unavailable' as const},asOf:'2026-11-18T01:00:00.000Z',code:'x'.repeat(128),groupCode:'g'.repeat(128),nameEn:'n'.repeat(256),nameRu:'я'.repeat(256)};
    result.assessment!.trailerDisplay=Array.from({length:110},()=>({...label}));expect(isQualificationWire('Result',result)).toBe(true);
    result.assessment!.trailerDisplay.push(label);expect(isQualificationWire('Result',result)).toBe(false);result.assessment!.trailerDisplay.pop();
    const batch=structuredClone(fixtures.find(f=>f.schema==='ResultBatch')!.value) as QualificationWire['ResultBatch'];
    batch.items=Array.from({length:5},()=>structuredClone(result));expect(isQualificationWire('ResultBatch',batch)).toBe(true);
    batch.items=Array.from({length:25},()=>structuredClone(result));expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeGreaterThan(1_048_576);expect(isQualificationWire('ResultBatch',batch)).toBe(false);
  });
  it('compares immutable assessment facts independently of refreshable current-catalog labels',()=>{
    const result=structuredClone(results.find(result=>result.assessment)!);
    const before=qualificationDecisionJson(result),rules=structuredClone(result.assessment!.rules);
    result.assessment!.trailerDisplay=[{id:'00000000-0000-4000-8000-000000000099',basis:'current_catalog',identityKind:'variant',classification:{state:'unavailable'},asOf:'2026-11-18T01:00:00.000Z',code:'flatbed',groupCode:null,nameEn:'Current label',nameRu:null}];
    result.version='new-current-catalog-view';
    expect(qualificationDecisionJson(result)).toBe(before);
    const presentation=qualificationPresentationJson(result);result.assessment!.trailerDisplay[0].asOf='2026-11-18T02:00:00.000Z';expect(qualificationPresentationJson(result)).toBe(presentation);
    result.assessment!.trailerDisplay[0].nameEn='Another label';expect(qualificationPresentationJson(result)).not.toBe(presentation);
    expect(result.assessment!.rules).toEqual(rules);
    result.assessment!.eventExempt=!result.assessment!.eventExempt;
    expect(qualificationDecisionJson(result)).not.toBe(before);
  });
  it('retains all 1010 saved comparison entries and distinguishes mapping from current classification',()=>{
    const result=structuredClone(results.find(result=>result.assessment?.trailerComparison?.entries.length===1010)!);
    expect(result.assessment!.trailerComparison!.entries).toHaveLength(1010);expect(isQualificationWire('Result',result)).toBe(true);
    const facts=qualificationDecisionJson(result);result.assessment!.trailerDisplay[0].classification={state:'unclassified'};expect(qualificationDecisionJson(result)).toBe(facts);
    result.assessment!.trailerComparison!.entries[0].comparisonIdentity='undefined';expect(qualificationDecisionJson(result)).not.toBe(facts);
    result.assessment!.trailerComparison!.entries.push(result.assessment!.trailerComparison!.entries[0]);expect(isQualificationWire('Result',result)).toBe(false);
  });
  it('enforces output scalar bounds without narrowing aggregate progress to an individual fact decimal',()=>{
    const aggregate=structuredClone(fixtures.find(f=>f.name==='owning-unsigned-condition-and-exact-aggregate-distance')!.value) as QualificationWire['Qualification'];
    expect(isQualificationWire('Qualification',aggregate)).toBe(true);expect(qualificationPercentage(aggregate.progress!.creditedDistanceM,'1')).toBe(100);
    expect(isQualificationWire('AggregateDecimal','9'.repeat(64))).toBe(true);expect(isQualificationWire('AggregateDecimal','9'.repeat(65))).toBe(false);expect(isQualificationWire('Decimal','9'.repeat(64))).toBe(false);
    expect(qualificationPercentage('0.'+'0'.repeat(61)+'1','1')).toBe(0);
    for(const trips of [0,4294967296]){const invalid=structuredClone(aggregate);invalid.progress!.conditions.requiredTrips=trips;expect(isQualificationWire('Qualification',invalid)).toBe(false);}
    aggregate.progress!.creditedTrips=Number.MAX_SAFE_INTEGER;expect(isQualificationWire('Qualification',aggregate)).toBe(true);aggregate.progress!.creditedTrips++;expect(isQualificationWire('Qualification',aggregate)).toBe(false);
    const result=structuredClone(results.find(result=>result.assessment)!);result.assessment!.decisionSequence=4294967295;expect(isQualificationWire('Result',result)).toBe(true);result.assessment!.decisionSequence++;expect(isQualificationWire('Result',result)).toBe(false);
    const time=structuredClone(fixtures.find(f=>f.schema==='Qualification')!.value) as QualificationWire['Qualification'];time.asOf='2026-11-18T01:00:00.0000Z';expect(isQualificationWire('Qualification',time)).toBe(false);
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
