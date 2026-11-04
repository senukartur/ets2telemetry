import {describe, expect, it} from 'vitest';
import {advanceProgress, restoredProgress, type ProgressAnchor} from '../../packages/telemetry-core/src/trips/progress';
import {matchesSavedEndpoint} from '../../packages/telemetry-core/src/trips/saved-endpoint';

const anchor = (odometerM: number, fuelL = 200, pluginSessionId = 'session-a'): ProgressAnchor =>
  ({pluginSessionId, sourceClockId: 'clock', monotonicNs: '1', truck: 'truck-a', odometerM, fuelL, gameMinutes: '500', position: {x: odometerM / 20, y: 0, z: 0}});
describe('REG-008 current-save progress', () => {
  it('retains an exact observed endpoint prefix across only bounded save measurement differences without crediting them', () => {
    const start = advanceProgress(null, {...anchor(0, 100), gameMinutes: '500', position: {x: 0, y: 0, z: 0}}, true);
    const end = advanceProgress(start, {...anchor(250, 99.5), gameMinutes: '501', position: {x: 13, y: 0, z: 0}}, true);
    const at = {...end.anchor, pluginSessionId: 'next-source', fuelL: 99.515, position: {x: 13.003, y: 0.004, z: 0}};
    const restored = restoredProgress(start, end, at, true);
    expect(restored.distanceM).toEqual({available: true, value: 250});
    expect(restored.fuelUsedL).toEqual({available: true, value: 0.5});
    expect(restored.anchor.fuelL).toBe(99.515);
    expect(restoredProgress(start,end,at).fuelUsedL.available).toBe(false);
  });
  it.each([
    {name:'inclusive limits', fuel:100.020, x:0.003,y:0.004, matches:true},
    {name:'negative fuel noise', fuel:99.980, x:0,y:0, matches:true},
    {name:'outside fuel limit',fuel:100.020001,x:0,y:0,matches:false},
    {name:'outside Euclidean limit',fuel:100,x:0.004,y:0.004,matches:false},
    {name:'outside position limit',fuel:100,x:0.005001,y:0,matches:false}
  ])('bounds saved endpoint comparison only: $name',({fuel,x,y,matches})=>{
    const original={...anchor(250,100),position:{x:0,y:0,z:0}};
    const next={...original,fuelL:fuel,position:{x,y,z:0}};
    expect(matchesSavedEndpoint(original,next)).toBe(matches);
    expect(matchesSavedEndpoint(original,{...next,truck:null})).toBe(false);
    expect(matchesSavedEndpoint(original,{...next,gameMinutes:null})).toBe(false);
    expect(matchesSavedEndpoint(original,{...next,odometerM:251})).toBe(false);
    expect(matchesSavedEndpoint(original,{...next,gameMinutes:'501'})).toBe(false);
  });
  it('nets small fuel rises as measurement noise and counts a real refuel separately from consumption',()=>{
    let progress=advanceProgress(null,anchor(0,100),true);
    for(const [odo,fuel] of [[1,99],[2,99.005],[3,98.005]])progress=advanceProgress(progress,anchor(odo,fuel),true);
    expect(progress.fuelUsedL.available && progress.fuelUsedL.value).toBeCloseTo(1.995,9);
    progress=advanceProgress(progress,anchor(4,110),true);
    expect(progress.fuelUsedL.available && progress.fuelUsedL.value).toBeCloseTo(1.995,9);
  });
  it.each(['session-a', 'next-day-session'])('replaces abandoned driving after restore in %s: 100 → 60 → 100 km', session => {
    const start = advanceProgress(null, anchor(1_000_000), true);
    const end = advanceProgress(start, anchor(1_100_000, 160), true);
    const restored = restoredProgress(start, end, anchor(1_060_000, 175, session));
    expect(restored.distanceM).toEqual({available: true, value: 60_000});
    expect(restored.fuelUsedL.available).toBe(false);
    expect(advanceProgress(restored, anchor(1_100_000, 160, session), true).distanceM).toEqual({available: true, value: 100_000});
  });
  it('does not reconstruct across missing evidence or a different truck', () => {
    const start = advanceProgress(null, anchor(0), true), end = advanceProgress(start, anchor(100_000), true);
    expect(restoredProgress(start, end, {...anchor(60_000), truck: 'other'}).distanceM.available).toBe(false);
    expect(advanceProgress(end, anchor(150_000), false).distanceM.available).toBe(false);
  });
  it('can show less than an earlier maximum after a second rollback', () => {
    const start = advanceProgress(null, anchor(0), true), end = advanceProgress(start, anchor(100_000), true);
    const restored = restoredProgress(start, end, anchor(60_000));
    expect(advanceProgress(restored, anchor(70_000), true).distanceM).toEqual({available: true, value: 70_000});
  });
  it('keeps distance but refuses a fuel prefix at a stationary endpoint with changed tank evidence',()=>{
    const start=advanceProgress(null,anchor(0,200),true),end=advanceProgress(start,anchor(100,190),true);
    expect(restoredProgress(start,end,anchor(100,180))).toMatchObject({distanceM:{available:true,value:100},fuelUsedL:{available:false,reason:'not-observed'}});
    expect(restoredProgress(start,end,anchor(100,190)).fuelUsedL).toEqual({available:true,value:10});
  });
});
