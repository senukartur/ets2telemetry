import {describe,expect,it,vi} from 'vitest';
import {QualificationMainController} from '../../apps/desktop/src/qualification/main-controller';
import {QualificationServiceBridge} from '../../apps/desktop/src/qualification/service-bridge';
import {randomUUID} from 'node:crypto';
import {initialQualificationState} from '../../packages/contracts/src/qualification';
import type {JournalUploadScope} from '../../apps/desktop/src/dashboard-upload/journal-sync-guard';
const owner={origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'e'};
describe('qualification main authority (REG-010/012/014)',()=>{
  it('keeps the private connection fence on both replies and publications without exposing it in page state',async()=>{
    const generation=randomUUID(),sent:unknown[]=[],publish=vi.fn(),bridge=new QualificationServiceBridge(generation,value=>sent.push(value),publish);
    const state=initialQualificationState('ets2',owner),pending=bridge.call('get','ets2'),request=sent[0] as {id:string};
    bridge.receive({type:'qualification:answer',id:request.id,generation,state,connectionVersion:'2'});
    await expect(pending).resolves.toEqual({state,connectionVersion:'2'});
    bridge.receive({type:'qualification:status',generation,state});expect(publish).not.toHaveBeenCalled();
    bridge.receive({type:'qualification:status',generation,state,connectionVersion:'2'});expect(publish).toHaveBeenCalledExactlyOnceWith(state,'2');bridge.retire();
    const visible=vi.fn(),controller=new QualificationMainController(()=>({owner,documentEpoch:1,connectionVersion:'3',utilityGeneration:generation}),visible);
    controller.attach({generation,retire:vi.fn(),call:()=>Promise.resolve({state,connectionVersion:'2'})});controller.accept(state,'2');expect(visible).not.toHaveBeenCalled();
    expect((await controller.handle('get',['ets2'])).owner).toBeNull();controller.accept(state,'3');expect(visible).toHaveBeenCalledExactlyOnceWith(state);controller.detach();
  });
  it('retires delayed replies at document, owner, connection and utility boundaries',async()=>{
    for(const change of ['documentEpoch','connectionVersion','utilityGeneration','owner'] as const){
      let scope:JournalUploadScope|undefined={owner,documentEpoch:1,connectionVersion:'1',utilityGeneration:'utility'};
      let resolve!:(value:{state:ReturnType<typeof initialQualificationState>;connectionVersion:string})=>void;
      const publish=vi.fn(),controller=new QualificationMainController(()=>scope,publish);
      controller.attach({generation:'utility',retire:vi.fn(),call:()=>new Promise(done=>{resolve=done;})});
      const pending=controller.handle('get',['ets2']);
      scope=change==='owner'?{...scope,owner:{...owner,identityEpoch:'new'}}:change==='documentEpoch'?{...scope,documentEpoch:2}:{...scope,[change]:'new'};
      resolve({state:initialQualificationState('ets2',owner),connectionVersion:'1'});expect((await pending).owner).toBeNull();
      controller.accept(initialQualificationState('ets2',owner),'1');if(change==='owner'||change==='utilityGeneration'||change==='connectionVersion')expect(publish).not.toHaveBeenCalled();
      scope=undefined;expect((await controller.handle('refresh',['ats'])).owner).toBeNull();controller.detach();
    }
  });
  it('accepts exactly a game enum and no renderer owner, source, URL, SQL or facts',async()=>{
    const controller=new QualificationMainController(()=>undefined,()=>undefined);
    for(const args of [[],['ets2',owner],['ETS2'],[{game:'ets2'}],['https://evil.example']])await expect(controller.handle('get',args)).rejects.toThrow('INVALID_QUALIFICATION_REQUEST');
  });
});
