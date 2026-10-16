import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {overlayBounds, overlaySize, overlayWindowSize, placementFromBounds, surfaceHeightDip, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';

// REG-016 partial: per-layout placement inside the game's client area in DIP (ET-012a decision L10). The worked
// examples are hand-computed from the plan's geometry table, not produced by the implementation.
// ET-012c (decisions S2-S6): the requirement for the strip's height changed. It reserves as many 36 px rows as its
// enabled sections need at its width, so with every section (the default) the strip expectations below changed from
// one 38 px row to the plan's hand-written all-sections values; one-row values stay for speed only.
// ET-012d (decisions K3-K5): the requirement for the card, cluster and HUD heights changed. Each reserves one fixed row
// per enabled section and is max(round(nominal height × scale), ceil(content × scale + 2 × border × max(1, scale))) high.
// With every section (the default) the content is 382 CSS px for the card (48 + 24 × 14 = 384 with its border), 265 for
// the cluster's panel (36 + 21 × 11 = 267) and 354 for the HUD (18 + 24 × 14, no border), so the expectations with every
// section changed to the plan's hand-written values: 300 × 384, 440 × 267 and 320 × 354 at scale 1, needing 332 × 416,
// 472 × 299 and 352 × 386. The nominal values stay for the presets, which fit their nominal size.
const client = (x: number, y: number, width: number, height: number): DipRect => ({x, y, width, height});
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const SPEED_ONLY = only('speed');

// Card x = cx + cw − 316; cluster y = cy + 16 + (ch − 32 − 267) = cy + ch − 283.
it.each([
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080), strip: {x: 320, y: 8, width: 1280, height: 110},
    card: {x: 1604, y: 16, width: 300, height: 384}, cluster: {x: 16, y: 797, width: 440, height: 267}, hud: {x: 16, y: 16, width: 320, height: 354}},
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720), strip: {x: 16, y: 8, width: 1248, height: 110},
    card: {x: 964, y: 16, width: 300, height: 384}, cluster: {x: 16, y: 437, width: 440, height: 267}, hud: {x: 16, y: 16, width: 320, height: 354}},
  {name: '800 x 600 at (100, 50)', area: client(100, 50, 800, 600), strip: {x: 116, y: 58, width: 768, height: 218},
    card: {x: 584, y: 66, width: 300, height: 384}, cluster: {x: 116, y: 367, width: 440, height: 267}, hud: {x: 116, y: 66, width: 320, height: 354}},
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540), strip: {x: -944, y: 8, width: 928, height: 182},
    card: {x: -316, y: 16, width: 300, height: 384}, cluster: {x: -944, y: 257, width: 440, height: 267}, hud: {x: -944, y: 16, width: 320, height: 354}}
])('places every layout for $name', ({area, strip, card, cluster, hud}) => {
  expect(overlayBounds('strip', area)).toEqual(strip);
  expect(overlayBounds('card', area)).toEqual(card);
  expect(overlayBounds('cluster', area)).toEqual(cluster);
  expect(overlayBounds('hud', area)).toEqual(hud);
});

it('hides the strip, card and HUD in a 500 x 380 area while the cluster still fits', () => {
  // ET-012d: with every section the HUD needs 354 + 32 = 386 high, so it no longer fits 380; it fits 386.
  const area = client(0, 0, 500, 380);
  expect(overlayBounds('strip', area)).toBeUndefined();
  expect(overlayBounds('card', area)).toBeUndefined();
  // 16 + (380 − 32 − 267) = 97.
  expect(overlayBounds('cluster', area)).toEqual({x: 16, y: 97, width: 440, height: 267});
  expect(overlayBounds('hud', area)).toBeUndefined();
  expect(overlayBounds('hud', client(0, 0, 500, 386))).toEqual({x: 16, y: 16, width: 320, height: 354});
});

