// Run only through the verified guest wrapper and its Job Object, never on the physical host.
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir, mkdtemp, readFile, readdir, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

const [kit, output, guardFile] = process.argv.slice(2);
const result = {schemaVersion: 1, startedUtc: new Date().toISOString(), finishedUtc: null,
  passed: false, applicationLaunched: false, nodeVersion: process.versions.node,
  playwrightCoreVersion: null, windowsPlaywrightShellWrapper: true, runs: [], failure: null};
const serializeError = error => ({name: error?.name ?? 'Error', message: String(error?.message ?? error), stack: error?.stack});
const persist = async () => {
  result.finishedUtc = new Date().toISOString();
  await writeFile(path.join(output, 'driver-result.json'), JSON.stringify(result, null, 2) + '\n');
};
async function within(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(code)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
async function logs(directory) {
  return (await readFile(path.join(directory, 'startup.jsonl'), 'utf8')).trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
const deadline = setTimeout(async () => {
  result.failure ??= serializeError(new Error('DRIVER_TOTAL_DEADLINE_52_SECONDS'));
  try { await persist(); } finally { process.exit(1); }
}, 52000);
try {
  assert.equal(process.platform, 'win32');
  assert.equal(path.resolve(kit), 'C:\\ETS2ET001Acceptance');
  assert.equal(process.env.ETS2TELEMETRY_ALLOW_DESKTOP_LAUNCH, '1');
  assert.equal(process.env.ETS2TELEMETRY_VM_JOB, '1');
  assert.equal(process.versions.node, '24.19.0');
  assert.ok(path.resolve(output).startsWith(path.join(kit, 'evidence') + path.sep));
  const guard = JSON.parse((await readFile(guardFile, 'utf8')).replace(/^\uFEFF/, ''));
  assert.equal(guard.vmUuid, '94674D56-D803-F4D5-9AAC-C4E91CFB475F');
  assert.equal(guard.labId, '9a047927-f94b-41cb-bda8-abcc7d0b76f1');
  assert.match(guard.manufacturer, /^VMware/);
  assert.equal(guard.jobRequired, true);
  const guardAge = Date.now() - Date.parse(guard.verifiedUtc);
  assert.ok(guardAge >= -5000 && guardAge < 90000, 'Fresh guest validation is required');
  assert.ok(Date.parse(guard.outerDeadlineUtc) - Date.now() >= 60000, 'Outer deadline must remain armed');
  const metadata = JSON.parse(await readFile(path.join(kit, 'node_modules/playwright-core/package.json'), 'utf8'));
  assert.equal(metadata.version, '1.64.0');
  result.playwrightCoreVersion = metadata.version;
  // playwright-core is self-contained for Electron; no browser download, checkout or dev tools are used.
  const {_electron: electron} = await import('playwright-core');
  for (let index = 1; index <= 2; index++) {
    const directory = await mkdtemp(path.join(output, `launch-${index}-`));
    const paths = Object.fromEntries(['cwd', 'temp', 'appdata', 'localappdata', 'profile', 'diagnostics'].map(name => [name, path.join(directory, name)]));
    await Promise.all(Object.values(paths).map(value => mkdir(value)));
    const run = {index, directory, cwd: paths.cwd, startedUtc: new Date().toISOString(), launcherPid: null,
      ready: false, security: null, status: null, probeDirectoriesBeforeClose: null,
      probeDirectoriesAfterClose: null, closeMilliseconds: null, launcherExitCode: null, launcherSignalCode: null,
      mainEvents: [], serviceEvents: [], passed: false, failure: null, closeFailure: null};
    result.runs.push(run);
    let application;
    try {
      result.applicationLaunched = true;
      application = await electron.launch({executablePath: path.join(kit, 'package/ETS2TelemetryDesktop.exe'),
        cwd: paths.cwd, timeout: 15000, env: {...process.env, TEMP: paths.temp, TMP: paths.temp,
          APPDATA: paths.appdata, LOCALAPPDATA: paths.localappdata,
          ETS2TELEMETRY_PROFILE_DIR: paths.profile, ETS2TELEMETRY_DIAGNOSTIC_DIR: paths.diagnostics}});
      // Upstream Playwright uses cmd.exe on Windows; this PID is the contained launcher.
      // Actual Electron/service exit proof comes from their JSONL and the complete Job drain.
      run.launcherPid = application.process().pid;
      const window = await application.firstWindow({timeout: 10000});
      await window.getByText('Telemetry service ready; isolated storage probe verified', {exact: true}).waitFor({state: 'visible', timeout: 10000});
      run.ready = true;
      run.security = await application.evaluate(({BrowserWindow}) => {
        const windows = BrowserWindow.getAllWindows();
        const preferences = windows[0].webContents.getLastWebPreferences();
        return {windowCount: windows.length, sandbox: preferences.sandbox,
          contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration};
      });
      assert.deepEqual(run.security, {windowCount: 1, sandbox: true, contextIsolation: true, nodeIntegration: false});
      run.status = await window.evaluate(async () => ({require: typeof globalThis.require,
        process: typeof globalThis.process, bridgeKeys: Object.keys(globalThis.desktop),
        bridgeFrozen: Object.isFrozen(globalThis.desktop), status: await globalThis.desktop.getStatus()}));
      assert.deepEqual(run.status, {require: 'undefined', process: 'undefined', bridgeKeys: ['getStatus'],
        bridgeFrozen: true, status: {service: 'ready', storage: 'verified', synthetic: true}});
      run.probeDirectoriesBeforeClose = (await readdir(paths.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
      assert.equal(run.probeDirectoriesBeforeClose.length, 1, 'Ready probe must exist before shutdown');
    } catch (error) { run.failure = serializeError(error); }
    finally {
      if (application) {
        const launcher = application.process();
        const started = performance.now();
        try {
          await within(application.close(), 8000, 'APP_CLOSE_TIMEOUT_8_SECONDS');
          run.closeMilliseconds = performance.now() - started;
          run.launcherExitCode = launcher.exitCode;
          run.launcherSignalCode = launcher.signalCode;
          assert.equal(run.launcherExitCode, 0, 'Contained Playwright launcher exit must be 0');
          assert.equal(run.launcherSignalCode, null, 'Launcher exit must not use forced termination');
        } catch (error) { run.closeFailure = serializeError(error); }
      }
    }
    try {
      run.probeDirectoriesAfterClose = (await readdir(paths.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
      assert.deepEqual(run.probeDirectoriesAfterClose, [], 'No temporary SQLite probe may remain');
      run.mainEvents = await logs(paths.diagnostics);
      run.serviceEvents = await logs(path.join(paths.diagnostics, 'service'));
      const main = run.mainEvents;
      assert.equal(main.filter(record => record.event === 'APP_START').length, 1);
      assert.equal(main.find(record => record.event === 'APP_START')?.detail?.packaged, true);
      assert.equal(main.find(record => record.event === 'SERVICE_EXIT')?.detail?.code, 0);
      assert.equal(main.find(record => record.event === 'APP_EXIT')?.detail?.code, 0);
      assert.equal(main.filter(record => record.event === 'SERVICE_EXIT').length, 1);
      assert.equal(main.filter(record => record.event === 'APP_EXIT').length, 1);
      assert.ok(main.some(record => record.event === 'APP_STOP_REQUESTED'));
      assert.ok(run.serviceEvents.some(record => record.event === 'STORAGE_VERIFIED'));
      assert.ok(run.serviceEvents.some(record => record.event === 'SERVICE_REPORT' && record.detail?.type === 'stopped'));
      assert.ok(!main.some(record => /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|RENDER_PROCESS_GONE|INVALID/.test(record.event)), 'No failure diagnostic may be hidden');
      assert.ok(!run.serviceEvents.some(record => /FAILED|TIMEOUT/.test(record.event)), 'No service failure diagnostic may be hidden');
    } catch (error) { run.failure ??= serializeError(error); }
    run.passed = run.ready && !run.failure && !run.closeFailure;
    await persist();
    if (!run.passed) throw new Error(`PACKAGED_LIFECYCLE_FAILED_RUN_${index}`);
  }
  assert.notEqual(result.runs[0].cwd, result.runs[1].cwd);
  result.passed = true;
} catch (error) { result.failure ??= serializeError(error); }
finally { clearTimeout(deadline); await persist(); }
// The Job Object checks for remaining descendants and treats cleanup as a failure (125).
process.exit(result.passed ? 0 : 1);
