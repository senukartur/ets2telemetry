import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {overlayBounds, overlaySize, overlayWindowSize, placementFromBounds, placeSize, surfaceHeightDip, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';

// REG-016 partial: per-layout placement inside the game's client area in DIP (ET-012a decision L10). The worked
// examples are hand-computed from the plan's geometry table, not produced by the implementation.
// ET-012c (decisions S2-S6): the strip reserves as many 38 px rows as its enabled sections need at its width.
// ET-012d (decisions K3-K5): the card, cluster and HUD reserve one fixed row per enabled section and are
// max(round(nominal height × zoom), ceil(content × zoom + 2 × border × max(1, zoom))) high. With every section the content
// is 382 CSS px for the card (border 1), 265 for the cluster's panel (border 1) and 354 for the HUD (no border).
// ET-045e (decisions Z1-Z4, owner decisions D1 option b and D5): the requirement for the scale changed. The saved scale
// is now a setting whose zoom factor is setting × 0.7, so the default placements (setting 1) render at zoom 0.7 and every
// expectation at a placement scale changed to the plan's re-derived values. The strip is
// floor(min(1280 × max(1, setting), client width − 32)) wide, at least round(480 × zoom), with its rows counted at the CSS
// width floor(width / zoom). Every section at zoom 0.7: the card is 210 × 270 (round(267.4 + 2) up), the cluster
// 308 × 188 (185.5 + 2 up) and the HUD 224 × 248 (247.8 up), needing 242 × 302, 340 × 220 and 256 × 280. The strip at
// 1280 DIP has CSS width floor(1828.57) = 1828 and inner width floor(1828 − 2 × 1.4286 − 24) = 1801; the worst-case line
// of every section (two 96 px tags, the fourteen maxima and fifteen 14 px gaps) is 3242 CSS px and wraps after cargo
// (1524 + 314 > 1801) into two rows, ceil(76 × 0.7 + 2) = 56 high.
const client = (x: number, y: number, width: number, height: number): DipRect => ({x, y, width, height});
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const SPEED_ONLY = only('speed');
/** The owner's 2560 × 1440 physical game client at 150%, {1706.67, 240, 1706.67, 960} DIP. */
const OWNER_CLIENT = client(2560 / 1.5, 240, 2560 / 1.5, 960);
const LAYOUTS = ['strip', 'card', 'cluster', 'hud'] as const;

// Card x = cx + cw − 226; cluster y = cy + ch − 204.
it.each([
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080), strip: {x: 320, y: 8, width: 1280, height: 56},
    card: {x: 1694, y: 16, width: 210, height: 270}, cluster: {x: 16, y: 876, width: 308, height: 188}, hud: {x: 16, y: 16, width: 224, height: 248}},
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720), strip: {x: 16, y: 8, width: 1248, height: 56},
    card: {x: 1054, y: 16, width: 210, height: 270}, cluster: {x: 16, y: 516, width: 308, height: 188}, hud: {x: 16, y: 16, width: 224, height: 248}},
  // The 768 DIP strip has CSS width floor(1097.14) = 1097, inner 1070: four rows, ceil(152 × 0.7 + 2) = 109.
  {name: '800 x 600 at (100, 50)', area: client(100, 50, 800, 600), strip: {x: 116, y: 58, width: 768, height: 109},
    card: {x: 674, y: 66, width: 210, height: 270}, cluster: {x: 116, y: 446, width: 308, height: 188}, hud: {x: 116, y: 66, width: 224, height: 248}},
  // The 928 DIP strip has CSS width floor(1325.71) = 1325, inner 1298: three rows, ceil(114 × 0.7 + 2) = 82.
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540), strip: {x: -944, y: 8, width: 928, height: 82},
    card: {x: -226, y: 16, width: 210, height: 270}, cluster: {x: -944, y: 336, width: 308, height: 188}, hud: {x: -944, y: 16, width: 224, height: 248}}
])('places every layout for $name', ({area, strip, card, cluster, hud}) => {
  expect(overlayBounds('strip', area)).toEqual(strip);
  expect(overlayBounds('card', area)).toEqual(card);
  expect(overlayBounds('cluster', area)).toEqual(cluster);
  expect(overlayBounds('hud', area)).toEqual(hud);
});

it('hides the strip, card and HUD in a 360 x 260 area while the cluster still fits', () => {
  // The strip needs a 336 DIP window plus 32; the card needs 302 high and the HUD 280.
  const area = client(0, 0, 360, 260);
  expect(overlayBounds('strip', area)).toBeUndefined();
  expect(overlayBounds('card', area)).toBeUndefined();
  // 16 + (260 − 32 − 188) = 56.
  expect(overlayBounds('cluster', area)).toEqual({x: 16, y: 56, width: 308, height: 188});
  expect(overlayBounds('hud', area)).toBeUndefined();
  expect(overlayBounds('hud', client(0, 0, 360, 280))).toEqual({x: 16, y: 16, width: 224, height: 248});
});

