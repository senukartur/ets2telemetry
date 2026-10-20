import type {BrowserWindow} from 'electron';
import {readLatencyMarker} from './latency-marker';
import type {OverlayLatency} from './overlay-latency';

/** Reads only this overlay's composited content. It captures neither the game nor the desktop, and stores no images. */
export function observeLatencyFrames(window: BrowserWindow, latency: Pick<OverlayLatency, 'complete' | 'frame' | 'finish'>, eligible: () => boolean,
  failed: (error: unknown) => void): () => void {
  const contents = window.webContents;
  let observing = false;
  const stop = () => {if (observing && !contents.isDestroyed()) contents.endFrameSubscription(); observing = false;};
  // A hidden about:blank widget can lack its view. Electron's subscriber then keeps that host without creating a
  // capturer. Wait for the loaded document and bind again after every navigation, including renderer recovery.
  const start = () => {
    if (contents.isDestroyed() || latency.complete) return;
    stop(); observing = true;
    contents.beginFrameSubscription(false, image => {
      const observedNs = process.hrtime.bigint();
      if (latency.complete) {stop(); return;}
      if (window.isDestroyed() || !window.isVisible() || !eligible()) return;
      try {
        const size = image.getSize(), [dipWidth] = window.getContentSize();
        const token = readLatencyMarker(image.toBitmap(), size.width, size.height, size.width / dipWidth * contents.getZoomFactor());
        if (token !== undefined) latency.frame(token, true, observedNs);
      } catch (error) {failed(error); latency.finish('frame-failed'); stop();}
    });
  };
  contents.on('did-start-loading', stop);
  contents.on('did-finish-load', start);
  if (contents.getURL() && contents.getURL() !== 'about:blank' && !contents.isLoadingMainFrame()) start();
  return () => {contents.removeListener('did-start-loading', stop); contents.removeListener('did-finish-load', start); stop();};
}
