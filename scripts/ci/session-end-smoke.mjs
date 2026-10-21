import assert from 'node:assert/strict';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {appendFileSync, renameSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {assertSessionSender, observeSessionEnd} from './session-end-observation.mjs';
import {verifyPackage} from '../package-integrity.mjs';

const [configFile] = process.argv.slice(2);
const config = JSON.parse((await readFile(configFile, 'utf8')).replace(/^\uFEFF/, ''));
const record = {kind: 'OWNED-WINDOW-WM_ENDSESSION', passed: false, baselineMissingAudit: config.baselineMissingAudit,
  commit: config.commit, harnessHashes: config.harnessHashes, senderSha256: config.senderSha256,
  actualWindowsSignout: false, noBroadcast: true, startedUtc: new Date().toISOString(), stage: 'initializing'};
let application, launcher;
let finalized = false, browserLogBytes = 0;
function checkpoint(stage) {
  record.stage = stage;
  const temporary = path.join(config.output, `progress-${process.pid}.next`);
  writeFileSync(temporary, JSON.stringify(record, null, 2) + '\n', {flush: true});
  renameSync(temporary, path.join(config.output, 'progress.json'));
}
function finish() {
  if (finalized) return;
  record.finishedUtc = new Date().toISOString();
  writeFileSync(path.join(config.output, 'result.json'), JSON.stringify(record, null, 2) + '\n', {flag: 'wx', flush: true});
  finalized = true;
}
function fatal(kind, error) {
  record.passed = false; record.failureKind = kind; record.error = String(error).slice(0, 8192);
  record.errorStack = error instanceof Error ? error.stack?.slice(0, 16384) : null;
  try {checkpoint('fatal'); finish();} catch { /* The outer Job receipt still records a missing or unreadable result. */ }
  process.exit(1);
}
process.once('unhandledRejection', error => fatal('unhandledRejection', error));
process.once('uncaughtException', error => fatal('uncaughtException', error));
// Electron.launch does not expose the browser logger option. Enable the pinned SDK's existing browser diagnostics
// before importing it; retain at most 64 KiB, while the outer Job independently bounds its stdout/stderr capture.
process.env.DEBUG = 'pw:browser*';
const originalStderrWrite = process.stderr.write;
process.stderr.write = function(chunk, ...args) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
  const retained = bytes.subarray(0, Math.max(0, 64 * 1024 - browserLogBytes));
  if (retained.length) {
    try {appendFileSync(path.join(config.output, 'browser-launch.log'), retained); browserLogBytes += retained.length;}
    catch { /* Launch diagnostics cannot replace the underlying check result. */ }
  }
  return originalStderrWrite.call(this, chunk, ...args);
};
checkpoint('initializing');
const rows = async filename => (await readFile(filename, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
async function until(probe) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {if (await probe()) return; await new Promise(resolve => setTimeout(resolve, 50));}
  throw new Error('Session-end fixture readiness exceeded 10 seconds');
}
async function send(target, mode) {
  assert.equal(target.pid, record.mainPid);
  return await new Promise((resolve, reject) => {
    const child = spawn(config.sender, [String(target.pid), target.handle, config.executable, mode], {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    let stdout = '', stderr = '';
    child.stdout.on('data', value => {stdout += value;}); child.stderr.on('data', value => {stderr += value;});
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Owned-window sender failed (${code}): ${stderr}`));
      else resolve(JSON.parse(stdout));
    });
  });
}
async function target(overlay) {
  return await application.evaluate(({BrowserWindow}, wantOverlay) => {
    const window = BrowserWindow.getAllWindows().find(candidate => candidate.webContents.getURL().includes('?view=overlay') === wantOverlay);
    if (!window) throw new Error('Owned test window unavailable');
    return {pid: process.pid, handle: window.getNativeWindowHandle().readBigUInt64LE().toString(16)};
  }, overlay);
}
try {
  const { _electron: electron } = await import('@playwright/test');
  const integrity = verifyPackage(config.packageDirectory);
  record.packageSha256 = integrity.packageSha256;
  assert.equal(integrity.packageSha256, config.expectedPackageSha256);
  const environment = {...process.env, TEMP: config.temp, TMP: config.temp, APPDATA: config.appdata, LOCALAPPDATA: config.localappdata,
    ETS2TELEMETRY_PROFILE_DIR: config.profile, ETS2TELEMETRY_DIAGNOSTIC_DIR: config.diagnostics,
    ETS2TELEMETRY_PLUGIN_SETUP: 'disabled', ETS2TELEMETRY_RECORDING: 'synthetic:session-end'};
  for (const key of Object.keys(environment)) if ((key.startsWith('ETS2TELEMETRY_') && !['ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR', 'ETS2TELEMETRY_PLUGIN_SETUP', 'ETS2TELEMETRY_RECORDING'].includes(key)) || key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') delete environment[key];
  checkpoint('launching');
  application = await electron.launch({executablePath: config.executable, cwd: config.output, env: environment, timeout: 20000});
  checkpoint('launched');
  launcher = application.process();
  const mainPath = path.join(config.diagnostics, 'startup.jsonl');
  await until(async () => {try {return (await rows(mainPath)).some(row => row.event === 'SERVICE_READY');} catch {return false;}});
  record.mainPid = (await rows(mainPath)).find(row => row.event === 'APP_START').pid;
  await until(async () => await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length === 2 && BrowserWindow.getAllWindows().every(window => window.webContents.getURL().includes('/renderer/index.html') && !window.webContents.isLoading())));
  record.cancelTarget = await target(false);
  record.cancelledQuery = await send(record.cancelTarget, 'cancel');
  assertSessionSender(record.cancelledQuery, record.cancelTarget, config.executable, 'cancel');
  checkpoint('cancelled-query');
  assert.equal(launcher.exitCode, null);
  let events = await rows(mainPath);
  assert.equal(events.some(row => row.event === 'APP_EXIT_REQUESTED' || row.event === 'APP_STOP_REQUESTED' || row.event === 'WINDOWS_SESSION_END_HANDOFF'), false);
  await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('?view=overlay')).close());
  await until(async () => await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length === 1));
  record.dashboardClosed = true;
  checkpoint('dashboard-closed');
  const ownedOverlay = await target(true);
  record.endTarget = ownedOverlay;
  record.exit = await observeSessionEnd({application, launcher, record, target: ownedOverlay, executable: config.executable,
    send: () => send(ownedOverlay, 'end')});
  assert.equal(record.exit.code, 0); assert.equal(record.exit.signal, null);
  events = await rows(mainPath);
  record.mainEvents = events;
  const request = events.filter(row => row.event === 'APP_EXIT_REQUESTED');
  const stop = events.filter(row => row.event === 'APP_STOP_REQUESTED');
  const handoff = events.filter(row => row.event === 'WINDOWS_SESSION_END_HANDOFF');
  if (config.baselineMissingAudit) {
    assert.equal(request.length, 0); assert.equal(stop.length, 0); assert.equal(handoff.length, 0);
    record.reproducedLogLoss = true;
  } else {
    assert.deepEqual(request.map(row => row.facts), [{reason: 'session-end'}]);
    assert.equal(stop.length, 1);
    assert.deepEqual(handoff.map(row => row.facts), [{completion: 'os-owned'}]);
    assert.ok(events.indexOf(request[0]) < events.indexOf(stop[0]) && events.indexOf(stop[0]) < events.indexOf(handoff[0]));
    // A native WM_ENDSESSION ends Electron immediately. These rows would falsely claim that main observed its supervisor.
    assert.equal(events.some(row => row.event === 'APP_EXIT' || row.event === 'SERVICE_EXIT'), false);
    record.passed = true;
  }
} catch (error) {
  record.error = String(error).slice(0, 8192);
  record.errorStack = error instanceof Error ? error.stack?.slice(0, 16384) : null;
  process.exitCode = 1;
}
finally {
  checkpoint(record.error ? 'failed' : 'completed');
  // Keep the original ChildProcess: ElectronApplication.process() resolves through SDK objects that native termination
  // has already disposed. Re-resolving it during cleanup throws instead of reporting the observed launcher exit.
  if (launcher?.exitCode === null) await application.close().catch(() => undefined);
  finish();
}
