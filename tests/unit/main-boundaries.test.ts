import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import type {AppUninstallResult, LiveTelemetry} from '../../packages/contracts/src';
import type {AppUninstallPorts} from '../../apps/desktop/src/uninstall/app-uninstall';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {MAIN_EXIT_FLUSH_MS} from '../../apps/desktop/src/diagnostics';
import {initialLive} from '../../apps/desktop/src/live-state';
import {v1Projection, type V1Options} from '../shared/live-v1-fixtures';
import {changed, DETAIL, LIST_ITEM, TRIP, TRIP_PAGE} from '../shared/journal-replies';

const processEvents = ['uncaughtException', 'unhandledRejection'] as const;
const processEmitter: EventEmitter = process;
let originals: Map<string, ReturnType<EventEmitter['listeners']>>;
let app: EventEmitter & {exit: ReturnType<typeof vi.fn>; quit: ReturnType<typeof vi.fn>; setPath: ReturnType<typeof vi.fn>; requestSingleInstanceLock: ReturnType<typeof vi.fn>;
  disableHardwareAcceleration: ReturnType<typeof vi.fn>; commandLine: {appendSwitch: ReturnType<typeof vi.fn>}};
let ipc: EventEmitter;
let handlers: Map<string, (event: unknown, source?: unknown) => unknown>;
let child: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>};
let children: typeof child[];
let contents: EventEmitter & {mainFrame: object; send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>; setZoomFactor: ReturnType<typeof vi.fn>};
let resolveBroker: ReturnType<typeof vi.fn>;
let loadFile: ReturnType<typeof vi.fn>;
let overlayContents: typeof contents;
let windows: (EventEmitter & {webContents: typeof contents; hide: ReturnType<typeof vi.fn>; showInactive: ReturnType<typeof vi.fn>; setBounds: ReturnType<typeof vi.fn>;
  topmost: boolean; setAlwaysOnTop: ReturnType<typeof vi.fn>; moveTop: ReturnType<typeof vi.fn>; setIgnoreMouseEvents: ReturnType<typeof vi.fn>; setFocusable: ReturnType<typeof vi.fn>;
  minimized: boolean; minimize: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn>;
  focused: boolean; setMovable: ReturnType<typeof vi.fn>; setSkipTaskbar: ReturnType<typeof vi.fn>; bounds: Electron.Rectangle})[];
