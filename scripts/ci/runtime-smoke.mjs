import {dashboardObservation} from './dashboard-observation.mjs';
import {runUiSmoke, runUiReadOnly, UI_CASES} from './ui-observation.mjs';
import {screen, settingsPanel, waitForStartup} from './ui-navigation.mjs';
import {HARD_MODE_TARGET, runHardModeSmoke, startHardModeSource, verifyHardModeRun} from './hard-mode-observation.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {open, readFile, readdir, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import {_electron as electron} from '@playwright/test';
import {startLiveSmokeSource} from './live-smoke-source.mjs';
import {startLiveSmokeSourceV1} from './live-smoke-source-v1.mjs';
import {
  overlayOverflow, RECORDING_DISABLED_TEXT, SYNTHETIC_V0_VALUE_IDS, SYNTHETIC_V0V1_HIDDEN_ROWS, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V1_LIVE_ROWS, SYNTHETIC_V1_OVERLAY_CURRENT,
  SYNTHETIC_V1_OVERLAY_STOPPED, SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_V1_STALE, SYNTHETIC_V1_STRIP_SECTIONS, SYNTHETIC_V1_VALUE_IDS,
  waitForCompleteLive, waitForCurrentTelemetry, waitForNotCurrentLive, waitForOverlayV1, waitForRecordingText, waitForV1NotCurrentLive
} from './renderer-observation.mjs';
import {
  captureHiddenOverlay, LAYOUT_SMOKE_RESERVED_CSS, LAYOUT_SMOKE_WINDOWS, rendererPages, runOverlaySmoke, verifyLayoutContainment, verifyStripLayout, waitForLayoutContainment, waitForStripLayout, windowSecurity,
  verifyRendererStyles
} from './overlay-observation.mjs';
import {runLifecycleSmoke, seedLifecycleSettings, until, verifyLifecycleRestart} from './lifecycle-observation.mjs';
import {assertNoGameRunning, buildPluginFixture, runDiagnosticsExport, runPluginJourney, snapshotPluginFixture, verifyDisabledPluginCard, verifyPluginEvents, verifyPluginRestart} from './plugin-fixture.mjs';
import {RECORDING_TARGET, runRecordingSmoke, startRecordingSource, verifyRecordingRestart, verifyRecordingRun} from './recording-observation.mjs';
import {JOURNAL_TARGET, runJournalEmpty, runJournalExport, runJournalSeeded, seedJournalDatabase, verifyJournalRun} from './journal-observation.mjs';
import {placeNewerHistory, runRefusalSmoke, verifyRefusalRun} from './refusal-observation.mjs';
import {coldLaunchPhases, observeColdLaunch, observeProcessMemory} from './launch-evidence.mjs';
import {observeExit} from './exit-observation.mjs';
import {SOAK_TARGET, compactSoakEvents, runSoakSmoke, startSoakSource, verifySoakLogs, verifySoakRun} from './soak-observation.mjs';
import {installedEnvironment, minimalPath, normalizePath} from '../installer/installer-guard.mjs';

const [configFile] = process.argv.slice(2);
const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
const result = {scenario: config.scenario === 'soak' ? 'V1 SYNTHETIC-RECORDING-SOAK / partial REG-011, REG-017, REG-018' : config.scenario === 'refusal' ? 'NEWER-HISTORY-REFUSAL / partial REG-013, REG-014, REG-017' : config.scenario === 'plugin' ? 'PLUGIN-SETUP-TEST-ROOT / partial REG-015, REG-017' : config.scenario === 'journal' ? 'SYNTHETIC-JOURNAL-UI / partial REG-009, REG-014, REG-017' : config.scenario === 'recording' ? 'V1 SYNTHETIC-RECORDING-JOURNEY / partial REG-006, REG-012, REG-017' : config.scenario === 'lifecycle' ? 'V0 TRAY-LIFECYCLE-SETTINGS / partial REG-009, REG-011, REG-012, REG-017' : config.scenario === 'overlay' ? 'V0 HIDDEN-OVERLAY-PROJECTION / partial REG-009, REG-011, REG-017' : config.scenario === 'telemetry' ? 'V0 SOURCE-RENDERER-RECOVERY / partial REG-003, REG-010, REG-011, REG-017' : 'SCAFFOLD-WORKER / partial REG-011, REG-017', passed: false,
  scenarioKind: config.scenario ?? 'scaffold',
  commit: config.commit, mode: config.mode, node: process.versions, expected: {
    status: {service: 'ready', storage: 'verified', synthetic: true}, exit: 0, probesAfterExit: []},
  // The Job's 25% hard CPU cap is relative to all logical processors; record them to size the actual budget.
  host: {logicalProcessors: os.availableParallelism()}, startedUtc: new Date().toISOString()};
let application;
let launcher;
let tracing = false;
let telemetrySource;
// ET-010c: the telemetry scenario also serves synthetic protocol v1 data; every other scenario stays v0-only.
let telemetrySourceV1;
// ET-015a PR-4: the recording scenario's reactive v1 simulator behind its recording proxy (recording-observation.mjs).
let recordingSource;
let hardModeSource;
// ET-016 PR-4: the journal scenario's second run opens its seeded synthetic database (journal-observation.mjs).
let journalTarget;
// ET-017 PR-5: the plugin scenario's fake Steam and game folders (plugin-fixture.mjs) and the snapshot run A compares against.
let pluginFixture;
let pluginBefore;
// ET-019 PR-12b: the soak scenario's protocol v1 soak source, spawned with a stdin pipe for its stop (soak-observation.mjs).
let soakSource;
// ET-019 PR-11: the first launch's process creation time and dashboard paint timing (launch-evidence.mjs).
let coldLaunchObservation = null;
const failure = error => ({name: error.name, message: error.message, stack: error.stack});
/** The uninstall card of a portable or development copy: the warning, and the not-installed answer to its button. */
async function verifyUninstallNotInstalled(page, press) {
  await settingsPanel(page, 'about');
  const warning = await page.getByTestId('uninstall-warning').innerText();
  // An installed copy (the installer lifecycle's installed smokes) would open the confirmation: its button is not pressed.
  if (!press) {
    const record = {warningShown: /captures/.test(warning) && /trip history/.test(warning) && /exports/i.test(warning), notInstalledShown: null};
    assert.equal(record.warningShown, true, 'UNINSTALL_CARD_UNEXPECTED');
    return record;
  }
  await page.getByTestId('uninstall-button').click();
  const result = page.getByTestId('uninstall-result');
  await result.waitFor({state: 'visible', timeout: 10000});
  const text = await result.innerText();
  const record = {warningShown: /captures/.test(warning) && /trip history/.test(warning) && /exports/i.test(warning),
    notInstalledShown: text.includes('available only in an installed copy')};
  assert.deepEqual(record, {warningShown: true, notInstalledShown: true}, 'UNINSTALL_CARD_UNEXPECTED');
  return record;
}

