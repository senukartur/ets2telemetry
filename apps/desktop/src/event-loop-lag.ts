export interface LagClock {
  now(): number;
  every(callback: () => void, intervalMs: number): {unref?(): unknown};
  cancel(handle: unknown): void;
}
const systemClock: LagClock = {now: () => performance.now(), every: (callback, intervalMs) => setInterval(callback, intervalMs),
  cancel: handle => clearInterval(handle as ReturnType<typeof setInterval>)};

/**
 * Reports when a periodic timer fires more than `thresholdMs` late: the event loop (in Electron main, also
 * Chromium's browser UI thread) ran nothing for that long. A report can only be written after the stall
 * ends; `gapMs` then gives its length, so the stall began `gapMs` before the report time.
 */
export function monitorEventLoopLag(report: (facts: {gapMs: number; lateMs: number}) => void,
  {intervalMs = 250, thresholdMs = 1000, clock = systemClock}: {intervalMs?: number; thresholdMs?: number; clock?: LagClock} = {}): () => void {
  let last = clock.now();
  const handle = clock.every(() => {
    const now = clock.now(), gap = now - last; last = now;
    if (gap - intervalMs > thresholdMs) report({gapMs: Math.round(gap), lateMs: Math.round(gap - intervalMs)});
  }, intervalMs);
  // Diagnostics never keep the application alive.
  handle.unref?.();
  return () => clock.cancel(handle);
}
