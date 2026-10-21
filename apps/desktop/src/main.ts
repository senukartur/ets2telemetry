import {HardModeServiceCache} from './hard-mode/service-status';
import {app, BrowserWindow, dialog, ipcMain, Menu, MessageChannelMain, nativeImage, screen, shell, Tray, utilityProcess, type MessagePortMain, type UtilityProcess, type IpcMainEvent, type IpcMainInvokeEvent} from 'electron';
import {spawn} from 'node:child_process';
import {existsSync, mkdirSync} from 'node:fs';
import * as nodeFsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {EventEmitter} from 'node:events';
import {version} from '../../../package.json';
import type {AppHealth, AppLanguage, AppState, AppUninstallResult, DiagnosticsExportResult, LiveTelemetry, OverlayEditState, OverlayPresentation, OverlaySettings, PluginFolderChoice, PluginGame, PluginShowFileResult, RecordingHealth, ScaffoldStatus, SettingsView,
  SourceSelection, UnitProfiles} from '../../../packages/contracts/src';
import {SettingsBusyError, SettingsError, SettingsStore, settingsDirectory} from './settings-store';
import {isUnitGame, isUnitProfile} from './unit-profiles';
import {isAppLanguage} from './settings-schema';
import {processEntrypoint} from './entrypoints';
import {BUNDLE_FLUSH_MS, createDiagnostics, MAIN_EXIT_FLUSH_MS, type DiagnosticFacts} from './diagnostics';
import {mainLogLocation, serviceEnvironment} from './log-location';
import {ServiceSupervisor} from './service-supervisor';
import {ServiceHeartbeatMonitor} from './service-heartbeat';
import {initialLive, sourceSelection} from './live-state';
import {createBrokerResolver} from './broker-artifact';
import {RecoveryBudget} from './recovery-budget';
import {LiveSubscriptions} from './live-subscriptions';
import {LiveFreshness} from './live-freshness';
import {parseLiveV1} from './live-v1';
import {OVERLAY_TOPMOST_LEVEL, OverlayController} from './overlay-controller';
import {overlayPresentation} from './overlay-presentation';
import {latencyEnabled, OverlayLatency} from './overlay-latency';
import {observeLatencyFrames} from './latency-frames';
import {overlayWindowSize} from './overlay-geometry';
import {isOverlayLayout, parseOverlaySections} from './overlay-sections';
import {isOverlayEditOutcome, parseOverlayEditScale, type OverlayEditOutcome} from './overlay-placement';
import {OwnForegroundGate} from './overlay-edit';
import {captureActivation, type CaptureGrant} from './capture-activation';
import {monitorEventLoopLag} from './event-loop-lag';
import {ExitCoordinator, isUninstallExitPayload, secondInstanceAction, type ExitReason} from './app-lifecycle';
import {failureCode, initialHealth, reduceHealth, sameHealth, type HealthEvent} from './app-health';
import {addLosses, parseRecordingHealth, recordingFacts, sameRecording, ZERO_LOSSES} from './recording-status';
import {TrayPresenter, type TrayMenuItem} from './tray-model';
import {JournalBroker} from './journal-broker';
import {JOURNAL_CHANNELS, JOURNAL_EXPORT_CHANNEL, journalRequest, type JournalChannelKind} from './journal-contract';
import {EXPORT_DIALOG_FILTERS, JournalExporter} from './journal-export-writer';
import {isJournalUuid} from '../../../packages/contracts/src/journal';
import {TRAY_ICON_REPRESENTATIONS, trayIconPng, type TrayTone} from './tray-icon';
import {pluginSetupMode} from './plugin-setup/mode';
import {PluginSetup, PluginSetupError, productionPluginSetupPorts} from './plugin-setup/plugin-setup';
import {DIAGNOSTICS_EXPORT_CHANNEL, isPluginGame, isPluginTargetId, PLUGIN_CHANNELS} from './plugin-setup-contract';
import {connectionDiagnosis} from './connection-diagnosis';
import {buildDiagnosticBundle, readDiagnosticLogs, readFileTail} from './diagnostic-bundle';
import {DiagnosticBundleExporter} from './diagnostic-bundle-writer';
import {cancelDeferralOnStart, EXIT_CODES, parseSquirrelArgs, prepareSquirrelProcess, productionSquirrelPorts, runSquirrelEvent} from './squirrel-events';
import {checkRunningGames} from './plugin-setup/game-processes';
import {pluginBundleDirectory, readPluginBundle} from './plugin-setup/plugin-bundle';
import {APP_UNINSTALL_FAILSAFE_MS, APP_UNINSTALL_WIPE_BUDGET_MS, AppUninstall, uninstallWipeBudget, type AppUninstallPorts} from './uninstall/app-uninstall';
import {resolveUninstallRoots} from './uninstall/roots';
import {UNINSTALL_CHANNEL} from './uninstall-contract';
import {finishedUninstallText, handoverFailedText} from './uninstall-text';
import {UNINSTALL_STRINGS} from './strings';

// ET-018 (U2): a Squirrel event runs first and alone, before the profile override, logs, settings, plugin setup and the
// service. Unpackaged, the first argument after the executable is the application path.
const squirrelArgs = parseSquirrelArgs(process.argv.slice(app.isPackaged ? 1 : 2));
if (squirrelArgs.kind !== 'none') {
  // Before anything else: no GPU or network-service child process may outlive this process (Squirrel deletes the folder).
  prepareSquirrelProcess(app);
  void runSquirrelEvent(squirrelArgs, productionSquirrelPorts({app, appVersion: version, executable: process.execPath, env: process.env, mainDirectory: __dirname,
    resourcesPath: process.resourcesPath})).then(code => app.exit(code), () => app.exit(EXIT_CODES.refused));
} else {
  // The diagnostic profile override must precede the single-instance lock, which Electron keys by userData.
  let profileError: unknown;
  try {
    const profile = process.env.ETS2TELEMETRY_PROFILE_DIR;
    if (profile) {
      if (!path.isAbsolute(profile)) throw new Error('Diagnostic profile must be absolute');
      mkdirSync(profile, {recursive: true}); app.setPath('userData', profile); app.setPath('sessionData', profile);
    }
  } catch (error) {profileError = error;}
  // A second launch hands over to the running instance and exits 0 before any log, listener, service or window.
  // A failed profile override never requests the lock: it must not signal the real instance, only fail.
  if (profileError === undefined && !app.requestSingleInstanceLock()) app.quit();
  else runApplication(profileError);
}

/** Whether `child` is `parent` or lies inside it (case-insensitive, Windows paths). */
function isInsideFolder(child: string, parent: string): boolean {
  const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
  return normal(child) === normal(parent) || normal(child).startsWith(`${normal(parent)}\\`);
}

/** The names the diagnostic bundle replaces: the Windows user name and computer name as this process sees them. */
function diagnosticIdentities(): (string | undefined)[] {
  let user: string | undefined;
  try {user = os.userInfo().username;} catch {user = undefined;}
  let host: string | undefined;
  try {host = os.hostname();} catch {host = undefined;}
  return [user, host, process.env.USERNAME, process.env.COMPUTERNAME, process.env.USERDOMAIN];
}

