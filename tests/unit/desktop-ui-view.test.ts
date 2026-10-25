import {dashboardFuel} from '../../apps/desktop/src/speed-display';
import {describe, expect, it} from 'vitest';
import {clampRatio, connectionTone, desktopLiveView, gaugeArc, hardModeTone, pluginTone, pluginStatusText, recordingTone} from '../../apps/desktop/src/screens/desktop-ui-view';
import {liveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import type {HardModeStatus} from '../../packages/contracts/src/hard-mode';
import {smokePair, smokeV0} from '../shared/live-v1-fixtures';
describe('desktop numeric presentation (REG-002/003/009/014)', () => {
  it('uses normalized canonical values and clamps only geometry, not the displayed reading', () => {
    const live = smokeV0(); live.observation!.state.speed = {available: true, value: 100, unit: 'm/s'};
    const view = desktopLiveView(live);
    expect(view.speed).toBe(360); expect(view.speedText).toBe('360'); expect(view.speedRatio).toBe(1);
    expect(clampRatio(-1)).toBe(0); expect(clampRatio(0)).toBe(0); expect(clampRatio(0.4)).toBe(0.4);
    expect(clampRatio(Infinity)).toBeNull(); expect(clampRatio(null)).toBeNull();
  });
  it('shows zero as current but stale, waiting and disconnected observations as unavailable', () => {
    const live = smokeV0(); live.observation!.state.speed = {available: true, value: 0, unit: 'm/s'};
    expect(desktopLiveView(live)).toMatchObject({current: true, speed: 0, speedText: '0', speedRatio: 0});
    for (const status of ['stale', 'waiting', 'disconnected'] as const) expect(desktopLiveView({...live, fresh: false, status})).toMatchObject({current: false, speed: null, speedText: '—', speedRatio: null, fuelRatio: null});
    expect(desktopLiveView(undefined)).toMatchObject({current: false, speed: null});
  });
  it('rounds only the live speed text and preserves fractional gauge geometry', () => {
    const live = smokeV0(); live.observation!.state.speed = {available: true, value: 1.25, unit: 'm/s'};
    const view = desktopLiveView(live);
    expect(view.speedText).toBe('5'); expect(view.speed).toBe(4.5); expect(view.speedRatio).toBe(4.5 / view.scaleMax);
    expect(live.observation!.state.speed).toEqual({available: true, value: 1.25, unit: 'm/s'});
  });
  it('draws no speed arc while the displayed integer is 0, and keeps fractional geometry above it (ET-045a item 1)', () => {
    const at = (value: number, profiles?: {ets2: 'metric' | 'us-customary'; ats: 'metric' | 'us-customary'}) => {
      const live = smokeV0(); live.observation!.state.speed = {available: true, value, unit: 'm/s'};
      return {view: desktopLiveView(live, profiles), live};
    };
    for (const [value, profiles] of [[0.1, undefined], [0.2, {ets2: 'us-customary', ats: 'us-customary'}], [-0.1, undefined]] as const) {
      const {view, live} = at(value, profiles);
      expect(view.speedText, String(value)).toBe('0'); expect(view.speedRatio, String(value)).toBe(0);
      expect(view.speed, String(value)).not.toBe(0);
      expect(live.observation!.state.speed).toEqual({available: true, value, unit: 'm/s'});
    }
    const moving = at(0.14).view;
    expect(moving.speedText).toBe('1'); expect(moving.speedRatio).toBeGreaterThan(0); expect(moving.speedRatio).toBe(moving.speed! / moving.scaleMax);
    const stale = at(0.1).live;
    expect(desktopLiveView({...stale, fresh: false, status: 'stale'})).toMatchObject({speedText: '—', speedRatio: null});
    const unavailable = smokeV0(); unavailable.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
    expect(desktopLiveView(unavailable)).toMatchObject({speed: null, speedText: '—', speedRatio: null});
  });
  it('preserves game-provided cargo/city/company/truck names in both languages, localizing only labels and provenance', () => {
    const live = smokePair();
    const en = liveDashboardText(live), ru = liveDashboardText(live, undefined, 'ru');
    const rows = (text: typeof en) => text.sections.flatMap(section => section.rows);
    for (const id of ['cargo', 'source-city', 'source-company', 'destination-city', 'destination-company', 'truck'] as const) {
      expect(rows(ru).find(row => row.id === id)?.value, id).toBe(rows(en).find(row => row.id === id)?.value);
    }
    expect(rows(ru).find(row => row.id === 'cargo')?.label).toBe('Груз');
    expect(rows(ru).find(row => row.id === 'sdk-average-consumption')?.note).toContain('не среднее за рейс');
  });
  it('draws a finite named-gauge arc from bounded numeric geometry', () => {
    expect(gaugeArc(10, 0, 90, 0)).toBe('M0 -10 A10 10 0 0 1 10 -6.123233995736766e-16');
  });
});

it('never translates SDK names equal to application words or containing accented/Cyrillic text', () => {
  for (const name of ['Speed', 'Settings', 'Łódź', 'Груз Скорость']) {
    const live = smokePair(), job = live.v1!.observation!.state.configuration.job;
    if (!job.available) throw new Error('Fixture job unavailable');
    for (const key of ['cargo', 'sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany'] as const) job.value[key] = {available: true, value: name};
    live.observation!.state.configuration.truckId = {available: true, value: name};
    for (const language of ['en', 'ru'] as const) {
      const rows = liveDashboardText(live, undefined, language).sections.flatMap(section => section.rows);
      for (const id of ['cargo', 'source-city', 'source-company', 'destination-city', 'destination-company', 'truck']) expect(rows.find(row => row.id === id)?.value, `${language}/${id}`).toBe(name);
    }
  }
});
it.each([
  ['connected', 'ok'], ['paused', 'warn'], ['stale', 'error'], ['disconnected', 'error'], ['incompatible', 'error'], ['service-failed', 'error'],
  ['waiting', 'neutral'], ['unavailable', 'neutral'], ['restarting', 'neutral'], [undefined, 'neutral']
] as const)('colors connection %s with its words, not only a fresh boolean', (state, tone) => expect(connectionTone(state)).toBe(tone));
it.each([
  ['installed', 'ok'], ['outdated', 'warn'], ['working', 'warn'], ['blocked', 'error'], ['missing', 'neutral'], ['excluded', 'neutral']
] as const)('colors plugin %s without presenting missing as installed', (state, tone) => expect(pluginTone([{state: state}])).toBe(tone));
it('gives blocked plugin state precedence, requires every target installed and handles no target', () => {
  expect(pluginTone([])).toBe('neutral'); expect(pluginTone([{state: 'installed'}, {state: 'missing'}])).toBe('neutral');
  expect(pluginTone([{state: 'working'}, {state: 'blocked'}])).toBe('error');
});
it.each([
  ['recording', 'ok'], ['paused', 'warn'], ['waiting', 'warn'], ['opening', 'warn'], ['interrupted', 'error'], ['retrying', 'error'], ['stopped', 'error'],
  ['disabled', 'neutral'], ['unknown', 'neutral'], ['live-only', 'neutral'], ['not-recorded-source', 'neutral'], [undefined, 'neutral']
] as const)('keeps recording %s indicator truthful', (state, tone) => expect(recordingTone(state)).toBe(tone));
it('colors current settings independently of irreversible trip loss', () => {
  const status: HardModeStatus = {assessment: unknownHardMode(0), trip: null};
  expect(hardModeTone(status)).toBe('neutral');
  expect(hardModeTone({...status, assessment: {...status.assessment, state: 'pass'}})).toBe('ok');
  expect(hardModeTone({...status, assessment: {...status.assessment, state: 'fail'}})).toBe('warn');
  expect(hardModeTone({...status, trip: {firstLoss: {}} as HardModeStatus['trip']})).toBe('error');
});

it('makes blocked and missing visibly distinct, with localized words alongside the plugin count', () => {
  expect(pluginStatusText([{state: 'blocked'}], 'en')).toBe('Blocked');
  expect(pluginStatusText([{state: 'missing'}], 'en')).toBe('Not installed');
  expect(pluginStatusText([{state: 'blocked'}], 'ru')).toBe('Заблокирован');
  expect(pluginStatusText([{state: 'missing'}], 'ru')).toBe('Не установлен');
  expect(pluginStatusText([], 'ru')).toBe('Неизвестно');
});

it('distinguishes unavailable tank level, known empty and positive level without discarding known fuel when capacity is missing', () => {
  const live = smokeV0();
  live.observation!.state.fuelCapacity = {available: true, value: 1000, unit: 'L'};
  for (const fuel of [0, 73]) {
    live.observation!.state.fuel = {available: true, value: fuel, unit: 'L'};
    expect(desktopLiveView(live).fuelRatio).toBe(fuel / 1000);
  }
  live.observation!.state.fuelCapacity = {available: false, reason: 'not-observed', unit: 'L'};
  expect(desktopLiveView(live).fuelRatio).toBeNull();
  expect(dashboardFuel(live, 'metric')).toBe('73.0 L');
  live.observation!.state.fuel = {available: false, reason: 'not-observed', unit: 'L'};
  expect(desktopLiveView(live).fuelRatio).toBeNull();
});

// ET-050: live.instrument.gear reads the gear field through desktopLiveView with the displayed game's mode.
describe('gear display mode on the Live instrument (ET-050)', () => {
  const withGear = (value: number) => {const live = smokeV0(); live.observation!.state.gear = {available: true, value, unit: 'index'}; return live;};
  const gear = (value: number, modes?: {ets2: 'automatic' | 'manual'; ats: 'automatic' | 'manual'}) => desktopLiveView(withGear(value), undefined, modes).sources.field('gear');
  it('formats the instrument gear per mode and keeps reverse and neutral', () => {
    expect(gear(3)).toMatchObject({state: 'value', text: '3'});
    expect(gear(3, {ets2: 'automatic', ats: 'manual'})).toMatchObject({state: 'value', text: '3'});
    expect(gear(3, {ets2: 'manual', ats: 'automatic'})).toMatchObject({state: 'value', text: '2L'});
    expect(gear(16, {ets2: 'manual', ats: 'automatic'})).toMatchObject({state: 'value', text: '8H'});
    for (const mode of ['automatic', 'manual'] as const) {
      expect(gear(-1, {ets2: mode, ats: mode}).text).toBe('R1');
      expect(gear(0, {ets2: mode, ats: mode}).text).toBe('N');
    }
    expect(desktopLiveView({...withGear(3), fresh: false, status: 'stale'}, undefined, {ets2: 'manual', ats: 'manual'}).sources.field('gear'))
      .toMatchObject({state: 'missing', reason: 'not-current'});
  });
});