// ET-016 PR-5: the Save dialog of the trip export; each case sets its answer.
let showSaveDialog: ReturnType<typeof vi.fn<(window: unknown, options: unknown) => Promise<{canceled: boolean; filePath?: string}>>>;
// ET-017 PR-4: the folder dialog and the shell calls of plugin setup; each case sets its answers.
let showOpenDialog: ReturnType<typeof vi.fn<(window: unknown, options: unknown) => Promise<{canceled: boolean; filePaths: string[]}>>>;
// ET-018 PR-4: dialog.showMessageBox, with or without a parent window.
let showMessageBox: ReturnType<typeof vi.fn<(...args: unknown[]) => Promise<{response: number}>>>;
let shell: {showItemInFolder: ReturnType<typeof vi.fn<(file: string) => void>>; openPath: ReturnType<typeof vi.fn<(folder: string) => Promise<string>>>};
let channels: {port1: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn<() => void>>; start: ReturnType<typeof vi.fn<() => void>>}; port2: {close: ReturnType<typeof vi.fn<() => void>>}}[];
let configurations: Electron.BrowserWindowConstructorOptions[];
let log: ReturnType<typeof vi.fn> & {flush: ReturnType<typeof vi.fn>; finalize: ReturnType<typeof vi.fn>};
// Log location fix: the arguments of every createDiagnostics call and of every service fork.
let diagnosticsCalls: unknown[][], forkCalls: unknown[][];
// ET-011a fixture additions. The tray is unavailable unless a test enables it, so earlier tests keep their
// timer and log expectations; windows after the first dashboard and overlay get their own web contents.
let lockGranted: boolean;
let trayAvailable: boolean;
let trays: (EventEmitter & {setToolTip: ReturnType<typeof vi.fn>; setContextMenu: ReturnType<typeof vi.fn>; setImage: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; destroyed: boolean})[];
let extraContents: typeof contents[];
// Every import of main.ts that a case starts. main.ts is an entry point with startup side effects, so each
// case evaluates a fresh instance after vi.resetModules(). An instance still loading when its case ends (for
// example after a timeout) would otherwise finish against the next case's fixture: extra windows and loads.
const loadingMain = new Set<Promise<unknown>>();
function loadMain(): Promise<unknown> {
  const loading = import('../../apps/desktop/src/main');
  loadingMain.add(loading); void loading.finally(() => loadingMain.delete(loading)).catch(() => undefined);
  return loading;
}
// Captured before any fake timers are installed; removeFixture uses it to cross one real macrotask boundary.
const realSetImmediate = setImmediate;
// One-time module-graph load. The first import of main.ts transforms it and every non-mocked dependency, which
// took 4-5 s when all default Vitest workers competed for the transform pipeline on a 24-thread host. Pay that
// cost here, under the same fixture, so no case's own timeout measures module transformation; later cases only
// re-evaluate the already transformed graph. This budget is a load allowance, not a behaviour bound.
const MODULE_GRAPH_LOAD_BUDGET_MS = 60_000;
beforeAll(async () => {
  installFixture();
  try {await loadMain(); await settle();} finally {await removeFixture();}
}, MODULE_GRAPH_LOAD_BUDGET_MS);
// ET-011b fixture addition: a settled in-memory settings store, so main never touches the real %LOCALAPPDATA% and
// readiness timing is unchanged. `settingsWrite` controls each save; `settingsView` is what the store reports.
class FakeSettingsError extends Error {constructor(readonly code: 'SETTINGS_WRITE_FAILED' | 'SETTINGS_READ_ONLY') {super(code === 'SETTINGS_READ_ONLY' ? 'Settings are read-only' : 'Settings could not be saved');}}
class FakeSettingsBusyError extends Error {}
// ET-012a: the view carries the overlay layout and sections; `overlayWrite` controls each overlay save.
const ALL_SECTIONS = {'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true,
  'destination': true, 'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true};
// ET-012b: the overlay settings carry the placements of every layout (the ET-012a anchors at scale 1 by default).
const PLACEMENTS = {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}};
const DEFAULT_OVERLAY = {layout: 'strip', sections: ALL_SECTIONS, placements: PLACEMENTS};
// ET-012b: the application state carries the overlay edit mode, which every start leaves in driving mode.
const DRIVING = {active: false};
// ET-017: the application state carries the plugin setup view. These cases run with ETS2TELEMETRY_SOURCE_KIND set and
// unpackaged, so the mode gate disables plugin setup: nothing is read or written, and no game is ever discovered.
const NO_PLUGIN_GAME = {excluded: false, discovery: 'pending', manualFolder: 'none', targets: [], unlistedFolders: 0};
const PLUGINS_DISABLED = {mode: 'disabled', bundled: null, running: false, games: {ets2: NO_PLUGIN_GAME, ats: NO_PLUGIN_GAME}};
let settingsView: {units: {ets2: string; ats: string}; overlay: {layout: string; sections: Record<string, boolean>; placements: Record<string, {x: number; y: number; scale: number}>}; state: string; writable: boolean; saveError: string | null};
type OverlayWrite = (kind: 'layout' | 'sections' | 'placement', value: unknown) => Promise<unknown>;
let overlayWrite: ReturnType<typeof vi.fn<OverlayWrite>>;
type SettingsWrite = (game: string, profile: string) => Promise<unknown>;
let settingsWrite: ReturnType<typeof vi.fn<SettingsWrite>>;
let settingsIdle: Promise<void> | undefined;
let settingsDirectories: unknown[];
let settingsLoaded: boolean;
let settingsLoading: Promise<unknown>;
// Clean late read (October 15, 2026): the `changed` callback main hands to the store, which reports a late read.
let settingsChanged: (() => void) | undefined;
beforeEach(() => {
  expect(loadingMain.size, 'a previous case left main.ts loading').toBe(0);
  installFixture();
});
afterEach(() => removeFixture());
function installFixture() {
  vi.useFakeTimers(); vi.resetModules();
  const started = Date.now(); vi.spyOn(performance, 'now').mockImplementation(() => Date.now() - started);
  originals = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  lockGranted = true; trayAvailable = false; trays = []; extraContents = [];
  app = Object.assign(new EventEmitter(), {exit: vi.fn(), quit: vi.fn(), getPath: () => 'C:\\isolated', setPath: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false,
    requestSingleInstanceLock: vi.fn(() => lockGranted), disableHardwareAcceleration: vi.fn(), commandLine: {appendSwitch: vi.fn()}});
  child = Object.assign(new EventEmitter(), {postMessage: vi.fn(), kill: vi.fn(() => true)});
  children = [child]; let forks = 0;
  contents = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn()});
  overlayContents = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn()});
  windows = []; channels = []; configurations = [];
  loadFile = vi.fn(() => Promise.resolve());
  handlers = new Map(); ipc = new EventEmitter();
  Object.assign(ipc, {handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(name, handler)});
  resolveBroker = vi.fn(() => undefined);
  showSaveDialog = vi.fn(() => Promise.resolve({canceled: true, filePath: ''}));
  showOpenDialog = vi.fn(() => Promise.resolve({canceled: true, filePaths: []}));
  showMessageBox = vi.fn(() => Promise.resolve({response: 0}));
  shell = {showItemInFolder: vi.fn(), openPath: vi.fn(() => Promise.resolve(''))};
  forkCalls = [];
  vi.doMock('electron', () => ({app, ipcMain: ipc, utilityProcess: {fork: (...args: unknown[]) => {
    forkCalls.push(args);
    if (forks++ === 0) return child;
    const next = Object.assign(new EventEmitter(), {postMessage: vi.fn(), kill: vi.fn(() => true)}); children.push(next); return next;
  }},
    screen: Object.assign(new EventEmitter(), {screenToDipRect: (_window: null, bounds: Electron.Rectangle) => bounds, getAllDisplays: () => [{bounds: {x: -1920, y: 0, width: 3840, height: 1080}}]}),
    BrowserWindow: class extends EventEmitter {
      webContents = windows.length === 0 ? contents : windows.length === 1 ? overlayContents : (() => {
        const next = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn(), setZoomFactor: vi.fn()}); extraContents.push(next); return next;
      })();
      minimized = false; isMinimized = () => this.minimized; minimize = vi.fn(() => {this.minimized = true;}); restore = vi.fn(() => {this.minimized = false;}); show = vi.fn(); focus = vi.fn();
      hide = vi.fn(); showInactive = vi.fn(); setBounds = vi.fn(); setIgnoreMouseEvents = vi.fn(); setFocusable = vi.fn(); destroy = vi.fn(() => this.emit('closed'));
      // ET-012b: focus feeds the edit mode's own-foreground gate; the overlay becomes movable only while edited.
      focused = false; isFocused = () => this.focused; setMovable = vi.fn(); setSkipTaskbar = vi.fn(); bounds = {x: 0, y: 0, width: 0, height: 0}; getBounds = () => ({...this.bounds});
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
    nativeImage: {createFromBuffer: () => ({addRepresentation: vi.fn()})},
    dialog: {showSaveDialog: (window: unknown, options: unknown) => showSaveDialog(window, options), showOpenDialog: (window: unknown, options: unknown) => showOpenDialog(window, options),
      showMessageBox: (...args: unknown[]) => showMessageBox(...args)},
    shell: {showItemInFolder: (file: string) => shell.showItemInFolder(file), openPath: (folder: string) => shell.openPath(folder)}}));
  vi.doMock('../../apps/desktop/src/entrypoints', () => ({processEntrypoint: () => 'package.json'}));
  log = Object.assign(vi.fn(), {flush: vi.fn(() => Promise.resolve(true)), settle: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), finalize: vi.fn<(timeoutMs: number) => Promise<void>>(() => Promise.resolve()), drainSync: vi.fn()}); diagnosticsCalls = [];
  vi.doMock('../../apps/desktop/src/diagnostics', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/diagnostics')>(),
    createDiagnostics: (...args: unknown[]) => {diagnosticsCalls.push(args); return log;}}));
  vi.doMock('../../apps/desktop/src/broker-artifact', () => ({brokerConfiguration: resolveBroker, createBrokerResolver: () => resolveBroker}));
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'synthetic');
  settingsView = {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: null};
  settingsWrite = vi.fn<SettingsWrite>(); overlayWrite = vi.fn<OverlayWrite>(); settingsIdle = undefined; settingsDirectories = []; settingsLoaded = true; settingsLoading = Promise.resolve();
  settingsChanged = undefined;
  vi.doMock('../../apps/desktop/src/settings-store', () => ({
    settingsDirectory: (localAppData: unknown) => typeof localAppData === 'string' ? `${localAppData}\\ETS2Telemetry\\settings` : undefined, SettingsError: FakeSettingsError, SettingsBusyError: FakeSettingsBusyError,
    SettingsStore: class {
      get settled() {return settingsLoaded;}
      constructor(directory: unknown, options?: {changed?: () => void}) {settingsDirectories.push(directory); settingsChanged = options?.changed;}
      view() {return settingsView;}
      load() {return settingsLoading.then(() => {settingsLoaded = true; return settingsView;});}
      setUnitProfile(game: string, profile: string) {return settingsWrite(game, profile);}
      setOverlayLayout(layout: string) {return overlayWrite('layout', layout);}
      setOverlaySections(sections: unknown) {return overlayWrite('sections', sections);}
      setOverlayPlacement(layout: string, placement: unknown) {return overlayWrite('placement', [layout, placement]);}
      idle() {return settingsIdle;}
    }}));
}
async function removeFixture() {
  // Let an import that outlived its case finish, and its startup microtasks run, against this case's fixture
  // while its fake timers are still installed, so nothing it starts can reach the next case.
  await Promise.allSettled(loadingMain); await new Promise(resolve => realSetImmediate(resolve));
  for (const name of processEvents) for (const listener of processEmitter.listeners(name)) if (!originals.get(name)!.includes(listener)) processEmitter.removeListener(name, listener as (...args: unknown[]) => void);
  vi.clearAllTimers(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs();
  for (const name of ['electron', '../../apps/desktop/src/entrypoints', '../../apps/desktop/src/diagnostics', '../../apps/desktop/src/broker-artifact',
    '../../apps/desktop/src/settings-store', '../../apps/desktop/src/plugin-setup/plugin-setup', '../../apps/desktop/src/squirrel-events',
    '../../apps/desktop/src/uninstall/app-uninstall']) vi.doUnmock(name);
}
async function settle() {await Promise.resolve(); await Promise.resolve();}
async function ready() {await loadMain(); await Promise.resolve(); child.emit('message', {type: 'ready'}); await settle();}
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
  await loadMain(); await settle();
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
  expect(handlers.get('app:get-state')!(reopenedSender)).toEqual({health: {service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: null}, settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: null}, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED});
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
  if (state === 'before first readiness') {await loadMain(); await settle();}
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
// ET-018 (U2): a Squirrel event runs first and alone. The handler is replaced here; it never sees the real execPath layout.
async function withArgv(args: readonly string[], run: () => Promise<void>) {
  const argv = process.argv;
  process.argv = [argv[0], 'apps\\desktop\\dist\\main.js', ...args];
  try {await run();} finally {process.argv = argv;}
}
it.each([
  [['--squirrel-uninstall', '0.1.0'], {kind: 'event', event: 'uninstall', version: '0.1.0'}, 3],
  [['--squirrel-obsolete', '0.1.0'], {kind: 'event', event: 'obsolete', version: '0.1.0'}, 0],
  [['--squirrel-install', '0.1.0', '--extra'], {kind: 'invalid'}, 4]
] as const)('dispatches %j before the profile override, the lock, logs, settings, plugin setup and the service', async (args, parsed, code) => {
  const run = vi.fn(() => Promise.resolve(code));
  vi.doMock('../../apps/desktop/src/squirrel-events', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/squirrel-events')>(),
    runSquirrelEvent: run, productionSquirrelPorts: () => ({})}));
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', 'C:\\never-applied');
  trayAvailable = true;
  await withArgv(args, async () => {await loadMain(); await settle();});
  expect(run).toHaveBeenCalledExactlyOnceWith(parsed, {});
  // No GPU or network-service child process may outlive a Squirrel event process.
  expect(app.disableHardwareAcceleration).toHaveBeenCalledOnce();
  expect(app.commandLine.appendSwitch.mock.calls).toEqual([['in-process-gpu'], ['enable-features', 'NetworkServiceInProcess2']]);
  expect(app.commandLine.appendSwitch.mock.invocationCallOrder[0]).toBeLessThan(run.mock.invocationCallOrder[0]);
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(code);
  expect(app.setPath).not.toHaveBeenCalled(); expect(app.requestSingleInstanceLock).not.toHaveBeenCalled();
  expect(diagnosticsCalls).toEqual([]); expect(log).not.toHaveBeenCalled(); expect(settingsDirectories).toEqual([]);
  expect(forkCalls).toEqual([]); expect(windows).toHaveLength(0); expect(trays).toHaveLength(0);
  for (const name of ['before-quit', 'window-all-closed', 'second-instance']) expect(app.listenerCount(name)).toBe(0);
});
it('starts normally for --squirrel-firstrun', async () => {
  const run = vi.fn(() => Promise.resolve(0));
  vi.doMock('../../apps/desktop/src/squirrel-events', async importOriginal => ({...await importOriginal<typeof import('../../apps/desktop/src/squirrel-events')>(),
    runSquirrelEvent: run}));
  await withArgv(['--squirrel-firstrun'], async () => {await ready();});
  expect(run).not.toHaveBeenCalled();
  expect(app.disableHardwareAcceleration).not.toHaveBeenCalled(); expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  expect(app.requestSingleInstanceLock).toHaveBeenCalledOnce();
  expect(app.listenerCount('second-instance')).toBe(1);
});
// ET-018 (U6): the one second-instance payload that exits. Main deletes nothing for it.
it.each([
  ['an extra key', {ets2telemetry: 'uninstall-exit', force: true}], ['another value', {ets2telemetry: 'Uninstall-Exit'}], ['another key', {ETS2Telemetry: 'uninstall-exit'}],
  ['an array', ['uninstall-exit']], ['a string', 'uninstall-exit'], ['null', null], ['no data', undefined], ['an empty object', {}]
] as const)('only shows the dashboard for a second launch with %s, even with Squirrel arguments', async (_name, data) => {
  trayAvailable = true; await ready();
  app.emit('second-instance', {}, ['ETS2TelemetryDesktop.exe', '--squirrel-uninstall', '0.1.0'], 'C:\\isolated', data);
  expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action: 'focused'});
  expect(windows[0].show).toHaveBeenCalledOnce();
  expect(log).not.toHaveBeenCalledWith('APP_EXIT_REQUESTED', undefined, expect.anything());
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
});
it('an exiting instance ignores the uninstall-exit payload', async () => {
  trayAvailable = true; await ready();
  app.emit('before-quit', {preventDefault: vi.fn()});
  app.emit('second-instance', {}, [], 'C:\\isolated', {ets2telemetry: 'uninstall-exit'});
  expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action: 'ignored-exiting'});
  expect(log.mock.calls.filter(call => call[0] === 'APP_EXIT_REQUESTED')).toEqual([['APP_EXIT_REQUESTED', undefined, {reason: 'app-quit'}]]);
});
it('an uninstall-exit request before first readiness still exits once', async () => {
  trayAvailable = true; await loadMain(); await settle();
  app.emit('second-instance', {}, [], 'C:\\isolated', {ets2telemetry: 'uninstall-exit'});
  expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action: 'uninstall-exit'});
  expect(log.mock.calls.filter(call => call[0] === 'APP_EXIT_REQUESTED')).toEqual([['APP_EXIT_REQUESTED', undefined, {reason: 'uninstall'}]]);
});
it.each(['tray', 'renderer', 'app-quit', 'session-end', 'uninstall'] as const)('runs one orderly exit for a %s request and removes the tray before exiting', async reason => {
  trayAvailable = true; await ready(); ipc.emit('overlay:subscribe', overlayTrusted());
  const request = () => {
    if (reason === 'tray') trayMenuItem('Exit ETS2Telemetry').click!();
    else if (reason === 'renderer') void handlers.get('app:exit')!(trusted());
    else if (reason === 'app-quit') {const event = {preventDefault: vi.fn()}; app.emit('before-quit', event); expect(event.preventDefault).toHaveBeenCalled();}
    else if (reason === 'uninstall') app.emit('second-instance', {}, ['ETS2TelemetryDesktop.exe', '--squirrel-uninstall', '0.1.0'], 'C:\\isolated', {ets2telemetry: 'uninstall-exit'});
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
  // Since October 18, 2026 main exits after its pending log records are written, waiting at most MAIN_EXIT_FLUSH_MS.
  expect(log.finalize).toHaveBeenCalledExactlyOnceWith(MAIN_EXIT_FLUSH_MS); expect(app.exit).not.toHaveBeenCalled();
  await settle();
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
  expect(log.finalize.mock.invocationCallOrder[0]).toBeLessThan(app.exit.mock.invocationCallOrder[0]);
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
  expect(states().at(-1)).toEqual({service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: null});
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  expect(child.kill).toHaveBeenCalledOnce(); expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'}); expect(app.exit).not.toHaveBeenCalled();
  expect(states().at(-1)).toEqual({service: 'restarting', storage: 'failed', recording: {state: 'unknown'}, lastError: 'STORAGE_FAILED'});
  child.emit('exit', 1); expect(states().at(-1)).toMatchObject({service: 'restarting', lastError: 'STORAGE_FAILED'});
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  expect(states().at(-1)).toEqual({service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: 'STORAGE_FAILED'});
  await vi.advanceTimersByTimeAsync(500); expect(trays[0].setToolTip).toHaveBeenLastCalledWith(expect.stringMatching(/^ETS2Telemetry\nService ready/));
  expect(app.exit).not.toHaveBeenCalled(); expect(windows).toHaveLength(2);
});
it('keeps a pre-readiness service failure report fatal', async () => {
  trayAvailable = true; await loadMain(); await settle();
  child.emit('message', {type: 'failed', code: 'STORAGE_TIMEOUT'});
  expect(child.kill).not.toHaveBeenCalled(); expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
  child.emit('exit', 0); await settle(); expect(app.exit).toHaveBeenCalledExactlyOnceWith(1); expect(trays[0].destroy).toHaveBeenCalledOnce();
});
it('shows restart exhaustion in health and the tray and stays running until an explicit exit', async () => {
  trayAvailable = true; await ready();
  for (let crash = 0; crash < 3; crash++) {
    children.at(-1)!.emit('exit', 1); await vi.advanceTimersByTimeAsync(1000);
    if (crash < 2) {children.at(-1)!.emit('message', {type: 'ready'}); await settle();}
  }
  expect(handlers.get('app:get-state')!(trusted())).toEqual({health: {service: 'failed', storage: 'pending', recording: {state: 'unknown'}, lastError: 'SERVICE_RESTART_EXHAUSTED'}, settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: null}, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED});
  await vi.advanceTimersByTimeAsync(500);
  expect(trays[0].setImage).toHaveBeenCalled(); expect(trays[0].setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nService failed');
  expect(app.exit).not.toHaveBeenCalled();
  trayMenuItem('Exit ETS2Telemetry').click!(); await settle(); expect(app.exit).toHaveBeenCalledOnce(); expect(trays[0].destroy).toHaveBeenCalledOnce();
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
  child.emit('exit', 0); await settle(); expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
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
  expect(reopened.send).toHaveBeenLastCalledWith('app:state', {health: expect.objectContaining({service: 'restarting'}), settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: null}, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED});
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
  await loadMain(); await settle();
  expect(app.requestSingleInstanceLock).not.toHaveBeenCalled(); expect(app.quit).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith('PROFILE_SETUP_FAILED', expect.any(Error));
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(windows).toHaveLength(0); expect(trays).toHaveLength(0); expect(child.listenerCount('message')).toBe(0);
});
// PR #52 advisory review fixes.
it('retires readiness, status and live channels as soon as a post-readiness failure is reported', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); ipc.emit('telemetry:subscribe', trusted());
  const upstream = channels[0], dashboard = channels[2];
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  expect(child.kill).toHaveBeenCalledOnce();
  // Until the killed service's exit arrives (up to 3000 ms) nothing may treat it as ready.
  await expect(handlers.get('telemetry:select')!(trusted(), 'ats')).rejects.toThrow('Untrusted');
  expect(handlers.get('scaffold:status')!(trusted())).toBeNull();
  expect(upstream.port1.close).toHaveBeenCalled(); expect(dashboard.port1.close).toHaveBeenCalled();
  expect(contents.send).toHaveBeenCalledWith('telemetry:service-state', expect.objectContaining({status: 'restarting', fresh: false}));
  windows[1].showInactive.mockClear(); deliver(currentGame(), 1, upstream); await vi.advanceTimersByTimeAsync(50);
  expect(windows[1].showInactive).not.toHaveBeenCalled();
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select', source: 'ats'}));
  // The killed service's exit then follows the ordinary supervised restart without closing anything twice.
  const closes = upstream.port1.close.mock.calls.length;
  child.emit('exit', 1); expect(upstream.port1.close.mock.calls.length).toBe(closes);
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  expect(upstreamRequests(children[1])).toBe(1);
  expect(handlers.get('scaffold:status')!(trusted())).toEqual({service: 'ready', storage: 'verified', synthetic: true});
  await vi.advanceTimersByTimeAsync(250); await handlers.get('telemetry:select')!(trusted(), 'ats');
  expect(children[1].postMessage).toHaveBeenCalledWith({type: 'select', source: 'ats', broker: undefined});
  expect(app.exit).not.toHaveBeenCalled();
});
it.each(['overlay-restart-exhausted', 'service-recovery-timeout'] as const)('marks the application exiting at the start of a fatal %s stop', async trigger => {
  trayAvailable = true; await ready();
  if (trigger === 'overlay-restart-exhausted') for (let crash = 0; crash < 3; crash++) overlayContents.emit('render-process-gone', {}, {reason: 'crashed'});
  else {child.emit('message', {type: 'failed', code: 'SERVICE_START_FAILED'}); await vi.advanceTimersByTimeAsync(3000);}
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'}); expect(app.exit).not.toHaveBeenCalled();
  // During the stop window: the dashboard may close, nothing reopens it, the overlay may close and the tray is disabled.
  expect(closeDashboard().preventDefault).not.toHaveBeenCalled();
  const count = windows.length;
  app.emit('second-instance', {}, [], 'C:\\isolated'); trays[0].emit('click');
  expect(windows).toHaveLength(count); expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action: 'ignored-exiting'});
  const overlayClose = {preventDefault: vi.fn()}; windows[1].emit('close', overlayClose); expect(overlayClose.preventDefault).not.toHaveBeenCalled();
  expect(trayMenuItem('Open ETS2Telemetry').enabled).toBe(false); expect(trayMenuItem('Exit ETS2Telemetry').enabled).toBe(false);
  expect(trays[0].setToolTip).toHaveBeenLastCalledWith('ETS2Telemetry\nExiting');
  expect(log).not.toHaveBeenCalledWith('APP_EXIT_REQUESTED', undefined, expect.anything());
  child.emit('exit', trigger === 'overlay-restart-exhausted' ? 0 : 1); await settle();
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(trays[0].destroy.mock.invocationCallOrder[0]).toBeLessThan(app.exit.mock.invocationCallOrder[0]);
});
// ET-011b: persisted settings and per-game unit profiles.
function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {resolve = done; reject = fail;});
  return {promise, resolve, reject};
}
/** A current ETS2 game reading of 25 m/s and 73 L. */
function currentReading(): LiveTelemetry {
  const current = currentGame(), state = current.observation!.state;
  state.speed = {available: true, value: 25, unit: 'm/s'}; state.fuel = {available: true, value: 73, unit: 'L'};
  return current;
}
const saveUnits = (event: unknown, ...request: unknown[]) => Promise.resolve(handlers.get('settings:set-unit-profile')!(event, ...request as [unknown]));
const overlayProjection = (channel: typeof channels[number]) => channel.port1.postMessage.mock.lastCall![0].update as Record<string, unknown>;
const consumeOverlay = (channel: typeof channels[number]) => channel.port1.emit('message', {data: {type: 'consumed', delivery: channel.port1.postMessage.mock.lastCall![0].delivery}});
/** Advances in 50 ms steps and acknowledges each new overlay delivery, as the renderer would. */
async function drainOverlay(channel: typeof channels[number], milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 50) {
    const count = channel.port1.postMessage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(50);
    if (channel.port1.postMessage.mock.calls.length > count) consumeOverlay(channel);
  }
}
// Without LOCALAPPDATA main logged under userData and the service under TEMP, so one root never held both logs.
const forkEnvironment = (index = 0) => (forkCalls[index][2] as {env: Record<string, string | undefined>}).env;
it('resolves one log root under userData without LOCALAPPDATA and forks every service with it', async () => {
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', undefined); vi.stubEnv('LOCALAPPDATA', undefined);
  // A value in main's own launch environment is replaced, never trusted.
  vi.stubEnv('ETS2TELEMETRY_SERVICE_LOG_ROOT', 'C:\\elsewhere');
  await ready();
  const root = 'C:\\isolated\\ETS2Telemetry\\logs';
  expect(diagnosticsCalls[0]).toEqual([root, false]);
  expect(forkEnvironment()).toMatchObject({ETS2TELEMETRY_SERVICE_LOG_ROOT: root, ETS2TELEMETRY_SOURCE_KIND: 'synthetic'});
  expect(forkEnvironment()).not.toHaveProperty('LOCALAPPDATA');
  // A supervised restart forks the replacement with the same root.
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  expect(forkCalls).toHaveLength(2); expect(forkEnvironment(1)).toMatchObject({ETS2TELEMETRY_SERVICE_LOG_ROOT: root});
});
it('resolves the log root under LOCALAPPDATA when it is set and forks the service with it', async () => {
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', undefined); vi.stubEnv('LOCALAPPDATA', 'C:\\isolated\\local');
  await ready();
  const root = 'C:\\isolated\\local\\ETS2Telemetry\\logs';
  expect(diagnosticsCalls[0]).toEqual([root, false]);
  expect(forkEnvironment()).toMatchObject({ETS2TELEMETRY_SERVICE_LOG_ROOT: root, LOCALAPPDATA: 'C:\\isolated\\local'});
});
it('hands the diagnostic directory to the service as its log root, with detailed main logs', async () => {
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated\\diagnostics'); vi.stubEnv('LOCALAPPDATA', 'C:\\isolated\\local');
  await ready();
  expect(diagnosticsCalls[0]).toEqual(['C:\\isolated\\diagnostics', true]);
  expect(forkEnvironment()).toMatchObject({ETS2TELEMETRY_SERVICE_LOG_ROOT: 'C:\\isolated\\diagnostics',
    ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\isolated\\diagnostics'});
});
it('loads settings from LOCALAPPDATA and opens the first windows only after the load settled', async () => {
  vi.stubEnv('LOCALAPPDATA', 'C:\\isolated\\local');
  settingsLoaded = false; const load = deferred(); settingsLoading = load.promise;
  await ready();
  expect(settingsDirectories).toEqual(['C:\\isolated\\local\\ETS2Telemetry\\settings']);
  expect(windows).toHaveLength(0); expect(child.postMessage).not.toHaveBeenCalled();
  load.resolve(); await settle(); await settle();
  expect(windows).toHaveLength(2); expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'synthetic', broker: undefined});
});
// Clean late read (October 15, 2026; hosted run 38755116140): the windows open with defaults in the pending `loading`
// state, and the late read's result reaches the dashboard and the overlay as a save's does.
it('applies a settings read that settles after the load budget to the dashboard and the overlay without renewing authority', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2');
  const pending = {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loading', writable: false, saveError: null};
  settingsView = pending; await ready();
  expect(windows).toHaveLength(2);
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  const pushes = () => contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => call[1] as {settings: unknown});
  expect(pushes().at(-1)!.settings).toEqual(pending);
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({source: 'ETS2', speed: '90.0', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L', freshness: 'current'});
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); consumeOverlay(overlayChannel);
  await drainOverlay(overlayChannel, 150);
  // The store applies the late read (t = 200 ms) and reports it; main reads the new view from the store.
  settingsView = {units: {ets2: 'us-customary', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null};
  expect(settingsChanged).toBeTypeOf('function'); settingsChanged!();
  expect(pushes().at(-1)).toEqual({health: {service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: null}, settings: settingsView, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED});
  expect(handlers.get('app:get-state')!(trusted())).toMatchObject({settings: settingsView});
  await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({source: 'ETS2', speed: '55.9', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal', freshness: 'current'});
  consumeOverlay(overlayChannel);
  // Nothing was saved, and neither SDK nor window freshness was renewed: the reading still expires 500 ms after its
  // delivery, inside this window; a renewal when the read was applied would end after it.
  expect(settingsWrite).not.toHaveBeenCalled(); expect(windows[1].showInactive).toHaveBeenCalledOnce();
  await drainOverlay(overlayChannel, 300);
  expect(overlayProjection(overlayChannel)).toMatchObject({speed: '—', fuel: '—', speedUnit: 'mph', fuelUnit: 'US gal', freshness: 'stale'});
});
it('rejects unit profile requests from untrusted senders, frames and the overlay, and invalid values', async () => {
  trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    await expect(saveUnits(event, 'ets2', 'us-customary')).rejects.toThrow('Untrusted');
  for (const request of [['ets2', 'imperial'], ['synthetic', 'metric'], ['ETS2', 'metric'], ['ats'], ['ats', 'metric', 'C:\\settings.json'], [{}, 'metric']])
    await expect(saveUnits(trusted(), ...request)).rejects.toThrow('Invalid unit profile request');
  expect(settingsWrite).not.toHaveBeenCalled();
  expect(contents.send).not.toHaveBeenCalledWith('app:state', expect.anything());
});
it('applies a unit profile only after the durable save and republishes the overlay without renewing authority', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({source: 'ETS2', speed: '90.0', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L', freshness: 'current'});
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); consumeOverlay(overlayChannel);
  const pushes = () => contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => call[1] as {settings: unknown; health: {lastError: unknown}});
  const before = pushes().length, saved = deferred<typeof settingsView>();
  settingsWrite.mockReturnValue(saved.promise);
  const request = saveUnits(trusted(), 'ets2', 'us-customary');
  await vi.advanceTimersByTimeAsync(100);
  // Not durable yet: nothing applied, pushed or republished.
  expect(settingsWrite).toHaveBeenCalledExactlyOnceWith('ets2', 'us-customary');
  expect(pushes()).toHaveLength(before); expect(overlayProjection(overlayChannel)).toMatchObject({speedUnit: 'km/h'});
  settingsView = {units: {ets2: 'us-customary', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null}; saved.resolve(settingsView);
  await expect(request).resolves.toEqual(settingsView);
  expect(pushes().at(-1)).toEqual({health: {service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: null}, settings: settingsView, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED});
  await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({source: 'ETS2', speed: '55.9', speedUnit: 'mph', fuel: '19.3', fuelUnit: 'US gal', freshness: 'current'});
  consumeOverlay(overlayChannel);
  // The republication renewed neither SDK nor window receipts: both still expire from the original delivery.
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  // Main's original 500 ms SDK deadline falls inside this window; a renewal at the save (t = 150 ms) would end after it.
  await drainOverlay(overlayChannel, 400);
  expect(overlayProjection(overlayChannel)).toMatchObject({speed: '—', fuel: '—', speedUnit: 'mph', fuelUnit: 'US gal', freshness: 'stale'});
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); expect(windows[1].hide).toHaveBeenCalled();
  // The dashboard derives its units from the pushed settings; its live update stays canonical.
  ipc.emit('telemetry:subscribe', trusted());
  expect(channels.at(-1)!.port1.postMessage.mock.lastCall![0].update.observation.state.speed).toEqual({available: true, value: 25, unit: 'm/s'});
});
it.each(['SETTINGS_WRITE_FAILED', 'SETTINGS_READ_ONLY'] as const)('keeps the units and the service problem and reports %s in the settings view', async code => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  // A recovered post-readiness storage failure stays the service's last problem.
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'}); child.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  const upstream = channels.at(-1)!;
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels.at(-1)!;
  consumeOverlay(overlayChannel); deliver(currentReading(), 1, upstream); await vi.advanceTimersByTimeAsync(50); consumeOverlay(overlayChannel);
  const health = {service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: 'STORAGE_FAILED'};
  expect(handlers.get('app:get-state')!(trusted())).toMatchObject({health});
  const deliveries = overlayChannel.port1.postMessage.mock.calls.length;
  // The store records the refusal in its view, as the real store does.
  settingsWrite.mockImplementation(() => {settingsView = {...settingsView, saveError: code}; return Promise.reject(new FakeSettingsError(code));});
  await expect(saveUnits(trusted(), 'ets2', 'us-customary')).rejects.toThrow(code === 'SETTINGS_READ_ONLY' ? 'Settings are read-only' : 'Settings could not be saved');
  const refused = {health, settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'defaults', writable: true, saveError: code}, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED};
  expect(handlers.get('app:get-state')!(trusted())).toEqual(refused);
  expect(contents.send).toHaveBeenLastCalledWith('app:state', refused);
  await vi.advanceTimersByTimeAsync(50); expect(overlayChannel.port1.postMessage.mock.calls).toHaveLength(deliveries);
  // A later successful save clears the settings error and still leaves the service problem in place.
  settingsWrite.mockImplementation(() => {settingsView = {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null}; return Promise.resolve(settingsView);});
  await saveUnits(trusted(), 'ats', 'us-customary');
  const saved = {health, settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'loaded', writable: true, saveError: null}, overlayEdit: DRIVING, plugins: PLUGINS_DISABLED};
  expect(handlers.get('app:get-state')!(trusted())).toEqual(saved);
  expect(contents.send).toHaveBeenLastCalledWith('app:state', saved);
});
it('waits for an in-flight settings save before exiting and refuses new saves once exiting', async () => {
  trayAvailable = true; await ready();
  const idle = deferred(); settingsIdle = idle.promise;
  void handlers.get('app:exit')!(trusted()); child.emit('exit', 0);
  expect(app.exit).not.toHaveBeenCalled(); expect(trays[0].destroy).not.toHaveBeenCalled();
  await expect(saveUnits(trusted(), 'ets2', 'us-customary')).rejects.toThrow('retired'); expect(settingsWrite).not.toHaveBeenCalled();
  idle.resolve(); await settle();
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0); expect(trays[0].destroy).toHaveBeenCalledOnce();
});
it('exits after at most 1000 ms when an in-flight settings save does not settle', async () => {
  trayAvailable = true; await ready();
  settingsIdle = new Promise(() => undefined);
  void handlers.get('app:exit')!(trusted()); child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(999); expect(app.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('reports the settings view in the gated lifecycle facts', () => isolatedProfile(async profile => {
  vi.stubEnv('ETS2TELEMETRY_LIVE_SMOKE', '1'); vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated\\diagnostics');
  vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', profile); trayAvailable = true;
  settingsView = {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: null}; await ready();
  let facts: Record<string, unknown> | undefined;
  app.emit('ets2telemetry:diagnostic-lifecycle-state', (state: Record<string, unknown>) => {facts = state;});
  expect(facts).toMatchObject({settings: {units: {ets2: 'metric', ats: 'us-customary'}, overlay: DEFAULT_OVERLAY, state: 'invalid-file', writable: true, saveError: null}});
}));
// ET-012a: overlay layouts and sections. The snapshot's game client is 1920 x 1080 at (-1920, 0) and the fixture's
// screen conversion is the identity, so the strip is {-1600, 8, 1280, 110} with every section (ET-012c: three 36 px
// rows at 1280 DIP wide; it was one 38 px row before the requirement changed) and the card {-316, 16, 300, 384} with
// every section (ET-012d: 48 + 24 × 14 CSS px; it was 360 before the requirement changed). The cluster is created
// 440 × 267 (36 + 21 × 11) and the HUD placed {-1904, 16, 320, 354} (18 + 24 × 14).
const saveOverlay = (channel: 'settings:set-overlay-layout' | 'settings:set-overlay-sections', event: unknown, ...request: unknown[]) =>
  Promise.resolve(handlers.get(channel)!(event, ...request as [unknown]));
const sectionIds = (projection: Record<string, unknown>) => (projection.sections as {id: string}[]).map(section => section.id);
it('creates the overlay window at the strip size reserved for every section by default', async () => {
  await ready(); expect(configurations[1]).toMatchObject({width: 1280, height: 110});
});
it('creates the overlay window at the size the saved layout reserves for its sections', async () => {
  settingsView = {...settingsView, overlay: {layout: 'cluster', sections: ALL_SECTIONS, placements: PLACEMENTS}}; await ready();
  expect(configurations[1]).toMatchObject({width: 440, height: 267});
});
it('delivers the saved layout and sections in the overlay document first projection', async () => {
  settingsView = {...settingsView, overlay: {layout: 'card', sections: {...ALL_SECTIONS, rpm: false, cargo: false}, placements: PLACEMENTS}}; await ready();
  // Twelve sections reserve 48 + 24 × 12 = 336 CSS px, below the card's nominal 360.
  expect(configurations[1]).toMatchObject({width: 300, height: 360});
  ipc.emit('overlay:subscribe', overlayTrusted());
  const first = overlayProjection(channels.at(-1)!);
  expect(first).toMatchObject({layout: 'card', freshness: 'unavailable', paused: false});
  // Before any current data only the baseline placeholders show (decision L5); disabled sections never do.
  expect(sectionIds(first)).toEqual(['speed', 'fuel']);
});
it('rejects overlay settings requests from untrusted senders, frames and the overlay, and invalid shapes', async () => {
  trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()]) {
    await expect(saveOverlay('settings:set-overlay-layout', event, 'card')).rejects.toThrow('Untrusted');
    await expect(saveOverlay('settings:set-overlay-sections', event, ALL_SECTIONS)).rejects.toThrow('Untrusted');
  }
  for (const request of [['bar'], ['Card'], [], ['card', 'hud'], [{layout: 'card'}]])
    await expect(saveOverlay('settings:set-overlay-layout', trusted(), ...request)).rejects.toThrow('Invalid overlay layout request');
  for (const request of [[], [ALL_SECTIONS, 'extra'], [{...ALL_SECTIONS, theme: true}], [{...ALL_SECTIONS, rpm: 1}],
    [Object.fromEntries(Object.keys(ALL_SECTIONS).map(id => [id, false]))], [[true]], ['all']])
    await expect(saveOverlay('settings:set-overlay-sections', trusted(), ...request)).rejects.toThrow('Invalid overlay sections request');
  expect(overlayWrite).not.toHaveBeenCalled();
  expect(contents.send).not.toHaveBeenCalledWith('app:state', expect.anything());
});
it('applies an overlay layout only after the durable save, then republishes and re-places the overlay without renewing authority', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({layout: 'strip', speed: '90.0', freshness: 'current'});
  expect(windows[1].setBounds.mock.calls).toEqual([[{x: -1600, y: 8, width: 1280, height: 110}]]);
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); consumeOverlay(overlayChannel);
  windows[1].setAlwaysOnTop.mockClear(); windows[1].moveTop.mockClear();
  const pushes = () => contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => call[1] as {settings: unknown});
  const before = pushes().length, saved = deferred<typeof settingsView>();
  overlayWrite.mockReturnValue(saved.promise);
  const request = saveOverlay('settings:set-overlay-layout', trusted(), 'card');
  await vi.advanceTimersByTimeAsync(100);
  // Not durable yet: nothing applied, pushed, republished or moved.
  expect(overlayWrite).toHaveBeenCalledExactlyOnceWith('layout', 'card');
  expect(pushes()).toHaveLength(before); expect(windows[1].setBounds).toHaveBeenCalledOnce();
  expect(overlayProjection(overlayChannel)).toMatchObject({layout: 'strip'});
  settingsView = {...settingsView, overlay: {layout: 'card', sections: ALL_SECTIONS, placements: PLACEMENTS}, state: 'loaded'}; saved.resolve(settingsView);
  await expect(request).resolves.toEqual(settingsView);
  expect(pushes().at(-1)).toMatchObject({settings: settingsView});
  expect(windows[1].setBounds).toHaveBeenLastCalledWith({x: -316, y: 16, width: 300, height: 384});
  expect(windows[1].setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(windows[1].moveTop).toHaveBeenCalledOnce();
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(50);
  const currentProjection = overlayProjection(overlayChannel);
  expect(currentProjection).toMatchObject({layout: 'card', speed: '90.0', freshness: 'current'});
  consumeOverlay(overlayChannel);
  // The original 500 ms SDK deadline still applies; a renewal at the save (t = 150 ms) would end after this window.
  await drainOverlay(overlayChannel, 400);
  expect(overlayProjection(overlayChannel)).toMatchObject({layout: 'card', speed: '—', freshness: 'stale'});
  // The stale projection keeps the last published shape (decision L5): main passes its previous projection along.
  expect(sectionIds(currentProjection).length).toBeGreaterThan(2);
  expect(overlayProjection(overlayChannel).sections).toEqual(sectionIds(currentProjection).map(id => ({id, state: 'unavailable'})));
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
});
it('applies overlay sections after the durable save and hands the store only a validated fresh copy', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50); consumeOverlay(overlayChannel);
  expect(sectionIds(overlayProjection(overlayChannel))).toContain('rpm');
  const input = {...ALL_SECTIONS, rpm: false, cargo: false};
  overlayWrite.mockImplementation((_kind, value) => {
    settingsView = {...settingsView, overlay: {layout: 'strip', sections: value as Record<string, boolean>, placements: PLACEMENTS}, state: 'loaded'}; return Promise.resolve(settingsView);
  });
  await saveOverlay('settings:set-overlay-sections', trusted(), input);
  const [kind, forwarded] = overlayWrite.mock.calls[0];
  expect(kind).toBe('sections'); expect(forwarded).toEqual(input); expect(forwarded).not.toBe(input); expect(Object.isFrozen(forwarded)).toBe(true);
  await vi.advanceTimersByTimeAsync(50);
  expect(sectionIds(overlayProjection(overlayChannel))).toEqual(['speed', 'gear', 'fuel', 'sdk-consumption', 'destination', 'expected-income', 'game-time']);
  // Without RPM and cargo the strip still needs three rows at 1280 DIP wide, so it is not re-placed.
  expect(windows[1].setBounds).toHaveBeenCalledOnce();
});
// ET-012c (decisions S7 and S8): the strip window is created and placed for the saved sections. Driving-only needs one
// row at 1280 DIP wide: 38 high.
const DRIVING_ONLY = Object.fromEntries(Object.keys(ALL_SECTIONS).map(id => [id, ['speed', 'gear', 'rpm', 'fuel', 'range'].includes(id)]));
it('creates the strip overlay window as high as its saved sections need', async () => {
  settingsView = {...settingsView, overlay: {layout: 'strip', sections: DRIVING_ONLY, placements: PLACEMENTS}}; await ready();
  expect(configurations[1]).toMatchObject({width: 1280, height: 38});
});
it('re-places the strip for saved sections only after the durable save and re-asserts topmost once without showing it again', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50); consumeOverlay(overlayChannel);
  const overlay = windows[1];
  expect(overlay.setBounds.mock.calls).toEqual([[{x: -1600, y: 8, width: 1280, height: 110}]]); expect(overlay.showInactive).toHaveBeenCalledOnce();
  overlay.setAlwaysOnTop.mockClear(); overlay.moveTop.mockClear();
  const saved = deferred<typeof settingsView>(); overlayWrite.mockReturnValue(saved.promise);
  const request = saveOverlay('settings:set-overlay-sections', trusted(), DRIVING_ONLY);
  await vi.advanceTimersByTimeAsync(10);
  // Not durable yet: the strip keeps its rows.
  expect(overlayWrite).toHaveBeenCalledOnce(); expect(overlay.setBounds).toHaveBeenCalledOnce(); expect(overlay.setAlwaysOnTop).not.toHaveBeenCalled();
  settingsView = {...settingsView, overlay: {layout: 'strip', sections: DRIVING_ONLY, placements: PLACEMENTS}, state: 'loaded'}; saved.resolve(settingsView);
  await expect(request).resolves.toEqual(settingsView);
  expect(overlay.setBounds.mock.calls).toEqual([[{x: -1600, y: 8, width: 1280, height: 110}], [{x: -1600, y: 8, width: 1280, height: 38}]]);
  expect(overlay.setAlwaysOnTop.mock.calls).toEqual([[true, 'screen-saver']]); expect(overlay.moveTop).toHaveBeenCalledOnce();
  expect(overlay.setBounds.mock.invocationCallOrder[1]).toBeLessThan(overlay.setAlwaysOnTop.mock.invocationCallOrder[0]);
  expect(overlay.showInactive).toHaveBeenCalledOnce();
});
it('keeps the overlay settings and maps refusals like a unit save', async () => {
  trayAvailable = true; await ready(); ipc.emit('app:subscribe-state', trusted());
  overlayWrite.mockImplementation(() => {settingsView = {...settingsView, saveError: 'SETTINGS_READ_ONLY'}; return Promise.reject(new FakeSettingsError('SETTINGS_READ_ONLY'));});
  await expect(saveOverlay('settings:set-overlay-layout', trusted(), 'hud')).rejects.toThrow('Settings are read-only');
  expect(contents.send).toHaveBeenLastCalledWith('app:state', expect.objectContaining({settings: expect.objectContaining({overlay: DEFAULT_OVERLAY, saveError: 'SETTINGS_READ_ONLY'})}));
  overlayWrite.mockImplementation(() => Promise.reject(new FakeSettingsBusyError('Settings request limit exceeded')));
  await expect(saveOverlay('settings:set-overlay-sections', trusted(), ALL_SECTIONS)).rejects.toThrow('Settings request limit exceeded');
  overlayWrite.mockImplementation(() => Promise.reject(new Error('private detail')));
  await expect(saveOverlay('settings:set-overlay-sections', trusted(), ALL_SECTIONS)).rejects.toThrow(/^Settings could not be saved$/);
});
it('refuses overlay settings requests once exiting', async () => {
  trayAvailable = true; await ready();
  settingsIdle = deferred().promise;
  void handlers.get('app:exit')!(trusted());
  await expect(saveOverlay('settings:set-overlay-layout', trusted(), 'card')).rejects.toThrow('retired');
  await expect(saveOverlay('settings:set-overlay-sections', trusted(), ALL_SECTIONS)).rejects.toThrow('retired');
  expect(overlayWrite).not.toHaveBeenCalled();
});
// ET-010c decisions F2, F3 and F7: main validates the v1 projection before freshness and the overlay see it, expires it
// on its own clock and feeds it into the overlay projection. The v1 input is snapshot-live with the v0 job ids under the
// ETS2 game origin; the overlay origin text is written by hand from it. Since ET-012b the projection also carries `editing`.
const OVERLAY_KEYS = ['source', 'origin', 'status', 'speed', 'speedUnit', 'fuel', 'fuelUnit', 'freshness', 'layout', 'paused', 'sections', 'editing'];
const ORIGIN_VALUE = {id: 'origin', state: 'value', text: 'Synthetic City A, Synthetic Company A'};
const sectionOf = (projection: Record<string, unknown>, id: string) => (projection.sections as {id: string}[]).find(section => section.id === id);
function readingWithV1(options: V1Options = {}): LiveTelemetry {
  return {...currentReading(), v1: v1Projection('snapshot-live', {selection: 'ets2', origin: 'game', ...options})};
}
async function v1Consumers() {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); await ready();
  ipc.emit('telemetry:subscribe', trusted()); const dashboard = channels[1];
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[2];
  consumeOverlay(dashboard); consumeOverlay(overlayChannel);
  return {dashboard, overlayChannel};
}
it('feeds a valid v1 projection to the dashboard and into the overlay sections, whose shape is unchanged', async () => {
  const {dashboard, overlayChannel} = await v1Consumers();
  deliver(readingWithV1()); await vi.advanceTimersByTimeAsync(50);
  const update = dashboard.port1.postMessage.mock.lastCall![0].update as LiveTelemetry;
  expect(update.v1).toMatchObject({selection: 'ets2', status: 'connected', fresh: true, observation: {state: {boundaryOrder: '102'}}});
  const projection = overlayProjection(overlayChannel);
  expect(Object.keys(projection)).toEqual(OVERLAY_KEYS);
  expect(sectionOf(projection, 'origin')).toEqual(ORIGIN_VALUE);
  expect(sectionOf(projection, 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'Synthetic Cargo', detail: '18.0 t'});
  expect(JSON.stringify(projection)).not.toMatch(/pluginSessionId|boundaryOrder|handle|clockMapping|10000000-0000-4000-8000-000000000001/);
  expect(log.mock.calls.filter(call => call[0] === 'LIVE_V1_REJECTED')).toEqual([]);
});
it.each([
  ['a projection that still carries the game window', (update: LiveTelemetry) => {
    (update.v1!.observation!.state as unknown as Record<string, unknown>).window = {available: true, value: {handle: '65538', x: 0, y: 0, width: 1920, height: 1080, dpi: 96,
      foreground: true, minimized: false, displayMode: 'borderless'}};
  }],
  ['a projection with an extra clock mapping', (update: LiveTelemetry) => {(update.v1 as unknown as Record<string, unknown>).clockMapping = {offsetNs: '1'};}],
  ['a projection of another selection', (update: LiveTelemetry) => {update.v1!.selection = 'ats';}]
])('strips %s, logs it at occurrences 1, 2 and 4 and keeps the v0 update and the channel', async (_name, corrupt) => {
  const {dashboard, overlayChannel} = await v1Consumers();
  for (let delivery = 1; delivery <= 5; delivery++) {
    const update = readingWithV1(); corrupt(update);
    update.observation!.capture.monotonicNs = String(delivery); deliver(update, delivery);
  }
  await vi.advanceTimersByTimeAsync(50);
  expect(log.mock.calls.filter(call => call[0] === 'LIVE_V1_REJECTED')).toEqual([1, 2, 4].map(count => ['LIVE_V1_REJECTED', undefined, {count}]));
  const update = dashboard.port1.postMessage.mock.lastCall![0].update as LiveTelemetry;
  expect(update).not.toHaveProperty('v1');
  expect(update).toMatchObject({selection: 'ets2', status: 'connected', fresh: true});
  // The overlay equals the v0-only projection: no v1 section at all.
  const projection = overlayProjection(overlayChannel);
  expect(sectionIds(projection)).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']);
  expect(sectionOf(projection, 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'cargo.logs'});
  expect(channels[0].port1.close).not.toHaveBeenCalled();
  expect(channels[0].port1.postMessage.mock.calls.map(call => call[0])).toEqual([1, 2, 3, 4, 5].map(delivery => ({type: 'consumed', delivery})));
  expect(log.mock.calls.filter(call => call[0] === 'MAIN_CHANNEL_CLOSED')).toEqual([]);
});
// PR #73 advisory review: the realistic path to a lost v1 carriage is a projection main strips while v0 continues.
it('keeps a shown overlay origin as a dash when main strips the next v1 projection, and clears it on a source change', async () => {
  const {dashboard, overlayChannel} = await v1Consumers();
  deliver(readingWithV1(), 1); await vi.advanceTimersByTimeAsync(50); consumeOverlay(dashboard); consumeOverlay(overlayChannel);
  expect(sectionOf(overlayProjection(overlayChannel), 'origin')).toEqual(ORIGIN_VALUE);
  const invalid = readingWithV1(); invalid.observation!.capture.monotonicNs = '2000';
  (invalid.v1!.observation!.state as unknown as Record<string, unknown>).window = {available: false, reason: 'not-observed'};
  deliver(invalid, 2); await vi.advanceTimersByTimeAsync(50); consumeOverlay(dashboard); consumeOverlay(overlayChannel);
  expect(log.mock.calls.filter(call => call[0] === 'LIVE_V1_REJECTED')).toEqual([['LIVE_V1_REJECTED', undefined, {count: 1}]]);
  const stripped = overlayProjection(overlayChannel);
  expect(stripped).toMatchObject({freshness: 'current', speed: '90.0'});
  for (const id of ['origin', 'distance-remaining', 'deadline']) expect(sectionOf(stripped, id)).toEqual({id, state: 'unavailable'});
  expect(sectionOf(stripped, 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'cargo.logs'});
  // A source change publishes an update without an observation; the v1 sections are then left out.
  await handlers.get('telemetry:select')!(trusted(), 'ats'); await vi.advanceTimersByTimeAsync(50);
  for (const id of ['origin', 'distance-remaining', 'deadline']) expect(sectionOf(overlayProjection(overlayChannel), id)).toBeUndefined();
});
it('expires v1 data 500 ms after its last new boundary while v0 renews, turning the overlay origin into a dash', async () => {
  const {dashboard, overlayChannel} = await v1Consumers();
  for (let step = 0; step <= 5; step++) {
    const update = readingWithV1(); update.observation!.capture.monotonicNs = String(1000 + step);
    update.observation!.windowReceivedMonotonicMs = step * 100;
    deliver(update, step + 1);
    if (step === 4) expect(sectionOf(overlayProjection(overlayChannel), 'origin')).toEqual(ORIGIN_VALUE);
    await drainOverlay(overlayChannel, 100); consumeOverlay(dashboard);
  }
  const projection = overlayProjection(overlayChannel);
  expect(projection).toMatchObject({freshness: 'current', speed: '90.0'});
  expect(sectionOf(projection, 'origin')).toEqual({id: 'origin', state: 'unavailable'});
  expect(sectionOf(projection, 'distance-remaining')).toEqual({id: 'distance-remaining', state: 'unavailable'});
  expect(sectionOf(projection, 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'cargo.logs'});
  expect(dashboard.port1.postMessage.mock.lastCall![0].update).toMatchObject({fresh: true, v1: {fresh: false, status: 'stale', reason: 'Main has no recent v1 SDK capture'}});
});
it('re-places the overlay when a late settings read brings another layout', async () => {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2');
  settingsView = {...settingsView, state: 'loading', writable: false}; await ready();
  expect(configurations[1]).toMatchObject({width: 1280, height: 110});
  ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); deliver(currentReading()); await vi.advanceTimersByTimeAsync(50); consumeOverlay(overlayChannel);
  expect(windows[1].setBounds.mock.calls).toEqual([[{x: -1600, y: 8, width: 1280, height: 110}]]);
  settingsView = {...settingsView, overlay: {layout: 'hud', sections: ALL_SECTIONS, placements: PLACEMENTS}, state: 'loaded', writable: true};
  settingsChanged!();
  expect(windows[1].setBounds).toHaveBeenLastCalledWith({x: -1904, y: 16, width: 320, height: 354});
  await vi.advanceTimersByTimeAsync(50);
  expect(overlayProjection(overlayChannel)).toMatchObject({layout: 'hud', freshness: 'current'});
  expect(windows[1].showInactive).toHaveBeenCalledOnce();
});
// ET-012b overlay edit mode (REG-016, REG-017). The snapshot's game client is 1920 x 1080 at (-1920, 0) and the screen
// conversion is the identity. The edit handlers may throw synchronously, as ipcMain.handle turns that into a rejection.
const edit = (channel: string, event: unknown, ...request: unknown[]) => new Promise<unknown>(resolve => resolve(handlers.get(channel)!(event, ...request as [unknown])));
let receipt = 0;
/** A current ETS2 reading with a new SDK capture and window report; `foreground` false while the dashboard is in front. */
function renew(foreground = false) {
  receipt++;
  const current = currentReading(), window = current.observation!.state.window;
  if (!window.available) throw new Error('Expected window');
  window.value.foreground = foreground; current.observation!.windowReceivedMonotonicMs = receipt * 100;
  current.observation!.capture = {...current.observation!.capture, monotonicNs: String(5_000_000_000 + receipt)};
  deliver(current, receipt);
}
const editPushes = () => contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => (call[1] as {overlayEdit: unknown}).overlayEdit);
/** The dashboard is focused and the game runs behind it; the overlay subscribed and holds a current reading. */
async function editableOverlay(view: Partial<typeof settingsView> = {}) {
  trayAvailable = true; vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); settingsView = {...settingsView, ...view}; receipt = 0; await ready();
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted()); const overlayChannel = channels[1];
  consumeOverlay(overlayChannel); renew(); await vi.advanceTimersByTimeAsync(50); consumeOverlay(overlayChannel);
  windows[0].focused = true;
  return overlayChannel;
}
function interactive(target = windows[1]) {
  return {ignoreMouse: target.setIgnoreMouseEvents.mock.lastCall?.[0], focusable: target.setFocusable.mock.lastCall?.[0],
    movable: target.setMovable.mock.lastCall?.[0] ?? false, skipTaskbar: target.setSkipTaskbar.mock.lastCall?.[0] ?? true};
}
const CLICK_THROUGH = {ignoreMouse: true, focusable: false, movable: false, skipTaskbar: true};
/** The overlay was hidden after it last became focusable and before it became click-through again. */
function hiddenBeforeClickThrough(target = windows[1]) {
  const restored = target.setIgnoreMouseEvents.mock.invocationCallOrder.at(-1)!;
  const enabled = target.setFocusable.mock.invocationCallOrder.filter((_order, index) => target.setFocusable.mock.calls[index][0] === true).at(-1)!;
  expect(target.hide.mock.invocationCallOrder.some(order => order > enabled && order < restored)).toBe(true);
}
const EDITABLE = {ignoreMouse: false, focusable: true, movable: true, skipTaskbar: true};

