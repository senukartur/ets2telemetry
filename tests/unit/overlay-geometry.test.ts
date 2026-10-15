import {expect, it} from 'vitest';
import {overlayBounds, type DipRect} from '../../apps/desktop/src/overlay-geometry';

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
