import assert from 'node:assert/strict';
import path from 'node:path';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {_electron as electron} from '@playwright/test';

const [configFile] = process.argv.slice(2);
const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
const result = {scenario: 'SCAFFOLD-WORKER / partial REG-011, REG-017', passed: false,
  commit: config.commit, mode: config.mode, node: process.versions, expected: {
    status: {service: 'ready', storage: 'verified', synthetic: true}, exit: 0, probesAfterExit: []},
  startedUtc: new Date().toISOString()};
let application;
let timer;
let tracing = false;
const failure = error => ({name: error.name, message: error.message, stack: error.stack});
try {
  assert.equal(process.platform, 'win32');
  assert.equal(process.arch, 'x64');
  assert.equal(process.versions.node, '24.19.0');
  result.playwright = JSON.parse(await readFile(new URL('../../node_modules/playwright-core/package.json', import.meta.url))).version;
  assert.equal(result.playwright, '1.64.0');
  application = await electron.launch({timeout: 20000, cwd: config.cwd,
    ...(config.mode === 'packaged' ? {executablePath: config.executable} : {args: [config.checkout]}),
    env: {...process.env, TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata,
      LOCALAPPDATA: config.localappdata, ETS2TELEMETRY_PROFILE_DIR: config.profile,
      ETS2TELEMETRY_DIAGNOSTIC_DIR: config.diagnostics}});
  await application.context().tracing.start({screenshots: true, snapshots: true});
  tracing = true;
  const window = await application.firstWindow({timeout: 10000});
  await window.getByText('Telemetry service ready; isolated storage probe verified', {exact: true})
    .waitFor({state: 'visible', timeout: 10000});
  result.runtime = await application.evaluate(({app, BrowserWindow}) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {versions: process.versions, packaged: app.isPackaged,
      security: {sandbox: preferences.sandbox, isolation: preferences.contextIsolation, node: preferences.nodeIntegration}};
  });
  assert.equal(result.runtime.versions.electron, '44.7.0');
  assert.equal(result.runtime.packaged, config.mode === 'packaged');
  assert.deepEqual(result.runtime.security, {sandbox: true, isolation: true, node: false});
  result.actual = await window.evaluate(async () => ({require: typeof globalThis.require,
    process: typeof globalThis.process, keys: Object.keys(globalThis.desktop),
    frozen: Object.isFrozen(globalThis.desktop), status: await globalThis.desktop.getStatus()}));
  assert.deepEqual(result.actual, {require: 'undefined', process: 'undefined', keys: ['getStatus'],
    frozen: true, status: result.expected.status});
  result.probesBeforeExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
  assert.equal(result.probesBeforeExit.length, 1);
  await window.screenshot({path: path.join(config.output, 'ready.png')});
} catch (error) {result.failure = failure(error);}
finally {
  if (application) {
    if (tracing) {
      try {await application.context().tracing.stop({path: path.join(config.output, 'trace.zip')});}
      catch (error) {result.traceFailure = failure(error);}
    }
    const start = performance.now();
    try {
      await Promise.race([application.close(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('APP_CLOSE_TIMEOUT_8_SECONDS')), 8000);
      })]);
      result.closeMilliseconds = performance.now() - start;
      result.launcherExit = application.process().exitCode;
      assert.equal(result.launcherExit, 0);
      assert.equal(application.process().signalCode, null);
    } catch (error) {result.closeFailure = failure(error);}
    finally {clearTimeout(timer);}
  }
  try {
    result.probesAfterExit = (await readdir(config.temp)).filter(name => name.startsWith('ets2telemetry-probe-'));
    assert.deepEqual(result.probesAfterExit, []);
    const logs = async directory => (await readFile(path.join(directory, 'startup.jsonl'), 'utf8'))
      .trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    result.mainEvents = await logs(config.diagnostics);
    result.serviceEvents = await logs(path.join(config.diagnostics, 'service'));
    for (const name of ['APP_EXIT', 'SERVICE_EXIT']) {
      const rows = result.mainEvents.filter(row => row.event === name);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].detail.code, 0);
    }
    assert.ok(result.serviceEvents.some(row => row.event === 'STORAGE_VERIFIED'));
    assert.ok(result.serviceEvents.some(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped'));
    assert.ok(![...result.mainEvents, ...result.serviceEvents].some(row =>
      /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/.test(row.event)));
  } catch (error) {result.postconditionFailure = failure(error);}
  result.passed = !result.failure && !result.closeFailure && !result.traceFailure && !result.postconditionFailure;
  result.finishedUtc = new Date().toISOString();
  await writeFile(path.join(config.output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
}
// The external Job owns descendants even if launch, instrumentation or shutdown fails.
process.exit(result.passed ? 0 : 1);
