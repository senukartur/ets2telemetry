import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';

const processEvents = ['uncaughtException', 'unhandledRejection'] as const;
const processEmitter: EventEmitter = process;
let originals: Map<string, ReturnType<EventEmitter['listeners']>>;
let app: EventEmitter & {exit: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; setPath: ReturnType<typeof vi.fn>; requestSingleInstanceLock: ReturnType<typeof vi.fn>};
let ipc: EventEmitter;
let handlers: Map<string, (event: unknown, source?: unknown) => unknown>;
let child: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>};
let children: typeof child[];
let contents: EventEmitter & {mainFrame: object; send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>};
let resolveBroker: ReturnType<typeof vi.fn>;
let loadFile: ReturnType<typeof vi.fn>;
let overlayContents: typeof contents;
let windows: (EventEmitter & {webContents: typeof contents; hide: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn>;
  topmost: boolean; setAlwaysOnTop: ReturnType<typeof vi.fn>; moveTop: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; setFocusable: ReturnType<typeof vi.fn>;
  minimized: boolean; minimize: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>})[];
let channels: {port1: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn<() => void>>; start: ReturnType<typeof vi.fn<() => void>>}; port2: {close: ReturnType<typeof vi.fn<() => void>>}}[];
let configurations: Electron.BrowserWindowConstructorOptions[];
let log: ReturnType<typeof vi.fn>;
// ET-011a fixture additions. The tray is unavailable unless a test enables it, so earlier tests keep their
// timer and log expectations; windows after the first dashboard and overlay get their own web contents.
let lockGranted: boolean;
let trayAvailable: boolean;
let trays: (EventEmitter & {setToolTip: ReturnType<typeof vi.fn>; setContextMenu: ReturnType<typeof vi.fn>; setImage: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; destroyed: boolean})[];
let extraContents: typeof contents[];
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  const started = Date.now(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - started);
  originals = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  lockGranted = true; trayAvailable = false; trays = []; extraContents = [];
  app = Object.assign(new EventEmitter(), {exit: vi.fn(), quit: vi.fn(), getPath: () => 'C:\\isolated', setPath: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => lockGranted)});
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
      webContents = windows.length === 0 ? contents : windows.length === 1 ? overlayContents : (() => {
        const next = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn()}); extraContents.push(next); return next;
      })();
      minimized = false; isMinimized = () => this.minimized; minimize = vi.fn(() => {this.minimized = true;}); restore = vi.fn(() => {this.minimized = false;}); show = vi.fn(); focus = vi.fn();
      hide = vi.fn(); showInactive = vi.fn(); setBounds = vi.fn(); setIgnoreMouseEvents = vi.fn(); setFocusable = vi.fn(); destroy = vi.fn(() => this.emit('closed'));
      // Models Windows: isAlwaysOnTop() reports the HWND style, which external z-order changes can clear.
      topmost = false; isAlwaysOnTop = () => this.topmost; setAlwaysOnTop = vi.fn((flag: boolean) => {this.topmost = flag;}); moveTop = vi.fn();
      constructor(configuration: Electron.BrowserWindowConstructorOptions) {super(); configurations.push(configuration); windows.push(this);}
      isDestroyed() {return false;} loadFile = loadFile;
    },
    MessageChannelMain: class {
      port1 = Object.assign(new EventEmitter(), {postMessage: vi.fn(), start: vi.fn(), close: vi.fn()}); port2 = {close: vi.fn()};
      constructor() {let closed = false; this.port1.close.mockImplementation(() => {if (!closed) {closed = true; this.port1.emit('close');}}); channels.push(this);}
    },
    Tray: class extends EventEmitter {
      setToolTip = vi.fn(); setContextMenu = vi.fn(); setImage = vi.fn(); destroyed = false; destroy = vi.fn(() => {this.destroyed = true;});
      constructor() {super(); if (!trayAvailable) throw new Error('Notification area unavailable in this fixture'); trays.push(this);}
      isDestroyed() {return this.destroyed;}
    },
    Menu: {buildFromTemplate: (template: unknown[]) => ({template})},
    nativeImage: {createFromBuffer: () => ({addRepresentation: vi.fn()})}}));
  vi.doMock('electron-squirrel-startup', () => ({default: false}));
  vi.doMock('../../apps/desktop/src/entrypoints', () => ({processEntrypoint: () => 'package.json'}));
  log = vi.fn(); vi.doMock('../../apps/desktop/src/diagnostics', () => ({createDiagnostics: () => log}));
  vi.doMock('../../apps/desktop/src/broker-artifact', () => ({brokerConfiguration: resolveBroker, createBrokerResolver: () => resolveBroker}));
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'synthetic');
});
afterEach(() => {
  for (const name of processEvents) for (const listener of processEmitter.listeners(name)) if (!originals.get(name)!.includes(listener)) processEmitter.removeListener(name, listener as (...args: unknown[]) => void);
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
  for (const name of ['electron', 'electron-squirrel-startup', '../../apps/desktop/src/entrypoints', '../../apps/desktop/src/diagnostics', '../../apps/desktop/src/broker-artifact']) vi.doUnmock(name);
});
async function settle() {await Promise.resolve(); await Promise.resolve();}
async function ready() {await import('../../apps/desktop/src/main'); await Promise.resolve(); child.emit('message', {type: 'ready'}); await settle();}
const trusted = () => ({sender: contents, senderFrame: contents.mainFrame});
function upstreamRequests(target = child) {return target.postMessage.mock.calls.filter(call => call[0].type === 'subscribe').length;}
async function exhaustUpstream() {
  const retired: typeof channels = [];
  for (let loss = 0; loss < 3; loss++) {
    const next = channels.at(-1)!; retired.push(next); next.port1.close();
    if (loss < 2) await vi.advanceTimersByTimeAsync(250);
  }
  expect(upstreamRequests()).toBe(3);
  return retired;
}

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
function hydrateConsumers() {
  ipc.emit('telemetry:unsubscribe', trusted()); ipc.emit('overlay:unsubscribe', overlayTrusted());
  ipc.emit('telemetry:subscribe', trusted()); const dashboard = channels.at(-1)!;
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels.at(-1)!;
  return {dashboard: dashboard.port1.postMessage.mock.lastCall![0].update, overlay: overlayChannel.port1.postMessage.mock.lastCall![0].update};
}
it.each(['reload', 'frame-replacement', 'renderer-crash'])('hydrates the committed source after a quiet selection request is retired by dashboard %s', async reason => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  if (reason === 'reload') contents.emit('did-start-loading');
  else if (reason === 'renderer-crash') contents.emit('render-process-gone', {}, {reason: 'crashed'});
  contents.mainFrame = {};
  complete(); await expect(pending).rejects.toThrow('retired');
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ets2', fresh: false}, overlay: {source: 'ETS2', speed: '—', fuel: '—'}});
  expect(windows[1].showInactive).not.toHaveBeenCalled();
});
it('retains committed blank caches if source dispatch throws on a quiet service', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  child.postMessage.mockImplementationOnce(() => {throw new Error('closed IPC');});
  await expect(handlers.get('telemetry:select')!(trusted(), 'ats')).rejects.toThrow('closed IPC');
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ets2', fresh: false}, overlay: {source: 'ETS2', speed: '—', fuel: '—'}});
  expect(windows[1].showInactive).not.toHaveBeenCalled();
});
it('publishes new source labels only after a successful quiet source dispatch', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ets2', fresh: false}, overlay: {source: 'ETS2', speed: '—', fuel: '—'}});
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
  complete(); await pending;
  expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ats', broker: undefined});
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ats', status: 'waiting', fresh: false}, overlay: {source: 'ATS', status: 'waiting', speed: '—', fuel: '—'}});
  expect(windows[1].showInactive).not.toHaveBeenCalled();
});
it('does not let superseded source verification overwrite a newer committed quiet selection', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  const complete = pendingVerification(), select = handlers.get('telemetry:select')!, older = select(trusted(), 'ats');
  await vi.advanceTimersByTimeAsync(250); await select(trusted(), 'replay');
  const committed = hydrateConsumers(); expect(committed.dashboard).toMatchObject({selection: 'replay', fresh: false});
  complete(); await expect(older).rejects.toThrow('retired');
  expect(hydrateConsumers()).toEqual(committed);
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
});
it('preserves service-failure state when pending source verification finishes after service exit', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  child.emit('exit', 1); const terminal = hydrateConsumers();
  expect(terminal).toMatchObject({dashboard: {selection: 'ets2', status: 'restarting', fresh: false}, overlay: {source: 'ETS2', status: 'restarting'}});
  complete(); await expect(pending).rejects.toThrow('retired');
  expect(hydrateConsumers()).toEqual(terminal);
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
});
it('does not replace a newer service generation publication when old source verification finishes', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  child.emit('exit', 1); resolveBroker.mockReturnValue(undefined); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1]; replacement.emit('message', {type: 'ready'}); await settle();
  const update: LiveTelemetry = {...initialLive('ets2'), status: 'service-failed', reason: 'Replacement service source failed'};
  deliver(update, 1, channels.at(-1));
  complete(); await expect(pending).rejects.toThrow('retired'); const hydrated = hydrateConsumers();
  expect(hydrated.dashboard).toEqual(update);
  expect(hydrated.overlay).toMatchObject({source: 'ETS2', status: 'service-failed', speed: '—', fuel: '—'});
  expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
});
it('keeps application stop final when source verification completes afterwards', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); hydrateConsumers();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  app.emit('before-quit', {preventDefault: vi.fn()}); child.emit('exit', 0);
  const count = channels.length, messages = contents.postMessage.mock.calls.length + overlayContents.postMessage.mock.calls.length;
  complete(); await expect(pending).rejects.toThrow('retired');
  ipc.emit('telemetry:subscribe', trusted()); ipc.emit('overlay:subscribe', overlayTrusted());
  expect(channels).toHaveLength(count); expect(contents.postMessage.mock.calls.length + overlayContents.postMessage.mock.calls.length).toBe(messages);
  expect(log.mock.calls.filter(call => call[0] === 'APP_STOP_REQUESTED')).toHaveLength(1);
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
  expect(vi.getTimerCount()).toBe(0);
});
it('does not renew SDK or window authority when a failed source change leaves committed labels', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); hydrateConsumers(); deliver(currentGame());
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ats');
  expect(windows[1].hide).toHaveBeenCalled(); contents.mainFrame = {};
  await vi.advanceTimersByTimeAsync(501); complete(); await expect(pending).rejects.toThrow('retired');
  windows[1].showInactive.mockClear(); deliver(currentGame(), 2); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ets2', fresh: false, observation: {windowFresh: false}}, overlay: {source: 'ETS2', freshness: 'stale', speed: '—', fuel: '—'}});
  const current = currentGame(); current.observation!.capture.monotonicNs = '9999999999'; current.observation!.windowReceivedMonotonicMs = 600;
  deliver(current, 3); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  expect(hydrateConsumers()).toMatchObject({dashboard: {selection: 'ets2', fresh: true, observation: {windowFresh: true}}, overlay: {source: 'ETS2', freshness: 'current'}});
});
it('constructs hidden click-through nonfocus sandboxed overlay and retains dashboard-only authority', async () => {
  await ready(); expect(configurations[1]).toMatchObject({show: false, focusable: false, transparent: true, frame: false, skipTaskbar: true,
    webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false}});
  // The constructor flag would apply Electron's `floating` level, which stacks the overlay behind the taskbar.
  expect(configurations[1]).not.toHaveProperty('alwaysOnTop');
  expect(windows[1].setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]);
  expect(windows[1].setIgnoreMouseEvents).toHaveBeenCalledWith(true); expect(windows[1].setFocusable).toHaveBeenCalledWith(false);
  expect(windows[1].moveTop).not.toHaveBeenCalled();
  expect(windows[0].setAlwaysOnTop).not.toHaveBeenCalled();
  expect(configurations[1].webPreferences!.preload).toContain('overlay-preload.cjs');
  expect(configurations[0].webPreferences).not.toHaveProperty('partition');
  expect(configurations[0].webPreferences).not.toHaveProperty('session');
  expect(configurations[1].webPreferences!.partition).toBe('ets2telemetry-overlay');
  expect(configurations[1].webPreferences!.partition!.startsWith('persist:')).toBe(false);
  expect(configurations[1].webPreferences).not.toHaveProperty('session');
  await expect(handlers.get('telemetry:select')!(overlayTrusted(), 'ats')).rejects.toThrow('Untrusted');
  ipc.emit('overlay:subscribe', trusted()); ipc.emit('overlay:subscribe', {sender: overlayContents, senderFrame: {}});
  expect(overlayContents.postMessage).not.toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted()); expect(overlayContents.postMessage).toHaveBeenCalledOnce();
  expect(windows[1].showInactive).not.toHaveBeenCalled();
});
it('re-asserts the overlay topmost level after showing and records a fact-only diagnostic when it was lost', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); ipc.emit('overlay:subscribe', overlayTrusted());
  const overlay = windows[1]; overlay.setAlwaysOnTop.mockClear();
  // As observed on 2026-10-13: the HWND lost WS_EX_TOPMOST before it was shown over a borderless game.
  overlay.topmost = false;
  deliver(currentGame());
  expect(overlay.showInactive).toHaveBeenCalledOnce(); expect(overlay.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]);
  expect(overlay.showInactive.mock.invocationCallOrder[0]).toBeLessThan(overlay.setAlwaysOnTop.mock.invocationCallOrder[0]);
  expect(overlay.setAlwaysOnTop.mock.invocationCallOrder[0]).toBeLessThan(overlay.moveTop.mock.invocationCallOrder[0]);
  expect(overlay.topmost).toBe(true);
  expect(log.mock.calls.filter(call => call[0] === 'OVERLAY_TOPMOST_RESTORED')).toEqual([['OVERLAY_TOPMOST_RESTORED', undefined, {phase: 'show'}]]);
  expect(windows[0].setAlwaysOnTop).not.toHaveBeenCalled();
});
it('retains the dedicated overlay session construction across reload and renderer recovery', async () => {
  await ready(); const dashboard = windows[0], overlay = windows[1];
  const configuration = configurations[1];
  ipc.emit('overlay:subscribe', overlayTrusted()); const retired = channels[1];
  overlayContents.emit('did-start-loading'); expect(retired.port1.close).toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted());
  overlayContents.emit('render-process-gone', {}, {reason: 'crashed'});
  expect(loadFile).toHaveBeenLastCalledWith(expect.any(String), {query: {view: 'overlay'}});
  expect(windows).toEqual([dashboard, overlay]); expect(configurations).toHaveLength(2);
  expect(configurations[1]).toBe(configuration);
  expect(configuration.webPreferences).toMatchObject({partition: 'ets2telemetry-overlay', sandbox: true, contextIsolation: true, nodeIntegration: false});
  expect(configuration.webPreferences).not.toHaveProperty('session');
  expect(configurations[0].webPreferences).not.toHaveProperty('partition');
  expect(child.kill).not.toHaveBeenCalled(); expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
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
function reloadParticipants(view: 'dashboard' | 'overlay') {
  return view === 'dashboard' ? {target: contents, sender: trusted, channel: 'telemetry'} : {target: overlayContents, sender: overlayTrusted, channel: 'overlay'};
}
it.each(['dashboard', 'overlay'] as const)('retires the %s subscription that the replaced document requests before the reload commits', async view => {
  await ready(); const {target, sender, channel} = reloadParticipants(view);
  ipc.emit(`${channel}:subscribe`, sender()); const original = channels.at(-1)!;
  target.emit('did-start-loading'); expect(original.port1.close).toHaveBeenCalled();
  // Electron 44 keeps one WebFrameMain across a reload, so the outgoing document's recovery request is trusted.
  ipc.emit(`${channel}:subscribe`, sender()); const outgoing = channels.at(-1)!;
  expect(outgoing).not.toBe(original); expect(target.postMessage).toHaveBeenLastCalledWith(`${channel}:port`, null, [outgoing.port2]);
  target.emit('did-navigate'); expect(outgoing.port1.close).toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(`${view.toUpperCase()}_PRECOMMIT_SUBSCRIPTION_RETIRED`);
  ipc.emit(`${channel}:subscribe`, sender()); const replacement = channels.at(-1)!;
  expect(replacement).not.toBe(outgoing); expect(replacement.port1.close).not.toHaveBeenCalled();
  expect(target.postMessage).toHaveBeenLastCalledWith(`${channel}:port`, null, [replacement.port2]);
  expect(replacement.port1.postMessage).toHaveBeenCalledWith(expect.objectContaining({type: 'live', delivery: expect.any(Number)}));
});
it.each(['dashboard', 'overlay'] as const)('keeps one %s subscription after an uncontended reload commit', async view => {
  await ready(); const {target, sender, channel} = reloadParticipants(view);
  ipc.emit(`${channel}:subscribe`, sender());
  target.emit('did-start-loading'); target.emit('did-navigate');
  ipc.emit(`${channel}:subscribe`, sender()); const replacement = channels.at(-1)!, count = channels.length;
  ipc.emit(`${channel}:subscribe`, sender()); expect(channels).toHaveLength(count);
  expect(replacement.port1.close).not.toHaveBeenCalled();
  expect(log).not.toHaveBeenCalledWith(`${view.toUpperCase()}_PRECOMMIT_SUBSCRIPTION_RETIRED`);
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
// ET-011a changed the requirement: closing the dashboard hides it to the tray, and only an explicit exit stops owned processes.
it('hides on upstream loss, window expiry, overlay reload and credit timeout; explicit exit stops owned processes', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); ipc.emit('overlay:subscribe', overlayTrusted()); deliver(currentGame());
  windows[1].hide.mockClear(); await vi.advanceTimersByTimeAsync(250); expect(windows[1].hide).toHaveBeenCalled();
  channels[0].port1.close(); expect(windows[1].hide).toHaveBeenCalled();
  overlayContents.emit('did-start-loading'); expect(channels[1].port1.close).toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted()); await vi.advanceTimersByTimeAsync(500);
  expect(channels[2].port1.close).toHaveBeenCalled();
  app.emit('before-quit', {preventDefault: vi.fn()}); expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
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
it.each(['credit-timeout', 'port-loss', 'invalid-credit'])('logs factual current-overlay closure after %s and keeps upstream alive', async reason => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); const current = channels[1]; deliver(currentGame());
  windows[1].hide.mockClear();
  if (reason === 'credit-timeout') await vi.advanceTimersByTimeAsync(500);
  else if (reason === 'port-loss') current.port1.close();
  else current.port1.emit('message', {data: {type: 'consumed', delivery: -1}});
  expect(windows[1].hide).toHaveBeenCalled();
  expect(log.mock.calls.filter(call => call[0] === 'OVERLAY_CHANNEL_CLOSED')).toEqual([['OVERLAY_CHANNEL_CLOSED', 'Active overlay subscription closed']]);
  expect(channels[0].port1.close).not.toHaveBeenCalled(); expect(child.kill).not.toHaveBeenCalled();
  ipc.emit('overlay:subscribe', overlayTrusted()); expect(channels).toHaveLength(3);
  windows[1].hide.mockClear(); current.port1.emit('close');
  expect(windows[1].hide).not.toHaveBeenCalled();
  expect(log.mock.calls.filter(call => call[0] === 'OVERLAY_CHANNEL_CLOSED')).toHaveLength(1);
});
// ET-011a: a dashboard close no longer closes the overlay channel, so that case now exits after the close.
it.each(['unsubscribe', 'reload', 'overlay-crash', 'overlay-close', 'exit-after-dashboard-close', 'stop'])('does not label intentional overlay %s as unexpected closure', async reason => {
  await ready(); ipc.emit('overlay:subscribe', overlayTrusted()); const current = channels[1];
  if (reason === 'unsubscribe') ipc.emit('overlay:unsubscribe', overlayTrusted());
  else if (reason === 'reload') overlayContents.emit('did-start-loading');
  else if (reason === 'overlay-crash') overlayContents.emit('render-process-gone', {}, {reason: 'crashed'});
  else if (reason === 'overlay-close') windows[1].emit('closed');
  else if (reason === 'exit-after-dashboard-close') {windows[0].emit('closed'); expect(current.port1.close).not.toHaveBeenCalled(); app.emit('before-quit', {preventDefault: vi.fn()});}
  else app.emit('before-quit', {preventDefault: vi.fn()});
  expect(current.port1.close).toHaveBeenCalled(); current.port1.emit('close');
  expect(log.mock.calls.filter(call => call[0] === 'OVERLAY_CHANNEL_CLOSED')).toHaveLength(0);
});
it('requires current window authority and new projected data after a long overlay channel gap', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); deliver(currentGame()); channels[1].port1.close();
  await vi.advanceTimersByTimeAsync(60000); windows[1].showInactive.mockClear();
  ipc.emit('overlay:subscribe', overlayTrusted()); const replacement = channels[2];
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  const stale = replacement.port1.postMessage.mock.lastCall![0];
  expect(stale.update).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
  replacement.port1.emit('message', {data: {type: 'consumed', delivery: stale.delivery}});
  const current = currentGame(); current.observation!.windowReceivedMonotonicMs = 60000;
  // A new window receipt authorizes placement, but the old SDK capture cannot renew metrics.
  deliver(current, 2); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  const sameCapture = replacement.port1.postMessage.mock.lastCall![0];
  expect(sameCapture.update).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
  replacement.port1.emit('message', {data: {type: 'consumed', delivery: sameCapture.delivery}});
  current.observation!.capture.monotonicNs = '9999999999'; current.observation!.windowReceivedMonotonicMs = 60050;
  deliver(current, 3); await vi.advanceTimersByTimeAsync(50);
  expect(replacement.port1.postMessage.mock.lastCall![0].update).toMatchObject({freshness: 'current', source: 'ETS2'});
});
it('recovers the third upstream loss after a bounded cooldown in the same ready service', async () => {
  await ready(); await exhaustUpstream();
  await vi.advanceTimersByTimeAsync(59999); expect(upstreamRequests()).toBe(3);
  await vi.advanceTimersByTimeAsync(251); expect(upstreamRequests()).toBe(4);
  expect(children).toHaveLength(1); expect(child.kill).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds recurring upstream losses across multiple cooldowns without accumulating recovery timers', async () => {
  await ready(); const attempts: number[] = [];
  child.postMessage.mockImplementation((message: {type: string}) => {if (message.type === 'subscribe') attempts.push(performance.now());});
  for (let loss = 0; loss < 9; loss++) {
    const current = channels.at(-1)!; current.port1.close();
    const count = upstreamRequests(), logs = log.mock.calls.length;
    expect(vi.getTimerCount()).toBe(1);
    current.port1.emit('close'); deliver(currentGame(), 100, current);
    expect(log).toHaveBeenCalledTimes(logs); expect(vi.getTimerCount()).toBe(1);
    expect(current.port1.postMessage).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    if (upstreamRequests() === count) await vi.advanceTimersByTimeAsync(60000);
    expect(upstreamRequests()).toBe(count + 1); expect(vi.getTimerCount()).toBe(0);
  }
  expect(attempts).toHaveLength(9);
  for (const time of attempts) expect(attempts.filter(attempt => attempt <= time && time - attempt < 60000).length).toBeLessThanOrEqual(2);
  expect(log.mock.calls.filter(call => call[0] === 'MAIN_CHANNEL_CLOSED')).toHaveLength(9);
  const cooldowns = log.mock.calls.filter(call => call[0] === 'MAIN_CHANNEL_RECOVERY_COOLDOWN');
  expect(cooldowns.length).toBeGreaterThanOrEqual(3);
  expect(cooldowns.every(call => call[1].delayMs === 60000)).toBe(true);
  expect(children).toHaveLength(1); expect(child.kill).not.toHaveBeenCalled();
});
it.each(['retry', 'cooldown'])('cancels pending upstream %s on stop and ignores retired deliveries', async phase => {
  await ready(); const retired = phase === 'cooldown' ? await exhaustUpstream() : [channels[0]];
  if (phase === 'retry') retired[0].port1.close();
  expect(vi.getTimerCount()).toBe(1); const count = upstreamRequests();
  app.emit('before-quit', {preventDefault: vi.fn()}); child.emit('exit', 0);
  const logs = log.mock.calls.length;
  for (const old of retired) {old.port1.emit('close'); deliver(currentGame(), 100, old);}
  await vi.advanceTimersByTimeAsync(61000);
  expect(upstreamRequests()).toBe(count); expect(log).toHaveBeenCalledTimes(logs);
  expect(children).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});