// Driver timeline on its own wall and monotonic clocks, to align with app diagnostics and the Job CPU series.
result.phases = [];
const phase = name => result.phases.push({phase: name, utc: new Date().toISOString(), monotonicMs: Math.round(performance.now() * 10) / 10});
const diagnosticEvents = async directory => (await readFile(path.join(directory, 'startup.jsonl'), 'utf8'))
  .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
// ET-013: one service run opens the history database once per service process (`created` per opening, in order),
// never reports it unavailable, and closes it in its storage shutdown step before its single stopped report.
const verifyHistoryEvents = (service, created) => {
  const opened = service.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts);
  assert.deepEqual(opened, created.map(value => ({schemaVersion: 3, created: value, migratedFrom: null})));
  assert.ok(!service.some(row => row.event === 'HISTORY_STORAGE_UNAVAILABLE'), 'History storage was unavailable');
  const closed = service.flatMap((row, index) => row.event === 'HISTORY_STORAGE_CLOSED' ? [index] : []);
  const stopped = service.findLastIndex(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped');
  assert.equal(closed.length, 1); assert.ok(closed[0] < stopped, 'History storage closed after the stopped report');
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'history-storage').map(row => row.facts.outcome), ['ok']);
  return {opened, closed: closed.length};
};
// The database is in the isolated LOCALAPPDATA, checkpointed and closed: a SQLite file of this application at schema
// version 2 (ET-016) without WAL, shared-memory or journal files, and no pre-migration backup for a new database.
const verifyHistoryFile = async () => {
  const database = path.join(config.localappdata, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
  const file = await open(database, 'r');
  const header = Buffer.alloc(100);
  try {await file.read(header, 0, 100, 0);} finally {await file.close();}
  const facts = {magic: header.subarray(0, 15).toString('latin1'), applicationId: header.readInt32BE(68), userVersion: header.readUInt32BE(60),
    sidecars: ['-wal', '-shm', '-journal'].filter(suffix => existsSync(database + suffix)),
    backups: existsSync(path.join(config.localappdata, 'ETS2Telemetry', 'backups'))};
  assert.deepEqual(facts, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 3, sidecars: [], backups: false});
  return facts;
};
// Every launch of one run shares the isolated profile, TEMP, APPDATA and LOCALAPPDATA; only the diagnostic directory may differ.
// ET-018 PR-1 (U11): an installed copy starts like a user's: the minimal Windows PATH and no Node, npm, Electron or
// inherited ETS2TELEMETRY_ variable (scripts/installer/installer-guard.mjs, installedEnvironment).
const environment = diagnostics => ({...(config.mode === 'installed' ? installedEnvironment(process.env, {}) : process.env), TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata,
  LOCALAPPDATA: config.localappdata, ETS2TELEMETRY_PROFILE_DIR: config.profile,
  ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostics,
  ...(telemetrySource ? {ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_SOURCE_KIND: 'synthetic', ETS2TELEMETRY_SOURCE_PIPE: telemetrySource.endpoint} : {}),
  ...(telemetrySourceV1 ? {ETS2TELEMETRY_SOURCE_PIPE_V1: telemetrySourceV1.endpoint} : {}),
  ...(recordingSource ? {ETS2TELEMETRY_SOURCE_PIPE_V1: recordingSource.endpoint, ETS2TELEMETRY_RECORDING: RECORDING_TARGET} : {}),
  ...(hardModeSource ? {ETS2TELEMETRY_SOURCE_PIPE_V1: hardModeSource.endpoint, ETS2TELEMETRY_RECORDING: HARD_MODE_TARGET, ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_HARD_MODE_FIXTURE: '1'} : {}),
  ...(journalTarget ? {ETS2TELEMETRY_RECORDING: journalTarget} : {}),
  ...(soakSource ? {ETS2TELEMETRY_SOURCE_PIPE_V1: soakSource.endpoint, ETS2TELEMETRY_RECORDING: SOAK_TARGET} : {}),
  // ET-017 PR-5: the test-root mode, confined to the fake root inside this run's isolated output folder.
  ...(pluginFixture ? {ETS2TELEMETRY_PLUGIN_SETUP_ROOT: pluginFixture.root} : {})});
const launchOptions = diagnostics => ({timeout: 20000, cwd: config.cwd,
  ...(config.mode !== 'development' ? {executablePath: config.executable, args: config.forceRendererProcessReuse ? ['--renderer-process-limit=1'] : []} :
    {args: [config.checkout, ...(config.forceRendererProcessReuse ? ['--renderer-process-limit=1'] : [])]}),
  env: environment(diagnostics)});
