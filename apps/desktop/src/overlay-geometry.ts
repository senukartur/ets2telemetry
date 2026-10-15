import type {OverlayLayout} from '../../../packages/contracts/src';

// Overlay window geometry per layout (ET-012a decision L10). Pure: the input is the game's client area already
// converted from physical pixels to Electron DIP by `screen.screenToDipRect`; the output is the overlay window's DIP
// bounds inside that area, or undefined when the layout does not fit and the overlay must hide.

export interface DipRect {x: number; y: number; width: number; height: number}

/** Distance from the client area's edges; the strip sits closer to the top edge. */
export const OVERLAY_MARGIN_DIP = 16;
export const STRIP_TOP_MARGIN_DIP = 8;
export const STRIP_MAX_WIDTH_DIP = 1280;
export const STRIP_MIN_WIDTH_DIP = 480;
export const STRIP_HEIGHT_DIP = 38;

/** The window size each layout is created or styled for; the strip narrows to fit smaller client areas. */
export const OVERLAY_NOMINAL_SIZE: Readonly<Record<OverlayLayout, {width: number; height: number}>> = Object.freeze({
  strip: Object.freeze({width: STRIP_MAX_WIDTH_DIP, height: STRIP_HEIGHT_DIP}),
  card: Object.freeze({width: 300, height: 360}),
  cluster: Object.freeze({width: 440, height: 220}),
  hud: Object.freeze({width: 320, height: 320})
});

/**
 * strip: top centre, width min(1280, client width − 32), 38 high, 8 below the top edge; needs 480 × 54.
 * card: top right, 300 × 360 with 16 margins; needs 332 × 392.
 * cluster: bottom left, 440 × 220 with 16 margins; needs 472 × 252.
 * hud: top left, 320 × 320 with 16 margins; needs 352 × 352.
 */
export function overlayBounds(layout: OverlayLayout, client: DipRect): DipRect | undefined {
  if (![client.x, client.y, client.width, client.height].every(Number.isFinite) || client.width <= 0 || client.height <= 0) return undefined;
  const margin = OVERLAY_MARGIN_DIP;
  if (layout === 'strip') {
    const width = Math.floor(Math.min(STRIP_MAX_WIDTH_DIP, client.width - 2 * margin));
    if (width < STRIP_MIN_WIDTH_DIP || client.height < STRIP_TOP_MARGIN_DIP + STRIP_HEIGHT_DIP + STRIP_TOP_MARGIN_DIP) return undefined;
    return {x: Math.round(client.x + (client.width - width) / 2), y: Math.round(client.y + STRIP_TOP_MARGIN_DIP), width, height: STRIP_HEIGHT_DIP};
  }
  const {width, height} = OVERLAY_NOMINAL_SIZE[layout];
  if (client.width < width + 2 * margin || client.height < height + 2 * margin) return undefined;
  if (layout === 'card') return {x: Math.round(client.x + client.width - width - margin), y: Math.round(client.y + margin), width, height};
  if (layout === 'cluster') return {x: Math.round(client.x + margin), y: Math.round(client.y + client.height - height - margin), width, height};
  return {x: Math.round(client.x + margin), y: Math.round(client.y + margin), width, height};
}