it.each([
  // The strip's minimum window is round(480 × 0.7) = 336, CSS width floor(480.0) = 480 and inner floor(453.14) = 453, where
  // every section needs ten rows: ceil(380 × 0.7 + 2) = 268, plus 16 = 284. It fits from a 368 DIP client and hides at 367.
  {layout: 'strip' as const, fits: client(0, 0, 368, 284), narrow: client(0, 0, 367, 284), short: client(0, 0, 368, 283)},
  // Every section: 210 × 270, 308 × 188 and 224 × 248, plus 32 each way.
  {layout: 'card' as const, fits: client(0, 0, 242, 302), narrow: client(0, 0, 241, 302), short: client(0, 0, 242, 301)},
  {layout: 'cluster' as const, fits: client(0, 0, 340, 220), narrow: client(0, 0, 339, 220), short: client(0, 0, 340, 219)},
  {layout: 'hud' as const, fits: client(0, 0, 256, 280), narrow: client(0, 0, 255, 280), short: client(0, 0, 256, 279)}
])('applies the exact fit threshold of the $layout layout', ({layout, fits, narrow, short}) => {
  expect(overlayBounds(layout, fits)).toBeDefined();
  expect(overlayBounds(layout, narrow)).toBeUndefined();
  expect(overlayBounds(layout, short)).toBeUndefined();
});

it('applies the one-row fit threshold of a strip with speed only', () => {
  // Speed only is 96 + 96 + 140 with two gaps, 360 of the minimum's 453 inner CSS px: ceil(26.6 + 2) = 29, plus 16 = 45.
  const placement = DEFAULT_OVERLAY_PLACEMENTS.strip;
  expect(overlayBounds('strip', client(0, 0, 368, 45), placement, SPEED_ONLY)).toEqual({x: 16, y: 8, width: 336, height: 29});
  expect(overlayBounds('strip', client(0, 0, 367, 45), placement, SPEED_ONLY)).toBeUndefined();
  expect(overlayBounds('strip', client(0, 0, 368, 44), placement, SPEED_ONLY)).toBeUndefined();
});

it('rounds fractional DIP positions and floors the strip width', () => {
  // 1.5 scaling of an odd physical rectangle produces fractional DIP coordinates. The strip is floor(1247.33) = 1247 wide,
  // CSS width floor(1781.43) = 1781, inner 1754: two rows. x = round(−623.33 + 0.5 × 0.33) = −623, y = round(18.67) = 19.
  const area = client(-639.3333, 10.6667, 1279.3333, 719.3333);
  expect(overlayBounds('strip', area)).toEqual({x: -623, y: 19, width: 1247, height: 56});
  // Card x = round(−639.3333 + 16 + 1037.3333) = 414; cluster y = round(10.6667 + 16 + 499.3333) = 526.
  expect(overlayBounds('card', area)).toEqual({x: 414, y: 27, width: 210, height: 270});
  expect(overlayBounds('cluster', area)).toEqual({x: -623, y: 526, width: 308, height: 188});
  expect(overlayBounds('hud', area)).toEqual({x: -623, y: 27, width: 224, height: 248});
});

it('keeps every placed layout inside its client area', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-2560, -300, 2560, 1440), client(13.5, 7.25, 640.75, 480.5), client(0, 0, 472, 252),
    client(0, 0, 472, 299)]) {
    for (const layout of LAYOUTS) {
      const bounds = overlayBounds(layout, area);
      if (!bounds) continue;
      expect(bounds.x).toBeGreaterThanOrEqual(Math.floor(area.x));
      expect(bounds.y).toBeGreaterThanOrEqual(Math.floor(area.y));
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(Math.ceil(area.x + area.width));
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(Math.ceil(area.y + area.height));
    }
  }
});

it.each([
  ['a zero width', client(0, 0, 0, 1080)],
  ['a negative height', client(0, 0, 1920, -1)],
  ['a non-finite position', client(Number.NaN, 0, 1920, 1080)],
  ['an infinite size', client(0, 0, Number.POSITIVE_INFINITY, 1080)]
])('hides every layout for %s', (_name, area) => {
  for (const layout of LAYOUTS) expect(overlayBounds(layout, area)).toBeUndefined();
});

// ET-012b placements (decisions M3 and M4). Hand-computed: left = round(x + margin + fraction × free width), where the
// free width is the client width minus both margins and the window; the same for the top.
it.each([
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080)},
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720)},
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540)},
  {name: 'fractional DIP coordinates', area: client(-639.3333, 10.6667, 1279.3333, 719.3333)}
])('reproduces the ET-012a anchors with the default placements for $name', ({area}) => {
  for (const layout of LAYOUTS)
    expect(overlayBounds(layout, area, DEFAULT_OVERLAY_PLACEMENTS[layout])).toEqual(overlayBounds(layout, area));
  expect(DEFAULT_OVERLAY_PLACEMENTS).toEqual({strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}});
});

