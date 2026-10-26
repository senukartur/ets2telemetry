// REG-009 display formatting. Expected strings are written by hand from the exact unit definitions; rounding
// boundaries straddle each half-step on both sides and avoid exact binary ties.
import {describe, expect, it} from 'vitest';
import {
  fixed, formatBearing, formatBoolean, formatConsumption, formatDeadline, formatDistance, formatGameDuration, formatGameTime, formatGear,
  formatMass, formatMoney, formatMoneyAmount, formatPercent, formatPosition, formatRpm, formatSpeed, formatVolume, GEAR_DISPLAY_MODES, isGearDisplayMode,
  L100KM_US_MPG
} from '../../packages/telemetry-core/src';

describe('rounding and signed zero', () => {
  it.each([
    [0.0136, 'km/h', '0.0 km/h'], [0.0142, 'km/h', '0.1 km/h'], [-0.0136, 'km/h', '0.0 km/h'], [-0.0142, 'km/h', '-0.1 km/h'],
    [27.7638, 'km/h', '99.9 km/h'], [27.7639, 'km/h', '100.0 km/h'], [-2, 'km/h', '-7.2 km/h'],
    [1, 'mph', '2.2 mph'], [10, 'mph', '22.4 mph'], [26.8, 'mph', '59.9 mph'], [26.83, 'mph', '60.0 mph'], [-0.02, 'mph', '0.0 mph']
  ] as const)('speed %s m/s in %s is %s', (mps, unit, text) => expect(formatSpeed(mps, unit)).toBe(text));
  it.each([
    [1234567.5, 'km', 1, '1234.6 km'], [1234567.5, 'mi', 1, '767.1 mi'], [1049.9, 'km', 1, '1.0 km'], [1050.1, 'km', 1, '1.1 km'],
    [199499, 'km', 0, '199 km'], [199501, 'km', 0, '200 km'], [200000, 'mi', 0, '124 mi'], [151000, 'mi', 1, '93.8 mi']
  ] as const)('distance %s m in %s with %s decimals is %s', (meters, unit, decimals, text) => expect(formatDistance(meters, unit, decimals)).toBe(text));
  it.each([
    [410.5, 'L', 1, '410.5 L'], [410.5, 'US gal', 1, '108.4 US gal'], [1000, 'L', 0, '1000 L'], [1000, 'US gal', 0, '264 US gal'],
    [0.04, 'L', 1, '0.0 L'], [0.06, 'L', 1, '0.1 L']
  ] as const)('volume %s L in %s with %s decimals is %s', (liters, unit, decimals, text) => expect(formatVolume(liters, unit, decimals)).toBe(text));
  it('formats mass as tonnes with one decimal or whole pounds', () => {
    expect(formatMass(18000, 't')).toBe('18.0 t');
    expect(formatMass(18000, 'lb')).toBe('39683 lb');
    expect(formatMass(1040, 't')).toBe('1.0 t');
    expect(formatMass(1060, 't')).toBe('1.1 t');
  });
  it('never shows a signed zero for any quantity', () => {
    expect(formatSpeed(-0, 'km/h')).toBe('0.0 km/h');
    expect(formatSpeed(-0, 'mph')).toBe('0.0 mph');
    expect(formatDistance(-0, 'km', 1)).toBe('0.0 km');
    expect(formatDistance(-0, 'mi', 0)).toBe('0 mi');
    expect(formatVolume(-0, 'L', 1)).toBe('0.0 L');
    expect(formatVolume(-0, 'US gal', 0)).toBe('0 US gal');
    expect(formatMass(-0, 't')).toBe('0.0 t');
    expect(formatMass(-0, 'lb')).toBe('0 lb');
    expect(formatConsumption(-0, 'L/100 km')).toEqual({text: '0.0 L/100 km'});
    expect(formatRpm(-0)).toBe('0 rpm');
    expect(formatPercent(-0)).toBe('0%');
    expect(formatPosition({x: -0, y: -0.04, z: -0.0001})).toBe('x 0.0, y 0.0, z 0.0');
    expect(fixed(-0.4, 0)).toBe('0');
    expect(fixed(-0.6, 0)).toBe('-1');
  });
});

describe('REG-009 SDK average consumption', () => {
  it('shows L/100 km with one decimal and US mpg through the exact constant', () => {
    expect(formatConsumption(25, 'L/100 km')).toEqual({text: '25.0 L/100 km'});
    expect(formatConsumption(25, 'US mpg')).toEqual({text: '9.4 US mpg'});
    expect(formatConsumption(30, 'US mpg')).toEqual({text: '7.8 US mpg'});
    expect(formatConsumption(32.5, 'L/100 km')).toEqual({text: '32.5 L/100 km'});
  });
  it('agrees with the rounded 235.215 at one decimal for ordinary values', () => {
    for (const [x, text] of [[25, '9.4'], [30, '7.8'], [32.5, '7.2'], [40, '5.9']] as const) {
      expect(formatConsumption(x, 'US mpg')).toEqual({text: `${text} US mpg`});
      expect((235.215 / x).toFixed(1)).toBe(text);
    }
    expect(L100KM_US_MPG).not.toBe(235.215);
  });
  it('keeps zero numeric in metric and non-numeric in US mpg', () => {
    expect(formatConsumption(0, 'L/100 km')).toEqual({text: '0.0 L/100 km'});
    expect(formatConsumption(0, 'US mpg')).toEqual({reason: 'zero-consumption'});
    expect(formatConsumption(-1, 'US mpg')).toEqual({reason: 'invalid'});
    expect(formatConsumption(Number.NaN, 'L/100 km')).toEqual({reason: 'invalid'});
  });
});

