import {expect, it} from 'vitest';
import type {OverlaySectionId, OverlaySections} from '../../packages/contracts/src';
import {overlayBounds, overlaySize, overlayWindowSize, placementFromBounds, placeSize, surfaceHeightDip, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';
import {DEFAULT_OVERLAY_SECTIONS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';

// REG-016 partial: per-layout placement inside the game's client area in DIP (ET-012a decision L10). The worked
// examples are hand-computed from the plan's geometry table, not produced by the implementation.
// Current model: the saved scale maps to zoom = setting x 0.7. Strip width is
// floor(client width - 32) at every setting, at least round(480 x zoom).
// The 18 sections and final Hard Mode row need card content 46 + 24 x 19 = 502 CSS px,
// cluster panel content 36 + 21 x 15 = 351, and HUD content 20 + 24 x 19 = 476.
// At zoom 0.7 their windows are 210 x 354, 308 x 248 and 224 x 334 DIP, including snapped borders.
// Strip items use two 112 px tags, section maxima and the final 140 px Hard Mode/qualification item with 14 px gaps.
// At 1280 DIP its CSS width is 1828 and inner width 1801: rows end at cargo (1756), game time (1704),
// and the fixed indicator after both breaks (468). Three 38 px rows need ceil(114 x 0.7 + 2) = 82 DIP.
const client = (x: number, y: number, width: number, height: number): DipRect => ({x, y, width, height});
/** All current sections except Rest State. */
const WITHOUT_REST = {...DEFAULT_OVERLAY_SECTIONS, 'rest-state': false};
const WITHOUT_LIMIT = {...WITHOUT_REST, 'speed-limit': false};
/** The fifteen sections of before ET-071 (cruise control and the speed limit off). */
const WITHOUT_CRUISE = {...WITHOUT_LIMIT, 'cruise-control': false};
/** The fourteen sections of before ET-052 (the next mandatory break, cruise control and the speed limit off). */
const WITHOUT_BREAK = {...WITHOUT_CRUISE, 'mandatory-break': false};
const only = (...ids: OverlaySectionId[]): OverlaySections =>
  Object.freeze(Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, ids.includes(id)])) as Record<OverlaySectionId, boolean>);
const SPEED_ONLY = only('speed');
/** The owner's 2560 × 1440 physical game client at 150%, {1706.67, 240, 1706.67, 960} DIP. */
const OWNER_CLIENT = client(2560 / 1.5, 240, 2560 / 1.5, 960);
const LAYOUTS = ['strip', 'card', 'cluster', 'hud'] as const;

it.each([
  {width: 1920, height: 1080, expectedWidth: 1888},
  {width: 3440, height: 1440, expectedWidth: 3408},
  {width: 2560 / 1.5, height: 960, expectedWidth: 1674}
])('fills the available game width at every scale in a $width DIP client', ({width, height, expectedWidth}) => {
  for (const scale of [0.5, 1, 1.1, 1.5, 2, 3]) {
    const size = overlaySize('strip', client(0, 0, width, height), scale);
    expect(size?.width).toBe(expectedWidth);
  }
});

// Card x = cx + cw - 226; cluster y = cy + ch - 264.
it.each([
  // Strip: 1888 DIP, CSS 2697, inner 2670; rows end at distance driven (2548), then Hard Mode (1394): 56 DIP.
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080), strip: {x: 16, y: 8, width: 1888, height: 56},
    card: {x: 1694, y: 16, width: 210, height: 354}, cluster: {x: 16, y: 816, width: 308, height: 248}, hud: {x: 16, y: 16, width: 224, height: 334}},
  // Strip: 1248 DIP, CSS 1782, inner 1755; rows end at consumption 1442, deadline 1490, Hard Mode 956: three rows.
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720), strip: {x: 16, y: 8, width: 1248, height: 82},
    card: {x: 1054, y: 16, width: 210, height: 354}, cluster: {x: 16, y: 456, width: 308, height: 248}, hud: {x: 16, y: 16, width: 224, height: 334}},
  // Strip: 768 DIP, CSS 1097, inner 1070; rows end at fuel 1044, origin 1012, deadline 862, Hard Mode 956: four rows, 109 DIP.
  {name: '800 x 600 at (100, 50)', area: client(100, 50, 800, 600), strip: {x: 116, y: 58, width: 768, height: 109},
    card: {x: 674, y: 66, width: 210, height: 354}, cluster: {x: 116, y: 386, width: 308, height: 248}, hud: {x: 116, y: 66, width: 224, height: 334}},
  // Strip: 928 DIP, CSS 1325, inner 1298; row totals 1198, 1172, 1240, 264: four rows, 109 DIP.
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540), strip: {x: -944, y: 8, width: 928, height: 109},
    card: {x: -226, y: 16, width: 210, height: 354}, cluster: {x: -944, y: 276, width: 308, height: 248}, hud: {x: -944, y: 16, width: 224, height: 334}}
])('places every layout for $name', ({area, strip, card, cluster, hud}) => {
  expect(overlayBounds('strip', area)).toEqual(strip);
  expect(overlayBounds('card', area)).toEqual(card);
  expect(overlayBounds('cluster', area)).toEqual(cluster);
  expect(overlayBounds('hud', area)).toEqual(hud);
});

