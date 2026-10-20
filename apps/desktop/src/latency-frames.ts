import type {BrowserWindow} from 'electron';
import {readLatencyMarker} from './latency-marker';
import type {OverlayLatency} from './overlay-latency';

/** Reads only this overlay's composited content. It captures neither the game nor the desktop, and stores no images. */
export function observeLatencyFrames(window: BrowserWindow, latency: OverlayLatency, eligible: () => boolean,
  failed: (error: unknown) => void): void {
  window.webContents.beginFrameSubscription(false, image => {
    const observedNs = process.hrtime.bigint();
    if (latency.complete) {window.webContents.endFrameSubscription(); return;}
    if (window.isDestroyed() || !window.isVisible() || !eligible()) return;
    try {
      const size = image.getSize(), [dipWidth] = window.getContentSize();
      const token = readLatencyMarker(image.toBitmap(), size.width, size.height, size.width / dipWidth * window.webContents.getZoomFactor());
      if (token !== undefined) latency.frame(token, true, observedNs);
    } catch (error) {failed(error); latency.finish('frame-failed');}
  });
}
