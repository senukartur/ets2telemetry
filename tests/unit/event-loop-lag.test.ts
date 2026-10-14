import {expect, it, vi} from 'vitest';
import {monitorEventLoopLag, type LagClock} from '../../apps/desktop/src/event-loop-lag';

function manualClock() {
  let now = 0, tick: (() => void) | undefined;
  const handle = {unref: vi.fn()};
  const clock: LagClock = {now: () => now, every: callback => {tick = callback; return handle;}, cancel: vi.fn(() => {tick = undefined;})};
  // Fires the timer `late` ms after its nominal 250 ms interval.
  const fire = (late = 0) => {now += 250 + late; tick?.();};
  return {clock, handle, fire, cancelled: () => tick === undefined};
}

it('reports only intervals that ran more than the threshold late, with the whole gap', () => {
  const {clock, fire} = manualClock(), report = vi.fn();
  monitorEventLoopLag(report, {clock});
  fire(); fire(999); fire(1000);
  expect(report).not.toHaveBeenCalled();
  fire(17500);
  expect(report).toHaveBeenCalledExactlyOnceWith({gapMs: 17750, lateMs: 17500});
  fire();
  expect(report).toHaveBeenCalledOnce();
});
it('never keeps the process alive and stops on request', () => {
  const {clock, handle, fire, cancelled} = manualClock(), report = vi.fn();
  const stop = monitorEventLoopLag(report, {clock});
  expect(handle.unref).toHaveBeenCalledOnce();
  stop(); expect(cancelled()).toBe(true);
  fire(5000); expect(report).not.toHaveBeenCalled();
});
