import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {beginUploadFold,advanceUploadFold,finishUploadFold,isUploadPageQuery, isUploadProjection, isUploadProjectionPage, mapUploadProjection,
  type UploadMember, type UploadProjection, type UploadProjectionPage, type UploadSummary} from '../../packages/storage/src/upload-projection';
import {ETS2_A, ETS2_B, job} from '../shared/trip-messages';

const golden = JSON.parse(readFileSync('tests/fixtures/dashboard-upload/continued-summary.json','utf8')) as {expected: UploadSummary};
const root = '70000000-0000-4000-8000-000000000001', child = '70000000-0000-4000-8000-000000000002', db = '50000000-0000-4000-8000-000000000001';
const absent = {available:false,reason:'not-observed'} as const;
function fixture() {
  const occurrence = {pluginSessionId:ETS2_A,rawTripUuid:root,eventSeq:'1200',type:'job.configured',utcMs:1000};
  const pin: UploadProjection = {requestedTripUuid:root,rootTripUuid:root,readiness:'ready',rootReadiness:'ready',databaseUuid:db,purpose:'history',revision:'5',
    snapshot:`u2:${db}:${child}:80000000-0000-4000-8000-000000000001:${root}:5`,totals:{members:2,configurations:1,intervals:0},bounds:{members:'2',events:'20',gaps:'0',samples:'0',intervals:'0',accountingHead:null},
    facts:{game:'ets2',pluginSessionId:ETS2_A,outcome:'delivered',closeReason:'outcome',recordingCompleteness:'partial',openedBy:'event',checkpointNextEventSeq:null,checkpointUtcMs:null,
      opening:occurrence,outcomeOccurrence:{pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'3',type:'job.delivered',utcMs:2000},close:null,
      gameMode:{mode:'unknown',method:'none',confidence:'none',ambiguous:false},job:job({expectedIncome:{available:true,value:{raw:'18446744073709551615',sdkType:'u64',currency:{status:'unknown'}}}}),
      observedDistance:{available:true,value:0,unit:'m'},fuelUsed:{...absent,unit:'L'},deliveredDistance:{available:true,value:151250.5,unit:'m'},cargoDamage:{available:true,value:0.0125,unit:'fraction'},
      revenue:{available:true,value:{raw:'-9223372036854775808',sdkType:'s64',currency:{status:'unknown'}}},penalty:absent,moneyIncomplete:false,clockAnomaly:false}};
  const members: UploadMember[] = [root,child].map((rawTripUuid,index) => ({id:String(index+1),rawTripUuid,pluginSessionId:index?ETS2_B:ETS2_A,game:'ets2',origin:'game',versions:golden.expected.snapshot.context.versions}));
  const pages: UploadProjectionPage[] = [
    {snapshot:pin.snapshot,kind:'members',cursor:null,nextCursor:null,total:2,rows:members},
    {snapshot:pin.snapshot,kind:'configurations',cursor:null,nextCursor:null,total:1,rows:[{id:'2',occurrence:{...occurrence,eventSeq:'1201',type:'trailer.configured'},index:0,idValue:{available:true,value:'curtainsider'},bodyType:absent,chainType:absent}]},
    {snapshot:pin.snapshot,kind:'intervals',cursor:null,nextCursor:null,total:0,rows:[]}
  ];
  return {pin,pages};
}
function mapped(f = fixture()) {const result = mapUploadProjection(f.pin,f.pages); expect(result.status).toBe('projected'); if(result.status!=='projected')throw new Error(result.reason);return result;}

