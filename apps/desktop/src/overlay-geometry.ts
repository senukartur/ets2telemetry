import type {OverlayLayout, OverlayPlacement, OverlaySections} from '../../../packages/contracts/src';
import {clampFraction, DEFAULT_OVERLAY_PLACEMENTS, normalizeFraction} from './overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS} from './overlay-sections';
import {stripCssHeight, stripRowCount} from './overlay-strip';

// Overlay window geometry per layout (ET-012a decision L10, placements ET-012b decisions M3 and M4, strip rows ET-012c
// decisions S2-S6). Pure: the input is the game's client area already converted from physical pixels to Electron DIP by
// `screen.screenToDipRect`; the output is the overlay window's DIP bounds inside that area, or undefined when the layout
// does not fit and the overlay must hide. The strip's size depends on its enabled sections, never on their values.

export interface DipRect {x: number; y: number; width: number; height: number}

/** Distance from the client area's edges; the strip sits closer to the top and bottom edges. */
export const OVERLAY_MARGIN_DIP = 16;
export const STRIP_TOP_MARGIN_DIP = 8;
export const STRIP_MAX_WIDTH_DIP = 1280;
export const STRIP_MIN_WIDTH_DIP = 480;
/** Absorbs binary floating-point noise in a scaled strip height, such as 110 × 1.1 = 121.00000000000001. */
const STRIP_HEIGHT_EPSILON = 1e-6;

/**
 * The window size each layout is styled for at scale 1. The strip's entry is its maximum width and the height of one
 * row; its actual height depends on the enabled sections (`overlaySize`, `overlayWindowSize`), and it narrows to fit
 * smaller client areas.
 */
export const OVERLAY_NOMINAL_SIZE: Readonly<Record<OverlayLayout, {width: number; height: number}>> = Object.freeze({
  strip: Object.freeze({width: STRIP_MAX_WIDTH_DIP, height: stripCssHeight(1)}),
  card: Object.freeze({width: 300, height: 360}),
  cluster: Object.freeze({width: 440, height: 220}),
  hud: Object.freeze({width: 320, height: 320})
});

/** The horizontal and vertical margins a layout keeps from the client area's edges. */
export function overlayMargins(layout: OverlayLayout): {x: number; y: number} {
  return {x: OVERLAY_MARGIN_DIP, y: layout === 'strip' ? STRIP_TOP_MARGIN_DIP : OVERLAY_MARGIN_DIP};
}

const validArea = (client: DipRect) => [client.x, client.y, client.width, client.height].every(Number.isFinite) && client.width > 0 && client.height > 0;
/** The strip's DIP height for its reserved rows at this scale: ceil((36 × rows + 2) × scale). */
const stripHeight = (rows: number, scale: number) => Math.ceil(stripCssHeight(rows) * scale - STRIP_HEIGHT_EPSILON);

/**
 * The scaled window size of a layout in this client area, or undefined when it does not fit inside the margins. The
 * card, cluster and HUD are their nominal size times the scale. The strip is floor(min(1280 × scale, client width − 32))
 * wide, at least round(480 × scale), and ceil((36 × rows + 2) × scale) high, where `rows` is what its enabled sections
 * need at its CSS width floor(width / scale) (overlay-strip.ts). Nothing shrinks automatically: a scaled layout that
 * does not fit hides as a whole. `sections` defaults to every section, which reserves the most rows.
 */
export function overlaySize(layout: OverlayLayout, client: DipRect, scale: number, sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS):
  {width: number; height: number} | undefined {
  if (!validArea(client) || !Number.isFinite(scale) || scale <= 0) return undefined;
  const margin = overlayMargins(layout);
  if (layout === 'strip') {
    const width = Math.floor(Math.min(STRIP_MAX_WIDTH_DIP * scale, client.width - 2 * margin.x));
    if (width < Math.round(STRIP_MIN_WIDTH_DIP * scale)) return undefined;
    const rows = stripRowCount(sections, Math.floor(width / scale));
    if (rows === undefined) return undefined;
    const height = stripHeight(rows, scale);
    if (client.height < height + 2 * margin.y) return undefined;
    return {width, height};
  }
  const nominal = OVERLAY_NOMINAL_SIZE[layout];
  const width = Math.round(nominal.width * scale), height = Math.round(nominal.height * scale);
  if (client.width < width + 2 * margin.x || client.height < height + 2 * margin.y) return undefined;
  return {width, height};
}

/**
 * The size the overlay window is created with, before any client area is known: the layout's nominal size times the
 * scale. The strip is round(1280 × scale) wide and as high as its enabled sections need at its full 1280 px CSS width,
 * 1280 × 110 at scale 1 with every section.
 */
export function overlayWindowSize(layout: OverlayLayout, scale: number, sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS): {width: number; height: number} {
  const nominal = OVERLAY_NOMINAL_SIZE[layout];
  if (layout !== 'strip') return {width: Math.round(nominal.width * scale), height: Math.round(nominal.height * scale)};
  // Every strip item fits a 1280 px row (overlay-strip.ts), so the row count is always defined here.
  return {width: Math.round(STRIP_MAX_WIDTH_DIP * scale), height: stripHeight(stripRowCount(sections, STRIP_MAX_WIDTH_DIP) ?? 1, scale)};
}

/**
 * The overlay's bounds for a placement: `x` and `y` are fractions of the free space between the margins once the scaled
 * window is taken away, so left = round(client.x + margin + x × free width) and the same for the top. The default
 * placements reproduce the ET-012a anchors:
 * strip: top centre, width min(1280, client width − 32), 8 below the top edge, 110 high with every section (three rows
 * at 1280); the height follows the enabled sections and the width, and the strip needs width ≥ 480 + 32 and
 * height ≥ its own height + 16.
 * card: top right, 300 × 360 with 16 margins; needs 332 × 392.
 * cluster: bottom left, 440 × 220 with 16 margins; needs 472 × 252.
 * hud: top left, 320 × 320 with 16 margins; needs 352 × 352.
 */
export function overlayBounds(layout: OverlayLayout, client: DipRect, placement: OverlayPlacement = DEFAULT_OVERLAY_PLACEMENTS[layout],
  sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS): DipRect | undefined {
  const size = overlaySize(layout, client, placement.scale, sections);
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
export function placementFromBounds(layout: OverlayLayout, client: DipRect, bounds: DipRect, previous: OverlayPlacement,
  sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS): OverlayPlacement {
  const size = overlaySize(layout, client, previous.scale, sections);
  if (!size || ![bounds.x, bounds.y].every(Number.isFinite)) return previous;
  const margin = overlayMargins(layout);
  const freeX = client.width - 2 * margin.x - size.width, freeY = client.height - 2 * margin.y - size.height;
  const x = freeX > 0 ? normalizeFraction(clampFraction((bounds.x - client.x - margin.x) / freeX)) : previous.x;
  const y = freeY > 0 ? normalizeFraction(clampFraction((bounds.y - client.y - margin.y) / freeY)) : previous.y;
  return {x, y, scale: previous.scale};
}