it.each(['retry', 'cooldown'])('cancels old-service upstream %s on generation replacement', async phase => {
  await ready(); const retired = phase === 'cooldown' ? await exhaustUpstream() : [channels[0]];
  if (phase === 'retry') retired[0].port1.close();
  const count = upstreamRequests(); child.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(250); const replacement = children[1];
  replacement.emit('message', {type: 'ready'}); await settle();
  expect(upstreamRequests(replacement)).toBe(1); expect(vi.getTimerCount()).toBe(0);
  const logs = log.mock.calls.length, total = channels.length;
  for (const old of retired) {old.port1.emit('close'); deliver(currentGame(), 100, old);}
  child.emit('message', {type: 'failed'}); await vi.advanceTimersByTimeAsync(61000);
  expect(log).toHaveBeenCalledTimes(logs); expect(upstreamRequests()).toBe(count);
  expect(upstreamRequests(replacement)).toBe(1); expect(channels).toHaveLength(total);
  expect(replacement.kill).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it.each(['stop', 'service-exit'])('does not log intentional upstream closure on %s', async reason => {
  await ready(); const current = channels[0];
  if (reason === 'stop') {app.emit('before-quit', {preventDefault: vi.fn()}); child.emit('exit', 0);}
  else child.emit('exit', 1);
  expect(current.port1.close).toHaveBeenCalled(); current.port1.emit('close');
  expect(log.mock.calls.filter(call => call[0] === 'MAIN_CHANNEL_CLOSED' || call[0] === 'MAIN_CHANNEL_RECOVERY_COOLDOWN')).toHaveLength(0);
});
it('rechecks the upstream budget at cooldown expiry instead of forcing a subscription', async () => {
  await ready(); await exhaustUpstream(); const clock = vi.spyOn(performance, 'now'); clock.mockReturnValue(NaN);
  await vi.advanceTimersByTimeAsync(60250); expect(upstreamRequests()).toBe(3); expect(vi.getTimerCount()).toBe(1);
  expect(log.mock.calls.filter(call => call[0] === 'MAIN_CHANNEL_RECOVERY_COOLDOWN')).toHaveLength(2);
  clock.mockReturnValue(120500); await vi.advanceTimersByTimeAsync(60000);
  expect(upstreamRequests()).toBe(4); expect(vi.getTimerCount()).toBe(0);
});
it('keeps expired SDK and window authority across upstream cooldown and rejects retired-port publication', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready(); deliver(currentGame());
  const retired = await exhaustUpstream(); await vi.advanceTimersByTimeAsync(60250); const recovered = channels.at(-1)!;
  ipc.emit('telemetry:subscribe', trusted()); const dashboard = channels.at(-1)!;
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels.at(-1)!;
  const consume = (channel: typeof channels[number]) => channel.port1.emit('message', {data: {type: 'consumed', delivery: channel.port1.postMessage.mock.lastCall![0].delivery}});
  const projection = () => overlayChannel.port1.postMessage.mock.lastCall![0].update;
  expect(projection()).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
  consume(dashboard); consume(overlayChannel); windows[1].showInactive.mockClear();
  for (const old of retired) deliver(currentGame(), 100, old);
  await vi.advanceTimersByTimeAsync(50); expect(windows[1].showInactive).not.toHaveBeenCalled();
  deliver(currentGame(), 1, recovered); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  expect(projection()).toMatchObject({freshness: 'stale', speed: '—', fuel: '—'});
  expect(dashboard.port1.postMessage.mock.lastCall![0].update).toMatchObject({fresh: false, observation: {windowFresh: false}});
  consume(dashboard); consume(overlayChannel);
  const current = currentGame(); current.observation!.windowReceivedMonotonicMs = 61000;
  deliver(current, 2, recovered); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); expect(projection().freshness).toBe('stale');
  consume(dashboard); consume(overlayChannel);
  current.observation!.capture.monotonicNs = '9999999999'; current.observation!.windowReceivedMonotonicMs = 61050;
  deliver(current, 3, recovered); await vi.advanceTimersByTimeAsync(50);
  expect(projection()).toMatchObject({freshness: 'current', source: 'ETS2'});
  expect(dashboard.port1.postMessage.mock.lastCall![0].update).toMatchObject({fresh: true, observation: {windowFresh: true}});
  expect(upstreamRequests()).toBe(4); expect(children).toHaveLength(1);
});
it('attaches an explicit CAP0 capture grant once, only to a verified ETS2/ATS selection', async () => {
  const broker = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); vi.stubEnv('ETS2TELEMETRY_CAPTURE', 'cap0'); vi.stubEnv('ETS2TELEMETRY_CAPTURE_MINUTES', '15');
  resolveBroker.mockImplementation(() => broker);
  await ready();
  const selects = () => child.postMessage.mock.calls.map(call => call[0] as Record<string, unknown>).filter(message => message.type === 'select');
  expect(selects()).toHaveLength(1);
  expect(selects()[0]).toMatchObject({type: 'select', source: 'ets2', broker, capture: {format: 'cap0', deadlineMs: 900_000, operatorLabel: null}});
  expect(log).toHaveBeenCalledWith('CAPTURE_ACTIVATION', {format: 'cap0', deadlineMs: 900_000});
  await vi.advanceTimersByTimeAsync(300); await handlers.get('telemetry:select')!(trusted(), 'ats');
  expect(selects()).toHaveLength(2); expect(selects()[1]).toEqual({type: 'select', source: 'ats', broker});
});
it('keeps capture off by default and rejects an invalid activation without starting capture', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); vi.stubEnv('ETS2TELEMETRY_CAPTURE', 'cap0'); vi.stubEnv('ETS2TELEMETRY_CAPTURE_MINUTES', '600');
  resolveBroker.mockImplementation(() => ({executable: 'C:\\isolated\\b.exe', discoveryDirectory: 'C:\\isolated\\t'}));
  await ready();
  expect(log).toHaveBeenCalledWith('CAPTURE_ACTIVATION_REJECTED', expect.stringContaining('interval'));
  expect(child.postMessage.mock.calls.some(call => 'capture' in (call[0] as object))).toBe(false);
});
it('does not renew a used capture grant after a supervised service restart', async () => {
  const broker = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); vi.stubEnv('ETS2TELEMETRY_CAPTURE', 'cap0');
  resolveBroker.mockImplementation(() => broker);
  await ready();
  expect(child.postMessage.mock.calls.filter(call => 'capture' in (call[0] as object))).toHaveLength(1);
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1]; replacement.emit('message', {type: 'ready'}); await settle();
  const selects = replacement.postMessage.mock.calls.map(call => call[0] as Record<string, unknown>).filter(message => message.type === 'select');
  expect(selects).toEqual([{type: 'select', source: 'ets2', broker}]);
});
it('records the opt-in startup timeline and main event-loop stalls only for an explicit diagnostic directory', async () => {
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated\\diagnostics');
  await ready();
  const events = () => log.mock.calls.map(call => call[0] as string);
  expect(events()).toEqual(expect.arrayContaining(['DASHBOARD_WINDOW_CREATED', 'OVERLAY_WINDOW_CREATED']));
  contents.emit('did-start-loading'); contents.emit('did-finish-load'); overlayContents.emit('did-finish-load');
  // The mock has no OS renderer process, so the PID is explicitly unavailable rather than invented.
  expect(log).toHaveBeenCalledWith('DASHBOARD_LOAD_STARTED', undefined, undefined);
  expect(log).toHaveBeenCalledWith('DASHBOARD_LOAD_FINISHED', undefined, {rendererPid: null});
  expect(log).toHaveBeenCalledWith('OVERLAY_LOAD_FINISHED', undefined, {rendererPid: null});
  app.emit('child-process-gone', {}, {type: 'GPU', reason: 'crashed', exitCode: 3, name: 'GPU'});
  expect(log).toHaveBeenCalledWith('CHILD_PROCESS_GONE', undefined, {type: 'GPU', reason: 'crashed', exitCode: 3, name: 'GPU'});
  await vi.advanceTimersByTimeAsync(1000);
  expect(events()).not.toContain('MAIN_EVENT_LOOP_LAG');
  // A blocked main thread: the clock moves 3 s while no timer runs.
  vi.setSystemTime(Date.now() + 3000); await vi.advanceTimersByTimeAsync(250);
  expect(log).toHaveBeenCalledWith('MAIN_EVENT_LOOP_LAG', undefined, {gapMs: 3250, lateMs: 3000});
  // None of these observations may match the smoke's failure-event pattern.
  expect(events().filter(name => /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(name))).toEqual([]);
});
it('keeps default logs free of the diagnostic timeline and lag monitor', async () => {
  await ready();
  contents.emit('did-start-loading'); contents.emit('did-finish-load'); app.emit('child-process-gone', {}, {type: 'GPU', reason: 'crashed', exitCode: 3});
  vi.setSystemTime(Date.now() + 3000); await vi.advanceTimersByTimeAsync(250);
  const timeline = ['DASHBOARD_WINDOW_CREATED', 'OVERLAY_WINDOW_CREATED', 'DASHBOARD_LOAD_STARTED', 'DASHBOARD_LOAD_FINISHED', 'CHILD_PROCESS_GONE', 'MAIN_EVENT_LOOP_LAG'];
  expect(log.mock.calls.map(call => call[0] as string).filter(name => timeline.includes(name))).toEqual([]);
});

