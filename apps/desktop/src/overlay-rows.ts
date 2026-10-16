import type {OverlayLayout, OverlaySections} from '../../../packages/contracts/src';
import {CLUSTER_GAUGE_SECTIONS, OVERLAY_SECTION_IDS} from './overlay-sections';

// The reserved rows of the card, the cluster's side panel and the minimal HUD (ET-012d decisions K2, K3 and K7). Pure
// and renderer-safe: main sizes the overlay window from these heights and renderer.css gives every row the same fixed
// height, so every enabled section fits inside the window by construction, whatever its value. All lengths are CSS
// pixels at zoom 1 with border-box sizing; overlay-rows.test.ts checks the matching rules in renderer.css. The strip has
// its own row model (overlay-strip.ts).

/** The layouts with one fixed row per enabled section. */
export type RowLayout = Exclude<OverlayLayout, 'strip'>;
export const ROW_LAYOUTS: readonly RowLayout[] = Object.freeze(['card', 'cluster', 'hud']);

/** Card: a 1 px surface border, 10 px vertical padding, a 20 px header and its 6 px gap, then 24 px rows. */
export const CARD_BORDER_CSS = 1;
export const CARD_PADDING_Y_CSS = 10;
export const CARD_PADDING_X_CSS = 14;
export const CARD_HEADER_HEIGHT_CSS = 20;
export const CARD_HEADER_GAP_CSS = 6;
/** One card row, its 1 px top border included. */
export const CARD_ROW_HEIGHT_CSS = 24;

/** Cluster side panel: a 1 px surface border, 8 px vertical padding, an 18 px tag row, then 18 px rows, each 3 px apart. */
export const CLUSTER_PANEL_BORDER_CSS = 1;
export const CLUSTER_PANEL_PADDING_Y_CSS = 8;
export const CLUSTER_PANEL_PADDING_X_CSS = 10;
export const CLUSTER_TAG_ROW_HEIGHT_CSS = 18;
export const CLUSTER_ROW_GAP_CSS = 3;
export const CLUSTER_ROW_HEIGHT_CSS = 18;
/** The round gauge beside the panel; it never exceeds the cluster's 220 px nominal height. */
export const CLUSTER_GAUGE_SIZE_CSS = 200;

/** HUD: no surface, an 18 px tag row, then 22 px lines, each 2 px apart. */
export const HUD_TAG_ROW_HEIGHT_CSS = 18;
export const HUD_LINE_GAP_CSS = 2;
export const HUD_LINE_HEIGHT_CSS = 22;

/** The outer border on each side that the window height must hold besides the content (`surfaceHeightDip`). */
export const LAYOUT_BORDER_CSS: Readonly<Record<RowLayout, number>> = Object.freeze({card: CARD_BORDER_CSS, cluster: CLUSTER_PANEL_BORDER_CSS, hud: 0});

/**
 * The rows a layout reserves for these enabled sections: one per section in the card and the HUD, and one per section
 * outside the gauge (speed, gear and RPM) in the cluster's side panel. The header or tag row is reserved separately.
 */
export function layoutRowCount(layout: RowLayout, sections: OverlaySections): number {
  return OVERLAY_SECTION_IDS.filter(id => sections[id] && !(layout === 'cluster' && CLUSTER_GAUGE_SECTIONS.has(id))).length;
}

/**
 * The CSS height a layout's content needs inside its outer border: the header or tag row is always reserved, because
 * tags can appear at any time, plus one fixed row per counted section. Card 46 + 24 × rows, cluster panel 34 + 21 × rows,
 * HUD 18 + 24 × rows. The cluster's gauge is covered by its nominal height, not by this reserve.
 */
export function layoutContentCss(layout: RowLayout, sections: OverlaySections): number {
  const rows = layoutRowCount(layout, sections);
  if (layout === 'card') return 2 * CARD_PADDING_Y_CSS + CARD_HEADER_HEIGHT_CSS + CARD_HEADER_GAP_CSS + CARD_ROW_HEIGHT_CSS * rows;
  if (layout === 'cluster') return 2 * CLUSTER_PANEL_PADDING_Y_CSS + CLUSTER_TAG_ROW_HEIGHT_CSS + (CLUSTER_ROW_GAP_CSS + CLUSTER_ROW_HEIGHT_CSS) * rows;
  return HUD_TAG_ROW_HEIGHT_CSS + (HUD_LINE_GAP_CSS + HUD_LINE_HEIGHT_CSS) * rows;
}

/** The reserved CSS height at zoom 1, the outer border included: card 48 + 24n, cluster panel 36 + 21m, HUD 18 + 24n. */
export function layoutReservedCss(layout: RowLayout, sections: OverlaySections): number {
  return layoutContentCss(layout, sections) + 2 * LAYOUT_BORDER_CSS[layout];
}
