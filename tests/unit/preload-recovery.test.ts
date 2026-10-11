import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopBridge, LiveTelemetry} from '../../packages/contracts/src';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveSubscriptions} from '../../apps/desktop/src/live-subscriptions';

class RendererPort {
  onmessage?: (event: {data: unknown}) => void;
  onmessageerror?: () => void;
  events = new EventEmitter();
  closed = false;
  postMessage = vi.fn();
  start() {}
  addEventListener(type: string, listener: () => void) {this.events.on(type, listener);}
  close() {if (!this.closed) {this.closed = true; this.events.emit('close');}}
  deliver(update: LiveTelemetry, delivery = 1) {this.onmessage?.({data: {type: 'live', delivery, update}});}
}
let ipc: EventEmitter & {send: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>};
let bridge: DesktopBridge;
beforeEach(async () => {
  vi.useFakeTimers(); vi.resetModules();
  ipc = Object.assign(new EventEmitter(), {send: vi.fn(), invoke: vi.fn()});
  vi.doMock('electron', () => ({ipcRenderer: ipc, contextBridge: {exposeInMainWorld: (_key: string, value: DesktopBridge) => {bridge = value;}}}));
  await import('../../apps/desktop/src/preload');
});
afterEach(() => {vi.useRealTimers(); vi.doUnmock('electron');});
const connected = (): LiveTelemetry => ({...initialLive('synthetic'), status: 'connected', fresh: true});
function attach() {const port = new RendererPort(); ipc.emit('telemetry:port', {ports: [port]}); return port;}
function subscriptions() {return ipc.send.mock.calls.filter(call => call[0] === 'telemetry:subscribe').length;}

it('expires current data while keeping a quiet healthy subscription open', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  port.deliver(connected()); await vi.advanceTimersByTimeAsync(501);
  expect(consume.mock.lastCall?.[0]).toMatchObject({status: 'stale', fresh: false});
  expect(port.closed).toBe(false); expect(subscriptions()).toBe(1);
  await vi.advanceTimersByTimeAsync(60000); expect(subscriptions()).toBe(1);
  port.deliver(connected(), 2); expect(consume.mock.lastCall?.[0].fresh).toBe(true);
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('marks a closed subscription stale, bounds reauthorization and ignores retired deliveries', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const first = attach();
  first.deliver(connected()); first.close();
  expect(consume.mock.lastCall?.[0].fresh).toBe(false);
  await vi.advanceTimersByTimeAsync(250); expect(subscriptions()).toBe(2);
  const second = attach(); second.deliver(connected()); const count = consume.mock.calls.length;
  first.deliver(connected(), 3); expect(consume).toHaveBeenCalledTimes(count);
  second.close(); await vi.advanceTimersByTimeAsync(250); expect(subscriptions()).toBe(3);
  attach().close(); await vi.advanceTimersByTimeAsync(1000); expect(subscriptions()).toBe(3);
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('cancels closure recovery on unsubscribe or a main-owned service restart', async () => {
  const stop = bridge.subscribeLive(vi.fn()); attach().close(); stop();
  await vi.advanceTimersByTimeAsync(1000); expect(subscriptions()).toBe(1);
  const stopAgain = bridge.subscribeLive(vi.fn()); attach().close();
  ipc.emit('telemetry:service-state', {}, {...initialLive(), status: 'restarting'});
  await vi.advanceTimersByTimeAsync(1000); expect(subscriptions()).toBe(2);
  stopAgain(); expect(vi.getTimerCount()).toBe(0);
});

it('recovers an actual fanout acknowledgement timeout and marks message decode failures stale', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const renderer = attach();
  const messages: unknown[] = [];
  const events = new EventEmitter();
  const service = Object.assign(events, {start() {}, close() {renderer.close(); events.emit('close');}, postMessage(value: unknown) {messages.push(value);}});
  const fanout = new LiveSubscriptions(connected()); fanout.attach(service);
  // The renderer is stalled: a transferred message exists, but callback consumption never returns a credit.
  expect(messages).toHaveLength(1); await vi.advanceTimersByTimeAsync(5000);
  expect(renderer.closed).toBe(true); expect(consume.mock.lastCall?.[0].fresh).toBe(false);
  await vi.advanceTimersByTimeAsync(250); expect(subscriptions()).toBe(2);
  const next = attach(); next.deliver(connected()); next.onmessageerror?.();
  expect(consume.mock.lastCall?.[0].fresh).toBe(false);
  stop(); fanout.close(); expect(vi.getTimerCount()).toBe(0);
});

it('does not expose the previous observation as current while a replacement port awaits delivery', () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); attach().deliver(connected());
  const replacement = attach(); expect(consume.mock.lastCall?.[0].fresh).toBe(false);
  replacement.deliver(connected()); expect(consume.mock.lastCall?.[0].fresh).toBe(true);
  stop();
});
it('preserves the frozen narrow bridge and rejects privileged source values before IPC', async () => {
  expect(Object.isFrozen(bridge)).toBe(true); expect(Object.keys(bridge).sort()).toEqual(['getStatus', 'selectSource', 'subscribeLive']);
  await expect(bridge.selectSource('C:\\arbitrary.exe' as never)).rejects.toThrow('Invalid source selection');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await bridge.selectSource('ats'); expect(ipc.invoke).toHaveBeenCalledWith('telemetry:select', 'ats');
});