describe('private Dashboard summary projection', () => {
  it('matches independently authored v1.0 source/snapshot, preserves exact SDK money and selected availability', () => {
    const f=fixture();expect(isUploadProjection(f.pin)).toBe(true);expect(mapped(f).summary).toEqual(golden.expected);
    expect(mapped(f).provenance.outcome).toMatchObject({pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'3'});
  });
  it.each(['3','1200'])('keeps native final sequence %s in its own session without cross-session ordering', seq => {
    const f=fixture();f.pin.facts.outcomeOccurrence!.eventSeq=seq;const value=mapped(f);
    expect(value.summary.source.pluginSessionId).toBe(ETS2_A);expect(value.summary.snapshot.start.eventSeq).toBe('1200');expect(value.summary.snapshot.end?.eventSeq).toBe(seq);
    expect(value.summary.snapshot.evidence.endObserved).toBe(true);
  });
  it('keeps the qualified continued member on an unknown-outcome close', () => {
    const f=fixture();Object.assign(f.pin.facts,{outcome:'none',closeReason:'different-job',outcomeOccurrence:null,
      close:{pluginSessionId:ETS2_B,rawTripUuid:child,eventSeq:'4',type:'job.configured',utcMs:2000}});
    const value=mapped(f);expect(value.provenance.close).toEqual(f.pin.facts.close);
    expect(value.summary.snapshot.end).toEqual({utcMs:2000,basis:'event',eventSeq:'4'});expect(value.summary.snapshot.evidence.endObserved).toBe(false);
  });
  it.each(['unknown-trip','wrong-member-session','open-close','outcome-member','invalid-type'] as const)('holds malformed close provenance: %s', fault => {
    const f=fixture();f.pin.facts.close={...f.pin.facts.outcomeOccurrence!};
    if(fault==='unknown-trip')f.pin.facts.close.rawTripUuid=db;
    if(fault==='wrong-member-session')Object.assign(f.pin.facts,{outcome:'none',closeReason:'different-job',outcomeOccurrence:null,
      close:{...f.pin.facts.close,rawTripUuid:root}});
    if(fault==='open-close')Object.assign(f.pin.facts,{outcome:'open',closeReason:null,outcomeOccurrence:null});
    if(fault==='outcome-member')Object.assign(f.pin.facts.close,{rawTripUuid:root,pluginSessionId:ETS2_A});
    if(fault==='invalid-type')f.pin.facts.close.type='unrecognized';
    expect(mapUploadProjection(f.pin,f.pages)).toEqual({status:'hold',reason:'evidence-contradictory'});
  });
  it('preserves a restart carrier from a later session that closes an earlier raw member', () => {
    const f=fixture();Object.assign(f.pin.facts,{outcome:'none',closeReason:'restart',outcomeOccurrence:null,
      close:{pluginSessionId:db,rawTripUuid:root,eventSeq:'1',type:'job.configured',utcMs:2000}});
    expect(mapped(f).provenance.close).toEqual(f.pin.facts.close);
  });
  it('keeps a checkpoint start unobserved despite a later observed member and supports cancellation', () => {
    const f=fixture();Object.assign(f.pin.facts,{openedBy:'checkpoint',opening:null,checkpointNextEventSeq:'1200',checkpointUtcMs:900,outcome:'cancelled',penalty:{available:true,value:{raw:'0',sdkType:'s64',currency:{status:'unknown'}}}});
    f.pin.facts.outcomeOccurrence!.type='job.cancelled';const s=mapped(f).summary.snapshot;
    expect(s.start).toEqual({utcMs:900,basis:'checkpoint',eventSeq:null});expect(s.evidence.startObserved).toBe(false);expect(s.openedEventSeq).toBeNull();expect(s.penalty).toMatchObject({available:true,value:{raw:'0'}});
  });
  it.each(['synthetic','replay'] as const)('excludes %s without relabeling its evidence', purpose => {
    const f=fixture();f.pin.purpose=purpose;expect(mapUploadProjection(f.pin,f.pages)).toEqual({status:'hold',reason:'source-ineligible'});
  });
  it('holds identity-pending roots and incomplete/mixed pages', () => {
    const f=fixture();f.pin.readiness=f.pin.rootReadiness='identity-pending';expect(mapUploadProjection(f.pin,f.pages)).toEqual({status:'hold',reason:'identity-pending'});
    f.pin.readiness=f.pin.rootReadiness='ready';expect(mapUploadProjection(f.pin,f.pages.slice(0,2))).toEqual({status:'hold',reason:'evidence-incomplete'});
    f.pages[0].snapshot=f.pin.snapshot.replace(/:5$/,':6');expect(mapUploadProjection(f.pin,f.pages)).toEqual({status:'hold',reason:'evidence-incomplete'});
  });
  it('folds all historical trailers and intervals without exposing private rows or claiming a current chain', () => {
    const f=fixture();f.pin.totals.configurations=11;f.pin.totals.intervals=51;f.pin.snapshot=`u2:${db}:${child}:80000000-0000-4000-8000-000000000001:${root}:5`;
    const config=f.pages[1].rows[0];f.pages[1].rows=Array.from({length:11},(_,i)=>({...config,id:String(i+1)}));f.pages[1].total=11;
    f.pages[2].rows=Array.from({length:51},(_,i)=>({id:String(i+1),rawTripUuid:root,pluginSessionId:ETS2_A,kind:'event-loss'}));f.pages[2].total=51;
    for(const page of f.pages)page.snapshot=f.pin.snapshot;
    const value=mapped(f);expect(value.summary.snapshot.trailers).toEqual({complete:false,items:[]});
    expect(value.summary.snapshot.evidence.reasons).toEqual(['recording-intervals','trailer-context-changed','trailer-context-unproven']);
    const wire=JSON.stringify(value.summary);for(const key of ['rawTripUuid','proof','profile','samples','position','occurrence','revision','accountingHead'])expect(wire).not.toContain(`"${key}"`);
  });
  it('preserves native terminal money despite aggregate uncertainty and keeps anomalous UTC unknown', () => {
    const f=fixture();f.pin.facts.moneyIncomplete=true;f.pin.facts.opening!.utcMs=3000;const s=mapped(f).summary.snapshot;
    expect(s.observedDistance).toEqual({available:true,value:0,unit:'m'});expect(s.revenue).toEqual(f.pin.facts.revenue);expect(s.penalty).toEqual(absent);
    expect(s.evidence).toMatchObject({startObserved:false,endObserved:false,clockAnomaly:true});expect(s.evidence.reasons).toContain('accounting-unavailable');
    f.pin.facts.opening!.utcMs=Number.MAX_SAFE_INTEGER;expect(mapped(f).summary.snapshot.start).toEqual({utcMs:null,basis:'unknown',eventSeq:null});
  });
  it.each(['0','-9223372036854775808','9223372036854775807'])('preserves exact native cancellation penalty %s with uncertain aggregate accounting', raw => {
    const f=fixture();Object.assign(f.pin.facts,{outcome:'cancelled',revenue:absent,moneyIncomplete:true,
      penalty:{available:true,value:{raw,sdkType:'s64',currency:{status:'unknown'}}}});
    f.pin.facts.outcomeOccurrence!.type='job.cancelled';const s=mapped(f).summary.snapshot;
    expect(s.penalty).toEqual(f.pin.facts.penalty);expect(s.revenue).toEqual(absent);expect(s.evidence.reasons).toContain('accounting-unavailable');
  });
  it.each(['oversized','negative','money','mode','private-field'] as const)('holds contradictory or unrepresentable evidence: %s', fault => {
    const f=fixture();if(fault==='oversized')f.pin.facts.job.cargo={available:true,value:'я'.repeat(129)};
    if(fault==='negative')f.pin.facts.observedDistance={available:true,value:-1,unit:'m'};
    if(fault==='money')f.pin.facts.revenue={available:true,value:{raw:'9223372036854775808',sdkType:'s64',currency:{status:'unknown'}}};
    if(fault==='mode')f.pin.facts.gameMode={mode:'unknown',method:'module-scan',confidence:'weak',ambiguous:false};
    if(fault==='private-field')Object.assign(f.pin.facts.job,{proof:'private'});
    expect(mapUploadProjection(f.pin,f.pages).status).toBe('hold');
  });
  it('strictly binds page kind, revision, database and position and rejects malformed success rows', () => {
    const f=fixture(),query={snapshot:f.pin.snapshot,kind:'members' as const,limit:1};
    expect(isUploadPageQuery(query)).toBe(true);
    for(const bad of [{...query,limit:101},{...query,limit:0},{...query,cursor:`${query.snapshot}:intervals:1`},{...query,cursor:`${query.snapshot}:members:01`},
      {...query,snapshot:query.snapshot.slice(0,query.snapshot.lastIndexOf(':'))},{...query,snapshot:`${query.snapshot.slice(0,-1)}A`},{...query,extra:true}])expect(isUploadPageQuery(bad)).toBe(false);
    expect(isUploadProjectionPage(f.pages[0],query)).toBe(false);
    const page={...f.pages[0],rows:f.pages[0].rows.slice(0,1),nextCursor:`${query.snapshot}:members:1`};expect(isUploadProjectionPage(page,query)).toBe(true);
    expect(isUploadProjectionPage({...page,rows:[{...page.rows[0],extra:true}]},query)).toBe(false);
  });
});

