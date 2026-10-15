import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EXIT_IDLE_BUDGET_MS, ExitCoordinator, secondInstanceAction} from '../../apps/desktop/src/app-lifecycle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture(idle?: () => Promise<void> | undefined) {
  const order: string[] = [];
  const hooks = {log: vi.fn(), begin: vi.fn(() => order.push('begin')), stopService: vi.fn(() => order.push('stop')),
    destroyTray: vi.fn(() => order.push('tray')), exit: vi.fn((code: number) => order.push(`exit ${code}`)), idle};
  return {hooks, order, coordinator: new ExitCoordinator(hooks)};
}

it('decides second-launch handling from lifecycle state only', () => {
  expect(secondInstanceAction({exiting: true, started: true, dashboard: 'visible'})).toBe('ignored-exiting');
  expect(secondInstanceAction({exiting: false, started: false, dashboard: 'none'})).toBe('ignored-starting');
  expect(secondInstanceAction({exiting: false, started: true, dashboard: 'minimized'})).toBe('restored');
  expect(secondInstanceAction({exiting: false, started: true, dashboard: 'visible'})).toBe('focused');
  expect(secondInstanceAction({exiting: false, started: true, dashboard: 'none'})).toBe('created');
});

it('runs one exit sequence per process and removes the tray before exiting', () => {
  const f = fixture();
  expect(f.coordinator.request('tray')).toBe(true);
  for (const reason of ['tray', 'renderer', 'app-quit', 'session-end'] as const) expect(f.coordinator.request(reason)).toBe(false);
  expect(f.coordinator.exiting).toBe(true); expect(f.coordinator.reason).toBe('tray');
  expect(f.hooks.log).toHaveBeenCalledExactlyOnceWith('APP_EXIT_REQUESTED', undefined, {reason: 'tray'});
  expect(f.order).toEqual(['begin', 'stop']);
  f.coordinator.finish(0); f.coordinator.finish(1);
  expect(f.order).toEqual(['begin', 'stop', 'tray', 'exit 0']); expect(vi.getTimerCount()).toBe(0);
});

it('treats a fatal supervisor finish without a request as exiting and still removes the tray first', () => {
  const f = fixture();
  f.coordinator.finish(1);
  expect(f.coordinator.exiting).toBe(true); expect(f.coordinator.request('tray')).toBe(false);
  expect(f.order).toEqual(['tray', 'exit 1']); expect(f.hooks.log).not.toHaveBeenCalled();
});

it('waits for pending idle work after the service stops, bounded by the idle budget', async () => {
  let settle!: () => void;
  const f = fixture(() => new Promise<void>(resolve => {settle = resolve;}));
  f.coordinator.request('renderer'); f.coordinator.finish(0);
  expect(f.hooks.exit).not.toHaveBeenCalled();
  settle(); await vi.advanceTimersByTimeAsync(0);
  expect(f.order).toEqual(['begin', 'stop', 'tray', 'exit 0']); expect(vi.getTimerCount()).toBe(0);

  const hung = fixture(() => new Promise<void>(() => undefined));
  hung.coordinator.request('app-quit'); hung.coordinator.finish(0);
  await vi.advanceTimersByTimeAsync(EXIT_IDLE_BUDGET_MS - 1); expect(hung.hooks.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(hung.order).toEqual(['begin', 'stop', 'tray', 'exit 0']);
});

it('runs idle work in parallel with the service stop, so its budget starts at the request', async () => {
  const failed = fixture(() => Promise.reject(new Error('write failed')));
  failed.coordinator.request('tray'); await vi.advanceTimersByTimeAsync(0);
  failed.coordinator.finish(0); expect(failed.order).toEqual(['begin', 'stop', 'tray', 'exit 0']);

  const slow = fixture(() => new Promise<void>(() => undefined));
  slow.coordinator.request('session-end'); await vi.advanceTimersByTimeAsync(EXIT_IDLE_BUDGET_MS);
  slow.coordinator.finish(0); expect(slow.order).toEqual(['begin', 'stop', 'tray', 'exit 0']); expect(vi.getTimerCount()).toBe(0);
});

it('still exits when removing the tray icon throws', () => {
  const f = fixture(); f.hooks.destroyTray.mockImplementation(() => {throw new Error('shell gone');});
  f.coordinator.request('tray'); f.coordinator.finish(0);
  expect(f.hooks.exit).toHaveBeenCalledExactlyOnceWith(0); expect(f.hooks.log).toHaveBeenCalledWith('TRAY_DESTROY_REJECTED', expect.any(String));
});

it('marks a fatal stop as exiting at once without logging an exit request or running exit hooks', () => {
  const f = fixture();
  expect(f.coordinator.abort()).toBe(true); expect(f.coordinator.abort()).toBe(false);
  expect(f.coordinator.exiting).toBe(true); expect(f.coordinator.reason).toBeUndefined();
  expect(f.coordinator.request('tray')).toBe(false);
  expect(f.order).toEqual([]); expect(f.hooks.log).not.toHaveBeenCalled();
  f.coordinator.finish(1); expect(f.order).toEqual(['tray', 'exit 1']);
  const requested = fixture(); requested.coordinator.request('renderer');
  expect(requested.coordinator.abort()).toBe(false);
});