// The plan's table with every section at the settings 0.5, 1, 1.5, 2 and 3 (zoom 0.35, 0.7, 1.05, 1.4 and 2.1):
// width round(nominal width × zoom), height max(round(nominal height × zoom), ceil(content × zoom + 2 × border × max(1, zoom))).
// Card 0.35: 133.7 + 2 = 135.7, so 136; 1.05: 401.1 + 2.1 = 403.2, so 404; 1.4: 534.8 + 2.8 = 537.6, so 538; 2.1: 802.2 + 4.2 = 806.4, so 807.
// Cluster 0.35: 92.75 + 2, so 95; 0.7: 187.5, so 188; 1.05: 278.25 + 2.1, so 281; 1.4: 371 + 2.8, so 374; 2.1: 556.5 + 4.2, so 561.
// HUD 0.35: 123.9, so 124; 1.05: 371.7, so 372; 1.4: 495.6, so 496; 2.1: 743.4, so 744.
const ROW_LAYOUT_TABLE = [
  {scale: 0.5, card: {width: 105, height: 136}, cluster: {width: 154, height: 95}, hud: {width: 112, height: 124}},
  {scale: 1, card: {width: 210, height: 270}, cluster: {width: 308, height: 188}, hud: {width: 224, height: 248}},
  {scale: 1.5, card: {width: 315, height: 404}, cluster: {width: 462, height: 281}, hud: {width: 336, height: 372}},
  {scale: 2, card: {width: 420, height: 538}, cluster: {width: 616, height: 374}, hud: {width: 448, height: 496}},
  {scale: 3, card: {width: 630, height: 807}, cluster: {width: 924, height: 561}, hud: {width: 672, height: 744}}
];
it.each(ROW_LAYOUT_TABLE)('sizes the card, cluster and HUD at the setting $scale from its zoom', ({scale, card, cluster, hud}) => {
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, scale)).toEqual(card);
  expect(overlaySize('cluster', area, scale)).toEqual(cluster);
  expect(overlaySize('hud', area, scale)).toEqual(hud);
  expect(overlayWindowSize('card', scale)).toEqual(card);
  expect(overlayWindowSize('cluster', scale)).toEqual(cluster);
  expect(overlayWindowSize('hud', scale)).toEqual(hud);
});

it('renders the new 100% exactly as large as the earlier 70% for the card, cluster and HUD', () => {
  // ET-045d's overlaySize(layout, 1920 × 1080, 0.7) with every section, hand-computed with the same formula at scale 0.7:
  // card 210 × 270, cluster 308 × 188 and HUD 224 × 248.
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, 1)).toEqual({width: 210, height: 270});
  expect(overlaySize('cluster', area, 1)).toEqual({width: 308, height: 188});
  expect(overlaySize('hud', area, 1)).toEqual({width: 224, height: 248});
});

it.each([
  // Every section in 1920 x 1080: floor(min(1280 × max(1, setting), 1888)) wide, rows at CSS width floor(width / zoom).
  // 0.5: 1280 wide, CSS 3657, inner floor(3657 − 2 × 2.857 − 24) = 3627 ≥ 3242, one row: ceil(13.3 + 2) = 16.
  {scale: 0.5, size: {width: 1280, height: 16}},
  // 1.1 (zoom 0.77): 1408 wide, CSS 1828, inner floor(1828 − 2 × 1.2987 − 24) = 1801, two rows: ceil(58.52 + 2) = 61.
  {scale: 1.1, size: {width: 1408, height: 61}},
  // 1.5 (zoom 1.05): 1888 wide, CSS 1798, inner 1772, two rows: ceil(79.8 + 2.1) = 82.
  {scale: 1.5, size: {width: 1888, height: 82}},
  // 2 (zoom 1.4): 1888 wide, CSS 1348, inner 1322, three rows: ceil(159.6 + 2.8) = 163.
  {scale: 2, size: {width: 1888, height: 163}},
  // 3 (zoom 2.1): 1888 wide, CSS 899, inner 873, five rows: ceil(399 + 4.2) = 404.
  {scale: 3, size: {width: 1888, height: 404}}
])('sizes the strip with every section at the setting $scale to $size.width x $size.height', ({scale, size}) => {
  expect(overlaySize('strip', client(0, 0, 1920, 1080), scale)).toEqual(size);
});

it('keeps the snapped one-device-pixel border inside the strip below zoom 1', () => {
  // Speed only at 0.5: one 13.3 DIP row plus two 1 DIP borders, rounded up to 16.
  expect(overlaySize('strip', client(0, 0, 1920, 1080), 0.5, SPEED_ONLY)).toEqual({width: 1280, height: 16});
  // A 749 x 600 client at the setting 1 gives a 717 DIP strip, CSS width floor(1024.29) = 1024. Cargo, origin and
  // distance driven with two tags take 998 CSS px, more than the snapped inner width floor(1024 − 2 × 1.4286 − 24) = 997
  // (998 with an unsnapped 1 px border), so two rows: ceil(38 × 2 × 0.7 + 2) = ceil(55.2) = 56 high.
  const sections = only('cargo', 'origin', 'distance-driven');
  expect(overlaySize('strip', client(0, 0, 749, 600), 1, sections)).toEqual({width: 717, height: 56});
});