describe('labels for gear, engine and level', () => {
  it.each([[0, 'N'], [1, '1'], [12, '12'], [-1, 'R1'], [-2, 'R2'], [-100, 'R100']] as const)('gear %s is %s', (gear, text) => expect(formatGear(gear)).toBe(text));
  // ET-050: the default is automatic, and both modes keep neutral and reverse.
  it.each([[0, 'N'], [1, '1'], [2, '2'], [3, '3'], [9, '9'], [12, '12'], [100, '100'], [-1, 'R1'], [-2, 'R2'], [-100, 'R100']] as const)(
    'automatic gear %s is %s', (gear, text) => expect(formatGear(gear, 'automatic')).toBe(text));
  it.each([
    [0, 'N'], [1, '1L'], [2, '1H'], [3, '2L'], [4, '2H'], [5, '3L'], [6, '3H'], [7, '4L'], [8, '4H'], [9, '5L'], [10, '5H'], [11, '6L'],
    [12, '6H'], [13, '7L'], [14, '7H'], [15, '8L'], [16, '8H'], [18, '9H'], [99, '50L'], [100, '50H'], [-1, 'R1'], [-2, 'R2'], [-100, 'R100']
  ] as const)('manual gear %s is %s', (gear, text) => expect(formatGear(gear, 'manual')).toBe(text));
  it('defaults to automatic and shows a non-integer forward value as its plain number in both modes', () => {
    for (const gear of [-3, -1, 0, 1, 2, 7, 16]) expect(formatGear(gear)).toBe(formatGear(gear, 'automatic'));
    expect(formatGear(2.5, 'manual')).toBe('2.5');
    expect(formatGear(2.5, 'automatic')).toBe('2.5');
    expect(formatGear(Number.MAX_SAFE_INTEGER + 1, 'manual')).toBe(String(Number.MAX_SAFE_INTEGER + 1));
  });
  // ET-050b B3: manual mode uses derived labels for the gears they cover and the GD2 formula for any other gear.
  it('uses gearbox labels only in manual mode and only for covered gears', () => {
    const labels = {forward: new Map([[1, 'LL'], [2, 'LH'], [3, '1L']]), reverse: new Map([[1, 'R1'], [2, 'RX']])};
    expect(formatGear(1, 'manual', labels)).toBe('LL');
    expect(formatGear(2, 'manual', labels)).toBe('LH');
    expect(formatGear(3, 'manual', labels)).toBe('1L');
    expect(formatGear(4, 'manual', labels)).toBe('2H');
    expect(formatGear(-2, 'manual', labels)).toBe('RX');
    expect(formatGear(-3, 'manual', labels)).toBe('R3');
    expect(formatGear(0, 'manual', labels)).toBe('N');
    expect(formatGear(1, 'automatic', labels)).toBe('1');
    expect(formatGear(-2, 'automatic', labels)).toBe('R2');
    expect(formatGear(1, 'manual', undefined)).toBe('1L');
  });
  it('accepts only the exact gear display mode strings', () => {
    // ET-050b owner option B: the requirement changed; the crawler mode joins the two ET-050 modes.
    expect(GEAR_DISPLAY_MODES).toEqual(['automatic', 'manual', 'crawler']);
    for (const mode of GEAR_DISPLAY_MODES) expect(isGearDisplayMode(mode)).toBe(true);
    for (const value of ['Manual', 'AUTOMATIC', ' manual', 'manual ', '', 'auto', 'Crawler', 'crawler ', 'C', 0, 1, true, null, undefined, {}, ['manual']]) expect(isGearDisplayMode(value)).toBe(false);
  });
  // ET-050b owner option B (October 26, 2026): the ETS2 Scania G38CMR 13+1 dashboard reads C, 1, 2, 3… and R1…R4.
  it('formats crawler mode as the crawler for gear 1 and g − 1 above it, ignoring gearbox labels', () => {
    expect([1, 2, 3, 4, 14].map(gear => formatGear(gear, 'crawler'))).toEqual(['C', '1', '2', '3', '13']);
    expect([1, 2, 3].map(gear => formatGear(gear, 'crawler', undefined, 'L'))).toEqual(['L', '1', '2']);
    expect(formatGear(0, 'crawler')).toBe('N');
    expect(formatGear(-1, 'crawler')).toBe('R1');
    expect(formatGear(-8, 'crawler', undefined, 'L')).toBe('R8');
    const labels = {forward: new Map([[1, 'C1'], [2, 'C2']]), reverse: new Map([[1, 'RX']])};
    expect(formatGear(1, 'crawler', labels)).toBe('C');
    expect(formatGear(-1, 'crawler', labels)).toBe('R1');
    expect(formatGear(1.5, 'crawler')).toBe('1.5');
  });
  it('rounds engine speed and percentages to integers', () => {
    expect(formatRpm(600)).toBe('600 rpm');
    expect(formatRpm(599.4)).toBe('599 rpm');
    expect(formatRpm(599.6)).toBe('600 rpm');
    expect(formatPercent(0.4105)).toBe('41%');
    expect(formatPercent(0.994)).toBe('99%');
    expect(formatPercent(0.996)).toBe('100%');
    expect(formatBoolean(true)).toBe('yes');
    expect(formatBoolean(false)).toBe('no');
  });
});

