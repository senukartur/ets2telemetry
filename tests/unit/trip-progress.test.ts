import {describe, expect, it} from 'vitest';
import {advanceProgress, restoredProgress, type ProgressAnchor} from '../../packages/telemetry-core/src/trips/progress';

const anchor = (odometerM: number, fuelL = 200, pluginSessionId = 'session-a'): ProgressAnchor =>
  ({pluginSessionId, sourceClockId: 'clock', monotonicNs: '1', truck: 'truck-a', odometerM, fuelL});
describe('REG-008 current-save progress', () => {
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