it('rounds a scaled strip height up, never down', () => {
  // Speed only at 1.8 (zoom 1.26): one row, 47.88 + 2.52 = 50.4, so 51; a rounded height of 50 would clip it.
  expect(overlaySize('strip', client(0, 0, 1920, 1080), 1.8, SPEED_ONLY)).toEqual({width: 1888, height: 51});
});

it.each([
  // The card with every section at 1.5 is 315 x 404 and needs 347 x 436.
  {layout: 'card' as const, scale: 1.5, fits: client(0, 0, 347, 436), narrow: client(0, 0, 346, 436), short: client(0, 0, 347, 435)},
  // The strip at 2 (zoom 1.4) needs round(480 × 1.4) + 32 = 704 wide; its CSS width is then 480 and its inner width 454,
  // where every section needs ten rows: ceil(532 + 2.8) + 16 = 551 high. With speed only: ceil(53.2 + 2.8) + 16 = 72.
  {layout: 'strip' as const, scale: 2, fits: client(0, 0, 704, 551), narrow: client(0, 0, 703, 551), short: client(0, 0, 704, 550)},
  {layout: 'strip' as const, scale: 2, sections: SPEED_ONLY, fits: client(0, 0, 704, 72), narrow: client(0, 0, 703, 72), short: client(0, 0, 704, 71)},
  // The strip at 0.5 (zoom 0.35) needs round(480 × 0.35) + 32 = 200 wide. Its CSS width 480 with 2.857 CSS px borders
  // leaves an inner width of floor(450.29) = 450, where every section still needs ten rows: ceil(133 + 2) + 16 = 151
  // high. Speed only needs one row: 16 + 16 = 32.
  {layout: 'strip' as const, scale: 0.5, fits: client(0, 0, 200, 151), narrow: client(0, 0, 199, 151), short: client(0, 0, 200, 150)},
  {layout: 'strip' as const, scale: 0.5, sections: SPEED_ONLY, fits: client(0, 0, 200, 32), narrow: client(0, 0, 199, 32), short: client(0, 0, 200, 31)}
])('applies the scaled fit threshold of the $layout layout at $scale', ({layout, scale, sections, fits, narrow, short}) => {
  const placement = {x: 0, y: 0, scale};
  expect(overlayBounds(layout, fits, placement, sections)).toBeDefined();
  expect(overlayBounds(layout, narrow, placement, sections)).toBeUndefined();
  expect(overlayBounds(layout, short, placement, sections)).toBeUndefined();
});