describe('game time and deadlines', () => {
  it.each([
    [0n, 'Day 1, 00:00'], [1439n, 'Day 1, 23:59'], [1440n, 'Day 2, 00:00'], [12345n, 'Day 9, 13:45'], [12345678n, 'Day 8574, 09:18'],
    [4294967295n, 'Day 2982617, 04:15']
  ] as const)('game minute %s is %s', (minutes, text) => expect(formatGameTime(minutes)).toBe(text));
  it('rejects negative game time', () => expect(() => formatGameTime(-1n)).toThrow(RangeError));
  it.each([[655n, 'in 10 h 55 min'], [45n, 'in 45 min'], [0n, 'in 0 min'], [-1n, 'late by 1 min'], [-312n, 'late by 5 h 12 min'], [1800n, 'in 30 h 0 min']] as const)(
    'deadline remaining %s min is %s', (minutes, text) => expect(formatDeadline(minutes)).toBe(text));
  it('formats a game-time span without a sign', () => {
    expect(formatGameDuration(471n)).toBe('7 h 51 min');
    expect(formatGameDuration(-471n)).toBe('7 h 51 min');
  });
});

describe('game-world placement', () => {
  it.each([[0, '0°'], [0.25, '270°'], [0.5, '180°'], [0.75, '90°'], [-0.25, '90°'], [1, '0°'], [0.9, '36°'], [0.999, '0°'], [0.0001, '0°'], [0.0014, '359°']] as const)(
    'heading %s is bearing %s', (heading, text) => expect(formatBearing(heading)).toBe(text));
  it('shows game coordinates with one decimal', () => {
    expect(formatPosition({x: -31234.54, y: 42.26, z: 18800.71})).toBe('x -31234.5, y 42.3, z 18800.7');
  });
});

describe('money', () => {
  it('shows exact raw digits with the currency basis and never groups or converts', () => {
    expect(formatMoney({kind: 'expected-income', raw: '9007199254740993.123456', sdkType: 'v0-decimal', currency: {basis: 'unknown'}}))
      .toBe('9007199254740993.123456 (currency unknown)');
    expect(formatMoney({kind: 'expected-income', raw: '12345', sdkType: 'u64', currency: {basis: 'sdk-documented', code: 'EUR', source: 'scssdk_telemetry_eut2.h'}}))
      .toBe('12345 EUR (SDK-documented)');
    expect(formatMoney({kind: 'expected-income', raw: '18446744073709551615', sdkType: 'u64', currency: {basis: 'unknown'}}))
      .toBe('18446744073709551615 (currency unknown)');
    expect(formatMoney({kind: 'penalty', raw: '-9223372036854775808', sdkType: 's64', currency: {basis: 'unknown'}}))
      .toBe('-9223372036854775808 (currency unknown)');
    expect(formatMoney({kind: 'revenue', raw: '0', sdkType: 's64', currency: {basis: 'unknown'}})).toBe('0 (currency unknown)');
  });
  it('shows the same exact amount and currency without the SDK provenance suffix for compact displays (ET-045a)', () => {
    const eur = {kind: 'expected-income', raw: '1234567', sdkType: 'u64', currency: {basis: 'sdk-documented', code: 'EUR', source: 'scssdk_telemetry_eut2.h'}} as const;
    expect(formatMoneyAmount(eur)).toBe('1234567 EUR');
    expect(formatMoney(eur)).toBe('1234567 EUR (SDK-documented)');
    expect(formatMoneyAmount({kind: 'expected-income', raw: '18446744073709551615', sdkType: 'u64', currency: {basis: 'sdk-documented', code: 'USD', source: 'scssdk_telemetry_ats.h'}}))
      .toBe('18446744073709551615 USD');
    expect(formatMoneyAmount({kind: 'expected-income', raw: '9007199254740993.123456', sdkType: 'v0-decimal', currency: {basis: 'unknown'}}))
      .toBe('9007199254740993.123456 (currency unknown)');
    expect(formatMoneyAmount({kind: 'revenue', raw: '0', sdkType: 's64', currency: {basis: 'unknown'}})).toBe('0 (currency unknown)');
  });
});
