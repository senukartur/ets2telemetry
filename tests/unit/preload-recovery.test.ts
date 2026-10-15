import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopBridge, LiveTelemetry} from '../../packages/contracts/src';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveSubscriptions} from '../../apps/desktop/src/live-subscriptions';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';

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
it('does not extend SDK expiry for equal captures and expires window metadata separately', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot') throw new Error('Expected snapshot');
  const live: LiveTelemetry = {...connected(), observation: {source: message.source, state: message.data.state, seq: message.seq,
    capture: message.capture, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}}};
  port.deliver(live); await vi.advanceTimersByTimeAsync(400);
  port.deliver({...live, observation: {...live.observation!, windowReceivedMonotonicMs: 400}}, 2);
  await vi.advanceTimersByTimeAsync(101); expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, observation: {windowFresh: true}});
  await vi.advanceTimersByTimeAsync(150); expect(consume.mock.lastCall?.[0].observation.windowFresh).toBe(false);
  port.deliver({...live, observation: {...live.observation!, windowReceivedMonotonicMs: 400}}, 3);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, observation: {windowFresh: false}});
  port.deliver({...live, observation: {...live.observation!, receivedMonotonicMs: 700, windowReceivedMonotonicMs: 700,
    capture: {...message.capture, monotonicNs: (BigInt(message.capture.monotonicNs) + 1n).toString()}}}, 4);
  expect(consume.mock.lastCall?.[0].fresh).toBe(true); stop(); expect(vi.getTimerCount()).toBe(0);
});
it('invalidates fresh window metadata when a replacement port arrives after SDK expiry', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot') throw new Error('Expected snapshot');
  port.deliver({...connected(), fresh: false, status: 'stale', observation: {source: message.source, state: message.data.state,
    seq: message.seq, capture: message.capture, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 600, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}}});
  attach(); await vi.advanceTimersByTimeAsync(251);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, observation: {windowFresh: false}});
  stop(); expect(vi.getTimerCount()).toBe(0);
});

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
  expect(subscriptions()).toBe(3); // Immediate trusted intent replaces obsolete delayed port recovery.
  await vi.advanceTimersByTimeAsync(1000); expect(subscriptions()).toBe(3);
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
  expect(Object.isFrozen(bridge)).toBe(true); expect(Object.keys(bridge).sort()).toEqual(['exitApplication', 'getAppState', 'getStatus', 'selectSource', 'setUnitProfile', 'subscribeAppState', 'subscribeLive']);
  await expect(bridge.selectSource('C:\\arbitrary.exe' as never)).rejects.toThrow('Invalid source selection');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await bridge.selectSource('ats'); expect(ipc.invoke).toHaveBeenCalledWith('telemetry:select', 'ats');
});

it.each(['close-first', 'state-first'])('preserves active main subscription intent across service replacement (%s)', async order => {
  // Main's existing trusted handlers retain intent while serviceReady=false; ready only transfers when that intent is true.
  let subscribed = false;
  ipc.send.mockImplementation((channel: string) => {
    if (channel === 'telemetry:subscribe') subscribed = true;
    if (channel === 'telemetry:unsubscribe') subscribed = false;
  });
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const old = attach(); old.deliver(connected());
  const states = () => {
    ipc.emit('telemetry:service-state', {}, {...initialLive('synthetic'), status: 'service-failed'});
    ipc.emit('telemetry:service-state', {}, {...initialLive('synthetic'), status: 'restarting'});
  };
  if (order === 'close-first') {old.close(); states();} else {states(); old.close();}
  expect(consume.mock.lastCall?.[0]).toMatchObject({status: 'restarting', fresh: false});
  expect(subscribed).toBe(true);
  if (subscribed) attach().deliver(connected());
  expect(consume.mock.lastCall?.[0]).toMatchObject({status: 'connected', fresh: true});
  const requestCount = subscriptions(); await vi.advanceTimersByTimeAsync(250);
  expect(subscriptions()).toBe(requestCount); // Obsolete closure recovery did not issue another request.
  old.deliver(connected(), 2); expect(consume.mock.lastCall?.[0].fresh).toBe(true);
  stop(); expect(subscribed).toBe(false); expect(vi.getTimerCount()).toBe(0);
});
it('does not reassert service subscription after the callback unsubscribes its owner', () => {
  const onUpdate = (update: LiveTelemetry) => {if (update.status === 'restarting') stop();};
  const stop = bridge.subscribeLive(onUpdate); const old = attach();
  ipc.emit('telemetry:service-state', {}, {...initialLive(), status: 'restarting'});
  old.close(); ipc.emit('telemetry:service-state', {}, {...initialLive(), status: 'service-failed'});
  expect(subscriptions()).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it('appends the application state and exit methods after the original three bridge keys', () => {
  expect(Object.keys(bridge)).toEqual(['getStatus', 'selectSource', 'subscribeLive', 'getAppState', 'subscribeAppState', 'exitApplication', 'setUnitProfile']);
});
it('allows one application state listener, forwards pushed state and unsubscribes once', () => {
  const listener = vi.fn(); const stop = bridge.subscribeAppState(listener);
  expect(ipc.send).toHaveBeenCalledExactlyOnceWith('app:subscribe-state');
  expect(() => bridge.subscribeAppState(vi.fn())).toThrow('One application state subscription');
  expect(() => bridge.subscribeAppState('not a function' as never)).toThrow();
  const state = {health: {service: 'ready', storage: 'verified', recording: 'unavailable', lastError: null}};
  ipc.emit('app:state', {}, state); expect(listener).toHaveBeenCalledExactlyOnceWith(state);
  stop(); stop(); expect(ipc.send.mock.calls.filter(call => call[0] === 'app:unsubscribe-state')).toHaveLength(1);
  ipc.emit('app:state', {}, state); expect(listener).toHaveBeenCalledOnce();
  const next = vi.fn(); bridge.subscribeAppState(next); ipc.emit('app:state', {}, state); expect(next).toHaveBeenCalledOnce();
});
it('requests state and exit through fixed invoke channels without forwarding renderer arguments', async () => {
  await bridge.getAppState(); await Reflect.apply(bridge.exitApplication, bridge, ['C:\\arbitrary', {force: true}]);
  expect(ipc.invoke.mock.calls).toEqual([['app:get-state'], ['app:exit']]);
});
// ET-011b: one appended settings method that forwards only the two validated enums.
it('validates unit profile requests before IPC and forwards exactly a game and a profile', async () => {
  for (const [game, profile] of [['ets2', 'imperial'], ['ETS2', 'metric'], ['synthetic', 'metric'], ['ats', 'C:\\settings.json'], [undefined, undefined], [{}, 'metric']]) {
    await expect(bridge.setUnitProfile(game as never, profile as never)).rejects.toThrow('Invalid unit profile request');
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
  const view = {units: {ets2: 'us-customary', ats: 'us-customary'}, state: 'loaded', writable: true, saveError: null};
  ipc.invoke.mockResolvedValueOnce(view);
  await expect(Reflect.apply(bridge.setUnitProfile, bridge, ['ets2', 'us-customary', {path: 'C:\\arbitrary'}])).resolves.toEqual(view);
  expect(ipc.invoke.mock.calls).toEqual([['settings:set-unit-profile', 'ets2', 'us-customary']]);
});
