import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// useLiveDisplay's timer: the only thing that moves the Live page when the game stops sending, because a stopped game
// produces no further render. A minimal hook runtime stands in for React (the unit suite has no DOM): useState keeps
// slots, a set state during render re-renders at once, a set state from a timer re-renders with the last props, and
// useEffect runs after the render when its dependencies change, cleaning up the previous run first.
const hooks = vi.hoisted(() => ({
  slots: [] as unknown[], effects: [] as ({deps: unknown[]; cleanup?: () => void} | undefined)[], pending: [] as (() => void)[],
  slot: 0, effect: 0, dirty: false, rendering: false, rerender: () => {}
}));
vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.slot++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    const set = (value: unknown) => {
      const next = typeof value === 'function' ? (value as (current: unknown) => unknown)(hooks.slots[index]) : value;
      if (Object.is(next, hooks.slots[index])) return;
      hooks.slots[index] = next; hooks.dirty = true;
      if (!hooks.rendering) hooks.rerender();
    };
    return [hooks.slots[index], set];
  },
  useEffect: (run: () => void | (() => void), deps: unknown[]) => {
    const index = hooks.effect++, previous = hooks.effects[index];
    if (previous && deps.every((dep, i) => Object.is(dep, previous.deps[i]))) return;
    hooks.pending.push(() => {previous?.cleanup?.(); hooks.effects[index] = {deps, cleanup: run() ?? undefined};});
  }
}));

const {useLiveDisplay, LIVE_DISPLAY_TIMING} = await import('../../apps/desktop/src/live-display-hold');
const ENTER = LIVE_DISPLAY_TIMING.enterMs, EXIT = LIVE_DISPLAY_TIMING.exitMs;

let shown: string;
function render(known: boolean, hasData: boolean) {
  hooks.rerender = () => render(known, hasData);
  do {
    // Like React, a render that set state is thrown away with its effects and rendered again.
    hooks.slot = 0; hooks.effect = 0; hooks.dirty = false; hooks.rendering = true; hooks.pending = [];
    shown = useLiveDisplay(known, hasData);
    hooks.rendering = false;
  } while (hooks.dirty);
  for (const run of hooks.pending.splice(0)) run();
  return shown;
}
const unmount = () => {for (const effect of hooks.effects) effect?.cleanup?.();};

beforeEach(() => {vi.useFakeTimers(); vi.setSystemTime(1_000_000); Object.assign(hooks, {slots: [], effects: [], pending: []});});
afterEach(() => {unmount(); vi.useRealTimers();});

describe('useLiveDisplay', () => {
  it('shows the placeholder until the first live update, then the first known input at once', () => {
    expect(render(false, false)).toBe('placeholder');
    expect(render(true, true)).toBe('dashboard');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switches to the placeholder when the game stops, with no further render, after the exit delay', () => {
    render(true, true);
    expect(render(true, false)).toBe('dashboard');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(EXIT - 1); expect(shown).toBe('dashboard');
    vi.advanceTimersByTime(1); expect(shown).toBe('placeholder');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('switches to the dashboard after the enter delay of current data', () => {
    render(true, false);
    expect(render(true, true)).toBe('placeholder');
    vi.advanceTimersByTime(ENTER); expect(shown).toBe('dashboard');
  });

  it('clears the pending switch when the input flips back, and re-arms for the new direction', () => {
    render(true, true); render(true, false);
    vi.advanceTimersByTime(EXIT - 500);
    expect(render(true, true)).toBe('dashboard');
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(EXIT * 2); expect(shown).toBe('dashboard');
    render(true, false);
    vi.advanceTimersByTime(EXIT); expect(shown).toBe('placeholder');
  });

  it('switches at the deadline even when the clock stepped back while it waited', () => {
    render(true, true); render(true, false);
    vi.setSystemTime(Date.now() - 60_000);
    vi.advanceTimersByTime(EXIT); expect(shown).toBe('placeholder');
  });

  it('re-arms with the current input, so an input that became unknown while a switch waited keeps the display', () => {
    render(true, true); render(true, false);
    expect(render(false, false)).toBe('dashboard');
    vi.advanceTimersByTime(EXIT * 2); expect(shown).toBe('dashboard');
  });

  it('clears the timer on unmount', () => {
    render(true, true); render(true, false);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
