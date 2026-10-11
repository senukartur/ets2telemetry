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
async function ready() {await import('../../apps/desktop/src/main'); await Promise.resolve(); child.emit('message', {type: 'ready'});}
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
  expect(() => select({sender: {}, senderFrame: contents.mainFrame}, 'ats')).toThrow('Untrusted');
  expect(() => select({sender: contents, senderFrame: {}}, 'ats')).toThrow('Untrusted');
  child.postMessage.mockImplementationOnce(() => {throw new Error('closed IPC');});
  expect(() => select(trusted(), 'replay')).toThrow('closed IPC');
  child.emit('exit', 1);
  expect(contents.send.mock.calls[0][1].selection).toBe('synthetic');
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
