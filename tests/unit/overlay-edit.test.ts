import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {OWN_FOCUS_GRACE_MS, OwnForegroundGate} from '../../apps/desktop/src/overlay-edit';

// ET-012b decision M6: the own-foreground gate of the overlay edit mode, with fake timers.
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('counts a gain at once and a loss only after 150 ms', async () => {
  const changed = vi.fn(), gate = new OwnForegroundGate(changed);
  expect(OWN_FOCUS_GRACE_MS).toBe(150);
  gate.start(false); expect(gate.inFront).toBe(false);
  gate.update(true); expect(changed.mock.calls).toEqual([[true]]); expect(gate.inFront).toBe(true);
  gate.update(false); await vi.advanceTimersByTimeAsync(149);
  expect(changed).toHaveBeenCalledOnce(); expect(gate.inFront).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(changed.mock.calls).toEqual([[true], [false]]); expect(gate.inFront).toBe(false);
  gate.stop(); expect(vi.getTimerCount()).toBe(0);
});

it('cancels a loss regained within the grace, as when a click moves focus from the dashboard to the overlay', async () => {
  const changed = vi.fn(), gate = new OwnForegroundGate(changed);
  gate.start(true);
  gate.update(false); await vi.advanceTimersByTimeAsync(100); gate.update(true);
  await vi.advanceTimersByTimeAsync(500);
  expect(changed).not.toHaveBeenCalled(); expect(gate.inFront).toBe(true); expect(vi.getTimerCount()).toBe(0);
});

it('keeps one pending loss for repeated blur events', async () => {
  const changed = vi.fn(), gate = new OwnForegroundGate(changed);
  gate.start(true);
  gate.update(false); await vi.advanceTimersByTimeAsync(100); gate.update(false);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(50); expect(changed.mock.calls).toEqual([[false]]);
  gate.update(false); expect(vi.getTimerCount()).toBe(0); expect(changed).toHaveBeenCalledOnce();
});

it('reports nothing and keeps no timer after it stops, and ignores updates while stopped', async () => {
  const changed = vi.fn(), gate = new OwnForegroundGate(changed);
  gate.update(true); expect(changed).not.toHaveBeenCalled(); expect(gate.inFront).toBe(false);
  gate.start(true); gate.update(false); gate.stop();
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(500);
  expect(changed).not.toHaveBeenCalled(); expect(gate.inFront).toBe(false);
  // A new start reads the focus again without reporting it.
  gate.start(false); expect(gate.inFront).toBe(false); expect(changed).not.toHaveBeenCalled();
});
