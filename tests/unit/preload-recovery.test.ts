import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopBridge, LiveTelemetry} from '../../packages/contracts/src';
import {initialLive} from '../../apps/desktop/src/live-state';
import {LiveSubscriptions} from '../../apps/desktop/src/live-subscriptions';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {smokePair} from '../shared/live-v1-fixtures';

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
// ET-010c decisions F2 and F3: the preload validates the v1 projection again and expires it on its own clock.
function v0Renewed(update: LiveTelemetry, monotonicNs: number): LiveTelemetry {
  return {...update, observation: {...update.observation!, receivedMonotonicMs: monotonicNs, capture: {...update.observation!.capture, monotonicNs: String(monotonicNs)}}};
}
it('expires v1 data 500 ms after its last new boundary although new v0 captures keep arriving', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  port.deliver(smokePair());
  for (let step = 1; step <= 4; step++) {await vi.advanceTimersByTimeAsync(100); port.deliver(v0Renewed(smokePair(), step * 100), step + 1);}
  await vi.advanceTimersByTimeAsync(99);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: true, v1: {fresh: true, status: 'connected'}});
  await vi.advanceTimersByTimeAsync(1);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: true, status: 'connected', v1: {fresh: false, status: 'stale', reason: 'Renderer has no recent v1 SDK capture'}});
  // A new v1 boundary renews it; the expired v0 clock is not renewed by it.
  await vi.advanceTimersByTimeAsync(400);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, reason: 'Renderer has no recent SDK capture'});
  const renewed = v0Renewed(smokePair({receivedMonotonicMs: 900}), 400);
  port.deliver(renewed, 6);
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, v1: {fresh: true, status: 'connected'}});
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('never passes an invalid or foreign v1 projection to the listener and keeps the v0 update', () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  const withWindow = smokePair();
  (withWindow.v1!.observation!.state as unknown as Record<string, unknown>).window = {available: false, reason: 'not-observed'};
  const foreign = smokePair({selection: 'replay'});
  const extra = smokePair(); (extra.v1 as unknown as Record<string, unknown>).durable = {state: 'off'};
  [withWindow, foreign, extra].forEach((update, index) => {
    port.deliver(update, index + 1);
    expect(consume.mock.lastCall?.[0]).not.toHaveProperty('v1');
    expect(consume.mock.lastCall?.[0]).toMatchObject({selection: 'synthetic', status: 'connected', fresh: true});
  });
  expect(port.closed).toBe(false);
  stop();
});
it('marks v1 data stale when the subscription closes or a replacement port awaits data', () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume);
  const first = attach(); first.deliver(smokePair()); first.close();
  expect(consume.mock.lastCall?.[0]).toMatchObject({fresh: false, v1: {fresh: false, status: 'stale', reason: 'Live subscription closed; current interval is unknown'}});
  // Only v1 is fresh: the replacement port stales it and leaves the v0 status alone.
  const waiting = smokePair({}, {status: 'waiting', fresh: false, reason: 'Awaiting selected source'}); waiting.observation!.windowFresh = false;
  const second = attach(); second.deliver(waiting);
  expect(consume.mock.lastCall?.[0]).toMatchObject({status: 'waiting', v1: {fresh: true}});
  attach();
  expect(consume.mock.lastCall?.[0]).toMatchObject({status: 'waiting', reason: 'Awaiting selected source',
    v1: {fresh: false, status: 'stale', reason: 'Replacement live subscription awaits a current observation'}});
  stop(); expect(vi.getTimerCount()).toBe(0);
});
it('preserves the frozen narrow bridge and rejects privileged source values before IPC', async () => {
  expect(Object.isFrozen(bridge)).toBe(true); expect(Object.keys(bridge).sort()).toEqual(['beginOverlayEdit', 'choosePluginFolder', 'exitApplication', 'exportDiagnostics', 'exportJournalTrip', 'finishOverlayEdit', 'getAppState', 'getJournalTrip', 'getStatus',
    'listJournalEvents', 'listJournalIntervals', 'listJournalSamples', 'listJournalTrips', 'openPluginFolder',
    'resetOverlayEditPlacement', 'retryPluginSetup', 'selectSource', 'setLanguage', 'setOverlayEditScale', 'setOverlayLayout', 'setOverlaySections', 'setPluginGameExcluded', 'setUnitProfile',
    'showPluginFile', 'subscribeAppState', 'subscribeLive', 'uninstallApplication']);
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
  // ET-012a appends the two overlay settings methods, ET-012b the four overlay edit methods, ET-016 PR-3 the five journal reads,
  // ET-016 PR-5 the trip export, ET-017 PR-4 the five plugin setup methods, ET-017 PR-6 the diagnostics export and ET-018
  // PR-4 the in-app uninstall.
  expect(Object.keys(bridge)).toEqual(['getStatus', 'selectSource', 'subscribeLive', 'getAppState', 'subscribeAppState', 'exitApplication', 'setLanguage', 'setUnitProfile',
    'setOverlayLayout', 'setOverlaySections', 'beginOverlayEdit', 'setOverlayEditScale', 'resetOverlayEditPlacement', 'finishOverlayEdit',
    'listJournalTrips', 'getJournalTrip', 'listJournalEvents', 'listJournalIntervals', 'listJournalSamples', 'exportJournalTrip',
    'retryPluginSetup', 'choosePluginFolder', 'setPluginGameExcluded', 'showPluginFile', 'openPluginFolder', 'exportDiagnostics', 'uninstallApplication']);
});
it('allows one application state listener, forwards pushed state and unsubscribes once', () => {
  const listener = vi.fn(); const stop = bridge.subscribeAppState(listener);
  expect(ipc.send).toHaveBeenCalledExactlyOnceWith('app:subscribe-state');
  expect(() => bridge.subscribeAppState(vi.fn())).toThrow('One application state subscription');
  expect(() => bridge.subscribeAppState('not a function' as never)).toThrow();
  // ET-015c: the wider recording status passes through unchanged; the preload forwards main's state as it is.
  const state = {health: {service: 'ready', storage: 'verified', recording: {state: 'recording', target: 'synthetic', code: null,
    losses: {lostEvents: 2, eventLoss: 0, notConnected: 1, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}, trip: {phase: 'active', completeness: 'partial', untrackedJob: false}}, lastError: null}};
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
it('validates language requests before IPC and forwards exactly an allowed language', async () => {
  await expect(bridge.setLanguage('fr' as never)).rejects.toThrow('Invalid language');
  await expect(bridge.setLanguage(123 as never)).rejects.toThrow('Invalid language');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await bridge.setLanguage('ru');
  expect(ipc.invoke).toHaveBeenCalledWith('settings:set-language', 'ru');
});
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
// ET-012a: two appended overlay settings methods; each validates before IPC and forwards only the validated value.
const ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
const without = (record: Record<string, boolean>, key: string) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key));
it('validates overlay layout requests before IPC and forwards exactly one layout id', async () => {
  for (const layout of ['Strip', 'bar', '', undefined, null, 1, ['card'], {layout: 'card'}]) {
    await expect(bridge.setOverlayLayout(layout as never)).rejects.toThrow('Invalid overlay layout request');
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
  ipc.invoke.mockResolvedValueOnce({state: 'loaded'});
  await expect(Reflect.apply(bridge.setOverlayLayout, bridge, ['cluster', {path: 'C:\\arbitrary'}])).resolves.toEqual({state: 'loaded'});
  expect(ipc.invoke.mock.calls).toEqual([['settings:set-overlay-layout', 'cluster']]);
});
it('validates overlay section records strictly before IPC and forwards a fresh copy only', async () => {
  const invalid = [{...ALL_ON, extra: true}, without(ALL_ON, 'rpm'), {...ALL_ON, rpm: 'false'},
    Object.fromEntries(Object.keys(ALL_ON).map(id => [id, false])), [true], null, 'all', Object.assign(Object.create({x: 1}) as object, ALL_ON)];
  for (const sections of invalid) await expect(bridge.setOverlaySections(sections as never)).rejects.toThrow('Invalid overlay sections request');
  expect(ipc.invoke).not.toHaveBeenCalled();
  const input = {...ALL_ON, rpm: false};
  ipc.invoke.mockResolvedValueOnce({state: 'loaded'});
  await expect(Reflect.apply(bridge.setOverlaySections, bridge, [input, 'extra'])).resolves.toEqual({state: 'loaded'});
  expect(ipc.invoke.mock.calls).toEqual([['settings:set-overlay-sections', {...ALL_ON, rpm: false}]]);
  expect(ipc.invoke.mock.calls[0][1]).not.toBe(input);
});
// ET-012b: four appended overlay edit methods; each validates before IPC and forwards only fixed or validated values.
it('requests the overlay edit mode through fixed channels and forwards only a validated scale or outcome', async () => {
  for (const scale of [Number.NaN, Number.POSITIVE_INFINITY, 0.49, 2.01, '1.5', null, undefined, [1], {scale: 1}]) {
    await expect(bridge.setOverlayEditScale(scale as never)).rejects.toThrow('Invalid overlay edit request');
  }
  for (const outcome of ['Save', 'done', '', undefined, null, 1, {outcome: 'save'}]) {
    await expect(bridge.finishOverlayEdit(outcome as never)).rejects.toThrow('Invalid overlay edit request');
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
  ipc.invoke.mockResolvedValue({active: true});
  await Reflect.apply(bridge.beginOverlayEdit, bridge, ['card', {path: 'C:\\arbitrary'}]);
  await Reflect.apply(bridge.setOverlayEditScale, bridge, [1.234, 'extra']);
  await Reflect.apply(bridge.resetOverlayEditPlacement, bridge, [{x: 0}]);
  await Reflect.apply(bridge.finishOverlayEdit, bridge, ['save', {x: 0}]);
  await bridge.finishOverlayEdit('cancel');
  expect(ipc.invoke.mock.calls).toEqual([['overlay-edit:begin'], ['overlay-edit:set-scale', 1.23], ['overlay-edit:reset'], ['overlay-edit:finish', 'save'],
    ['overlay-edit:finish', 'cancel']]);
});
// ET-017 PR-4 (P16): the five plugin setup methods. Each validates its arguments before it invokes its fixed channel and
// forwards only the validated values; anything else rejects without IPC. Extra arguments are never forwarded.
it('validates plugin setup requests before IPC and forwards only a game, an exclusion flag or a target id', async () => {
  for (const game of ['ETS2', 'synthetic', '', 'C:\\Games\\ETS2', undefined, null, 1, {game: 'ets2'}]) {
    await expect(bridge.choosePluginFolder(game as never)).rejects.toThrow('Invalid plugin setup request');
    await expect(bridge.setPluginGameExcluded(game as never, true)).rejects.toThrow('Invalid plugin setup request');
  }
  for (const excluded of ['true', 1, 0, null, undefined, {}]) {
    await expect(bridge.setPluginGameExcluded('ets2', excluded as never)).rejects.toThrow('Invalid plugin setup request');
  }
  for (const id of ['ets2:steam:4', 'ets2:Steam:0', 'ets2:adopted:0', 'ETS2:steam:0', 'ets2:steam:0 ', 'C:\\Games\\ETS2\\bin\\win_x64\\plugins', '', undefined, 0]) {
    await expect(bridge.openPluginFolder(id as never)).rejects.toThrow('Invalid plugin setup request');
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
  ipc.invoke.mockResolvedValue(undefined);
  await Reflect.apply(bridge.retryPluginSetup, bridge, ['C:\\arbitrary']);
  await Reflect.apply(bridge.choosePluginFolder, bridge, ['ats', 'C:\\Games\\ATS']);
  await Reflect.apply(bridge.setPluginGameExcluded, bridge, ['ets2', false, {path: 'C:\\arbitrary'}]);
  await Reflect.apply(bridge.showPluginFile, bridge, ['C:\\Windows\\explorer.exe']);
  await Reflect.apply(bridge.openPluginFolder, bridge, ['ats:manual:0', 'C:\\Games']);
  await bridge.openPluginFolder('ets2:steam:3');
  expect(ipc.invoke.mock.calls).toEqual([['plugin:retry'], ['plugin:choose-folder', 'ats'], ['plugin:set-excluded', 'ets2', false], ['plugin:show-file'],
    ['plugin:open-folder', 'ats:manual:0'], ['plugin:open-folder', 'ets2:steam:3']]);
  expect(ipc.send).not.toHaveBeenCalled();
});
// ET-018 PR-4 (U8): the in-app uninstall forwards nothing; any argument is refused before IPC, and main checks again.
it('invokes the in-app uninstall on its fixed channel only without arguments', async () => {
  ipc.invoke.mockResolvedValue({outcome: 'cancelled'});
  await expect(bridge.uninstallApplication()).resolves.toEqual({outcome: 'cancelled'});
  await expect(Reflect.apply(bridge.uninstallApplication, bridge, [{force: true}])).rejects.toThrow('Invalid uninstall request');
  await expect(Reflect.apply(bridge.uninstallApplication, bridge, ['C:\\Users'])).rejects.toThrow('Invalid uninstall request');
  await expect(Reflect.apply(bridge.uninstallApplication, bridge, [undefined])).rejects.toThrow('Invalid uninstall request');
  expect(ipc.invoke.mock.calls).toEqual([['app:uninstall']]);
  expect(ipc.send).not.toHaveBeenCalled();
});
// ET-017 PR-6 (P17): the diagnostics export forwards no argument; main owns the Save dialog and the bundle.
it('invokes the diagnostics export on its fixed channel without any argument', async () => {
  ipc.invoke.mockResolvedValue({outcome: 'cancelled'});
  await expect(Reflect.apply(bridge.exportDiagnostics, bridge, ['D:/exports/diagnostics.json', {upload: true}])).resolves.toEqual({outcome: 'cancelled'});
  await bridge.exportDiagnostics();
  expect(ipc.invoke.mock.calls).toEqual([['diagnostics:export'], ['diagnostics:export']]);
  expect(ipc.send).not.toHaveBeenCalled();
});
