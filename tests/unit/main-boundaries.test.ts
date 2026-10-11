import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';

const processEvents = ['uncaughtException', 'unhandledRejection'] as const;
const processEmitter: EventEmitter = process;
let originals: Map<string, ReturnType<EventEmitter['listeners']>>;
let app: EventEmitter & {exit: ReturnType<typeof vi.fn>};
let ipc: EventEmitter;
let handlers: Map<string, (event: unknown, source?: unknown) => unknown>;
let child: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>};
let children: typeof child[];
let contents: EventEmitter & {mainFrame: object; send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>};
let resolveBroker: ReturnType<typeof vi.fn>;
let loadFile: ReturnType<typeof vi.fn>;
let overlayContents: typeof contents;
let windows: (EventEmitter & {webContents: typeof contents; hide: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn>})[];
let channels: {port1: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn<() => void>>; start: ReturnType<typeof vi.fn<() => void>>}; port2: {close: ReturnType<typeof vi.fn<() => void>>}}[];
let configurations: Electron.BrowserWindowConstructorOptions[];
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  originals = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  app = Object.assign(new EventEmitter(), {exit: vi.fn(), quit: vi.fn(), getPath: () => 'C:\\isolated', setPath: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false});
  child = Object.assign(new EventEmitter(), {postMessage: vi.fn(), kill: vi.fn(() => true)});
  children = [child]; let forks = 0;
  contents = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn()});
  overlayContents = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn()});
  windows = []; channels = []; configurations = [];
  loadFile = vi.fn(() => Promise.resolve());
  handlers = new Map(); ipc = new EventEmitter();
  Object.assign(ipc, {handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(name, handler)});
  resolveBroker = vi.fn(() => undefined);
  vi.doMock('electron', () => ({app, ipcMain: ipc, utilityProcess: {fork: () => {
    if (forks++ === 0) return child;
    const next = Object.assign(new EventEmitter(), {postMessage: vi.fn(), kill: vi.fn(() => true)}); children.push(next); return next;
  }},
    screen: Object.assign(new EventEmitter(), {screenToDipRect: (_window: null, bounds: Electron.Rectangle) => bounds, getAllDisplays: () => [{bounds: {x: -1920, y: 0, width: 3840, height: 1080}}]}),
    BrowserWindow: class extends EventEmitter {
      webContents = windows.length === 0 ? contents : overlayContents;
      hide = vi.fn(); showInactive = vi.fn(); setBounds = vi.fn(); setIgnoreMouseEvents = vi.fn(); setFocusable = vi.fn(); destroy = vi.fn(() => this.emit('closed'));
      constructor(configuration: Electron.BrowserWindowConstructorOptions) {super(); configurations.push(configuration); windows.push(this);}
      isDestroyed() {return false;} loadFile = loadFile;
    },
    MessageChannelMain: class {
      port1 = Object.assign(new EventEmitter(), {postMessage: vi.fn(), start: vi.fn(), close: vi.fn()}); port2 = {close: vi.fn()};
      constructor() {let closed = false; this.port1.close.mockImplementation(() => {if (!closed) {closed = true; this.port1.emit('close');}}); channels.push(this);}
    }}));
  vi.doMock('electron-squirrel-startup', () => ({default: false}));
  vi.doMock('../../apps/desktop/src/entrypoints', () => ({processEntrypoint: () => 'package.json'}));
  vi.doMock('../../apps/desktop/src/diagnostics', () => ({createDiagnostics: () => vi.fn()}));
  vi.doMock('../../apps/desktop/src/broker-artifact', () => ({brokerConfiguration: resolveBroker, createBrokerResolver: () => resolveBroker}));
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'synthetic');
});
afterEach(() => {
  for (const name of processEvents) for (const listener of processEmitter.listeners(name)) if (!originals.get(name)!.includes(listener)) processEmitter.removeListener(name, listener as (...args: unknown[]) => void);
  vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllEnvs();
  for (const name of ['electron', 'electron-squirrel-startup', '../../apps/desktop/src/entrypoints', '../../apps/desktop/src/diagnostics', '../../apps/desktop/src/broker-artifact']) vi.doUnmock(name);
});
async function settle() {await Promise.resolve(); await Promise.resolve();}
async function ready() {await import('../../apps/desktop/src/main'); await Promise.resolve(); child.emit('message', {type: 'ready'}); await settle();}
const trusted = () => ({sender: contents, senderFrame: contents.mainFrame});

