import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {OverlayBridge, OverlayPresentation} from '../../packages/contracts/src';
class Port {
  events = new EventEmitter();
  onmessage?: (event: {data: unknown}) => void;
  onmessageerror?: () => void;
  closed = false;
  postMessage = vi.fn();
  start() {}
  addEventListener(type: string, listener: () => void) {this.events.on(type, listener);}
  close() {if (!this.closed) {this.closed = true; this.events.emit('close');}}
  deliver(update: OverlayPresentation, delivery = 1) {this.onmessage?.({data: {type: 'live', delivery, update}});}
}
let bridge: OverlayBridge;
let ipc: EventEmitter & {send: ReturnType<typeof vi.fn>};
const projected: OverlayPresentation = {source: 'ETS2', origin: 'synthetic', status: 'connected', speed: '90.0', fuel: '73.0', speedUnit: 'km/h', fuelUnit: 'L', freshness: 'current',
  layout: 'card', paused: true, sections: [{id: 'speed', state: 'value', text: '90.0 km/h'}, {id: 'rpm', state: 'value', text: '1500 rpm', ring: 0.5}, {id: 'fuel', state: 'unavailable'}]};
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); ipc = Object.assign(new EventEmitter(), {send: vi.fn()});
  const started = Date.now(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - started);
  vi.doMock('electron', () => ({ipcRenderer: ipc, contextBridge: {exposeInMainWorld: (key: string, value: OverlayBridge) => {expect(key).toBe('overlay'); bridge = value;}}}));
  await import('../../apps/desktop/src/overlay-preload');
});
afterEach(() => {vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.doUnmock('electron');});
function attach() {const port = new Port(); ipc.emit('overlay:port', {ports: [port]}); return port;}
function subscriptions() {return ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe').length;}
async function exhaustRecovery() {
  const retired: Port[] = [];
  for (let loss = 0; loss < 3; loss++) {
    const next = attach(); retired.push(next); next.close();
    if (loss < 2) await vi.advanceTimersByTimeAsync(250);
  }
  expect(subscriptions()).toBe(3); expect(vi.getTimerCount()).toBe(1);
  return retired;
}
it('exposes only a frozen subscription, rejects duplicate listeners and sends independent credits', () => {
  expect(Object.isFrozen(bridge)).toBe(true); expect(Object.keys(bridge)).toEqual(['subscribeOverlay']);
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive); expect(() => bridge.subscribeOverlay(vi.fn())).toThrow('One overlay');
  const port = attach(); port.deliver(projected, 27);
  expect(receive.mock.lastCall?.[0]).toEqual(projected); expect(port.postMessage).toHaveBeenCalledWith({type: 'consumed', delivery: 27});
  stop(); stop(); expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:unsubscribe')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
it('blanks metrics on quiet transport expiry without inventing stale initial service status', async () => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), port = attach(); port.deliver(projected);
  await vi.advanceTimersByTimeAsync(500); expect(receive.mock.lastCall?.[0]).toMatchObject({speed: '—', fuel: '—', freshness: 'stale'});
  port.deliver({...projected, status: 'service-failed', freshness: 'unavailable', speed: '—', fuel: '—'}, 2);
  await vi.advanceTimersByTimeAsync(1000); expect(receive.mock.lastCall?.[0].status).toBe('service-failed'); stop();
});
it('retires old deliveries, fails closed on malformed credits and bounds recovery', async () => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), first = attach(); first.deliver(projected);
  const second = attach(); expect(first.closed).toBe(true); expect(receive.mock.lastCall?.[0].freshness).toBe('stale');
  const count = receive.mock.calls.length; first.deliver(projected, 9); expect(receive).toHaveBeenCalledTimes(count);
  second.onmessage?.({data: {type: 'live', delivery: 0, update: projected}});
  await vi.advanceTimersByTimeAsync(250); attach().onmessageerror?.();
  await vi.advanceTimersByTimeAsync(250); attach().close(); await vi.advanceTimersByTimeAsync(1000);
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe')).toHaveLength(3);
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('cancels retired-owner recovery and rejects unsolicited or multiple transferred ports', async () => {
  const unsolicited = attach(); expect(unsolicited.closed).toBe(true);
  const stop = bridge.subscribeOverlay(vi.fn()); const a = new Port(), b = new Port(); ipc.emit('overlay:port', {ports: [a, b]});
  expect(a.closed && b.closed).toBe(true); attach().close(); stop(); await vi.advanceTimersByTimeAsync(1000);
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe')).toHaveLength(1);
});
it('recovers a third consumer loss after a bounded cooldown without restoring retired readings', async () => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive);
  const retired: Port[] = [];
  for (let loss = 0; loss < 3; loss++) {
    const next = attach(); retired.push(next); next.deliver(projected, loss + 1);
    await vi.advanceTimersByTimeAsync(501); next.close();
    if (loss < 2) await vi.advanceTimersByTimeAsync(250);
  }
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe')).toHaveLength(3);
  expect(receive.mock.lastCall?.[0]).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
  await vi.advanceTimersByTimeAsync(59999);
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe')).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(251);
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:subscribe')).toHaveLength(4);
  const count = receive.mock.calls.length;
  for (const old of retired) {old.deliver(projected, 99); old.onmessageerror?.();}
  expect(receive).toHaveBeenCalledTimes(count);
  expect(vi.getTimerCount()).toBe(0);
  const recovered = attach(); expect(receive.mock.lastCall?.[0].freshness).toBe('stale');
  recovered.deliver({...projected, speed: '91.0'}, 4);
  expect(receive.mock.lastCall?.[0]).toMatchObject({freshness: 'current', speed: '91.0'});
  expect(recovered.postMessage).toHaveBeenCalledWith({type: 'consumed', delivery: 4});
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('bounds recurring losses to two recovery requests per sliding minute with one pending timer', async () => {
  const attempts: number[] = [];
  ipc.send.mockImplementation((channel: string) => {if (channel === 'overlay:subscribe') attempts.push(performance.now());});
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive);
  for (let loss = 0; loss < 10; loss++) {
    const next = attach(); next.deliver(projected, loss + 1);
    await vi.advanceTimersByTimeAsync(501); next.close();
    const count = subscriptions(); expect(vi.getTimerCount()).toBe(1);
    next.onmessageerror?.(); next.deliver(projected, 100);
    expect(vi.getTimerCount()).toBe(1);
    expect(receive.mock.lastCall?.[0]).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
    await vi.advanceTimersByTimeAsync(250);
    if (subscriptions() === count) await vi.advanceTimersByTimeAsync(60000);
    expect(subscriptions()).toBe(count + 1); expect(vi.getTimerCount()).toBe(0);
  }
  const retries = attempts.slice(1);
  for (const time of retries) expect(retries.filter(attempt => attempt <= time && time - attempt < 60000).length).toBeLessThanOrEqual(2);
  expect(retries).toHaveLength(10); stop();
});
it.each(['unsubscribe', 'replacement'])('cancels an exhausted-budget cooldown on %s', async reason => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), retired = await exhaustRecovery();
  if (reason === 'unsubscribe') stop();
  else attach().deliver({...projected, speed: '92.0'}, 4);
  const count = receive.mock.calls.length;
  for (const old of retired) {old.close(); old.onmessageerror?.(); old.deliver(projected);}
  expect(receive).toHaveBeenCalledTimes(count);
  await vi.advanceTimersByTimeAsync(61000);
  expect(subscriptions()).toBe(3); expect(vi.getTimerCount()).toBe(0); stop();
});
it('does not let a retired owner renew a new subscription timer, credits or readings', async () => {
  const firstReceive = vi.fn(), firstStop = bridge.subscribeOverlay(firstReceive), retired = await exhaustRecovery();
  firstStop(); const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), next = attach(); next.deliver(projected, 4);
  const firstCount = firstReceive.mock.calls.length, count = receive.mock.calls.length;
  await vi.advanceTimersByTimeAsync(499);
  for (const old of retired) {old.onmessageerror?.(); old.deliver({...projected, speed: '999'}, 999);}
  firstStop(); expect(firstReceive).toHaveBeenCalledTimes(firstCount); expect(receive).toHaveBeenCalledTimes(count);
  expect(next.postMessage).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(receive.mock.lastCall?.[0]).toMatchObject({freshness: 'stale', speed: '—'});
  await vi.advanceTimersByTimeAsync(61000); expect(subscriptions()).toBe(4); expect(vi.getTimerCount()).toBe(0);
  stop();
});
it('abandons old loss recovery when the stale callback replaces its subscription owner', async () => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), old = attach(); old.deliver(projected);
  const replacement = vi.fn(); let replacementStop!: () => void;
  receive.mockImplementationOnce(() => {stop(); replacementStop = bridge.subscribeOverlay(replacement);});
  old.close(); expect(subscriptions()).toBe(2);
  expect(ipc.send.mock.calls.filter(call => call[0] === 'overlay:unsubscribe')).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0); await vi.advanceTimersByTimeAsync(61000); expect(subscriptions()).toBe(2);
  old.deliver(projected); expect(replacement).not.toHaveBeenCalled(); replacementStop();
});
it('rechecks the monotonic budget at cooldown expiry and waits again if the clock is invalid', async () => {
  const stop = bridge.subscribeOverlay(vi.fn()); await exhaustRecovery();
  const clock = vi.spyOn(performance, 'now'); clock.mockReturnValue(NaN);
  await vi.advanceTimersByTimeAsync(60250); expect(subscriptions()).toBe(3); expect(vi.getTimerCount()).toBe(1);
  clock.mockReturnValue(120500);
  await vi.advanceTimersByTimeAsync(60000); expect(subscriptions()).toBe(4); expect(vi.getTimerCount()).toBe(0); stop();
});
// ET-012a: the quiet deadline blanks every section but keeps the layout and section list, so the overlay does not jump.
it('blanks every section on quiet transport expiry and keeps the layout and units', async () => {
  const receive = vi.fn(), stop = bridge.subscribeOverlay(receive), port = attach(); port.deliver(projected);
  await vi.advanceTimersByTimeAsync(500);
  expect(receive.mock.lastCall?.[0]).toEqual({source: 'ETS2', origin: 'synthetic', status: 'stale', speed: '—', fuel: '—', speedUnit: 'km/h', fuelUnit: 'L',
    freshness: 'stale', layout: 'card', paused: false, sections: [{id: 'speed', state: 'unavailable'}, {id: 'rpm', state: 'unavailable'}, {id: 'fuel', state: 'unavailable'}]});
  stop();
});