it('creates the overlay window at the saved scale of its layout and applies that zoom after every load', async () => {
  settingsView = {...settingsView, overlay: {layout: 'cluster', sections: ALL_SECTIONS, placements: {...PLACEMENTS, cluster: {x: 0, y: 1, scale: 1.5}}}}; await ready();
  // ET-012d: the cluster with every section at 1.5 is ceil(265 × 1.5 + 3) = 401 high (330 before).
  expect(configurations[1]).toMatchObject({width: 660, height: 401, webPreferences: {zoomFactor: 1.5, partition: 'ets2telemetry-overlay'}});
  expect(configurations[0].webPreferences).not.toHaveProperty('zoomFactor');
  overlayContents.emit('did-finish-load'); expect(overlayContents.setZoomFactor).toHaveBeenLastCalledWith(1.5);
  expect(contents.setZoomFactor).not.toHaveBeenCalled();
});
it('accepts overlay edit requests only from the trusted dashboard in their fixed shapes, with writable settings and before exit', async () => {
  await editableOverlay();
  const requests: [string, unknown[]][] = [['overlay-edit:begin', []], ['overlay-edit:set-scale', [1.5]], ['overlay-edit:reset', []], ['overlay-edit:finish', ['save']]];
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    for (const [channel, request] of requests) await expect(edit(channel, event, ...request)).rejects.toThrow('Untrusted');
  const invalid: [string, unknown[]][] = [['overlay-edit:begin', [1]], ['overlay-edit:begin', ['strip']], ['overlay-edit:set-scale', []], ['overlay-edit:set-scale', [0.49]],
    ['overlay-edit:set-scale', [2.01]], ['overlay-edit:set-scale', ['1.5']], ['overlay-edit:set-scale', [Number.NaN]], ['overlay-edit:set-scale', [Number.POSITIVE_INFINITY]],
    ['overlay-edit:set-scale', [1, 2]], ['overlay-edit:reset', [true]], ['overlay-edit:finish', []], ['overlay-edit:finish', ['done']], ['overlay-edit:finish', ['save', 'x']],
    ['overlay-edit:finish', [{outcome: 'save'}]]];
  for (const [channel, request] of invalid) await expect(edit(channel, trusted(), ...request)).rejects.toThrow('Invalid overlay edit request');
  for (const [channel, request] of requests.slice(1)) await expect(edit(channel, trusted(), ...request)).rejects.toThrow('Overlay edit mode is not active');
  settingsView = {...settingsView, state: 'newer-version', writable: false};
  await expect(edit('overlay-edit:begin', trusted())).rejects.toThrow('Overlay edit mode needs writable settings');
  settingsView = {...settingsView, state: 'loaded', writable: true};
  settingsIdle = deferred().promise; void handlers.get('app:exit')!(trusted());
  for (const [channel, request] of requests) await expect(edit(channel, trusted(), ...request)).rejects.toThrow('retired');
  expect(overlayWrite).not.toHaveBeenCalled(); expect(windows[1].setFocusable.mock.calls).toEqual([[false]]); expect(windows[1].setMovable).not.toHaveBeenCalled();
  expect(editPushes().every(state => (state as {active: boolean}).active === false)).toBe(true);
});
it('edits over a background game: interactive only while shown, the layout locked, and the draft saved only through the settings queue', async () => {
  const overlayChannel = await editableOverlay(), overlay = windows[1];
  expect(overlay.showInactive).not.toHaveBeenCalled();
  const begun = await edit('overlay-edit:begin', trusted());
  expect(begun).toEqual({active: true, layout: 'strip', scale: 1, placement: 'visible'});
  expect(editPushes().at(-1)).toEqual(begun); expect(handlers.get('app:get-state')!(trusted())).toMatchObject({overlayEdit: begun});
  expect(interactive()).toEqual(EDITABLE);
  expect(overlay.setBounds).toHaveBeenLastCalledWith({x: -1600, y: 8, width: 1280, height: 110});
  expect(overlay.showInactive).toHaveBeenCalledOnce(); expect(overlay.show).not.toHaveBeenCalled(); expect(overlay.focus).not.toHaveBeenCalled();
  expect(overlay.setFocusable.mock.invocationCallOrder.at(-1)).toBeLessThan(overlay.showInactive.mock.invocationCallOrder[0]);
  expect(overlay.showInactive.mock.invocationCallOrder[0]).toBeLessThan(overlay.setAlwaysOnTop.mock.invocationCallOrder.at(-1)!);
  // A second begin returns the same state; the projection marks the edit mode for the renderer.
  expect(await edit('overlay-edit:begin', trusted())).toEqual(begun);
  await vi.advanceTimersByTimeAsync(50); expect(overlayProjection(overlayChannel)).toMatchObject({editing: true, layout: 'strip'}); consumeOverlay(overlayChannel);
  await expect(saveOverlay('settings:set-overlay-layout', trusted(), 'card')).rejects.toThrow('The overlay layout cannot change while its position is edited');
  // The scale is rounded to two decimals; the strip at 1.23 is floor(1280 × 1.23) = 1574 wide. Its CSS width
  // floor(1574 / 1.23) = 1279 needs three rows for every section, so it is ceil(110 × 1.23 = 135.3) = 136 high.
  expect(await edit('overlay-edit:set-scale', trusted(), 1.234)).toEqual({active: true, layout: 'strip', scale: 1.23, placement: 'visible'});
  expect(overlayContents.setZoomFactor).toHaveBeenLastCalledWith(1.23); expect(contents.setZoomFactor).not.toHaveBeenCalled();
  expect(overlay.setBounds).toHaveBeenLastCalledWith({x: -1747, y: 8, width: 1574, height: 136});
  // A drag past the left edge snaps inside: x = 0; y = (500 − 8) / (1080 − 16 − 136) = 0.5302.
  overlay.emit('will-move'); overlay.setBounds.mockClear();
  renew(); expect(overlay.setBounds).not.toHaveBeenCalled();
  overlay.bounds = {x: -5000, y: 500, width: 1574, height: 136}; overlay.emit('moved');
  expect(overlay.setBounds.mock.calls).toEqual([[{x: -1904, y: 500, width: 1574, height: 136}]]);
  // Unit and section saves stay allowed while editing.
  overlayWrite.mockImplementationOnce(() => Promise.resolve(settingsView));
  await saveOverlay('settings:set-overlay-sections', trusted(), ALL_SECTIONS);
  const saved = deferred<typeof settingsView>(); overlayWrite.mockReturnValueOnce(saved.promise);
  const finishing = edit('overlay-edit:finish', trusted(), 'save');
  // Edit mode ended first: hidden, then click-through again, before the write completes; nothing is applied yet.
  expect(overlayWrite).toHaveBeenLastCalledWith('placement', ['strip', {x: 0, y: 0.5302, scale: 1.23}]);
  expect(interactive()).toEqual(CLICK_THROUGH);
  hiddenBeforeClickThrough();
  expect(editPushes().at(-1)).toEqual({active: false});
  const placements = {...PLACEMENTS, strip: {x: 0, y: 0.5302, scale: 1.23}};
  settingsView = {...settingsView, overlay: {...DEFAULT_OVERLAY, placements}, state: 'loaded'}; saved.resolve(settingsView);
  await expect(finishing).resolves.toEqual(settingsView);
  expect(overlayContents.setZoomFactor).toHaveBeenLastCalledWith(1.23);
  await vi.advanceTimersByTimeAsync(50); expect(overlayProjection(overlayChannel)).toMatchObject({editing: false}); consumeOverlay(overlayChannel);
  // Driving mode: the saved placement shows only with the game in front, still click-through.
  overlay.showInactive.mockClear(); renew(true);
  expect(overlay.showInactive).toHaveBeenCalledOnce(); expect(overlay.setBounds).toHaveBeenLastCalledWith({x: -1904, y: 500, width: 1574, height: 136});
  expect(interactive()).toEqual(CLICK_THROUGH);
});
it('keeps the previous placement when the edit save fails and reports the refusal in the settings view', async () => {
  await editableOverlay(); await edit('overlay-edit:begin', trusted()); await edit('overlay-edit:set-scale', trusted(), 1.5);
  overlayWrite.mockImplementation(() => {settingsView = {...settingsView, saveError: 'SETTINGS_WRITE_FAILED'}; return Promise.reject(new FakeSettingsError('SETTINGS_WRITE_FAILED'));});
  await expect(edit('overlay-edit:finish', trusted(), 'save')).rejects.toThrow('Settings could not be saved');
  expect(handlers.get('app:get-state')!(trusted())).toMatchObject({overlayEdit: {active: false}, settings: {overlay: DEFAULT_OVERLAY, saveError: 'SETTINGS_WRITE_FAILED'}});
  expect(overlayContents.setZoomFactor).toHaveBeenLastCalledWith(1); expect(interactive()).toEqual(CLICK_THROUGH);
});
it.each(['cancel', 'escape', 'dashboard-closed', 'dashboard-minimized', 'dashboard-reload', 'dashboard-crash', 'overlay-reload', 'overlay-crash', 'exit'])(
  'discards the draft without writing on %s', async reason => {
    await editableOverlay(); await edit('overlay-edit:begin', trusted()); await edit('overlay-edit:set-scale', trusted(), 1.5);
    expect(interactive()).toEqual(EDITABLE);
    if (reason === 'cancel') await expect(edit('overlay-edit:finish', trusted(), 'cancel')).resolves.toEqual(settingsView);
    else if (reason === 'escape') overlayContents.emit('before-input-event', {preventDefault: vi.fn()}, {type: 'keyDown', key: 'Escape'});
    else if (reason === 'dashboard-closed') closeDashboard();
    else if (reason === 'dashboard-minimized') {windows[0].minimized = true; windows[0].emit('minimize');}
    else if (reason === 'dashboard-reload') contents.emit('did-start-loading');
    else if (reason === 'dashboard-crash') contents.emit('render-process-gone', {}, {reason: 'crashed'});
    else if (reason === 'overlay-reload') overlayContents.emit('did-start-loading');
    else if (reason === 'overlay-crash') overlayContents.emit('render-process-gone', {}, {reason: 'crashed'});
    else app.emit('before-quit', {preventDefault: vi.fn()});
    await settle();
    expect(overlayWrite).not.toHaveBeenCalled(); expect(interactive()).toEqual(CLICK_THROUGH);
    hiddenBeforeClickThrough();
    expect(editPushes().at(-1)).toEqual({active: false});
    // The saved scale applies again.
    expect(overlayContents.setZoomFactor).toHaveBeenLastCalledWith(1);
  });
