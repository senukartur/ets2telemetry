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
const projected: OverlayPresentation = {source: 'ETS2', origin: 'synthetic', status: 'connected', speed: '90.0', fuel: '73.0', speedUnit: 'km/h', fuelUnit: 'L', freshness: 'current'};
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules(); ipc = Object.assign(new EventEmitter(), {send: vi.fn()});
  vi.doMock('electron', () => ({ipcRenderer: ipc, contextBridge: {exposeInMainWorld: (key: string, value: OverlayBridge) => {expect(key).toBe('overlay'); bridge = value;}}}));
  await import('../../apps/desktop/src/overlay-preload');
});
afterEach(() => {vi.clearAllTimers(); vi.useRealTimers(); vi.doUnmock('electron');});
function attach() {const port = new Port(); ipc.emit('overlay:port', {ports: [port]}); return port;}
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
