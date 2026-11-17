import {useEffect, useState} from 'react';

/** What the Live page shows: the dashboard while the game sends current data, a placeholder scene otherwise. */
export type LiveDisplay = 'dashboard' | 'placeholder';
export interface LiveDisplayTiming {enterMs: number; exitMs: number}
/**
 * A game that loads, pauses or reconnects flips between current and not-current data several times a second. The page
 * switches only after the new condition has held: two seconds of current data before the dashboard, three seconds
 * without before the placeholder.
 */
export const LIVE_DISPLAY_TIMING: LiveDisplayTiming = {enterMs: 2000, exitMs: 3000};

/** The shown display and, while the input disagrees with it, when that disagreement began. */
export interface LiveDisplayHold {shown: LiveDisplay | null; since: number | null}
export const LIVE_DISPLAY_INITIAL: LiveDisplayHold = {shown: null, since: null};

/**
 * The next hold for the input at `now`. Until the first live update (`known` false) nothing is decided; the first known
 * input shows at once, so opening the window mid-drive shows the dashboard without a delay. Afterwards a change shows
 * once it has lasted its delay; a change back within the delay cancels it. Returns the same object when nothing changes.
 */
export function nextLiveDisplay(hold: LiveDisplayHold, known: boolean, hasData: boolean, now: number, timing: LiveDisplayTiming = LIVE_DISPLAY_TIMING): LiveDisplayHold {
  if (!known) return hold;
  const wanted: LiveDisplay = hasData ? 'dashboard' : 'placeholder';
  if (hold.shown === null) return {shown: wanted, since: null};
  if (hold.shown === wanted) return hold.since === null ? hold : {shown: wanted, since: null};
  if (hold.since === null) return {shown: hold.shown, since: now};
  return now - hold.since >= liveDisplayDelay(hasData, timing) ? {shown: wanted, since: null} : hold;
}

/** The delay before switching towards the given input. */
export const liveDisplayDelay = (hasData: boolean, timing: LiveDisplayTiming = LIVE_DISPLAY_TIMING) => hasData ? timing.enterMs : timing.exitMs;

/**
 * The held Live display for the renderer. A pending switch also gets a timer, so it happens on time even when no new
 * live update arrives; the timer evaluates at its deadline at the latest, so an early wake-up or a clock step back cannot
 * hold the old display.
 */
export function useLiveDisplay(known: boolean, hasData: boolean): LiveDisplay {
  const [hold, setHold] = useState<LiveDisplayHold>(() => nextLiveDisplay(LIVE_DISPLAY_INITIAL, known, hasData, Date.now()));
  const next = nextLiveDisplay(hold, known, hasData, Date.now());
  if (next !== hold) setHold(next);
  const since = next.since;
  useEffect(() => {
    if (since === null) return;
    const deadline = since + liveDisplayDelay(hasData);
    const timer = setTimeout(() => setHold(current => nextLiveDisplay(current, known, hasData, Math.max(Date.now(), deadline))), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [since, known, hasData]);
  return next.shown ?? 'placeholder';
}