it.each([
  // Every section at the 480 minimum width needs ten rows: 36 × 10 + 2 = 362, plus 16.
  {layout: 'strip' as const, fits: client(0, 0, 512, 378), narrow: client(0, 0, 511, 378), short: client(0, 0, 512, 377)},
  // Every section: 300 × 384, 440 × 267 and 320 × 354, plus 32 each way.
  {layout: 'card' as const, fits: client(0, 0, 332, 416), narrow: client(0, 0, 331, 416), short: client(0, 0, 332, 415)},
  {layout: 'cluster' as const, fits: client(0, 0, 472, 299), narrow: client(0, 0, 471, 299), short: client(0, 0, 472, 298)},
  {layout: 'hud' as const, fits: client(0, 0, 352, 386), narrow: client(0, 0, 351, 386), short: client(0, 0, 352, 385)}
])('applies the exact fit threshold of the $layout layout', ({layout, fits, narrow, short}) => {
  expect(overlayBounds(layout, fits)).toBeDefined();
  expect(overlayBounds(layout, narrow)).toBeUndefined();
  expect(overlayBounds(layout, short)).toBeUndefined();
});

it('applies the one-row fit threshold of a strip with speed only', () => {
  const placement = DEFAULT_OVERLAY_PLACEMENTS.strip;
  expect(overlayBounds('strip', client(0, 0, 512, 54), placement, SPEED_ONLY)).toEqual({x: 16, y: 8, width: 480, height: 38});
  expect(overlayBounds('strip', client(0, 0, 511, 54), placement, SPEED_ONLY)).toBeUndefined();
  expect(overlayBounds('strip', client(0, 0, 512, 53), placement, SPEED_ONLY)).toBeUndefined();
});

it('rounds fractional DIP positions and floors the strip width', () => {
  // 1.5 scaling of an odd physical rectangle produces fractional DIP coordinates.
  const area = client(-639.3333, 10.6667, 1279.3333, 719.3333);
  expect(overlayBounds('strip', area)).toEqual({x: -623, y: 19, width: 1247, height: 110});
  // Card x = round(−639.3333 + 16 + 947.3333) = 324; cluster y = round(10.6667 + 16 + 420.3333) = 447.
  expect(overlayBounds('card', area)).toEqual({x: 324, y: 27, width: 300, height: 384});
  expect(overlayBounds('cluster', area)).toEqual({x: -623, y: 447, width: 440, height: 267});
  expect(overlayBounds('hud', area)).toEqual({x: -623, y: 27, width: 320, height: 354});
});

it('keeps every placed layout inside its client area', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-2560, -300, 2560, 1440), client(13.5, 7.25, 640.75, 480.5), client(0, 0, 472, 252),
    client(0, 0, 472, 299)]) {
    for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
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
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) expect(overlayBounds(layout, area)).toBeUndefined();
});

// ET-012b placements (decisions M3 and M4). Hand-computed: left = round(x + margin + fraction × free width), where the
// free width is the client width minus both margins and the scaled window; the same for the top.
it.each([
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080)},
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720)},
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540)},
  {name: 'fractional DIP coordinates', area: client(-639.3333, 10.6667, 1279.3333, 719.3333)}
])('reproduces the ET-012a anchors with the default placements for $name', ({area}) => {
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const)
    expect(overlayBounds(layout, area, DEFAULT_OVERLAY_PLACEMENTS[layout])).toEqual(overlayBounds(layout, area));
  expect(DEFAULT_OVERLAY_PLACEMENTS).toEqual({strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}});
});