it('REG-004/009 folds independently expected pages with constant state and refuses missing/out-of-order pages',()=>{
  const f=fixture();let fold=beginUploadFold(f.pin);
  expect(finishUploadFold(f.pin,fold)).toEqual({status:'hold',reason:'evidence-incomplete'});
  expect(advanceUploadFold(f.pin,fold,f.pages[1],()=>true).invalid).toBe('evidence-incomplete');
  for(const page of f.pages)fold=advanceUploadFold(f.pin,fold,page,(trip,session)=>trip===root&&session===ETS2_A);
  expect(finishUploadFold(f.pin,fold)).toMatchObject({status:'projected',summary:golden.expected});
  const many=fixture();many.pin.totals.members=10_001;many.pages[0].total=10_001;fold=beginUploadFold(many.pin);
  for(let offset=0;offset<10_001;offset+=100){const rows=Array.from({length:Math.min(100,10_001-offset)},(_,i)=>({...many.pages[0].rows[0],id:String(offset+i+1)}));const end=offset+rows.length;
    fold=advanceUploadFold(many.pin,fold,{...many.pages[0],cursor:offset?`${many.pin.snapshot}:members:${offset}`:null,nextCursor:end<10_001?`${many.pin.snapshot}:members:${end}`:null,rows},()=>true);
    expect(JSON.stringify(fold).length).toBeLessThan(2500);expect(fold.items.length).toBeLessThanOrEqual(10);
  }
  expect(fold.counts.members).toBe(10_001);expect(fold.kind).toBe(1);
});