// ET-011a lifecycle: single instance, close-to-tray, tray, explicit exit and health.
const trayMenuItem = (label: string) => (trays[0].setContextMenu.mock.lastCall![0] as {template: {label?: string; enabled?: boolean; click?: () => void}[]}).template.find(item => item.label === label)!;
const failurePattern = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
function closeDashboard(target = windows[0]) {const event = {preventDefault: vi.fn()}; target.emit('close', event); if (!event.preventDefault.mock.calls.length) target.emit('closed'); return event;}
async function isolatedProfile(run: (profile: string) => Promise<void>) {
  const profile = await mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-lifecycle-profile-'));
  try {await run(profile);} finally {await rm(profile, {recursive: true, force: true});}
}
it('exits a second process before diagnostics, listeners, service, windows or tray when the instance lock is held', async () => {
  lockGranted = false; trayAvailable = true;
  await import('../../apps/desktop/src/main'); await settle();
  expect(app.quit).toHaveBeenCalledOnce(); expect(log).not.toHaveBeenCalled();
  expect(windows).toHaveLength(0); expect(trays).toHaveLength(0); expect(loadFile).not.toHaveBeenCalled(); expect(handlers.size).toBe(0);
  for (const name of ['before-quit', 'window-all-closed', 'second-instance']) expect(app.listenerCount(name)).toBe(0);
  expect(child.listenerCount('message')).toBe(0); expect(app.exit).not.toHaveBeenCalled();
});
it('applies the diagnostic profile before requesting the instance lock that it scopes', () => isolatedProfile(async profile => {
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', profile); await ready();
  expect(app.setPath).toHaveBeenCalledWith('userData', profile);
  expect(app.setPath.mock.invocationCallOrder[0]).toBeLessThan(app.requestSingleInstanceLock.mock.invocationCallOrder[0]);
}));
it('closes the dashboard to the tray without stopping the service, upstream or overlay', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  ipc.emit('telemetry:subscribe', trusted()); const dashboard = channels[2];
  expect(closeDashboard().preventDefault).not.toHaveBeenCalled();
  expect(dashboard.port1.close).toHaveBeenCalled(); expect(channels[0].port1.close).not.toHaveBeenCalled(); expect(overlayChannel.port1.close).not.toHaveBeenCalled();
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'}); expect(child.kill).not.toHaveBeenCalled(); expect(app.exit).not.toHaveBeenCalled();
  app.emit('window-all-closed'); expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  // The overlay still follows live data while the main window is closed.
  overlayChannel.port1.emit('message', {data: {type: 'consumed', delivery: overlayChannel.port1.postMessage.mock.lastCall![0].delivery}});
  deliver(currentGame()); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  expect(overlayChannel.port1.postMessage.mock.lastCall![0].update).toMatchObject({freshness: 'current', source: 'ETS2'});
  // The closed document's sender loses every authority.
  await expect(handlers.get('telemetry:select')!(trusted(), 'ats')).rejects.toThrow('Untrusted');
  expect(() => handlers.get('app:get-state')!(trusted())).toThrow('Untrusted');
  expect(trays[0].destroy).not.toHaveBeenCalled();
});
it('reopens a new dashboard from the tray that resubscribes without a second upstream subscription', async () => {
  trayAvailable = true; await ready(); ipc.emit('telemetry:subscribe', trusted());
  const complete = pendingVerification(), pending = handlers.get('telemetry:select')!(trusted(), 'ets2');
  closeDashboard(); trays[0].emit('click');
  expect(windows).toHaveLength(3); expect(configurations[2].webPreferences).toMatchObject({sandbox: true, contextIsolation: true, nodeIntegration: false});
  const reopened = extraContents[0], reopenedSender = {sender: reopened, senderFrame: reopened.mainFrame};
  complete(); await expect(pending).rejects.toThrow('retired');
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ets2'}));
  ipc.emit('telemetry:subscribe', trusted()); expect(reopened.postMessage).not.toHaveBeenCalled();
  ipc.emit('telemetry:subscribe', reopenedSender);
  expect(reopened.postMessage).toHaveBeenCalledWith('telemetry:port', null, [channels.at(-1)!.port2]);
  expect(upstreamRequests()).toBe(1); expect(children).toHaveLength(1);
  expect(handlers.get('app:get-state')!(reopenedSender)).toEqual({health: {service: 'ready', storage: 'verified', recording: 'unavailable', lastError: null}});
  // A second tray open focuses the existing window instead of creating another.
  trays[0].emit('click'); expect(windows).toHaveLength(3); expect(windows[2].show).toHaveBeenCalledOnce(); expect(windows[2].focus).toHaveBeenCalledOnce();
});
it('does not recreate the dashboard or a second overlay when the service restarts while the window is closed', async () => {
  trayAvailable = true; await ready(); closeDashboard();
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  children[1].emit('message', {type: 'ready'}); await settle();
  expect(windows).toHaveLength(2); expect(configurations).toHaveLength(2); expect(loadFile).toHaveBeenCalledTimes(2);
  expect(upstreamRequests(children[1])).toBe(1); expect(app.exit).not.toHaveBeenCalled();
  trays[0].emit('click'); expect(windows).toHaveLength(3); expect(configurations[2].webPreferences).not.toHaveProperty('partition');
});
it.each([
  ['before first readiness', 'ignored-starting'], ['with a visible dashboard', 'focused'], ['with a minimized dashboard', 'restored'],
  ['after the dashboard closed', 'created'], ['while exiting', 'ignored-exiting']
] as const)('answers a second launch %s without reading its arguments', async (state, action) => {
  trayAvailable = true;
  if (state === 'before first readiness') {await import('../../apps/desktop/src/main'); await settle();}
  else {
    await ready();
    if (state === 'with a minimized dashboard') windows[0].minimized = true;
    if (state === 'after the dashboard closed') closeDashboard();
    if (state === 'while exiting') app.emit('before-quit', {preventDefault: vi.fn()});
  }
  const count = windows.length;
  app.emit('second-instance', {}, ['electron.exe', '--inspect', 'C:\\attacker\\path'], 'C:\\attacker', {payload: 'ignored'});
  expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action});
  expect(windows).toHaveLength(action === 'created' ? count + 1 : count);
  if (action === 'restored') expect(windows[0].restore).toHaveBeenCalledOnce();
  if (action === 'focused' || action === 'restored') {expect(windows[0].show).toHaveBeenCalledOnce(); expect(windows[0].focus).toHaveBeenCalledOnce();}
  if (action === 'ignored-exiting' || action === 'ignored-starting') expect(windows.every(target => target.show.mock.calls.length === 0)).toBe(true);
  expect(JSON.stringify(log.mock.calls)).not.toContain('attacker');
});
it.each(['tray', 'renderer', 'app-quit', 'session-end'] as const)('runs one orderly exit for a %s request and removes the tray before exiting', async reason => {
  trayAvailable = true; await ready(); ipc.emit('overlay:subscribe', overlayTrusted());
  const request = () => {
    if (reason === 'tray') trayMenuItem('Exit ETS2Telemetry').click!();
    else if (reason === 'renderer') void handlers.get('app:exit')!(trusted());
    else if (reason === 'app-quit') {const event = {preventDefault: vi.fn()}; app.emit('before-quit', event); expect(event.preventDefault).toHaveBeenCalled();}
    else windows[1].emit('session-end');
  };
  request(); request(); app.emit('before-quit', {preventDefault: vi.fn()}); windows[0].emit('session-end');
  expect(log.mock.calls.filter(call => call[0] === 'APP_EXIT_REQUESTED')).toEqual([['APP_EXIT_REQUESTED', undefined, {reason}]]);
  expect(child.postMessage.mock.calls.filter(call => call[0].type === 'stop')).toHaveLength(1);
  expect(channels.every(channel => channel.port1.close.mock.calls.length > 0)).toBe(true);
  expect(windows[1].hide).toHaveBeenCalled();
  expect(trays[0].setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting');
  expect(trayMenuItem('Exit ETS2Telemetry').enabled).toBe(false); expect(trayMenuItem('Open ETS2Telemetry').enabled).toBe(false);
  // Exiting is final: tray and overlay close requests no longer reopen or keep anything.
  trays[0].emit('click'); expect(windows).toHaveLength(2);
  const overlayClose = {preventDefault: vi.fn()}; windows[1].emit('close', overlayClose); expect(overlayClose.preventDefault).not.toHaveBeenCalled();
  expect(app.exit).not.toHaveBeenCalled(); expect(trays[0].destroy).not.toHaveBeenCalled();
  child.emit('exit', 0);
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(trays[0].destroy).toHaveBeenCalledOnce();
  expect(trays[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(app.exit.mock.invocationCallOrder[0]);
  expect(log.mock.calls.map(call => call[0] as string).filter(name => failurePattern.test(name))).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
it('rejects application exit and state requests from untrusted senders, frames and the overlay', async () => {
  trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()]) {
    expect(() => handlers.get('app:exit')!(event)).toThrow('Untrusted'); expect(() => handlers.get('app:get-state')!(event)).toThrow('Untrusted');
    ipc.emit('app:subscribe-state', event);
  }
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'}); expect(log).not.toHaveBeenCalledWith('APP_EXIT_REQUESTED', undefined, expect.anything());
  expect(contents.send).not.toHaveBeenCalledWith('app:state', expect.anything()); expect(overlayContents.send).not.toHaveBeenCalled();
});
it('keeps the overlay open against close requests until exit and ignores window-all-closed', async () => {
  trayAvailable = true; await ready();
  const event = {preventDefault: vi.fn()}; windows[1].emit('close', event); expect(event.preventDefault).toHaveBeenCalledOnce();
  app.emit('window-all-closed'); expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'}); expect(app.exit).not.toHaveBeenCalled();
});
it('minimizes instead of closing the dashboard when the notification area is unavailable', async () => {
  await ready(); expect(log).toHaveBeenCalledWith('TRAY_UNAVAILABLE', expect.any(String));
  const event = closeDashboard(); expect(event.preventDefault).toHaveBeenCalledOnce(); expect(windows[0].minimize).toHaveBeenCalledOnce();
  expect(handlers.get('app:get-state')!(trusted())).toMatchObject({health: {service: 'ready'}});
  void handlers.get('app:exit')!(trusted()); const exitClose = {preventDefault: vi.fn()}; windows[0].emit('close', exitClose);
  expect(exitClose.preventDefault).not.toHaveBeenCalled();
});
it('recovers a post-readiness service failure report with a supervised restart and visible health', async () => {
  trayAvailable = true; await ready(); ipc.emit('app:subscribe-state', trusted());
  const states = () => contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => (call[1] as {health: Record<string, unknown>}).health);
  expect(states().at(-1)).toEqual({service: 'ready', storage: 'verified', recording: 'unavailable', lastError: null});
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  expect(child.kill).toHaveBeenCalledOnce(); expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'}); expect(app.exit).not.toHaveBeenCalled();
  expect(states().at(-1)).toEqual({service: 'restarting', storage: 'failed', recording: 'unavailable', lastError: 'STORAGE_FAILED'});
  child.emit('exit', 1); expect(states().at(-1)).toMatchObject({service: 'restarting', lastError: 'STORAGE_FAILED'});
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  expect(states().at(-1)).toEqual({service: 'ready', storage: 'verified', recording: 'unavailable', lastError: 'STORAGE_FAILED'});
  await vi.advanceTimersByTimeAsync(500); expect(trays[0].setToolTip).toHaveBeenLastCalledWith(expect.stringMatching(/^ETS2Telemetry\nService ready/));
  expect(app.exit).not.toHaveBeenCalled(); expect(windows).toHaveLength(2);
});
it('keeps a pre-readiness service failure report fatal', async () => {
  trayAvailable = true; await import('../../apps/desktop/src/main'); await settle();
  child.emit('message', {type: 'failed', code: 'STORAGE_TIMEOUT'});
  expect(child.kill).not.toHaveBeenCalled(); expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
  child.emit('exit', 0); expect(app.exit).toHaveBeenCalledExactlyOnceWith(1); expect(trays[0].destroy).toHaveBeenCalledOnce();
});
it('shows restart exhaustion in health and the tray and stays running until an explicit exit', async () => {
  trayAvailable = true; await ready();
  for (let crash = 0; crash < 3; crash++) {
    children.at(-1)!.emit('exit', 1); await vi.advanceTimersByTimeAsync(1000);
    if (crash < 2) {children.at(-1)!.emit('message', {type: 'ready'}); await settle();}
  }
  expect(handlers.get('app:get-state')!(trusted())).toEqual({health: {service: 'failed', storage: 'pending', recording: 'unavailable', lastError: 'SERVICE_RESTART_EXHAUSTED'}});
  await vi.advanceTimersByTimeAsync(500);
  expect(trays[0].setImage).toHaveBeenCalled(); expect(trays[0].setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nService failed');
  expect(app.exit).not.toHaveBeenCalled();
  trayMenuItem('Exit ETS2Telemetry').click!(); expect(app.exit).toHaveBeenCalledOnce(); expect(trays[0].destroy).toHaveBeenCalledOnce();
});
it('registers no diagnostic lifecycle events outside the isolated live smoke configuration', async () => {
  trayAvailable = true; await ready();
  for (const name of ['ets2telemetry:diagnostic-tray-action', 'ets2telemetry:diagnostic-lifecycle-state', 'ets2telemetry:diagnostic-service-exit']) expect(app.listenerCount(name)).toBe(0);
});
it('opens and exits through the gated diagnostic tray action and reports read-only lifecycle facts', () => isolatedProfile(async profile => {
  vi.stubEnv('ETS2TELEMETRY_LIVE_SMOKE', '1'); vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated\\diagnostics');
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', profile); trayAvailable = true; await ready();
  const facts = () => {let value: Record<string, unknown> | undefined; app.emit('ets2telemetry:diagnostic-lifecycle-state', (state: Record<string, unknown>) => {value = state;}); return value;};
  expect(facts()).toMatchObject({started: true, exiting: false, serviceReady: true, tray: true, dashboard: true, overlay: true, upstream: true, health: {service: 'ready'}});
  closeDashboard(); expect(facts()).toMatchObject({dashboard: false, overlay: true, upstream: true});
  app.emit('ets2telemetry:diagnostic-tray-action', 'C:\\anything'); expect(windows).toHaveLength(2);
  app.emit('ets2telemetry:diagnostic-tray-action', 'open'); expect(windows).toHaveLength(3); expect(facts()).toMatchObject({dashboard: true});
  app.emit('ets2telemetry:diagnostic-tray-action', 'exit');
  expect(log).toHaveBeenCalledWith('APP_EXIT_REQUESTED', undefined, {reason: 'tray'}); expect(facts()).toMatchObject({exiting: true, health: {service: 'stopping'}});
  child.emit('exit', 0); expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(log.mock.calls.map(call => call[0] as string).filter(name => failurePattern.test(name))).toEqual([]);
}));
// ET-011a fix round 1.
it('answers a dashboard opened during a service restart with a not-ready status, then the status after readiness', async () => {
  trayAvailable = true; await ready(); closeDashboard();
  child.emit('exit', 1); trays[0].emit('click'); expect(windows).toHaveLength(3);
  const reopened = extraContents[0], sender = {sender: reopened, senderFrame: reopened.mainFrame};
  expect(handlers.get('scaffold:status')!(sender)).toBeNull();
  expect(() => handlers.get('scaffold:status')!(trusted())).toThrow('Untrusted');
  ipc.emit('app:subscribe-state', sender);
  expect(reopened.send).toHaveBeenLastCalledWith('app:state', {health: expect.objectContaining({service: 'restarting'})});
  // When the pushed health reports ready, the status query already answers with the ready status.
  let statusAtReadyPush: unknown;
  reopened.send.mockImplementation((channel: string, state: {health: {service: string}}) => {
    if (channel === 'app:state' && state.health.service === 'ready') statusAtReadyPush = handlers.get('scaffold:status')!(sender);
  });
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  expect(statusAtReadyPush).toEqual({service: 'ready', storage: 'verified', synthetic: true});
});
it('never requests the instance lock when the diagnostic profile override fails', async () => {
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', 'relative\\profile'); trayAvailable = true;
  await import('../../apps/desktop/src/main'); await settle();
  expect(app.requestSingleInstanceLock).not.toHaveBeenCalled(); expect(app.quit).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('PROFILE_SETUP_FAILED', expect.any(Error));
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(windows).toHaveLength(0); expect(trays).toHaveLength(0); expect(child.listenerCount('message')).toBe(0);
});
