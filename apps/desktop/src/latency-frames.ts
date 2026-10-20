import type {BrowserWindow} from 'electron';
import {readLatencyMarker, MARKER_CELL, MARKER_HEIGHT} from './latency-marker';
import type {OverlayLatency, LatencyFrameStats} from './overlay-latency';

/** Reads only the diagnostic marker of this overlay. At most one readback is pending; no game/desktop images are read. */
export function observeLatencyFrames(window: BrowserWindow, latency: Pick<OverlayLatency, 'complete' | 'frame' | 'finish'>, eligible: () => boolean,
  failed: (error: unknown) => void, diagnose?: (facts: LatencyFrameStats) => void): (() => void) & {stats: LatencyFrameStats} {
  const contents = window.webContents;
  const stats: LatencyFrameStats = {subscriptions: 0, requests: 0, inFlight: false, hiddenSkips: 0, ineligibleSkips: 0,
    callbacks: 0, eligible: 0, decoded: 0, width: 0, height: 0, bytes: 0, dipWidth: 0, zoom: 0, scale: 0, firstPixel: ''};
  let observing = false, pending = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {observing = false; generation++; clearTimeout(timer); timer = undefined;};
  const schedule = (delay: number) => {
    clearTimeout(timer);
    if (!observing || latency.complete || contents.isDestroyed()) return;
    timer = setTimeout(() => {timer = undefined; void capture();}, delay); timer.unref();
  };
  const capture = async () => {
    if (!observing || latency.complete || contents.isDestroyed()) {stop(); return;}
    if (pending) {schedule(50); return;}
    if (window.isDestroyed() || !window.isVisible()) {stats.hiddenSkips++; schedule(50); return;}
    if (!eligible()) {stats.ineligibleSkips++; schedule(50); return;}
    const epoch = generation, requested = performance.now(), zoom = contents.getZoomFactor();
    const rect = {x: 0, y: 0, width: Math.ceil(MARKER_CELL * 32 * zoom), height: Math.ceil(MARKER_HEIGHT * zoom)};
    pending = true; stats.inFlight = true; stats.requests++;
    try {
      // stayHidden prevents an in-flight readback from making the page visible after Alt+Tab/hide.
      const image = await contents.capturePage(rect, {stayHidden: true, stayAwake: false});
      const observedNs = process.hrtime.bigint(); stats.callbacks++;
      if (epoch !== generation || !observing || latency.complete || window.isDestroyed() || !window.isVisible() || !eligible()) return;
      stats.eligible++;
      const size = image.getSize(1), bitmap = image.toBitmap({scaleFactor: 1});
      Object.assign(stats, {width: size.width, height: size.height, bytes: bitmap.length, dipWidth: rect.width, zoom,
        scale: size.width / rect.width * zoom, firstPixel: Array.from(bitmap.subarray(0, 4)).join(',')});
      if (stats.eligible === 1) diagnose?.({...stats});
      const token = readLatencyMarker(bitmap, size.width, size.height, stats.scale);
      if (token !== undefined) {stats.decoded++; latency.frame(token, true, observedNs);}
    } catch (error) {
      if (epoch === generation && observing && !latency.complete && !contents.isDestroyed()) {failed(error); latency.finish('capture-failed'); stop();}
    } finally {pending = false; stats.inFlight = false; schedule(Math.max(0, 50 - (performance.now() - requested)));}
  };
  // Wait for a loaded document; retired readbacks cannot attach to its replacement.
  const start = () => {
    if (contents.isDestroyed() || latency.complete) return;
    stop(); observing = true;
    stats.subscriptions++;
    schedule(0);
  };
  contents.on('did-start-loading', stop);
  contents.on('did-finish-load', start);
  if (contents.getURL() && contents.getURL() !== 'about:blank' && !contents.isLoadingMainFrame()) start();
  return Object.assign(() => {contents.removeListener('did-start-loading', stop); contents.removeListener('did-finish-load', start); stop();}, {stats});
}