it('hides the strip, card and HUD in a 360 x 280 area while the cluster still fits', () => {
  // Strip needs 368 DIP width; card, cluster and HUD need 386, 280 and 366 DIP height including margins.
  const area = client(0, 0, 360, 280);
  expect(overlayBounds('strip', area)).toBeUndefined();
  expect(overlayBounds('card', area)).toBeUndefined();
  // 16 + (280 - 32 - 248) = 16.
  expect(overlayBounds('cluster', area)).toEqual({x: 16, y: 16, width: 308, height: 248});
  expect(overlayBounds('cluster', client(0, 0, 360, 260))).toBeUndefined();
  expect(overlayBounds('hud', area)).toBeUndefined();
  expect(overlayBounds('hud', client(0, 0, 360, 363))).toBeUndefined();
  expect(overlayBounds('hud', client(0, 0, 360, 366))).toEqual({x: 16, y: 16, width: 224, height: 334});
});

it.each([
  // Minimum strip: 336 DIP, CSS 480, inner 453. Twelve 38 px rows need ceil(456 x 0.7 + 2) = 322 DIP.
  // Adding margins gives 368 x 338 DIP; a one-DIP deficit on either axis hides it.
  {layout: 'strip' as const, fits: client(0, 0, 368, 338), narrow: client(0, 0, 367, 338), short: client(0, 0, 368, 337)},
  // Every section: card 210 x 354, cluster 308 x 248, HUD 224 x 334; add 32 DIP on each axis.
  {layout: 'card' as const, fits: client(0, 0, 242, 386), narrow: client(0, 0, 241, 386), short: client(0, 0, 242, 385)},
  {layout: 'cluster' as const, fits: client(0, 0, 340, 280), narrow: client(0, 0, 339, 280), short: client(0, 0, 340, 279)},
  {layout: 'hud' as const, fits: client(0, 0, 256, 366), narrow: client(0, 0, 255, 366), short: client(0, 0, 256, 365)}
])('applies the exact fit threshold of the $layout layout', ({layout, fits, narrow, short}) => {
  expect(overlayBounds(layout, fits)).toBeDefined();
  expect(overlayBounds(layout, narrow)).toBeUndefined();
  expect(overlayBounds(layout, short)).toBeUndefined();
});

it('applies the fit threshold of a strip with speed only', () => {
  // Speed only is 112 + 112 + 140 with two gaps = 392 of the minimum's 453 inner CSS px; the fixed indicator reaches 546, so
  // it takes a second row: ceil(76 × 0.7 + 2) = ceil(55.2) = 56, plus 16 = 72 (one row, 29 and 45, before).
  const placement = DEFAULT_OVERLAY_PLACEMENTS.strip;
  expect(overlayBounds('strip', client(0, 0, 368, 72), placement, SPEED_ONLY)).toEqual({x: 16, y: 8, width: 336, height: 56});
  expect(overlayBounds('strip', client(0, 0, 367, 72), placement, SPEED_ONLY)).toBeUndefined();
  expect(overlayBounds('strip', client(0, 0, 368, 71), placement, SPEED_ONLY)).toBeUndefined();
});

