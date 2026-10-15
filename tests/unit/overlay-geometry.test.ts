import {expect, it} from 'vitest';
import {overlayBounds, overlaySize, placementFromBounds, type DipRect} from '../../apps/desktop/src/overlay-geometry';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';

// REG-016 partial: per-layout placement inside the game's client area in DIP (ET-012a decision L10). The worked
// examples are hand-computed from the plan's geometry table, not produced by the implementation.
const client = (x: number, y: number, width: number, height: number): DipRect => ({x, y, width, height});

it.each([
  {name: '1920 x 1080 at the origin', area: client(0, 0, 1920, 1080), strip: {x: 320, y: 8, width: 1280, height: 38},
    card: {x: 1604, y: 16, width: 300, height: 360}, cluster: {x: 16, y: 844, width: 440, height: 220}, hud: {x: 16, y: 16, width: 320, height: 320}},
  {name: '1280 x 720 at the origin', area: client(0, 0, 1280, 720), strip: {x: 16, y: 8, width: 1248, height: 38},
    card: {x: 964, y: 16, width: 300, height: 360}, cluster: {x: 16, y: 484, width: 440, height: 220}, hud: {x: 16, y: 16, width: 320, height: 320}},
  {name: '800 x 600 at (100, 50)', area: client(100, 50, 800, 600), strip: {x: 116, y: 58, width: 768, height: 38},
    card: {x: 584, y: 66, width: 300, height: 360}, cluster: {x: 116, y: 414, width: 440, height: 220}, hud: {x: 116, y: 66, width: 320, height: 320}},
  {name: 'a 960 x 540 area left of the primary display', area: client(-960, 0, 960, 540), strip: {x: -944, y: 8, width: 928, height: 38},
    card: {x: -316, y: 16, width: 300, height: 360}, cluster: {x: -944, y: 304, width: 440, height: 220}, hud: {x: -944, y: 16, width: 320, height: 320}}
])('places every layout for $name', ({area, strip, card, cluster, hud}) => {
  expect(overlayBounds('strip', area)).toEqual(strip);
  expect(overlayBounds('card', area)).toEqual(card);
  expect(overlayBounds('cluster', area)).toEqual(cluster);
  expect(overlayBounds('hud', area)).toEqual(hud);
});

it('hides the strip and card in a 500 x 380 area while the cluster and HUD still fit', () => {
  const area = client(0, 0, 500, 380);
  expect(overlayBounds('strip', area)).toBeUndefined();
  expect(overlayBounds('card', area)).toBeUndefined();
  expect(overlayBounds('cluster', area)).toEqual({x: 16, y: 144, width: 440, height: 220});
  expect(overlayBounds('hud', area)).toEqual({x: 16, y: 16, width: 320, height: 320});
});

it.each([
  {layout: 'strip' as const, fits: client(0, 0, 512, 54), narrow: client(0, 0, 511, 54), short: client(0, 0, 512, 53)},
  {layout: 'card' as const, fits: client(0, 0, 332, 392), narrow: client(0, 0, 331, 392), short: client(0, 0, 332, 391)},
  {layout: 'cluster' as const, fits: client(0, 0, 472, 252), narrow: client(0, 0, 471, 252), short: client(0, 0, 472, 251)},
  {layout: 'hud' as const, fits: client(0, 0, 352, 352), narrow: client(0, 0, 351, 352), short: client(0, 0, 352, 351)}
])('applies the exact fit threshold of the $layout layout', ({layout, fits, narrow, short}) => {
  expect(overlayBounds(layout, fits)).toBeDefined();
  expect(overlayBounds(layout, narrow)).toBeUndefined();
  expect(overlayBounds(layout, short)).toBeUndefined();
});

it('rounds fractional DIP positions and floors the strip width', () => {
  // 1.5 scaling of an odd physical rectangle produces fractional DIP coordinates.
  const area = client(-639.3333, 10.6667, 1279.3333, 719.3333);
  expect(overlayBounds('strip', area)).toEqual({x: -623, y: 19, width: 1247, height: 38});
  expect(overlayBounds('card', area)).toEqual({x: 324, y: 27, width: 300, height: 360});
  expect(overlayBounds('cluster', area)).toEqual({x: -623, y: 494, width: 440, height: 220});
  expect(overlayBounds('hud', area)).toEqual({x: -623, y: 27, width: 320, height: 320});
});

