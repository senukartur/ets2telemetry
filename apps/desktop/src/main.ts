import {app, BrowserWindow, ipcMain, MessageChannelMain, utilityProcess, type UtilityProcess, type IpcMainEvent, type IpcMainInvokeEvent} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import type {EventEmitter} from 'node:events';
import type {ScaffoldStatus, SourceSelection} from '../../../packages/contracts/src';
import {processEntrypoint} from './entrypoints';
import {createDiagnostics} from './diagnostics';
import {ServiceSupervisor} from './service-supervisor';
import {initialLive, sourceSelection} from './live-state';
import {createBrokerResolver} from './broker-artifact';
import {RecoveryBudget} from './recovery-budget';

if (squirrelStartup) app.quit();
else {
  const diagnosticDirectory = process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  const log = createDiagnostics(diagnosticDirectory || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ETS2Telemetry', 'logs'), Boolean(diagnosticDirectory));
  let window: BrowserWindow | undefined, service: UtilityProcess | undefined, status: ScaffoldStatus | undefined;
  let subscribed = false, serviceReady = false;
  const rendererBudget = new RecoveryBudget();
  const resolveBroker = createBrokerResolver(__dirname, process.resourcesPath, app.isPackaged, process.env.LOCALAPPDATA, error => log('BROKER_UNAVAILABLE', String(error)));
  async function selectedBroker(source: SourceSelection) {
    if (source !== 'ets2' && source !== 'ats') return undefined;
    try {return await resolveBroker();}
    catch (error) {log('BROKER_UNAVAILABLE', String(error)); return undefined;}
  }
  let lastSelectionRequest = -Infinity;
  let selectionGeneration = 0;
  let rendererEpoch = 0;
  let selection: SourceSelection = sourceSelection(process.env.ETS2TELEMETRY_SOURCE_KIND || 'game');
  const supervisor = new ServiceSupervisor(log, code => app.exit(code), {
    restart: () => startService(),
    state: state => {serviceReady = false; status = undefined; window?.webContents.send('telemetry:service-state', {...initialLive(selection), status: state, reason: 'Telemetry service exited; current interval is unknown'});},
    exhausted: () => {window?.webContents.send('telemetry:service-state', {...initialLive(selection), status: 'service-failed', reason: 'Automatic service restart limit reached'});}
  });
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  function connectSubscription(): void {
    if (!subscribed || !serviceReady || !service || !window || window.isDestroyed()) return;
    const {port1, port2} = new MessageChannelMain();
    try {service.postMessage({type: 'subscribe'}, [port2]); window.webContents.postMessage('telemetry:port', null, [port1]);}
    catch (error) {port1.close(); port2.close(); log('SUBSCRIPTION_FAILED', String(error));}
  }
  function createWindow(): void {
    window = new BrowserWindow({width: 800, height: 500, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-start-loading', () => {rendererEpoch++; subscribed = false; service?.postMessage({type: 'unsubscribe'});});
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererEpoch++; subscribed = false; service?.postMessage({type: 'unsubscribe'}); log('RENDER_PROCESS_GONE', details);
      if (!supervisor.stopping && rendererBudget.take() !== undefined) loadWindow(); else supervisor.fail('RENDERER_RESTART_EXHAUSTED');
    });
    loadWindow();
  }
  function loadWindow(): void {
    void window!.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => log('WINDOW_LOADED')).catch(error => supervisor.fail('WINDOW_LOAD_FAILED', error));
  }
  function startService(): void {
    if (supervisor.stopping) return;
    const entrypoint = processEntrypoint(__dirname, 'telemetry-service');
    if (!existsSync(entrypoint)) throw new Error('Missing physical telemetry service entrypoint');
    const child = service = utilityProcess.fork(entrypoint, [], {serviceName: 'ETS2Telemetry telemetry service', stdio: 'pipe'});
    supervisor.attach(child);
    child.stdout?.on('data', chunk => log('SERVICE_STDOUT', String(chunk)));
    child.stderr?.on('data', chunk => log('SERVICE_STDERR', String(chunk)));
    child.once('spawn', () => log('SERVICE_SPAWN', {pid: child.pid}));
    child.once('exit', code => {if (service === child) {service = undefined; supervisor.serviceExited(code);}});
    child.on('message', (message: unknown) => {
      if (supervisor.stopping || service !== child) return;
      const type = message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>).type : undefined;
      if (type === 'ready') {
        if (!supervisor.ready()) return;
        const requested = selection, generation = ++selectionGeneration;
        void (async () => {
          const broker = requested === 'ets2' || requested === 'ats' ? await selectedBroker(requested) : undefined;
          if (supervisor.stopping || service !== child || generation !== selectionGeneration) return;
          child.postMessage({type: 'select', source: requested, broker});
          serviceReady = true; status = {service: 'ready', storage: 'verified', synthetic: true};
          if (!window) createWindow(); else connectSubscription();
        })().catch(error => {if (!supervisor.stopping && service === child) supervisor.fail('SERVICE_CONFIGURATION_FAILED', error);});
      } else if (type === 'failed') supervisor.fail('SERVICE_START_FAILED', message);
      else if (type !== 'stopped') supervisor.fail('SERVICE_INVALID_MESSAGE');
    });
  }
  log('APP_START', {electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged});
  process.on('uncaughtException', error => supervisor.fail('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', error => supervisor.fail('UNHANDLED_REJECTION', error));
  app.on('before-quit', event => {event.preventDefault(); supervisor.stop();});
  // V0 records no history. Close-to-tray recording lifecycle belongs to ET-011/015.
  app.on('window-all-closed', () => supervisor.stop());
  if (process.env.ETS2TELEMETRY_LIVE_SMOKE === '1' && diagnosticDirectory && path.isAbsolute(diagnosticDirectory) && process.env.ETS2TELEMETRY_PROFILE_DIR && path.isAbsolute(process.env.ETS2TELEMETRY_PROFILE_DIR)) {
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-service-exit', () => {if (service && serviceReady && !supervisor.stopping) {log('DIAGNOSTIC_SERVICE_EXIT_REQUEST', {pid: service.pid}); service.kill();}});
  }
  try {
    const profile = process.env.ETS2TELEMETRY_PROFILE_DIR;
    if (profile) {
      if (!path.isAbsolute(profile)) throw new Error('Diagnostic profile must be absolute');
      mkdirSync(profile, {recursive: true}); app.setPath('userData', profile); app.setPath('sessionData', profile);
    }
  } catch (error) {supervisor.fail('PROFILE_SETUP_FAILED', error);}
  ipcMain.handle('scaffold:status', event => {if (!trusted(event) || !status) throw new Error('Untrusted status request'); return status;});
  ipcMain.handle('telemetry:select', async (event, source: unknown) => {
    if (!trusted(event) || !serviceReady) throw new Error('Untrusted source request');
    const next = sourceSelection(source);
    if (performance.now() - lastSelectionRequest < 250) throw new Error('Source selection request limit exceeded');
    lastSelectionRequest = performance.now();
    const child = service!, generation = ++selectionGeneration, epoch = rendererEpoch;
    const broker = next === 'ets2' || next === 'ats' ? await selectedBroker(next) : undefined;
    if (!trusted(event) || !serviceReady || supervisor.stopping || service !== child || generation !== selectionGeneration || epoch !== rendererEpoch) throw new Error('Source request was retired');
    child.postMessage({type: 'select', source: next, broker});
    selection = next;
  });
  ipcMain.on('telemetry:subscribe', event => {if (!trusted(event) || subscribed) return; subscribed = true; connectSubscription();});
  ipcMain.on('telemetry:unsubscribe', event => {if (!trusted(event)) return; subscribed = false; service?.postMessage({type: 'unsubscribe'});});
  app.whenReady().then(startService).catch(error => supervisor.fail('APP_START_FAILED', error));
}