it('rounds fractional DIP positions and floors the strip width', () => {
  // 1.5 scaling of an odd physical rectangle produces fractional DIP coordinates. The strip is floor(1247.33) = 1247 wide,
  // CSS width floor(1781.43) = 1781, inner 1754: ET-052 three rows (the break would reach 1868), where there were two.
  // x = round(−623.33 + 0.5 × 0.33) = −623, y = round(18.67) = 19.
  const area = client(-639.3333, 10.6667, 1279.3333, 719.3333);
  expect(overlayBounds('strip', area)).toEqual({x: -623, y: 19, width: 1247, height: 82});
  // Card x = round(−639.3333 + 16 + 1037.3333) = 414; ET-071: cluster y = round(10.6667 + 16 + (719.3333 − 32 − 232)) = round(482) = 482.
  expect(overlayBounds('card', area)).toEqual({x: 414, y: 27, width: 210, height: 354});
  expect(overlayBounds('cluster', area)).toEqual({x: -623, y: 466, width: 308, height: 248});
  expect(overlayBounds('hud', area)).toEqual({x: -623, y: 27, width: 224, height: 334});
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
// ET-052 (the break adds a row to each): with the contents 406 (card, border 1), 286 (cluster panel, border 1) and 378 (HUD):
// Card 0.35: 142.1 + 2 = 144.1, so 145; 0.7: 284.2 + 2 = 286.2, so 287; 1.05: 426.3 + 2.1 = 428.4, so 429; 1.4: 568.4 + 2.8 = 571.2,
// so 572; 2.1: 852.6 + 4.2 = 856.8, so 857. Cluster 0.35: 100.1 + 2 = 102.1, so 103; 0.7: 200.2 + 2, so 203; 1.05: 300.3 + 2.1 = 302.4,
// so 303; 1.4: 400.4 + 2.8 = 403.2, so 404; 2.1: 600.6 + 4.2 = 604.8, so 605. HUD 0.35: 132.3, so 133; 0.7: 264.6, so 265; 1.05: 396.9,
// so 397; 1.4: 529.2, so 530; 2.1: 793.8, so 794. Widths are unchanged.
// ET-070 (the Hard Mode row adds a row to each): with the contents 430 (card, border 1), 307 (cluster panel, border 1) and 402
// (HUD): Card 0.35: 150.5 + 2 = 152.5, so 153; 0.7: 301 + 2 = 303; 1.05: 451.5 + 2.1 = 453.6, so 454; 1.4: 602 + 2.8 = 604.8,
// so 605; 2.1: 903 + 4.2 = 907.2, so 908. Cluster 0.35: 107.45 + 2 = 109.45, so 110; 0.7: 214.9 + 2, so 217; 1.05: 322.35 + 2.1
// = 324.45, so 325; 1.4: 429.8 + 2.8 = 432.6, so 433; 2.1: 644.7 + 4.2 = 648.9, so 649. HUD 0.35: 140.7, so 141; 0.7: 281.4,
// so 282; 1.05: 422.1, so 423; 1.4: 562.8, so 563; 2.1: 844.2, so 845. Every one is above its nominal floor; widths are unchanged.
// ET-071 (cruise control adds a row to each): with the contents 454 (card, border 1), 328 (cluster panel, border 1) and 426
// (HUD): Card 0.35: 158.9 + 2 = 160.9, so 161; 0.7: 317.8 + 2 = 319.8, so 320; 1.05: 476.7 + 2.1 = 478.8, so 479; 1.4: 635.6
// + 2.8 = 638.4, so 639; 2.1: 953.4 + 4.2 = 957.6, so 958. Cluster 0.35: 114.8 + 2 = 116.8, so 117; 0.7: 229.6 + 2 = 231.6, so
// 232; 1.05: 344.4 + 2.1 = 346.5, so 347; 1.4: 459.2 + 2.8 = 462; 2.1: 688.8 + 4.2 = 693. HUD 0.35: 149.1, so 150; 0.7: 298.2,
// so 299; 1.05: 447.3, so 448; 1.4: 596.4, so 597; 2.1: 894.6, so 895.
// Rest State adds one row to each layout. All sections and Hard Mode are enabled for the table.
const ROW_LAYOUT_TABLE = [
  {scale: 0.5, card: {width: 105, height: 178}, cluster: {width: 154, height: 125}, hud: {width: 112, height: 167}},
  {scale: 1, card: {width: 210, height: 354}, cluster: {width: 308, height: 248}, hud: {width: 224, height: 334}},
  {scale: 1.5, card: {width: 315, height: 530}, cluster: {width: 462, height: 371}, hud: {width: 336, height: 500}},
  {scale: 2, card: {width: 420, height: 706}, cluster: {width: 616, height: 495}, hud: {width: 448, height: 667}},
  {scale: 3, card: {width: 630, height: 1059}, cluster: {width: 924, height: 742}, hud: {width: 672, height: 1000}}
];
it.each(ROW_LAYOUT_TABLE)('sizes the card, cluster and HUD at the setting $scale from its zoom', ({scale, card, cluster, hud}) => {
  const area = client(0, 0, 1920, 1200);
  expect(overlaySize('card', area, scale)).toEqual(card);
  expect(overlaySize('cluster', area, scale)).toEqual(cluster);
  expect(overlaySize('hud', area, scale)).toEqual(hud);
  expect(overlayWindowSize('card', scale)).toEqual(card);
  expect(overlayWindowSize('cluster', scale)).toEqual(cluster);
  expect(overlayWindowSize('hud', scale)).toEqual(hud);
});

it('renders the new 100% exactly as large as the earlier 70% for the card, cluster and HUD', () => {
  // ET-045d's overlaySize(layout, 1920 × 1080, 0.7) with every section, hand-computed with the same formula at scale 0.7:
  // card 210 × 270, cluster 308 × 188 and HUD 224 × 248 with fourteen sections; ET-052's fifteenth makes them 287, 203 and 265.
  // ET-070's Hard Mode row makes every section 303, 217 and 282, and fourteen sections with it are as high as fifteen were
  // without it: content 406, 286 and 378, so 287, 203 and 265. ET-071's cruise control makes every section 320, 232 and 299;
  // without it they are ET-070's 303, 217 and 282. ET-084's speed limit makes every section 337, 232 and 315; without it they
  // are ET-071's 320, 232 and 299.
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, 1)).toEqual({width: 210, height: 354});
  expect(overlaySize('cluster', area, 1)).toEqual({width: 308, height: 248});
  expect(overlaySize('hud', area, 1)).toEqual({width: 224, height: 334});
  expect(overlaySize('card', area, 1, WITHOUT_LIMIT)).toEqual({width: 210, height: 320});
  expect(overlaySize('cluster', area, 1, WITHOUT_LIMIT)).toEqual({width: 308, height: 233});
  expect(overlaySize('hud', area, 1, WITHOUT_LIMIT)).toEqual({width: 224, height: 300});
  expect(overlaySize('card', area, 1, WITHOUT_CRUISE)).toEqual({width: 210, height: 303});
  expect(overlaySize('cluster', area, 1, WITHOUT_CRUISE)).toEqual({width: 308, height: 219});
  expect(overlaySize('hud', area, 1, WITHOUT_CRUISE)).toEqual({width: 224, height: 283});
  expect(overlaySize('card', area, 1, WITHOUT_BREAK)).toEqual({width: 210, height: 287});
  expect(overlaySize('cluster', area, 1, WITHOUT_BREAK)).toEqual({width: 308, height: 204});
  expect(overlaySize('hud', area, 1, WITHOUT_BREAK)).toEqual({width: 224, height: 266});
});