it.each([
  // Every section: max(round(nominal height × scale), ceil(content × scale + 2 × border × max(1, scale))) with content
  // 382 (card, border 1), 265 (cluster, border 1) and 354 (HUD, no border); widths round(nominal width × scale).
  // Card 0.5: 191 + 2 = 193 (the border stays one DIP; 192 without); 1.1: 420.2 + 2.2 = 422.4, so 423 (round gives 422);
  // 1.5: 573 + 3 = 576; 2: 764 + 4 = 768.
  {layout: 'card' as const, scale: 0.5, size: {width: 150, height: 193}},
  {layout: 'card' as const, scale: 1.1, size: {width: 330, height: 423}},
  {layout: 'card' as const, scale: 1.5, size: {width: 450, height: 576}},
  {layout: 'card' as const, scale: 2, size: {width: 600, height: 768}},
  // Cluster 0.5: 132.5 + 2 = 134.5, so 135; 1.1: 291.5 + 2.2 = 293.7, so 294; 1.5: 397.5 + 3 = 400.5, so 401; 2: 530 + 4.
  {layout: 'cluster' as const, scale: 0.5, size: {width: 220, height: 135}},
  {layout: 'cluster' as const, scale: 1.1, size: {width: 484, height: 294}},
  {layout: 'cluster' as const, scale: 1.5, size: {width: 660, height: 401}},
  {layout: 'cluster' as const, scale: 2, size: {width: 880, height: 534}},
  // HUD 0.5: 177; 1.1: 389.4, so 390; 1.25: 442.5, so 443; 2: 708.
  {layout: 'hud' as const, scale: 0.5, size: {width: 160, height: 177}},
  {layout: 'hud' as const, scale: 1.1, size: {width: 352, height: 390}},
  {layout: 'hud' as const, scale: 1.25, size: {width: 400, height: 443}},
  {layout: 'hud' as const, scale: 2, size: {width: 640, height: 708}},
  // The strip with every section: floor(min(1280 × scale, 1920 − 32)) wide; its CSS width floor(width / scale) is 1280
  // at 0.5 (3 rows), 1258 at 1.5 (3 rows) and 944 at 2 (4 rows), and it is ceil(36 × rows × scale + 2 × max(1, scale))
  // high: below zoom 1 the border stays one device pixel. At 0.5: ceil(36 × 3 × 0.5 + 2) = 56 (not 55); at 1.5:
  // 162 + 3 = 165; at 2: 288 + 4 = 292.
  {layout: 'strip' as const, scale: 0.5, size: {width: 640, height: 56}},
  {layout: 'strip' as const, scale: 1.5, size: {width: 1888, height: 165}},
  {layout: 'strip' as const, scale: 2, size: {width: 1888, height: 292}},
  // 1408 / 1.1 is just below 1280, so the CSS width is 1279 (3 rows); 110 × 1.1 is 121.00000000000001 in binary floating
  // point, which the epsilon keeps at 121 instead of 122.
  {layout: 'strip' as const, scale: 1.1, size: {width: 1408, height: 121}}
])('scales the $layout layout to $size.width x $size.height at $scale', ({layout, scale, size}) => {
  expect(overlaySize(layout, client(0, 0, 1920, 1080), scale)).toEqual(size);
});

it('keeps the snapped one-device-pixel border inside the strip below zoom 1', () => {
  // Speed only at 0.5: one 18 DIP row plus two 1 DIP borders is drawn 20 high, where ceil(38 × 0.5) reserved 19.
  expect(overlaySize('strip', client(0, 0, 1920, 1080), 0.5, SPEED_ONLY)).toEqual({width: 640, height: 20});
  // The reviewer's case: an 800 x 600 client at 0.75 gives a 768 DIP strip, CSS width 1024. Cargo, origin and distance
  // driven with two tags take 998 CSS px, more than the inner width floor(1024 − 2 × 1.3333 − 24) = 997, so two rows:
  // ceil(36 × 2 × 0.75 + 2) = ceil(56) = 56 high. With a 1 CSS px border it would be one row, ceil(38 × 0.75) = 29.
  const sections = only('cargo', 'origin', 'distance-driven');
  expect(overlaySize('strip', client(0, 0, 800, 600), 0.75, sections)).toEqual({width: 768, height: 56});
});

it('rounds a scaled strip height up, never down', () => {
  // Speed only at 1.01: 1292 wide, CSS width floor(1292 / 1.01) = 1279, one row: ceil(38 × 1.01 = 38.38) = 39, where
  // ET-012b's round(38 × scale) gave 38.
  expect(overlaySize('strip', client(0, 0, 1920, 1080), 1.01, SPEED_ONLY)).toEqual({width: 1292, height: 39});
});