it.each([
  // Driving-only's worst case is 966 CSS px: one row from a 696 DIP strip (CSS 994, inner 967), two at 695 (CSS 992, inner 965).
  {name: 'driving-only in 800 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 800, 600), bounds: {x: 16, y: 8, width: 768, height: 29}},
  {name: 'driving-only in 960 x 540', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 960, 540), bounds: {x: 16, y: 8, width: 928, height: 29}},
  {name: 'driving-only in 1280 x 720', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 1280, 720), bounds: {x: 16, y: 8, width: 1248, height: 29}},
  {name: 'driving-only in 728 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 728, 600), bounds: {x: 16, y: 8, width: 696, height: 29}},
  {name: 'driving-only in 727 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 727, 600), bounds: {x: 16, y: 8, width: 695, height: 56}},
  // Job-focus's worst case is 1694 CSS px: one row at 1280 (inner 1801), two at 768 (inner 1070).
  {name: 'job-focus in 1920 x 1080', sections: OVERLAY_PRESETS['job-focus'], area: client(0, 0, 1920, 1080), bounds: {x: 320, y: 8, width: 1280, height: 29}},
  {name: 'job-focus in 800 x 600', sections: OVERLAY_PRESETS['job-focus'], area: client(0, 0, 800, 600), bounds: {x: 16, y: 8, width: 768, height: 56}}
])('sizes the strip for its enabled sections: $name', ({sections, area, bounds}) => {
  expect(overlayBounds('strip', area, DEFAULT_OVERLAY_PLACEMENTS.strip, sections)).toEqual(bounds);
});

it.each([
  // round(1280 × max(1, setting)) wide, rows at floor(width / zoom): CSS 3657 (one row) at 0.5, 1828 (two rows) from 1 to 3.
  {scale: 0.5, size: {width: 1280, height: 16}},
  {scale: 1, size: {width: 1280, height: 56}},
  {scale: 1, sections: OVERLAY_PRESETS['driving-only'], size: {width: 1280, height: 29}},
  {scale: 1.5, size: {width: 1920, height: 82}},
  {scale: 2, size: {width: 2560, height: 110}},
  // ceil(76 × 2.1 + 4.2) = ceil(163.8) = 164.
  {scale: 3, size: {width: 3840, height: 164}}
])('creates the strip window at $size.width x $size.height for the setting $scale', ({scale, sections, size}) => {
  expect(overlayWindowSize('strip', scale, sections)).toEqual(size);
});

it('shows the old visual references: the earlier 70% and 100% strips', () => {
  // ET-045d's strip at scale 0.7 was round(1280 × 0.7) = 896 wide at CSS width 1280 (inner 1253, three rows,
  // ceil(79.8 + 2) = 82) and at scale 1 1280 × 116 (inner 1254, three rows). The new 100% keeps the 70% text size but,
  // by D5, the full 1280 DIP width: two rows, 1280 × 56.
  expect(overlayWindowSize('strip', 1)).toEqual({width: 1280, height: 56});
});

// ET-012d (decision K4): the plan's hand-written table of reserves at zoom 1 (card 48 + 24n, cluster 36 + 21m, HUD
// 18 + 24n) and the window each gives at the setting 1 (zoom 0.7) with its nominal floor of 210 × 252, 308 × 154 and
// 224 × 224: max(round(nominal × 0.7), ceil((reserve − 2 × border) × 0.7 + 2 × border)).
const WITHOUT_DRIVEN = {...DEFAULT_OVERLAY_SECTIONS, 'distance-driven': false};
const WITHOUT_RANGE_AND_DRIVEN = {...WITHOUT_DRIVEN, range: false};
it.each([
  {name: 'every section (card 384, cluster 267, HUD 354)', sections: DEFAULT_OVERLAY_SECTIONS, card: 270, cluster: 188, hud: 248},
  // Card 358 × 0.7 + 2 = 252.6, so 253; cluster 244 × 0.7 + 2 = 172.8, so 173; HUD 330 × 0.7 = 231.
  {name: 'without distance driven (card 360, cluster 246, HUD 330)', sections: WITHOUT_DRIVEN, card: 253, cluster: 173, hud: 231},
  // Cluster 223 × 0.7 + 2 = 158.1, so 159.
  {name: 'without range and distance driven (card 336, cluster 225, HUD 306)', sections: WITHOUT_RANGE_AND_DRIVEN, card: 252, cluster: 159, hud: 224},
  {name: 'also without game time (card 312, cluster 204, HUD 282)', sections: {...WITHOUT_RANGE_AND_DRIVEN, 'game-time': false}, card: 252, cluster: 154, hud: 224},
  {name: 'job-focus (card 216, cluster 141, HUD 186)', sections: OVERLAY_PRESETS['job-focus'], card: 252, cluster: 154, hud: 224},
  {name: 'driving-only (card 168, cluster 78, HUD 138)', sections: OVERLAY_PRESETS['driving-only'], card: 252, cluster: 154, hud: 224},
  {name: 'speed only (card 72, cluster 36, HUD 42)', sections: only('speed'), card: 252, cluster: 154, hud: 224}
])('creates the card, cluster and HUD windows for $name at their reserved height, never below nominal', ({sections, card, cluster, hud}) => {
  expect(overlayWindowSize('card', 1, sections)).toEqual({width: 210, height: card});
  expect(overlayWindowSize('cluster', 1, sections)).toEqual({width: 308, height: cluster});
  expect(overlayWindowSize('hud', 1, sections)).toEqual({width: 224, height: hud});
});

it('keeps the exact nominal geometry of the presets that fit it', () => {
  const area = client(0, 0, 1920, 1080);
  for (const preset of ['job-focus', 'driving-only'] as const) {
    const sections = OVERLAY_PRESETS[preset];
    expect(overlayBounds('card', area, DEFAULT_OVERLAY_PLACEMENTS.card, sections)).toEqual({x: 1694, y: 16, width: 210, height: 252});
    expect(overlayBounds('cluster', area, DEFAULT_OVERLAY_PLACEMENTS.cluster, sections)).toEqual({x: 16, y: 910, width: 308, height: 154});
    expect(overlayBounds('hud', area, DEFAULT_OVERLAY_PLACEMENTS.hud, sections)).toEqual({x: 16, y: 16, width: 224, height: 224});
    // At 1.5 (zoom 1.05) every preset stays round(nominal × 1.05): 315 × 378, 462 × 231 and 336 × 336.
    expect(overlaySize('card', area, 1.5, sections)).toEqual({width: 315, height: 378});
    expect(overlaySize('cluster', area, 1.5, sections)).toEqual({width: 462, height: 231});
    expect(overlaySize('hud', area, 1.5, sections)).toEqual({width: 336, height: 336});
  }
});

it('keeps the nominal size only at the zooms where the reserved rows fit it', () => {
  // Thirteen sections (without distance driven): content 46 + 24 × 13 = 358, so 360 with the border, exactly the card's
  // nominal height at zoom 1 and above. At 1.5 (zoom 1.05): ceil(375.9 + 2.1) = 378 = round(378). Below zoom 1 the border
  // stays one DIP: at 1 (zoom 0.7) ceil(250.6 + 2) = 253, not round(252); at 0.5 (zoom 0.35) ceil(125.3 + 2) = 128, not
  // round(126). At 1.6 (zoom 1.12): ceil(400.96 + 2.24 = 403.2) = 404, not round(403.2) = 403.
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, 1.5, WITHOUT_DRIVEN)).toEqual({width: 315, height: 378});
  expect(overlaySize('card', area, 1, WITHOUT_DRIVEN)).toEqual({width: 210, height: 253});
  expect(overlaySize('card', area, 0.5, WITHOUT_DRIVEN)).toEqual({width: 105, height: 128});
  expect(overlaySize('card', area, 1.6, WITHOUT_DRIVEN)).toEqual({width: 336, height: 404});
});