it('does not inspect an unused broker for explicit synthetic startup', async () => {
  resolveBroker.mockImplementation(() => {throw new Error('provenance');});
  await ready(); expect(resolveBroker).not.toHaveBeenCalled();
  expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'synthetic', broker: undefined});
  expect(loadFile).toHaveBeenCalledTimes(2); expect(app.exit).not.toHaveBeenCalled();
});
it('keeps unavailable game broker selection contained in the service instead of crashing main', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2');
  resolveBroker.mockImplementation(() => {throw new Error('provenance');});
  await ready(); expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ets2', broker: undefined});
  expect(loadFile).toHaveBeenCalledTimes(2); expect(app.exit).not.toHaveBeenCalled();
});
it('commits selected state only after successful IPC and retains sender/main-frame checks', async () => {
  await ready(); const select = handlers.get('telemetry:select')!;
  await expect(select({sender: {}, senderFrame: contents.mainFrame}, 'ats')).rejects.toThrow('Untrusted');
  await expect(select({sender: contents, senderFrame: {}}, 'ats')).rejects.toThrow('Untrusted');
  child.postMessage.mockImplementationOnce(() => {throw new Error('closed IPC');});
  await expect(select(trusted(), 'replay')).rejects.toThrow('closed IPC');
  child.emit('exit', 1);
  expect(contents.send.mock.calls[0][1].selection).toBe('synthetic');
});