it.each([
  // The card with every section at 1.5 is 450 x 576 and needs 482 x 608.
  {layout: 'card' as const, scale: 1.5, fits: client(0, 0, 482, 608), narrow: client(0, 0, 481, 608), short: client(0, 0, 482, 607)},
  // The strip at 2 needs round(480 × 2) + 32 = 992 wide; its CSS width is then 480, where every section needs ten rows:
  // 362 × 2 + 16 = 740 high. With speed only it needs one row: 38 × 2 + 16 = 92.
  {layout: 'strip' as const, scale: 2, fits: client(0, 0, 992, 740), narrow: client(0, 0, 991, 740), short: client(0, 0, 992, 739)},
  {layout: 'strip' as const, scale: 2, sections: SPEED_ONLY, fits: client(0, 0, 992, 92), narrow: client(0, 0, 991, 92), short: client(0, 0, 992, 91)},
  // The strip at 0.5 needs 240 + 32 = 272 wide. Its CSS width 480 with 2 CSS px borders leaves an inner width of
  // 480 − 4 − 24 = 452, where every section still needs ten rows: ceil(36 × 10 × 0.5 + 2) + 16 = 198 high. Speed only
  // needs one row: ceil(18 + 2) + 16 = 36.
  {layout: 'strip' as const, scale: 0.5, fits: client(0, 0, 272, 198), narrow: client(0, 0, 271, 198), short: client(0, 0, 272, 197)},
  {layout: 'strip' as const, scale: 0.5, sections: SPEED_ONLY, fits: client(0, 0, 272, 36), narrow: client(0, 0, 271, 36), short: client(0, 0, 272, 35)}
])('applies the scaled fit threshold of the $layout layout at $scale', ({layout, scale, sections, fits, narrow, short}) => {
  const placement = {x: 0, y: 0, scale};
  expect(overlayBounds(layout, fits, placement, sections)).toBeDefined();
  expect(overlayBounds(layout, narrow, placement, sections)).toBeUndefined();
  expect(overlayBounds(layout, short, placement, sections)).toBeUndefined();
});

