import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {expect, it} from 'vitest';
import * as format from '../../packages/telemetry-core/src/format';
import {resolveDisplayUnits} from '../../packages/telemetry-core/src/display-profile';
import {localizedMeasurement} from '../../apps/desktop/src/screens/app-copy';
import {localizeDeadlineString, localizeGameTimeString} from '../../apps/desktop/src/i18n';
import {overlayView, OVERLAY_PLACEHOLDER} from '../../apps/desktop/src/overlay-view';
import {liveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {smokePair} from '../shared/live-v1-fixtures';
it.each(['ets2', 'ats'] as const)('binds every real formatter unit to EN/RU localization for both %s profiles', game => {
  for (const profile of ['metric', 'us-customary'] as const) {
    const u = resolveDisplayUnits(game, {profile});
    const metric = profile === 'metric';
    const live = smokePair(); live.observation!.source.game = game;
    live.observation!.state.speed = {available: true, value: 25, unit: 'm/s'}; live.observation!.state.fuel = {available: true, value: 73, unit: 'L'};
    for (const language of ['en', 'ru'] as const) {
      const view = overlayView(overlayPresentation(live, {ets2: profile, ats: profile}, undefined, undefined, false, language));
      expect(view.items.find(item => item.id === 'speed')).toMatchObject({value: metric ? '90' : '56', unit: language === 'en' ? metric ? 'km/h' : 'mph' : metric ? 'км/ч' : 'миль/ч'});
      expect(view.items.find(item => item.id === 'fuel')).toMatchObject({value: metric ? '73' : '19', unit: language === 'en' ? metric ? 'L' : 'US gal' : metric ? 'л' : 'гал'});
    }
    const rows: [string, string, string][] = [
      [format.formatSpeed(25, u.speed), metric ? '90.0 km/h' : '55.9 mph', metric ? '90.0 км/ч' : '55.9 миль/ч'],
      [format.formatSpeed(-2, u.speed), metric ? '-7.2 km/h' : '-4.5 mph', metric ? '-7.2 км/ч' : '-4.5 миль/ч'],
      [format.formatSpeed(0, u.speed), metric ? '0.0 km/h' : '0.0 mph', metric ? '0.0 км/ч' : '0.0 миль/ч'],
      [format.formatDistance(1000, u.distance, 1), metric ? '1.0 km' : '0.6 mi', metric ? '1.0 км' : '0.6 миль'],
      [format.formatVolume(73, u.volume, 1), metric ? '73.0 L' : '19.3 US gal', metric ? '73.0 л' : '19.3 гал'],
      [format.formatMass(18000, u.mass), metric ? '18.0 t' : '39683 lb', metric ? '18.0 т' : '39683 фунт'],
      [format.formatRpm(600), '600 rpm', '600 об/мин'], [format.formatPercent(.5), '50%', '50%']
    ];
    const consumption = format.formatConsumption(30, u.consumption);
    if (!('text' in consumption)) throw new Error('Expected consumption');
    rows.push([consumption.text, metric ? '30.0 L/100 km' : '7.8 US mpg', metric ? '30.0 л/100 км' : '7.8 миль/гал']);
    expect(format.formatConsumption(0, u.consumption)).toEqual(metric ? {text: '0.0 L/100 km'} : {reason: 'zero-consumption'});
    expect(format.formatConsumption(-1, u.consumption)).toEqual({reason: 'invalid'});
    for (const [actual, en, ru] of rows) {expect(localizedMeasurement(actual, 'en')).toBe(en); expect(localizedMeasurement(actual, 'ru')).toBe(ru);}
    for (const language of ['en', 'ru'] as const) {
      // ET-045d (W2): the overlay RPM number and its localized unit are separate; the other measurements stay one text.
      const sections = [
        {id: 'rpm' as const, text: format.formatRpm(600), expected: ['600', language === 'en' ? 'rpm' : 'об/мин']},
        {id: 'range' as const, text: format.formatDistance(1000, u.distance, 1), expected: [language === 'en' ? metric ? '1.0 km' : '0.6 mi' : metric ? '1.0 км' : '0.6 миль', undefined]},
        {id: 'sdk-consumption' as const, text: consumption.text, expected: [language === 'en' ? metric ? '30.0 L/100 km' : '7.8 US mpg' : metric ? '30.0 л/100 км' : '7.8 миль/гал', undefined]}
      ];
      const view = overlayView({...OVERLAY_PLACEHOLDER, language, sections: sections.map(section => ({id: section.id, text: section.text, state: 'value'}))});
      expect(view.items.map(item => [item.value, item.unit])).toEqual(sections.map(section => section.expected));
      const mass = overlayView({...OVERLAY_PLACEHOLDER, language, sections: [{id: 'cargo', state: 'value', text: '18.0 t', detail: format.formatMass(18000, u.mass)}]}).items[0];
      expect(mass.value).toBe('18.0 t'); expect(mass.detail).toBe(language === 'en' ? metric ? '18.0 t' : '39683 lb' : metric ? '18.0 т' : '39683 фунт');
    }

  }
});
it('binds deadline and day-boundary paths plus exact signed/large money digits and provenance', () => {
  for (const [minutes, en, ru] of [[0n, 'in 0 min', 'через 0 мин'], [1n, 'in 1 min', 'через 1 мин'], [61n, 'in 1 h 1 min', 'через 1 ч 1 мин'], [-61n, 'late by 1 h 1 min', 'опоздание на 1 ч 1 мин']] as const) {
    const actual = format.formatDeadline(minutes); expect(actual).toBe(en); expect(localizeDeadlineString(actual, 'ru')).toBe(ru); expect(localizedMeasurement(actual, 'ru')).toBe(ru);
    for (const language of ['en', 'ru'] as const) expect(overlayView({...OVERLAY_PLACEHOLDER, language, sections: [{id: 'deadline', state: 'value', text: actual}]}).items[0].value).toBe(language === 'en' ? en : ru);
  }
  for (const [minutes, en, ru] of [[1439n, 'Day 1, 23:59', 'День 1, 23:59'], [1440n, 'Day 2, 00:00', 'День 2, 00:00']] as const) {
    const actual = format.formatGameTime(minutes); expect(actual).toBe(en); expect(localizeGameTimeString(actual, 'ru')).toBe(ru);
    expect(overlayView({...OVERLAY_PLACEHOLDER, language: 'ru', sections: [{id: 'game-time', state: 'value', text: actual}]}).items[0].value).toBe(ru);
  }
  for (const raw of ['0', '-123', '9007199254741238', '9007199254740993.123456']) {
    for (const currency of [{basis: 'sdk-documented', code: 'EUR', source: 'SDK fixture'}, {basis: 'sdk-documented', code: 'USD', source: 'SDK fixture'}, {basis: 'unknown'}] as const) {
      const actual = format.formatMoney({kind: 'revenue', sdkType: raw.includes('.') ? 'v0-decimal' : 's64', raw, currency});
      const en = currency.basis === 'sdk-documented' ? `${raw} ${currency.code} (SDK-documented)` : `${raw} (currency unknown)`;
      const ru = currency.basis === 'sdk-documented' ? `${raw} ${currency.code} (подтверждено SDK)` : `${raw} (валюта неизвестна)`;
      expect(actual).toBe(en); expect(localizedMeasurement(actual, 'en')).toBe(en); expect(localizedMeasurement(actual, 'ru')).toBe(ru);
    }
  }
});
it('never routes game names resembling units, deadlines, money notes or UI words through localization', () => {
  for (const name of ['Speed', 'Settings', '90.0 km/h', 'in 1 h 1 min', 'Day 2, 00:00', '123 EUR (SDK-documented)', 'Łódź Груз', '20.0 t']) {
    const live = smokePair(), job = live.v1!.observation!.state.configuration.job;
    if (!job.available) throw new Error('Fixture job unavailable');
    live.observation!.state.configuration.truckId = {available: true, value: name};
    for (const id of ['cargo', 'sourceCity', 'sourceCompany', 'destinationCity', 'destinationCompany'] as const) job.value[id] = {available: true, value: name};
    for (const language of ['en', 'ru'] as const) {
      const rows = liveDashboardText(live, undefined, language).sections.flatMap(section => section.rows);
      for (const id of ['cargo', 'source-city', 'source-company', 'destination-city', 'destination-company', 'truck']) expect(rows.find(row => row.id === id)?.value).toBe(name);
      const overlay = overlayView({...OVERLAY_PLACEHOLDER, language, sections: ['cargo', 'origin', 'destination'].map(id => ({id: id as 'cargo' | 'origin' | 'destination', state: 'value', text: name}))});
      expect(overlay.items.map(item => item.value)).toEqual([name, name, name]);
      for (const id of ['origin', 'destination'] as const) expect(overlayView({...OVERLAY_PLACEHOLDER, language, sections: [{id, state: 'value', text: name, detail: name}]}).items[0]).toMatchObject({value: name, detail: name});
    }
  }
});

// ET-050: manual gear labels keep their Latin L and H in Russian on the dashboard and the overlay.
it.each(['en', 'ru'] as const)('keeps manual gear labels unchanged in %s', language => {
  for (const [gear, text] of [[1, '1L'], [2, '1H'], [3, '2L'], [16, '8H'], [18, '9H'], [-1, 'R1'], [0, 'N']] as const) {
    const live = smokePair(); live.observation!.state.gear = {available: true, value: gear, unit: 'index'};
    const modes = {ets2: 'manual', ats: 'manual'} as const;
    expect(localizedMeasurement(text, language)).toBe(text);
    expect(liveDashboardText(live, undefined, language, modes).sections.flatMap(section => section.rows).find(row => row.id === 'gear')?.value).toBe(text);
    const view = overlayView(overlayPresentation(live, undefined, undefined, undefined, false, language, modes));
    expect(view.items.find(item => item.id === 'gear')).toMatchObject({value: text});
  }
});
