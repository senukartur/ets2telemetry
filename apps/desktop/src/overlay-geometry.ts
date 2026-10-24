import type {OverlayLayout, OverlayPlacement, OverlaySections} from '../../../packages/contracts/src';
import {clampFraction, DEFAULT_OVERLAY_PLACEMENTS, normalizeFraction, overlayZoom} from './overlay-placement';
import {LAYOUT_BORDER_CSS, layoutContentCss, type RowLayout} from './overlay-rows';
import {DEFAULT_OVERLAY_SECTIONS} from './overlay-sections';
import {STRIP_BORDER_CSS, STRIP_ROW_HEIGHT_CSS, stripCssHeight, stripRowCount} from './overlay-strip';

// Overlay window geometry per layout (ET-012a decision L10, placements ET-012b decisions M3 and M4, strip rows ET-012c
// decisions S2-S6, card, cluster and HUD rows ET-012d decisions K4 and K5, the rebased scale and the strip width
// ET-045e decisions Z2-Z4). Pure: the input is the game's client area already converted from physical pixels to
// Electron DIP by `screen.screenToDipRect`; the output is the overlay window's DIP bounds inside that area, or undefined
// when the layout does not fit and the overlay must hide. Every layout's size depends on its enabled sections, never on
// their values.
//
// Two numbers describe the size (ET-045e decision Z2). `scale` is the user's setting from the placement (1 is 100%);
// the exported functions below take it. `zoom` = overlayZoom(scale) = scale × 0.7 is the overlay document's zoom factor
// and the factor between CSS px and DIP; only the internals here and Chromium's zoom use it.

export interface DipRect {x: number; y: number; width: number; height: number}

/** Distance from the client area's edges; the strip sits closer to the top and bottom edges. */
export const OVERLAY_MARGIN_DIP = 16;
export const STRIP_TOP_MARGIN_DIP = 8;
/** The strip's widest window at scale settings up to 1; above 1 it is this width times the setting (ET-045e decision Z3). */
export const STRIP_MAX_WIDTH_DIP = 1280;
/** The strip's narrowest content width in CSS px; the window must be at least this times the zoom. */
export const STRIP_MIN_WIDTH_DIP = 480;
/** Absorbs binary floating-point noise in a scaled height, such as 110 × 1.1 = 121.00000000000001. */
const HEIGHT_EPSILON = 1e-6;

/**
 * The size each layout is styled for at zoom 1, in CSS px. The strip's entry is its maximum width and the height of one
 * row; its actual height depends on the enabled sections (`overlaySize`, `overlayWindowSize`), and it narrows to fit
 * smaller client areas. The card, cluster and HUD are never lower than their entry times the zoom and grow only when
 * their enabled sections need more rows (ET-012d).
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
/**
 * The DIP height of a surface with this CSS content height inside a border of `borderCss` on each side, at this zoom:
 * ceil(content × zoom + 2 × border × max(1, zoom)). Below zoom 1 Chromium snaps a nonzero border thinner than one
 * device pixel up to one device pixel, so each border stays at least one DIP (overlay-strip.ts); at zoom 1 and above
 * this is ceil((content + 2 × border) × zoom). The epsilon keeps binary floating-point noise from adding a pixel.
 */
export function surfaceHeightDip(contentCss: number, borderCss: number, zoom: number): number {
  return Math.ceil(contentCss * zoom + 2 * borderCss * Math.max(1, zoom) - HEIGHT_EPSILON);
}
/** The strip's DIP height for its reserved rows: ceil(STRIP_ROW_HEIGHT_CSS × rows × zoom + 2 × max(1, zoom)), ET-012c's rule unchanged. */
const stripHeight = (rows: number, zoom: number) => surfaceHeightDip(STRIP_ROW_HEIGHT_CSS * rows, STRIP_BORDER_CSS, zoom);
/**
 * The card, cluster or HUD window at this zoom (ET-012d decision K4): round(nominal width × zoom) wide and the larger
 * of round(nominal height × zoom) and the DIP height its reserved rows need (overlay-rows.ts). A layout whose sections
 * fit its nominal size at that zoom keeps its nominal geometry; it grows only when they do not. Fitting at one zoom does
 * not imply fitting at every zoom, because below zoom 1 the snapped border takes one DIP whatever the zoom.
 */