function pendingVerification() {
  let complete!: (value: undefined) => void;
  resolveBroker.mockReturnValue(new Promise<undefined>(resolve => {complete = resolve;}));
  return () => complete(undefined);
}
it.each(['owned', 'retired'])('awaits game startup verification before window creation and ignores a %s service generation', async outcome => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); const complete = pendingVerification();
  await ready(); expect(loadFile).not.toHaveBeenCalled(); expect(child.postMessage).not.toHaveBeenCalled();
  await expect(handlers.get('telemetry:select')!(trusted(), 'synthetic')).rejects.toThrow('Untrusted');
  if (outcome === 'retired') child.emit('exit', 1);
  complete(); await settle();
  if (outcome === 'retired') {expect(loadFile).not.toHaveBeenCalled(); expect(child.postMessage).not.toHaveBeenCalled();}
  else {expect(loadFile).toHaveBeenCalledTimes(2); expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ets2', broker: undefined});}
});
it('does not dispatch or commit an older game request after a newer source selection', async () => {
  await ready(); const complete = pendingVerification(), select = handlers.get('telemetry:select')!;
  const older = select(trusted(), 'ets2'); await vi.advanceTimersByTimeAsync(250);
  await select(trusted(), 'replay'); complete(); await expect(older).rejects.toThrow('retired');
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ets2'}));
  child.emit('exit', 1); expect(contents.send.mock.calls[0][1].selection).toBe('replay');
});
it.each(['service-exit', 'frame-replaced', 'reload', 'renderer-crash', 'stop'])('rechecks async dispatch ownership after %s', async reason => {
  await ready(); const complete = pendingVerification(), event = trusted();
  const pending = handlers.get('telemetry:select')!(event, 'ats');
  if (reason === 'service-exit') child.emit('exit', 1);
  else if (reason === 'frame-replaced') contents.mainFrame = {};
  else if (reason === 'reload') contents.emit('did-start-loading');
  else if (reason === 'renderer-crash') contents.emit('render-process-gone', {}, {reason: 'crashed'});
  else app.emit('before-quit', {preventDefault: vi.fn()});
  complete(); await expect(pending).rejects.toThrow('retired');
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
});
it('recovers separated renderer crashes while stopping clustered crash loops', async () => {
  await ready();
  for (let index = 0; index < 4; index++) {
    contents.emit('render-process-gone', {}, {reason: 'crashed'});
    expect(loadFile).toHaveBeenCalledTimes(index + 3); await vi.advanceTimersByTimeAsync(60000);
  }
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  for (let index = 0; index < 3; index++) contents.emit('render-process-gone', {}, {reason: 'crashed'});
  expect(loadFile).toHaveBeenCalledTimes(8);
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
});
function currentGame(): LiveTelemetry {
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot') throw new Error('Expected snapshot');
  return {...initialLive('ets2'), status: 'connected', fresh: true, observation: {source: {...message.source, origin: 'game'}, state: message.data.state,
    capture: message.capture, seq: message.seq, receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}}};
}
const overlayTrusted = () => ({sender: overlayContents, senderFrame: overlayContents.mainFrame});
function deliver(update: LiveTelemetry, delivery = 1, channel = channels[0]) {channel.port1.emit('message', {data: {type: 'live', delivery, update}});}
it('constructs hidden click-through nonfocus sandboxed overlay and retains dashboard-only authority', async () => {
  await ready(); expect(configurations[1]).toMatchObject({show: false, focusable: false, transparent: true, frame: false, skipTaskbar: true, alwaysOnTop: true,
    webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
  expect(configurations[1].webPreferences!.preload).toContain('overlay-preload.cjs');
  await expect(handlers.get('telemetry:select')!(overlayTrusted(), 'ats')).rejects.toThrow('Untrusted');
  ipc.emit('overlay:subscribe', trusted()); ipc.emit('overlay:subscribe', {sender: overlayContents, senderFrame: {}});
  expect(overlayContents.postMessage).not.toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted()); expect(overlayContents.postMessage).toHaveBeenCalledOnce();
  expect(windows[1].showInactive).not.toHaveBeenCalled();
});
it('keeps upstream and overlay independent of dashboard unsubscribe/reload and rejects stale renderer credits', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('telemetry:subscribe', trusted()); const dashboard = channels[1];
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[2];
  const initialCredit = overlayChannel.port1.postMessage.mock.lastCall![0].delivery;
  overlayChannel.port1.emit('message', {data: {type: 'consumed', delivery: initialCredit}});
  deliver(currentGame()); expect(windows[1].showInactive).toHaveBeenCalledOnce();
  ipc.emit('telemetry:unsubscribe', trusted()); contents.emit('did-start-loading');
  expect(dashboard.port1.close).toHaveBeenCalled(); expect(channels[0].port1.close).not.toHaveBeenCalled(); expect(overlayChannel.port1.close).not.toHaveBeenCalled();
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'unsubscribe'});
  await vi.advanceTimersByTimeAsync(50); const overlayDelivery = overlayChannel.port1.postMessage.mock.lastCall![0];
  expect(overlayDelivery.update).not.toHaveProperty('observation'); expect(overlayDelivery.update).not.toHaveProperty('window');
  expect(overlayDelivery.update).toMatchObject({source: 'ETS2', origin: 'game'});
  dashboard.port1.emit('message', {data: {type: 'consumed', delivery: overlayDelivery.delivery}});
  expect(overlayChannel.port1.close).not.toHaveBeenCalled();
  expect(channels[0].port1.postMessage).toHaveBeenCalledWith({type: 'consumed', delivery: 1});
});
it('hides while async selection is pending and ignores previous-source or retired-port updates', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); ipc.emit('overlay:subscribe', overlayTrusted()); deliver(currentGame());
  const complete = pendingVerification(); const pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  expect(windows[1].hide).toHaveBeenCalled(); windows[1].showInactive.mockClear(); deliver(currentGame(), 2);
  expect(windows[1].showInactive).not.toHaveBeenCalled(); complete(); await pending; deliver(currentGame(), 3);
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  const original = channels[0]; original.port1.close(); await vi.advanceTimersByTimeAsync(250); deliver(currentGame(), 4, original);
  expect(windows[1].showInactive).not.toHaveBeenCalled(); expect(channels).toHaveLength(3);
});
it('hides on upstream loss, window expiry, overlay reload and credit timeout; dashboard close stops owned processes', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); ipc.emit('overlay:subscribe', overlayTrusted()); deliver(currentGame());
  windows[1].hide.mockClear(); await vi.advanceTimersByTimeAsync(250); expect(windows[1].hide).toHaveBeenCalled();
  channels[0].port1.close(); expect(windows[1].hide).toHaveBeenCalled();
  overlayContents.emit('did-start-loading'); expect(channels[1].port1.close).toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted()); await vi.advanceTimersByTimeAsync(500);
  expect(channels[2].port1.close).toHaveBeenCalled();
  windows[0].emit('closed'); expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
  expect(channels.every(channel => channel.port1.close.mock.calls.length > 0)).toBe(true);
  const count = channels.length; ipc.emit('telemetry:subscribe', trusted()); ipc.emit('overlay:subscribe', overlayTrusted());
  expect(channels).toHaveLength(count);
});
it('retires exact service generations and releases pending source selection on service replacement', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); ipc.emit('overlay:subscribe', overlayTrusted()); deliver(currentGame());
  const complete = pendingVerification(); const pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  child.emit('exit', 1); resolveBroker.mockReturnValue(undefined); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1]; replacement.emit('message', {type: 'ready'}); await settle();
  complete(); await expect(pending).rejects.toThrow('retired');
  const old = channels[0]; const next = channels.at(-1)!; const current = currentGame();
  current.observation!.capture.monotonicNs = '9999999999'; current.observation!.windowReceivedMonotonicMs = 1000;
  windows[1].showInactive.mockClear(); deliver(current, 2, old); child.emit('message', {type: 'failed'});
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  deliver(current, 1, next); expect(windows[1].showInactive).toHaveBeenCalledOnce();
  expect(replacement.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ets2', broker: undefined});
  expect(replacement.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
});