it('computes a surface height with the border snapped to one device pixel below zoom 1', () => {
  // Strip, three rows at zoom 1.1: 118.8 + 2.2 = 121 (the epsilon keeps binary noise from making it 122).
  expect(surfaceHeightDip(108, 1, 1.1)).toBe(121);
  expect(surfaceHeightDip(382, 1, 0.5)).toBe(193);
  expect(surfaceHeightDip(382, 1, 1.1)).toBe(423);
  expect(surfaceHeightDip(354, 0, 1.25)).toBe(443);
  expect(surfaceHeightDip(265, 1, 1)).toBe(267);
});

it('places fractions 0, 0.5 and 1 across the free space', () => {
  // A card with every section in 1920 x 1080: free space 1678 x 778.
  const area = client(0, 0, 1920, 1080);
  expect(overlayBounds('card', area, {x: 0, y: 0, scale: 1})).toEqual({x: 16, y: 16, width: 210, height: 270});
  expect(overlayBounds('card', area, {x: 0.5, y: 0.5, scale: 1})).toEqual({x: 855, y: 405, width: 210, height: 270});
  expect(overlayBounds('card', area, {x: 1, y: 1, scale: 1})).toEqual({x: 1694, y: 794, width: 210, height: 270});
  // The strip keeps 8 above and below: free height 1080 − 16 − 56 = 1008. A HUD in 960 x 540 has 704 x 260 free:
  // x = −960 + 16 + 176 = −768, y = 16 + 195 = 211.
  expect(overlayBounds('strip', area, {x: 0, y: 1, scale: 1})).toEqual({x: 16, y: 1016, width: 1280, height: 56});
  expect(overlayBounds('hud', client(-960, 0, 960, 540), {x: 0.25, y: 0.75, scale: 1})).toEqual({x: -768, y: 211, width: 224, height: 248});
});

it('keeps every scaled placement inside its client area', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-2560, -300, 2560, 1440), client(13.5, 7.25, 1640.75, 980.5), OWNER_CLIENT]) {
    for (const layout of LAYOUTS) {
      for (const scale of [0.5, 1, 1.37, 2, 3]) {
        for (const [x, y] of [[0, 0], [1, 1], [0.3333, 0.6667]]) {
          const bounds = overlayBounds(layout, area, {x, y, scale});
          if (!bounds) continue;
          expect(bounds.x).toBeGreaterThanOrEqual(Math.floor(area.x));
          expect(bounds.y).toBeGreaterThanOrEqual(Math.floor(area.y));
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(Math.ceil(area.x + area.width));
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(Math.ceil(area.y + area.height));
        }
      }
    }
  }
});

it.each([
  {name: 'past the left and top edges', bounds: {x: -500, y: -500}, expected: {x: 0, y: 0}},
  {name: 'past the right and bottom edges', bounds: {x: 5000, y: 5000}, expected: {x: 1, y: 1}},
  {name: 'inside', bounds: {x: 855, y: 405}, expected: {x: 0.5, y: 0.5}},
  {name: 'at a fraction that needs rounding', bounds: {x: 575, y: 16}, expected: {x: 0.3331, y: 0}}
])('converts a card dropped $name into clamped fractions', ({bounds, expected}) => {
  // Every section, free space 1678 x 778: (575 − 16) / 1678 = 0.33313 and (405 − 16) / 778 = 0.5.
  expect(placementFromBounds('card', client(0, 0, 1920, 1080), {...bounds, width: 210, height: 270}, {x: 0.9, y: 0.9, scale: 1}))
    .toEqual({...expected, scale: 1});
});

it('converts a dropped strip against the height of its enabled sections', () => {
  // Every section: free height 1008, 492 / 1008 = 0.488095. Driving-only: 1035, 492 / 1035 = 0.475362.
  const area = client(0, 0, 1920, 1080), previous = {x: 0.5, y: 0, scale: 1};
  expect(placementFromBounds('strip', area, {x: 320, y: 500, width: 1280, height: 56}, previous)).toEqual({x: 0.5, y: 0.4881, scale: 1});
  expect(placementFromBounds('strip', area, {x: 320, y: 500, width: 1280, height: 29}, previous, OVERLAY_PRESETS['driving-only']))
    .toEqual({x: 0.5, y: 0.4754, scale: 1});
});

it('converts a drop at the new scales against the size of that scale', () => {
  // A card at 3 (630 × 807) in 1920 x 1080 has 1258 x 241 free: (645 − 16) / 1258 = 0.5, (136.5 − 16) / 241 = 0.5.
  // A HUD at 0.5 (112 × 124) has 1776 x 924 free: (460 − 16) / 1776 = 0.25.
  const area = client(0, 0, 1920, 1080);
  expect(placementFromBounds('card', area, {x: 645, y: 136.5, width: 630, height: 807}, {x: 0, y: 0, scale: 3})).toEqual({x: 0.5, y: 0.5, scale: 3});
  expect(placementFromBounds('hud', area, {x: 460, y: 16, width: 112, height: 124}, {x: 0, y: 1, scale: 0.5})).toEqual({x: 0.25, y: 0, scale: 0.5});
});

