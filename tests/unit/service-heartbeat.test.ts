import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  STARTUP_TIMEOUT_MS,
  ServiceHeartbeatMonitor
} from '../../apps/desktop/src/service-heartbeat';

describe('ServiceHeartbeatMonitor (REG-011)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports documented heartbeat interval and timeout constants', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(1000);
    expect(HEARTBEAT_TIMEOUT_MS).toBe(5000);
    expect(STARTUP_TIMEOUT_MS).toBe(15000);
  });

  it('fires onTimeout after 15,000 ms of initial startup silence before first message', () => {
    const onTimeout = vi.fn();
    const onResume = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout, onResume});

    expect(monitor.isActive).toBe(false);
    expect(monitor.isTimedOut).toBe(false);

    monitor.start();
    expect(monitor.isActive).toBe(true);
    expect(monitor.isTimedOut).toBe(false);

    // Advance 14,999 ms - should not time out yet
    vi.advanceTimersByTime(14999);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(monitor.isTimedOut).toBe(false);

    // Advance 1 ms (total 15,000 ms) - times out now
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(monitor.isTimedOut).toBe(true);

    // Further silence does not repeatedly fire onTimeout
    vi.advanceTimersByTime(10000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
  });

  it('transitions to 5,000 ms steady-state timeout after first message received', () => {
    const onTimeout = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout});
    monitor.start();

    // First message received at 2,000 ms
    vi.advanceTimersByTime(2000);
    monitor.touch();
    expect(onTimeout).not.toHaveBeenCalled();

    // Steady state: advance 4,999 ms -> no timeout
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    // 1 ms more (5,000 ms total silence after touch) -> times out
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(monitor.isTimedOut).toBe(true);
  });

  it('proves any message resets the deadline timer', () => {
    const onTimeout = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout});
    monitor.start();

    // Periodic messages every 1,000 ms for 20 seconds
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1000);
      monitor.touch();
      expect(onTimeout).not.toHaveBeenCalled();
      expect(monitor.isTimedOut).toBe(false);
    }

    // Delay up to 4,500 ms (less than 5,000 ms)
    vi.advanceTimersByTime(4500);
    expect(onTimeout).not.toHaveBeenCalled();
    monitor.refresh();

    // Another 4,999 ms after refresh
    vi.advanceTimersByTime(4999);
    expect(onTimeout).not.toHaveBeenCalled();

    // 1 ms more triggers timeout
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(monitor.isTimedOut).toBe(true);
  });

  it('proves onResume fires when heartbeat returns after a timeout', () => {
    const onTimeout = vi.fn();
    const onResume = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout, onResume});
    monitor.start();

    // Trigger initial startup timeout
    vi.advanceTimersByTime(15000);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onResume).not.toHaveBeenCalled();
    expect(monitor.isTimedOut).toBe(true);

    // Message arrives from recovering service
    monitor.touch();
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(monitor.isTimedOut).toBe(false);

    // Subsequent steady-state messages do not re-fire onResume
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(1000);
      monitor.touch();
      expect(onResume).toHaveBeenCalledTimes(1);
    }

    // Steady-state timeout cycle (5,000 ms)
    vi.advanceTimersByTime(5000);
    expect(onTimeout).toHaveBeenCalledTimes(2);
    expect(monitor.isTimedOut).toBe(true);

    monitor.touch();
    expect(onResume).toHaveBeenCalledTimes(2);
    expect(monitor.isTimedOut).toBe(false);
  });

  it('proves stop() cancels all timers and prevents timeout', () => {
    const onTimeout = vi.fn();
    const onResume = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout, onResume});
    monitor.start();

    vi.advanceTimersByTime(4000);
    monitor.stop();

    expect(monitor.isActive).toBe(false);
    expect(monitor.isTimedOut).toBe(false);

    vi.advanceTimersByTime(20000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(onResume).not.toHaveBeenCalled();
  });

  it('ignores touches when not active', () => {
    const onTimeout = vi.fn();
    const onResume = vi.fn();
    const monitor = new ServiceHeartbeatMonitor({onTimeout, onResume});

    // Touch before start
    monitor.touch();
    vi.advanceTimersByTime(10000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(monitor.isActive).toBe(false);

    // Start, stop, then touch
    monitor.start();
    monitor.stop();
    monitor.touch();
    vi.advanceTimersByTime(20000);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(monitor.isActive).toBe(false);
  });

  it('supports custom timeout and injectable timer functions', () => {
    const customTimeoutMs = 2500;
    const customStartupTimeoutMs = 6000;
    const fakeSetTimeout = vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms));
    const fakeClearTimeout = vi.fn((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
    const onTimeout = vi.fn();

    const monitor = new ServiceHeartbeatMonitor({
      timeoutMs: customTimeoutMs,
      startupTimeoutMs: customStartupTimeoutMs,
      setTimeout: fakeSetTimeout,
      clearTimeout: fakeClearTimeout,
      onTimeout
    });

    expect(monitor.timeoutMs).toBe(2500);
    expect(monitor.startupTimeoutMs).toBe(6000);
    monitor.start();
    expect(fakeSetTimeout).toHaveBeenCalledWith(expect.any(Function), 6000);

    monitor.touch();
    expect(fakeSetTimeout).toHaveBeenCalledWith(expect.any(Function), 2500);

    monitor.stop();
    expect(fakeClearTimeout).toHaveBeenCalled();
  });
});
