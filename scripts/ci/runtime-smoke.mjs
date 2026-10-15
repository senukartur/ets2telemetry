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
  overlayOverflow, SYNTHETIC_V0_VALUE_IDS, SYNTHETIC_V0V1_HIDDEN_ROWS, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V1_LIVE_ROWS, SYNTHETIC_V1_OVERLAY_CURRENT,
  SYNTHETIC_V1_OVERLAY_STOPPED, SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_V1_STALE, SYNTHETIC_V1_VALUE_IDS, waitForCompleteLive, waitForCurrentTelemetry,
  waitForNotCurrentLive, waitForOverlayV1, waitForV1NotCurrentLive
} from './renderer-observation.mjs';
import {rendererPages, runOverlaySmoke, windowSecurity, verifyRendererStyles} from './overlay-observation.mjs';
import {runLifecycleSmoke, seedLifecycleSettings, verifyLifecycleRestart} from './lifecycle-observation.mjs';
// These read-only globals are used only inside serialized Playwright browser callbacks.
/* global document: readonly, getComputedStyle: readonly, innerHeight: readonly, innerWidth: readonly */

const [configFile] = process.argv.slice(2);
const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
const result = {scenario: config.scenario === 'lifecycle' ? 'V0 TRAY-LIFECYCLE-SETTINGS / partial REG-009, REG-011, REG-012, REG-017' : config.scenario === 'overlay' ? 'V0 HIDDEN-OVERLAY-PROJECTION / partial REG-009, REG-011, REG-017' : config.scenario === 'telemetry' ? 'V0 SOURCE-RENDERER-RECOVERY / partial REG-003, REG-010, REG-011, REG-017' : 'SCAFFOLD-WORKER / partial REG-011, REG-017', passed: false,
  scenarioKind: config.scenario ?? 'scaffold',
  commit: config.commit, mode: config.mode, node: process.versions, expected: {
    status: {service: 'ready', storage: 'verified', synthetic: true}, exit: 0, probesAfterExit: []},
  // The Job's 25% hard CPU cap is relative to all logical processors; record them to size the actual budget.
  host: {logicalProcessors: os.availableParallelism()}, startedUtc: new Date().toISOString()};
let application;
let launcher;
let timer;
let tracing = false;
let telemetrySource;
// ET-010c: the telemetry scenario also serves synthetic protocol v1 data; every other scenario stays v0-only.
let telemetrySourceV1;
const failure = error => ({name: error.name, message: error.message, stack: error.stack});
// Driver timeline on its own wall and monotonic clocks, to align with app diagnostics and the Job CPU series.
result.phases = [];
const phase = name => result.phases.push({phase: name, utc: new Date().toISOString(), monotonicMs: Math.round(performance.now() * 10) / 10});
const diagnosticEvents = async directory => (await readFile(path.join(directory, 'startup.jsonl'), 'utf8'))
  .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