it.each([
  // Driving-only reserves two rows at 768 and 928 wide and one at 1248; job-focus two at 1280.
  {name: 'driving-only in 800 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 800, 600), bounds: {x: 16, y: 8, width: 768, height: 74}},
  {name: 'driving-only in 960 x 540', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 960, 540), bounds: {x: 16, y: 8, width: 928, height: 74}},
  {name: 'driving-only in 1280 x 720', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 1280, 720), bounds: {x: 16, y: 8, width: 1248, height: 38}},
  {name: 'job-focus in 1920 x 1080', sections: OVERLAY_PRESETS['job-focus'], area: client(0, 0, 1920, 1080), bounds: {x: 320, y: 8, width: 1280, height: 74}},
  // Driving-only fills one row exactly at 992 wide (inner 966) and wraps at 991.
  {name: 'driving-only in 1024 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 1024, 600), bounds: {x: 16, y: 8, width: 992, height: 38}},
  {name: 'driving-only in 1023 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 1023, 600), bounds: {x: 16, y: 8, width: 991, height: 74}}
])('sizes the strip for its enabled sections: $name', ({sections, area, bounds}) => {
  expect(overlayBounds('strip', area, DEFAULT_OVERLAY_PLACEMENTS.strip, sections)).toEqual(bounds);
});

it.each([
  {layout: 'strip' as const, scale: 1, size: {width: 1280, height: 110}},
  {layout: 'strip' as const, scale: 1, sections: OVERLAY_PRESETS['driving-only'], size: {width: 1280, height: 38}},
  {layout: 'strip' as const, scale: 1.5, size: {width: 1920, height: 165}},
  // Every section: the scaled sizes above; HUD 1.5 is 354 × 1.5 = 531 high.
  {layout: 'card' as const, scale: 1, size: {width: 300, height: 384}},
  {layout: 'card' as const, scale: 1.5, size: {width: 450, height: 576}},
  {layout: 'cluster' as const, scale: 1, size: {width: 440, height: 267}},
  {layout: 'cluster' as const, scale: 1.5, size: {width: 660, height: 401}},
  {layout: 'hud' as const, scale: 1, size: {width: 320, height: 354}},
  {layout: 'hud' as const, scale: 1.5, size: {width: 480, height: 531}}
])('creates the $layout window at $size.width x $size.height for scale $scale', ({layout, scale, sections, size}) => {
  expect(overlayWindowSize(layout, scale, sections)).toEqual(size);
});

// ET-012d (decision K4): the plan's hand-written table of reserves at scale 1 (card 48 + 24n, cluster 36 + 21m, HUD
// 18 + 24n) and the window each gives with its nominal floor.
const WITHOUT_DRIVEN = {...DEFAULT_OVERLAY_SECTIONS, 'distance-driven': false};
const WITHOUT_RANGE_AND_DRIVEN = {...WITHOUT_DRIVEN, range: false};
it.each([
  {name: 'every section', sections: DEFAULT_OVERLAY_SECTIONS, card: 384, cluster: 267, hud: 354},
  {name: 'without distance driven (card 360, cluster 246, HUD 330)', sections: WITHOUT_DRIVEN, card: 360, cluster: 246, hud: 330},
  {name: 'without range and distance driven (card 336, cluster 225, HUD 306)', sections: WITHOUT_RANGE_AND_DRIVEN, card: 360, cluster: 225, hud: 320},
  {name: 'also without game time (card 312, cluster 204, HUD 282)', sections: {...WITHOUT_RANGE_AND_DRIVEN, 'game-time': false}, card: 360, cluster: 220, hud: 320},
  {name: 'job-focus (card 216, cluster 141, HUD 186)', sections: OVERLAY_PRESETS['job-focus'], card: 360, cluster: 220, hud: 320},
  {name: 'driving-only (card 168, cluster 78, HUD 138)', sections: OVERLAY_PRESETS['driving-only'], card: 360, cluster: 220, hud: 320},
  {name: 'speed only (card 72, cluster 36, HUD 42)', sections: only('speed'), card: 360, cluster: 220, hud: 320}
])('creates the card, cluster and HUD windows for $name at their reserved height, never below nominal', ({sections, card, cluster, hud}) => {
  expect(overlayWindowSize('card', 1, sections)).toEqual({width: 300, height: card});
  expect(overlayWindowSize('cluster', 1, sections)).toEqual({width: 440, height: cluster});
  expect(overlayWindowSize('hud', 1, sections)).toEqual({width: 320, height: hud});
});

it('keeps the exact nominal geometry of the presets that fit it', () => {
  const area = client(0, 0, 1920, 1080);
  for (const preset of ['job-focus', 'driving-only'] as const) {
    const sections = OVERLAY_PRESETS[preset];
    expect(overlayBounds('card', area, DEFAULT_OVERLAY_PLACEMENTS.card, sections)).toEqual({x: 1604, y: 16, width: 300, height: 360});
    expect(overlayBounds('cluster', area, DEFAULT_OVERLAY_PLACEMENTS.cluster, sections)).toEqual({x: 16, y: 844, width: 440, height: 220});
    expect(overlayBounds('hud', area, DEFAULT_OVERLAY_PLACEMENTS.hud, sections)).toEqual({x: 16, y: 16, width: 320, height: 320});
    // At 1.5 every preset stays round(nominal × 1.5): 450 × 540, 660 × 330 and 480 × 480.
    expect(overlaySize('card', area, 1.5, sections)).toEqual({width: 450, height: 540});
    expect(overlaySize('cluster', area, 1.5, sections)).toEqual({width: 660, height: 330});
    expect(overlaySize('hud', area, 1.5, sections)).toEqual({width: 480, height: 480});
  }
});

it('keeps the nominal size only at the scales where the reserved rows fit it', () => {
  // Thirteen sections (without distance driven): content 46 + 24 × 13 = 358, so 360 with the border, exactly the card's
  // nominal height at scale 1. At 0.5 the border stays one DIP: ceil(358 × 0.5 + 2) = 181, not round(360 × 0.5) = 180.
  // At 1.12: ceil(400.96 + 2.24 = 403.2) = 404, not round(403.2) = 403.
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, 1, WITHOUT_DRIVEN)).toEqual({width: 300, height: 360});
  expect(overlaySize('card', area, 0.5, WITHOUT_DRIVEN)).toEqual({width: 150, height: 181});
  expect(overlaySize('card', area, 1.12, WITHOUT_DRIVEN)).toEqual({width: 336, height: 404});
});

