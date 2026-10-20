// Built by Run-OverlayLatencySmoke.ps1; no game, discovery, production settings or history is opened.
import {app, BrowserWindow, ipcMain, MessageChannelMain} from 'electron';
import path from 'node:path';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {OverlayLatency, latencyReply} from '../../apps/desktop/src/overlay-latency';
import {observeLatencyFrames} from '../../apps/desktop/src/latency-frames';
import {initialLive} from '../../apps/desktop/src/live-state';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';

const [root, output] = process.argv.slice(2);
app.setPath('userData', path.join(output, 'profile')); app.setPath('sessionData', path.join(output, 'profile'));
app.on('window-all-closed', () => undefined);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(2), 20000);
void app.whenReady().then(async () => {
  const fixture = validateMessage(JSON.parse(await readFile(path.join(root, 'tests/fixtures/protocol-v0/snapshot.json'), 'utf8')));
  assert.equal(fixture.kind, 'snapshot'); if (fixture.kind !== 'snapshot') throw new Error('Wrong fixture');
  const window = new BrowserWindow({width: 700, height: 180, frame: false, transparent: true, show: false, focusable: false, skipTaskbar: true,
    webPreferences: {preload: path.join(root, 'apps/desktop/dist/overlay-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false}});
  window.setIgnoreMouseEvents(true);
  // Match main.ts: observation is requested while the first document is still about:blank and the window is hidden.
  // This forwarding object lets the first case begin only after startup without changing the subscription lifetime.
  let activeCollector: OverlayLatency | undefined;
  const startupCollector = {get complete() {return activeCollector?.complete ?? false;},
    frame: (...args: Parameters<OverlayLatency['frame']>) => activeCollector?.frame(...args),
    finish: (reason: string) => activeCollector?.finish(reason)};
  let stopObserving = observeLatencyFrames(window, startupCollector, () => activeCollector !== undefined, error => {throw error;});
  const channel = new MessageChannelMain(); let subscribed = false;
  ipcMain.on('overlay:subscribe', event => {
    if (event.sender !== window.webContents || subscribed) return;
    subscribed = true; window.webContents.postMessage('overlay:port', null, [channel.port2]);
  });
  await window.loadFile(path.join(root, 'apps/desktop/dist/renderer/index.html'), {query: {view: 'overlay'}});
  window.setSize(1280, 108);
  window.showInactive();
  for (let attempt = 0; !subscribed && attempt < 100; attempt++) await pause(20);
  assert.equal(subscribed, true);
  // A subscribed React effect does not imply the first visible compositor frame has arrived.
  await pause(2000);
  const results = [];
  for (const zoom of [0.75, 1, 1.5]) {
    window.webContents.setZoomFactor(zoom); await pause(100);
    const directory = path.join(output, `zoom-${zoom}`);
    const collector = new OverlayLatency(directory, request => {
      const now = process.hrtime.bigint();
      // Controlled source clock equals this harness's clock. This exercises the causal path, not native clock calibration.
      const state = {selection: 'ets2', status: 'connected', fresh: true, observation: {source: request.source, capture: request.capture},
        clockMapping: {sourceClockId: request.capture.clockId, clientClockId: 'smoke', offsetNs: '0', uncertaintyNs: '0', measuredAtClientNs: now.toString()}} as V1SourceState;
      collector.reply(latencyReply(request, state, now));
    }, () => undefined);
    activeCollector = collector;
    if (zoom !== 0.75) stopObserving = observeLatencyFrames(window, collector, () => true, error => {throw error;});
    for (let index = 0; index < 25; index++) {
      const live = {...initialLive('synthetic'), status: 'connected' as const, fresh: true, observation: {source: fixture.source,
        capture: {...fixture.capture, monotonicNs: (process.hrtime.bigint() - 2000000n).toString()}, state: fixture.data.state, seq: String(index + 1),
        receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
        applied: {hydration: false, skippedSequences: '0', continuity: fixture.data.continuity}}};
      const projection = {...overlayPresentation(live), freshness: 'current' as const, sections: [{id: 'speed' as const, state: 'value' as const, text: `${index}.0 km/h`}]};
      channel.port1.postMessage({type: 'live', delivery: index + 1, update: collector.project(projection, live, true)});
      await pause(50);
    }
    await pause(150); collector.finish('synthetic-smoke'); await collector.idle(); stopObserving();
    const report = JSON.parse(await readFile(path.join(directory, 'overlay-latency.json'), 'utf8')) as {valid: number; attempted: number};
    results.push({zoom, ...report}); assert.ok(report.valid >= 15, `Too few composited frames at zoom ${zoom}: ${report.valid}`);
  }
  channel.port1.close();
  await mkdir(output, {recursive: true});
  await writeFile(path.join(output, 'result.json'), JSON.stringify({passed: true, synthetic: true, electron: process.versions.electron, results}, null, 2));
  window.destroy();
  clearTimeout(deadline); app.exit(0);
}).catch(async (error: unknown) => {
  await writeFile(path.join(output, 'failure.txt'), String(error)); clearTimeout(deadline); app.exit(1);
});
