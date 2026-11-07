import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {spawn} from 'node:child_process';
import path from 'node:path';

const MAIN_OBSERVER_READY_MS = 2000;
const OBSERVER_CLEANUP_MS = 1000;
const OUTPUT_BYTES = 4096;
const safeError = error => ({name: error?.name === 'Error' ? 'Error' : 'OBSERVER_ERROR',
  code: typeof error?.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : null});
const sanitize = value => value.replace(/vtc1_[A-Za-z0-9_-]*/g, '[redacted-token]')
  .replace(/(?:https?|wss?):\/\/[^\s]+/g, '[url]').replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\r\n"<>]*/g, '[path]')
  .replace(/[^\x20-\x7e\r\n\t]/g, '?');

// Open a handle before quit, verify PID + creation time + executable, then wait on THAT process object.
// This child observes only; it never terminates Electron. Disposing it terminates only this PowerShell observer.
const PROCESS_OBSERVER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$observed = $null
try {
  $observed = [System.Diagnostics.Process]::GetProcessById([int]$env:ETS2TELEMETRY_OBSERVED_PID)
  $handle = $observed.Handle
  $created = [DateTimeOffset]::new($observed.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()
  if ($created -ne [long]$env:ETS2TELEMETRY_OBSERVED_CREATED -or
      -not [string]::Equals($observed.MainModule.FileName, $env:ETS2TELEMETRY_OBSERVED_EXE, [StringComparison]::OrdinalIgnoreCase)) {
    @{event='unknown'; code='IDENTITY_MISMATCH'} | ConvertTo-Json -Compress
  } else {
    @{event='opened'} | ConvertTo-Json -Compress
    [Console]::Out.Flush()
    if ($observed.WaitForExit(8000)) { @{event='terminated'; code=$observed.ExitCode} | ConvertTo-Json -Compress }
    else { @{event='unknown'; code='OBSERVER_WAIT_EXPIRED'} | ConvertTo-Json -Compress }
  }
} catch { @{event='unknown'; code='PROCESS_OBSERVER_ERROR'} | ConvertTo-Json -Compress }
finally { if ($null -ne $observed) { $observed.Dispose() } }
`;

export function observeMainProcess(identity, update, {spawnProcess = spawn, platform = process.platform} = {}) {
  if (platform !== 'win32') {update({state: 'unknown', reason: 'UNSUPPORTED_PLATFORM'}); return {ready: Promise.resolve(), dispose: () => Promise.resolve({closed: true})};}
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  let child, readyTimer, cleanupTimer, finished = false, disposed = false, opened = false, childClosed = false, line = '';
  let readyResolve, closeResolve;
  const ready = new Promise(resolve => {readyResolve = resolve;}), closed = new Promise(resolve => {closeResolve = resolve;});
  const unknown = reason => {if (!disposed) update({state: 'unknown', reason}); clearTimeout(readyTimer); readyResolve();};
  const data = chunk => {
    line += chunk.toString('utf8');
    if (line.length > 1024) {line = ''; unknown('OBSERVER_OUTPUT_LIMIT'); return;}
    let end;
    while ((end = line.indexOf('\n')) >= 0) {
      const text = line.slice(0, end); line = line.slice(end + 1);
      try {
        const row = JSON.parse(text);
        if (row.event === 'opened') {opened = true; update({state: 'opened'}); clearTimeout(readyTimer); readyResolve();}
        else if (row.event === 'terminated' && opened && Number.isInteger(row.code)) {finished = true; update({state: 'terminated', code: row.code});}
        else unknown(['IDENTITY_MISMATCH', 'PROCESS_OBSERVER_ERROR', 'OBSERVER_WAIT_EXPIRED'].includes(row.code) ? row.code : 'OBSERVER_PROTOCOL_ERROR');
      } catch {unknown('OBSERVER_PROTOCOL_ERROR');}
    }
  };
  const error = () => unknown('OBSERVER_PROCESS_ERROR');
  const close = () => {childClosed = true; if (!finished) unknown('OBSERVER_CLOSED_WITHOUT_TERMINATION'); closeResolve();};
  try {
    child = spawnProcess(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PROCESS_OBSERVER_SCRIPT, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], env: {...process.env,
          ETS2TELEMETRY_OBSERVED_PID: String(identity.pid), ETS2TELEMETRY_OBSERVED_CREATED: String(identity.createdMs), ETS2TELEMETRY_OBSERVED_EXE: identity.executable}});
    child.stdout.on('data', data); child.on('error', error); child.on('close', close);
    readyTimer = setTimeout(() => unknown('OBSERVER_READY_TIMEOUT'), MAIN_OBSERVER_READY_MS);
  } catch {unknown('OBSERVER_SPAWN_ERROR'); closeResolve();}
  return {ready, async dispose() {
    disposed = true; clearTimeout(readyTimer); readyResolve();
    if (!child) return {closed: true};
    let cleanupError;
    try {
      try {if (!childClosed && child.exitCode === null && child.signalCode === null) child.kill();} catch (error) {cleanupError = safeError(error);}
      await Promise.race([closed, new Promise(resolve => {cleanupTimer = setTimeout(resolve, OBSERVER_CLEANUP_MS);})]);
      return {closed: childClosed, ...(childClosed ? {} : {reason: 'OBSERVER_CLEANUP_TIMEOUT', errorSinkUntilClose: true}), ...(cleanupError ? {error: cleanupError} : {})};
    } finally {
      clearTimeout(cleanupTimer);
      child.stdout.removeListener('data', data);
      const detach = () => {child.removeListener('error', error); child.removeListener('close', close);};
      if (childClosed) detach();
      else {
        // A failed observer kill is not an observed exit. Keep its error sink until the real close, without retaining pipes.
        child.once('close', detach); child.stdout.destroy?.(); child.unref?.();
      }
    }
  }};
}

/** Bound identity/handle setup separately, then observe the request and launcher within the unchanged eight seconds.
 * On Windows Playwright launches a shell and waits for its stdio `close`; APP_EXIT is only an app log.
 * The caller retains this small snapshot even when the request, process exit or Playwright close stalls.
 */
export async function observeExit({application, launcher, request, record, message, requireRequest = false, observeMain = observeMainProcess}) {
  const started = performance.now();
  Object.assign(record, {launcherPid: launcher.pid ?? null, request: 'pending', launcherExit: launcher.exitCode, signal: launcher.signalCode,
    launcherExited: launcher.exitCode !== null || launcher.signalCode !== null, launcherClosed: false, applicationClosed: false});
  record.main = {identity: 'unknown', pid: null, createdMs: null, executable: null, termination: 'unknown'};
  record.stages = [];
  const stage = name => {if (observing) {if (record.stages.length < 32) record.stages.push({name, milliseconds: Math.round(performance.now() - started)}); else record.stagesTruncated = true;}};
  let timer, setupTimer, onExit, observing = true, preparing = true, observerActive = true, mainObserver, requestStarted;
  const streams = [];
  for (const name of ['stdout', 'stderr']) {
    const stream = launcher[name];
    record[name] = stream ? {closed: stream.closed === true, destroyed: stream.destroyed === true, bytes: 0, truncated: false, text: ''} : null;
    if (stream) {
      let raw = Buffer.alloc(0);
      const data = chunk => {
        const bytes = Buffer.from(chunk); record[name].bytes = Math.min(Number.MAX_SAFE_INTEGER, record[name].bytes + bytes.length);
        if (raw.length < OUTPUT_BYTES) raw = Buffer.concat([raw, bytes.subarray(0, OUTPUT_BYTES - raw.length)]);
        const text = sanitize(raw.toString('utf8'));
        record[name].truncated = record[name].bytes > OUTPUT_BYTES || text.length > OUTPUT_BYTES; record[name].text = text.slice(0, OUTPUT_BYTES);
      };
      const closed = () => {record[name].closed = true; record[name].destroyed = stream.destroyed === true; stage(`${name}-closed`);};
      stream.on('close', closed); stream.on('data', data); streams.push({name, stream, closed, data});
    }
  }
  const exit = new Promise(resolve => {
    onExit = (code, signal) => {Object.assign(record, {launcherExited: true, launcherExit: code, signal}); stage('launcher-exit'); resolve();};
    launcher.on('exit', onExit);
    if (record.launcherExited) resolve();
  });
  const onClose = () => {record.launcherClosed = true; stage('launcher-close');};
  const onApplicationClose = () => {record.applicationClosed = true; stage('application-close');};
  launcher.on('close', onClose);
  application.on('close', onApplicationClose);
  // Install observers before requesting exit. Both branches consume a late request rejection after timeout.
  const preparation = Promise.resolve().then(async () => {
    try {
      if (typeof application.evaluate === 'function') {
        const identity = await application.evaluate(() => {
          const created = process.getCreationTime();
          return {pid: process.pid, createdMs: typeof created === 'number' && Number.isFinite(created) && created > 0 ? Math.floor(created) : null, executable: process.execPath};
        });
        if (!preparing) return;
        if (Number.isSafeInteger(identity?.pid) && identity.pid > 0 && Number.isSafeInteger(identity.createdMs) && identity.createdMs > 0 && typeof identity.executable === 'string' && path.win32.isAbsolute(identity.executable)) {
          Object.assign(record.main, {identity: 'captured', pid: identity.pid, createdMs: identity.createdMs, executable: path.win32.basename(identity.executable)}); stage('main-identity');
          mainObserver = observeMain(identity, event => {
            if (!observing || !observerActive) return;
            if (event.state === 'opened') {record.main.identity = 'verified'; record.main.termination = 'observing'; stage('main-handle-opened');}
            else if (event.state === 'terminated' && record.main.identity === 'verified') {record.main.termination = 'exited'; record.main.exitCode = event.code; stage('main-terminated');}
            else {record.main.reason = event.reason ?? 'OBSERVER_UNKNOWN'; record.main.termination = 'unknown'; stage('main-observer-unknown');}
          });
          await mainObserver.ready;
        } else {record.main.reason = 'IDENTITY_UNAVAILABLE'; stage('main-identity-unknown');}
      } else record.main.reason = 'IDENTITY_UNAVAILABLE';
    } catch (error) {if (preparing) {record.main.reason = 'IDENTITY_OBSERVATION_FAILED'; record.main.error = safeError(error); stage('main-observer-error');}}
  });
  try {
    const setupTimedOut = await Promise.race([preparation.then(() => false), new Promise(resolve => {
      setupTimer = setTimeout(() => resolve(true), MAIN_OBSERVER_READY_MS);
    })]);
    preparing = false; clearTimeout(setupTimer);
    if (setupTimedOut) {observerActive = false; record.main.termination = 'unknown'; record.main.reason = 'IDENTITY_SETUP_TIMEOUT'; stage('main-setup-timeout');}
    record.setupMilliseconds = Math.round(performance.now() - started);
    // The original eight seconds start at the quit request, after separately bounded identity/probe setup.
    let deadlineReject;
    const deadline = new Promise((_, reject) => {deadlineReject = reject;});
    const requested = Promise.resolve().then(() => {
      requestStarted = performance.now(); stage('request-started');
      timer = setTimeout(() => deadlineReject(new Error(message)), 8000);
      return request();
    }).then(() => {if (observing) {record.request = 'fulfilled'; stage('request-fulfilled');}}, error => {
      if (observing) {record.request = 'rejected'; record.requestError = safeError(error); stage('request-rejected');}
      if (requireRequest) throw error;
    });
    await Promise.race([Promise.all([requested, exit]), deadline]);
    assert.equal(record.launcherExit, 0);
    assert.equal(record.signal, null);
    return {code: record.launcherExit, signal: record.signal};
  } finally {
    observing = false; preparing = false;
    clearTimeout(timer); clearTimeout(setupTimer);
    record.requestMilliseconds = requestStarted === undefined ? null : Math.round(performance.now() - requestStarted);
    launcher.removeListener('exit', onExit);
    launcher.removeListener('close', onClose);
    application.removeListener('close', onApplicationClose);
    for (const {name, stream, closed, data} of streams) {
      stream.removeListener('close', closed); stream.removeListener('data', data);
      record[name].closed ||= stream.closed === true; record[name].destroyed = stream.destroyed === true;
    }
    try {if (mainObserver) record.main.observerCleanup = await mainObserver.dispose();}
    catch (error) {record.main.observerCleanup = {closed: false, error: safeError(error)};}
    record.elapsedMilliseconds = Math.round(performance.now() - started);
  }
}