it('computes a surface height with the border snapped to one device pixel below zoom 1', () => {
  // Strip, three rows at 1.1: 118.8 + 2.2 = 121 (the epsilon keeps binary noise from making it 122).
  expect(surfaceHeightDip(108, 1, 1.1)).toBe(121);
  expect(surfaceHeightDip(382, 1, 0.5)).toBe(193);
  expect(surfaceHeightDip(382, 1, 1.1)).toBe(423);
  expect(surfaceHeightDip(354, 0, 1.25)).toBe(443);
  expect(surfaceHeightDip(265, 1, 1)).toBe(267);
});

it('places fractions 0, 0.5 and 1 across the free space', () => {
  // A card with every section in 1920 x 1080: free space 1588 x 664.
  const area = client(0, 0, 1920, 1080);
  expect(overlayBounds('card', area, {x: 0, y: 0, scale: 1})).toEqual({x: 16, y: 16, width: 300, height: 384});
  expect(overlayBounds('card', area, {x: 0.5, y: 0.5, scale: 1})).toEqual({x: 810, y: 348, width: 300, height: 384});
  expect(overlayBounds('card', area, {x: 1, y: 1, scale: 1})).toEqual({x: 1604, y: 680, width: 300, height: 384});
  // The strip keeps 8 above and below: free height 1080 − 16 − 110 = 954. A HUD in 960 x 540 has 608 x 154 free:
  // x = −960 + 16 + 152 = −792, y = round(16 + 115.5) = 132.
  expect(overlayBounds('strip', area, {x: 0, y: 1, scale: 1})).toEqual({x: 16, y: 962, width: 1280, height: 110});
  expect(overlayBounds('hud', client(-960, 0, 960, 540), {x: 0.25, y: 0.75, scale: 1})).toEqual({x: -792, y: 132, width: 320, height: 354});
});

it('keeps every scaled placement inside its client area', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-2560, -300, 2560, 1440), client(13.5, 7.25, 1640.75, 980.5)]) {
    for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
      for (const scale of [0.5, 1, 1.37, 2]) {
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
  {name: 'inside', bounds: {x: 810, y: 348}, expected: {x: 0.5, y: 0.5}},
  {name: 'at a fraction that needs rounding', bounds: {x: 545, y: 16}, expected: {x: 0.3331, y: 0}}
])('converts a card dropped $name into clamped fractions', ({bounds, expected}) => {
  // Every section, free space 1588 x 664: (545 − 16) / 1588 = 0.33312 and (348 − 16) / 664 = 0.5.
  expect(placementFromBounds('card', client(0, 0, 1920, 1080), {...bounds, width: 300, height: 384}, {x: 0.9, y: 0.9, scale: 1}))
    .toEqual({...expected, scale: 1});
});

it('converts a dropped strip against the height of its enabled sections', () => {
  // Every section: free height 1080 − 16 − 110 = 954, (500 − 8) / 954 = 0.51572. Driving-only: 1080 − 16 − 38 = 1026,
  // 492 / 1026 = 0.47953.
  const area = client(0, 0, 1920, 1080), previous = {x: 0.5, y: 0, scale: 1};
  expect(placementFromBounds('strip', area, {x: 320, y: 500, width: 1280, height: 110}, previous)).toEqual({x: 0.5, y: 0.5157, scale: 1});
  expect(placementFromBounds('strip', area, {x: 320, y: 500, width: 1280, height: 38}, previous, OVERLAY_PRESETS['driving-only']))
    .toEqual({x: 0.5, y: 0.4795, scale: 1});
});

it('keeps the previous fraction on an axis without free space, or when the layout does not fit', () => {
  // A 332 x 600 area leaves the card no horizontal free space; vertically, with every section, (100 − 16) / 184 = 0.45652.
  expect(placementFromBounds('card', client(0, 0, 332, 600), {x: 0, y: 100, width: 300, height: 384}, {x: 0.25, y: 0, scale: 1})).toEqual({x: 0.25, y: 0.4565, scale: 1});
  expect(placementFromBounds('card', client(0, 0, 300, 300), {x: 0, y: 0, width: 300, height: 384}, {x: 0.25, y: 0.75, scale: 1})).toEqual({x: 0.25, y: 0.75, scale: 1});
});

it('round-trips a placement through its bounds within one DIP', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-639.3333, 10.6667, 1279.3333, 719.3333), client(-3840, -200, 3840, 2160)]) {
    for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
      for (const scale of [0.5, 1, 1.75]) {
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
