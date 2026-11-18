import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {qualificationLeaseCue,type QualificationLease} from '../../apps/desktop/src/overlay-qualification';
import {previewDecimal,qualificationTrailerFacts,QualificationPreviewFacts,type PreviewStorage,type QualificationLive} from '../../apps/desktop/src/qualification/preview-facts';
import {trailer,Script,ETS2_A,job} from '../shared/trip-messages';
import type {UploadProjection} from '../../packages/storage/src/upload-projection';
import type {QualificationPreview,QualificationPreviewInput} from '../../packages/contracts/src/qualification';
const fixtures=JSON.parse(readFileSync('tests/fixtures/qualification/companion-v1.json','utf8')) as {name:string;value:unknown}[];
const fixture=<T>(name:string)=>structuredClone(fixtures.find(f=>f.name===name)!.value) as T;
describe('server provisional applicability timelines (REG-003/008/009/010)',()=>{
  it.each(['semantic-type-classified-pass','semantic-type-wrong-and-unclassified-fail','semantic-type-unclassified-unknown'])('keeps the corrected paired %s fixture inside its exact issued guard',name=>{
    const input=fixture<QualificationPreviewInput>(`${name}-body-code-input`),reply=fixture<QualificationPreview>(name);
    expect(input.actualDistance.metres).toBe('100000');expect(input.hardMode).toEqual({result:'qualified',final:true});expect(reply.applicability.minimumDistanceM).toBe('100000');
    expect(reply.requestId).toBe(input.requestId);expect(reply.rules.find(rule=>rule.rule==='hard_mode')?.result).toBe('pass');
    const lease:QualificationLease={reply,input,authority:reply.securityScope,dispatchMonotonicMs:0};expect(qualificationLeaseCue(lease,input,reply.securityScope,reply.applicability.qualificationRevision,1)).toBe(reply.outcome==='unknown'?'neutral':reply.outcome);
    const older=structuredClone(input);older.actualDistance.metres='99999';older.evidenceRevision++;expect(qualificationLeaseCue(lease,older,reply.securityScope,reply.applicability.qualificationRevision,1)).toBe('neutral');
  });
  it('separates growing evidence from context and releases its exact pin when an active job disappears during preparation',async()=>{
    const script=new Script(ETS2_A),checkpoint=script.checkpoint(job()),live:QualificationLive={source:{...checkpoint.source,origin:'game'},capture:checkpoint.capture,state:checkpoint.data.state};
    const root='70000000-0000-4000-8000-000000000001',authority={registrationId:'70000000-0000-4000-8000-000000000002',connectionVersion:'1'};
    let metres='0';
    const projection={rootTripUuid:root,purpose:'history',facts:{job:job(),opening:{utcMs:1000}}} as unknown as UploadProjection;
    const release=vi.fn((input:{pinId:string})=>Promise.resolve({ok:true as const,value:{pinId:input.pinId,state:'released' as const,examined:1,projection:null}}));
    const db={readQualificationPreview:()=>Promise.resolve({ok:true as const,value:{current:{tripUuid:root,rawTripUuid:root,materialVersion:'1',actualDistance:{availability:'known',metres,support:'whole-trip',final:false}}}}),beginQualificationPreview:vi.fn((input:{pinId:string})=>Promise.resolve({ok:true as const,value:{pinId:input.pinId,state:'ready',examined:1,projection}})),advanceQualificationPreview:vi.fn(),releaseQualificationPreview:release} as unknown as PreviewStorage;
    const facts=new QualificationPreviewFacts(db,authority);facts.observe(live);
    const first=await facts.read();expect(first?.actualDistance.metres).toBe('0');expect(first?.hardMode).toEqual({result:'unknown',final:false});
    metres='1';const next=await facts.read();expect(next?.contextRevision).toBe(first?.contextRevision);expect(next!.evidenceRevision).toBeGreaterThan(first!.evidenceRevision);
    facts.observe(null);expect(facts.current).toBeNull();await facts.close();expect(release).toHaveBeenCalledTimes(1);
    let started!:()=>void,finish!:()=>void;const preparing=new Promise<void>(resolve=>{started=resolve;}),reply=new Promise<void>(resolve=>{finish=resolve;});
    const delayed=new QualificationPreviewFacts({...db,beginQualificationPreview:async input=>{started();await reply;return {ok:true,value:{pinId:input.pinId,state:'ready',examined:1,projection}};}},authority);
    delayed.observe(live);const pending=delayed.read();await preparing;delayed.observe(null);finish();expect(await pending).toBeNull();await delayed.close();expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls.every(([input])=>Object.keys(input).sort().join(',')==='connectionVersion,pinId,registrationId')).toBe(true);
  });
  it('uses only the first SDK body type per double/triple coupling and preserves a missing first slot and prior coupling',()=>{
    const slots=[0,1,2].map(index=>({available:true as const,value:trailer(index,{id:{available:true,value:`trailer-${index}`},bodyType:{available:true,value:index===0?'double':'physical-part'}})}));
    const proof={version:2 as const,status:'proven' as const,items:slots.map(slot=>slot.value),recordingLoss:false};
    expect(qualificationTrailerFacts(proof,slots)).toEqual({complete:true,items:[{code:'double',provenance:'attached'}]});
    expect(qualificationTrailerFacts(proof,[{available:false,reason:'not-observed'},...slots.slice(1)])).toEqual({complete:false,items:[{code:'double',provenance:'previous'},{code:null,provenance:'unknown'}]});
    expect(qualificationTrailerFacts(proof,slots,['lowbed',null]).items).toEqual([{code:'lowbed',provenance:'previous'},{code:null,provenance:'unknown'},{code:'double',provenance:'attached'}]);
  });
  it('invalidates a delayed positive at maximum crossing, rollback, support loss, context change, retirement, edit and expiry',()=>{
    const reply=fixture<QualificationPreview>('maximum-guard-delayed-positive'),input=fixture<QualificationPreviewInput>('fictional-PreviewInput-5');
    input.actualDistance.metres='499999';input.hardMode.final=true;
    const lease:QualificationLease={reply,input,authority:reply.securityScope,dispatchMonotonicMs:1000};
    const cue=(current:QualificationPreviewInput|null,now=1100,scope=reply.securityScope,revision='12')=>qualificationLeaseCue(lease,current,scope,revision,now);
    expect(cue(input)).toBe('pass');
    const current=structuredClone(input);current.evidenceRevision++;current.actualDistance.metres='500000';expect(cue(current)).toBe('pass');
    current.actualDistance.metres='500001';expect(cue(current)).toBe('neutral');
    current.actualDistance.metres='499998';expect(cue(current)).toBe('neutral');
    current.actualDistance.metres='499999';current.actualDistance.support='partial';expect(cue(current)).toBe('neutral');
    current.actualDistance.support='whole-trip';current.contextRevision++;expect(cue(current)).toBe('neutral');
    expect(cue(null)).toBe('neutral');expect(cue(input,1100,'b'.repeat(43))).toBe('neutral');expect(cue(input,1100,reply.securityScope,'13')).toBe('neutral');
    expect(cue(input,6000)).toBe('neutral');expect(cue(input,5999)).toBe('pass');
  });
  it('never changes a server pending below-minimum result into passing as metres grow',()=>{
    const reply=fixture<QualificationPreview>('below-minimum-crossed-while-in-flight'),input=fixture<QualificationPreviewInput>('fictional-PreviewInput-5');
    const lease={reply,input,authority:reply.securityScope,dispatchMonotonicMs:0},current=structuredClone(input);current.actualDistance.metres='100001';current.evidenceRevision++;
    expect(input.hardMode.final).toBe(false);expect(reply.rules.find(rule=>rule.rule==='hard_mode')?.result).toBe('unknown');
    expect(qualificationLeaseCue(lease,current,reply.securityScope,'12',1)).toBe('neutral');
  });
  it('keeps a server-issued proven partial-distance failure within its envelope and rejects unknown or changed support',()=>{
    const reply=fixture<QualificationPreview>('already-over-maximum-proven-violation-lease'),input=fixture<QualificationPreviewInput>('fictional-PreviewInput-5');
    input.actualDistance={availability:'known',support:'partial',metres:'500001',final:false};
    const lease:QualificationLease={reply,input,authority:reply.securityScope,dispatchMonotonicMs:0};
    const cue=(current:QualificationPreviewInput)=>qualificationLeaseCue(lease,current,reply.securityScope,'12',1);
    expect(reply.outcome).toBe('fail');expect(reply.applicability.maximumDistanceM).toBeNull();expect(cue(input)).toBe('fail');
    const current=structuredClone(input);current.evidenceRevision++;current.actualDistance.metres='600000';expect(cue(current)).toBe('fail');
    current.actualDistance.metres='500000';expect(cue(current)).toBe('neutral');
    current.actualDistance.metres='600000';current.actualDistance.support='unknown';expect(cue(current)).toBe('neutral');
    current.actualDistance.support='whole-trip';expect(cue(current)).toBe('neutral');
  });
  it('requires the exact issued final distance and retires it on a corrected context',()=>{
    const reply=fixture<QualificationPreview>('final-distance-correction-exact-guard'),input=fixture<QualificationPreviewInput>('fictional-PreviewInput-5');input.actualDistance.final=true;
    const lease:QualificationLease={reply,input,authority:reply.securityScope,dispatchMonotonicMs:0};
    expect(qualificationLeaseCue(lease,input,reply.securityScope,'12',1)).toBe('fail');
    const corrected=structuredClone(input);corrected.actualDistance.metres='100000';expect(qualificationLeaseCue(lease,corrected,reply.securityScope,'12',1)).toBe('neutral');
    corrected.actualDistance.metres=input.actualDistance.metres;corrected.contextRevision++;expect(qualificationLeaseCue(lease,corrected,reply.securityScope,'12',1)).toBe('neutral');
  });
  it('preserves zero and canonical tiny numeric SDK facts without borrowing planned distance',()=>{
    expect(previewDecimal(0)).toBe('0');expect(previewDecimal(1e-7)).toBe('0.0000001');expect(previewDecimal(-1)).toBeNull();expect(previewDecimal(NaN)).toBeNull();expect(previewDecimal(1e21)).toBeNull();
  });
});
