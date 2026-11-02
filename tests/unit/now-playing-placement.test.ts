import {expect, it} from 'vitest';
import {positionFromBounds, widgetBounds} from '../../apps/desktop/src/now-playing/placement';
const primary = {id: 1, workArea: {x: 0, y: 0, width: 1920, height: 1040}}, secondary = {id: 2, workArea: {x: -1280, y: 0, width: 1280, height: 984}};
it('places the default at a margin from the right and 75% down the free work area', () => {
  expect(widgetBounds({displayId: null, x: 1, y: 0.75}, 'minimal', [primary], primary)).toEqual({x: 1604, y: 714, width: 300, height: 78});
});
it('keeps a saved display across style changes, clamps drops and falls back without rewriting it', () => {
  const position = {displayId: '2', x: 1, y: 1};
  expect(widgetBounds(position, 'full', [primary, secondary], primary)).toEqual({x: -376, y: 840, width: 360, height: 128});
  expect(widgetBounds(position, 'full', [primary], primary)).toEqual({x: 1544, y: 896, width: 360, height: 128});
  expect(position).toEqual({displayId: '2', x: 1, y: 1});
  expect(positionFromBounds({x: -9999, y: 9999, width: 300, height: 78}, secondary)).toEqual({displayId: '2', x: 0, y: 1});
});
