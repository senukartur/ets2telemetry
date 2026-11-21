import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {initialQualificationState,isQualificationState,type QualificationSnapshot,type QualificationPreview} from '../../packages/contracts/src/qualification';
import {validateJournalTripDetail} from '../../packages/contracts/src/journal';
import {QualificationScreenView} from '../../apps/desktop/src/qualification/screen';
import {JournalQualificationResult} from '../../apps/desktop/src/qualification/journal-result';
import {qualificationKilometres,qualificationRuleRows} from '../../apps/desktop/src/qualification/view';
import {SidebarNav} from '../../apps/desktop/src/shell/sidebar-nav';
import {DETAIL} from '../shared/journal-replies';
import {TripExportSerializer,tripExportHeader} from '../../apps/desktop/src/journal-export';
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {schema:string;value:unknown}[];
const snapshot=fixtures.find(f=>f.schema==='Qualification')!.value as QualificationSnapshot;
const owner={origin:'https://dashboard.example',accountId:snapshot.ownerId,companyId:'c',identityEpoch:'e'};
describe('qualification presentation (REG-009/014/016)',()=>{
  it('names the historical assessed level when current assignment and active-trip assignment differ',()=>{
    const current=structuredClone(snapshot);current.assignment!.level.name='Current level A';
    const preview=structuredClone(fixtures.find(f=>f.schema==='Preview')!.value) as QualificationPreview;
    preview.basis='historical_assignment';preview.assignment!.id='00000000-0000-4000-8000-000000000099';preview.assignment!.level.name='Assessed level B';
    const state={...initialQualificationState('ets2',owner),snapshot:current,preview,activeJob:true};
    const html=renderToStaticMarkup(React.createElement(QualificationScreenView,{state,language:'en',onGame:()=>undefined,onRefresh:()=>undefined}));
    expect(html).toContain('Current level A');expect(html).toContain('Assessed level: Assessed level B');expect(html).toContain('Assignment at actual trip start');
  });
  it('shows the current Hard Mode check in the active-trip requirements',()=>{
    const preview=structuredClone(fixtures.find(f=>f.schema==='Preview')!.value) as QualificationPreview;
    const state={...initialQualificationState('ets2',owner),snapshot,preview,activeJob:true};
    const render=(hardMode:'pass'|'unknown')=>renderToStaticMarkup(React.createElement(QualificationScreenView,{state,hardMode,language:'en',onGame:()=>undefined,onRefresh:()=>undefined}));
    expect(render('unknown')).toContain('Hard Mode audit is not final');
    expect(render('pass')).toMatch(/data-testid="qualification-rule-hard_mode".*?Observed: <\/span>Current settings pass.*?data-state="pass"/);
    expect(render('pass')).not.toContain('Hard Mode audit is not final');
  });
  it.each(['en','ru'] as const)('shows server totals, five named limits and no invented no-job verdict in %s',language=>{
    const state={...initialQualificationState('ets2',owner),snapshot,availability:'ready' as const,stale:false};
    const html=renderToStaticMarkup(React.createElement(QualificationScreenView,{state,language,onGame:()=>undefined,onRefresh:()=>undefined}));
    expect(html.match(/<progress /g)).toHaveLength(2);expect(html.match(/data-testid="qualification-rule-/g)).toHaveLength(5);expect(html).toContain('lucide-medal');expect(html).not.toContain('qualification-check');
    expect(qualificationRuleRows(snapshot.assignment!.limits,null,[],language)[1].limit).toBe(language==='ru'?'100–500 км':'100–500 km');
    const terminal=structuredClone(state);Object.assign(terminal.snapshot.progress!,{terminal:true,nextLevel:null,remainingTrips:null,remainingDistanceM:null});
    expect(renderToStaticMarkup(React.createElement(QualificationScreenView,{state:terminal,language,onGame:()=>undefined,onRefresh:()=>undefined}))).not.toContain('<progress ');
  });
  it('keeps conversion exact and rejects a foreign snapshot owner',()=>{
    expect(qualificationKilometres('200000.125')).toBe('200.000125');expect(qualificationKilometres('0.000000000000000001')).toBe('0.000000000000000000001');
    const state={...initialQualificationState('ets2',owner),snapshot};expect(isQualificationState(state)).toBe(true);expect(isQualificationState({...state,owner:{...owner,accountId:'foreign'}})).toBe(false);
  });
  it('leaves the existing export bytes unchanged when safe qualification decorations are present',()=>{
    const header=tripExportHeader({uuid:'50000000-0000-4000-8000-000000000001',purpose:'history',schemaVersion:11},'test',1000);
    const source=validateJournalTripDetail(DETAIL),detail={...source,qualification:{owner,connectionVersion:'1',row:{tripUuid:source.trip.tripUuid,state:'sent' as const,materialVersion:'1',latestRevision:1,lastDurableUploadUtcMs:1,reason:null,qualification:{current:null,previous:null,awaiting:true}}}};
    expect(new TripExportSerializer(detail,header).begin()).toBe(new TripExportSerializer(source,header).begin());
  });
  it('shows the retained previous explanation independently of latest company review metadata',()=>{
    const result=fixtures.filter(f=>f.schema==='ResultBatch').flatMap(f=>(f.value as import('../../packages/contracts/src/qualification').QualificationWire['ResultBatch']).items).find(item=>item.assessmentBasis==='current')!;
    const latest={companyDecision:'pending_review' as const,credit:null};
    const row={tripUuid:result.source.tripId,state:'sent' as const,materialVersion:'1',latestRevision:1,lastDurableUploadUtcMs:1,reason:null,qualification:{current:null,previous:result,latest,awaiting:true}};
    const html=renderToStaticMarkup(React.createElement(JournalQualificationResult,{row,language:'en'}));
    expect(html).toContain('qualification-previous');expect(html).not.toContain('data-testid="qualification-assessment"');expect(html).toContain('Pending review');
  });
  it('only exposes connected qualification navigation and uses Lucide Medal',()=>{
    const props={route:'live' as const,language:'en' as const,onNavigate:()=>undefined};
    expect(renderToStaticMarkup(React.createElement(SidebarNav,props))).not.toContain('tab-qualification');
    const html=renderToStaticMarkup(React.createElement(SidebarNav,{...props,qualification:true}));expect(html).toContain('tab-qualification');expect(html).toContain('lucide-medal');
  });
});
