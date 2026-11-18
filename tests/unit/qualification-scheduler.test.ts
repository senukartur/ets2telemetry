import {afterEach,describe,expect,it,vi} from 'vitest';
import {QualificationScheduler,qualificationRetry,type QualificationTask} from '../../apps/desktop/src/qualification/scheduler';
afterEach(()=>vi.useRealTimers());
describe('companion fairness and retry (REG-010/011/012)',()=>{
  it('coalesces refreshes without starving either game, results or preview',async()=>{
    vi.useFakeTimers();const calls:QualificationTask[]=[];let release:()=>void=()=>undefined;
    const scheduler=new QualificationScheduler(async task=>{calls.push(task);if(calls.length===1)await new Promise<void>(resolve=>{release=resolve;});return 5000;});
    try{
      for(const task of ['ets2','ats','results','preview'] as const){scheduler.request(task);scheduler.request(task);}
      await vi.advanceTimersByTimeAsync(0);expect(calls).toEqual(['ets2']);
      await vi.advanceTimersByTimeAsync(2000);expect(calls).toHaveLength(1);release();await vi.advanceTimersByTimeAsync(0);
      for(let turn=0;turn<4&&calls.length<4;turn++)await vi.advanceTimersToNextTimerAsync();expect(calls).toEqual(['ets2','ats','results','preview']);
      scheduler.stop();await vi.advanceTimersByTimeAsync(60000);expect(calls).toHaveLength(4);
    }finally{scheduler.stop();}
  });
  it('bounds jitter while honoring a bounded Retry-After including HTTP dates',()=>{
    expect(qualificationRetry(9,null,0,1)).toBe(60000);
    expect(qualificationRetry(1,'120',0,0)).toBe(120000);
    expect(qualificationRetry(1,'Thu, 01 Jan 1970 00:01:00 GMT',0,0)).toBe(60000);
    expect(qualificationRetry(1,'invalid',0,0)).toBe(0);
  });
});