// ET-013: one service run opens the history database once per service process (`created` per opening, in order),
// never reports it unavailable, and closes it in its storage shutdown step before its single stopped report.
const verifyHistoryEvents = (service, created) => {
  const opened = service.filter(row => row.event === 'HISTORY_STORAGE_OPENED').map(row => row.facts);
  assert.deepEqual(opened, created.map(value => ({schemaVersion: 1, created: value, migratedFrom: null})));
  assert.ok(!service.some(row => row.event === 'HISTORY_STORAGE_UNAVAILABLE'), 'History storage was unavailable');
  const closed = service.flatMap((row, index) => row.event === 'HISTORY_STORAGE_CLOSED' ? [index] : []);
  const stopped = service.findLastIndex(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped');
  assert.equal(closed.length, 1); assert.ok(closed[0] < stopped, 'History storage closed after the stopped report');
  assert.deepEqual(service.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'history-storage').map(row => row.facts.outcome), ['ok']);
  return {opened, closed: closed.length};
};
// The database is in the isolated LOCALAPPDATA, checkpointed and closed: a SQLite file of this application at schema
// version 1 without WAL, shared-memory or journal files, and no pre-migration backup for a new database.
const verifyHistoryFile = async () => {
  const database = path.join(config.localappdata, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
  const file = await open(database, 'r');
  const header = Buffer.alloc(100);
  try {await file.read(header, 0, 100, 0);} finally {await file.close();}
  const facts = {magic: header.subarray(0, 15).toString('latin1'), applicationId: header.readInt32BE(68), userVersion: header.readUInt32BE(60),
    sidecars: ['-wal', '-shm', '-journal'].filter(suffix => existsSync(database + suffix)),
    backups: existsSync(path.join(config.localappdata, 'ETS2Telemetry', 'backups'))};
  assert.deepEqual(facts, {magic: 'SQLite format 3', applicationId: 1163154226, userVersion: 1, sidecars: [], backups: false});
  return facts;
};
// Every launch of one run shares the isolated profile, TEMP, APPDATA and LOCALAPPDATA; only the diagnostic directory may differ.
const environment = diagnostics => ({...process.env, TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata,
  LOCALAPPDATA: config.localappdata, ETS2TELEMETRY_PROFILE_DIR: config.profile,
  ETS2TELEMETRY_DIAGNOSTIC_DIR: diagnostics,
  ...(telemetrySource ? {ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_SOURCE_KIND: 'synthetic', ETS2TELEMETRY_SOURCE_PIPE: telemetrySource.endpoint} : {}),
  ...(telemetrySourceV1 ? {ETS2TELEMETRY_SOURCE_PIPE_V1: telemetrySourceV1.endpoint} : {})});
const launchOptions = diagnostics => ({timeout: 20000, cwd: config.cwd,
  ...(config.mode === 'packaged' ? {executablePath: config.executable, args: config.forceRendererProcessReuse ? ['--renderer-process-limit=1'] : []} :
    {args: [config.checkout, ...(config.forceRendererProcessReuse ? ['--renderer-process-limit=1'] : [])]}),
  env: environment(diagnostics)});
try {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, '24.19.0');
  result.playwright = JSON.parse(await readFile(new URL('../../node_modules/playwright-core/package.json', import.meta.url))).version;
  assert.equal(result.playwright, '1.64.0');
  if (config.scenario === 'telemetry' || config.scenario === 'overlay' || config.scenario === 'lifecycle') telemetrySource = await startLiveSmokeSource(config.checkout);
  if (config.scenario === 'telemetry') telemetrySourceV1 = await startLiveSmokeSourceV1(config.checkout);
  // ET-011b: the lifecycle journey starts from a deliberately invalid settings file in the isolated LOCALAPPDATA.
  if (config.scenario === 'lifecycle') await seedLifecycleSettings(config);
  phase('launch-requested');
  application = await electron.launch(launchOptions(config.diagnostics));
  launcher = application.process();
  phase('launch-returned');
  await application.context().tracing.start({screenshots: true, snapshots: true});
  tracing = true;
  phase('tracing-started');
  const {dashboard: window, overlay} = await rendererPages(application).catch(error => {
    // Playwright's own view of the windows, read locally without a protocol round trip.
    result.pagesAtRendererPagesFailure = application.windows().map(page => page.url());
    throw error;
  });
  phase('renderer-pages-found');
  await window.getByText('Telemetry service ready; isolated storage probe verified', {exact: true})
    .waitFor({state: 'visible', timeout: 10000});
  phase('dashboard-ready-visible');
  result.runtime = await application.evaluate(({app, BrowserWindow}) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {versions: process.versions, packaged: app.isPackaged, rendererProcessLimit: app.commandLine.getSwitchValue('renderer-process-limit'),
      security: {sandbox: preferences.sandbox, isolation: preferences.contextIsolation, node: preferences.nodeIntegration}};
  });
  assert.equal(result.runtime.versions.electron, '44.7.0');
  assert.equal(result.runtime.packaged, config.mode === 'packaged');
  assert.equal(result.runtime.rendererProcessLimit, config.forceRendererProcessReuse ? '1' : '');
  assert.deepEqual(result.runtime.security, {sandbox: true, isolation: true, node: false});
  result.runtime.windows = await windowSecurity(application);
  result.runtime.rendererStyles = await verifyRendererStyles(window, overlay);
  result.actual = await window.evaluate(async () => ({require: typeof globalThis.require,
    process: typeof globalThis.process, keys: Object.keys(globalThis.desktop),
    frozen: Object.isFrozen(globalThis.desktop), status: await globalThis.desktop.getStatus()}));
  assert.deepEqual(result.actual, {require: 'undefined', process: 'undefined', keys: ['getStatus', 'selectSource', 'subscribeLive', 'getAppState', 'subscribeAppState', 'exitApplication', 'setUnitProfile', 'setOverlayLayout', 'setOverlaySections',
    'beginOverlayEdit', 'setOverlayEditScale', 'resetOverlayEditPlacement', 'finishOverlayEdit'],
    frozen: true, status: result.expected.status});
  result.probesBeforeExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
  assert.equal(result.probesBeforeExit.length, 1);
  if (config.scenario === 'overlay') {
    result.overlay = {};
    await runOverlaySmoke(application, window, overlay, telemetrySource, result.overlay);
    await overlay.screenshot({path: path.join(config.output, 'hidden-overlay-dom.png')});
  }
  if (config.scenario === 'telemetry') {
    // The dashboard is taller than the smoke window, and outside wheel input on a shared desktop can scroll it, also
    // during the renderer stall (compositor scrolling). Return to the top right before each wait that requires the
    // status, speed and fuel lines inside the viewport; the predicates themselves are unchanged.
    const atTop = () => window.evaluate(() => globalThis.scrollTo(0, 0));
    const current = async phase => {
      await atTop();
      const observation = await waitForCurrentTelemetry(window);
      (result.rendererObservations ??= []).push({phase, ...observation});
    };
    const resizeOverlay = (width, height) => application.evaluate(({BrowserWindow}, size) => {
      const target = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('view=overlay'));
      if (!target) return null;
      target.setBounds({...target.getBounds(), width: size.width, height: size.height}); return target.getBounds();
    }, {width, height});
    const overlayState = () => overlay.evaluate(() => ({layout: globalThis.document.querySelector('[data-testid="overlay-root"]')?.getAttribute('data-layout') ?? null,
      width: globalThis.innerWidth, height: globalThis.innerHeight, sections: globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length}));
    // A short bound for the review-only layouts keeps two missed waits well inside the Job's 60 s limit; the strip
    // restore keeps the usual 10 s. `sections` is null when the count could not be read, and is then not compared.
    const renderedLayout = async (layout, width, sections, timeout) => {
      const handle = await overlay.waitForFunction(expected => {
        const root = globalThis.document.querySelector('[data-testid="overlay-root"]');
        return root?.getAttribute('data-layout') === expected.layout && Math.abs(globalThis.innerWidth - expected.width) <= 1 &&
          (expected.sections === null || globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length === expected.sections);
      }, {layout, width, sections}, {timeout});
      await handle.dispose();
    };
    const measureLayouts = async layouts => {
      const record = {};
      let sections = null;
      try {
        sections = await overlay.evaluate(() => globalThis.document.querySelectorAll('[data-testid^="overlay-section-"]').length);
        for (const [layout, width, height] of layouts) {
          const saved = await window.evaluate(value => globalThis.desktop.setOverlayLayout(value), layout);
          record[layout] = {saved: saved.overlay.layout, resized: await resizeOverlay(width, height)};
          await renderedLayout(layout, width, sections, 3000);
          record[layout].overflow = await overlay.evaluate(overlayOverflow);
        }
      } catch (error) {record.error = failure(error); record.stateAtError = await overlayState().catch(() => null);}
      try {
        await window.evaluate(() => globalThis.desktop.setOverlayLayout('strip'));
        await resizeOverlay(1280, 38); await renderedLayout('strip', 1280, sections, 10000);
        record.restored = 'strip';
      } catch (error) {record.restoreError = failure(error);}
      return record;
    };
    await current('initial');
    result.telemetry = {origin: 'synthetic', speedKmh: 90, fuelL: 73, recording: false};
    // ET-010b/ET-010c: the live card shows the complete v0 field set with the v1 rows of the same job beside it, and the
    // hidden overlay document the v1 sections, all from the same pair of observations.
    result.telemetry.liveFields = await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    result.telemetry.v1Fields = Object.fromEntries(SYNTHETIC_V1_LIVE_ROWS.map(([id]) => [id, result.telemetry.liveFields[id]]));
    result.telemetry.overlayV1 = {current: await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_CURRENT)};
    // For review only (coordinator decision C3): which strip sections lie outside the overlay root.
    result.telemetry.overlayOverflow = await overlay.evaluate(overlayOverflow);
    // Also for review only, recorded and never asserted (docs/validation/et-012a.md asked for it): the card and HUD
    // layouts with every section filled. Without a game window the controller never places the overlay, so the hidden
    // window is sized here to each layout's nominal size (overlay-geometry.ts) and restored to the strip afterwards.
    // The layout saves are real settings writes in the isolated profile: a failed write logs SETTINGS_WRITE_FAILED,
    // which the strict diagnostic postcondition below rejects, so it fails the run as a product failure.
    result.telemetry.overlayLayoutOverflow = await measureLayouts([['card', 300, 360], ['hud', 320, 320]]);
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
      await atTop(); result.telemetry.v1Stale = await waitForV1NotCurrentLive(window, SYNTHETIC_V1_VALUE_IDS, '^stale:', 'Speed: 90.0 km/h');
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
    const recovered = await window.waitForFunction(() => {
      const read = id => {
        const nodes = document.querySelectorAll(`[data-testid="${id}"]`);
        if (nodes.length !== 1) return undefined;
        const node = nodes[0], bounds = node.getBoundingClientRect();
        return getComputedStyle(node).visibility === 'visible' && bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.right > 0 && bounds.top < innerHeight && bounds.left < innerWidth ? node.innerText : undefined;
      };
      return /^connected:/.test(read('telemetry-status') ?? '') && read('speed') === 'Speed: 72.0 km/h' && read('fuel') === 'Fuel: 71.0 L';
    }, undefined, {timeout: 10000});
    try {assert.equal(await recovered.jsonValue(), true);} finally {await recovered.dispose();}
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
    const retiredAfter = await precommitRetirements();
    result.telemetry.delayedCommit = {holdMilliseconds: commitDelayMilliseconds, precommitRetirementsBefore: retiredBefore, precommitRetirementsAfter: retiredAfter};
    assert.equal(retiredAfter - retiredBefore, 1, 'Delayed-commit reload did not retire the replaced document subscription');
    result.telemetry.rendererReloads = 3;
    const restartRequested = await application.evaluate(({app}) => app.emit('ets2telemetry:diagnostic-service-exit'));
    assert.equal(restartRequested, true, 'Opt-in diagnostic event unavailable');
    result.telemetry.diagnosticCrashRequested = true;
    await window.getByText(/^(restarting|service-failed):/).waitFor({state: 'visible', timeout: 5000});
    await current('service-restart'); result.telemetry.serviceRestartRecovered = true;
    result.telemetry.source = telemetrySource.statistics();
    assert.equal(result.telemetry.source.connections, 2, 'Expected one initial source connection and one service-restart connection');
    // The replacement service connects v1 again; the card shows both sources once more.
    await atTop(); await waitForCompleteLive(window, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V0V1_HIDDEN_ROWS);
    result.telemetry.sourceV1 = telemetrySourceV1.statistics();
    assert.equal(result.telemetry.sourceV1.connections, 2, 'Expected one initial v1 source connection and one service-restart connection');
    await telemetrySource.stop();
    await window.getByText('Speed: unavailable', {exact: true}).waitFor({state: 'visible', timeout: 5000});
    assert.match(await window.getByTestId('telemetry-status').innerText(), /^(disconnected|waiting):/);
    result.telemetry.staleAfterDisconnect = true;
    await atTop(); await waitForNotCurrentLive(window, ['live-gear', 'live-cargo', 'live-odometer'], '^(disconnected|waiting):');
    result.telemetry.liveDisconnectedHidden = true;
    await telemetrySourceV1.stop();
    await atTop(); await waitForV1NotCurrentLive(window, SYNTHETIC_V1_VALUE_IDS, '^(disconnected|waiting):', 'Speed: unavailable');
    result.telemetry.overlayV1.stopped = await waitForOverlayV1(overlay, SYNTHETIC_V1_OVERLAY_STOPPED);
    result.telemetry.v1DisconnectedHidden = true;
  }
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
  phase('journey-complete');
  if (config.scenario !== 'lifecycle') await window.screenshot({path: path.join(config.output, 'ready.png')});
} catch (error) {result.failure = failure(error); phase('failed');}
finally {
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
      await Promise.race([application.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('APP_CLOSE_TIMEOUT_8_SECONDS')), 8000);
      })]);
      result.closeMilliseconds = performance.now() - start;
      result.launcherExit = launcher.exitCode;
      assert.equal(result.launcherExit, 0);
      assert.equal(launcher.signalCode, null);
    } catch (error) {result.closeFailure = failure(error);}
    finally {clearTimeout(timer); phase('close-settled');}
  }
  try {
    // Preserve lifecycle evidence even when a later cleanup assertion fails.
    result.mainEvents = await diagnosticEvents(config.diagnostics);
    result.serviceEvents = await diagnosticEvents(path.join(config.diagnostics, 'service'));
    result.probesAfterExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
    if (telemetrySource && result.telemetry?.serviceRestartRecovered) {
      // A deliberately killed worker's original isolated probe is retained as crash evidence.
      // The replacement service must remove its own normal-shutdown probe.
      assert.deepEqual(result.probesAfterExit, result.probesBeforeExit);
      result.telemetry.retainedCrashProbe = result.probesAfterExit;
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
    result.history = verifyHistoryEvents(result.serviceEvents, telemetrySource && result.telemetry?.serviceRestartRecovered ? [true, false] : [true]);
    assert.ok(![...result.mainEvents, ...result.serviceEvents].some(row =>
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
      // Settings diagnostics: run A falls back from the invalid file, quarantines it and saves once; run B only loads.
      const settingsEvents = rows => rows.filter(row => row.event.startsWith('SETTINGS_')).map(row => ({event: row.event, facts: row.facts ?? null}));
      lifecycle.settingsEvents = {runA: settingsEvents(result.mainEvents), runB: settingsEvents(lifecycle.restartMainEvents)};
      // A read that outlasted its 1000 ms load budget under CPU starvation is preceded by exactly one pending row; the
      // rows after it are the same as for a read within the budget.
      const pending = {event: 'SETTINGS_LOAD_PENDING', facts: {state: 'loading', reason: 'load-budget'}};
      const late = rows => rows[0]?.event === pending.event ? [pending] : [];
      lifecycle.settingsLateRead = {runA: late(lifecycle.settingsEvents.runA).length === 1, runB: late(lifecycle.settingsEvents.runB).length === 1};
      assert.deepEqual(lifecycle.settingsEvents.runA, [...late(lifecycle.settingsEvents.runA), {event: 'SETTINGS_FALLBACK', facts: {state: 'invalid-file'}},
        {event: 'SETTINGS_QUARANTINED', facts: {state: 'invalid-file'}}, {event: 'SETTINGS_SAVED', facts: {game: 'ets2', profile: 'us-customary'}}]);
      assert.deepEqual(lifecycle.settingsEvents.runB, [...late(lifecycle.settingsEvents.runB), {event: 'SETTINGS_LOADED', facts: {state: 'loaded'}}]);
      lifecycle.restartLauncherExit = result.launcherExit;
      lifecycle.shutdownClean = true;
    }
    result.history.file = await verifyHistoryFile();
  } catch (error) {result.postconditionFailure = failure(error);}
  result.passed = !result.failure && !result.closeFailure && !result.traceFailure && !result.postconditionFailure && !result.sourceCloseFailure && !result.sourceV1CloseFailure;
  result.finishedUtc = new Date().toISOString();
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
// The external Job owns descendants even if launch, instrumentation or shutdown fails.
process.exit(result.passed ? 0 : 1);
