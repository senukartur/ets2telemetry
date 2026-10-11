// Coordinator runs this synthetic regression once inside the standard 60-second Job.
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
const [output, manifestPath, manifestSha] = process.argv.slice(2);
const manual = 'D:\\Projects\\ETS2Telemetry\\.local\\sp01-manual';
if (!output || !path.isAbsolute(output) || path.dirname(output).toLowerCase() !== manual.toLowerCase() || !/^g03-window-fixed-run-[a-z0-9-]+$/.test(path.basename(output)) || !manifestPath || !path.isAbsolute(manifestPath) || !/^[A-F0-9]{64}$/.test(manifestSha)) throw new Error('Fresh isolated output and reviewed absolute manifest/SHA required');
await mkdir(output, { recursive: false });
const prep = path.dirname(manifestPath), logs = []; let logBytes = 0;
const receipt = { passed: false, source: 'synthetic-only', gameAcceptance: 'G03 retry pending', historicalProbe2: 'Original baseline drift not reproduced; invariant repair regression only', browserExitCode: null, browserExitCodeEvidence: 'Unavailable; verified image/ancestry and post-close absence are separate', playwrightDisposed: false, forcedCleanup: [], startedUtc: new Date().toISOString(), driverPid: process.pid };
const capture = (label, stream) => stream?.on('data', (chunk) => { if (logBytes < 1000000) { const value = `${label}: ${chunk}`; logs.push(value); logBytes += Buffer.byteLength(value); } });
const waitExit = (child) => new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
const deadline = (promise, ms, label) => { let timer; return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} deadline`)), ms); })]).finally(() => clearTimeout(timer)); };
const alive = (child) => child && child.exitCode === null && child.signalCode === null;
let app, child, childExit, manifest, env, closeAttempted = false, absenceAttempted = false;
async function close() { closeAttempted = true; await deadline(app.close(), 3000, 'Playwright disposal'); receipt.playwrightDisposed = true; }
async function readOnly(script, args, label) {
  const probe = spawn(manifest.pwshPath, ['-NoProfile', '-File', path.join(prep, script), ...args], { cwd: output, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = waitExit(probe); let text = ''; probe.stdout.on('data', (chunk) => { text += chunk; if (text.length > 100000) probe.kill(); }); capture(`${label}.stderr`, probe.stderr);
  try { assert.deepEqual(await deadline(exit, 3500, label), { code: 0, signal: null }); return JSON.parse(text); }
  catch (error) { if (alive(probe)) { receipt.forcedCleanup.push({ owner: label, pid: probe.pid }); probe.kill(); await deadline(exit, 1500, 'helper cleanup').catch(() => {}); } throw error; }
}
async function identity(stage) {
  if (stage === 'After') absenceAttempted = true;
  return readOnly('Read-ProcessIdentity.ps1', ['-Stage', stage, '-BrowserPid', String(receipt.browserPid), '-TransportPid', String(receipt.transportChildPid), '-DriverPid', String(process.pid), '-ElectronPath', path.join(manifest.worktree, 'node_modules/electron/dist/electron.exe')], `identity-${stage}`);
}
async function native(info, label) {
  const value = await readOnly('Read-NativeGeometry.ps1', ['-AppPid', String(info.browserPid), '-Handles', info.handle], `native-${label}`);
  assert.equal(value.rectStructSize, 16);
  assert.equal(value.windows.length, 1); assert.equal(value.windows[0].pid, receipt.browserPid);
  receipt.native ??= {}; receipt.native[label] = value;
  const rect = value.windows[0].windowRect;
  assert.ok(Math.abs((rect.Right - rect.Left) - 280 * receipt.scaleFactor) <= 2, 'native width differs from fixed bounds');
  assert.ok(Math.abs((rect.Bottom - rect.Top) - 96 * receipt.scaleFactor) <= 2, 'native height differs from fixed bounds');
  return value;
}
const fixed = (row, anchor) => { assert.deepEqual(row.bounds, { x: Math.round(anchor.x + 20), y: Math.round(anchor.y + 20), width: 280, height: 96 }); assert.deepEqual(row.contentBounds, row.bounds); assert.equal(row.focusable, false); assert.equal(row.focused, false); };
try {
  const bytes = await readFile(manifestPath); assert.equal(createHash('sha256').update(bytes).digest('hex').toUpperCase(), manifestSha); manifest = JSON.parse(bytes);
  assert.match(manifest.candidate, /^[a-f0-9]{40}$/); receipt.candidate = manifest.candidate; assert.equal(process.version, `v${manifest.node}`);
  assert.equal(execFileSync('C:\\Program Files\\Git\\cmd\\git.exe', ['-C', manifest.worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim(), manifest.candidate);
  receipt.inputHashes = {};
  for (const input of manifest.inputs) { const hash = createHash('sha256').update(await readFile(input.path)).digest('hex').toUpperCase(); assert.equal(hash, input.sha256); receipt.inputHashes[input.path] = hash; }
  const require = createRequire(path.join(manifest.worktree, 'package.json')); assert.equal(require('@playwright/test/package.json').version, manifest.playwright); const { _electron: electron } = require('@playwright/test');
  const dirs = Object.fromEntries(['TEMP', 'TMP', 'APPDATA', 'LOCALAPPDATA'].map((key) => [key, path.join(output, key.toLowerCase())])); await Promise.all(Object.values(dirs).map((dir) => mkdir(dir)));
  env = { ...process.env, ...dirs }; delete env.ELECTRON_RUN_AS_NODE; assert.ok(!Object.hasOwn(env, 'ELECTRON_RUN_AS_NODE')); receipt.runAsNodeAbsent = true;
  app = await electron.launch({ executablePath: path.join(manifest.worktree, 'node_modules/electron/dist/electron.exe'), cwd: output, env, args: [path.join(manifest.worktree, 'experiments/sp01/tests/window-geometry.app.cjs'), `--profile=${path.join(output, 'profile')}`], timeout: 12000 });
  child = app.process(); childExit = waitExit(child); receipt.transportChildPid = child.pid; capture('app.stdout', child.stdout); capture('app.stderr', child.stderr);
  await deadline(app.evaluate(async () => { const started = performance.now(); while (!globalThis.__sp01WindowRegression) { if (performance.now() - started > 2500) throw new Error('Regression ready deadline'); await new Promise((resolve) => setTimeout(resolve, 25)); } }), 3000, 'readiness');
  const info = () => app.evaluate(() => globalThis.__sp01WindowRegression.info());
  receipt.initial = await info(); receipt.browserPid = receipt.initial.browserPid; receipt.versions = receipt.initial.versions; receipt.scaleFactor = receipt.initial.display.scaleFactor;
  assert.equal(receipt.versions.electron, manifest.electron); assert.equal(receipt.scaleFactor, 1.5); assert.deepEqual(receipt.initial.security, { sandbox: true, isolation: true, node: false });
  receipt.identity = await identity('Before'); assert.equal(receipt.identity.ancestryVerified, true); assert.equal(receipt.identity.browserImageMatchesPinned, true);
  receipt.stages = {};
  const step = async (name) => { const rows = await deadline(app.evaluate((stage) => globalThis.__sp01WindowRegression.step(stage), name), 6500, name); receipt.stages[name] = rows; return rows; };
  const first = (await step('initial'))[0]; fixed(first, receipt.initial.anchor); await native(await info(), 'initial');
  const page = await app.firstWindow({ timeout: 3000 }); page.setDefaultTimeout(3000); receipt.renderer = await page.locator('main').innerText(); assert.ok(receipt.renderer.includes('SYNTHETIC'));
  await page.screenshot({ path: path.join(output, 'initial.png'), omitBackground: true, timeout: 3000 });
  const repeated = await step('same-anchor'); assert.equal(repeated.length, 80); for (const row of repeated) { fixed(row, receipt.initial.anchor); assert.equal(row.writes, first.writes); }
  const moved = (await step('moved'))[0]; fixed(moved, receipt.initial.moved); assert.equal(moved.writes, first.writes + 1); await native(await info(), 'moved');
  const stableMoved = await step('same-moved-anchor'); assert.equal(stableMoved.length, 20); for (const row of stableMoved) { fixed(row, receipt.initial.moved); assert.equal(row.writes, moved.writes); }
  const seeded = (await step('seeded-oversize'))[0]; assert.equal(seeded.bounds.height, 420); assert.equal(seeded.bounds.width, 282);
  const repaired = (await step('repaired'))[0]; fixed(repaired, receipt.initial.moved); assert.equal(repaired.writes, moved.writes + 1); await native(await info(), 'repaired');
  assert.equal((await step('hidden'))[0].visible, false);
  const shown = (await step('shown-inactive'))[0]; fixed(shown, receipt.initial.moved); assert.equal(shown.visible, true); await native(await info(), 'shown');
  const returned = (await step('returned-anchor'))[0]; fixed(returned, receipt.initial.anchor); assert.equal(returned.writes, shown.writes + 1);
  receipt.final = await info(); assert.ok(receipt.final.heartbeats > 0); await page.screenshot({ path: path.join(output, 'final.png'), omitBackground: true, timeout: 3000 });
  await close(); receipt.transportExit = await deadline(childExit, 3000, 'transport exit'); assert.deepEqual(receipt.transportExit, { code: 0, signal: null }); receipt.browserPostClose = await identity('After'); assert.equal(receipt.browserPostClose.browserAbsent, true);
  assert.ok(logs.join('').includes('WINDOW_GEOMETRY_SERVICE_EXIT:0')); assert.ok(!logs.join('').includes('WINDOW_GEOMETRY_SERVICE_STOP_TIMEOUT'));
  receipt.passed = true;
} catch (error) { receipt.error = error.stack ?? String(error); }
finally {
  if (app && !closeAttempted) { try { await close(); } catch (error) { receipt.cleanupError = String(error); } }
  if (alive(child)) { receipt.forcedCleanup.push({ owner: 'transport', pid: child.pid }); child.kill(); try { receipt.cleanupTransportExit = await deadline(childExit, 2000, 'transport cleanup'); } catch (error) { receipt.cleanupError = String(error); } }
  if (childExit && !receipt.transportExit) { try { receipt.transportExit = await deadline(childExit, 2000, 'cached transport exit'); } catch (error) { receipt.transportExitError = String(error); } }
  if (receipt.browserPid && !absenceAttempted) { try { receipt.browserPostClose = await identity('After'); } catch (error) { receipt.browserAbsenceError = String(error); } }
  if (receipt.forcedCleanup.length || receipt.cleanupError || receipt.browserAbsenceError) receipt.passed = false;
  receipt.driverExitCode = receipt.passed ? 0 : 1; receipt.finishedUtc = new Date().toISOString();
  await writeFile(path.join(output, 'process.log'), logs.join('')); await writeFile(path.join(output, 'result.json'), JSON.stringify(receipt, null, 2));
}
console.log(JSON.stringify({ passed: receipt.passed, gameAcceptance: receipt.gameAcceptance }));
// The root-owned outer Job remains authoritative for residual descendants.
process.exit(receipt.driverExitCode);