describe('TEL-034 stored whole-trip rule context',()=>{
  function complete(coupling=false){
    const f=fixture();f.pin.ruleContext={version:2,status:'proven',recordingLoss:false,items:[{index:0,id:{available:true,value:'trailer-a'},bodyType:{available:true,value:'curtainsider'},chainType:absent},
      ...(coupling?[{index:1,id:{available:true as const,value:'trailer-b'},bodyType:absent,chainType:absent}]:[])]};return f;
  }
  it.each([false,true])('projects a proven unchanged chain including first-slot-only coupling types (%s)',coupling=>{
    const f=complete(coupling);f.pin.facts.moneyIncomplete=false;f.pin.facts.clockAnomaly=true;f.pin.facts.gameMode.ambiguous=true;
    f.pin.facts.job.cargoMass={available:true,value:0,unit:'kg'};
    const summary=mapped(f).summary.snapshot;
    expect(summary.trailers.complete).toBe(true);expect(summary.trailers.items).toHaveLength(coupling?2:1);
    expect(summary.evidence).toMatchObject({ruleContextComplete:true,reasons:[],clockAnomaly:true});
    expect(summary.gameMode.ambiguous).toBe(true);expect(summary.cargoDamage).toEqual(f.pin.facts.cargoDamage);
    let fold=beginUploadFold(f.pin);for(const page of f.pages)fold=advanceUploadFold(f.pin,fold,page,()=>true);
    expect(finishUploadFold(f.pin,fold)).toEqual(mapUploadProjection(f.pin,f.pages));
    delete fold.ruleContextVersion;
    const legacy=finishUploadFold(f.pin,fold);expect(legacy).toMatchObject({status:'projected',summary:{snapshot:{trailers:{complete:false},evidence:{ruleContextComplete:false}}}});
  });
  it.each([false,true])('retains accounting uncertainty independently of proven trailers and exact native amounts (%s)',moneyIncomplete=>{
    const f=complete(true);f.pin.facts.moneyIncomplete=moneyIncomplete;
    f.pin.facts.penalty={available:true,value:{raw:'0',sdkType:'s64',currency:{status:'unknown'}}};
    f.pin.facts.fuelUsed={available:true,value:12,unit:'L'};
    const summary=mapped(f).summary.snapshot;
    expect(summary.trailers.complete).toBe(true);expect(summary.trailers.items).toHaveLength(2);
    expect(summary.evidence).toMatchObject({ruleContextComplete:!moneyIncomplete,reasons:moneyIncomplete?['accounting-unavailable']:[]});
    expect(summary.revenue).toEqual({available:true,value:{raw:'-9223372036854775808',sdkType:'s64',currency:{status:'unknown'}}});
    expect(summary.penalty).toEqual({available:true,value:{raw:'0',sdkType:'s64',currency:{status:'unknown'}}});
    expect(summary.expectedIncome).toEqual({available:true,value:{raw:'18446744073709551615',sdkType:'u64',currency:{status:'unknown'}}});
    expect(summary.observedDistance).toEqual({available:true,value:0,unit:'m'});expect(summary.fuelUsed).toEqual({available:true,value:12,unit:'L'});
    let fold=beginUploadFold(f.pin);for(const page of f.pages)fold=advanceUploadFold(f.pin,fold,page,()=>true);
    expect(finishUploadFold(f.pin,fold)).toEqual(mapUploadProjection(f.pin,f.pages));
  });
  it('keeps a retained version1 proven result unproven because it did not examine job-prefix evidence',()=>{
    const f=complete();f.pin.ruleContext!.version=1;expect(isUploadProjection(f.pin)).toBe(true);
    expect(mapped(f).summary.snapshot).toMatchObject({trailers:{complete:false},evidence:{ruleContextComplete:false,reasons:['trailer-context-unproven']}});
  });
  it.each(['sourceCityId','destinationCityId','cargoId','cargoMass'] as const)('requires stored %s while leaving catalog and ADR resolution to Dashboard',key=>{
    const f=complete();Object.assign(f.pin.facts.job,{[key]:key==='cargoMass'?{...absent,unit:'kg'}:absent});
    expect(mapped(f).summary.snapshot.evidence.ruleContextComplete).toBe(false);
    expect(mapped(f).summary.snapshot.evidence.reasons).toEqual([key==='cargoMass'?'cargo-mass-unavailable':'job-context-unavailable']);
  });
  it.each(['changed','unavailable','unproven'] as const)('preserves the bounded %s reason',status=>{
    const f=complete();f.pin.ruleContext!.status=status;f.pin.ruleContext!.items=[];
    expect(mapped(f).summary.snapshot.evidence).toMatchObject({ruleContextComplete:false,reasons:[`trailer-context-${status}`]});
  });
  it('rejects a complete proof with missing IDs/type, invalid slots or recording loss',()=>{
    for(const change of [({pin}:ReturnType<typeof complete>)=>{pin.ruleContext!.version='2' as never;},
      ({pin}:ReturnType<typeof complete>)=>{pin.ruleContext!.items[0].bodyType=absent;},
      ({pin}:ReturnType<typeof complete>)=>{pin.ruleContext!.items[0].id={available:true,value:''};},
      ({pin}:ReturnType<typeof complete>)=>{pin.ruleContext!.recordingLoss=true;}]){
      const f=complete();change(f);expect(isUploadProjection(f.pin)).toBe(false);
    }
  });
});
