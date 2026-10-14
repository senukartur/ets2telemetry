import {app, BrowserWindow, ipcMain, MessageChannelMain, screen, utilityProcess, type MessagePortMain, type UtilityProcess, type IpcMainEvent, type IpcMainInvokeEvent} from 'electron';
import squirrelStartup from 'electron-squirrel-startup';
import {existsSync, mkdirSync} from 'node:fs';
import path from 'node:path';
import type {EventEmitter} from 'node:events';
import type {LiveTelemetry, OverlayPresentation, ScaffoldStatus, SourceSelection} from '../../../packages/contracts/src';
import {processEntrypoint} from './entrypoints';
import {createDiagnostics, type DiagnosticFacts} from './diagnostics';
import {ServiceSupervisor} from './service-supervisor';
import {initialLive, sourceSelection} from './live-state';
import {createBrokerResolver} from './broker-artifact';
import {RecoveryBudget} from './recovery-budget';
import {LiveSubscriptions} from './live-subscriptions';
import {LiveFreshness} from './live-freshness';
import {OVERLAY_TOPMOST_LEVEL, OverlayController} from './overlay-controller';
import {overlayPresentation} from './overlay-presentation';
import {captureActivation, type CaptureGrant} from './capture-activation';
import {monitorEventLoopLag} from './event-loop-lag';

if (squirrelStartup) app.quit();
else {
  const diagnosticDirectory = process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  const log = createDiagnostics(diagnosticDirectory || path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'ETS2Telemetry', 'logs'), Boolean(diagnosticDirectory));
  // Opt-in startup timeline for diagnosing stalls in isolated smokes: fixed codes and numbers only, never in default logs.
  const timeline = diagnosticDirectory ? (event: string, facts?: DiagnosticFacts) => log(event, undefined, facts) : undefined;
  function observeLoads(contents: Electron.WebContents, prefix: 'DASHBOARD' | 'OVERLAY'): void {
    if (!timeline) return;
    contents.on('did-start-loading', () => timeline(`${prefix}_LOAD_STARTED`));
    contents.on('did-finish-load', () => {
      let rendererPid: number | null = null;
      try {rendererPid = contents.getOSProcessId();} catch {/* A destroyed renderer has no PID. */}
      timeline(`${prefix}_LOAD_FINISHED`, {rendererPid});
    });
  }
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
  // CAP0 evidence capture is default off. An explicit launch-environment request becomes one
  // grant attached to the first verified ETS2/ATS selection; it never renews after service restarts.
  let captureRequest: Omit<CaptureGrant, 'displays'> | undefined;
  try {captureRequest = captureActivation(process.env); if (captureRequest) log('CAPTURE_ACTIVATION', {format: captureRequest.format, deadlineMs: captureRequest.deadlineMs});}
  catch (error) {log('CAPTURE_ACTIVATION_REJECTED', String(error));}
  function selectMessage(source: SourceSelection, broker: Awaited<ReturnType<typeof selectedBroker>>) {
    if (!captureRequest || !broker || (source !== 'ets2' && source !== 'ats')) return {type: 'select', source, broker};
    const capture: CaptureGrant = {...captureRequest, displays: screen.getAllDisplays().slice(0, 16).map(display => ({id: String(display.id),
      bounds: {x: Math.round(display.bounds.x), y: Math.round(display.bounds.y), width: Math.round(display.bounds.width), height: Math.round(display.bounds.height)}, scaleFactor: display.scaleFactor, rotation: display.rotation}))};
    captureRequest = undefined;
    return {type: 'select', source, broker, capture};
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
      focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      // A dedicated in-memory session separates the overlay's browser context from the dashboard.
      webPreferences: {partition: 'ets2telemetry-overlay', preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    timeline?.('OVERLAY_WINDOW_CREATED'); observeLoads(overlay.webContents, 'OVERLAY');
    overlay.setIgnoreMouseEvents(true); overlay.setFocusable(false);
    // Not the constructor's alwaysOnTop: its default `floating` level stacks the overlay behind the
    // taskbar, which drops WS_EX_TOPMOST while a borderless full-screen game is foreground.
    overlay.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL);
    overlayController = new OverlayController(overlay, screen, phase => log('OVERLAY_TOPMOST_RESTORED', undefined, {phase}));
    overlay.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    overlay.webContents.on('will-navigate', event => event.preventDefault());
    const retire = () => retireOverlay();
    overlay.webContents.on('did-start-loading', retire);
    // The replaced document runs until the new one commits, behind the same trusted WebFrameMain, and its
    // recovery timer can re-subscribe meanwhile. Commit precedes the new document's IPC, so retire that port again.
    overlay.webContents.on('did-navigate', () => {if (overlayPort) log('OVERLAY_PRECOMMIT_SUBSCRIPTION_RETIRED'); retire();});
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
    timeline?.('DASHBOARD_WINDOW_CREATED'); observeLoads(window.webContents, 'DASHBOARD');
    window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    window.webContents.on('will-navigate', event => event.preventDefault());
    const retireDocument = () => {rendererEpoch++; subscribed = false; dashboardSubscriptions.close(); dashboardPort = undefined;};
    window.webContents.on('did-start-loading', retireDocument);
    // As for the overlay: a subscription made before commit belongs to the replaced document. Left in place,
    // it would make main ignore the new document's subscribe request and leave the dashboard without data.
    window.webContents.on('did-navigate', () => {if (subscribed) log('DASHBOARD_PRECOMMIT_SUBSCRIPTION_RETIRED'); retireDocument();});
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
          child.postMessage(selectMessage(requested, broker));
          serviceReady = true; selectionPending = false; status = {service: 'ready', storage: 'verified', synthetic: true};
          if (!window) {createWindow(); createOverlay();} else connectSubscription();
          connectUpstream();
        })().catch(error => {if (!supervisor.stopping && service === child) fail('SERVICE_CONFIGURATION_FAILED', error);});
      } else if (type === 'failed') fail('SERVICE_START_FAILED', message);
      else if (type !== 'stopped') fail('SERVICE_INVALID_MESSAGE');
    });
  }
  log('APP_START', {electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged});
  if (timeline) {
    monitorEventLoopLag(facts => timeline('MAIN_EVENT_LOOP_LAG', facts));
    // Observation only: an unexpected GPU or utility exit is recorded, not treated as a smoke failure here.
    app.on('child-process-gone', (_event, details) => timeline('CHILD_PROCESS_GONE', {type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? null}));
  }
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
    selectionPending = true; freshness.invalidate(initialLive(selection));
    try {
      const broker = next === 'ets2' || next === 'ats' ? await selectedBroker(next) : undefined;
      if (!trusted(event) || !serviceReady || supervisor.stopping || service !== child || generation !== selectionGeneration || epoch !== rendererEpoch) throw new Error('Source request was retired');
      child.postMessage(selectMessage(next, broker));
      selection = next; freshness.invalidate(initialLive(selection));
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
