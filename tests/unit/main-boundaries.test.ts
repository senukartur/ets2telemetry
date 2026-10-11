import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

const processEvents = ['uncaughtException', 'unhandledRejection'] as const;
const processEmitter: EventEmitter = process;
let originals: Map<string, Function[]>;
let app: EventEmitter & {exit: ReturnType<typeof vi.fn>};
let ipc: EventEmitter;
let handlers: Map<string, (event: unknown, source?: unknown) => unknown>;
let child: EventEmitter & {postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>};
let contents: EventEmitter & {mainFrame: object; send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn>};
let resolveBroker: ReturnType<typeof vi.fn>;
let loadFile: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); vi.resetModules();
  originals = new Map(processEvents.map(name => [name, processEmitter.listeners(name)]));
  app = Object.assign(new EventEmitter(), {exit: vi.fn(), quit: vi.fn(), getPath: () => 'C:\\isolated', setPath: vi.fn(), whenReady: () => Promise.resolve(), isPackaged: false});
  child = Object.assign(new EventEmitter(), {postMessage: vi.fn(), kill: vi.fn(() => true)});
  contents = Object.assign(new EventEmitter(), {mainFrame: {}, send: vi.fn(), postMessage: vi.fn(), setWindowOpenHandler: vi.fn()});
  loadFile = vi.fn(() => Promise.resolve());
  handlers = new Map(); ipc = new EventEmitter();
  Object.assign(ipc, {handle: (name: string, handler: typeof handlers extends Map<string, infer H> ? H : never) => handlers.set(name, handler)});
  resolveBroker = vi.fn(() => undefined);
  vi.doMock('electron', () => ({app, ipcMain: ipc, utilityProcess: {fork: () => child},
    BrowserWindow: class {webContents = contents; isDestroyed() {return false;} loadFile = loadFile;},
    MessageChannelMain: class {port1 = {close: vi.fn()}; port2 = {close: vi.fn()};}}));
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
  expect(loadFile).toHaveBeenCalledOnce(); expect(app.exit).not.toHaveBeenCalled();
});
it('keeps unavailable game broker selection contained in the service instead of crashing main', async () => {
  vi.stubEnv('ETS2TELEMETRY_SOURCE_KIND', 'ets2');
  resolveBroker.mockImplementation(() => {throw new Error('provenance');});
  await ready(); expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ets2', broker: undefined});
  expect(loadFile).toHaveBeenCalledOnce(); expect(app.exit).not.toHaveBeenCalled();
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
  else {expect(loadFile).toHaveBeenCalledOnce(); expect(child.postMessage).toHaveBeenCalledWith({type: 'select', source: 'ets2', broker: undefined});}
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
    expect(loadFile).toHaveBeenCalledTimes(index + 2); await vi.advanceTimersByTimeAsync(60000);
  }
  expect(child.postMessage).not.toHaveBeenCalledWith({type: 'stop'});
  for (let index = 0; index < 3; index++) contents.emit('render-process-gone', {}, {reason: 'crashed'});
  expect(loadFile).toHaveBeenCalledTimes(7);
  expect(child.postMessage).toHaveBeenCalledWith({type: 'stop'});
});
