import {expect, it} from 'vitest';
import {
  DEFAULT_OVERLAY_PLACEMENTS, isOverlayEditOutcome, isOverlayScale, isPlacementFraction, normalizeFraction, normalizeScale, parseOverlayEditScale,
  parseOverlayPlacement, samePlacement, stepOverlayScale, withPlacement
} from '../../apps/desktop/src/overlay-placement';

// ET-012b placement values (decisions M2-M4 and M10). Hand-written expectations.

it('keeps the default placements frozen at the ET-012a anchors', () => {
  expect(DEFAULT_OVERLAY_PLACEMENTS).toEqual({strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}});
  expect(Object.keys(DEFAULT_OVERLAY_PLACEMENTS)).toEqual(['strip', 'card', 'cluster', 'hud']);
  expect(Object.isFrozen(DEFAULT_OVERLAY_PLACEMENTS)).toBe(true);
  for (const placement of Object.values(DEFAULT_OVERLAY_PLACEMENTS)) expect(Object.isFrozen(placement)).toBe(true);
});

it.each([
  ['NaN', Number.NaN], ['+Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['a string', '0.5'], ['a boolean', true],
  ['null', null], ['undefined', undefined], ['below zero', -0.0001], ['above one', 1.0001], ['an object', {}]
])('rejects %s as a position fraction', (_name, value) => {
  expect(isPlacementFraction(value)).toBe(false);
});

it.each([0, 1, 0.5, -0])('accepts %s as a position fraction', value => {
  expect(isPlacementFraction(value)).toBe(true);
});

it.each([
  ['NaN', Number.NaN], ['+Infinity', Number.POSITIVE_INFINITY], ['-Infinity', Number.NEGATIVE_INFINITY], ['a string', '1'], ['a boolean', false],
  ['zero', 0], ['just below the minimum', 0.4999], ['just above the maximum', 2.0001], ['a negative scale', -1]
])('rejects %s as a scale', (_name, value) => {
  expect(isOverlayScale(value)).toBe(false);
  expect(parseOverlayEditScale(value)).toBeUndefined();
});

it.each([
  {value: 0.5, expected: 0.5}, {value: 2, expected: 2}, {value: 1, expected: 1}, {value: 1.234, expected: 1.23}, {value: 1.999, expected: 2},
  {value: 0.5049, expected: 0.5}, {value: 1.3000000000000003, expected: 1.3}
])('accepts and rounds the edit scale $value to $expected', ({value, expected}) => {
  expect(parseOverlayEditScale(value)).toBe(expected);
});

it('normalises fractions to four decimals and scales to two, without a negative zero', () => {
  expect(normalizeFraction(0.123456)).toBe(0.1235);
  expect(normalizeFraction(0.99995)).toBe(1);
  expect(Object.is(normalizeFraction(-0), 0)).toBe(true);
  expect(Object.is(normalizeFraction(-0.00001), 0)).toBe(true);
  expect(normalizeScale(1.255)).toBe(1.25);
  expect(normalizeScale(0.996)).toBe(1);
});

it('parses a file placement, normalised and frozen, and ignores unknown keys', () => {
  const parsed = parseOverlayPlacement({x: 0.123456, y: 1, scale: 1.256, extra: 'x'});
  expect(parsed).toEqual({x: 0.1235, y: 1, scale: 1.26});
  expect(Object.isFrozen(parsed)).toBe(true);
});

it.each([
  ['a missing scale', {x: 0, y: 0}], ['an out-of-range x', {x: 1.5, y: 0, scale: 1}], ['a negative y', {x: 0, y: -0.1, scale: 1}],
  ['an out-of-range scale', {x: 0, y: 0, scale: 3}], ['a string x', {x: '0', y: 0, scale: 1}], ['an array', [0, 0, 1]], ['null', null], ['a number', 1]
])('rejects %s as a file placement instead of clamping it', (_name, value) => {
  expect(parseOverlayPlacement(value)).toBeUndefined();
});

it('accepts only the two edit outcomes', () => {
  expect(isOverlayEditOutcome('save')).toBe(true); expect(isOverlayEditOutcome('cancel')).toBe(true);
  for (const value of ['Save', 'done', '', undefined, null, 1, {outcome: 'save'}]) expect(isOverlayEditOutcome(value)).toBe(false);
});

it('steps the scale by 0.1 inside its bounds', () => {
  expect(stepOverlayScale(1, 1)).toBe(1.1); expect(stepOverlayScale(1.2, 1)).toBe(1.3); expect(stepOverlayScale(1, -1)).toBe(0.9);
  expect(stepOverlayScale(1.95, 1)).toBe(2); expect(stepOverlayScale(2, 1)).toBe(2);
  expect(stepOverlayScale(0.55, -1)).toBe(0.5); expect(stepOverlayScale(0.5, -1)).toBe(0.5);
});

it('replaces one layout placement with a normalised frozen copy', () => {
  const next = withPlacement(DEFAULT_OVERLAY_PLACEMENTS, 'card', {x: 0.333333, y: 0.5, scale: 1.504});
  expect(next).toEqual({...DEFAULT_OVERLAY_PLACEMENTS, card: {x: 0.3333, y: 0.5, scale: 1.5}});
  expect(Object.isFrozen(next)).toBe(true); expect(Object.isFrozen(next.card)).toBe(true);
  expect(next.strip).toBe(DEFAULT_OVERLAY_PLACEMENTS.strip);
  expect(samePlacement(next.card, {x: 0.3333, y: 0.5, scale: 1.5})).toBe(true);
  expect(samePlacement(next.card, DEFAULT_OVERLAY_PLACEMENTS.card)).toBe(false);
});
