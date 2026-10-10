import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ServiceSupervisor} from '../../apps/desktop/src/service-supervisor';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function fixture() {
  const log = vi.fn();
  const exit = vi.fn();
  const service = {postMessage: vi.fn(), kill: vi.fn(() => true)};
  const supervisor = new ServiceSupervisor(log, exit);
  supervisor.attach(service);
  return {log, exit, service, supervisor};
}

it('bounds silent startup and forces exit even when stop IPC and kill throw', async () => {
  const f = fixture();
  f.service.postMessage.mockImplementation(() => {throw new Error('closed port');});
  f.service.kill.mockImplementation(() => {throw new Error('kill failed');});
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.supervisor.ready()).toBe(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(f.service.kill).toHaveBeenCalledOnce();
  expect(f.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2000);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('accepts readiness once, cancels startup timeout and exits cleanly after stop', async () => {
  const f = fixture();
  expect(f.supervisor.ready()).toBe(true);
  expect(f.supervisor.ready()).toBe(false);
  await vi.advanceTimersByTimeAsync(20000);
  expect(f.exit).not.toHaveBeenCalled();
  f.supervisor.stop();
  f.supervisor.stop();
  expect(f.service.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'stop'});
  f.supervisor.serviceExited(0);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});

it('retains failure when the service subsequently exits successfully', () => {
  const f = fixture();
  f.supervisor.fail('SERVICE_START_FAILED');
  f.supervisor.serviceExited(0);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
});

it('treats unsolicited service exit as failure and never opens a late window', () => {
  const f = fixture();
  f.supervisor.serviceExited(0);
  expect(f.supervisor.ready()).toBe(false);
  expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('can stop before a service is created', () => {
  const exit = vi.fn();
  const supervisor = new ServiceSupervisor(vi.fn(), exit);
  supervisor.stop();
  expect(supervisor.stopping).toBe(true);
  expect(exit).toHaveBeenCalledExactlyOnceWith(0);
});
