import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {SERVICE_EXIT_RESERVE_MS, SERVICE_KILL_DEADLINE_MS, ServiceSupervisor, stopTimeLeftMs} from '../../apps/desktop/src/service-supervisor';

beforeEach(() => vi.useFakeTimers());
// Review round 1 of the final log write (October 18, 2026): the stopping service's wait for an append in flight ends
// SERVICE_EXIT_RESERVE_MS before the kill deadline and is 0, with no floor, once a stop overran that point.
it('gives a stopping service the time left before the kill deadline, less the exit reserve, and 0 after it', () => {
  expect([SERVICE_KILL_DEADLINE_MS, SERVICE_EXIT_RESERVE_MS]).toEqual([3000, 300]);
  expect([0, 20, 2500, 2503, 2700, 2750, 2900, 5000].map(stopTimeLeftMs)).toEqual([2700, 2680, 200, 197, 0, 0, 0, 0]);
});
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

it('recovers widely separated crashes but bounds three crashes within a minute', async () => {
  const service = {postMessage: vi.fn(), kill: vi.fn(() => true)};
  const exhausted = vi.fn(); const restart = vi.fn();
  const supervisor = new ServiceSupervisor(vi.fn(), vi.fn(), {restart, state: vi.fn(), exhausted});
  for (let index = 0; index < 4; index++) {
    supervisor.attach(service); supervisor.ready(); supervisor.serviceExited(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(restart).toHaveBeenCalledTimes(index + 1);
    await vi.advanceTimersByTimeAsync(60000);
  }
  expect(exhausted).not.toHaveBeenCalled();
  for (let index = 0; index < 3; index++) {
    supervisor.attach(service); supervisor.ready(); supervisor.serviceExited(1);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(restart).toHaveBeenCalledTimes(6); expect(exhausted).toHaveBeenCalledOnce();
  supervisor.stop(); expect(vi.getTimerCount()).toBe(0);
});

function recovering() {
  const log = vi.fn(), exit = vi.fn(), restart = vi.fn(), state = vi.fn(), exhausted = vi.fn(), failure = vi.fn();
  const service = {postMessage: vi.fn(), kill: vi.fn(() => true)};
  const supervisor = new ServiceSupervisor(log, exit, {restart, state, exhausted, failure});
  supervisor.attach(service);
  return {log, exit, restart, state, exhausted, failure, service, supervisor};
}
it.each(['SERVICE_START_FAILED', 'STORAGE_WORKER_EXIT'])('recovers a post-readiness %s report by terminating and restarting the service', async code => {
  const f = recovering(); expect(f.supervisor.ready()).toBe(true);
  f.supervisor.serviceFailed(code); f.supervisor.serviceFailed(code);
  expect(f.service.kill).toHaveBeenCalledOnce(); expect(f.failure).toHaveBeenCalledExactlyOnceWith(code);
  expect(f.exit).not.toHaveBeenCalled(); expect(f.supervisor.stopping).toBe(false);
  // A late readiness message from the terminated service is not accepted.
  expect(f.supervisor.ready()).toBe(false);
  f.supervisor.serviceExited(1);
  expect(f.state.mock.calls).toEqual([['service-failed'], ['restarting']]);
  await vi.advanceTimersByTimeAsync(250); expect(f.restart).toHaveBeenCalledOnce();
  f.supervisor.attach(f.service); expect(f.supervisor.ready()).toBe(true);
  expect(f.exit).not.toHaveBeenCalled();
  f.supervisor.stop(); f.supervisor.serviceExited(0); expect(f.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('recovers a restarted service that misses its start deadline instead of exiting', async () => {
  const f = recovering(); f.supervisor.ready(); f.supervisor.serviceExited(1);
  await vi.advanceTimersByTimeAsync(250); f.supervisor.attach(f.service);
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.failure).toHaveBeenCalledExactlyOnceWith('SERVICE_START_TIMEOUT'); expect(f.service.kill).toHaveBeenCalledOnce();
  expect(f.exit).not.toHaveBeenCalled();
  f.supervisor.serviceExited(1); await vi.advanceTimersByTimeAsync(1000); expect(f.restart).toHaveBeenCalledTimes(2);
  f.supervisor.stop(); expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])('fails when a post-readiness kill is not followed by an exit within 3000 ms (kill throws: %s)', async throws => {
  const f = recovering(); f.supervisor.ready();
  if (throws) f.service.kill.mockImplementation(() => {throw new Error('kill failed');});
  f.supervisor.serviceFailed('SERVICE_START_FAILED');
  await vi.advanceTimersByTimeAsync(2999); expect(f.exit).not.toHaveBeenCalled(); expect(f.supervisor.stopping).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.log).toHaveBeenCalledWith('SERVICE_RECOVERY_TIMEOUT', undefined); expect(f.supervisor.stopping).toBe(true);
  expect(f.service.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'stop'});
  await vi.advanceTimersByTimeAsync(5000); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('keeps restart exhaustion visible without exiting after post-readiness failures', async () => {
  const f = recovering();
  for (let index = 0; index < 3; index++) {
    if (index) f.supervisor.attach(f.service);
    f.supervisor.ready(); f.supervisor.serviceFailed('SERVICE_START_FAILED'); f.supervisor.serviceExited(1);
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(f.restart).toHaveBeenCalledTimes(2); expect(f.exhausted).toHaveBeenCalledOnce();
  expect(f.exit).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  f.supervisor.stop(); expect(f.exit).toHaveBeenCalledOnce();
});
it.each(['report', 'timeout'])('keeps pre-readiness %s failures fatal even with recovery configured', async kind => {
  const f = recovering();
  if (kind === 'report') f.supervisor.serviceFailed('SERVICE_START_FAILED'); else await vi.advanceTimersByTimeAsync(15000);
  expect(f.failure).not.toHaveBeenCalled(); expect(f.service.kill).not.toHaveBeenCalled();
  expect(f.supervisor.stopping).toBe(true); expect(f.service.postMessage).toHaveBeenCalledExactlyOnceWith({type: 'stop'});
  f.supervisor.serviceExited(0); expect(f.exit).toHaveBeenCalledExactlyOnceWith(1);
});
it.each(['orderly', 'fatal'])('reports the start of an %s stop once, before the stop can finish', kind => {
  const order: string[] = [];
  const exit = vi.fn(() => order.push('exit')), stopping = vi.fn(() => order.push('stopping'));
  const supervisor = new ServiceSupervisor(vi.fn(), exit, {restart: vi.fn(), state: vi.fn(), exhausted: vi.fn(), stopping});
  if (kind === 'orderly') supervisor.stop(); else supervisor.fail('RENDERER_RESTART_EXHAUSTED');
  supervisor.stop(); supervisor.fail('OVERLAY_LOAD_FAILED');
  expect(stopping).toHaveBeenCalledOnce(); expect(order).toEqual(['stopping', 'exit']);
  expect(exit).toHaveBeenCalledExactlyOnceWith(kind === 'orderly' ? 0 : 1);
});