function runApplication(profileError: unknown): void {
  const diagnosticDirectory = process.env.ETS2TELEMETRY_DIAGNOSTIC_DIR;
  // Resolved once; the telemetry service gets this root at fork, so both logs share it, also without LOCALAPPDATA. The
  // diagnostic bundle (ET-017 P17) reads this directory's startup logs and its `service` subdirectory's.
  const logLocation = mainLogLocation(process.env, app.getPath('userData'));
  const log = createDiagnostics(logLocation.directory, logLocation.detailed);
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
  // Settings load in parallel with the service start and never write. The store's view is the only settings state in
  // main; it changes only after a durable save or when a startup read that outlasted its budget is applied. The first
  // windows open after the load returned (at most 1000 ms), if need be with defaults in the read-only `loading` state.
  const settingsStore = new SettingsStore(settingsDirectory(process.env.LOCALAPPDATA), {log, changed: () => settingsChanged()});
  const settingsLoad = settingsStore.load().then(() => undefined, (error: unknown) => {log('SETTINGS_LOAD_REJECTED', String(error));});
  let window: BrowserWindow | undefined, service: UtilityProcess | undefined, status: ScaffoldStatus | undefined;
  let subscribed = false, serviceReady = false;
  // First readiness creates the dashboard and overlay once; later service restarts never recreate them.
  let started = false;
  let overlay: BrowserWindow | undefined, overlayController: OverlayController | undefined;
  let dashboardPort: MessagePortMain | undefined, overlayPort: MessagePortMain | undefined, upstream: MessagePortMain | undefined;
  let upstreamRecovery: ReturnType<typeof setTimeout> | undefined;
  let tray: Tray | undefined, trayPresenter: TrayPresenter | undefined, trayUnavailable = false;
  const hardMode = new HardModeServiceCache();
  function retireHardMode(): void {hardMode.retire();}
  let health: AppHealth = initialHealth(), appStateSubscribed = false, lastLive: LiveTelemetry = initialLive();
  let failureReported = false, reportedFailureCode: unknown;
  // ET-015c (G4, G6, G12): the service whose recording status main accepts, until it fails, exits or restarts; the
  // committed losses of every earlier service process; and the latest losses the current one reported.
  let recordingChild: UtilityProcess | undefined, lossBase = ZERO_LOSSES, childLosses = ZERO_LOSSES, rejectedRecording = 0;
  let lastKnownRecordingStatus: RecordingHealth | undefined;
  /** Stops accepting the current service's recording status and adds its losses to the totals; repeated calls add nothing. */
  function retireRecording(): void {recordingChild = undefined; lossBase = addLosses(lossBase, childLosses); childLosses = ZERO_LOSSES; lastKnownRecordingStatus = undefined;}
  // ET-016 (J4): journal reads go to the current ready service, attached at readiness and retired with it.
  const journal = new JournalBroker({log});
  // ET-016 PR-5 (J16): one trip export at a time. Main owns the Save dialog and the file writer; the renderer gets fixed
  // codes and row counts only. The dialog belongs to the dashboard window; without one the export is cancelled.
  const exporter = new JournalExporter({log, read: query => journal.request(query), localAppData: process.env.LOCALAPPDATA, appVersion: version,
    documents: () => app.getPath('documents'),
    showSaveDialog: defaultPath => window && !window.isDestroyed()
      ? dialog.showSaveDialog(window, {defaultPath, filters: EXPORT_DIALOG_FILTERS.map(filter => ({name: filter.name, extensions: [...filter.extensions]}))})
      : Promise.resolve({canceled: true})});
  // ET-017 PR-6 (P17): one diagnostic bundle export at a time, through the same Save dialog of the dashboard window and
  // the same target checks as the trip export. The bundle is built only after an allowed file was chosen; nothing is
  // uploaded, and the renderer gets a fixed outcome only.
  const diagnosticsExporter = new DiagnosticBundleExporter({log, localAppData: process.env.LOCALAPPDATA, documents: () => app.getPath('documents'),
    showSaveDialog: defaultPath => window && !window.isDestroyed()
      ? dialog.showSaveDialog(window, {defaultPath, filters: EXPORT_DIALOG_FILTERS.map(filter => ({name: filter.name, extensions: [...filter.extensions]}))})
      : Promise.resolve({canceled: true}),
    build: async () => {
      const state = appState();
      return buildDiagnosticBundle({createdMs: Date.now(), app: {version, electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged, osRelease: os.release()},
        health: state.health, settings: state.settings, plugins: state.plugins, live: {status: lastLive.status, selection: lastLive.selection},
        diagnosis: connectionDiagnosis(state.plugins, lastLive.status, lastLive.selection, state.health), logs: await log.flush(BUNDLE_FLUSH_MS).then(() => readDiagnosticLogs(logLocation.directory, readFileTail)),
        identities: diagnosticIdentities()});
    }});
  // ET-017 (P13-P16): silent plugin setup. The mode gate is decided once from the launch environment (P15); the disabled
  // mode, which every isolated or development launch gets, reads and writes nothing. Changes reach the dashboard through
  // the existing app:state push.
  const pluginDecision = pluginSetupMode(process.env, app.isPackaged);
  const pluginSetup = new PluginSetup({decision: pluginDecision, log, changed: () => pushAppState(),
    ports: pluginDecision.mode === 'disabled' ? undefined : productionPluginSetupPorts({mainDirectory: __dirname, resourcesPath: process.resourcesPath,
      packaged: app.isPackaged, localAppData: process.env.LOCALAPPDATA, installDirectory: path.dirname(app.getPath('exe')), log})});
  // ET-018 PR-4 (U8): the in-app uninstall. Main owns both dialogs; the dashboard gets fixed codes and target ids only.
  // The smoke-only dialog seam (`ets2telemetry:diagnostic-uninstall-dialogs` below) answers both dialogs in isolated smokes.
  let uninstallDialogs: {confirm: boolean} | undefined;
  let uninstallFailsafe: ReturnType<typeof setTimeout> | undefined;
  /** When the failsafe fires, on performance.now(); the wipe ends a margin before it. */
  let uninstallFailsafeAt: number | undefined;
  const uninstallFs = nodeFsPromises as unknown as AppUninstallPorts['fs'];
  const appUninstall = new AppUninstall({
    resolveRoots: () => resolveUninstallRoots({executable: process.execPath, env: process.env, fs: uninstallFs}),
    confirm: async () => {
      if (uninstallDialogs) {timeline?.('DIAGNOSTIC_UNINSTALL_DIALOG', {dialog: 'confirm', answer: uninstallDialogs.confirm ? 'uninstall' : 'cancel'}); return uninstallDialogs.confirm;}
      if (!window || window.isDestroyed()) return false;
      const answer = await dialog.showMessageBox(window, {type: 'warning', title: UNINSTALL_STRINGS.confirmTitle, message: UNINSTALL_STRINGS.confirmMessage,
        detail: UNINSTALL_STRINGS.warning.join('\n'), buttons: [UNINSTALL_STRINGS.confirmCancel, UNINSTALL_STRINGS.confirmUninstall], defaultId: 0, cancelId: 0, noLink: true});
      return answer.response === 1;
    },
    fs: uninstallFs,
    checkRunning: signal => checkRunningGames({signal}),
    readKnown: async () => {
      const read = await readPluginBundle(pluginBundleDirectory(__dirname, process.resourcesPath, app.isPackaged));
      return read.ok ? [read.bundle.sha256, ...read.bundle.known.map(entry => entry.sha256)] : [];
    },
    setup: {suspend: () => pluginSetup.suspend(), resume: () => pluginSetup.resume(), targetIdFor: (game, root) => pluginSetup.targetIdFor(game, root)},
    clock: () => performance.now(),
    log: (event, facts) => log(event, undefined, facts),
    // Windows' uninstall removes the program files and the registration; its hook finds the data already gone.
    startWindowsUninstall: installRoot => new Promise<boolean>(resolve => {
      try {
        const child = spawn(path.win32.join(installRoot, 'Update.exe'), ['--uninstall'], {detached: true, stdio: 'ignore', windowsHide: true});
        child.once('spawn', () => {child.unref(); resolve(true);});
        child.once('error', () => resolve(false));
      } catch {resolve(false);}
    })
  });
  /** After the exit: the data wipe, the result dialog, then Windows' uninstall. No log row is written once the wipe ran
   * while the log folder lies in the data root, so nothing recreates it. The wipe gets only what is left before the 12 s
   * failsafe, less the handover margin, so a slow exit shortens the wipe instead of letting the failsafe cut it; the
   * failsafe is disarmed only here. What a short wipe leaves, Windows' uninstall finishes from the intent. */
  async function completeAppUninstall(): Promise<void> {
    const prepared = appUninstall.prepared!;
    const finished = await appUninstall.finishAfterExit(uninstallFailsafeAt === undefined ? APP_UNINSTALL_WIPE_BUDGET_MS
      : uninstallWipeBudget(uninstallFailsafeAt, performance.now()));
    clearTimeout(uninstallFailsafe); uninstallFailsafe = undefined;
    const logOutside = !isInsideFolder(logLocation.directory, prepared.dataRoot);
    if (finished && logOutside) log('APP_UNINSTALL_FINISHED', undefined, {removed: finished.removed, kept: finished.data.kept, failed: finished.data.failed.length,
      rootRemoved: finished.data.rootRemoved, notes: finished.notes.length});
    if (finished) {
      const text = finishedUninstallText(finished);
      if (uninstallDialogs) {if (logOutside) timeline?.('DIAGNOSTIC_UNINSTALL_DIALOG', {dialog: 'result', rootRemoved: finished.data.rootRemoved, failed: finished.data.failed.length});}
      else await dialog.showMessageBox({type: finished.data.failed.some(entry => entry.code !== 'BUDGET_EXPIRED') ? 'warning' : 'info', title: text.title, message: text.message, detail: text.detail, buttons: ['OK'], noLink: true}).catch(() => undefined);
    }
    const started = await appUninstall.handOver();
    if (!started) {
      if (logOutside) log('APP_UNINSTALL_HANDOFF_FAILED');
      if (!uninstallDialogs) await dialog.showMessageBox({type: 'error', title: UNINSTALL_STRINGS.spawnFailedTitle, message: handoverFailedText(finished), buttons: ['OK'], noLink: true}).catch(() => undefined);
    }
    app.exit(0);
  }
  /** The in-app uninstall's exit: the explicit exit with reason `uninstall`, under a 12 s failsafe until the result dialog. */
  function beginUninstallExit(): void {
    uninstallFailsafeAt = performance.now() + APP_UNINSTALL_FAILSAFE_MS;
    uninstallFailsafe = setTimeout(() => {
      // A row in a log folder inside the data root could recreate it during the wipe; only a diagnostic folder records it.
      const prepared = appUninstall.prepared;
      if (prepared && !isInsideFolder(logLocation.directory, prepared.dataRoot)) log('APP_UNINSTALL_FAILSAFE');
      app.exit(1);
    }, APP_UNINSTALL_FAILSAFE_MS);
    requestExit('uninstall');
  }
  const upstreamBudget = new RecoveryBudget(), overlayBudget = new RecoveryBudget();
  const dashboardSubscriptions = new LiveSubscriptions(initialLive(), 1);
  // The last projection main published: a non-current projection keeps its shape (ET-012a decision L5).
  let lastOverlay = overlayPresentation(initialLive());
  const overlaySubscriptions = new LiveSubscriptions<OverlayPresentation>(lastOverlay, 1, 500);
  // ET-012b: the overlay edit mode lives in main's memory only; every start is in driving mode (decision M5).
  let overlayEdit: OverlayEditState = {active: false};
  const latency = latencyEnabled(process.env) ? new OverlayLatency(diagnosticDirectory!, request => {
    if (!service || !serviceReady || supervisor.stopping) throw new Error('Service unavailable');
    service.postMessage(request);
  }, (code, error) => log(code, error)) : undefined;
  function publishOverlay(live: LiveTelemetry, units: UnitProfiles, settings: OverlaySettings, language: AppLanguage = settingsStore.view().language): void {
    lastOverlay = overlayPresentation(live, units, settings, lastOverlay, overlayEdit.active, language);
    if (latency) lastOverlay = latency.project(lastOverlay, live, Boolean(overlay && !overlay.isDestroyed() && overlay.isVisible()));
    overlaySubscriptions.publish(lastOverlay);
  }
  const freshness = new LiveFreshness(update => {
    const view = settingsStore.view();
    dashboardSubscriptions.publish(update); publishOverlay(update, view.units, view.overlay, view.language); overlayController?.update(update);
    lastLive = update; presentTray();
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
  let selectionDispatched = false;
  function commitSelection(next: SourceSelection, origin: 'startup' | 'user' | 'restore'): void {
    const previous = selection;
    selection = next;
    if (selectionDispatched && previous !== next) log('SOURCE_SELECTION_RETIRED', undefined, {source: previous, origin});
    selectionDispatched = true;
    log('SOURCE_SELECTED', undefined, {source: next, origin});
  }
  const heartbeatMonitor = new ServiceHeartbeatMonitor({
    onTimeout: () => {
      log('SERVICE_HEARTBEAT_TIMEOUT');
      timeline?.('SERVICE_HEARTBEAT_TIMEOUT');
      updateHealth({type: 'recording', status: {state: 'unknown'}});
      freshness.invalidate({...initialLive(selection), status: 'stale', reason: 'Telemetry service heartbeat missed; current interval is unknown'});
    },
    onResume: () => {
      log('SERVICE_HEARTBEAT_RESUMED');
      timeline?.('SERVICE_HEARTBEAT_RESUMED');
      if (lastKnownRecordingStatus) updateHealth({type: 'recording', status: lastKnownRecordingStatus});
    }
  });
  const lifecycle = new ExitCoordinator({
    log,
    // A running trip export stops first, so a journal read that the retirement answers ends it as interrupted (J16).
    // ET-017: plugin setup stops after its current game folder; no new run, poll or trigger starts.
    begin: () => {latency?.finish('exit'); exporter.abort(); diagnosticsExporter.abort(); pluginSetup.abort(); heartbeatMonitor.stop(); updateHealth({type: 'exit-requested'}, true); retireLive();},
    stopService: () => supervisor.stop(),
    // An in-flight settings save, the removal of an interrupted trip or diagnostics export's partial file and the plugin setup run in flight
    // (which ends with the removal of its temporary file) may delay the final exit by at most EXIT_IDLE_BUDGET_MS
    // (1000 ms) together.
    idle: () => {
      const pending = [latency?.idle(), settingsStore.idle(), exporter.idle(), diagnosticsExporter.idle(), pluginSetup.idle()].filter((work): work is Promise<void> => work !== undefined);
      return pending.length > 1 ? Promise.all(pending).then(() => undefined) : pending[0];
    },
    destroyTray: () => {trayPresenter?.dispose(); const previous = tray; tray = undefined; previous?.destroy();},
    // The final rows (SERVICE_EXIT, APP_EXIT) are on disk before the process ends: the append in flight gets up to
    // MAIN_EXIT_FLUSH_MS, the queue is then written synchronously, and later rows are written at once.
    exit: code => {void log.finalize(MAIN_EXIT_FLUSH_MS).then(() => appUninstall.prepared ? completeAppUninstall() : app.exit(code));}
  });
  const supervisor = new ServiceSupervisor(log, code => lifecycle.finish(code), {
    restart: () => startService(),
    state: state => {heartbeatMonitor.stop(); serviceReady = false; retireHardMode(); selectionPending = false; status = undefined; closeUpstream(); retireRecording(); journal.retire();
      if (state === 'service-failed') {updateHealth({type: 'service-exited', afterFailure: failureReported}); failureReported = false;}
      else updateHealth({type: 'service-restarting'});
      const update: LiveTelemetry = {...initialLive(selection), status: state, reason: 'Telemetry service exited; current interval is unknown'};
      freshness.invalidate(update); dashboardSubscriptions.close(); dashboardPort = undefined; window?.webContents.send('telemetry:service-state', update);},
    // A service that failed or exited before its first readiness completed (the readiness was retired while awaiting its
    // broker or settings) never created the windows; create them now, so the dashboard shows the exhausted state and
    // the tray and a second launch can open it (ET-016 PR-3 delta review).
    exhausted: () => {heartbeatMonitor.stop(); retireRecording(); journal.retire(); updateHealth({type: 'service-restart-exhausted'});
      if (!started && !supervisor.stopping && !lifecycle.exiting) {started = true; createWindow(); createOverlay();}
      const update: LiveTelemetry = {...initialLive(selection), status: 'service-failed', reason: 'Automatic service restart limit reached'};
      freshness.invalidate(update); window?.webContents.send('telemetry:service-state', update);},
    // Every stop that did not start as an exit request is fatal (renderer or overlay exhaustion, configuration or
    // load failure, recovery timeout, ...): mark the application exiting at once so nothing reopens a window, the
    // overlay may close and the tray shows the exiting state. Exit codes and bounds are unchanged.
    // A running trip export ends as interrupted before it opens a file (J16), also on a fatal stop.
    stopping: () => {latency?.finish('service-stop'); heartbeatMonitor.stop(); exporter.abort(); diagnosticsExporter.abort(); pluginSetup.abort(); if (lifecycle.abort()) {updateHealth({type: 'exit-requested'}, true); retireLive();}},
    // The failed service is being terminated: retire its readiness, status and live channels now rather than when
    // its exit arrives (up to 3000 ms later). The later state callback finds them already retired.
    // A new selection generation also retires a readiness still awaiting its broker or settings, so the failing service
    // never becomes ready, selected or the journal's service afterwards (ET-016 PR-3 review).
    failure: code => {heartbeatMonitor.stop(); failureReported = true; serviceReady = false; retireHardMode(); selectionPending = false; status = undefined; selectionGeneration++; closeUpstream(); retireRecording(); journal.retire();
      updateHealth({type: 'service-failure', code: failureCode(code, reportedFailureCode)}); reportedFailureCode = undefined;
      const update: LiveTelemetry = {...initialLive(selection), status: 'restarting', reason: 'Telemetry service failed; current interval is unknown'};
      freshness.invalidate(update); dashboardSubscriptions.close(); dashboardPort = undefined; window?.webContents.send('telemetry:service-state', update);}
  });
  function appState(): AppState {return {health: {...health}, settings: settingsStore.view(), overlayEdit, plugins: pluginSetup.view()};}
  function pushAppState(): void {if (appStateSubscribed && window && !window.isDestroyed()) window.webContents.send('app:state', appState());}
  function updateHealth(event: HealthEvent, immediate = false): void {
    const next = reduceHealth(health, event);
    if (sameHealth(next, health)) return;
    // ET-015c PR-4: the opt-in smoke timeline records every recording status change, so the runtime journey can prove
    // states shorter than any poll (fixed enums and counts only; never in default logs).
    if (timeline && !sameRecording(next.recording, health.recording)) timeline('RECORDING_STATUS', recordingFacts(next.recording));
    health = next;
    pushAppState();
    presentTray(immediate);
  }
  // A saved unit profile or overlay setting, or a late startup read being applied, pushes the settings view and
  // republishes main's stored freshness output in the current units, layout and sections, then re-places the overlay
  // for its layout and saved placement. It accepts no observation and renews no SDK or window authority: freshness and
  // its expiry timers are untouched, and the placement uses the last observation the controller already holds.
  function settingsChanged(): void {
    const view = settingsStore.view();
    // Pending defaults are not the saved visibility; wait for the read result or existing read-limit fallback.
    const enabled = view.state !== 'loading' && view.overlay.enabled;
    // Disable before edit cancellation; enable only after the final committed geometry is installed.
    if (!enabled && overlayEdit.active) timeline?.('OVERLAY_EDIT_CANCELLED', {reason: 'overlay-disabled'});
    if (!enabled) overlayController?.setEnabled(false);
    pushAppState();
    if (lifecycle.exiting) return;
    presentTray(true);
    publishOverlay(lastLive, view.units, view.overlay, view.language);
    overlayController?.setLayout(view.overlay.layout, view.overlay.placements[view.overlay.layout], view.overlay.sections);
    if (enabled) overlayController?.setEnabled(true);
  }
  // ET-012b edit mode. The controller reports every change of its edit state; main pushes it to the dashboard and,
  // when the mode itself changes, republishes the overlay projection with its `editing` flag (no authority renewed).
  const focusGate = new OwnForegroundGate(foreground => overlayController?.setOwnForeground(foreground));
  function overlayEditChanged(state: OverlayEditState): void {
    const toggled = state.active !== overlayEdit.active;
    overlayEdit = state;
    if (!state.active) focusGate.stop();
    pushAppState();
    if (toggled && !lifecycle.exiting) {const view = settingsStore.view(); publishOverlay(lastLive, view.units, view.overlay, view.language);}
  }
  /** True while the dashboard or the overlay window has the keyboard focus. */
  function ownFocused(): boolean {
    return Boolean((window && !window.isDestroyed() && window.isFocused()) || (overlay && !overlay.isDestroyed() && overlay.isFocused()));
  }
  function focusChanged(): void {if (overlayEdit.active) focusGate.update(ownFocused());}
  /** Leaves edit mode (hidden and click-through again first) and returns the draft; nothing is written here. */
  function endOverlayEdit(): ReturnType<OverlayController['endEdit']> {
    focusGate.stop();
    return overlayController?.endEdit();
  }
  /** Discards an active edit without writing (decision M5); a no-op in driving mode. */
  function cancelOverlayEdit(reason: string): void {
    if (!overlayEdit.active) return;
    timeline?.('OVERLAY_EDIT_CANCELLED', {reason});
    endOverlayEdit();
  }
  /**
   * Done/Enter and Cancel/Esc (decision M11): edit mode ends first, so the overlay is hidden and click-through before
   * anything is written. A save then persists the draft through the shared settings queue and applies it only after the
   * durable write; a failed save keeps the previous placement and reports `saveError`. Cancel writes nothing.
   */
  async function finishOverlayEdit(outcome: OverlayEditOutcome): Promise<SettingsView> {
    if (lifecycle.exiting) throw new Error('Overlay edit request was retired');
    if (!overlayEdit.active) throw new Error('Overlay edit mode is not active');
    const layout = overlayEdit.layout, draft = endOverlayEdit();
    timeline?.('OVERLAY_EDIT_FINISHED', {outcome});
    if (outcome === 'cancel' || !draft) return settingsStore.view();
    return saveSettings(() => settingsStore.setOverlayPlacement(layout, draft));
  }
  function presentTray(immediate = false): void {
    trayPresenter?.update({health, exiting: lifecycle.exiting, source: {selection: lastLive.selection, status: lastLive.status}, language: settingsStore.view().language}, immediate);
  }
  // The overlay is marked not loaded first, so an edit in progress hides it before the edit is cancelled; that order avoids
  // a needless show on the retired document.
  function retireOverlay(): void {latency?.retire(); overlayPort = undefined; overlayController?.loaded(false); cancelOverlayEdit('overlay-retired'); overlaySubscriptions.close();}
  // Exits and fatal stops also retire the journal: pending journal requests resolve SERVICE_UNAVAILABLE (ET-016, J4).
  function retireLive(): void {freshness.close(); closeUpstream(); retireOverlay(); dashboardSubscriptions.close(); dashboardPort = undefined; journal.retire();}
  function stop(): void {retireLive(); supervisor.stop();}
  function fail(code: string, error?: unknown): void {retireLive(); supervisor.fail(code, error);}
  function requestExit(reason: ExitReason): void {lifecycle.request(reason);}
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
  // ET-010c decision F2: the v1 projection must match the update's selection and pass strict validation. A rejected
  // projection is logged at its occurrences 1, 2, 4, 8, ... and dropped; the v0 update and the channel are unaffected.
  let rejectedV1 = 0;
  function acceptedV1(update: LiveTelemetry): LiveTelemetry {
    if (update.v1 === undefined || parseLiveV1(update.v1, update.selection)) return update;
    const count = ++rejectedV1;
    if ((count & (count - 1)) === 0) log('LIVE_V1_REJECTED', undefined, {count});
    const stripped = {...update}; delete stripped.v1;
    return stripped;
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
      // The single typed utilityProcess publisher is trusted; renderers never reach this port. Its protocol v1 projection
      // is still validated here, before freshness and the overlay see it: an invalid one is stripped, never the update.
      if (!selectionPending && data.update.selection === selection) freshness.accept(acceptedV1(data.update));
      try {if (upstream === port1) port1.postMessage({type: 'consumed', delivery: data.delivery});} catch {lost();}
    });
    try {port1.start(); child.postMessage({type: 'subscribe'}, [port2]);} catch (error) {port2.close(); lost(); log('MAIN_SUBSCRIPTION_FAILED', String(error));}
  }
  function createOverlay(): void {
    // Created at the saved layout's size for its saved scale and sections: the strip as high as its sections need
    // (ET-012c), the card, cluster and HUD at least their nominal size times the scale and taller when their sections
    // need more rows (ET-012d). The controller sets the actual bounds inside the game's client area. The scale is also
    // the document's zoom factor (ET-012b decision M4); the overlay's own session keeps that zoom away from the
    // dashboard, whose file:// origin it would otherwise share.
    const settings = settingsStore.view(), layout = settings.overlay.layout, placement = settings.overlay.placements[layout];
    const size = overlayWindowSize(layout, placement.scale, settings.overlay.sections);
    const created = overlay = new BrowserWindow({width: size.width, height: size.height, show: false, frame: false,
      transparent: true, backgroundColor: '#00000000',
      focusable: false, skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      // A dedicated in-memory session separates the overlay's browser context from the dashboard.
      webPreferences: {partition: 'ets2telemetry-overlay', preload: path.join(__dirname, 'overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
        zoomFactor: placement.scale}});
    timeline?.('OVERLAY_WINDOW_CREATED'); observeLoads(created.webContents, 'OVERLAY');
    if (latency) {
      const frames = observeLatencyFrames(created, latency, () => lastOverlay.freshness === 'current' && !lastOverlay.paused && !overlayEdit.active,
        error => log('OVERLAY_LATENCY_FRAME_FAILED', String(error)), facts => log('OVERLAY_LATENCY_CAPTURE_AVAILABLE', facts));
      latency.setFrameStats(() => frames.stats);
    }
    created.setIgnoreMouseEvents(true); created.setFocusable(false);
    // Not the constructor's alwaysOnTop: its default `floating` level stacks the overlay behind the
    // taskbar, which drops WS_EX_TOPMOST while a borderless full-screen game is foreground.
    created.setAlwaysOnTop(true, OVERLAY_TOPMOST_LEVEL);
    overlayController = new OverlayController(created, screen, phase => log('OVERLAY_TOPMOST_RESTORED', undefined, {phase}), layout,
      {enabled: settings.state !== 'loading' && settings.overlay.enabled, placement, sections: settings.overlay.sections, editChanged: overlayEditChanged});
    created.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    created.webContents.on('will-navigate', event => event.preventDefault());
    // A loaded document starts at the default zoom; the scale in use applies again.
    created.webContents.on('did-finish-load', () => overlayController?.restoreZoom());
    // ET-012b edit mode (decisions M6, M8 and M9). Focus feeds the own-foreground gate. A drag of the edit overlay's
    // native drag region holds placement until it ends; the dropped DIP bounds become clamped fractions and the window
    // snaps inside the client area. Keys never reach the overlay document: in edit mode Enter saves and Escape cancels.
    // The system menu of the drag region is never shown. Outside edit mode the window is not movable or focusable.
    created.on('focus', focusChanged); created.on('blur', focusChanged);
    created.on('will-move', () => overlayController?.moveStarted());
    created.on('moved', () => {if (!created.isDestroyed()) overlayController?.moved(created.getBounds());});
    created.on('system-context-menu', event => event.preventDefault());
    created.webContents.on('before-input-event', (event, input) => {
      event.preventDefault();
      if (!overlayEdit.active || input.type !== 'keyDown') return;
      if (input.key === 'Enter') void finishOverlayEdit('save').catch(() => undefined);
      else if (input.key === 'Escape') void finishOverlayEdit('cancel').catch(() => undefined);
    });
    const retire = () => retireOverlay();
    created.webContents.on('did-start-loading', retire);
    // The replaced document runs until the new one commits, behind the same trusted WebFrameMain, and its
    // recovery timer can re-subscribe meanwhile. Commit precedes the new document's IPC, so retire that port again.
    created.webContents.on('did-navigate', () => {if (overlayPort) log('OVERLAY_PRECOMMIT_SUBSCRIPTION_RETIRED'); retire();});
    created.webContents.on('render-process-gone', (_event, details) => {
      retire(); log('OVERLAY_RENDER_PROCESS_GONE', details);
      if (!supervisor.stopping && overlayBudget.take() !== undefined) loadOverlay(); else fail('OVERLAY_RESTART_EXHAUSTED');
    });
    // The overlay lives as long as the application: it outlasts the main window and closes only on exit.
    created.on('close', event => {if (!lifecycle.exiting) event.preventDefault();});
    created.on('session-end', () => requestExit('session-end'));
    created.on('closed', () => {retire(); overlay = undefined; overlayController = undefined; if (!supervisor.stopping) stop();});
    const changed = () => overlayController?.topologyChanged();
    screen.on('display-added', changed); screen.on('display-removed', changed); screen.on('display-metrics-changed', changed);
    // The first delivery to the new document already carries the saved layout and sections.
    publishOverlay(lastLive, settings.units, settings.overlay);
    loadOverlay();
  }
  function loadOverlay(): void {
    void overlay!.loadFile(path.join(__dirname, 'renderer', 'index.html'), {query: {view: 'overlay'}}).catch(error => fail('OVERLAY_LOAD_FAILED', error));
  }
  // Retires only dashboard document state. Upstream, freshness, the overlay and the service are unaffected; an overlay
  // edit started from the retired document is cancelled without writing.
  function retireDashboard(): void {
    cancelOverlayEdit('dashboard-retired');
    rendererEpoch++; subscribed = false; appStateSubscribed = false; dashboardSubscriptions.close(); dashboardPort = undefined;
  }
  function createWindow(): void {
    const created = window = new BrowserWindow({width: 1280, height: 800, minWidth: 1100, minHeight: 720, title: 'Yukon Union Telemetry', titleBarStyle: 'hidden', titleBarOverlay: {color: '#0B1120', symbolColor: '#D1D5DB', height: 32}, webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
    timeline?.('DASHBOARD_WINDOW_CREATED'); observeLoads(created.webContents, 'DASHBOARD');
    created.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
    created.webContents.on('will-navigate', event => event.preventDefault());
    created.on('focus', focusChanged); created.on('blur', focusChanged);
    // Minimizing the dashboard ends an edit without saving, as closing it to the tray does: edit mode suppresses the
    // driving overlay, which would otherwise stay hidden over the game until the dashboard came back (ET-012b M5).
    created.on('minimize', () => {if (window === created) cancelOverlayEdit('dashboard-minimized');});
    const retireDocument = () => {if (window === created) retireDashboard();};
    created.webContents.on('did-start-loading', retireDocument);
    // As for the overlay: a subscription made before commit belongs to the replaced document. Left in place,
    // it would make main ignore the new document's subscribe request and leave the dashboard without data.
    created.webContents.on('did-navigate', () => {if (window !== created) return; if (subscribed) log('DASHBOARD_PRECOMMIT_SUBSCRIPTION_RETIRED'); retireDocument();});
    created.webContents.on('render-process-gone', (_event, details) => {
      if (window !== created) return;
      retireDashboard(); log('RENDER_PROCESS_GONE', details);
      if (!supervisor.stopping && rendererBudget.take() !== undefined) loadWindow(created); else fail('RENDERER_RESTART_EXHAUSTED');
    });
    // Close-to-tray: the window is destroyed and recreated on reopen; recording state lives outside it.
    // If creating the tray threw there is no tray way back, so closing minimizes instead. Electron does not report a
    // notification-area registration failure that does not throw; a second launch always reopens the dashboard.
    created.on('close', event => {if (!lifecycle.exiting && !tray) {event.preventDefault(); created.minimize();}});
    created.on('session-end', () => requestExit('session-end'));
    created.on('closed', () => {if (window !== created) return; retireDashboard(); window = undefined; timeline?.('DASHBOARD_WINDOW_CLOSED');});
    loadWindow(created);
  }
  function loadWindow(target: BrowserWindow): void {
    void target.loadFile(path.join(__dirname, 'renderer', 'index.html')).then(() => log('WINDOW_LOADED')).catch(error => {if (window === target) fail('WINDOW_LOAD_FAILED', error);});
  }
  // Shows the main window from the tray or a second launch. Never runs before first readiness or while exiting.
  function openDashboard(origin: 'tray' | 'second-instance'): void {
    const action = secondInstanceAction({exiting: lifecycle.exiting, started,
      dashboard: !window || window.isDestroyed() ? 'none' : window.isMinimized() ? 'minimized' : 'visible'});
    if (origin === 'second-instance') log('SECOND_INSTANCE', undefined, {action});
    else timeline?.('TRAY_OPEN', {action});
    if (action === 'created') {createWindow(); return;}
    if (action !== 'restored' && action !== 'focused') return;
    if (action === 'restored') window!.restore();
    window!.show(); window!.focus();
  }
  function trayImage(tone: TrayTone): Electron.NativeImage {
    const [first, ...rest] = TRAY_ICON_REPRESENTATIONS;
    const image = nativeImage.createFromBuffer(trayIconPng(first.size, tone), {scaleFactor: first.scaleFactor});
    for (const representation of rest) image.addRepresentation({scaleFactor: representation.scaleFactor, buffer: trayIconPng(representation.size, tone)});
    return image;
  }
  function trayMenu(items: TrayMenuItem[]): Electron.Menu {
    return Menu.buildFromTemplate(items.map(item => item.kind === 'separator' ? {type: 'separator' as const}
      : item.kind === 'status' ? {label: item.label, enabled: false}
        : {label: item.label, enabled: item.enabled, click: item.kind === 'open' ? () => openDashboard('tray') : () => requestExit('tray')}));
  }
  function createTray(): void {
    try {
      const created = tray = new Tray(trayImage('busy'));
      created.on('click', () => openDashboard('tray'));
      trayPresenter = new TrayPresenter({
        setToolTip: text => {if (tray === created) created.setToolTip(text);},
        setMenu: items => {if (tray === created) created.setContextMenu(trayMenu(items));},
        setTone: tone => {if (tray === created) created.setImage(trayImage(tone));}
      });
      presentTray(true);
    } catch (error) {
      tray = undefined; trayPresenter = undefined; trayUnavailable = true;
      log('TRAY_UNAVAILABLE', String(error));
    }
  }
  function startService(): void {
    if (supervisor.stopping) return;
    retireHardMode();
    const entrypoint = processEntrypoint(__dirname, 'telemetry-service');
    if (!existsSync(entrypoint)) throw new Error('Missing physical telemetry service entrypoint');
    const child = service = utilityProcess.fork(entrypoint, [], {serviceName: 'ETS2Telemetry telemetry service', stdio: 'pipe',
      env: {...serviceEnvironment(process.env, logLocation.directory), ETS2TELEMETRY_DOCUMENTS: app.getPath('documents')}});
    supervisor.attach(child); recordingChild = child; lastKnownRecordingStatus = undefined; heartbeatMonitor.start();
    child.stdout?.on('data', chunk => log('SERVICE_STDOUT', String(chunk)));
    child.stderr?.on('data', chunk => log('SERVICE_STDERR', String(chunk)));
    child.once('spawn', () => log('SERVICE_SPAWN', {pid: child.pid}));
    child.once('exit', code => {heartbeatMonitor.stop(); if (service === child) {service = undefined; supervisor.serviceExited(code);}});
    child.on('message', (message: unknown) => {
      if (supervisor.stopping || service !== child) return;
      heartbeatMonitor.touch();
      const type = message && typeof message === 'object' && !Array.isArray(message) ? (message as Record<string, unknown>).type : undefined;
      if (type === 'heartbeat') return;
      if (type === 'hard-mode') {
        hardMode.accept(message);
        return;
      }
      if (latency && type === 'overlay-latency-result') {latency.reply(message); return;}
      if (type === 'ready') {
        if (!supervisor.ready()) return;
        const requested = selection, generation = ++selectionGeneration;
        void (async () => {
          const broker = requested === 'ets2' || requested === 'ats' ? await selectedBroker(requested) : undefined;
          if (!settingsStore.settled) await settingsLoad;
          if (supervisor.stopping || service !== child || generation !== selectionGeneration) return;
          child.postMessage(selectMessage(requested, broker));
          commitSelection(requested, selectionDispatched ? 'restore' : 'startup');
          serviceReady = true; selectionPending = false; status = {service: 'ready', storage: 'verified', synthetic: true};
          journal.attach(child);
          updateHealth({type: 'service-ready'});
          if (!started) {started = true; createWindow(); createOverlay();} else connectSubscription();
          connectUpstream();
        })().catch(error => {if (!supervisor.stopping && service === child) fail('SERVICE_CONFIGURATION_FAILED', error);});
      } else if (type === 'failed') {
        // Before first readiness this stays fatal; afterwards the supervisor restarts the service.
        reportedFailureCode = (message as Record<string, unknown>).code;
        supervisor.serviceFailed('SERVICE_START_FAILED', message);
      } else if (type === 'recording') acceptRecording(child, message as Record<string, unknown>);
      // ET-016 (J4): a journal reply; the broker accepts it only from the current ready service for the request in flight.
      else if (type === 'journal') journal.reply(child, message as Record<string, unknown>);
      else if (type !== 'stopped') fail('SERVICE_INVALID_MESSAGE');
    });
  }
  /**
   * ET-015c (G4): a recording status from the current service, before or after its readiness, until it fails, exits or
   * restarts (retireRecording). Exactly {type, status} with a status that parseRecordingHealth accepts; anything else is
   * not fatal: the status becomes `unknown` and RECORDING_STATUS_REJECTED {count} is logged at counts 1, 2, 4, 8, ...
   * The reported losses are added to those of earlier service processes (G6); the status reaches the dashboard through
   * the existing app:state push and app:get-state, and the tray through its presenter.
   */
  function acceptRecording(child: UtilityProcess, message: Record<string, unknown>): void {
    if (recordingChild !== child) return;
    const keys = Object.keys(message);
    const parsed = keys.length === 2 && keys.includes('status') ? parseRecordingHealth(message.status) : undefined;
    if (!parsed) {
      const count = ++rejectedRecording;
      if ((count & (count - 1)) === 0) log('RECORDING_STATUS_REJECTED', undefined, {count});
      lastKnownRecordingStatus = undefined;
      updateHealth({type: 'recording', status: {state: 'unknown'}});
      return;
    }
    if (!('losses' in parsed)) {lastKnownRecordingStatus = parsed; updateHealth({type: 'recording', status: parsed}); return;}
    childLosses = parsed.losses;
    const combined: RecordingHealth = {...parsed, losses: addLosses(lossBase, parsed.losses)};
    lastKnownRecordingStatus = combined;
    updateHealth({type: 'recording', status: combined});
  }
  log('APP_START', {electron: process.versions.electron, node: process.versions.node, packaged: app.isPackaged});
  if (timeline) {
    monitorEventLoopLag(facts => timeline('MAIN_EVENT_LOOP_LAG', facts));
    // Observation only: an unexpected GPU or utility exit is recorded, not treated as a smoke failure here.
    app.on('child-process-gone', (_event, details) => timeline('CHILD_PROCESS_GONE', {type: details.type, reason: details.reason, exitCode: details.exitCode, name: details.name ?? null}));
  }
  process.on('uncaughtException', error => fail('UNCAUGHT_EXCEPTION', error));
  process.on('unhandledRejection', error => fail('UNHANDLED_REJECTION', error));
  // app.quit() (including Playwright's close) becomes the same orderly exit as the tray's Exit.
  app.on('before-quit', event => {event.preventDefault(); requestExit('app-quit');});
  // The tray keeps the application running after the last window closes; only an explicit exit ends it.
  app.on('window-all-closed', () => undefined);
  // The second process's argv and working directory are deliberately ignored. Its additional data is read for one exact
  // payload only: the Squirrel uninstall hook's request to run the explicit exit (ET-018 U6). Main deletes nothing for it;
  // every other payload only shows the dashboard, and an instance that is already exiting ignores both.
  app.on('second-instance', (_event, _argv, _cwd, additionalData) => {
    if (!isUninstallExitPayload(additionalData)) {openDashboard('second-instance'); return;}
    log('SECOND_INSTANCE', undefined, {action: lifecycle.exiting ? 'ignored-exiting' : 'uninstall-exit'});
    requestExit('uninstall');
  });
  if (process.env.ETS2TELEMETRY_LIVE_SMOKE === '1' && diagnosticDirectory && path.isAbsolute(diagnosticDirectory) && process.env.ETS2TELEMETRY_PROFILE_DIR && path.isAbsolute(process.env.ETS2TELEMETRY_PROFILE_DIR)) {
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-service-exit', () => {if (service && serviceReady && !supervisor.stopping) {log('DIAGNOSTIC_SERVICE_EXIT_REQUEST', {pid: service.pid}); service.kill();}});
    // Isolated smokes cannot click the notification area; this invokes the same handlers as the tray menu.
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-tray-action', (action: unknown) => {
      if (action === 'open') {timeline?.('DIAGNOSTIC_TRAY_ACTION', {action}); openDashboard('tray');}
      else if (action === 'exit') {timeline?.('DIAGNOSTIC_TRAY_ACTION', {action}); requestExit('tray');}
    });
    // ET-018 PR-4: answers the uninstall's confirmation ('uninstall' or 'cancel') and its result dialog in isolated smokes.
    // An app event: no renderer can reach it.
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-uninstall-dialogs', (answer: unknown) => {
      if (answer !== 'uninstall' && answer !== 'cancel') return;
      uninstallDialogs = {confirm: answer === 'uninstall'};
      timeline?.('DIAGNOSTIC_UNINSTALL_DIALOGS', {answer});
    });
    // Read-only lifecycle facts for the isolated smoke; it changes no state.
    (app as unknown as EventEmitter).on('ets2telemetry:diagnostic-lifecycle-state', (receive: unknown) => {
      if (typeof receive !== 'function') return;
      (receive as (state: unknown) => void)({started, exiting: lifecycle.exiting, serviceReady, servicePid: service?.pid ?? null,
        tray: Boolean(tray && !tray.isDestroyed()), trayUnavailable, dashboard: Boolean(window && !window.isDestroyed()),
        overlay: Boolean(overlay && !overlay.isDestroyed()), overlayChannel: Boolean(overlayPort), upstream: Boolean(upstream), health: {...health},
        settings: settingsStore.view()});
    });
  }
  if (profileError) fail('PROFILE_SETUP_FAILED', profileError);
  // A dashboard opened while the service restarts or after restart exhaustion gets `null`, not an error; it queries
  // again when the pushed health reports readiness. Untrusted senders still fail.
  ipcMain.handle('scaffold:status', event => {if (!trusted(event)) throw new Error('Untrusted status request'); return status ?? null;});
  for (const channel of ['hard-mode:status', 'hard-mode:refresh']) ipcMain.handle(channel, (event, ...request: unknown[]) => {
    if (!trusted(event) || request.length !== 0) throw new Error('Untrusted Hard Mode request');
    if (channel === 'hard-mode:refresh' && serviceReady && service && !supervisor.stopping) service.postMessage({type: 'hard-mode-refresh'});
    return hardMode.status(serviceReady && !supervisor.stopping);
  });
  ipcMain.handle('app:get-state', event => {if (!trusted(event)) throw new Error('Untrusted application state request'); return appState();});
  ipcMain.handle('app:exit', event => {if (!trusted(event)) throw new Error('Untrusted exit request'); requestExit('renderer');});
  ipcMain.on('app:subscribe-state', event => {
    if (!trusted(event)) return;
    appStateSubscribed = true; window!.webContents.send('app:state', appState());
  });
  ipcMain.on('app:unsubscribe-state', event => {if (trusted(event)) appStateSubscribed = false;});
  // Runs one validated settings save and applies its result only after the durable write. Shared by every settings
  // channel, so all of them map errors and refuse requests while exiting in the same way.
  async function saveSettings(save: () => Promise<SettingsView>): Promise<SettingsView> {
    if (lifecycle.exiting) throw new Error('Settings request was retired');
    try {
      const view = await save();
      settingsChanged();
      return view;
    } catch (error) {
      // The refusal lives in the settings view's `saveError`; the service's health and last problem are unchanged.
      if (error instanceof SettingsError) pushAppState();
      // Fixed messages only; the store's errors never carry paths. Electron sends the renderer only the message.
      throw new Error(error instanceof SettingsError || error instanceof SettingsBusyError ? error.message : 'Settings could not be saved', {cause: error});
    }
  }
  // Exactly one language id. Main validates it again and persists the change.
  ipcMain.handle('settings:set-language', async (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted settings request');
    const [language] = request;
    if (request.length !== 1 || !isAppLanguage(language)) throw new Error('Invalid language request');
    return saveSettings(() => settingsStore.setLanguage(language));
  });
  // Exactly a game and a profile id; the store serializes saves and refuses more than four outstanding ones.
  ipcMain.handle('settings:set-unit-profile', async (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted settings request');
    const [game, profile] = request;
    if (request.length !== 2 || !isUnitGame(game) || !isUnitProfile(profile)) throw new Error('Invalid unit profile request');
    return saveSettings(() => settingsStore.setUnitProfile(game, profile));
  });
  // Exactly one boolean, from the trusted dashboard frame. A failed write leaves visibility and any draft untouched.
  ipcMain.handle('settings:set-overlay-enabled', async (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted settings request');
    const [enabled] = request;
    if (request.length !== 1 || typeof enabled !== 'boolean') throw new Error('Invalid overlay visibility request');
    return saveSettings(() => settingsStore.setOverlayEnabled(enabled));
  });
  // Exactly one layout id. There is no generic settings patch: each channel accepts one fixed, validated shape.
  ipcMain.handle('settings:set-overlay-layout', async (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted settings request');
    const [layout] = request;
    if (request.length !== 1 || !isOverlayLayout(layout)) throw new Error('Invalid overlay layout request');
    // The edited placement belongs to the current layout (ET-012b decision M5); finish the edit first.
    if (overlayEdit.active) throw new Error('The overlay layout cannot change while its position is edited');
    return saveSettings(() => settingsStore.setOverlayLayout(layout));
  });
  // Exactly one complete section record: the fourteen ids, booleans only, at least one enabled; stored as a fresh copy.
  ipcMain.handle('settings:set-overlay-sections', async (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted settings request');
    const sections = request.length === 1 ? parseOverlaySections(request[0]) : undefined;
    if (!sections) throw new Error('Invalid overlay sections request');
    return saveSettings(() => settingsStore.setOverlaySections(sections));
  });
  // ET-012b overlay edit mode (decision M10): four fixed-shape channels, from the trusted dashboard main frame only.
  // Entering needs writable settings and an application that is not exiting; drag, scale and reset write nothing.
  function editRequest(event: IpcMainInvokeEvent, valid: boolean): OverlayController {
    if (!trusted(event)) throw new Error('Untrusted overlay edit request');
    if (!valid) throw new Error('Invalid overlay edit request');
    if (lifecycle.exiting) throw new Error('Overlay edit request was retired');
    if (!overlayController) throw new Error('Overlay edit mode is not available');
    return overlayController;
  }
  ipcMain.handle('overlay-edit:begin', (event, ...request: unknown[]) => {
    const controller = editRequest(event, request.length === 0);
    if (!settingsStore.view().overlay.enabled) throw new Error('Overlay is disabled');
    if (overlayEdit.active) return overlayEdit;
    if (!settingsStore.view().writable) throw new Error('Overlay edit mode needs writable settings');
    focusGate.start(ownFocused());
    timeline?.('OVERLAY_EDIT_STARTED');
    return controller.beginEdit(focusGate.inFront);
  });
  // Exactly one finite scale in [0.5, 2], rounded to two decimals.
  ipcMain.handle('overlay-edit:set-scale', (event, ...request: unknown[]) => {
    const scale = request.length === 1 ? parseOverlayEditScale(request[0]) : undefined;
    const controller = editRequest(event, scale !== undefined);
    if (!overlayEdit.active) throw new Error('Overlay edit mode is not active');
    return controller.setEditScale(scale!);
  });
  ipcMain.handle('overlay-edit:reset', (event, ...request: unknown[]) => {
    const controller = editRequest(event, request.length === 0);
    if (!overlayEdit.active) throw new Error('Overlay edit mode is not active');
    return controller.resetEdit();
  });
  // Exactly `save` or `cancel`.
  ipcMain.handle('overlay-edit:finish', async (event, ...request: unknown[]) => {
    editRequest(event, request.length === 1 && isOverlayEditOutcome(request[0]));
    return finishOverlayEdit(request[0] as OverlayEditOutcome);
  });
  // ET-016 (J10, J11): five fixed-shape journal channels, from the trusted dashboard main frame only (the overlay is
  // rejected). Exact argument counts, every argument checked again, the page size fixed here; an untrusted or invalid
  // call rejects. A valid call resolves the broker's {ok, value} or {ok: false, code}; no path, process id or Windows
  // session id is ever part of it.
  for (const kind of Object.keys(JOURNAL_CHANNELS) as JournalChannelKind[]) {
    ipcMain.handle(JOURNAL_CHANNELS[kind], (event, ...request: unknown[]) => {
      if (!trusted(event)) throw new Error('Untrusted journal request');
      const query = journalRequest(kind, request);
      if (!query) throw new Error('Invalid journal request');
      return journal.request(query);
    });
  }
  // ET-016 PR-5 (J16): the sixth journal channel exports exactly one trip UUID, from the trusted dashboard main frame only.
  ipcMain.handle(JOURNAL_EXPORT_CHANNEL, (event, ...request: unknown[]) => {
    if (!trusted(event)) throw new Error('Untrusted journal request');
    if (request.length !== 1 || !isJournalUuid(request[0])) throw new Error('Invalid journal request');
    return exporter.export(request[0]);
  });
  // ET-017 (P12, P16): five fixed-shape plugin setup channels, from the trusted dashboard main frame only (the overlay is
  // rejected). Exact argument counts, every argument checked again here, and refused once the exit has started. No reply
  // carries a path: a game folder is named by its target id, and only main opens the folder dialog, Explorer and folders.
  function pluginRequest(event: IpcMainInvokeEvent, valid: boolean): void {
    if (!trusted(event)) throw new Error('Untrusted plugin setup request');
    if (!valid) throw new Error('Invalid plugin setup request');
    if (lifecycle.exiting) throw new Error('Plugin setup request was retired');
  }
  // Fixed messages only: a rejection never carries an error text that might name a path.
  const pluginReply = <T>(work: () => Promise<T>): Promise<T> => work().catch((error: unknown) => {
    throw new Error(error instanceof PluginSetupError ? error.message : 'Plugin setup request failed');
  });
  ipcMain.handle(PLUGIN_CHANNELS.retry, (event, ...request: unknown[]) => {
    pluginRequest(event, request.length === 0);
    return pluginReply(() => pluginSetup.retry());
  });
  // One folder dialog at a time, parented to the dashboard. A cancelled dialog, or an exit that began while it was open,
  // writes nothing; only a confirmed folder reaches plugin setup, which validates it before storing it.
  let choosingFolder = false;
  ipcMain.handle(PLUGIN_CHANNELS.chooseFolder, async (event, ...request: unknown[]): Promise<PluginFolderChoice> => {
    pluginRequest(event, request.length === 1 && isPluginGame(request[0]));
    const game = request[0] as PluginGame, owner = window;
    if (pluginSetup.mode === 'disabled') return {outcome: 'refused', code: 'SETUP_DISABLED'};
    if (choosingFolder) return {outcome: 'refused', code: 'BUSY'};
    if (!owner || owner.isDestroyed()) return {outcome: 'cancelled'};
    choosingFolder = true;
    try {
      const selection = await pluginReply(() => dialog.showOpenDialog(owner, {properties: ['openDirectory']}));
      if (selection.canceled || selection.filePaths.length !== 1 || lifecycle.exiting) return {outcome: 'cancelled'};
      return await pluginReply(() => pluginSetup.chooseFolder(game, selection.filePaths[0]));
    } finally {choosingFolder = false;}
  });
  ipcMain.handle(PLUGIN_CHANNELS.setExcluded, (event, ...request: unknown[]) => {
    pluginRequest(event, request.length === 2 && isPluginGame(request[0]) && typeof request[1] === 'boolean');
    return pluginReply(() => pluginSetup.setExcluded(request[0] as PluginGame, request[1] as boolean));
  });
  // Explorer selects the verified bundled DLL, so the driver can copy it into a protected folder by hand (P12). Plugin
  // setup checks the file again right before (a regular file, not a link); otherwise a fixed code answers.
  ipcMain.handle(PLUGIN_CHANNELS.showFile, async (event, ...request: unknown[]): Promise<PluginShowFileResult> => {
    pluginRequest(event, request.length === 0);
    const file = await pluginReply(() => pluginSetup.bundledFile());
    if (!file || lifecycle.exiting) return {outcome: 'refused', code: 'BUNDLE_UNAVAILABLE'};
    shell.showItemInFolder(file);
    return {outcome: 'shown'};
  });
  // Opens a listed folder's plugins folder, or its bin\win_x64 folder when that is absent; the folder is validated again.
  ipcMain.handle(PLUGIN_CHANNELS.openFolder, async (event, ...request: unknown[]) => {
    pluginRequest(event, request.length === 1 && isPluginTargetId(request[0]));
    // Both calls run inside pluginReply, so a throw from either reaches the renderer as the fixed message, never its text.
    await pluginReply(async () => {
      const folder = await pluginSetup.folderToOpen(request[0] as string);
      if (!folder || lifecycle.exiting) return;
      // shell.openPath answers an error text, which may name the folder; only a fixed code is logged.
      if (await shell.openPath(folder)) log('PLUGIN_FOLDER_NOT_OPENED');
    });
  });
  // ET-017 PR-6 (P17): the diagnostic bundle export takes no argument, from the trusted dashboard main frame only (the
  // overlay is rejected), and answers EXPORT_INTERRUPTED once the exit has begun. It never rejects with an error text.
  ipcMain.handle(DIAGNOSTICS_EXPORT_CHANNEL, (event, ...request: unknown[]): Promise<DiagnosticsExportResult> => {
    if (!trusted(event)) throw new Error('Untrusted diagnostics request');
    if (request.length !== 0) throw new Error('Invalid diagnostics request');
    return diagnosticsExporter.export();
  });
  // ET-018 PR-4 (U8): the in-app uninstall takes no argument, from the trusted dashboard main frame only (the overlay is
  // rejected), and is refused once the exit has begun. `started` begins the explicit exit after the answer was sent.
  ipcMain.handle(UNINSTALL_CHANNEL, async (event, ...request: unknown[]): Promise<AppUninstallResult> => {
    if (!trusted(event)) throw new Error('Untrusted uninstall request');
    if (request.length !== 0) throw new Error('Invalid uninstall request');
    if (lifecycle.exiting) throw new Error('Uninstall refused: the application is exiting');
    const result = await appUninstall.run();
    if (result.outcome === 'started') setImmediate(beginUninstallExit);
    return result;
  });
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
      commitSelection(next, 'user'); freshness.invalidate(initialLive(selection));
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
  // ET-017 (P13): plugin setup starts 2 s after readiness on its own unreferenced timer; startup never waits for it.
  app.whenReady().then(() => {if (!lifecycle.exiting) {createTray(); pluginSetup.start();} startService();}).catch(error => fail('APP_START_FAILED', error));
  // ET-018 (U7): a start of the installed application cancels a pending uninstall deferral; it removes only the deferral's
  // intent, README and copied executor, then the executor's RunOnce registration, and the next plugin setup run takes
  // over the plugin files again.
  if (app.isPackaged) {
    void cancelDeferralOnStart({executable: process.execPath, env: process.env}).then(({deferral, executor}) => {
      if (deferral === 'cancelled' || deferral === 'failed') log('UNINSTALL_DEFERRAL_CANCEL', undefined, {outcome: deferral, executor});
    });
  }
}