it('retires a reloading overlay before cancelling its edit, so the retired document is never shown for driving', async () => {
  await editableOverlay(); await edit('overlay-edit:begin', trusted());
  // The game comes to the front while editing: the edit overlay hides; driving would show it once edit mode ends.
  renew(true); expect(handlers.get('app:get-state')!(trusted())).toMatchObject({overlayEdit: {placement: 'not-foreground'}});
  windows[1].showInactive.mockClear();
  overlayContents.emit('did-start-loading');
  expect(windows[1].showInactive).not.toHaveBeenCalled(); expect(interactive()).toEqual(CLICK_THROUGH);
  expect(editPushes().at(-1)).toEqual({active: false}); expect(overlayWrite).not.toHaveBeenCalled();
});
it('returns to driving after the dashboard is minimized during an edit, so the overlay shows over the game', async () => {
  await editableOverlay(); await edit('overlay-edit:begin', trusted());
  windows[0].focused = false; windows[0].minimized = true; windows[0].emit('minimize');
  expect(editPushes().at(-1)).toEqual({active: false}); expect(overlayWrite).not.toHaveBeenCalled();
  windows[1].showInactive.mockClear(); renew(true);
  expect(windows[1].showInactive).toHaveBeenCalledOnce(); expect(interactive()).toEqual(CLICK_THROUGH);
  // A minimize while not editing changes nothing.
  const pushes = editPushes().length; windows[0].emit('minimize'); expect(editPushes()).toHaveLength(pushes);
});
it('prevents every key and the system menu on the overlay and saves with Enter only in edit mode', async () => {
  await editableOverlay();
  const key = (input: {type: string; key: string}) => {const event = {preventDefault: vi.fn()}; overlayContents.emit('before-input-event', event, input); return event.preventDefault;};
  for (const input of [{type: 'keyDown', key: 'Enter'}, {type: 'keyDown', key: 'Escape'}, {type: 'keyDown', key: 'a'}]) expect(key(input)).toHaveBeenCalledOnce();
  const menu = {preventDefault: vi.fn()}; windows[1].emit('system-context-menu', menu); expect(menu.preventDefault).toHaveBeenCalledOnce();
  expect(overlayWrite).not.toHaveBeenCalled(); expect(editPushes().every(state => (state as {active: boolean}).active === false)).toBe(true);
  await edit('overlay-edit:begin', trusted());
  for (const input of [{type: 'keyDown', key: 'a'}, {type: 'keyUp', key: 'Enter'}, {type: 'char', key: 'Enter'}]) expect(key(input)).toHaveBeenCalledOnce();
  expect(handlers.get('app:get-state')!(trusted())).toMatchObject({overlayEdit: {active: true}});
  overlayWrite.mockImplementation((_kind, value) => {
    const [layout, placement] = value as [string, {x: number; y: number; scale: number}];
    settingsView = {...settingsView, overlay: {...DEFAULT_OVERLAY, placements: {...PLACEMENTS, [layout]: placement}}, state: 'loaded'}; return Promise.resolve(settingsView);
  });
  expect(key({type: 'keyDown', key: 'Enter'})).toHaveBeenCalledOnce(); await settle();
  expect(overlayWrite.mock.calls).toEqual([['placement', ['strip', {x: 0.5, y: 0, scale: 1}]]]);
  expect(editPushes().at(-1)).toEqual({active: false}); expect(interactive()).toEqual(CLICK_THROUGH);
  // A repeated Enter after the save does nothing.
  key({type: 'keyDown', key: 'Enter'}); await settle(); expect(overlayWrite).toHaveBeenCalledOnce();
});
it('gates the edit overlay on the focus of either own window with a 150 ms grace for losses', async () => {
  const overlayChannel = await editableOverlay(), [dashboard, overlay] = windows;
  await edit('overlay-edit:begin', trusted()); expect(overlay.showInactive).toHaveBeenCalledOnce(); overlay.hide.mockClear();
  const placement = () => (handlers.get('app:get-state')!(trusted()) as {overlayEdit: {placement?: string}}).overlayEdit.placement;
  // A click from the dashboard onto the overlay: the dashboard blurs before the overlay gains focus.
  dashboard.focused = false; dashboard.emit('blur'); await drainOverlay(overlayChannel, 100); renew();
  overlay.focused = true; overlay.emit('focus'); await drainOverlay(overlayChannel, 100); renew();
  expect(placement()).toBe('visible'); expect(overlay.hide).not.toHaveBeenCalled();
  // Another application comes to the front: hidden 150 ms later, click-through again.
  overlay.focused = false; overlay.emit('blur'); await drainOverlay(overlayChannel, 100); renew();
  expect(placement()).toBe('visible');
  await drainOverlay(overlayChannel, 50);
  expect(placement()).toBe('not-foreground'); expect(overlay.hide).toHaveBeenCalled(); expect(interactive()).toEqual(CLICK_THROUGH);
  // Back to the dashboard: shown again at once.
  dashboard.focused = true; dashboard.emit('focus');
  expect(placement()).toBe('visible'); expect(overlay.showInactive).toHaveBeenCalledTimes(2); expect(interactive()).toEqual(EDITABLE);
  // The game itself in front hides the edit overlay whatever the own focus is.
  renew(true); expect(placement()).toBe('not-foreground'); expect(interactive()).toEqual(CLICK_THROUGH);
  await edit('overlay-edit:finish', trusted(), 'cancel'); expect(interactive()).toEqual(CLICK_THROUGH);
});
it('reports waiting for the game while no game window can be placed, and never shows the overlay then', async () => {
  trayAvailable = true; await ready(); windows[0].focused = true;
  ipc.emit('app:subscribe-state', trusted()); ipc.emit('overlay:subscribe', overlayTrusted());
  expect(await edit('overlay-edit:begin', trusted())).toEqual({active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'});
  expect(await edit('overlay-edit:set-scale', trusted(), 2)).toEqual({active: true, layout: 'strip', scale: 2, placement: 'waiting-for-game'});
  expect(await edit('overlay-edit:reset', trusted())).toEqual({active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'});
  expect(windows[1].showInactive).not.toHaveBeenCalled(); expect(windows[1].setFocusable.mock.calls).toEqual([[false]]);
  expect(windows[1].setMovable).not.toHaveBeenCalled();
  expect(editPushes()).toEqual([{active: false}, {active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'},
    {active: true, layout: 'strip', scale: 2, placement: 'waiting-for-game'}, {active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'}]);
});

// ET-015c (G4, G5, G6, G12): main accepts the recording status only from the current service, validates it, keeps it in
// AppState.health.recording and adds the committed losses of every service process. Expected values are written by hand.
const NO_LOSSES = {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0};
const recordingStatus = (state: string, losses: Partial<typeof NO_LOSSES> = {}, code: string | null = null) =>
  ({state, target: 'synthetic', code, losses: {...NO_LOSSES, ...losses}, trip: {phase: 'active', completeness: 'partial', untrackedJob: false}});
const report = (status: unknown, target = child) => target.emit('message', {type: 'recording', status});
const healthOf = () => (handlers.get('app:get-state')!(trusted()) as {health: {recording: unknown}}).health.recording;
const pushedRecordings = (target = contents) => target.send.mock.calls.filter(call => call[0] === 'app:state').map(call => (call[1] as {health: {recording: unknown}}).health.recording);
it('accepts a valid recording status before and after readiness and pushes it in the application state and to the tray presenter', async () => {
  const presented: unknown[] = [];
  vi.doMock('../../apps/desktop/src/tray-model', async importOriginal => {
    const original = await importOriginal<typeof import('../../apps/desktop/src/tray-model')>();
    return {...original, TrayPresenter: class extends original.TrayPresenter {
      update(input: Parameters<InstanceType<typeof original.TrayPresenter>['update']>[0], immediate?: boolean) {presented.push(input.health.recording); super.update(input, immediate);}
    }};
  });
  try {
    trayAvailable = true; await loadMain(); await settle();
    // A status reported before readiness stays through it.
    report({state: 'disabled'});
    child.emit('message', {type: 'ready'}); await settle();
    expect(healthOf()).toEqual({state: 'disabled'});
    ipc.emit('app:subscribe-state', trusted());
    report(recordingStatus('waiting')); report(recordingStatus('recording', {notConnected: 1}));
    expect(healthOf()).toEqual(recordingStatus('recording', {notConnected: 1}));
    expect(pushedRecordings()).toEqual([{state: 'disabled'}, recordingStatus('waiting'), recordingStatus('recording', {notConnected: 1})]);
    expect(presented.at(-1)).toEqual(recordingStatus('recording', {notConnected: 1}));
    expect(presented).toContainEqual({state: 'disabled'});
    // The same status again pushes nothing.
    report(recordingStatus('recording', {notConnected: 1}));
    expect(pushedRecordings()).toHaveLength(3);
    expect(log.mock.calls.map(call => call[0] as string).filter(name => /RECORDING_STATUS_REJECTED|SERVICE_INVALID_MESSAGE/.test(name))).toEqual([]);
    expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  } finally {vi.doUnmock('../../apps/desktop/src/tray-model');}
});
it('turns an invalid recording status into unknown with a counted, non-fatal RECORDING_STATUS_REJECTED log', async () => {
  await ready(); ipc.emit('app:subscribe-state', trusted());
  report(recordingStatus('recording'));
  const invalid: unknown[] = [{...recordingStatus('recording'), path: 'C:\\Users\\owner'}, {state: 'recorded'}, {...recordingStatus('recording'), losses: {...NO_LOSSES, lostEvents: -1}},
    {...recordingStatus('recording'), code: 'SQLITE_FULL'}, undefined];
  for (const status of invalid) report(status);
  // The message itself must be exactly {type, status}.
  child.emit('message', {type: 'recording', status: recordingStatus('recording'), detail: 'extra'});
  child.emit('message', {type: 'recording'});
  expect(healthOf()).toEqual({state: 'unknown'});
  expect(log.mock.calls.filter(call => call[0] === 'RECORDING_STATUS_REJECTED').map(call => call[2] as unknown)).toEqual([{count: 1}, {count: 2}, {count: 4}]);
  expect(pushedRecordings()).toEqual([{state: 'unknown'}, recordingStatus('recording'), {state: 'unknown'}]);
  expect(log).not.toHaveBeenCalledWith('SERVICE_INVALID_MESSAGE', undefined);
  expect([child.postMessage.mock.calls.some(call => call[0].type === 'stop'), child.kill.mock.calls.length, app.exit.mock.calls.length]).toEqual([false, 0, 0]);
  // A valid report afterwards is accepted again.
  report(recordingStatus('paused'));
  expect(healthOf()).toEqual(recordingStatus('paused'));
  // An unknown message type stays fatal.
  child.emit('message', {type: 'recording-v2'});
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
});
it('resets the recording status to unknown when the service fails or exits and ignores reports of a retired service', async () => {
  trayAvailable = true; await ready(); ipc.emit('app:subscribe-state', trusted());
  report(recordingStatus('recording'));
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  expect(healthOf()).toEqual({state: 'unknown'});
  // The failing service is terminated; a report it still sends is ignored.
  report(recordingStatus('recording'));
  expect(healthOf()).toEqual({state: 'unknown'});
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1];
  report(recordingStatus('opening'), replacement);
  expect(healthOf()).toEqual(recordingStatus('opening'));
  // The exited service's late report changes nothing; the restart and readiness keep the new service's status.
  report(recordingStatus('stopped', {}, 'PERMISSION_DENIED'));
  replacement.emit('message', {type: 'ready'}); await settle();
  expect(healthOf()).toEqual(recordingStatus('opening'));
  // An exit without a failure report resets it too: the failed service, then the restart, each push unknown.
  const before = pushedRecordings().length;
  replacement.emit('exit', 1);
  expect(healthOf()).toEqual({state: 'unknown'});
  expect(pushedRecordings().slice(before - 1)).toEqual([recordingStatus('opening'), {state: 'unknown'}, {state: 'unknown'}]);
  expect(log.mock.calls.filter(call => call[0] === 'RECORDING_STATUS_REJECTED')).toEqual([]);
});
it('adds the committed losses of every service process since the application started', async () => {
  await ready();
  // The latest report of one service replaces its earlier one; it is not added to it.
  report(recordingStatus('recording', {lostEvents: 2, notConnected: 1}));
  report(recordingStatus('recording', {lostEvents: 3, notConnected: 2, droppedSamples: 1}));
  expect(healthOf()).toEqual(recordingStatus('recording', {lostEvents: 3, notConnected: 2, droppedSamples: 1}));
  // A failure report and the exit that follows add the failed service's losses once.
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'}); child.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(250); children[1].emit('message', {type: 'ready'}); await settle();
  report(recordingStatus('recording', {notConnected: 1, restoreLoss: 1}), children[1]);
  expect(healthOf()).toEqual(recordingStatus('recording', {lostEvents: 3, notConnected: 3, droppedSamples: 1, restoreLoss: 1}));
  // A disabled report carries no losses; the next process's report starts from all the earlier totals.
  children[1].emit('exit', 1); await vi.advanceTimersByTimeAsync(1000);
  report({state: 'disabled'}, children[2]);
  expect(healthOf()).toEqual({state: 'disabled'});
  report(recordingStatus('waiting'), children[2]);
  expect(healthOf()).toEqual(recordingStatus('waiting', {lostEvents: 3, notConnected: 3, droppedSamples: 1, restoreLoss: 1}));
});
it.each(['reload', 'renderer-crash', 'reopen'] as const)('gives a dashboard subscribing after a %s the current recording status', async reason => {
  trayAvailable = true; await ready(); ipc.emit('app:subscribe-state', trusted());
  report(recordingStatus('interrupted', {notConnected: 1}));
  let target = contents;
  if (reason === 'reload') contents.emit('did-start-loading');
  else if (reason === 'renderer-crash') contents.emit('render-process-gone', {}, {reason: 'crashed'});
  else {closeDashboard(); trays[0].emit('click'); target = extraContents[0];}
  const sender = {sender: target, senderFrame: target.mainFrame}, before = target.send.mock.calls.length;
  ipc.emit('app:subscribe-state', sender);
  expect(target.send.mock.calls.length).toBe(before + 1);
  expect(pushedRecordings(target).at(-1)).toEqual(recordingStatus('interrupted', {notConnected: 1}));
  expect((handlers.get('app:get-state')!(sender) as {health: {recording: unknown}}).health.recording).toEqual(recordingStatus('interrupted', {notConnected: 1}));
});
it('keeps the recording status unchanged when the upstream live channel closes and recovers', async () => {
  await ready(); ipc.emit('app:subscribe-state', trusted());
  report(recordingStatus('recording'));
  const pushes = pushedRecordings().length;
  channels[0].port1.close();
  expect(log).toHaveBeenCalledWith('MAIN_CHANNEL_CLOSED', 'Active service live subscription closed');
  await vi.advanceTimersByTimeAsync(250);
  expect(upstreamRequests()).toBe(2);
  expect([healthOf(), pushedRecordings().length]).toEqual([recordingStatus('recording'), pushes]);
});
// ET-015c PR-4: the opt-in smoke timeline records every recording status change as flat facts; default logs never do.
const recordingRows = () => log.mock.calls.filter(call => call[0] === 'RECORDING_STATUS').map(call => call[2] as unknown);
it('records each recording status change in the opt-in diagnostic timeline only', async () => {
  vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', 'C:\\isolated\\diagnostics');
  await ready();
  report(recordingStatus('waiting')); report(recordingStatus('waiting'));
  report({...recordingStatus('retrying', {lostEvents: 2}, 'DISK_FULL'), trip: null});
  child.emit('exit', 1);
  expect(recordingRows()).toEqual([
    {state: 'waiting', target: 'synthetic', code: null, ...NO_LOSSES, tripPhase: 'active', tripCompleteness: 'partial', untrackedJob: false},
    {state: 'retrying', target: 'synthetic', code: 'DISK_FULL', ...NO_LOSSES, lostEvents: 2, tripPhase: null, tripCompleteness: null, untrackedJob: null},
    {state: 'unknown'}]);
});
it('keeps recording status changes out of default logs', async () => {
  await ready();
  report(recordingStatus('recording')); child.emit('exit', 1);
  expect(healthOf()).toEqual({state: 'unknown'});
  expect(recordingRows()).toEqual([]);
});

// ET-016 PR-3 (J4, J10, J11): five fixed journal channels from the trusted dashboard main frame only, routed to the current
// ready service on its parent port; main checks every reply strictly. Expected values are written by hand.
const JOURNAL_CHANNELS = ['journal:list-trips', 'journal:get-trip', 'journal:list-events', 'journal:list-intervals', 'journal:list-samples'] as const;
const journalCall = (channel: typeof JOURNAL_CHANNELS[number], event: unknown, ...request: unknown[]) =>
  Promise.resolve().then(() => handlers.get(channel)!(event, ...request as [unknown]));
const journalSent = (target = child) => target.postMessage.mock.calls.map(call => call[0] as Record<string, unknown>).filter(message => message.type === 'journal');
const journalReply = (id: number, result: unknown, target = child) => target.emit('message', {type: 'journal', id, result});
it('rejects journal requests from untrusted senders, frames and the overlay, and every invalid shape, before they reach the service', async () => {
  trayAvailable = true; await ready();
  const valid: Record<typeof JOURNAL_CHANNELS[number], unknown[]> = {'journal:list-trips': [{}], 'journal:get-trip': [TRIP], 'journal:list-events': [TRIP, null],
    'journal:list-intervals': [TRIP, null], 'journal:list-samples': [TRIP, null]};
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    for (const channel of JOURNAL_CHANNELS) await expect(journalCall(channel, event, ...valid[channel])).rejects.toThrow('Untrusted journal request');
  const invalid: [typeof JOURNAL_CHANNELS[number], unknown[]][] = [
    ['journal:list-trips', []], ['journal:list-trips', [{}, {}]], ['journal:list-trips', [{limit: 51}]], ['journal:list-trips', [{game: 'ets'}]], ['journal:list-trips', [undefined]],
    ['journal:get-trip', []], ['journal:get-trip', [TRIP, null]], ['journal:get-trip', [TRIP.toUpperCase()]], ['journal:get-trip', ['C:\\Users\\owner']],
    ['journal:list-events', [TRIP]], ['journal:list-events', [TRIP, null, 500]], ['journal:list-events', [TRIP, '18446744073709551615']],
    ['journal:list-intervals', [TRIP, '0']], ['journal:list-samples', [TRIP, undefined]], ['journal:list-samples', ['not-a-uuid', null]]];
  for (const [channel, request] of invalid) await expect(journalCall(channel, trusted(), ...request)).rejects.toThrow('Invalid journal request');
  expect(journalSent()).toEqual([]);
  expect(overlayContents.send).not.toHaveBeenCalled();
});
it('routes each journal read to the ready service with the page size main fixes, and answers with its checked reply', async () => {
  await ready();
  const list = journalCall('journal:list-trips', trusted(), {game: 'ets2'});
  await settle();
  expect(journalSent()).toEqual([{type: 'journal', id: 1, query: {kind: 'trips', query: {game: 'ets2'}}}]);
  journalReply(1, {ok: true, value: TRIP_PAGE});
  await expect(list).resolves.toEqual({ok: true, value: TRIP_PAGE});
  const pages = [journalCall('journal:list-events', trusted(), TRIP, null), journalCall('journal:list-intervals', trusted(), TRIP, '7'),
    journalCall('journal:list-samples', trusted(), TRIP, '310'), journalCall('journal:get-trip', trusted(), TRIP)];
  for (let id = 2; id <= 5; id++) {
    await settle();
    journalReply(id, {ok: false, code: id === 5 ? 'NOT_FOUND' : 'DATABASE_OPENING'});
  }
  await expect(Promise.all(pages)).resolves.toEqual([{ok: false, code: 'DATABASE_OPENING'}, {ok: false, code: 'DATABASE_OPENING'}, {ok: false, code: 'DATABASE_OPENING'},
    {ok: false, code: 'NOT_FOUND'}]);
  expect(journalSent().slice(1)).toEqual([
    {type: 'journal', id: 2, query: {kind: 'events', tripUuid: TRIP, page: {limit: 100}}},
    {type: 'journal', id: 3, query: {kind: 'intervals', tripUuid: TRIP, page: {cursor: '7', limit: 100}}},
    {type: 'journal', id: 4, query: {kind: 'samples', tripUuid: TRIP, page: {cursor: '310', limit: 300}}},
    {type: 'journal', id: 5, query: {kind: 'trip', tripUuid: TRIP}}]);
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
});
it('never forwards an invalid service page: the call answers FAILED, the reply is logged as rejected, and the service keeps running', async () => {
  await ready();
  const call = journalCall('journal:list-trips', trusted(), {});
  await settle();
  journalReply(1, {ok: true, value: changed(TRIP_PAGE, page => { page.trips = Array<typeof LIST_ITEM>(51).fill(LIST_ITEM); })});
  await expect(call).resolves.toEqual({ok: false, code: 'FAILED'});
  const detail = journalCall('journal:get-trip', trusted(), TRIP);
  await settle();
  journalReply(2, {ok: true, value: changed(DETAIL, value => { (value.trip as Record<string, unknown>).processId = 4242; })});
  await expect(detail).resolves.toEqual({ok: false, code: 'FAILED'});
  expect(log.mock.calls.filter(entry => entry[0] === 'JOURNAL_REPLY_REJECTED').map(entry => entry[2] as unknown)).toEqual([{kind: 'trips', count: 1}, {kind: 'trip', count: 2}]);
  expect([child.postMessage.mock.calls.some(entry => (entry[0] as {type: string}).type === 'stop'), child.kill.mock.calls.length, app.exit.mock.calls.length]).toEqual([false, 0, 0]);
  // An unknown service message type stays fatal beside the journal reply type.
  child.emit('message', {type: 'journal-export'});
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
});
it('ignores a journal message of a service that is not ready yet, without failing, and refuses calls before the dashboard exists', async () => {
  await loadMain(); await settle();
  // No dashboard exists before the first readiness, so no sender is trusted.
  await expect(journalCall('journal:list-trips', trusted(), {})).rejects.toThrow('Untrusted journal request');
  journalReply(1, {ok: true, value: TRIP_PAGE});
  expect(log).toHaveBeenCalledWith('JOURNAL_REPLY_IGNORED', undefined, {count: 1});
  child.emit('message', {type: 'ready'}); await settle();
  expect(journalSent()).toEqual([]);
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  expect(app.exit).not.toHaveBeenCalled();
});
it('accepts journal replies only from the current service and answers pending reads SERVICE_UNAVAILABLE when it fails, exits or the application exits', async () => {
  trayAvailable = true; await ready();
  const pending = journalCall('journal:get-trip', trusted(), TRIP), queued = journalCall('journal:list-trips', trusted(), {});
  await settle();
  child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  await expect(Promise.all([pending, queued])).resolves.toEqual([{ok: false, code: 'SERVICE_UNAVAILABLE'}, {ok: false, code: 'SERVICE_UNAVAILABLE'}]);
  // The failing service is terminated; its late reply is ignored and new calls are refused until a service is ready.
  journalReply(1, {ok: true, value: DETAIL});
  await expect(journalCall('journal:list-trips', trusted(), {})).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1];
  replacement.emit('message', {type: 'ready'}); await settle();
  const next = journalCall('journal:get-trip', trusted(), TRIP);
  await settle();
  expect(journalSent(replacement)).toEqual([{type: 'journal', id: 2, query: {kind: 'trip', tripUuid: TRIP}}]);
  // A reply of the exited service, even with the id in flight, never answers the replacement's request.
  journalReply(2, {ok: true, value: DETAIL});
  journalReply(2, {ok: true, value: DETAIL}, replacement);
  await expect(next).resolves.toEqual({ok: true, value: DETAIL});
  // An unexpected exit and an application exit both answer the request in flight.
  const lost = journalCall('journal:list-trips', trusted(), {});
  await settle();
  replacement.emit('exit', 1);
  await expect(lost).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  await vi.advanceTimersByTimeAsync(1000); children[2].emit('message', {type: 'ready'}); await settle();
  const exiting = journalCall('journal:list-trips', trusted(), {});
  await settle();
  expect(journalSent(children[2])).toHaveLength(1);
  trayMenuItem('Exit ETS2Telemetry').click!();
  await expect(exiting).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  await expect(journalCall('journal:list-trips', trusted(), {})).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
});
it('never makes a service ready, selected or the journal\'s service when its failure arrives while its readiness awaits the broker', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); trayAvailable = true; await ready();
  child.emit('exit', 1); await vi.advanceTimersByTimeAsync(250);
  const replacement = children[1], complete = pendingVerification();
  replacement.emit('message', {type: 'ready'}); await settle();
  // The failure report arrives while the replacement's readiness still awaits its broker verification.
  replacement.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  complete(); await settle();
  expect(replacement.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select'}));
  expect(handlers.get('scaffold:status')!(trusted())).toBeNull();
  await expect(journalCall('journal:list-trips', trusted(), {})).resolves.toEqual({ok: false, code: 'SERVICE_UNAVAILABLE'});
  expect(journalSent(replacement)).toEqual([]);
});
it.each(['failure report', 'unexpected exit'] as const)('creates the dashboard and overlay showing restart exhaustion when the first service ends by its %s before its readiness completed', async ending => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2'); trayAvailable = true;
  await loadMain(); await settle();
  const complete = pendingVerification();
  // The first readiness is accepted (later failures are recovered) but still awaits its broker verification.
  child.emit('message', {type: 'ready'}); await settle();
  if (ending === 'failure report') child.emit('message', {type: 'failed', code: 'STORAGE_WORKER_EXIT'});
  child.emit('exit', 1);
  await vi.advanceTimersByTimeAsync(250); children[1].emit('exit', 1);
  await vi.advanceTimersByTimeAsync(1000); children[2].emit('exit', 1);
  expect(windows).toHaveLength(2); expect(loadFile).toHaveBeenCalledTimes(2);
  expect((handlers.get('app:get-state')!(trusted()) as {health: unknown}).health).toEqual({service: 'failed', storage: ending === 'failure report' ? 'failed' : 'pending', recording: {state: 'unknown'}, lastError: 'SERVICE_RESTART_EXHAUSTED'});
  // A second launch now focuses that dashboard instead of being ignored as starting.
  app.emit('second-instance');
  expect(log).toHaveBeenCalledWith('SECOND_INSTANCE', undefined, {action: 'focused'});
  // The retired readiness completing later creates nothing more and selects nothing.
  complete(); await settle();
  expect(windows).toHaveLength(2);
  expect(child.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({type: 'select'}));
  expect(app.exit).not.toHaveBeenCalled();
});
it('answers TIMEOUT when the service does not reply within 15 s and sends the next queued read', async () => {
  await ready();
  const slow = journalCall('journal:list-trips', trusted(), {}), next = journalCall('journal:get-trip', trusted(), TRIP);
  await settle();
  expect(journalSent()).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(slow).resolves.toEqual({ok: false, code: 'TIMEOUT'});
  expect(journalSent().at(-1)).toEqual({type: 'journal', id: 2, query: {kind: 'trip', tripUuid: TRIP}});
  journalReply(1, {ok: true, value: TRIP_PAGE});
  journalReply(2, {ok: true, value: DETAIL});
  await expect(next).resolves.toEqual({ok: true, value: DETAIL});
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
});

// ET-016 PR-5 (J10, J16): the sixth journal channel exports one trip through main's Save dialog, from the trusted
// dashboard main frame only. Its reads go through the same broker; the dialog belongs to the dashboard window. Expected
// values are written by hand from J16; these cases never reach a file (cancel, refusal and exit happen before any write).
const exportCall = (event: unknown, ...request: unknown[]) => Promise.resolve().then(() => handlers.get('journal:export-trip')!(event, ...request as [unknown]));
const DATABASE_INFO = {database: {purpose: 'synthetic', schemaVersion: 2}, databaseUuid: 'f0000000-0000-4000-8000-000000000001'};
/** Answers the export's detail and database reads in order. */
async function answerExportReads(firstId = 1) {
  await settle();
  expect(journalSent().at(-1)).toEqual({type: 'journal', id: firstId, query: {kind: 'trip', tripUuid: TRIP}});
  journalReply(firstId, {ok: true, value: DETAIL}); await settle(); await settle();
  expect(journalSent().at(-1)).toEqual({type: 'journal', id: firstId + 1, query: {kind: 'database'}});
  journalReply(firstId + 1, {ok: true, value: DATABASE_INFO}); await settle(); await settle();
}
it('rejects trip exports from untrusted senders, frames and the overlay, and every invalid shape, before any read or dialog', async () => {
  trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    await expect(exportCall(event, TRIP)).rejects.toThrow('Untrusted journal request');
  for (const request of [[], [TRIP, null], [TRIP.toUpperCase()], ['C:\\Users\\owner\\trip.json'], [{tripUuid: TRIP}]])
    await expect(exportCall(trusted(), ...request)).rejects.toThrow('Invalid journal request');
  expect(journalSent()).toEqual([]);
  expect(showSaveDialog).not.toHaveBeenCalled();
});
it('reads the detail, offers the default name in Documents in the Save dialog of the dashboard, and writes nothing when it is cancelled', async () => {
  await ready();
  let answer!: (value: {canceled: boolean; filePath?: string}) => void;
  showSaveDialog.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const running = exportCall(trusted(), TRIP);
  await answerExportReads();
  expect(showSaveDialog).toHaveBeenCalledExactlyOnceWith(windows[0], {defaultPath: 'C:\\isolated\\ets2telemetry-trip-ets2-20261011-0000-7a000000.json',
    filters: [{name: 'JSON', extensions: ['json']}]});
  // One export at a time (J16).
  await expect(exportCall(trusted(), TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_IN_PROGRESS'});
  answer({canceled: true, filePath: ''});
  await expect(running).resolves.toEqual({ok: true, value: {outcome: 'cancelled'}});
  expect(log.mock.calls.filter(entry => String(entry[0]).startsWith('JOURNAL_EXPORT_')).map(entry => [entry[0], entry[2] ?? null]))
    .toEqual([['JOURNAL_EXPORT_FAILED', {code: 'EXPORT_IN_PROGRESS'}], ['JOURNAL_EXPORT_CANCELLED', null]]);
  expect(journalSent()).toHaveLength(2);
});
it('refuses a target in the data directory of LOCALAPPDATA, in any case, before writing', async () => {
  vi.stubEnv('LOCALAPPDATA', 'C:\\isolated-local'); await ready();
  showSaveDialog.mockImplementationOnce(() => Promise.resolve({canceled: false, filePath: 'C:\\ISOLATED-LOCAL\\ets2telemetry\\data\\trip.json'}));
  const running = exportCall(trusted(), TRIP);
  await answerExportReads();
  await expect(running).resolves.toEqual({ok: false, code: 'EXPORT_TARGET_REFUSED'});
  expect(journalSent()).toHaveLength(2);
});
it('answers a running export EXPORT_INTERRUPTED when the application exits, and refuses exports afterwards', async () => {
  trayAvailable = true; await ready();
  // A read in flight: the exit retires the broker, and the export ends as interrupted rather than with the read's code.
  const reading = exportCall(trusted(), TRIP);
  await settle();
  expect(journalSent()).toHaveLength(1);
  trayMenuItem('Exit ETS2Telemetry').click!();
  await expect(reading).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
  await expect(exportCall(trusted(), TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
  expect(showSaveDialog).not.toHaveBeenCalled();
});
it('ends an export whose dialog is open at the exit as interrupted, without a write', async () => {
  trayAvailable = true; await ready();
  let answer!: (value: {canceled: boolean; filePath?: string}) => void;
  showSaveDialog.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const running = exportCall(trusted(), TRIP);
  await answerExportReads();
  trayMenuItem('Exit ETS2Telemetry').click!();
  answer({canceled: false, filePath: 'C:\\Users\\owner\\Documents\\trip.json'});
  await expect(running).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
  expect(journalSent()).toHaveLength(2);
});
// PR-5 review round 1, finding 3: a fatal stop, which is no exit request, also stops a running export before any file.
it('ends an export whose dialog is open at a fatal stop as interrupted, without a write', async () => {
  await ready();
  let answer!: (value: {canceled: boolean; filePath?: string}) => void;
  showSaveDialog.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const running = exportCall(trusted(), TRIP);
  await answerExportReads();
  // An unknown service message type is fatal (SERVICE_INVALID_MESSAGE).
  child.emit('message', {type: 'journal-export'});
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
  answer({canceled: false, filePath: 'C:\\Users\\owner\\Documents\\trip.json'});
  await expect(running).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
  await expect(exportCall(trusted(), TRIP)).resolves.toEqual({ok: false, code: 'EXPORT_INTERRUPTED'});
  expect(journalSent()).toHaveLength(2);
});
// ET-017 PR-4 (P12, P13, P16): plugin setup in main. A fake orchestrator stands in for plugin-setup.ts, whose own tests
// cover discovery, installs and timing; these cases cover main's part: the five fixed-shape channels from the trusted
// dashboard main frame only, the folder dialog parented to the dashboard, main-owned shell calls, the AppState.plugins
// push, the exit wiring and that no reply carries a path. Expected values are written by hand from P16.
const PLUGIN_CHANNEL_NAMES = ['plugin:retry', 'plugin:choose-folder', 'plugin:set-excluded', 'plugin:show-file', 'plugin:open-folder'] as const;
type PluginChannel = typeof PLUGIN_CHANNEL_NAMES[number];
const BUNDLED_FILE = 'C:\\isolated\\resources\\telemetry-plugin\\ets2telemetry-plugin.dll';
const PLUGINS_FOLDER = 'C:\\Games\\Euro Truck Simulator 2\\bin\\win_x64\\plugins';
const PLUGIN_VIEW = {mode: 'test-root', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
  ets2: {excluded: false, discovery: 'found', manualFolder: 'none', targets: [{id: 'ets2:steam:0', source: 'steam', ordinal: 0, state: 'installed', reason: null,
    installed: {version: '0.2.0', sha256Prefix: '0123456789ab'}, lastFailure: null}], unlistedFolders: 0},
  ats: {excluded: false, discovery: 'not-found', manualFolder: 'none', targets: [], unlistedFolders: 0}}};
interface FakePluginSetup {
  mode: string; view: () => unknown; changed: () => void; start: ReturnType<typeof vi.fn>; abort: ReturnType<typeof vi.fn>; idle: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>; setExcluded: ReturnType<typeof vi.fn>; chooseFolder: ReturnType<typeof vi.fn>; bundledFile: ReturnType<typeof vi.fn>;
  folderToOpen: ReturnType<typeof vi.fn>; current: unknown; suspend: ReturnType<typeof vi.fn>; resume: ReturnType<typeof vi.fn>; targetIdFor: ReturnType<typeof vi.fn>;
}
let pluginSetup: FakePluginSetup;
let pluginOptions: {decision: unknown; ports: unknown} | undefined;
/** Replaces the orchestrator with a fake in `mode` before main loads. */
function mockPluginSetup(mode = 'test-root') {
  class PluginSetupError extends Error {}
  vi.doMock('../../apps/desktop/src/plugin-setup/plugin-setup', () => ({
    PluginSetupError,
    productionPluginSetupPorts: () => ({}),
    PluginSetup: class {
      constructor(options: {decision: unknown; ports: unknown; changed: () => void}) {
        pluginOptions = options;
        const fake: FakePluginSetup = pluginSetup = {mode, current: PLUGIN_VIEW, changed: options.changed, view: () => fake.current,
          start: vi.fn(), abort: vi.fn(), idle: vi.fn(() => undefined), retry: vi.fn(() => Promise.resolve(fake.current)),
          setExcluded: vi.fn(() => Promise.resolve(fake.current)), chooseFolder: vi.fn(() => Promise.resolve({outcome: 'chosen'})),
          bundledFile: vi.fn(() => Promise.resolve(BUNDLED_FILE)), folderToOpen: vi.fn(() => Promise.resolve(PLUGINS_FOLDER)),
          suspend: vi.fn(() => Promise.resolve()), resume: vi.fn(), targetIdFor: vi.fn(() => 'ets2:steam:0')};
        return fake;
      }
    }
  }));
}
const pluginCall = (channel: PluginChannel, event: unknown, ...request: unknown[]) =>
  new Promise<unknown>(resolve => resolve(handlers.get(channel)!(event, ...request as [unknown])));
const pluginCalls = () => (['start', 'retry', 'setExcluded', 'chooseFolder', 'bundledFile', 'folderToOpen'] as const).map(name => pluginSetup[name].mock.calls.length);
const VALID_PLUGIN_REQUESTS: Record<PluginChannel, unknown[]> = {
  'plugin:retry': [], 'plugin:choose-folder': ['ets2'], 'plugin:set-excluded': ['ats', true], 'plugin:show-file': [], 'plugin:open-folder': ['ets2:steam:0']
};
it('uses the real mode gate: these unit cases run disabled and start nothing', async () => {
  await ready();
  expect((handlers.get('app:get-state')!(trusted()) as {plugins: unknown}).plugins).toEqual(PLUGINS_DISABLED);
  expect(log).toHaveBeenCalledWith('PLUGIN_SETUP_MODE', undefined, {mode: 'disabled', reason: 'isolated-launch'});
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ets2')).resolves.toEqual({outcome: 'refused', code: 'SETUP_DISABLED'});
  await expect(pluginCall('plugin:retry', trusted())).resolves.toEqual(PLUGINS_DISABLED);
  expect(showOpenDialog).not.toHaveBeenCalled();
});
it('starts plugin setup once Electron is ready and the tray exists, without waiting for it', async () => {
  mockPluginSetup(); trayAvailable = true;
  await loadMain(); await settle();
  expect(pluginSetup.start).toHaveBeenCalledOnce();
  expect(pluginOptions).toMatchObject({decision: {mode: 'disabled', reason: 'isolated-launch'}, ports: undefined});
  expect(windows).toHaveLength(0);
  child.emit('message', {type: 'ready'}); await settle();
  expect(windows).toHaveLength(2);
});
it('rejects plugin requests from untrusted senders, frames and the overlay, and every invalid shape, before any dialog or change', async () => {
  mockPluginSetup(); trayAvailable = true; await ready();
  const before = pluginCalls();
  for (const channel of PLUGIN_CHANNEL_NAMES) {
    for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()]) {
      await expect(pluginCall(channel, event, ...VALID_PLUGIN_REQUESTS[channel]), channel).rejects.toThrow('Untrusted plugin setup request');
    }
  }
  const invalid: [PluginChannel, unknown[]][] = [
    ['plugin:retry', ['ets2']], ['plugin:retry', [undefined]],
    ['plugin:choose-folder', []], ['plugin:choose-folder', ['ETS2']], ['plugin:choose-folder', ['synthetic']], ['plugin:choose-folder', ['C:\\Games\\ETS2']],
    ['plugin:choose-folder', ['ets2', 'C:\\Games\\ETS2']], ['plugin:choose-folder', [{game: 'ets2'}]],
    ['plugin:set-excluded', ['ets2']], ['plugin:set-excluded', ['ets2', 'true']], ['plugin:set-excluded', ['ets2', 1]], ['plugin:set-excluded', ['game', true]],
    ['plugin:set-excluded', ['ets2', true, 'C:\\Games']],
    ['plugin:show-file', ['C:\\Windows\\System32']], ['plugin:show-file', [undefined]],
    ['plugin:open-folder', []], ['plugin:open-folder', ['ets2:steam:4']], ['plugin:open-folder', ['ets2:Steam:0']], ['plugin:open-folder', ['ets2:adopted:0']],
    ['plugin:open-folder', ['ets2:steam:0 ']], ['plugin:open-folder', ['C:\\Games\\ETS2']], ['plugin:open-folder', ['ets2:steam:0', 'ats:steam:0']], ['plugin:open-folder', [0]]
  ];
  for (const [channel, request] of invalid) {
    await expect(pluginCall(channel, trusted(), ...request), `${channel} ${JSON.stringify(request)}`).rejects.toThrow('Invalid plugin setup request');
  }
  expect(pluginCalls()).toEqual(before);
  expect(showOpenDialog).not.toHaveBeenCalled(); expect(shell.showItemInFolder).not.toHaveBeenCalled(); expect(shell.openPath).not.toHaveBeenCalled();
});
it('opens the folder dialog parented to the dashboard; a cancelled choice writes nothing, and a chosen one is answered without its path', async () => {
  mockPluginSetup(); await ready();
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ats')).resolves.toEqual({outcome: 'cancelled'});
  expect(showOpenDialog).toHaveBeenCalledExactlyOnceWith(windows[0], {properties: ['openDirectory']});
  expect(pluginSetup.chooseFolder).not.toHaveBeenCalled();
  showOpenDialog.mockResolvedValueOnce({canceled: false, filePaths: []});
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ats')).resolves.toEqual({outcome: 'cancelled'});
  expect(pluginSetup.chooseFolder).not.toHaveBeenCalled();
  showOpenDialog.mockResolvedValueOnce({canceled: false, filePaths: ['D:\\Games\\American Truck Simulator\\bin']});
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ats')).resolves.toEqual({outcome: 'chosen'});
  expect(pluginSetup.chooseFolder).toHaveBeenCalledExactlyOnceWith('ats', 'D:\\Games\\American Truck Simulator\\bin');
  // A refusal of the folder is answered with its fixed code only.
  pluginSetup.chooseFolder.mockResolvedValueOnce({outcome: 'refused', code: 'FOLDER_WRONG_GAME'});
  showOpenDialog.mockResolvedValueOnce({canceled: false, filePaths: ['D:\\Games\\Euro Truck Simulator 2']});
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ats')).resolves.toEqual({outcome: 'refused', code: 'FOLDER_WRONG_GAME'});
  // A failure inside plugin setup reaches the dashboard as a fixed message, never its own text.
  pluginSetup.chooseFolder.mockRejectedValueOnce(new Error('EPERM: operation not permitted, open D:\\Games\\secret'));
  showOpenDialog.mockResolvedValueOnce({canceled: false, filePaths: ['D:\\Games\\Euro Truck Simulator 2']});
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ets2')).rejects.toThrow(/^Plugin setup request failed$/);
});
it('allows one folder dialog at a time and writes nothing when the exit begins while it is open', async () => {
  mockPluginSetup(); trayAvailable = true; await ready();
  let answer!: (value: {canceled: boolean; filePaths: string[]}) => void;
  showOpenDialog.mockImplementationOnce(() => new Promise(resolve => {answer = resolve;}));
  const open = pluginCall('plugin:choose-folder', trusted(), 'ets2');
  await settle();
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ats')).resolves.toEqual({outcome: 'refused', code: 'BUSY'});
  expect(showOpenDialog).toHaveBeenCalledOnce();
  void handlers.get('app:exit')!(trusted());
  answer({canceled: false, filePaths: ['D:\\Games\\Euro Truck Simulator 2']});
  await expect(open).resolves.toEqual({outcome: 'cancelled'});
  expect(pluginSetup.chooseFolder).not.toHaveBeenCalled();
});
it('refuses the folder dialog without opening it in the disabled mode', async () => {
  mockPluginSetup('disabled'); await ready();
  await expect(pluginCall('plugin:choose-folder', trusted(), 'ets2')).resolves.toEqual({outcome: 'refused', code: 'SETUP_DISABLED'});
  expect(showOpenDialog).not.toHaveBeenCalled();
});
it('forwards retry and exclusion requests and answers with the plugin view only', async () => {
  mockPluginSetup(); await ready();
  await expect(pluginCall('plugin:retry', trusted())).resolves.toEqual(PLUGIN_VIEW);
  await expect(pluginCall('plugin:set-excluded', trusted(), 'ats', true)).resolves.toEqual(PLUGIN_VIEW);
  expect(pluginSetup.retry).toHaveBeenCalledExactlyOnceWith();
  expect(pluginSetup.setExcluded).toHaveBeenCalledExactlyOnceWith('ats', true);
  pluginSetup.setExcluded.mockRejectedValueOnce(new Error('EACCES: permission denied, open C:\\Users\\driver\\AppData\\Local\\ETS2Telemetry\\plugins\\setup.json'));
  await expect(pluginCall('plugin:set-excluded', trusted(), 'ats', false)).rejects.toThrow(/^Plugin setup request failed$/);
});
it('shows the verified bundled file and opens a listed folder through main-owned shell calls, answering no path', async () => {
  mockPluginSetup(); await ready();
  await expect(pluginCall('plugin:show-file', trusted())).resolves.toEqual({outcome: 'shown'});
  expect(shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(BUNDLED_FILE);
  await expect(pluginCall('plugin:open-folder', trusted(), 'ets2:steam:0')).resolves.toBeUndefined();
  expect(pluginSetup.folderToOpen).toHaveBeenCalledExactlyOnceWith('ets2:steam:0');
  expect(shell.openPath).toHaveBeenCalledExactlyOnceWith(PLUGINS_FOLDER);
  // An unknown or no longer valid folder opens nothing; an Explorer error is logged as a fixed code without its text.
  pluginSetup.folderToOpen.mockResolvedValueOnce(undefined);
  await expect(pluginCall('plugin:open-folder', trusted(), 'ats:manual:0')).resolves.toBeUndefined();
  expect(shell.openPath).toHaveBeenCalledOnce();
  shell.openPath.mockResolvedValueOnce(`Failed to open ${PLUGINS_FOLDER}`);
  await expect(pluginCall('plugin:open-folder', trusted(), 'ets2:steam:0')).resolves.toBeUndefined();
  expect(log).toHaveBeenCalledWith('PLUGIN_FOLDER_NOT_OPENED');
  expect(JSON.stringify(log.mock.calls)).not.toContain('Euro Truck Simulator 2');
  // Without a verified bundle, or when plugin setup finds the file missing or a link right before, nothing is shown.
  pluginSetup.bundledFile.mockResolvedValueOnce(undefined);
  await expect(pluginCall('plugin:show-file', trusted())).resolves.toEqual({outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'});
  expect(shell.showItemInFolder).toHaveBeenCalledOnce();
});
// PR #107 advisory review: a throw while finding or opening the folder reaches the renderer as the fixed message only.
it('answers a failing folder lookup or Explorer call with the fixed message, never the error text or a path', async () => {
  mockPluginSetup(); await ready();
  const secret = 'C:\\Users\\driver\\Steam\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins';
  pluginSetup.folderToOpen.mockRejectedValueOnce(new Error(`EPERM: operation not permitted, lstat '${secret}'`));
  const lookup = await pluginCall('plugin:open-folder', trusted(), 'ets2:steam:0').then(() => 'resolved', (error: Error) => error.message);
  expect(lookup).toBe('Plugin setup request failed');
  expect(shell.openPath).not.toHaveBeenCalled();
  shell.openPath.mockRejectedValueOnce(new Error(`Explorer failed for ${secret}`));
  const opened = await pluginCall('plugin:open-folder', trusted(), 'ets2:steam:0').then(() => 'resolved', (error: Error) => error.message);
  expect(opened).toBe('Plugin setup request failed');
  expect(JSON.stringify([lookup, opened])).not.toMatch(/[A-Za-z]:\\|steamapps/);
});
it('carries the plugin view in the application state and pushes it when plugin setup changes', async () => {
  mockPluginSetup(); await ready();
  expect((handlers.get('app:get-state')!(trusted()) as {plugins: unknown}).plugins).toEqual(PLUGIN_VIEW);
  ipc.emit('app:subscribe-state', trusted());
  const changed = {...PLUGIN_VIEW, running: true};
  pluginSetup.current = changed; pluginSetup.changed();
  expect(contents.send).toHaveBeenLastCalledWith('app:state', expect.objectContaining({plugins: changed}));
  expect(overlayContents.send).not.toHaveBeenCalledWith('app:state', expect.anything());
  // No reply and no push carries a path.
  const replies = [await pluginCall('plugin:retry', trusted()), await pluginCall('plugin:set-excluded', trusted(), 'ets2', false),
    await pluginCall('plugin:show-file', trusted()), await pluginCall('plugin:open-folder', trusted(), 'ets2:steam:0'),
    ...contents.send.mock.calls.filter(call => call[0] === 'app:state').map(call => call[1] as unknown)];
  expect(JSON.stringify(replies)).not.toMatch(/[A-Za-z]:\\\\|\\\\\\\\/);
});
it('refuses every plugin request once the exit has begun, aborts setup and joins its idle work to the exit budget', async () => {
  mockPluginSetup(); trayAvailable = true; await ready();
  const idle = deferred();
  pluginSetup.idle.mockReturnValue(idle.promise);
  void handlers.get('app:exit')!(trusted());
  // The exit's begin aborts it; the supervisor's stop aborts it again, which the orchestrator ignores.
  expect(pluginSetup.abort).toHaveBeenCalled();
  const before = pluginCalls();
  for (const channel of PLUGIN_CHANNEL_NAMES) {
    await expect(pluginCall(channel, trusted(), ...VALID_PLUGIN_REQUESTS[channel]), channel).rejects.toThrow('Plugin setup request was retired');
  }
  expect(pluginCalls()).toEqual(before); expect(showOpenDialog).not.toHaveBeenCalled();
  child.emit('exit', 0);
  expect(app.exit).not.toHaveBeenCalled();
  idle.resolve(); await settle();
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('exits within 1000 ms when the plugin setup run does not settle', async () => {
  mockPluginSetup(); trayAvailable = true; await ready();
  pluginSetup.idle.mockReturnValue(new Promise(() => undefined));
  void handlers.get('app:exit')!(trusted()); child.emit('exit', 0);
  await vi.advanceTimersByTimeAsync(999); expect(app.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('aborts plugin setup on a fatal stop as well', async () => {
  mockPluginSetup(); await ready();
  child.emit('message', {type: 'unexpected'});
  expect(pluginSetup.abort).toHaveBeenCalledOnce();
});
// ET-017 PR-6 (P17): the diagnostics export channel. It takes no argument and serves the trusted dashboard main frame
// only; the Save dialog belongs to the dashboard window; the answer is a fixed outcome, never a path. The saved case
// writes into a temporary LOCALAPPDATA and output folder only. Expected values are written by hand from P17.
const diagnosticsCall = (event: unknown, ...request: unknown[]) => new Promise<unknown>(resolve => resolve(handlers.get('diagnostics:export')!(event, ...request as [unknown])));
it('rejects diagnostics exports from untrusted senders, frames and the overlay, and any argument, before any dialog', async () => {
  trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    await expect(diagnosticsCall(event)).rejects.toThrow('Untrusted diagnostics request');
  for (const request of [['C:\\Users\\owner\\diagnostics.json'], [undefined], [{upload: true}]])
    await expect(diagnosticsCall(trusted(), ...request)).rejects.toThrow('Invalid diagnostics request');
  expect(showSaveDialog).not.toHaveBeenCalled();
  expect(log.mock.calls.filter(entry => String(entry[0]).startsWith('DIAGNOSTICS_EXPORT_'))).toEqual([]);
});
it('offers the default name in Documents in the Save dialog of the dashboard, and writes nothing when it is cancelled', async () => {
  vi.setSystemTime(Date.UTC(2026, 9, 17, 8, 30, 15)); await ready();
  await expect(diagnosticsCall(trusted())).resolves.toEqual({outcome: 'cancelled'});
  expect(showSaveDialog).toHaveBeenCalledExactlyOnceWith(windows[0], {defaultPath: 'C:\\isolated\\ets2telemetry-diagnostics-20261017T083015Z.json',
    filters: [{name: 'JSON', extensions: ['json']}]});
  expect(log).toHaveBeenCalledWith('DIAGNOSTICS_EXPORT_CANCELLED');
});
it('refuses a target in the data directory of LOCALAPPDATA before building the bundle', async () => {
  vi.stubEnv('LOCALAPPDATA', 'C:\\isolated-local'); await ready();
  showSaveDialog.mockResolvedValueOnce({canceled: false, filePath: 'C:\\ISOLATED-LOCAL\\ets2telemetry\\logs\\diagnostics.json'});
  await expect(diagnosticsCall(trusted())).resolves.toEqual({outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'});
  expect(log).toHaveBeenCalledWith('DIAGNOSTICS_EXPORT_FAILED', undefined, {outcome: 'refused', code: 'EXPORT_TARGET_REFUSED'});
});
it('answers EXPORT_INTERRUPTED once the exit has begun, also for a dialog open at the exit, and joins no file work', async () => {
  trayAvailable = true; await ready();
  let answer!: (value: {canceled: boolean; filePath?: string}) => void;
  showSaveDialog.mockImplementationOnce(() => new Promise(resolve => { answer = resolve; }));
  const open = diagnosticsCall(trusted());
  await settle();
  void handlers.get('app:exit')!(trusted());
  answer({canceled: false, filePath: 'C:\\Users\\owner\\Documents\\diagnostics.json'});
  await expect(open).resolves.toEqual({outcome: 'refused', code: 'EXPORT_INTERRUPTED'});
  await expect(diagnosticsCall(trusted())).resolves.toEqual({outcome: 'refused', code: 'EXPORT_INTERRUPTED'});
  expect(showSaveDialog).toHaveBeenCalledOnce();
  child.emit('exit', 0); await settle();
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('saves the redacted bundle of this application state and its startup logs, and answers saved without a path', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-diagnostics-main-'));
  try {
    const local = path.join(root, 'local'), logs = path.join(local, 'ETS2Telemetry', 'logs'), target = path.join(root, 'out', 'diagnostics.json');
    await mkdir(path.join(logs, 'service'), {recursive: true}); await mkdir(path.dirname(target));
    const user = os.userInfo().username;
    await writeFile(path.join(logs, 'startup.jsonl'), `${JSON.stringify({time: '2026-10-17T08:30:00.000Z', pid: 1, event: 'PLUGIN_DISCOVERY', facts: {owner: user, library: 'D:\\SteamLibrary'}, detail: 'C:\\Users'})}\n`);
    await writeFile(path.join(logs, 'service', 'startup.jsonl'), `${JSON.stringify({time: '2026-10-17T08:30:01.000Z', pid: 2, event: 'SERVICE_READY'})}\n`);
    vi.stubEnv('LOCALAPPDATA', local); await ready();
    showSaveDialog.mockResolvedValueOnce({canceled: false, filePath: target});
    const answer = await diagnosticsCall(trusted());
    expect(answer).toEqual({outcome: 'saved'});
    const bundle = JSON.parse(await readFile(target, 'utf8')) as Record<string, unknown>;
    expect(bundle).toMatchObject({format: 'ets2telemetry.diagnostics', version: 1, app: {version: expect.any(String) as string, packaged: false,
      node: process.versions.node}, health: {service: 'ready', storage: 'verified'}, plugins: PLUGINS_DISABLED, bundledPlugin: null,
    // No live update arrived yet: main's last live state is the initial one, as the dashboard would show it.
    live: {status: 'waiting', selection: 'game'}, diagnosis: {code: 'NO_GAME_SELECTED', notes: []},
    logs: {main: [{time: '2026-10-17T08:30:00.000Z', event: 'PLUGIN_DISCOVERY', facts: {owner: '<redacted>', library: '<redacted>'}}],
      service: [{time: '2026-10-17T08:30:01.000Z', event: 'SERVICE_READY'}]}});
    expect(await readdir(path.dirname(target))).toEqual(['diagnostics.json']);
    expect(log).toHaveBeenCalledWith('DIAGNOSTICS_EXPORT_SAVED', undefined, {bytes: expect.any(Number) as number});
    expect(JSON.stringify(log.mock.calls.filter(entry => String(entry[0]).startsWith('DIAGNOSTICS_EXPORT_')))).not.toContain(root);
  } finally {await rm(root, {recursive: true, force: true});}
});

// ET-018 PR-4 (U8): the in-app uninstall channel and its exit. The orchestrator is replaced here; its own order, the
// preflight, the removal race and the wipe are tests/unit/app-uninstall.test.ts. Main must pass its answers through unchanged.
interface FakeAppUninstall {
  run: ReturnType<typeof vi.fn<() => Promise<AppUninstallResult>>>; prepared: unknown; finishAfterExit: ReturnType<typeof vi.fn<() => Promise<unknown>>>;
  handOver: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  ports: AppUninstallPorts;
}
let appUninstallFake: FakeAppUninstall;
const PREPARED = {dataRoot: 'C:\\isolated\\LocalAppData\\ETS2Telemetry', installRoot: 'C:\\isolated\\LocalAppData\\ETS2TelemetryDesktop', notes: [], removed: 1, unrecognized: 0};
function mockAppUninstall(result: AppUninstallResult) {
  vi.doMock('../../apps/desktop/src/uninstall/app-uninstall', () => ({
    AppUninstall: class {
      constructor(ports: AppUninstallPorts) {
        const fake: FakeAppUninstall = appUninstallFake = {ports, prepared: undefined, handOver: vi.fn(() => Promise.resolve(true)),
          run: vi.fn(() => {if (result.outcome === 'started') fake.prepared = PREPARED; return Promise.resolve(result);}),
          finishAfterExit: vi.fn(() => Promise.resolve({data: {removed: 7, kept: 0, failed: [], rootRemoved: true}, notes: [{game: 'ats', note: 'GAME_EXECUTABLE_MISSING'}], removed: 1, unrecognized: 0}))};
        return fake;
      }
    }
  }));
}
const uninstallCall = (event: unknown, ...request: unknown[]) => new Promise<unknown>(resolve => resolve(handlers.get('app:uninstall')!(event, ...request as [unknown])));
const exitRequests = () => log.mock.calls.filter(call => call[0] === 'APP_EXIT_REQUESTED').map(call => call[2] as unknown);
it('rejects the uninstall from untrusted senders, frames and the overlay, and any argument, before the orchestrator runs', async () => {
  mockAppUninstall({outcome: 'cancelled'}); trayAvailable = true; await ready();
  for (const event of [{sender: {}, senderFrame: contents.mainFrame}, {sender: contents, senderFrame: {}}, overlayTrusted()])
    await expect(uninstallCall(event)).rejects.toThrow('Untrusted uninstall request');
  for (const request of [['C:\\Users\\owner'], [undefined], [{force: true}]]) await expect(uninstallCall(trusted(), ...request)).rejects.toThrow('Invalid uninstall request');
  expect(appUninstallFake.run).not.toHaveBeenCalled();
});
it('refuses the uninstall once the exit has begun', async () => {
  mockAppUninstall({outcome: 'started'}); trayAvailable = true; await ready();
  app.emit('before-quit', {preventDefault: vi.fn()});
  await expect(uninstallCall(trusted())).rejects.toThrow('the application is exiting');
  expect(appUninstallFake.run).not.toHaveBeenCalled();
});
it.each([
  ['cancelled', {outcome: 'cancelled'}], ['not-installed', {outcome: 'not-installed'}], ['failed', {outcome: 'failed', code: 'BUSY'}],
  ['blocked', {outcome: 'blocked', code: 'GAME_RUNNING', blocked: [{targetId: 'ets2:steam:0', reason: 'GAME_RUNNING'}, {targetId: 'ats:other', reason: 'CLIENT_RUNNING'}]}]
] as const)('passes a %s answer through unchanged and starts no exit', async (_name, result) => {
  mockAppUninstall(result as AppUninstallResult); trayAvailable = true; await ready();
  await expect(uninstallCall(trusted())).resolves.toEqual(result);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(exitRequests()).toEqual([]);
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  expect(app.exit).not.toHaveBeenCalled();
});
it('after started: the explicit exit with reason uninstall, the final log rows, the wipe, the result dialog, the handover, exit 0', async () => {
  mockAppUninstall({outcome: 'started'}); trayAvailable = true; await ready();
  await expect(uninstallCall(trusted())).resolves.toEqual({outcome: 'started'});
  // The answer reaches the dashboard before the exit begins.
  expect(exitRequests()).toEqual([]);
  await vi.advanceTimersByTimeAsync(0);
  expect(exitRequests()).toEqual([{reason: 'uninstall'}]);
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
  expect(appUninstallFake.finishAfterExit).not.toHaveBeenCalled();
  child.emit('exit', 0); await settle(); await vi.advanceTimersByTimeAsync(0);
  expect(log.finalize.mock.invocationCallOrder[0]).toBeLessThan(appUninstallFake.finishAfterExit.mock.invocationCallOrder[0]);
  expect(showMessageBox).toHaveBeenCalledOnce();
  const [options] = showMessageBox.mock.calls[0] as [{title: string; message: string; detail: string}];
  expect(options.title).toBe('ETS2Telemetry was uninstalled');
  expect(options.detail).toContain('American Truck Simulator: the game is no longer installed in a recorded folder');
  expect(showMessageBox.mock.invocationCallOrder[0]).toBeLessThan(appUninstallFake.handOver.mock.invocationCallOrder[0]);
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
  // The 12 s failsafe was disarmed before the result dialog.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(app.exit).toHaveBeenCalledOnce();
});
it('says so when Windows\' uninstall cannot start, then exits 0', async () => {
  mockAppUninstall({outcome: 'started'}); trayAvailable = true; await ready();
  await uninstallCall(trusted()); await vi.advanceTimersByTimeAsync(0);
  appUninstallFake.handOver.mockResolvedValueOnce(false);
  child.emit('exit', 0); await settle(); await vi.advanceTimersByTimeAsync(0);
  expect(showMessageBox).toHaveBeenCalledTimes(2);
  expect((showMessageBox.mock.calls[1] as [{title: string}])[0].title).toBe('Windows uninstall could not start');
  expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
});
it('the 12 s failsafe ends an uninstall exit that hangs before the result dialog', async () => {
  mockAppUninstall({outcome: 'started'}); trayAvailable = true; await ready();
  await uninstallCall(trusted()); await vi.advanceTimersByTimeAsync(0);
  appUninstallFake.finishAfterExit.mockImplementationOnce(() => new Promise(() => undefined));
  child.emit('exit', 0); await settle();
  await vi.advanceTimersByTimeAsync(11_000); expect(app.exit).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_500); expect(app.exit).toHaveBeenCalledExactlyOnceWith(1);
  expect(showMessageBox).not.toHaveBeenCalled();
});
it('confirms in a dialog of the dashboard with Cancel as the default; the smoke seam answers both dialogs instead', async () => {
  mockAppUninstall({outcome: 'cancelled'}); trayAvailable = true; await ready();
  showMessageBox.mockResolvedValueOnce({response: 0}).mockResolvedValueOnce({response: 1});
  await expect(appUninstallFake.ports.confirm()).resolves.toBe(false);
  await expect(appUninstallFake.ports.confirm()).resolves.toBe(true);
  const [parent, options] = showMessageBox.mock.calls[0] as [unknown, {defaultId: number; cancelId: number; buttons: string[]; detail: string}];
  expect(parent).toBe(windows[0]);
  expect(options).toMatchObject({defaultId: 0, cancelId: 0, buttons: ['Cancel', 'Uninstall']});
  expect(options.detail).toContain('captures');
});
it('the dialog seam is an app event of isolated smokes only', async () => {
  await isolatedProfile(async profile => {
    vi.stubEnv('ETS2TELEMETRY_LIVE_SMOKE', '1'); vi.stubEnv('ETS2TELEMETRY_DIAGNOSTIC_DIR', profile); vi.stubEnv('ETS2TELEMETRY_PROFILE_DIR', profile);
    mockAppUninstall({outcome: 'cancelled'}); trayAvailable = true; await ready();
    app.emit('ets2telemetry:diagnostic-uninstall-dialogs', 'uninstall');
    await expect(appUninstallFake.ports.confirm()).resolves.toBe(true);
    app.emit('ets2telemetry:diagnostic-uninstall-dialogs', 'cancel');
    await expect(appUninstallFake.ports.confirm()).resolves.toBe(false);
    expect(showMessageBox).not.toHaveBeenCalled();
  });
});
it('without the smoke gate the dialog seam does nothing', async () => {
  mockAppUninstall({outcome: 'cancelled'}); trayAvailable = true; await ready();
  expect(app.listenerCount('ets2telemetry:diagnostic-uninstall-dialogs')).toBe(0);
});
it('wires the orchestrator to plugin setup: suspend, resume (after a removal race) and the target ids', async () => {
  mockPluginSetup(); mockAppUninstall({outcome: 'cancelled'}); trayAvailable = true; await ready();
  await appUninstallFake.ports.setup.suspend();
  appUninstallFake.ports.setup.resume();
  expect(appUninstallFake.ports.setup.targetIdFor('ets2', 'C:\\Games\\ETS2')).toBe('ets2:steam:0');
  expect(pluginSetup.suspend).toHaveBeenCalledOnce(); expect(pluginSetup.resume).toHaveBeenCalledOnce();
});