it('keeps the previous fraction on an axis without free space, or when the layout does not fit', () => {
  // A 242 x 600 area leaves the card no horizontal free space; vertically, with every section, (100 − 16) / 298 = 0.28188.
  expect(placementFromBounds('card', client(0, 0, 242, 600), {x: 0, y: 100, width: 210, height: 270}, {x: 0.25, y: 0, scale: 1})).toEqual({x: 0.25, y: 0.2819, scale: 1});
  expect(placementFromBounds('card', client(0, 0, 200, 200), {x: 0, y: 0, width: 210, height: 270}, {x: 0.25, y: 0.75, scale: 1})).toEqual({x: 0.25, y: 0.75, scale: 1});
});

it('round-trips a placement through its bounds within one DIP', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-639.3333, 10.6667, 1279.3333, 719.3333), client(-3840, -200, 3840, 2160)]) {
    for (const layout of LAYOUTS) {
      for (const scale of [0.5, 1, 1.75, 3]) {
        for (const [x, y] of [[0, 0], [0.1234, 0.9876], [1, 0.5]]) {
          const placed = overlayBounds(layout, area, {x, y, scale});
          if (!placed) continue;
          const back = placementFromBounds(layout, area, placed, {x: 0.5, y: 0.5, scale});
          const again = overlayBounds(layout, area, back)!;
          expect(Math.abs(again.x - placed.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(again.y - placed.y)).toBeLessThanOrEqual(1);
          expect({width: again.width, height: again.height}).toEqual({width: placed.width, height: placed.height});
        }
      }
    }
  }
});

// ET-045e (decision Z3, owner decision D5): the strip is never narrower than at the setting 1 and is limited only by the
// game's client width. In the owner's client (1674.67 DIP between the margins) with every section:
// 0.5: 1280 wide, one row, 16 high; 1: 1280 × 56; 1.5: floor(1674.67) = 1674 wide, CSS floor(1594.29) = 1594, inner
// 1568, three rows: ceil(119.7 + 2.1) = 122; 2: CSS floor(1195.71) = 1195, inner 1169, four rows: ceil(212.8 + 2.8) = 216;
// 3: CSS floor(797.14) = 797, inner 771, five rows: ceil(399 + 4.2) = 404.
it.each([
  {scale: 0.5, size: {width: 1280, height: 16}},
  {scale: 1, size: {width: 1280, height: 56}},
  {scale: 1.5, size: {width: 1674, height: 122}},
  {scale: 2, size: {width: 1674, height: 216}},
  {scale: 3, size: {width: 1674, height: 404}}
])('uses the owner client width for the strip at the setting $scale', ({scale, size}) => {
  expect(overlaySize('strip', OWNER_CLIENT, scale)).toEqual(size);
});

// At the owner's x 0.8485, y 1: free width 1674.67 − 1280 = 394.67, x = round(1722.67 + 334.88) = 2058; the bottom anchor
// puts the top at 248 + (944 − height). Driving only at 1 is one row, ceil(26.6 + 2) = 29; at 2 it is 1674 wide with free
// width 0.67, x = round(1723.23) = 1723, one row of ceil(53.2 + 2.8) = 56.
it.each([
  {name: 'every section at 0.5', scale: 0.5, sections: DEFAULT_OVERLAY_SECTIONS, bounds: {x: 2058, y: 1176, width: 1280, height: 16}},
  {name: 'every section at 1', scale: 1, sections: DEFAULT_OVERLAY_SECTIONS, bounds: {x: 2058, y: 1136, width: 1280, height: 56}},
  {name: 'driving only at 1', scale: 1, sections: OVERLAY_PRESETS['driving-only'], bounds: {x: 2058, y: 1163, width: 1280, height: 29}},
  {name: 'driving only at 2', scale: 2, sections: OVERLAY_PRESETS['driving-only'], bounds: {x: 1723, y: 1136, width: 1674, height: 56}}
])('places the owner strip at the bottom: $name', ({scale, sections, bounds}) => {
  expect(overlayBounds('strip', OWNER_CLIENT, {x: 0.8485, y: 1, scale}, sections)).toEqual(bounds);
});

it('keeps the strip width of the setting 1 in smaller clients', () => {
  // 1280 x 720: 1248 wide at 1 (two rows, 56) and at 0.5 (one row, 16). 1024 x 768: 992 wide, CSS floor(1417.14) = 1417,
  // inner 1390, three rows: ceil(79.8 + 2) = 82 (the earlier 70% was 896 × 82).
  expect(overlaySize('strip', client(0, 0, 1280, 720), 1)).toEqual({width: 1248, height: 56});
  expect(overlaySize('strip', client(0, 0, 1280, 720), 0.5)).toEqual({width: 1248, height: 16});
  expect(overlaySize('strip', client(0, 0, 1024, 768), 1)).toEqual({width: 992, height: 82});
});

