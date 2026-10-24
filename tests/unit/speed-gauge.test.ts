import {describe, expect, it} from 'vitest';
import {SPEED_GAUGE_FULL_SCALE, speedGaugeFraction} from '../../apps/desktop/src/speed-gauge';
import {speedNumber} from '../../apps/desktop/src/unit-profiles';

// ET-045f (REG-009): the shared speed gauge scale. Expected fractions are hand-computed: km/h = m/s × 3.6 on a 130 km/h
// scale, mph = m/s × 3600 / 1609.344 on an 80 mph scale; a speed that shows as 0 or a reverse speed draws no arc.
describe('speed gauge fraction (ET-045f, REG-009)', () => {
  it('uses the Live instrument scales of 130 km/h and 80 mph', () => {
    expect(SPEED_GAUGE_FULL_SCALE).toEqual({'km/h': 130, mph: 80});
    expect(Object.isFrozen(SPEED_GAUGE_FULL_SCALE)).toBe(true);
  });
  it('follows the displayed metric integer: 0 while it shows 0, fractional above it, capped at 1', () => {
    expect(speedGaugeFraction(0, 'metric')).toBe(0);
    expect(speedGaugeFraction(0.1, 'metric')).toBe(0);
    // 0.13 m/s is 0.468 km/h, which shows as 0; 0.14 m/s is 0.504 km/h, which shows as 1.
    expect(speedNumber(0.13, 'metric')).toBe('0'); expect(speedGaugeFraction(0.13, 'metric')).toBe(0);
    expect(speedNumber(0.14, 'metric')).toBe('1'); expect(speedGaugeFraction(0.14, 'metric')).toBeCloseTo(0.504 / 130, 12);
    expect(speedGaugeFraction(25, 'metric')).toBeCloseTo(9 / 13, 12);
    expect(speedGaugeFraction(130 / 3.6, 'metric')).toBeCloseTo(1, 12);
    expect(speedGaugeFraction(50, 'metric')).toBe(1);
  });
  it('draws no arc in reverse while the number keeps its sign', () => {
    expect(speedGaugeFraction(-0.1, 'metric')).toBe(0);
    expect(speedNumber(-1.3889, 'metric')).toBe('-5'); expect(speedGaugeFraction(-1.3889, 'metric')).toBe(0);
  });
  it('follows the displayed US customary integer on the 80 mph scale', () => {
    // 0.2 m/s is 0.447 mph (shows 0); 0.25 m/s is 0.559 mph (shows 1); 25 m/s is 55.923 mph.
    expect(speedGaugeFraction(0.2, 'us-customary')).toBe(0);
    expect(speedGaugeFraction(0.25, 'us-customary')).toBeCloseTo(0.5592340730136005 / 80, 12);
    expect(speedGaugeFraction(25, 'us-customary')).toBeCloseTo(0.6990425912670006, 12);
    expect(speedGaugeFraction(35.7632, 'us-customary')).toBeCloseTo(1, 12);
    expect(speedGaugeFraction(44.704, 'us-customary')).toBe(1);
  });
  it('has no fraction for a speed that is not finite', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(speedGaugeFraction(value, 'metric'), String(value)).toBeUndefined();
      expect(speedGaugeFraction(value, 'us-customary'), String(value)).toBeUndefined();
    }
  });
});
