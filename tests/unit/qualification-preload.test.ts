import {expect,it,vi} from 'vitest';
import {qualificationPreload,QUALIFICATION_CHANNELS} from '../../apps/desktop/src/qualification/contract';
import {initialQualificationState} from '../../packages/contracts/src/qualification';
it('REG-010/012 strips Electron events, validates replies/arguments and removes subscriptions',async()=>{
  let receive!:(event:unknown,value:unknown)=>void;
  const invoke=vi.fn(()=>Promise.resolve(initialQualificationState('ets2'))),removeListener=vi.fn(),bridge=qualificationPreload({invoke,on:(_channel,listener)=>{receive=listener;},removeListener});
  expect(await bridge.getQualification('ets2')).toEqual(initialQualificationState('ets2'));
  await expect(bridge.getQualification('ats')).rejects.toThrow('INVALID_QUALIFICATION_REPLY');
  await expect((bridge.getQualification as (...args:unknown[])=>Promise<unknown>)('ets2','extra')).rejects.toThrow('INVALID_QUALIFICATION_REQUEST');
  const listener=vi.fn(),off=bridge.subscribeQualification(listener);receive({sender:'private'},initialQualificationState('ats'));receive(null,{...initialQualificationState('ats'),token:'secret'});
  expect(listener).toHaveBeenCalledExactlyOnceWith(initialQualificationState('ats'));off();expect(removeListener).toHaveBeenCalledWith(QUALIFICATION_CHANNELS.status,receive);
});