it('never makes the strip narrower than at the setting 1, nor wider than the client allows', () => {
  for (const area of [client(0, 0, 1920, 1080), OWNER_CLIENT, client(0, 0, 1280, 720), client(0, 0, 1024, 768)]) {
    const atOne = overlaySize('strip', area, 1);
    expect(atOne).toBeDefined();
    for (let tenths = 5; tenths <= 30; tenths++) {
      const size = overlaySize('strip', area, tenths / 10);
      if (!size) continue;
      expect(size.width, `${tenths / 10}`).toBeGreaterThanOrEqual(atOne!.width);
      expect(size.width, `${tenths / 10}`).toBeLessThanOrEqual(area.width - 32);
    }
  }
});

// ET-045c: placeSize positions any window size by the placement's fractions, so the controller can place the size Windows
// actually applied. Hand-computed in the owner's 2560 × 1440 physical client at 150%, 1706.67 × 960 DIP at (1706.67, 240):
// a 640 × 40 strip at x 0.8485, y 1 has free space 1674.67 − 640 = 1034.67 and 944 − 40 = 904, so
// x = round(1722.67 + 877.91) = 2601 and y = 248 + 904 = 1152. These sizes are explicit and do not depend on the scale.
it('positions any size by the placement fractions and refuses one that does not fit inside the margins', () => {
  const area = OWNER_CLIENT;
  expect(placeSize('strip', area, {x: 0.8485, y: 1, scale: 0.5}, {width: 640, height: 40})).toEqual({x: 2601, y: 1152, width: 640, height: 40});
  // The same placement for a 21 high window: y = 248 + 944 − 21 = 1171.
  expect(placeSize('strip', area, {x: 0.8485, y: 1, scale: 0.5}, {width: 640, height: 21})).toEqual({x: 2601, y: 1171, width: 640, height: 21});
  // A card keeps 16 on every side: 300 × 384 in 1920 × 1080 at x 1, y 0 is at 1920 − 16 − 300 = 1604, 16.
  expect(placeSize('card', client(0, 0, 1920, 1080), {x: 1, y: 0, scale: 1}, {width: 300, height: 384})).toEqual({x: 1604, y: 16, width: 300, height: 384});
  // Exactly the margins fit; one DIP more does not.
  expect(placeSize('strip', client(0, 0, 672, 100), {x: 0.5, y: 0.5, scale: 1}, {width: 640, height: 84})).toEqual({x: 16, y: 8, width: 640, height: 84});
  expect(placeSize('strip', client(0, 0, 672, 100), {x: 0.5, y: 0.5, scale: 1}, {width: 641, height: 84})).toBeUndefined();
  expect(placeSize('strip', client(0, 0, 672, 100), {x: 0.5, y: 0.5, scale: 1}, {width: 640, height: 85})).toBeUndefined();
  expect(placeSize('card', client(0, 0, 0, 100), {x: 0, y: 0, scale: 1}, {width: 10, height: 10})).toBeUndefined();
  expect(placeSize('card', client(0, 0, 100, 100), {x: 0, y: 0, scale: 1}, {width: 0, height: 10})).toBeUndefined();
});
it('equals overlayBounds for every layout at the layout size', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-639.3333, 10.6667, 1279.3333, 719.3333), OWNER_CLIENT]) {
    for (const layout of LAYOUTS) {
      for (const sections of [DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS['job-focus'], OVERLAY_PRESETS['driving-only']]) {
        for (const scale of [0.5, 1, 2, 3]) {
          for (const [x, y] of [[0, 0], [0.8485, 1], [0.5, 0.25]]) {
            const placement = {x, y, scale}, size = overlaySize(layout, area, scale, sections);
            expect(size ? placeSize(layout, area, placement, size) : undefined).toEqual(overlayBounds(layout, area, placement, sections));
          }
        }
      }
    }
  }
});
// ET-045c review, re-derived for ET-045e: a fitted window converts against its actual size. In the owner's client the
// Driving only strip at 0.5 requests 1280 × 16; a window Windows keeps 38 DIP high, fitted at the bottom, has its top at
// 248 + (944 − 38) = 1154 and x round(1722.67 + 0.8485 × 394.67) = 2058. Against its actual 38 DIP (free 906) the drop
// converts to (1154 − 248) / 906 = 1; against the layout's 16 DIP (free 928) it would be 906 / 928 = 0.97629 → 0.9763.
// x is (2058 − 1722.67) / 394.67 = 0.84966 → 0.8497 either way.
it('converts a drop against an explicit window size when one is given', () => {
  const area = OWNER_CLIENT, previous = {x: 0.8485, y: 1, scale: 0.5}, drop = {x: 2058, y: 1154, width: 1280, height: 38};
  expect(placementFromBounds('strip', area, drop, previous, OVERLAY_PRESETS['driving-only'])).toEqual({x: 0.8497, y: 0.9763, scale: 0.5});
  expect(placementFromBounds('strip', area, drop, previous, OVERLAY_PRESETS['driving-only'], {width: 1280, height: 38})).toEqual({x: 0.8497, y: 1, scale: 0.5});
});