it.each([
  // Every section in 1920 x 1080: 1888 DIP wide at every scale, rows at CSS width floor(width / zoom).
  // 0.5: inner width 5364 holds the full 3956 CSS px line in one row: ceil(13.3 + 2) = 16 DIP.
  {scale: 0.5, size: {width: 1888, height: 16}},
  // 1.1 (zoom 0.77): CSS width 2451, inner 2424; two rows need ceil(76 x 0.77 + 2) = 61 DIP.
  {scale: 1.1, size: {width: 1888, height: 61}},
  // 1.5 (zoom 1.05): CSS width 1798, inner 1772; three rows need ceil(119.7 + 2.1) = 122 DIP.
  {scale: 1.5, size: {width: 1888, height: 122}},
  // 2 (zoom 1.4): inner 1322; row totals 1198, 1172, 1240, 264: ceil(212.8 + 2.8) = 216 DIP.
  {scale: 2, size: {width: 1888, height: 216}},
  // 3 (zoom 2.1): inner 873; row totals 840, 588, 614, 862, 842, 100: ceil(478.8 + 4.2) = 483 DIP.
  {scale: 3, size: {width: 1888, height: 483}}
])('sizes the strip with every section at the setting $scale to $size.width x $size.height', ({scale, size}) => {
  expect(overlaySize('strip', client(0, 0, 1920, 1080), scale)).toEqual(size);
});

it('keeps the snapped one-device-pixel border inside the strip below zoom 1', () => {
  // Speed only at 0.5: one 13.3 DIP row plus two 1 DIP borders, rounded up to 16.
  expect(overlaySize('strip', client(0, 0, 1920, 1080), 0.5, SPEED_ONLY)).toEqual({width: 1888, height: 16});
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
  // ET-084: the card with every section at 1.5 is 315 x 504 (ET-071: 479) and needs 347 x 536.
  {layout: 'card' as const, scale: 1.5, fits: client(0, 0, 347, 562), narrow: client(0, 0, 346, 562), short: client(0, 0, 347, 561)},
  // The strip at 2 (zoom 1.4) needs round(480 × 1.4) + 32 = 704 wide; its CSS width is then 480 and its inner width 454,
  // where every section needs ten rows and ET-070's indicator an eleventh (478 > 454), and ET-071's cruise control a twelfth
  // (see the minimum above): ceil(638.4 + 2.8) + 16 = 658 high (604 before).
  // Speed only needs two rows with it (506 > 454): ceil(106.4 + 2.8) + 16 = 126.
  {layout: 'strip' as const, scale: 2, fits: client(0, 0, 704, 658), narrow: client(0, 0, 703, 658), short: client(0, 0, 704, 657)},
  {layout: 'strip' as const, scale: 2, sections: SPEED_ONLY, fits: client(0, 0, 704, 126), narrow: client(0, 0, 703, 126), short: client(0, 0, 704, 125)},
  // The strip at 0.5 (zoom 0.35) needs round(480 × 0.35) + 32 = 200 wide. Its CSS width 480 with 2.857 CSS px borders
  // leaves an inner width of floor(450.29) = 450, where every section needs ten rows, the indicator an eleventh and ET-071's
  // cruise control a twelfth: ceil(159.6 + 2) + 16 = 178 high (165 before). Speed only needs two rows: ceil(26.6 + 2) + 16 = 45.
  {layout: 'strip' as const, scale: 0.5, fits: client(0, 0, 200, 178), narrow: client(0, 0, 199, 178), short: client(0, 0, 200, 177)},
  {layout: 'strip' as const, scale: 0.5, sections: SPEED_ONLY, fits: client(0, 0, 200, 45), narrow: client(0, 0, 199, 45), short: client(0, 0, 200, 44)}
])('applies the scaled fit threshold of the $layout layout at $scale', ({layout, scale, sections, fits, narrow, short}) => {
  const placement = {x: 0, y: 0, scale};
  expect(overlayBounds(layout, fits, placement, sections)).toBeDefined();
  expect(overlayBounds(layout, narrow, placement, sections)).toBeUndefined();
  expect(overlayBounds(layout, short, placement, sections)).toBeUndefined();
});