it('keeps every placed layout inside its client area', () => {
  for (const area of [client(0, 0, 1920, 1080), client(-2560, -300, 2560, 1440), client(13.5, 7.25, 640.75, 480.5), client(0, 0, 472, 252)]) {
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
  {layout: 'card' as const, scale: 0.5, size: {width: 150, height: 180}},
  {layout: 'card' as const, scale: 1.5, size: {width: 450, height: 540}},
  {layout: 'cluster' as const, scale: 2, size: {width: 880, height: 440}},
  {layout: 'hud' as const, scale: 1.25, size: {width: 400, height: 400}},
  // The strip: floor(min(1280 × scale, 1920 − 32)) wide and round(38 × scale) high.
  {layout: 'strip' as const, scale: 0.5, size: {width: 640, height: 19}},
  {layout: 'strip' as const, scale: 1.5, size: {width: 1888, height: 57}},
  {layout: 'strip' as const, scale: 2, size: {width: 1888, height: 76}}
])('scales the $layout layout to $size.width x $size.height at $scale', ({layout, scale, size}) => {
  expect(overlaySize(layout, client(0, 0, 1920, 1080), scale)).toEqual(size);
});

it.each([
  // The card at 1.5 is 450 x 540 and needs 482 x 572.
  {layout: 'card' as const, scale: 1.5, fits: client(0, 0, 482, 572), narrow: client(0, 0, 481, 572), short: client(0, 0, 482, 571)},
  // The strip at 2 needs round(480 × 2) + 32 = 992 wide and round(38 × 2) + 16 = 92 high.
  {layout: 'strip' as const, scale: 2, fits: client(0, 0, 992, 92), narrow: client(0, 0, 991, 92), short: client(0, 0, 992, 91)},
  // The strip at 0.5 needs 240 + 32 = 272 wide and 19 + 16 = 35 high.
  {layout: 'strip' as const, scale: 0.5, fits: client(0, 0, 272, 35), narrow: client(0, 0, 271, 35), short: client(0, 0, 272, 34)}
])('applies the scaled fit threshold of the $layout layout at $scale', ({layout, scale, fits, narrow, short}) => {
  const placement = {x: 0, y: 0, scale};
  expect(overlayBounds(layout, fits, placement)).toBeDefined();
  expect(overlayBounds(layout, narrow, placement)).toBeUndefined();
  expect(overlayBounds(layout, short, placement)).toBeUndefined();
});

it('places fractions 0, 0.5 and 1 across the free space', () => {
  // A card in 1920 x 1080: free space 1588 x 688.
  const area = client(0, 0, 1920, 1080);
  expect(overlayBounds('card', area, {x: 0, y: 0, scale: 1})).toEqual({x: 16, y: 16, width: 300, height: 360});
  expect(overlayBounds('card', area, {x: 0.5, y: 0.5, scale: 1})).toEqual({x: 810, y: 360, width: 300, height: 360});
  expect(overlayBounds('card', area, {x: 1, y: 1, scale: 1})).toEqual({x: 1604, y: 704, width: 300, height: 360});
  // The strip keeps 8 above and below: free height 1080 − 16 − 38 = 1026. A HUD in 960 x 540 has 608 x 188 free.
  expect(overlayBounds('strip', area, {x: 0, y: 1, scale: 1})).toEqual({x: 16, y: 1034, width: 1280, height: 38});
  expect(overlayBounds('hud', client(-960, 0, 960, 540), {x: 0.25, y: 0.75, scale: 1})).toEqual({x: -792, y: 157, width: 320, height: 320});
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
  {name: 'inside', bounds: {x: 810, y: 360}, expected: {x: 0.5, y: 0.5}},
  {name: 'at a fraction that needs rounding', bounds: {x: 545, y: 16}, expected: {x: 0.3331, y: 0}}
])('converts a card dropped $name into clamped fractions', ({bounds, expected}) => {
  // Free space 1588 x 688: (545 − 16) / 1588 = 0.33312.
  expect(placementFromBounds('card', client(0, 0, 1920, 1080), {...bounds, width: 300, height: 360}, {x: 0.9, y: 0.9, scale: 1}))
    .toEqual({...expected, scale: 1});
});

it('keeps the previous fraction on an axis without free space, or when the layout does not fit', () => {
  // A 332 x 600 area leaves the card no horizontal free space; vertically (100 − 16) / 208 = 0.40385.
  expect(placementFromBounds('card', client(0, 0, 332, 600), {x: 0, y: 100, width: 300, height: 360}, {x: 0.25, y: 0, scale: 1})).toEqual({x: 0.25, y: 0.4038, scale: 1});
  expect(placementFromBounds('card', client(0, 0, 300, 300), {x: 0, y: 0, width: 300, height: 360}, {x: 0.25, y: 0.75, scale: 1})).toEqual({x: 0.25, y: 0.75, scale: 1});
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