try {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, '24.19.0');
  result.playwright = JSON.parse(await readFile(new URL('../../node_modules/playwright-core/package.json', import.meta.url))).version;
  assert.equal(result.playwright, '1.64.0');
  if (config.scenario === 'ui' && (!UI_CASES.includes(config.uiCase) || config.mode === 'installed')) throw new Error('INVALID_UI_SHARD');
  if (config.scenario === 'ui' && config.uiCase !== 'journal' || config.scenario === 'telemetry' || config.scenario === 'overlay' || config.scenario === 'lifecycle' || config.scenario === 'recording' || config.scenario === 'soak') telemetrySource = await startLiveSmokeSource(config.checkout);
  if (config.scenario === 'telemetry' || config.scenario === 'ui' && ['live', 'overlay'].includes(config.uiCase)) telemetrySourceV1 = await startLiveSmokeSourceV1(config.checkout);
  if (config.scenario === 'hard-mode') hardModeSource = await startHardModeSource(config);
  if (config.scenario === 'recording') recordingSource = await startRecordingSource(config);
  if (config.scenario === 'soak') soakSource = await startSoakSource(config);
  // ET-011b: the lifecycle journey starts from a deliberately invalid settings file in the isolated LOCALAPPDATA.
  if (config.scenario === 'lifecycle') await seedLifecycleSettings(config);
  // ET-017 PR-5: the plugin journey never runs beside a real game, and only against its fake root.
  if (config.scenario === 'plugin') {assertNoGameRunning(); pluginFixture = await buildPluginFixture(config.output); pluginBefore = await snapshotPluginFixture(pluginFixture);}
  // ET-019 PR-7: the history path of the isolated LOCALAPPDATA holds a copy of the newer-schema fixture before the launch.
  if (config.scenario === 'refusal') await placeNewerHistory({config, record: result.refusal = {}});
  if (config.scenario === 'ui' && config.uiCase === 'journal') {await seedJournalDatabase({config, record: result.uiSeed = {}}); journalTarget = JOURNAL_TARGET;}
  phase('launch-requested');
  application = await electron.launch(launchOptions(config.diagnostics));
  launcher = application.process();
  phase('launch-returned');
  await application.context().tracing.start({screenshots: true, snapshots: true});
  tracing = true;
  phase('tracing-started');
  let {dashboard: window, overlay} = await rendererPages(application).catch(error => {
    // Playwright's own view of the windows, read locally without a protocol round trip.
    result.pagesAtRendererPagesFailure = application.windows().map(page => page.url());
    throw error;
  });
  phase('renderer-pages-found');
  await waitForStartup(window);
  phase('dashboard-ready-visible');
  // ET-019 PR-11: recorded, never asserted here; a failed read leaves the paint phases unavailable.
  coldLaunchObservation = await observeColdLaunch(application, window).catch(() => ({error: 'OBSERVATION_FAILED'}));
  result.runtime = await application.evaluate(({app, BrowserWindow}) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {versions: process.versions, packaged: app.isPackaged, rendererProcessLimit: app.commandLine.getSwitchValue('renderer-process-limit'),
      security: {sandbox: preferences.sandbox, isolation: preferences.contextIsolation, node: preferences.nodeIntegration}};
  });
  assert.equal(result.runtime.versions.electron, '44.7.0');
  assert.equal(result.runtime.packaged, config.mode !== 'development');
  if (config.mode === 'installed') {
    // ET-018 PR-1 (U11): the installed executable itself runs, from an unrelated working directory, with the minimal PATH.
    const actual = await application.evaluate(() => ({executable: process.execPath, cwd: process.cwd(),
      path: Object.entries(process.env).filter(([key]) => key.toUpperCase() === 'PATH').map(([, value]) => value),
      development: Object.keys(process.env).filter(key => /^(NODE_OPTIONS|NPM_)/i.test(key))}));
    result.installed = {executableMatches: normalizePath(actual.executable) === normalizePath(config.executable),
      cwdOutsideInstall: normalizePath(actual.cwd) === normalizePath(config.cwd) && !normalizePath(actual.cwd).startsWith(normalizePath(path.dirname(path.dirname(config.executable)))),
      minimalPath: actual.path.length === 1 && actual.path[0] === minimalPath(process.env.SystemRoot), developmentVariablesAbsent: actual.development.length === 0,
      packaged: result.runtime.packaged, layout: `${path.basename(path.dirname(path.dirname(config.executable)))}\\${path.basename(path.dirname(config.executable))}`};
    assert.deepEqual({...result.installed, layout: undefined}, {executableMatches: true, cwdOutsideInstall: true, minimalPath: true, developmentVariablesAbsent: true,
      packaged: true, layout: undefined});
  }
  assert.equal(result.runtime.rendererProcessLimit, config.forceRendererProcessReuse ? '1' : '');
  assert.deepEqual(result.runtime.security, {sandbox: true, isolation: true, node: false});
  result.runtime.windows = await windowSecurity(application);
  result.runtime.rendererStyles = await verifyRendererStyles(window, overlay);
  result.actual = await window.evaluate(async () => ({require: typeof globalThis.require,
    process: typeof globalThis.process, keys: Object.keys(globalThis.desktop),
    frozen: Object.isFrozen(globalThis.desktop), status: await globalThis.desktop.getStatus()}));
  assert.deepEqual(result.actual, {require: 'undefined', process: 'undefined', keys: ['getStatus', 'selectSource', 'subscribeLive', 'getAppState', 'subscribeAppState', 'exitApplication', 'setLanguage', 'setAutostart', 'setUnitProfile', 'setOverlayBackgroundOpacity', 'setOverlayEnabled', 'setOverlayLayout', 'setOverlaySections',
    'beginOverlayEdit', 'setOverlayEditScale', 'resetOverlayEditPlacement', 'finishOverlayEdit',
    'listJournalTrips', 'getJournalTrip', 'listJournalEvents', 'listJournalIntervals', 'listJournalSamples', 'exportJournalTrip',
    'retryPluginSetup', 'choosePluginFolder', 'setPluginGameExcluded', 'showPluginFile', 'openPluginFolder', 'exportDiagnostics', 'uninstallApplication', 'getHardModeStatus', 'refreshHardMode'],
    frozen: true, status: result.expected.status});
  if (config.scenario === 'scaffold') {
    // ET-016 PR-3: a journal read crosses the preload, main and the telemetry service to the new, empty history database
    // of the isolated LOCALAPPDATA; an invalid trip id is refused in the preload. DATABASE_OPENING is retried for up to 10 s.
    result.journal = await window.evaluate(async () => {
      let answer;
      for (let attempt = 0; attempt < 100; attempt++) {
        answer = await globalThis.desktop.listJournalTrips();
        if (answer.ok || answer.code !== 'DATABASE_OPENING') break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const refused = await globalThis.desktop.getJournalTrip('C:\\Users\\owner\\telemetry.sqlite').then(() => 'resolved', error => String(error?.message));
      return {answer, refused};
    });
    assert.deepEqual(result.journal, {answer: {ok: true, value: {database: {purpose: 'history', schemaVersion: 3}, trips: [], nextCursor: null}},
      refused: 'Invalid journal request'});
    // ET-017 PR-5 review: plugin setup is disabled here; the card says so and disables every control that would change nothing.
    result.pluginCard = await verifyDisabledPluginCard(window);
    // ET-018 PR-4: the uninstall card shows its warning. In a portable or development copy its button answers that
    // uninstalling is available only in an installed copy: main answers before any dialog and changes nothing. An installed
    // copy's button is never pressed here; the installer lifecycle's app-assisted scenarios do that through the dialog seam.
    result.uninstallCard = await verifyUninstallNotInstalled(window, config.mode !== 'installed');
    await screen(window, 'live');
    await window.evaluate(() => globalThis.scrollTo(0, 0));
  }
  result.probesBeforeExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
  assert.equal(result.probesBeforeExit.length, 1);
  if (config.scenario === 'overlay') {
    result.overlay = {};
    await runOverlaySmoke(application, window, overlay, telemetrySource, result.overlay);
    // Review evidence only: the serialized DOM always, the PNG when the hidden window presents a frame (overlay-observation.mjs).
    result.overlay.capture = await captureHiddenOverlay(overlay, config.output);
  }
  if (config.scenario === 'telemetry') {
    // The dashboard is taller than the smoke window, and outside wheel input on a shared desktop can scroll it, also
    // during the renderer stall (compositor scrolling). Return to the top right before each wait that requires the
    // status, speed and fuel lines inside the viewport; the predicates themselves are unchanged.
    const atTop = () => window.locator('.yu-content').evaluate(node => {node.scrollTop = 0;});
    const current = async phase => {
      await atTop();
      const observation = await waitForCurrentTelemetry(window);
      (result.rendererObservations ??= []).push({phase, ...observation});
    };
    // `zoom` mirrors ET-012b's scale, which the controller applies as the overlay document's zoom factor.
    const resizeOverlay = (width, height, zoom = 1) => application.evaluate(({BrowserWindow}, size) => {
      const target = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('view=overlay'));
      if (!target) return null;
      target.webContents.setZoomFactor(size.zoom);
      target.setBounds({...target.getBounds(), width: size.width, height: size.height}); return {...target.getBounds(), zoom: target.webContents.getZoomFactor()};
    }, {width, height, zoom});
    const overlayWindow = () => application.evaluate(({BrowserWindow}) => {
      const target = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('view=overlay'));
      return target ? {...target.getBounds(), zoom: target.webContents.getZoomFactor()} : null;
    });
    const overlayState = () => overlay.evaluate(() => ({layout: globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-layout') ?? null,
      width: globalThis.innerWidth, height: globalThis.innerHeight, sections: globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length}));
    // A short bound for the review-only layouts keeps missed waits well inside the Job's 60 s limit; the strip
    // restore keeps the usual 10 s. `sections` is null when the count could not be read, and is then not compared.
    // `height`, when given, is compared the same way as the width.
    const renderedLayout = async (layout, width, sections, timeout, height = null) => {
      const handle = await overlay.waitForFunction(expected => {
        const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
        return root?.getAttribute('data-layout') === expected.layout && Math.abs(globalThis.innerWidth - expected.width) <= 1 &&
          (expected.height === null || Math.abs(globalThis.innerHeight - expected.height) <= 1) &&
          (expected.sections === null || globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length === expected.sections);
      }, {layout, width, height, sections}, {timeout});
      await handle.dispose();
    };
    // ET-012d (decisions K10 and K11): the card, HUD and cluster with every v1 section the pair shows. The saved sections
    // are first set to exactly those twelve, so each window reserves no row for a hidden section (range and distance
    // driven); without a game window the controller never places the overlay, so the hidden window is sized here
    // (LAYOUT_SMOKE_WINDOWS for those sections at scale 1, tied to overlayWindowSize by a unit test). Each observation is
    // stored before it is verified, so a failed receipt keeps it. The original sections and the strip are restored at
    // the size the product created in every case; the first error, a failed assertion or a failed restore, fails the run.
    const assertLayouts = async record => {
      let base = null, sections = null, original = null, failed;
      try {
        base = await overlay.evaluate(() => ({width: globalThis.innerWidth, height: globalThis.innerHeight}));
        sections = await overlay.evaluate(() => globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length);
        original = (await window.evaluate(() => globalThis.desktop.getAppState())).settings.overlay.sections;
        const shown = Object.fromEntries(Object.keys(original).map(id => [id, SYNTHETIC_V1_STRIP_SECTIONS.includes(id)]));
        record.sections = (await window.evaluate(value => globalThis.desktop.setOverlaySections(value), shown)).overlay.sections;
        assert.deepEqual(record.sections, shown);
        for (const layout of ['card', 'hud', 'cluster']) {
          const size = LAYOUT_SMOKE_WINDOWS[layout];
          const saved = await window.evaluate(value => globalThis.desktop.setOverlayLayout(value), layout);
          assert.equal(saved.overlay.layout, layout);
          (record.windows ??= {})[layout] = await resizeOverlay(size.width, size.height, 1);
          await renderedLayout(layout, size.width, null, 10000, size.height);
          verifyLayoutContainment(record[layout] = await waitForLayoutContainment(overlay, {layout, sections: SYNTHETIC_V1_STRIP_SECTIONS}), size,
            LAYOUT_SMOKE_RESERVED_CSS[layout]);
        }
      } catch (error) {failed = error;}
      try {
        await window.evaluate(() => globalThis.desktop.setOverlayLayout('strip'));
        if (original) assert.deepEqual((await window.evaluate(value => globalThis.desktop.setOverlaySections(value), original)).overlay.sections, original);
        if (base) {await resizeOverlay(base.width, base.height, 1); await renderedLayout('strip', base.width, sections, 10000, base.height);}
        record.restored = 'strip';
      } catch (error) {failed ??= error;}
      if (failed) throw failed;
    };
    const measureLayouts = async layouts => {
      const record = {};
      let sections = null, base = null;
      try {
        // The product created the strip window at overlayWindowSize(...) for the enabled sections (ET-012c); every size
        // here derives from it, and the restore returns to it, so strip geometry is never read at a size the product
        // would not use. A layout given without a size is the strip at `zoom` times that size.
        // The document's inner size at zoom 1 is the window's DIP size; getBounds can round it up by one DIP.
        record.window = await overlayWindow();
        base = await overlay.evaluate(() => ({width: globalThis.innerWidth, height: globalThis.innerHeight})); record.base = base;
        sections = await overlay.evaluate(() => globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length);
        for (const [layout, givenWidth, givenHeight, zoom = 1] of layouts) {
          const width = givenWidth ?? base.width * zoom, height = givenHeight ?? base.height * zoom;
          const key = zoom === 1 ? layout : `${layout}@${zoom}`;
          const saved = await window.evaluate(value => globalThis.desktop.setOverlayLayout(value), layout);
          record[key] = {saved: saved.overlay.layout, resized: await resizeOverlay(width, height, zoom)};
          // The document's CSS width is the window's DIP width divided by the zoom factor.
          await renderedLayout(layout, width / zoom, sections, 3000);
          record[key].overflow = await overlay.evaluate(overlayOverflow);
        }
      } catch (error) {record.error = failure(error); record.stateAtError = await overlayState().catch(() => null);}
      try {
        await window.evaluate(() => globalThis.desktop.setOverlayLayout('strip'));
        if (base) {await resizeOverlay(base.width, base.height, 1); await renderedLayout('strip', base.width, sections, 10000);}
        record.restored = 'strip';
      } catch (error) {record.restoreError = failure(error);}
      return record;
    };
    await current('initial');
    result.telemetry = {origin: 'synthetic', speedKmh: 90, fuelL: 73, recording: false};
    // ET-015c PR-4: the service records nothing here, so the dashboard shows the fixed disabled recording text.
    result.telemetry.recordingStatus = await waitForRecordingText(window, RECORDING_DISABLED_TEXT, 'RECORDING_DISABLED_TEXT_NOT_SHOWN');
    // ET-010b/ET-010c: the live card shows the complete v0 field set with the v1 rows of the same job beside it, and the
    // hidden overlay document the v1 sections, all from the same pair of observations.
    result.telemetry.liveFields = await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    result.telemetry.v1Fields = Object.fromEntries(SYNTHETIC_V1_LIVE_ROWS.map(([id]) => [id, result.telemetry.liveFields[id]]));
    result.telemetry.overlayV1 = {current: await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_CURRENT)};
    // ET-012c reserves strip rows for every enabled section: with the v1 sections all twelve shown must lie inside the
    // overlay window. This is an assertion; the overflow record below stays for review.
    result.telemetry.stripLayout = verifyStripLayout(await waitForStripLayout(overlay, {sections: SYNTHETIC_V1_STRIP_SECTIONS}));
    result.telemetry.overlayOverflow = await overlay.evaluate(overlayOverflow);
    // ET-012d: an assertion. Every shown card, HUD and cluster section lies inside its reserved window.
    // The layout saves are real settings writes in the isolated profile: a failed write logs SETTINGS_WRITE_FAILED,
    // which the strict diagnostic postcondition below rejects, so it fails the run as a product failure.
    await assertLayouts(result.telemetry.layoutContainment = {});
    // For review only, recorded and never asserted: the strip at ET-012b's largest scale, 2, twice the size the product
    // created with a document zoom of 2 (2560 x 220 DIP for every section where the screen allows it), then restored.
    result.telemetry.overlayLayoutOverflow = await measureLayouts([['strip', null, null, 2]]);
    // Hold the v0 source on the same connection until main's freshness expiry: every v0 card value must become not
    // current while the v1 rows stay current and the overlay keeps only dashes; then return after resume. The later
    // single-connection assertion proves the hold did not reconnect.
    telemetrySource.hold();
    try {
      await atTop(); result.telemetry.liveStale = await waitForNotCurrentLive(window, SYNTHETIC_V0_VALUE_IDS, '^stale:', SYNTHETIC_V0V1_HIDDEN_ROWS);
      result.telemetry.v1CurrentWhileV0Stale = await waitForCompleteLive(window, SYNTHETIC_V1_LIVE_ROWS, []);
      result.telemetry.overlayV1.v0Stale = await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_V0_STALE);
    } finally {telemetrySource.resume();}
    await atTop(); await waitForCurrentTelemetry(window);
    await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    result.telemetry.liveStaleHidden = true;
    // Hold the v1 source the same way: the v1 rows and the v1 overlay sections expire while v0 stays current.
    telemetrySourceV1.hold();
    try {
      await atTop(); result.telemetry.v1Stale = await waitForV1NotCurrentLive(window, SYNTHETIC_V1_VALUE_IDS, '^stale:', 'Speed: 90 km/h');
      result.telemetry.overlayV1.v1Stale = await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_V1_STALE);
    } finally {telemetrySourceV1.resume();}
    await atTop(); await waitForCurrentTelemetry(window);
    await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_CURRENT);
    assert.equal(telemetrySourceV1.statistics().connections, 1, 'The v1 hold reconnected the v1 source');
    result.telemetry.v1StaleRecovered = true;
    // Stall only this owned renderer beyond the five-second consumption-credit deadline.
    // Change the source while it is stalled: a stranded cached reading cannot pass recovery.
    let changedDuringStall = false;
    const changeReading = setTimeout(() => {telemetrySource.setReading(20, 71); changedDuringStall = true;}, 1000);
    try {
      await window.evaluate(() => {const until = performance.now() + 6000; while (performance.now() < until) { /* controlled renderer stall */ }});
    } finally {clearTimeout(changeReading);}
    assert.equal(changedDuringStall, true, 'Source did not change during controlled renderer stall');
    await atTop();
    const recovered = await window.waitForFunction(dashboardObservation, {speed: 'Speed: 72 km/h', fuel: 'Fuel: 71.0 L'}, {timeout: 10000});
    try {
      const reading = await recovered.jsonValue();
      assert.equal(reading.speed, 'Speed: 72 km/h'); assert.equal(reading.fuel, 'Fuel: 71.0 L'); assert.match(reading.status, /^connected:/);
    } finally {await recovered.dispose();}
    assert.equal(telemetrySource.statistics().connections, 1, 'Subscription recovery restarted source ingestion');
    result.telemetry.subscriptionRestartRecovered = true;
    result.telemetry.rendererStallMilliseconds = 6000;
    result.telemetry.changedReadingAfterStall = {speedKmh: 72, fuelL: 71};
    telemetrySource.setReading(25, 73);
    await atTop(); await waitForCurrentTelemetry(window);
    result.telemetry.invalidSelectionRejected = await window.evaluate(async () => {
      try {await globalThis.desktop.selectSource('../arbitrary-path'); return false;} catch {return true;}
    });
    assert.equal(result.telemetry.invalidSelectionRejected, true);
    await window.reload(); await current('renderer-reload-1');
    await window.reload(); await current('renderer-reload-2');
    // A reload whose commit is late lets the replaced document's 250 ms re-subscribe reach main first (hosted
    // runs 38324766032 and 38470786173). Hold only the replacement document's request well past that delay, so
    // this reload always exercises the race, and require main's evidence that it retired that subscription.
    const commitDelayMilliseconds = 2000;
    // An unheld reload can also hit the race on a slow host; count only this reload's retirement.
    const precommitRetirements = async () => (await diagnosticEvents(config.diagnostics)).filter(row => row.event === 'DASHBOARD_PRECOMMIT_SUBSCRIPTION_RETIRED').length;
    const retiredBefore = await precommitRetirements();
    await window.route(url => url.protocol === 'file:', async route => {
      if (route.request().isNavigationRequest()) await new Promise(resolve => setTimeout(resolve, commitDelayMilliseconds));
      await route.continue();
    });
    try {await window.reload();} finally {await window.unrouteAll();}
    await current('renderer-reload-delayed-commit');
    // Main writes its log asynchronously, so the retirement row is awaited rather than read once.
    const retiredAfter = await until(precommitRetirements, count => count > retiredBefore, 'DELAYED_COMMIT_RETIREMENT_NOT_LOGGED');
    result.telemetry.delayedCommit = {holdMilliseconds: commitDelayMilliseconds, precommitRetirementsBefore: retiredBefore, precommitRetirementsAfter: retiredAfter};
    assert.equal(retiredAfter - retiredBefore, 1, 'Delayed-commit reload did not retire the replaced document subscription');
    result.telemetry.rendererReloads = 3;
    const restartRequested = await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-service-exit'));
    assert.equal(restartRequested, true, 'Opt-in diagnostic event unavailable');
    result.telemetry.diagnosticCrashRequested = true;
    await window.waitForFunction(() => /^(restarting|service-failed):/.test(globalThis.document.querySelector('[data-testid="telemetry-status"]')?.textContent ?? ''), undefined, {timeout: 5000});
    await current('service-restart'); result.telemetry.serviceRestartRecovered = true;
    result.telemetry.source = telemetrySource.statistics();
    assert.equal(result.telemetry.source.connections, 2, 'Expected one initial source connection and one service-restart connection');
    // The replacement service connects v1 again; the card shows both sources once more.
    await atTop(); await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    result.telemetry.sourceV1 = telemetrySourceV1.statistics();
    assert.equal(result.telemetry.sourceV1.connections, 2, 'Expected one initial v1 source connection and one service-restart connection');
    await telemetrySource.stop();
    const disconnected = await window.waitForFunction(dashboardObservation,
      {status: '^(disconnected|waiting):', speed: 'Speed: unavailable', omitFuel: true}, {timeout: 5000});
    try {assert.equal((await disconnected.jsonValue()).speed, 'Speed: unavailable');} finally {await disconnected.dispose();}
    assert.match(await window.getByTestId('telemetry-status').innerText(), /^(disconnected|waiting):/);
    result.telemetry.staleAfterDisconnect = true;
    await atTop(); await waitForNotCurrentLive(window, ['live-gear', 'live-cargo', 'live-odometer'], '^(disconnected|waiting):');
    result.telemetry.liveDisconnectedHidden = true;
    await telemetrySourceV1.stop();
    await atTop(); await waitForV1NotCurrentLive(window, SYNTHETIC_V1_VALUE_IDS, '^(disconnected|waiting):', 'Speed: unavailable');
    result.telemetry.overlayV1.stopped = await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_STOPPED);
    result.telemetry.v1DisconnectedHidden = true;
  }
  if (config.scenario === 'ui') {
    await runUiSmoke({application, dashboard: window, overlay, source: telemetrySource, config, record: result.ui = {}});
    if (config.uiCase === 'settings') {
      // Same 60-second Job: a normal first run, then an isolated newer-version read-only launch.
      await application.context().tracing.stop({path: path.join(config.output, 'ui-settings-first-trace.zip')}); tracing = false;
      await observeExit({application, launcher, request: () => application.close(), requireRequest: true,
        record: result.ui.exitObservation = {}, message: 'APP_CLOSE_TIMEOUT_8_SECONDS'});
      result.ui.firstLauncherExit = launcher.exitCode;
      const settingsBytes = '{"format":"ets2telemetry.settings","version":999,"language":"ru","fixture":"future settings retained byte-identically"}';
      await writeFile(path.join(config.localappdata, 'ETS2Telemetry', 'settings', 'settings.json'), settingsBytes);
      phase('ui-readonly-launch-requested');
      application = await electron.launch(launchOptions(config.diagnosticsRestart)); launcher = application.process();
      await application.context().tracing.start({screenshots: true, snapshots: true}); tracing = true;
      ({dashboard: window, overlay} = await rendererPages(application)); await waitForStartup(window);
      await runUiReadOnly({application, dashboard: window, config, record: result.ui, settingsBytes});
      result.ui.readOnly.windows = await windowSecurity(application);
      await screen(window, 'live');
    }
  }
  if (config.scenario === 'hard-mode') await runHardModeSmoke({application, dashboard: window, source: hardModeSource, config, record: result.hardMode = {}});
  if (config.scenario === 'lifecycle') {
    result.lifecycle = {};
    await runLifecycleSmoke({application, launcher, dashboard: window, overlay, source: telemetrySource, config,
      environment: environment(config.diagnostics), events: diagnosticEvents, record: result.lifecycle,
      stopTracing: async () => {tracing = false; await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')}); phase('tracing-stopped');}});
    // Run A exited on its own; the shared close path below now owns run B.
    application = undefined; phase('explicit-exit-complete');
    application = await electron.launch(launchOptions(config.diagnosticsRestart));
    launcher = application.process(); phase('restart-launch-returned');
    await verifyLifecycleRestart({application, record: result.lifecycle, rendererPages, config});
    phase('restart-ready');
  }
  if (config.scenario === 'recording') {
    // ET-015a PR-4: run A records through a killed and restarted service and close-to-tray, then exits from the tray;
    // the shared close path below owns run B, which appends to the same synthetic database.
    result.recording = {};
    await runRecordingSmoke({application, launcher, dashboard: window, recording: recordingSource, config, events: diagnosticEvents, record: result.recording,
      stopTracing: async () => {tracing = false; await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')}); phase('tracing-stopped');}});
    application = undefined; phase('tray-exit-complete');
    application = await electron.launch(launchOptions(config.diagnosticsRestart));
    launcher = application.process(); phase('restart-launch-returned');
    await verifyRecordingRestart({application, record: result.recording, rendererPages, recording: recordingSource, events: diagnosticEvents, config});
    phase('restart-recorded');
  }
  if (config.scenario === 'journal') {
    // ET-016 PR-4: run 1 shows the empty history and exits orderly; the seed writes the synthetic database; run 2 reads
    // it through the Journal tab. The shared close path below owns run 2.
    result.journal = {};
    await runJournalEmpty({dashboard: window, record: result.journal});
    phase('journal-empty-shown');
    tracing = false; await application.context().tracing.stop({path: path.join(config.output, 'trace-empty-history.zip')}); phase('tracing-stopped');
    const closeStart = performance.now();
    await observeExit({application, launcher, request: () => application.close(), requireRequest: true,
      record: result.journal.exitObservation = {}, message: 'APP_CLOSE_TIMEOUT_8_SECONDS'});
    result.journal.emptyRunExit = {launcherExit: launcher.exitCode, signal: launcher.signalCode, closeMilliseconds: Math.round(performance.now() - closeStart)};
    assert.deepEqual({launcherExit: launcher.exitCode, signal: launcher.signalCode}, {launcherExit: 0, signal: null});
    application = undefined; phase('journal-empty-run-exited');
    await seedJournalDatabase({config, record: result.journal});
    phase('journal-seeded');
    journalTarget = JOURNAL_TARGET;
    application = await electron.launch(launchOptions(config.diagnosticsRestart));
    launcher = application.process(); phase('restart-launch-returned');
    await application.context().tracing.start({screenshots: true, snapshots: true});
    tracing = true;
    const {dashboard} = await rendererPages(application);
    await waitForStartup(dashboard);
    phase('restart-ready');
    await runJournalSeeded({dashboard, record: result.journal});
    phase('journal-read');
    // ET-016 PR-5: the trip export through the Journal tab, with main's Save dialog replaced through Playwright.
    await runJournalExport({application, dashboard, config, record: result.journal});
    phase('journal-exported');
    await dashboard.screenshot({path: path.join(config.output, 'journal.png')});
  }
  if (config.scenario === 'refusal') {
    // ET-019 PR-7: the refused history database through the bridge, main's health, the recording texts and the Journal tab.
    await runRefusalSmoke({dashboard: window, config, record: result.refusal});
    phase('refusal-shown');
  }
  if (config.scenario === 'soak') {
    // ET-019 PR-12b: M minutes of recording from the soak source; the shared close path exits right after the source stops.
    result.soak = {};
    await runSoakSmoke({application, dashboard: window, source: soakSource, config, record: result.soak, phase,
      stopTracing: async () => {tracing = false; await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')}); phase('tracing-stopped');}});
  }
  if (config.scenario === 'plugin') {
    // ET-017 PR-5: run A installs into the fake folders, shows the card and excludes ATS through the card's switch, then
    // exits orderly; run B, a restart with the same profile, must reach the same states without writing. The shared close
    // path below owns run B.
    result.plugin = {};
    await runPluginJourney({application, dashboard: window, fixture: pluginFixture, config, before: pluginBefore, record: result.plugin, phase});
    tracing = false; await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')}); phase('tracing-stopped');
    await observeExit({application, launcher, request: () => application.close(), requireRequest: true,
      record: result.plugin.exitObservation = {}, message: 'APP_CLOSE_TIMEOUT_8_SECONDS'});
    result.plugin.runAExit = launcher.exitCode;
    assert.deepEqual({launcherExit: launcher.exitCode, signal: launcher.signalCode}, {launcherExit: 0, signal: null});
    application = undefined; phase('plugin-run-a-exited');
    // Run B must write nothing: every fixture file keeps the bytes and modification time run A left.
    assertNoGameRunning();
    const afterRunA = await snapshotPluginFixture(pluginFixture);
    application = await electron.launch(launchOptions(config.diagnosticsRestart));
    launcher = application.process(); phase('restart-launch-returned');
    const {dashboard} = await rendererPages(application);
    await waitForStartup(dashboard);
    phase('restart-ready');
    await verifyPluginRestart({dashboard, fixture: pluginFixture, before: afterRunA, record: result.plugin, phase});
    // ET-017 PR-6: "Export diagnostics…" after run B's states and files were verified; it writes only into this run's output.
    await runDiagnosticsExport({application, dashboard, config, fixture: pluginFixture, record: result.plugin});
    phase('plugin-diagnostics-exported');
    await dashboard.screenshot({path: path.join(config.output, 'plugin.png')});
  }
  // ET-019 PR-11: Electron's per-process peak working sets of the application open now (the restart run of the two-run
  // scenarios); recorded, never asserted here.
  result.processMemory = {run: ['lifecycle', 'recording', 'journal', 'plugin'].includes(config.scenario) || config.scenario === 'ui' && config.uiCase === 'settings' ? 'restart' : 'first',
    ...await observeProcessMemory(application).catch(() => ({error: 'OBSERVATION_FAILED'}))};
  phase('journey-complete');
  if (config.scenario !== 'lifecycle' && config.scenario !== 'recording' && config.scenario !== 'journal' && config.scenario !== 'plugin' && config.scenario !== 'refusal' && config.scenario !== 'soak') await window.screenshot({path: path.join(config.output, 'ready.png')});
} catch (error) {result.failure = failure(error); phase('failed');}
finally {
  try {await hardModeSource?.stop();} catch (error) {result.sourceV1CloseFailure = failure(error);}
  try {await telemetrySource?.stop();} catch (error) {result.sourceCloseFailure = failure(error);}
  try {await telemetrySourceV1?.stop();} catch (error) {result.sourceV1CloseFailure = failure(error);}
  if (application) {
    if (tracing) {
      try {await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')});}
      catch (error) {result.traceFailure = failure(error);}
      phase('tracing-stopped');
    }
    const start = performance.now();
    phase('close-requested');
    try {
      await observeExit({application, launcher, request: () => application.close(), requireRequest: true,
        record: result.closeObservation = {}, message: 'APP_CLOSE_TIMEOUT_8_SECONDS'});
      result.closeMilliseconds = performance.now() - start;
      result.launcherExit = launcher.exitCode;
      assert.equal(result.launcherExit, 0);
      assert.equal(launcher.signalCode, null);
    } catch (error) {result.closeFailure = failure(error);}
    finally {phase('close-settled');}
  }
  // ET-019 PR-12b: a soak whose source the journey did not stop (a failure, or an application that exited first) ends it
  // now, so its summary records how its last connection closed.
  if (soakSource && !result.soak?.sourceStopped) {
    try {(result.soak ??= {}).source = await soakSource.stop({waitMs: 5000});} catch (error) {result.soakSourceFailure = failure(error);}
  }
  try {
    // Preserve lifecycle evidence even when a later cleanup assertion fails.
    result.mainEvents = await diagnosticEvents(config.diagnostics);
    result.serviceEvents = await diagnosticEvents(path.join(config.diagnostics, 'service'));
    // ET-019 PR-11: the first launch's phases from rows it already logs; kept even when a later postcondition fails.
    result.coldLaunch = coldLaunchPhases({observation: coldLaunchObservation, driverPhases: result.phases, mainEvents: result.mainEvents, serviceEvents: result.serviceEvents});
    // ET-019 PR-12b: a log that reached its budget may have dropped the rows the checks below read.
    if (config.scenario === 'soak') await verifySoakLogs({config, record: result.soak ??= {}});
    result.probesAfterExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
    const restartRecord = result.telemetry?.serviceRestartRecovered ? result.telemetry : result.recording?.serviceRestartRecovered ? result.recording : undefined;
    if (telemetrySource && restartRecord) {
      // A deliberately killed worker's original isolated probe is retained as crash evidence.
      // The replacement service must remove its own normal-shutdown probe.
      assert.deepEqual(result.probesAfterExit, result.probesBeforeExit);
      restartRecord.retainedCrashProbe = result.probesAfterExit;
      result.expected.probesAfterExit = result.probesBeforeExit;
    } else assert.deepEqual(result.probesAfterExit, []);
    const diagnosticCrashObserved = result.mainEvents.some(row => row.event === 'DIAGNOSTIC_SERVICE_EXIT_REQUEST');
    for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
      const rows = result.mainEvents.filter(row => row.event === name);
      assert.equal(rows.length, name === 'SERVICE_EXIT' && diagnosticCrashObserved ? 2 : 1);
      assert.equal(rows.at(-1).detail.code, 0);
    }
    assert.ok(result.serviceEvents.some(row => row.event === 'STORAGE_VERIFIED'));
    assert.ok(result.serviceEvents.some(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped'));
    // A deliberately killed service never closed its database; its replacement reopens the existing file.
    // A recording target logs the same opening and closing codes for its synthetic database (ET-015a PR-3).
    // ET-019 PR-7: the refusal scenario's service never opens a database; its own checks replace the history ones.
    if (config.scenario === 'refusal') await verifyRefusalRun({config, record: result.refusal ??= {}, mainEvents: result.mainEvents, serviceEvents: result.serviceEvents});
    else result.history = verifyHistoryEvents(result.serviceEvents, telemetrySource && restartRecord ? [true, false] : config.scenario === 'ui' && config.uiCase === 'journal' ? [false] : [true]);
    const deliberateUiErrors = config.scenario === 'ui' && config.uiCase === 'settings' ? result.mainEvents.filter(row => row.event === 'SETTINGS_WRITE_FAILED') : [];
    if (config.scenario === 'ui' && config.uiCase === 'settings') {
      assert.deepEqual(deliberateUiErrors.map(row => row.facts), Array.from({length: 12}, () => ({step: 'target', code: null})));
      result.ui.saveFailureFacts = deliberateUiErrors.map(row => row.facts);
      result.ui.readOnly.mainEvents = await diagnosticEvents(config.diagnosticsRestart);
      result.ui.readOnly.serviceEvents = await diagnosticEvents(path.join(config.diagnosticsRestart, 'service'));
      result.ui.readOnly.launcherExit = result.launcherExit;
      for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {const rows = result.ui.readOnly.mainEvents.filter(row => row.event === name); assert.equal(rows.length, 1); assert.equal(rows[0].detail.code, 0);}
      assert.ok(![...result.ui.readOnly.mainEvents, ...result.ui.readOnly.serviceEvents].some(row => /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(row.event)));
      verifyHistoryEvents(result.ui.readOnly.serviceEvents, [false]);
      assert.deepEqual(result.ui.readOnly.mainEvents.filter(row => row.event === 'SETTINGS_FALLBACK').map(row => row.facts), [{state: 'newer-version'}]);
    }
    assert.ok(![...result.mainEvents.filter(row => !deliberateUiErrors.includes(row)), ...result.serviceEvents].some(row =>
      /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(row.event)));
    if (config.scenario === 'lifecycle') {
      // Run B wrote to its own diagnostic directory; both runs need the same orderly, clean shutdown.
      const lifecycle = result.lifecycle ??= {};
      lifecycle.restartMainEvents = await diagnosticEvents(config.diagnosticsRestart);
      lifecycle.restartServiceEvents = await diagnosticEvents(path.join(config.diagnosticsRestart, 'service'));
      for (const [main, service] of [[result.mainEvents, result.serviceEvents], [lifecycle.restartMainEvents, lifecycle.restartServiceEvents]]) {
        for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
          const rows = main.filter(row => row.event === name);
          assert.equal(rows.length, 1); assert.equal(rows[0].detail.code, 0);
        }
        assert.ok(service.some(row => row.event === 'STORAGE_VERIFIED'));
        assert.deepEqual(service.filter(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped').map(row => row.detail), [{type: 'stopped', clean: true}]);
        const steps = service.filter(row => row.event === 'SHUTDOWN_STEP');
        assert.ok(steps.length >= 3 && steps.every(row => row.facts?.outcome === 'ok'), 'Every service shutdown step must finish cleanly');
        assert.ok(![...main, ...service].some(row => /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(row.event)));
      }
      assert.deepEqual(lifecycle.restartMainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['app-quit']);
      // Run B reopens the history database that run A created.
      lifecycle.restartHistory = verifyHistoryEvents(lifecycle.restartServiceEvents, [false]);
      // Settings diagnostics: run A falls back from the invalid file, quarantines it and saves units then visibility false; run B only loads.
      const settingsEvents = rows => rows.filter(row => row.event.startsWith('SETTINGS_')).map(row => ({event: row.event, facts: row.facts ?? null}));
      lifecycle.settingsEvents = {runA: settingsEvents(result.mainEvents), runB: settingsEvents(lifecycle.restartMainEvents)};
      // A read that outlasted its 1000 ms load budget under CPU starvation is preceded by exactly one pending row; the
      // rows after it are the same as for a read within the budget.
      const pending = {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget'}};
      const late = rows => rows[0]?.event === pending.event ? [pending] : [];
      lifecycle.settingsLateRead = {runA: late(lifecycle.settingsEvents.runA).length === 1, runB: late(lifecycle.settingsEvents.runB).length === 1};
      assert.deepEqual(lifecycle.settingsEvents.runA, [...late(lifecycle.settingsEvents.runA), {event: 'SETTINGS_FALLBACK', facts: {state: 'invalid-file'}},
        {event: 'SETTINGS_QUARANTINED', facts: {state: 'invalid-file'}}, {event: 'SETTINGS_SAVED', facts: {game: 'ets2', profile: 'us-customary'}},
        {event: 'SETTINGS_SAVED', facts: {overlayEnabled: false}}]);
      assert.deepEqual(lifecycle.settingsEvents.runB, [...late(lifecycle.settingsEvents.runB), {event: 'SETTINGS_LOADED', facts: {state: 'loaded'}}]);
      lifecycle.restartLauncherExit = result.launcherExit;
      lifecycle.shutdownClean = true;
    }
    if (config.scenario === 'plugin') {
      // ET-017 PR-5: both runs exit orderly in the test-root mode with nothing refused outside the root; run B changes no folder.
      const plugin = result.plugin ??= {};
      plugin.restartMainEvents = await diagnosticEvents(config.diagnosticsRestart);
      plugin.restartServiceEvents = await diagnosticEvents(path.join(config.diagnosticsRestart, 'service'));
      plugin.restartLauncherExit = result.launcherExit;
      for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
        const rows = plugin.restartMainEvents.filter(row => row.event === name);
        assert.equal(rows.length, 1); assert.equal(rows[0].detail.code, 0);
      }
      assert.ok(!plugin.restartMainEvents.some(row => /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(row.event)));
      plugin.actions = {runA: verifyPluginEvents(result.mainEvents), runB: verifyPluginEvents(plugin.restartMainEvents)};
      // ET-017 PR-6: run B's main log records the cancelled and the saved export, with fixed facts only.
      const exports = plugin.restartMainEvents.filter(row => row.event.startsWith('DIAGNOSTICS_EXPORT_'));
      assert.deepEqual(exports.map(row => row.event), ['DIAGNOSTICS_EXPORT_CANCELLED', 'DIAGNOSTICS_EXPORT_SAVED']);
      assert.deepEqual(exports[1].facts, {bytes: plugin.diagnosticsBundle.bytes});
      assert.ok(plugin.actions.runB.length > 0 && plugin.actions.runB.every(facts => ['unchanged', 'blocked', 'absent'].includes(facts.outcome)),
        'Run B changed a game folder');
      plugin.pluginEventsVerified = true;
    }
    if (config.scenario === 'journal') {
      // ET-016 PR-4: run 1 created and closed the history database (checked below); run 2 opened only the synthetic one.
      const journal = result.journal ??= {};
      journal.restartMainEvents = await diagnosticEvents(config.diagnosticsRestart);
      journal.restartServiceEvents = await diagnosticEvents(path.join(config.diagnosticsRestart, 'service'));
      journal.restartLauncherExit = result.launcherExit;
      await verifyJournalRun({config, record: journal, restartMainEvents: journal.restartMainEvents, restartServiceEvents: journal.restartServiceEvents});
    }
    if (config.scenario === 'recording') {
      // ET-015a PR-4: no history database may exist; the synthetic database replaces it (recording-observation.mjs).
      const recording = result.recording ??= {};
      recording.restartMainEvents = await diagnosticEvents(config.diagnosticsRestart);
      recording.restartServiceEvents = await diagnosticEvents(path.join(config.diagnosticsRestart, 'service'));
      recording.restartLauncherExit = result.launcherExit;
      await verifyRecordingRun({config, record: recording, recording: recordingSource, mainEvents: result.mainEvents, serviceEvents: result.serviceEvents,
        restartMainEvents: recording.restartMainEvents, restartServiceEvents: recording.restartServiceEvents, simulatorWaitMs: result.failure ? 1000 : 5000});
    } else if (config.scenario === 'hard-mode') await verifyHardModeRun({config, record: result.hardMode});
    else if (config.scenario === 'soak') await verifySoakRun({config, record: result.soak ??= {}, mainEvents: result.mainEvents, serviceEvents: result.serviceEvents});
    else if (config.scenario !== 'refusal' && !(config.scenario === 'ui' && config.uiCase === 'journal')) result.history.file = await verifyHistoryFile();
  } catch (error) {result.postconditionFailure = failure(error);}
  // A failed run still ends the simulator it started; the Job owns it otherwise.
  if (recordingSource && !result.recording?.simulator) {
    // A short bound: a simulator still waiting for a scripted connection is terminated, so result.json is written inside the Job.
    try {result.recordingProxy = recordingSource.statistics(); result.recordingSourceStop = await recordingSource.stop({waitMs: 1000});}
    catch (error) {result.recordingSourceFailure = failure(error);}
  }
  result.passed = !result.failure && !result.closeFailure && !result.traceFailure && !result.postconditionFailure && !result.sourceCloseFailure && !result.sourceV1CloseFailure &&
    !result.recordingSourceFailure && !result.soakSourceFailure;
  result.finishedUtc = new Date().toISOString();
  // ET-019 PR-12b: a soak's logs can hold hundreds of rows; its receipt keeps the rows its checks name and counts the rest.
  if (config.scenario === 'soak') compactSoakEvents(result);
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
// The external Job owns descendants even if launch, instrumentation or shutdown fails.
process.exit(result.passed ? 0 : 1);
