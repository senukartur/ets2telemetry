import {describe, expect, it} from 'vitest';
import {LIVE_DISPLAY_INITIAL, LIVE_DISPLAY_TIMING, liveDisplayDelay, nextLiveDisplay, type LiveDisplayHold} from '../../apps/desktop/src/live-display-hold';

// The Live page's dashboard/placeholder hold: a controlled clock drives the pure step; the hook only adds a timer.
const ENTER = LIVE_DISPLAY_TIMING.enterMs, EXIT = LIVE_DISPLAY_TIMING.exitMs;
/** Feeds `[at ms, hasData]` steps from a hold and returns the shown display after each. */
function run(steps: readonly (readonly [number, boolean])[], start: LiveDisplayHold = LIVE_DISPLAY_INITIAL) {
  let hold = start;
  return steps.map(([at, hasData]) => (hold = nextLiveDisplay(hold, true, hasData, at)).shown);
}

describe('nextLiveDisplay', () => {
  it('keeps the agreed timing: two seconds before the dashboard, three before the placeholder', () => {
    expect([ENTER, EXIT]).toEqual([2000, 3000]);
    expect([liveDisplayDelay(true), liveDisplayDelay(false)]).toEqual([ENTER, EXIT]);
  });

  it('decides nothing until the first live update, then shows the first known input at once', () => {
    expect(nextLiveDisplay(LIVE_DISPLAY_INITIAL, false, true, 0)).toBe(LIVE_DISPLAY_INITIAL);
    expect(run([[0, true]])).toEqual(['dashboard']);
    expect(run([[0, false]])).toEqual(['placeholder']);
  });

  it('shows the dashboard only after current data has held for the enter delay', () => {
    expect(run([[0, false], [100, true], [100 + ENTER - 1, true], [100 + ENTER, true]])).toEqual(['placeholder', 'placeholder', 'placeholder', 'dashboard']);
  });

  it('shows the placeholder only after the data has been missing for the exit delay', () => {
    expect(run([[0, true], [500, false], [500 + EXIT - 1, false], [500 + EXIT, false]])).toEqual(['dashboard', 'dashboard', 'dashboard', 'placeholder']);
  });

  it('a flip back within the delay cancels the switch and restarts the wait', () => {
    // A loading game: data, a gap, data again, so the dashboard never leaves.
    expect(run([[0, true], [1000, false], [3500, true], [4000, false], [6999, false]])).toEqual(['dashboard', 'dashboard', 'dashboard', 'dashboard', 'dashboard']);
    // A reconnect that stutters: the dashboard waits for two seconds of uninterrupted data.
    expect(run([[0, false], [100, true], [1500, false], [1600, true], [3599, true], [3600, true]])).toEqual(['placeholder', 'placeholder', 'placeholder', 'placeholder', 'placeholder', 'dashboard']);
  });

  it('keeps the hold while the input is unknown and returns the same object when nothing changes', () => {
    const pending = nextLiveDisplay({shown: 'dashboard', since: null}, true, false, 0);
    expect(pending).toEqual({shown: 'dashboard', since: 0});
    expect(nextLiveDisplay(pending, false, true, 10_000)).toBe(pending);
    expect(nextLiveDisplay(pending, true, false, EXIT - 1)).toBe(pending);
    const settled = {shown: 'placeholder', since: null} as const;
    expect(nextLiveDisplay(settled, true, false, 50)).toBe(settled);
  });
});