it.each([
  // Driving-only: the base line is 998 CSS px, with Hard Mode/qualification 1152, cruise 1306, and the speed limit 1352.
  // At zoom 0.7 a 966 DIP strip has CSS width 1380 and inner 1353, so one row fits. At 965 DIP, CSS 1378
  // leaves inner 1351 and needs two rows. The 928/915/914/883/882 DIP cases below therefore all need two rows.
  {name: 'driving-only in 800 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 800, 600), bounds: {x: 16, y: 8, width: 768, height: 56}},
  {name: 'driving-only in 960 x 540', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 960, 540), bounds: {x: 16, y: 8, width: 928, height: 56}},
  {name: 'driving-only in 1280 x 720', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 1280, 720), bounds: {x: 16, y: 8, width: 1248, height: 29}},
  {name: 'driving-only at the 966 DIP one-row threshold', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 998, 600), bounds: {x: 16, y: 8, width: 966, height: 29}},
  {name: 'driving-only one DIP below the one-row threshold', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 997, 600), bounds: {x: 16, y: 8, width: 965, height: 56}},
  {name: 'driving-only in 947 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 947, 600), bounds: {x: 16, y: 8, width: 915, height: 56}},
  {name: 'driving-only in 946 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 946, 600), bounds: {x: 16, y: 8, width: 914, height: 56}},
  {name: 'driving-only in 915 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 915, 600), bounds: {x: 16, y: 8, width: 883, height: 56}},
  {name: 'driving-only in 914 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 914, 600), bounds: {x: 16, y: 8, width: 882, height: 56}},
  {name: 'driving-only in 807 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 807, 600), bounds: {x: 16, y: 8, width: 775, height: 56}},
  {name: 'driving-only in 728 x 600', sections: OVERLAY_PRESETS['driving-only'], area: client(0, 0, 728, 600), bounds: {x: 16, y: 8, width: 696, height: 56}},
  // Job-focus fits one row at 1888 DIP (inner CSS width 2670); at 768 DIP it needs two.
  {name: 'job-focus in 1920 x 1080', sections: OVERLAY_PRESETS['job-focus'], area: client(0, 0, 1920, 1080), bounds: {x: 16, y: 8, width: 1888, height: 29}},
  {name: 'job-focus in 800 x 600', sections: OVERLAY_PRESETS['job-focus'], area: client(0, 0, 800, 600), bounds: {x: 16, y: 8, width: 768, height: 56}}
])('sizes the strip for its enabled sections: $name', ({sections, area, bounds}) => {
  expect(overlayBounds('strip', area, DEFAULT_OVERLAY_PLACEMENTS.strip, sections)).toEqual(bounds);
});

it.each([
  // round(1280 × max(1, setting)) wide, rows at floor(width / zoom): CSS 3657 at 0.5, 1828 from 1 to 3, where ET-052
  // needs three rows (inner 1801 to 1802 against the 1868 the break's row would reach) and fourteen sections needed two.
  // ET-071: at 0.5 the 3674 CSS px line no longer fits the inner 3627, so two rows: ceil(26.6 + 2) = 29 (one row, 16, before).
  {scale: 0.5, size: {width: 1280, height: 29}},
  {scale: 0.5, sections: WITHOUT_CRUISE, size: {width: 1280, height: 16}},
  // ceil(114 × 0.7 + 2) = ceil(81.8) = 82.
  {scale: 1, size: {width: 1280, height: 82}},
  {scale: 1, sections: OVERLAY_PRESETS['driving-only'], size: {width: 1280, height: 29}},
  // ceil(114 × 1.05 + 2.1) = ceil(121.8) = 122.
  {scale: 1.5, size: {width: 1920, height: 122}},
  // ceil(114 × 1.4 + 2.8) = ceil(162.4) = 163.
  {scale: 2, size: {width: 2560, height: 163}},
  // ceil(114 × 2.1 + 4.2) = ceil(243.6) = 244.
  {scale: 3, size: {width: 3840, height: 244}}
])('creates the strip window at $size.width x $size.height for the setting $scale', ({scale, sections, size}) => {
  expect(overlayWindowSize('strip', scale, sections)).toEqual(size);
});

it('shows the old visual references: the earlier 70% and 100% strips', () => {
  // ET-045d's strip at scale 0.7 was round(1280 × 0.7) = 896 wide at CSS width 1280 (inner 1253, three rows,
  // ceil(79.8 + 2) = 82) and at scale 1 1280 × 116 (inner 1254, three rows). The new 100% keeps the 70% text size but,
  // by D5, the full 1280 DIP width: two rows, 1280 × 56 with fourteen sections and, with ET-052's fifteenth, three rows, 1280 × 82.
  // ET-070: the Hard Mode indicator takes the break's place without it (the second row ends at game time, 1704 + 114 = 1818 >
  // 1801), so fourteen sections need three rows too.
  expect(overlayWindowSize('strip', 1)).toEqual({width: 1280, height: 82});
  expect(overlayWindowSize('strip', 1, WITHOUT_BREAK)).toEqual({width: 1280, height: 82});
});

// ET-012d (decision K4): the plan's hand-written table of reserves at zoom 1 (card 48 + 24n, cluster 36 + 21m, HUD
// 18 + 24n) and the window each gives at the setting 1 (zoom 0.7) with its nominal floor of 210 × 252, 308 × 154 and
// 224 × 224: max(round(nominal × 0.7), ceil((reserve − 2 × border) × 0.7 + 2 × border)).
// ET-052: the historical rows keep the fourteen sections of ET-012d, so their hand-written numbers still test the same sets.
// ET-070: every reserve includes the Hard Mode row (card 72 + 24n, cluster 57 + 21m, HUD 42 + 24n), so each set needs one
// row more than before: fourteen sections now need what fifteen did, and so on down.
// ET-071: WITHOUT_BREAK also leaves cruise control off, and ET-084 the speed limit, so the historical rows keep their fourteen sections.
const WITHOUT_DRIVEN = {...WITHOUT_BREAK, 'distance-driven': false};
const WITHOUT_RANGE_AND_DRIVEN = {...WITHOUT_DRIVEN, range: false};
it.each([
  // ET-084: card 480 (478 content, 337), cluster 330 (232) and HUD 450 (315).
  {name: 'every section (card 504, cluster 351, HUD 474)', sections: DEFAULT_OVERLAY_SECTIONS, card: 354, cluster: 248, hud: 334},
  // ET-071: card 456 (454 content, 320), cluster 330 (232) and HUD 426 (299).
  {name: 'every section but the speed limit (card 456, cluster 330, HUD 426)', sections: WITHOUT_LIMIT, card: 320, cluster: 233, hud: 300},
  // ET-070: card 432 (430 content, 303), cluster 309 (217) and HUD 402 (282).
  {name: 'every section but cruise control and the speed limit (card 432, cluster 309, HUD 402)', sections: WITHOUT_CRUISE, card: 303, cluster: 219, hud: 283},
  // Card 406 × 0.7 + 2 = 286.2, so 287; cluster 286 × 0.7 + 2 = 202.2, so 203; HUD 378 × 0.7 = 264.6, so 265.
  {name: 'every section but the break (card 408, cluster 288, HUD 378)', sections: WITHOUT_BREAK, card: 287, cluster: 204, hud: 266},
  // Card 382 × 0.7 + 2 = 269.4, so 270; cluster 265 × 0.7 + 2 = 187.5, so 188; HUD 354 × 0.7 = 247.8, so 248.
  {name: 'without distance driven (card 384, cluster 267, HUD 354)', sections: WITHOUT_DRIVEN, card: 270, cluster: 189, hud: 250},
  // Card 358 × 0.7 + 2 = 252.6, so 253; cluster 244 × 0.7 + 2 = 172.8, so 173; HUD 330 × 0.7 = 231.
  {name: 'without range and distance driven (card 360, cluster 246, HUD 330)', sections: WITHOUT_RANGE_AND_DRIVEN, card: 253, cluster: 175, hud: 233},
  // Card 334 × 0.7 + 2 = 235.8, below 252; cluster 223 × 0.7 + 2 = 158.1, so 159; HUD 306 × 0.7 = 214.2, below 224.
  {name: 'also without game time (card 336, cluster 225, HUD 306)', sections: {...WITHOUT_RANGE_AND_DRIVEN, 'game-time': false}, card: 252, cluster: 160, hud: 224},
  {name: 'job-focus (card 240, cluster 162, HUD 210)', sections: OVERLAY_PRESETS['job-focus'], card: 252, cluster: 154, hud: 224},
  // ET-084: driving-only includes cruise control and the speed limit, still below every nominal height.
  {name: 'driving-only (card 240, cluster 120, HUD 210)', sections: OVERLAY_PRESETS['driving-only'], card: 252, cluster: 154, hud: 224},
  {name: 'speed only (card 96, cluster 57, HUD 66)', sections: only('speed'), card: 252, cluster: 154, hud: 224}
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
  // Thirteen rows (ET-070: twelve sections without range and distance driven, and the Hard Mode row; before, thirteen sections
  // without distance driven): content 46 + 24 × 13 = 358, so 360 with the border, exactly the card's
  // nominal height at zoom 1 and above. At 1.5 (zoom 1.05): ceil(375.9 + 2.1) = 378 = round(378). Below zoom 1 the border
  // stays one DIP: at 1 (zoom 0.7) ceil(250.6 + 2) = 253, not round(252); at 0.5 (zoom 0.35) ceil(125.3 + 2) = 128, not
  // round(126). At 1.6 (zoom 1.12): ceil(400.96 + 2.24 = 403.2) = 404, not round(403.2) = 403.
  const area = client(0, 0, 1920, 1080);
  expect(overlaySize('card', area, 1.5, WITHOUT_RANGE_AND_DRIVEN)).toEqual({width: 315, height: 378});
  expect(overlaySize('card', area, 1, WITHOUT_RANGE_AND_DRIVEN)).toEqual({width: 210, height: 253});
  expect(overlaySize('card', area, 0.5, WITHOUT_RANGE_AND_DRIVEN)).toEqual({width: 105, height: 128});
  expect(overlaySize('card', area, 1.6, WITHOUT_RANGE_AND_DRIVEN)).toEqual({width: 336, height: 404});
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
  // Card 210 x 354: free space 1678 x 694, so half fractions give (855, 363) and full fractions (1694, 710).
  const area = client(0, 0, 1920, 1080);
  expect(overlayBounds('card', area, {x: 0, y: 0, scale: 1})).toEqual({x: 16, y: 16, width: 210, height: 354});
  expect(overlayBounds('card', area, {x: 0.5, y: 0.5, scale: 1})).toEqual({x: 855, y: 363, width: 210, height: 354});
  expect(overlayBounds('card', area, {x: 1, y: 1, scale: 1})).toEqual({x: 1694, y: 710, width: 210, height: 354});
  // Strip free height 1080 - 16 - 56 = 1008 gives y 1016. HUD free space in 960 x 540 is 704 x 174:
  // x = -960 + 16 + 176 = -768; y = round(16 + 0.75 x 174) = 147.
  expect(overlayBounds('strip', area, {x: 0, y: 1, scale: 1})).toEqual({x: 16, y: 1016, width: 1888, height: 56});
  expect(overlayBounds('hud', client(-960, 0, 960, 540), {x: 0.25, y: 0.75, scale: 1})).toEqual({x: -768, y: 147, width: 224, height: 334});
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
  {name: 'inside', bounds: {x: 855, y: 363}, expected: {x: 0.5, y: 0.5}},
  {name: 'at a fraction that needs rounding', bounds: {x: 575, y: 16}, expected: {x: 0.3331, y: 0}}
])('converts a card dropped $name into clamped fractions', ({bounds, expected}) => {
  // Every section (ET-084: 337 high), free space 1678 x 711: (575 − 16) / 1678 = 0.33313 and (372 − 16) / 711 = 0.500703.
  expect(placementFromBounds('card', client(0, 0, 1920, 1080), {...bounds, width: 210, height: 354}, {x: 0.9, y: 0.9, scale: 1}))
    .toEqual({...expected, scale: 1});
});

it('converts a dropped strip against the height of its enabled sections', () => {
  // Every section: two rows, 56 DIP, free height 1008; 492 / 1008 = 0.488095. Driving-only: 1035, 492 / 1035 = 0.475362.
  const area = client(0, 0, 1920, 1080), previous = {x: 0.5, y: 0, scale: 1};
  expect(placementFromBounds('strip', area, {x: 16, y: 500, width: 1888, height: 56}, previous)).toEqual({x: 0.5, y: 0.4881, scale: 1});
  expect(placementFromBounds('strip', area, {x: 16, y: 500, width: 1888, height: 29}, previous, OVERLAY_PRESETS['driving-only']))
    .toEqual({x: 0.5, y: 0.4754, scale: 1});
});

it('converts a drop at the new scales against the size of that scale', () => {
  // Card at setting 3 is 630 x 1059. In 1920 x 1131 its free space is 1258 x 40, so (645, 36) gives halves.
  // HUD horizontal free space is 1776 at setting 0.5; (460 - 16) / 1776 = 0.25.
  const area = client(0, 0, 1920, 1080);
  expect(placementFromBounds('card', {...area, height: 1131}, {x: 645, y: 36, width: 630, height: 1059}, {x: 0, y: 0, scale: 3})).toEqual({x: 0.5, y: 0.5, scale: 3});
  expect(placementFromBounds('hud', area, {x: 460, y: 16, width: 112, height: 166}, {x: 0, y: 1, scale: 0.5})).toEqual({x: 0.25, y: 0, scale: 0.5});
});

it('keeps the previous fraction on an axis without free space, or when the layout does not fit', () => {
  // A 242 x 600 area has no horizontal free space; vertically (100 - 16) / (600 - 32 - 354) rounds to 0.3925.
  expect(placementFromBounds('card', client(0, 0, 242, 600), {x: 0, y: 100, width: 210, height: 354}, {x: 0.25, y: 0, scale: 1})).toEqual({x: 0.25, y: 0.3925, scale: 1});
  expect(placementFromBounds('card', client(0, 0, 200, 200), {x: 0, y: 0, width: 210, height: 354}, {x: 0.25, y: 0.75, scale: 1})).toEqual({x: 0.25, y: 0.75, scale: 1});
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

// The strip fills floor(1706.67 - 32) = 1674 DIP at every scale in the owner's client.
// At 50%, CSS width 4782 and inner width 4752 hold all 3956 CSS px in one row (16 DIP).
// At 100%, inner width 2364 needs two rows (56 DIP); larger zooms need three, four and six rows.
it.each([
  {scale: 0.5, size: {width: 1674, height: 16}},
  {scale: 1, size: {width: 1674, height: 56}},
  {scale: 1.5, size: {width: 1674, height: 122}},
  {scale: 2, size: {width: 1674, height: 216}},
  {scale: 3, size: {width: 1674, height: 483}}
])('uses the owner client width for the strip at the setting $scale', ({scale, size}) => {
  expect(overlaySize('strip', OWNER_CLIENT, scale)).toEqual(size);
});

// At x 0.8485, the remaining fractional width is 0.67 DIP, so x rounds to 1723.
// The bottom anchor is 1192 minus the reserved height; Driving only stays one row at 100%.
it.each([
  // One row at 50%: y = 1192 - 16 = 1176.
  {name: 'every section at 0.5', scale: 0.5, sections: DEFAULT_OVERLAY_SECTIONS, bounds: {x: 1723, y: 1176, width: 1674, height: 16}},
  // Two rows at 100%: y = 1192 - 56 = 1136.
  {name: 'every section at 1', scale: 1, sections: DEFAULT_OVERLAY_SECTIONS, bounds: {x: 1723, y: 1136, width: 1674, height: 56}},
  {name: 'driving only at 1', scale: 1, sections: OVERLAY_PRESETS['driving-only'], bounds: {x: 1723, y: 1163, width: 1674, height: 29}},
  // ET-071: y = 248 + (944 − 110) = 1082.
  {name: 'driving only at 2', scale: 2, sections: OVERLAY_PRESETS['driving-only'], bounds: {x: 1723, y: 1082, width: 1674, height: 110}}
])('places the owner strip at the bottom: $name', ({scale, sections, bounds}) => {
  expect(overlayBounds('strip', OWNER_CLIENT, {x: 0.8485, y: 1, scale}, sections)).toEqual(bounds);
});

it('keeps the strip width of the setting 1 in smaller clients', () => {
  // 1280 x 720: 1248 wide at 1 (ET-052: three rows, 82; two rows, 56 before) and at 0.5 (ET-071: CSS floor(3565.71) = 3565,
  // inner 3535 < 3674, two rows, 29; one row, 16, before). 1024 x 768: 992 wide, CSS floor(1417.14) = 1417, inner 1390,
  // four rows with the qualification reserve: ceil(106.4 + 2) = 109 (the earlier 70% was 896 × 82).
  expect(overlaySize('strip', client(0, 0, 1280, 720), 1)).toEqual({width: 1248, height: 82});
  expect(overlaySize('strip', client(0, 0, 1280, 720), 0.5)).toEqual({width: 1248, height: 29});
  expect(overlaySize('strip', client(0, 0, 1024, 768), 1)).toEqual({width: 992, height: 109});
});

it('keeps the same full client width across all supported scale settings', () => {
  for (const area of [client(0, 0, 1920, 1080), OWNER_CLIENT, client(0, 0, 1280, 720), client(0, 0, 1024, 768)]) {
    const atOne = overlaySize('strip', area, 1);
    expect(atOne).toBeDefined();
    for (let tenths = 5; tenths <= 30; tenths++) {
      const size = overlaySize('strip', area, tenths / 10);
      if (!size) continue;
      expect(size.width, `${tenths / 10}`).toBe(atOne!.width);
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
// Windows may apply a narrower, taller window than requested. The explicit 1280 x 38 DIP fit leaves 394.67 DIP
// horizontal free space: (2058 - 1722.67) / 394.67 rounds to 0.8497. Its fitted bottom gives y = 1.
// Without the explicit size, the full-width layout clamps the same x to 1 and computes y against its 16 DIP row.
it('converts a drop against an explicit window size when one is given', () => {
  const area = OWNER_CLIENT, previous = {x: 0.8485, y: 1, scale: 0.5}, drop = {x: 2058, y: 1154, width: 1280, height: 38};
  expect(placementFromBounds('strip', area, drop, previous, OVERLAY_PRESETS['driving-only'])).toEqual({x: 1, y: 0.9763, scale: 0.5});
  expect(placementFromBounds('strip', area, drop, previous, OVERLAY_PRESETS['driving-only'], {width: 1280, height: 38})).toEqual({x: 0.8497, y: 1, scale: 0.5});
});
