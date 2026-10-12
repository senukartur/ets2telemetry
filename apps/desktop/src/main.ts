import {app, BrowserWindow, ipcMain, MessageChannelMain, screen, utilityProcess, type MessagePortMain, type UtilityProcess, type IpcMainEvent, type IpcMainInvokeEvent} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import type {EventEmitter} from 'node:events';
import type {LiveTelemetry, OverlayPresentation, ScaffoldStatus, SourceSelection} from '../../../packages/contracts/src';
import {processEntrypoint} from './entrypoints';
import {createDiagnostics} from './diagnostics';
import {ServiceSupervisor} from './service-supervisor';
import {initialLive, sourceSelection} from './live-state';
import {createBrokerResolver} from './broker-artifact';
import {RecoveryBudget} from './recovery-budget';
import {LiveSubscriptions} from './live-subscriptions';
import {LiveFreshness} from './live-freshness';
import {OverlayController} from './overlay-controller';
import {overlayPresentation} from './overlay-presentation';

if (squirrelStartup) app.quit();
else {
  const diagnosticDirectory = process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  const log = createDiagnostics(diagnosticDirectory || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ETS2Telemetry', 'logs'), Boolean(diagnosticDirectory));
  let window: BrowserWindow | undefined, service: UtilityProcess | undefined, status: ScaffoldStatus | undefined;
  let subscribed = false, serviceReady = false;
  let overlay: BrowserWindow | undefined, overlayController: OverlayController | undefined;
  let dashboardPort: MessagePortMain | undefined, overlayPort: MessagePortMain | undefined, upstream: MessagePortMain | undefined;
  let upstreamRecovery: ReturnType<typeof setTimeout> | undefined;
  const upstreamBudget = new RecoveryBudget(), overlayBudget = new RecoveryBudget();
  const dashboardSubscriptions = new LiveSubscriptions(initialLive(), 1);
  const overlaySubscriptions = new LiveSubscriptions<OverlayPresentation>(overlayPresentation(initialLive()), 1, 500);
  const freshness = new LiveFreshness(update => {
    dashboardSubscriptions.publish(update); overlaySubscriptions.publish(overlayPresentation(update)); overlayController?.update(update);
  });
  const rendererBudget = new RecoveryBudget();
  const resolveBroker = createBrokerResolver(__dirname, process.resourcesPath, app.isPackaged, process.env.LOCALAPPDATA, error => log('BROKER_UNAVAILABLE', String(error)));
  async function selectedBroker(source: SourceSelection) {
    if (source !== 'ets2' && source !== 'ats') return undefined;
    try {return await resolveBroker();}
    catch (error) {log('BROKER_UNAVAILABLE', String(error)); return undefined;}
  }
  let lastSelectionRequest = -Infinity;
  let selectionGeneration = 0;
  let selectionPending = false;
  let rendererEpoch = 0;
  let selection: SourceSelection = sourceSelection(process.env.ETS2TELEMETRY_SOURCE_KIND || 'game');
  const supervisor = new ServiceSupervisor(log, code => app.exit(code), {
    restart: () => startService(),
    state: state => {serviceReady = false; selectionPending = false; status = undefined; closeUpstream();
      const update: LiveTelemetry = {...initialLive(selection), status: state, reason: 'Telemetry service exited; current interval is unknown'};
      freshness.invalidate(update); dashboardSubscriptions.close(); dashboardPort = undefined; window?.webContents.send('telemetry:service-state', update);},
    exhausted: () => {const update: LiveTelemetry = {...initialLive(selection), status: 'service-failed', reason: 'Automatic service restart limit reached'};
      freshness.invalidate(update); window?.webContents.send('telemetry:service-state', update);}
  });
  function retireOverlay(): void {overlayPort = undefined; overlayController?.loaded(false); overlaySubscriptions.close();}
  function retireLive(): void {freshness.close(); closeUpstream(); retireOverlay(); dashboardSubscriptions.close(); dashboardPort = undefined;}
  function stop(): void {retireLive(); supervisor.stop();}
  function fail(code: string, error?: unknown): void {retireLive(); supervisor.fail(code, error);}
  const trusted = (event: IpcMainEvent | IpcMainInvokeEvent) => Boolean(window && !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame);
  function connectSubscription(): void {
    if (!subscribed || dashboardPort || supervisor.stopping || !window || window.isDestroyed()) return;
    const {port1, port2} = new MessageChannelMain();
    dashboardPort = port1;
    port1.on('close', () => {if (dashboardPort === port1) dashboardPort = undefined;});
    try {dashboardSubscriptions.attach(port1); window.webContents.postMessage('telemetry:port', null, [port2]);}
    catch (error) {port1.close(); port2.close(); log('SUBSCRIPTION_FAILED', String(error));}
  }
  function closeUpstream(): void {
    clearTimeout(upstreamRecovery); upstreamRecovery = undefined;
    const previous = upstream; upstream = undefined; previous?.close();
  }
  function recoverUpstream(child: UtilityProcess): void {
    if (service !== child || !serviceReady || supervisor.stopping || upstream || upstreamRecovery !== undefined) return;
    if (upstreamBudget.take() === undefined) {
      log('MAIN_CHANNEL_RECOVERY_COOLDOWN', {delayMs: 60000});
      upstreamRecovery = setTimeout(() => {upstreamRecovery = undefined; recoverUpstream(child);}, 60000);
      return;
    }
    upstreamRecovery = setTimeout(() => {
      upstreamRecovery = undefined;
      if (service === child && serviceReady && !supervisor.stopping && !upstream) connectUpstream();
    }, 250);
  }
  function connectUpstream(): void {
    if (upstream || !serviceReady || !service || supervisor.stopping) return;
    clearTimeout(upstreamRecovery); upstreamRecovery = undefined;
    const child = service, {port1, port2} = new MessageChannelMain(); upstream = port1;
    const lost = () => {
      if (upstream !== port1 || service !== child || !serviceReady || supervisor.stopping) return;
      log('MAIN_CHANNEL_CLOSED', 'Active service live subscription closed');
      closeUpstream(); freshness.invalidate({...initialLive(selection), status: 'stale', reason: 'Main live subscription closed; current interval is unknown'});
      recoverUpstream(child);
    };
    port1.on('close', lost);
    port1.on('message', (event: {data: {type?: string; delivery?: number; update?: LiveTelemetry} | undefined}) => {
      if (upstream !== port1 || service !== child || !serviceReady || supervisor.stopping) return;
      const data = event.data;
      if (!data || data.type !== 'live' || !Number.isSafeInteger(data.delivery) || data.delivery! < 1 || !data.update) {lost(); return;}
      // The single typed utilityProcess publisher is trusted; renderers never reach this port.
      if (!selectionPending && data.update.selection === selection) freshness.accept(data.update);
      try {if (upstream === port1) port1.postMessage({type: 'consumed', delivery: data.delivery});} catch {lost();}
    });
    try {port1.start(); child.postMessage({type: 'subscribe'}, [port2]);} catch (error) {port2.close(); lost(); log('MAIN_SUBSCRIPTION_FAILED', String(error));}
  }
  function createOverlay(): void {
    overlay = new BrowserWindow({width: 300, height: 132, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
      focusable: false, skipTaskbar: true, alwaysOnTop: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      // A dedicated in-memory session separates the overlay's browser context from the dashboard.
      webPreferences: {partition: 'ets2telemetry-overlay', preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    overlayController = new OverlayController(overlay, screen);
    overlay.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    const retire = () => retireOverlay();
    overlay.webContents.on('did-start-loading', retire);
    overlay.webContents.on('render-process-gone', (_event, details) => {
      retire(); log('OVERLAY_RENDER_PROCESS_GONE', details);
      if (!supervisor.stopping && overlayBudget.take() !== undefined) loadOverlay(); else fail('OVERLAY_RESTART_EXHAUSTED');
    });
    overlay.on('closed', () => {retire(); overlay = undefined; overlayController = undefined; if (!supervisor.stopping) stop();});
    const changed = () => overlayController?.topologyChanged();
    screen.on('display-added', changed); screen.on('display-removed', changed); screen.on('display-metrics-changed', changed);
    loadOverlay();
  }
  function loadOverlay(): void {
    void overlay!.loadFile(path.join(__dirname, 'renderer', 'index.html'), {query: {view: 'overlay'}}).catch(error => fail('OVERLAY_LOAD_FAILED', error));
  }
  function createWindow(): void {
    window = new BrowserWindow({width: 800, height: 500, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    window.webContents.on('did-start-loading', () => {rendererEpoch++; subscribed = false; dashboardSubscriptions.close(); dashboardPort = undefined;});
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererEpoch++; subscribed = false; dashboardSubscriptions.close(); dashboardPort = undefined; log('RENDER_PROCESS_GONE', details);
      if (!supervisor.stopping && rendererBudget.take() !== undefined) loadWindow(); else fail('RENDERER_RESTART_EXHAUSTED');
    });
    window.on('closed', () => {subscribed = false; dashboardSubscriptions.close(); freshness.close(); closeUpstream(); overlay?.destroy(); stop();});
    loadWindow();
  }
  function loadWindow(): void {
    void window!.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => log('WINDOW_LOADED')).catch(error => fail('WINDOW_LOAD_FAILED', error));
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
          serviceReady = true; selectionPending = false; status = {service: 'ready', storage: 'verified', synthetic: true};
          if (!window) {createWindow(); createOverlay();} else connectSubscription();
          connectUpstream();
        })().catch(error => {if (!supervisor.stopping && service === child) fail('SERVICE_CONFIGURATION_FAILED', error);});
      } else if (type === 'failed') fail('SERVICE_START_FAILED', message);
      else if (type !== 'stopped') fail('SERVICE_INVALID_MESSAGE');
    });
  }
  log('APP_START', {electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged});
  process.on('uncaughtException', error => fail('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', error => fail('UNHANDLED_REJECTION', error));
  app.on('before-quit', event => {event.preventDefault(); freshness.close(); closeUpstream(); overlayController?.loaded(false); stop();});
  // V0 records no history. Close-to-tray recording lifecycle belongs to ET-011/015.
  app.on('window-all-closed', () => stop());
  if (process.env.ETS2TELEMETRY_LIVE_SMOKE === '1' && diagnosticDirectory && path.isAbsolute(diagnosticDirectory) && process.env.ETS2TELEMETRY_PROFILE_DIR && path.isAbsolute(process.env.ETS2TELEMETRY_PROFILE_DIR)) {
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-service-exit', () => {if (service && serviceReady && !supervisor.stopping) {log('DIAGNOSTIC_SERVICE_EXIT_REQUEST', {pid: service.pid}); service.kill();}});
  }
  try {
    const profile = process.env.ETS2TELEMETRY_PROFILE_DIR;
    if (profile) {
      if (!path.isAbsolute(profile)) throw new Error('Diagnostic profile must be absolute');
      mkdirSync(profile, {recursive: true}); app.setPath('userData', profile); app.setPath('sessionData', profile);
    }
  } catch (error) {fail('PROFILE_SETUP_FAILED', error);}
  ipcMain.handle('scaffold:status', event => {if (!trusted(event) || !status) throw new Error('Untrusted status request'); return status;});
  ipcMain.handle('telemetry:select', async (event, source: unknown) => {
    if (!trusted(event) || !serviceReady) throw new Error('Untrusted source request');
    const next = sourceSelection(source);
    if (performance.now() - lastSelectionRequest < 250) throw new Error('Source selection request limit exceeded');
    lastSelectionRequest = performance.now();
    const child = service!, generation = ++selectionGeneration, epoch = rendererEpoch;
    selectionPending = true; freshness.invalidate(initialLive(next));
    try {
      const broker = next === 'ets2' || next === 'ats' ? await selectedBroker(next) : undefined;
      if (!trusted(event) || !serviceReady || supervisor.stopping || service !== child || generation !== selectionGeneration || epoch !== rendererEpoch) throw new Error('Source request was retired');
      child.postMessage({type: 'select', source: next, broker});
      selection = next;
    } finally {if (generation === selectionGeneration) selectionPending = false;}
  });
  ipcMain.on('telemetry:subscribe', event => {if (!trusted(event) || subscribed || supervisor.stopping) return; subscribed = true; connectSubscription();});
  ipcMain.on('telemetry:unsubscribe', event => {if (!trusted(event)) return; subscribed = false; dashboardSubscriptions.close(); dashboardPort = undefined;});
  const trustedOverlay = (event: IpcMainEvent) => Boolean(overlay && !overlay.isDestroyed() && event.sender === overlay.webContents && event.senderFrame === overlay.webContents.mainFrame);
  ipcMain.on('overlay:subscribe', event => {
    if (!trustedOverlay(event) || overlayPort || supervisor.stopping) return;
    const {port1, port2} = new MessageChannelMain(); overlayPort = port1;
    port1.on('close', () => {if (overlayPort === port1) {overlayPort = undefined; overlayController?.loaded(false); log('OVERLAY_CHANNEL_CLOSED', 'Active overlay subscription closed');}});
    try {overlaySubscriptions.attach(port1); overlay!.webContents.postMessage('overlay:port', null, [port2]); overlayController?.loaded(true);}
    catch (error) {retireOverlay(); port1.close(); port2.close(); log('OVERLAY_SUBSCRIPTION_FAILED', String(error));}
  });
  ipcMain.on('overlay:unsubscribe', event => {if (!trustedOverlay(event)) return; retireOverlay();});
  app.whenReady().then(startService).catch(error => fail('APP_START_FAILED', error));
}