function rowLayoutSize(layout: RowLayout, zoom: number, sections: OverlaySections): {width: number; height: number} {
  const nominal = OVERLAY_NOMINAL_SIZE[layout];
  return {width: Math.round(nominal.width * zoom),
    height: Math.max(Math.round(nominal.height * zoom), surfaceHeightDip(layoutContentCss(layout, sections), LAYOUT_BORDER_CSS[layout], zoom))};
}
/**
 * The strip's widest window for a scale setting (ET-045e decision Z3, owner decision D5): 1280 DIP up to the setting 1
 * and 1280 × setting above it, so a smaller setting only shrinks the text and never the width it may use.
 */
const stripMaxWidth = (scale: number) => STRIP_MAX_WIDTH_DIP * Math.max(1, scale);

/**
 * The window size of a layout at this scale setting in this client area, or undefined when it does not fit inside the
 * margins. With zoom = overlayZoom(scale), the card, cluster and HUD are round(nominal width × zoom) wide and
 * max(round(nominal height × zoom), ceil(content × zoom + 2 × border × max(1, zoom))) high, where `content` is the CSS
 * height the reserved rows of their enabled sections need inside the outer border (overlay-rows.ts). The strip is
 * floor(min(1280 × max(1, scale), client width − 32)) wide, at least round(480 × zoom), and
 * ceil(STRIP_ROW_HEIGHT_CSS × rows × zoom + 2 × max(1, zoom)) high, where `rows` is what its enabled sections need at its
 * CSS width floor(width / zoom) and that zoom (overlay-strip.ts). The client width is the game's client area, never the
 * display's. Nothing shrinks automatically: a layout that does not fit hides as a whole. `sections` defaults to every
 * section, which reserves the most rows.
 */
export function overlaySize(layout: OverlayLayout, client: DipRect, scale: number, sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS):
  {width: number; height: number} | undefined {
  if (!validArea(client) || !Number.isFinite(scale) || scale <= 0) return undefined;
  const zoom = overlayZoom(scale);
  if (!(zoom > 0)) return undefined;
  const margin = overlayMargins(layout);
  if (layout === 'strip') {
    const width = Math.floor(Math.min(stripMaxWidth(scale), client.width - 2 * margin.x));
    if (width < Math.round(STRIP_MIN_WIDTH_DIP * zoom)) return undefined;
    const rows = stripRowCount(sections, Math.floor(width / zoom), zoom);
    if (rows === undefined) return undefined;
    const height = stripHeight(rows, zoom);
    if (client.height < height + 2 * margin.y) return undefined;
    return {width, height};
  }
  const {width, height} = rowLayoutSize(layout, zoom, sections);
  if (client.width < width + 2 * margin.x || client.height < height + 2 * margin.y) return undefined;
  return {width, height};
}

/**
 * The size the overlay window is created with at this scale setting, before any client area is known. The card,
 * cluster and HUD have the size `overlaySize` gives them: with every section at the setting 1 (zoom 0.7) the card is
 * 210 × 270, the cluster 308 × 188 and the HUD 224 × 248. The strip is round(1280 × max(1, scale)) wide and as high as
 * its enabled sections need at that width's CSS width floor(width / zoom), 1280 × 56 at the setting 1 with every section.
 */
export function overlayWindowSize(layout: OverlayLayout, scale: number, sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS): {width: number; height: number} {
  const zoom = overlayZoom(scale);
  if (layout !== 'strip') return rowLayoutSize(layout, zoom, sections);
  const width = Math.round(stripMaxWidth(scale));
  // The CSS width is at least floor(1280 / 0.7) = 1828 at every setting in [0.5, 3], wider than every strip item
  // (overlay-strip.ts), so the row count is always defined here.
  return {width, height: stripHeight(stripRowCount(sections, Math.floor(width / zoom), zoom) ?? 1, zoom)};
}

