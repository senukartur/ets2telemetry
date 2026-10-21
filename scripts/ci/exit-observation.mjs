import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';

/** Observe the request and the real launcher independently within one unchanged deadline.
 * On Windows Playwright launches a shell and waits for its stdio `close`; APP_EXIT is only an app log.
 * The caller retains this small snapshot even when the request, process exit or Playwright close stalls.
 */
export async function observeExit({application, launcher, request, record, message, requireRequest = false}) {
  const started = performance.now();
  Object.assign(record, {request: 'pending', launcherExit: launcher.exitCode, signal: launcher.signalCode,
    launcherExited: launcher.exitCode !== null || launcher.signalCode !== null, launcherClosed: false, applicationClosed: false});
  let timer, onExit, observing = true;
  const streams = [];
  for (const name of ['stdout', 'stderr']) {
    const stream = launcher[name];
    record[name] = stream ? {closed: stream.closed === true, destroyed: stream.destroyed === true} : null;
    if (stream) {
      const closed = () => {record[name] = {closed: true, destroyed: stream.destroyed === true};};
      stream.on('close', closed); streams.push({name, stream, closed});
    }
  }
  const exit = new Promise(resolve => {
    onExit = (code, signal) => {Object.assign(record, {launcherExited: true, launcherExit: code, signal}); resolve();};
    launcher.on('exit', onExit);
    if (record.launcherExited) resolve();
  });
  const onClose = () => {record.launcherClosed = true;};
  const onApplicationClose = () => {record.applicationClosed = true;};
  launcher.on('close', onClose);
  application.on('close', onApplicationClose);
  // Install observers before requesting exit. Both branches consume a late request rejection after timeout.
  const requested = Promise.resolve().then(request).then(() => {if (observing) record.request = 'fulfilled';}, error => {
    if (observing) record.request = 'rejected';
    if (requireRequest) throw error;
  });
  try {
    await Promise.race([Promise.all([requested, exit]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), 8000);
    })]);
    assert.equal(record.launcherExit, 0);
    assert.equal(record.signal, null);
    return {code: record.launcherExit, signal: record.signal};
  } finally {
    observing = false;
    clearTimeout(timer);
    launcher.removeListener('exit', onExit);
    launcher.removeListener('close', onClose);
    application.removeListener('close', onApplicationClose);
    for (const {name, stream, closed} of streams) {
      stream.removeListener('close', closed);
      record[name] = {closed: stream.closed === true || record[name].closed, destroyed: stream.destroyed === true};
    }
    record.elapsedMilliseconds = Math.round(performance.now() - started);
  }
}
