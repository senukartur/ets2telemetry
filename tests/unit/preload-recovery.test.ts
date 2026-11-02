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
// ET-055 (UP9): a valid application info and update view, as main sends them.
const APPLICATION = {version: '0.2.0-stg.000042', channel: 'staging', packaged: true};
const UPDATE_IDLE = {state: 'idle', available: null, progress: null, refusal: null, failure: null, lastCheck: {outcome: 'up-to-date', failure: null, atUtcMs: 1_700_000_000_000}};
it('rejects missing, invalid and extra visibility arguments before IPC', async () => {
  for (const value of [null, undefined, 0, 1, 'false', {}, []]) await expect(bridge.setOverlayEnabled(value as never)).rejects.toThrow('Invalid overlay visibility request');
  expect(ipc.invoke).not.toHaveBeenCalled();
  for (const args of [[], [true, {path: 'untrusted'}]]) await expect(Reflect.apply(bridge.setOverlayEnabled, bridge, args)).rejects.toThrow('Invalid overlay visibility request');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await bridge.setOverlayEnabled(false); await bridge.setOverlayEnabled(true);
  expect(ipc.invoke.mock.calls).toEqual([['settings:set-overlay-enabled', false], ['settings:set-overlay-enabled', true]]);
});
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
  // ET-052 MB5: the projection always carries the next mandatory break, in the s32 range with unit min.
  const noBreak = smokePair(); delete (noBreak.v1!.observation!.state as unknown as Record<string, unknown>).nextMandatoryBreak;
  const hugeBreak = smokePair({nextMandatoryBreak: {available: true, value: 2147483648, unit: 'min'}});
  const wrongUnit = smokePair(); (wrongUnit.v1!.observation!.state as unknown as Record<string, unknown>).nextMandatoryBreak = {available: true, value: 5, unit: 'm'};
  [withWindow, foreign, extra, noBreak, hugeBreak, wrongUnit].forEach((update, index) => {
    port.deliver(update, index + 1);
    expect(consume.mock.lastCall?.[0]).not.toHaveProperty('v1');
    expect(consume.mock.lastCall?.[0]).toMatchObject({selection: 'synthetic', status: 'connected', fresh: true});
  });
  expect(port.closed).toBe(false);
  stop();
});
it('passes the raw next mandatory break through and keeps it on an expired projection', async () => {
  const consume = vi.fn(); const stop = bridge.subscribeLive(consume); const port = attach();
  port.deliver(smokePair({nextMandatoryBreak: {available: true, value: -30, unit: 'min'}}));
  expect(consume.mock.lastCall?.[0].v1.observation.state.nextMandatoryBreak).toEqual({available: true, value: -30, unit: 'min'});
  await vi.advanceTimersByTimeAsync(500);
  expect(consume.mock.lastCall?.[0].v1).toMatchObject({fresh: false, status: 'stale', observation: {state: {nextMandatoryBreak: {available: true, value: -30, unit: 'min'}}}});
  port.deliver(smokePair({nextMandatoryBreak: {available: true, value: 0, unit: 'min'}, receivedMonotonicMs: 900}), 2);
  expect(consume.mock.lastCall?.[0].v1.observation.state.nextMandatoryBreak).toEqual({available: true, value: 0, unit: 'min'});
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
  expect(Object.isFrozen(bridge)).toBe(true); expect(Object.keys(bridge).sort()).toEqual(['beginOverlayEdit', 'checkForUpdates', 'choosePluginFolder', 'exitApplication', 'exportDiagnostics', 'exportJournalTrip', 'finishOverlayEdit', 'getAppState', 'getHardModeStatus', 'getJournalTrip', 'getStatus',
    'listJournalEvents', 'listJournalIntervals', 'listJournalSamples', 'listJournalTrips', 'openPluginFolder', 'refreshHardMode',
    'resetOverlayEditPlacement', 'retryPluginSetup', 'selectSource', 'setAutostart', 'setGearDisplay', 'setLanguage', 'setOverlayBackgroundOpacity', 'setOverlayEditScale', 'setOverlayEnabled', 'setOverlayLayout', 'setOverlaySections', 'setPluginGameExcluded', 'setUnitProfile',
    'showPluginFile', 'subscribeAppState', 'subscribeLive', 'uninstallApplication', 'updateApplication', 'setNowPlayingEnabled', 'setNowPlayingStyle', 'setNowPlayingBackgroundOpacity', 'selectNowPlayingSource', 'beginNowPlayingEdit', 'resetNowPlayingEditPlacement', 'finishNowPlayingEdit'].sort());
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
  // PR-4 the in-app uninstall. ET-050 adds the gear display setter right after the unit profile setter. ET-055 appends the
  // update click and the manual update check.
  expect(Object.keys(bridge)).toEqual(['getStatus', 'selectSource', 'subscribeLive', 'getAppState', 'subscribeAppState', 'exitApplication', 'setLanguage', 'setAutostart', 'setUnitProfile',
    'setGearDisplay', 'setOverlayBackgroundOpacity', 'setOverlayEnabled', 'setOverlayLayout', 'setOverlaySections', 'beginOverlayEdit', 'setOverlayEditScale', 'resetOverlayEditPlacement', 'finishOverlayEdit',
    'listJournalTrips', 'getJournalTrip', 'listJournalEvents', 'listJournalIntervals', 'listJournalSamples', 'exportJournalTrip',
    'retryPluginSetup', 'choosePluginFolder', 'setPluginGameExcluded', 'showPluginFile', 'openPluginFolder', 'exportDiagnostics', 'uninstallApplication', 'getHardModeStatus', 'refreshHardMode',
    'updateApplication', 'checkForUpdates', 'setNowPlayingEnabled', 'setNowPlayingStyle', 'setNowPlayingBackgroundOpacity', 'selectNowPlayingSource', 'beginNowPlayingEdit', 'resetNowPlayingEditPlacement', 'finishNowPlayingEdit']);
});
it('allows one application state listener, forwards pushed state and unsubscribes once', () => {
  const listener = vi.fn(); const stop = bridge.subscribeAppState(listener);
  expect(ipc.send).toHaveBeenCalledExactlyOnceWith('app:subscribe-state');
  expect(() => bridge.subscribeAppState(vi.fn())).toThrow('One application state subscription');
  expect(() => bridge.subscribeAppState('not a function' as never)).toThrow();
  // ET-015c: the wider recording status passes through unchanged; the preload forwards main's state as it is once the
  // ET-055 application info and update view validate.
  const state = {health: {service: 'ready', storage: 'verified', recording: {state: 'recording', target: 'synthetic', code: null,
    losses: {lostEvents: 2, eventLoss: 0, notConnected: 1, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}, trip: {phase: 'active', completeness: 'partial', untrackedJob: false}}, lastError: null},
    application: APPLICATION, update: UPDATE_IDLE};
  ipc.emit('app:state', {}, state); expect(listener).toHaveBeenCalledExactlyOnceWith(state);
  stop(); stop(); expect(ipc.send.mock.calls.filter(call => call[0] === 'app:unsubscribe-state')).toHaveLength(1);
  ipc.emit('app:state', {}, state); expect(listener).toHaveBeenCalledOnce();
  const next = vi.fn(); bridge.subscribeAppState(next); ipc.emit('app:state', {}, state); expect(next).toHaveBeenCalledOnce();
});
it('requests state and exit through fixed invoke channels without forwarding renderer arguments', async () => {
  // ET-055: the preload validates the state's application info and update view, so the reply must carry valid ones.
  ipc.invoke.mockResolvedValueOnce({application: APPLICATION, update: UPDATE_IDLE});
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
it('validates autostart requests before IPC and forwards exactly a boolean', async () => {
  await expect(bridge.setAutostart('true' as never)).rejects.toThrow('Invalid autostart');
  await expect(bridge.setAutostart(1 as never)).rejects.toThrow('Invalid autostart');
  await expect(bridge.setAutostart(null as never)).rejects.toThrow('Invalid autostart');
  expect(ipc.invoke).not.toHaveBeenCalled();
  await bridge.setAutostart(true);
  expect(ipc.invoke).toHaveBeenCalledWith('settings:set-autostart', true);
  await bridge.setAutostart(false);
  expect(ipc.invoke).toHaveBeenCalledWith('settings:set-autostart', false);
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
// ET-050: the gear display setter forwards exactly a game and a mode, both validated before IPC.
it('validates gear display requests before IPC and forwards exactly a game and a mode', async () => {
  for (const [game, mode] of [['ets2', 'Manual'], ['ets2', 'semi'], ['ETS2', 'manual'], ['synthetic', 'manual'], ['ats', 'C:\\settings.json'], [undefined, undefined],
    [{}, 'manual'], ['ats', 1], ['ats', true]]) {
    await expect(bridge.setGearDisplay(game as never, mode as never)).rejects.toThrow('Invalid gear display request');
  }
  for (const args of [[], ['ets2'], ['ets2', 'manual', {path: 'C:\\arbitrary'}]]) {
    await expect(Reflect.apply(bridge.setGearDisplay, bridge, args)).rejects.toThrow('Invalid gear display request');
  }
  expect(ipc.invoke).not.toHaveBeenCalled();
  const view = {gearDisplay: {ets2: 'manual', ats: 'automatic'}, state: 'loaded', writable: true, saveError: null};
  ipc.invoke.mockResolvedValueOnce(view);
  await expect(bridge.setGearDisplay('ets2', 'manual')).resolves.toEqual(view);
  await bridge.setGearDisplay('ats', 'automatic');
  expect(ipc.invoke.mock.calls).toEqual([['settings:set-gear-display', 'ets2', 'manual'], ['settings:set-gear-display', 'ats', 'automatic']]);
});
// ET-012a: two appended overlay settings methods; each validates before IPC and forwards only the validated value.
const ALL_ON = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true, 'mandatory-break': true};
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
  for (const scale of [Number.NaN, Number.POSITIVE_INFINITY, 0.49, 3.01, '1.5', null, undefined, [1], {scale: 1}]) {
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
  // ET-045e: the 300% maximum is forwarded unchanged.
  await bridge.setOverlayEditScale(3);
  expect(ipc.invoke.mock.calls).toEqual([['overlay-edit:begin'], ['overlay-edit:set-scale', 1.23], ['overlay-edit:reset'], ['overlay-edit:finish', 'save'],
    ['overlay-edit:finish', 'cancel'], ['overlay-edit:set-scale', 3]]);
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

// ET-026: no caller-supplied path or evaluator value crosses the new read-only boundary.
it('validates Hard Mode replies and rejects every supplied argument before IPC', async () => {
  const {unknownHardMode} = await import('../../packages/telemetry-core/src/hard-mode');
  const status = {assessment: unknownHardMode(Date.now()), trip: null}; ipc.invoke.mockResolvedValue(status);
  await expect(bridge.getHardModeStatus()).resolves.toEqual(status); await expect(bridge.refreshHardMode()).resolves.toEqual(status);
  expect(ipc.invoke.mock.calls).toEqual([['hard-mode:status'], ['hard-mode:refresh']]);
  for (const method of [bridge.getHardModeStatus, bridge.refreshHardMode]) for (const argument of ['C:/private/config.cfg', {state: 'pass'}, undefined])
    await expect(Reflect.apply(method, bridge, [argument])).rejects.toThrow('Invalid Hard Mode request');
  ipc.invoke.mockResolvedValue({...status, filename: 'private'}); await expect(bridge.getHardModeStatus()).rejects.toThrow('Invalid Hard Mode status');
});

it('validates opacity as exactly one whole percentage before IPC', async () => {
  for (const value of [undefined, null, '80', true, NaN, Infinity, 39, 101, 80.5, {}, []])
    await expect(bridge.setOverlayBackgroundOpacity(value as never)).rejects.toThrow('Invalid overlay opacity request');
  for (const args of [[], [80, {}]]) await expect(Reflect.apply(bridge.setOverlayBackgroundOpacity, bridge, args)).rejects.toThrow('Invalid overlay opacity request');
  for (const value of [40, 65, 80, 100]) await bridge.setOverlayBackgroundOpacity(value);
  expect(ipc.invoke.mock.calls.filter(call => call[0] === 'settings:set-overlay-background-opacity'))
    .toEqual([40, 65, 80, 100].map(value => ['settings:set-overlay-background-opacity', value]));
});

// ET-055 (UP9): the two update methods forward no argument and validate main's reply; the application state's
// application info and update view are validated again, and an invalid state never reaches the renderer.
it('invokes the update click and the manual check on their fixed channels only without arguments', async () => {
  const downloading = {state: 'downloading', available: '0.2.0-stg.000043', progress: 42, refusal: null, failure: null, lastCheck: UPDATE_IDLE.lastCheck};
  ipc.invoke.mockResolvedValueOnce(downloading).mockResolvedValueOnce(UPDATE_IDLE);
  await expect(bridge.updateApplication()).resolves.toEqual(downloading);
  await expect(bridge.checkForUpdates()).resolves.toEqual(UPDATE_IDLE);
  for (const method of [bridge.updateApplication, bridge.checkForUpdates]) for (const args of [['https://github.com/x'], [{force: true}], [undefined]])
    await expect(Reflect.apply(method, bridge, args)).rejects.toThrow('Invalid update request');
  expect(ipc.invoke.mock.calls).toEqual([['update:apply'], ['update:check']]);
  expect(ipc.send).not.toHaveBeenCalled();
});
it.each([
  ['an unknown state', {...UPDATE_IDLE, state: 'installed'}],
  ['a URL field', {...UPDATE_IDLE, url: 'https://github.com/senukartur/ets2telemetry/releases'}],
  ['a fractional progress', {state: 'downloading', available: '0.2.0', progress: 42.5, refusal: null, failure: null, lastCheck: null}],
  ['progress outside downloading', {...UPDATE_IDLE, progress: 10}],
  ['an offered state without a version', {state: 'available', available: null, progress: null, refusal: null, failure: null, lastCheck: null}],
  ['a version that is a path', {state: 'available', available: 'C:\\Users\\owner\\update.nupkg', progress: null, refusal: null, failure: null, lastCheck: null}],
  ['a refusal outside refused and ready', {...UPDATE_IDLE, refusal: 'GAME_RUNNING'}],
  ['a refused state without a code', {state: 'refused', available: '0.2.0', progress: null, refusal: null, failure: null, lastCheck: null}],
  ['an unknown failure', {state: 'failed', available: '0.2.0', progress: null, refusal: null, failure: 'EACCES', lastCheck: null}],
  ['a failed check without a code', {...UPDATE_IDLE, lastCheck: {outcome: 'failed', failure: null, atUtcMs: 1}}],
  ['a last check while unsupported', {...UPDATE_IDLE, state: 'unsupported'}]
])('rejects an update reply with %s', async (_name, reply) => {
  ipc.invoke.mockResolvedValueOnce(reply);
  await expect(bridge.updateApplication()).rejects.toThrow('Invalid update state');
});
// Review round 1: an invalid application info or update view is replaced by a fixed fallback, so the rest of the state
// (health, settings, plugins) still reaches the renderer; only a state that is not an object is dropped or rejected.
it('replaces an invalid application info or update view with fixed fallbacks and keeps the rest of the state', async () => {
  const listener = vi.fn(); bridge.subscribeAppState(listener);
  const health = {service: 'ready'};
  const UNSUPPORTED = {state: 'unsupported', available: null, progress: null, refusal: null, failure: null, lastCheck: null};
  const cases: [unknown, unknown, unknown][] = [
    [{...UPDATE_IDLE, state: 'installed'}, APPLICATION, {application: APPLICATION, update: UNSUPPORTED}],
    [{...UPDATE_IDLE, url: 'https://github.com/x'}, APPLICATION, {application: APPLICATION, update: UNSUPPORTED}],
    [UPDATE_IDLE, {...APPLICATION, channel: 'beta'}, {application: {version: '0.0.0', channel: 'production', packaged: true}, update: UPDATE_IDLE}],
    [UPDATE_IDLE, {...APPLICATION, version: '..\\..\\Update.exe'}, {application: {version: '0.0.0', channel: 'staging', packaged: true}, update: UPDATE_IDLE}],
    [UPDATE_IDLE, {...APPLICATION, path: 'C:\\x'}, {application: {version: '0.0.0', channel: 'staging', packaged: true}, update: UPDATE_IDLE}],
    [undefined, undefined, {application: {version: '0.0.0', channel: 'production', packaged: false}, update: UNSUPPORTED}]
  ];
  for (const [update, application, expected] of cases) {
    const state = {health, application, update};
    ipc.emit('app:state', {}, state);
    expect(listener).toHaveBeenLastCalledWith({health, ...expected as object});
    ipc.invoke.mockResolvedValueOnce(state);
    await expect(bridge.getAppState()).resolves.toEqual({health, ...expected as object});
  }
  listener.mockClear();
  for (const state of [null, 'state', []]) {
    ipc.emit('app:state', {}, state);
    ipc.invoke.mockResolvedValueOnce(state);
    await expect(bridge.getAppState()).rejects.toThrow('Invalid application state');
  }
  expect(listener).not.toHaveBeenCalled();
});