/**
 * The overlay's bounds for a placement: `x` and `y` are fractions of the free space between the margins once the
 * window is taken away, so left = round(client.x + margin + x × free width) and the same for the top. The default
 * placements (the setting 1, zoom 0.7) reproduce the ET-012a anchors:
 * strip: top centre, width min(1280, client width − 32), 8 below the top edge, 56 high with every section (two rows at
 * 1280); the height follows the enabled sections and the width, and the strip needs width ≥ 336 + 32 and height ≥ its
 * own height + 16.
 * card: top right with 16 margins; 210 × 270 with every section (never below 210 × 252), so it needs 242 × 302.
 * cluster: bottom left with 16 margins; 308 × 188 with every section (never below 308 × 154), so it needs 340 × 220.
 * hud: top left with 16 margins; 224 × 248 with every section (never below 224 × 224), so it needs 256 × 280.
 * The card, cluster and HUD heights follow their enabled sections (ET-012d).
 */
export function overlayBounds(layout: OverlayLayout, client: DipRect, placement: OverlayPlacement = DEFAULT_OVERLAY_PLACEMENTS[layout],
  sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS): DipRect | undefined {
  const size = overlaySize(layout, client, placement.scale, sections);
  return size && placeSize(layout, client, placement, size);
}

/**
 * Positions a window of the given DIP size by the placement's fractions of the free space between the layout's margins:
 * left = round(client.x + margin + x × (client width − 2 × margin − width)) and the same for the top. Undefined when the
 * size does not fit inside the margins. `overlayBounds` uses it for the layout's own size; ET-045c uses it for an actual
 * window size that Windows applied instead of the requested one. The placement's scale is not used.
 */
export function placeSize(layout: OverlayLayout, client: DipRect, placement: OverlayPlacement, size: {width: number; height: number}): DipRect | undefined {
  if (!validArea(client) || ![size.width, size.height, placement.x, placement.y].every(Number.isFinite) || size.width <= 0 || size.height <= 0) return undefined;
  const margin = overlayMargins(layout);
  const freeX = client.width - 2 * margin.x - size.width, freeY = client.height - 2 * margin.y - size.height;
  if (freeX < 0 || freeY < 0) return undefined;
  return {x: Math.round(client.x + margin.x + placement.x * freeX), y: Math.round(client.y + margin.y + placement.y * freeY), width: size.width, height: size.height};
}

/**
 * The placement that puts a window dragged to `bounds` as close as possible to that position: each fraction is clamped
 * to [0, 1] and rounded to four decimals, so a drag past an edge snaps back inside the client area. Where the layout
 * leaves no free space on an axis, or does not fit at all, the previous fraction is kept. The scale is unchanged.
 * `windowSize` replaces the layout's own size when Windows keeps the window at another size (ET-045c), so a drop of a
 * fitted window converts against the free space of the size it actually has and a drop where it stood keeps its fractions.
 */
export function placementFromBounds(layout: OverlayLayout, client: DipRect, bounds: DipRect, previous: OverlayPlacement,
  sections: OverlaySections = DEFAULT_OVERLAY_SECTIONS, windowSize?: {width: number; height: number}): OverlayPlacement {
  const size = windowSize ?? overlaySize(layout, client, previous.scale, sections);
  if (!size || ![bounds.x, bounds.y].every(Number.isFinite)) return previous;
  const margin = overlayMargins(layout);
  const freeX = client.width - 2 * margin.x - size.width, freeY = client.height - 2 * margin.y - size.height;
  const x = freeX > 0 ? normalizeFraction(clampFraction((bounds.x - client.x - margin.x) / freeX)) : previous.x;
  const y = freeY > 0 ? normalizeFraction(clampFraction((bounds.y - client.y - margin.y) / freeY)) : previous.y;
  return {x, y, scale: previous.scale};
}
