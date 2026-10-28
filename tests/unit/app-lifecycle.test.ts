import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EXIT_IDLE_BUDGET_MS, EXIT_REASONS, ExitCoordinator, secondInstanceAction, startsUpdatedApplication} from '../../apps/desktop/src/app-lifecycle';

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

// ET-055 (UP8; REG-012): the update exit is the same orderly sequence. The restart helper may start only at the final
// exit of a request with reason `update`, after the service stop (intake, recording-flush, storage) finished and the idle
// work settled; never on a fatal stop or another reason.
function restartFixture(idle?: () => Promise<void> | undefined) {
  const f = fixture(idle);
  f.hooks.exit.mockImplementation((code: number) => {
    if (startsUpdatedApplication(f.coordinator.reason)) f.order.push('restart helper');
    return f.order.push(`exit ${code}`);
  });
  return f;
}
it('runs the update exit through the unchanged sequence and allows the restart only at its final exit', async () => {
  expect(EXIT_REASONS).toContain('update');
  let settle!: () => void;
  const f = restartFixture(() => new Promise<void>(resolve => {settle = resolve;}));
  expect(f.coordinator.request('update')).toBe(true);
  expect(f.hooks.log).toHaveBeenCalledExactlyOnceWith('APP_EXIT_REQUESTED', undefined, {reason: 'update'});
  for (const reason of ['tray', 'update', 'uninstall'] as const) expect(f.coordinator.request(reason)).toBe(false);
  expect(f.order).toEqual(['begin', 'stop']);
  // The service stop has not finished: nothing restarts yet.
  await vi.advanceTimersByTimeAsync(EXIT_IDLE_BUDGET_MS * 2); expect(f.order).toEqual(['begin', 'stop']);
  f.coordinator.finish(0);
  expect(f.order).toEqual(['begin', 'stop', 'tray', 'restart helper', 'exit 0']);
  settle();
});
it('waits for idle work before the restart and never restarts after a fatal stop or another reason', async () => {
  let settle!: () => void;
  const slow = restartFixture(() => new Promise<void>(resolve => {settle = resolve;}));
  slow.coordinator.request('update'); slow.coordinator.finish(0);
  expect(slow.order).toEqual(['begin', 'stop']);
  settle(); await Promise.resolve(); await Promise.resolve();
  expect(slow.order).toEqual(['begin', 'stop', 'tray', 'restart helper', 'exit 0']);
  const fatal = restartFixture();
  fatal.coordinator.abort(); expect(fatal.coordinator.request('update')).toBe(false); fatal.coordinator.finish(1);
  expect(fatal.order).toEqual(['tray', 'exit 1']);
  for (const reason of ['tray', 'renderer', 'app-quit', 'session-end', 'uninstall'] as const) {
    const other = restartFixture(); other.coordinator.request(reason); other.coordinator.finish(0);
    expect(other.order).toEqual(['begin', 'stop', 'tray', 'exit 0']);
  }
  expect(startsUpdatedApplication(undefined)).toBe(false);
});
