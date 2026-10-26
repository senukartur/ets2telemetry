import type {OverlaySectionId, OverlaySections} from '../../../packages/contracts/src';
import {OVERLAY_SECTION_IDS} from './overlay-sections';

// The strip's reserved rows (ET-012c decisions S2-S4). Pure and renderer-safe: main sizes the overlay window from it and
// the overlay renderer applies the same maximum widths, so every enabled section fits inside the window by construction.
// All lengths are CSS pixels at zoom 1; renderer.css holds the matching strip rules (overlay-strip.test.ts checks them).

/** Height of one strip row: every strip item is 38 px high. */
export const STRIP_ROW_HEIGHT_CSS = 38;
/** The strip surface's border on each side at zoom 1 and above; see `stripBorderWidthCss` below zoom 1. */
export const STRIP_BORDER_CSS = 1;
/** The strip row's horizontal padding on each side. */
export const STRIP_PADDING_X_CSS = 12;
/** The strip row's column gap between neighbouring items. */
export const STRIP_COLUMN_GAP_CSS = 14;
/** Tag slots reserved before the sections: Paused needs current data and No signal needs unavailable data, so at most
 * one of them shows, plus Synthetic or Replay. */
export const STRIP_TAG_SLOTS = 2;
export const STRIP_TAG_MAX_WIDTH_CSS = 96;
/**
 * The maximum border-box width of each strip section, including its icon, inner gaps and the 15 px divider padding of a
 * group's first item. A longer value ends in an ellipsis.
 */
export const STRIP_ITEM_MAX_WIDTH_CSS: Readonly<Record<OverlaySectionId, number>> = Object.freeze({
  'speed': 140, 'gear': 90, 'rpm': 130, 'fuel': 190, 'range': 140, 'sdk-consumption': 230, 'cargo': 300, 'origin': 300, 'destination': 300,
  'distance-driven': 150, 'distance-remaining': 150, 'deadline': 220, 'expected-income': 300, 'game-time': 200, 'mandatory-break': 150
});

/**
 * The surface border's width in CSS px at this zoom. Chromium snaps a nonzero border thinner than one device pixel up to
 * one device pixel, so below zoom 1 the 1 px border takes 1 / zoom CSS px. At a device scale factor above 1 the snapped
 * border is thinner than that, so this stays conservative.
 */
export function stripBorderWidthCss(zoom: number): number {
  return Math.max(STRIP_BORDER_CSS, STRIP_BORDER_CSS / zoom);
}

/**
 * The number of rows the strip reserves for these enabled sections at this CSS width and zoom (the overlay document's
 * zoom factor, overlayZoom of the scale setting since ET-045e), or undefined when one item could not fit a row. The
 * inner width is floor(CSS width − 2 × border − 24), rounded down to stay conservative. It packs the worst case greedily
 * in DOM order, as flex-wrap collects lines: both tag slots, then every enabled section in canonical order, each at its
 * maximum width with the column gap between neighbours. Real items are never wider than their maximum and tags may be
 * absent, so the rendered strip never needs more lines.
 */
export function stripRowCount(sections: OverlaySections, cssWidth: number, zoom = 1): number | undefined {
  const inner = Math.floor(cssWidth - 2 * stripBorderWidthCss(zoom) - 2 * STRIP_PADDING_X_CSS);
  const widths = [...Array.from({length: STRIP_TAG_SLOTS}, () => STRIP_TAG_MAX_WIDTH_CSS), ...OVERLAY_SECTION_IDS.filter(id => sections[id]).map(id => STRIP_ITEM_MAX_WIDTH_CSS[id])];
  if (!Number.isFinite(inner) || widths.some(width => width > inner)) return undefined;
  let rows = 1, line = 0;
  for (const width of widths) {
    if (line === 0) line = width;
    else if (line + STRIP_COLUMN_GAP_CSS + width <= inner) line += STRIP_COLUMN_GAP_CSS + width;
    else {rows++; line = width;}
  }
  return rows;
}

/** The strip surface's CSS height for this many rows at zoom 1 and above, borders included. */
export function stripCssHeight(rows: number): number {
  return STRIP_ROW_HEIGHT_CSS * rows + 2 * STRIP_BORDER_CSS;
}
