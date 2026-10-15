import type {OverlayLayout, OverlayPlacement} from '../../../packages/contracts/src';
import {clampFraction, DEFAULT_OVERLAY_PLACEMENTS, normalizeFraction} from './overlay-placement';

// Overlay window geometry per layout (ET-012a decision L10, placements ET-012b decisions M3 and M4). Pure: the input is
// the game's client area already converted from physical pixels to Electron DIP by `screen.screenToDipRect`; the output
// is the overlay window's DIP bounds inside that area, or undefined when the layout does not fit and the overlay must hide.

export interface DipRect {x: number; y: number; width: number; height: number}

/** Distance from the client area's edges; the strip sits closer to the top and bottom edges. */
export const OVERLAY_MARGIN_DIP = 16;
export const STRIP_TOP_MARGIN_DIP = 8;
export const STRIP_MAX_WIDTH_DIP = 1280;
export const STRIP_MIN_WIDTH_DIP = 480;
export const STRIP_HEIGHT_DIP = 38;

/** The window size each layout is created or styled for at scale 1; the strip narrows to fit smaller client areas. */
export const OVERLAY_NOMINAL_SIZE: Readonly<Record<OverlayLayout, {width: number; height: number}>> = Object.freeze({
  strip: Object.freeze({width: STRIP_MAX_WIDTH_DIP, height: STRIP_HEIGHT_DIP}),
  card: Object.freeze({width: 300, height: 360}),
  cluster: Object.freeze({width: 440, height: 220}),
  hud: Object.freeze({width: 320, height: 320})
});

/** The horizontal and vertical margins a layout keeps from the client area's edges. */
export function overlayMargins(layout: OverlayLayout): {x: number; y: number} {
  return {x: OVERLAY_MARGIN_DIP, y: layout === 'strip' ? STRIP_TOP_MARGIN_DIP : OVERLAY_MARGIN_DIP};
}

const validArea = (client: DipRect) => [client.x, client.y, client.width, client.height].every(Number.isFinite) && client.width > 0 && client.height > 0;

/**
 * The scaled window size of a layout in this client area, or undefined when it does not fit inside the margins. The
 * card, cluster and HUD are their nominal size times the scale. The strip is round(38 × scale) high and
 * floor(min(1280 × scale, client width − 32)) wide, at least round(480 × scale). Nothing shrinks automatically: a scaled
 * layout that does not fit hides.
 */
export function overlaySize(layout: OverlayLayout, client: DipRect, scale: number): {width: number; height: number} | undefined {
  if (!validArea(client) || !Number.isFinite(scale) || scale <= 0) return undefined;
  const margin = overlayMargins(layout);
  if (layout === 'strip') {
    const width = Math.floor(Math.min(STRIP_MAX_WIDTH_DIP * scale, client.width - 2 * margin.x)), height = Math.round(STRIP_HEIGHT_DIP * scale);
    if (width < Math.round(STRIP_MIN_WIDTH_DIP * scale) || client.height < height + 2 * margin.y) return undefined;
    return {width, height};
  }
  const nominal = OVERLAY_NOMINAL_SIZE[layout];
  const width = Math.round(nominal.width * scale), height = Math.round(nominal.height * scale);
  if (client.width < width + 2 * margin.x || client.height < height + 2 * margin.y) return undefined;
  return {width, height};
}

/**
 * The overlay's bounds for a placement: `x` and `y` are fractions of the free space between the margins once the scaled
 * window is taken away, so left = round(client.x + margin + x × free width) and the same for the top. The default
 * placements reproduce the ET-012a anchors:
 * strip: top centre, width min(1280, client width − 32), 38 high, 8 below the top edge; needs 480 × 54.
 * card: top right, 300 × 360 with 16 margins; needs 332 × 392.
 * cluster: bottom left, 440 × 220 with 16 margins; needs 472 × 252.
 * hud: top left, 320 × 320 with 16 margins; needs 352 × 352.
 */
export function overlayBounds(layout: OverlayLayout, client: DipRect, placement: OverlayPlacement = DEFAULT_OVERLAY_PLACEMENTS[layout]): DipRect | undefined {
  const size = overlaySize(layout, client, placement.scale);
  if (!size) return undefined;
  const margin = overlayMargins(layout);
  const freeX = client.width - 2 * margin.x - size.width, freeY = client.height - 2 * margin.y - size.height;
  return {x: Math.round(client.x + margin.x + placement.x * freeX), y: Math.round(client.y + margin.y + placement.y * freeY), ...size};
}

/**
 * The placement that puts a window dragged to `bounds` as close as possible to that position: each fraction is clamped
 * to [0, 1] and rounded to four decimals, so a drag past an edge snaps back inside the client area. Where the layout
 * leaves no free space on an axis, or does not fit at all, the previous fraction is kept. The scale is unchanged.
 */
export function placementFromBounds(layout: OverlayLayout, client: DipRect, bounds: DipRect, previous: OverlayPlacement): OverlayPlacement {
  const size = overlaySize(layout, client, previous.scale);
  if (!size || ![bounds.x, bounds.y].every(Number.isFinite)) return previous;
  const margin = overlayMargins(layout);
  const freeX = client.width - 2 * margin.x - size.width, freeY = client.height - 2 * margin.y - size.height;
  const x = freeX > 0 ? normalizeFraction(clampFraction((bounds.x - client.x - margin.x) / freeX)) : previous.x;
  const y = freeY > 0 ? normalizeFraction(clampFraction((bounds.y - client.y - margin.y) / freeY)) : previous.y;
  return {x, y, scale: previous.scale};
}
