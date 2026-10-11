// Coordinator launches this script inside the reviewed Windows Job helper. Synthetic data only.
import { _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const output = process.argv[2]; const sid = process.argv[3]; const candidate = process.argv[4];
if (!output || !path.isAbsolute(output) || !/^S-1-[0-9-]+$/.test(sid) || !/^[a-f0-9]{40}$/.test(candidate)) throw new Error('absolute output, current user SID and frozen candidate SHA required');
await mkdir(output, { recursive: false }); // A rerun cannot overwrite an earlier failed receipt.
const directories = Object.fromEntries(['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'].map((key) => [key, path.join(output, key.toLowerCase())]));
await Promise.all(Object.values(directories).map((dir) => mkdir(dir)));
const env = { ...process.env, ...directories }; delete env.ELECTRON_RUN_AS_NODE;
const receipt = { passed: false, candidate, source: 'synthetic', compatibility: 'unverified', focusClickThroughDpi: 'manual game validation pending', forcedCleanup: [], startedUtc: new Date().toISOString() };
const logs = [];
const capture = (label, stream) => stream?.on('data', (chunk) => { if (logs.reduce((size, value) => size + value.length, 0) < 1000000) logs.push(`${label}: ${chunk.toString()}`); });
const waitExit = (child) => new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
const deadline = (promise, milliseconds, label) => {
  let timer;
  return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), milliseconds); })]).finally(() => clearTimeout(timer));
};
let fixture, fixtureExit, app, child, childExit, page, failure, closeAttempted = false;
async function disposePlaywright() {
  closeAttempted = true;
  try {
    await deadline(app.close(), 3000, 'Playwright connection disposal');
    receipt.playwrightDisposed = true;
  } catch (error) { receipt.cleanupError = String(error); throw error; }
}
const isAlive = (process) => process && process.exitCode === null && process.signalCode === null;
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json')));
  receipt.versions = { node: process.version, electron: manifest.devDependencies.electron, playwright: manifest.devDependencies['@playwright/test'], sdkArchive: '1.15', sdkApi: '1.01', wire: 'sp01-1' };
  receipt.hashes = {};
  for (const relative of ['experiments/sp01/build/Release/sp01_native_test.exe', 'experiments/sp01/build/Release/ets2telemetry_sp01.dll', 'experiments/sp01/tests/electron-smoke.mjs', 'node_modules/electron/dist/electron.exe']) receipt.hashes[relative] = createHash('sha256').update(await readFile(path.join(root, relative))).digest('hex');
  fixture = spawn(path.join(root, 'experiments/sp01/build/Release/sp01_native_test.exe'), ['--synthetic-fixture'], { windowsHide: true, cwd: output, env, stdio: ['ignore', 'pipe', 'pipe'] });
  fixtureExit = waitExit(fixture); capture('fixture.stdout', fixture.stdout); capture('fixture.stderr', fixture.stderr); receipt.fixturePid = fixture.pid;
  app = await electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/electron.exe'), cwd: output, env, args: [path.join(root, 'experiments/sp01/app/main.cjs'), '--game=eut2', `--sid=${sid}`, `--profile=${path.join(output, 'profile')}`, `--pipe-suffix=.synthetic.${fixture.pid}`], timeout: 15000 });
  child = app.process(); childExit = waitExit(child); capture('app.stdout', child.stdout); capture('app.stderr', child.stderr); receipt.appPid = child.pid;
  receipt.actualElectronVersions = await app.evaluate(() => process.versions);
  assert.equal(receipt.actualElectronVersions.electron, receipt.versions.electron);
  page = await app.firstWindow({ timeout: 5000 });
  await page.context().tracing.start({ screenshots: true, snapshots: true });
  await page.getByText('90 km/h', { exact: false }).waitFor({ timeout: 5000 });
  assert.equal(await page.locator('.metrics').innerText(), '90 km/h\n800.0 L');
  receipt.security = await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process, api: Object.keys(window.sp01) }));
  assert.deepEqual(receipt.security, { require: 'undefined', process: 'undefined', api: ['subscribe'] });
  receipt.window = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]; const pref = win.webContents.getLastWebPreferences();
    return { visible: win.isVisible(), focusable: win.isFocusable(), backgroundColor: win.getBackgroundColor(), sandbox: pref.sandbox, isolation: pref.contextIsolation, node: pref.nodeIntegration };
  });
  // Electron returns RGB only, excluding alpha; this assertion does not prove transparency.
  // https://www.electronjs.org/docs/latest/api/browser-window#wingetbackgroundcolor
  assert.deepEqual(receipt.window, { visible: false, focusable: false, backgroundColor: '#000000', sandbox: true, isolation: true, node: false });
  await page.screenshot({ path: path.join(output, 'synthetic-overlay.png'), omitBackground: true });
  receipt.fixtureExit = await deadline(fixtureExit, 10000, 'fixture natural exit');
  assert.deepEqual(receipt.fixtureExit, { code: 0, signal: null });
  await page.getByText('disconnected', { exact: false }).waitFor({ timeout: 3000 });
  await page.context().tracing.stop({ path: path.join(output, 'trace.zip') });
  // Playwright initiates app.quit and disposes its connection; the child handle was cached at launch.
  await disposePlaywright();
  receipt.appExit = await deadline(childExit, 3000, 'app normal exit');
  assert.deepEqual(receipt.appExit, { code: 0, signal: null });
  assert.ok(logs.join('').includes('SP01_SERVICE_EXIT:0'), 'utility service must stop normally');
  assert.ok(!logs.join('').includes('SP01_SERVICE_STOP_TIMEOUT'));
  receipt.passed = true;
} catch (error) {
  failure = error; receipt.error = error.stack ?? String(error);
  try { if (page) await deadline(page.context().tracing.stop({ path: path.join(output, 'failure-trace.zip') }), 2000, 'failure trace'); }
  catch (error) { receipt.traceCleanupError = String(error); }
} finally {
  if (app && !closeAttempted) { try { await disposePlaywright(); } catch { /* The receipt retains the failed disposal; no retry hides it. */ } }
  if (isAlive(child)) { receipt.forcedCleanup.push({ owner: 'app', pid: child.pid }); child.kill(); try { receipt.cleanupAppExit = await deadline(childExit, 2000, 'app cleanup'); } catch (error) { receipt.cleanupError = String(error); } }
  if (isAlive(fixture)) { receipt.forcedCleanup.push({ owner: 'fixture', pid: fixture.pid }); fixture.kill(); try { receipt.cleanupFixtureExit = await deadline(fixtureExit, 2000, 'fixture cleanup'); } catch (error) { receipt.cleanupError = String(error); } }
  if (receipt.forcedCleanup.length || receipt.cleanupError) receipt.passed = false;
  receipt.driverExitCode = receipt.passed ? 0 : 1;
  receipt.finishedUtc = new Date().toISOString();
  await writeFile(path.join(output, 'process.log'), logs.join(''));
  await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2));
}
if (failure || !receipt.passed) { console.error(failure ?? 'normal lifecycle not established'); process.exitCode = 1; }
else console.log(JSON.stringify(receipt));
// Receipts/logs are durable above. The external Job remains authoritative for any surviving descendants.
process.exit(receipt.passed ? 0 : 1);
