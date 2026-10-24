import {expect, it} from 'vitest';
import type {OverlayPresentation} from '../../packages/contracts/src';
import {overlayView, overlayCardParts} from '../../apps/desktop/src/overlay-view';

// The overlay renderer's view model (ET-012a): arrangement only. React components are not unit-tested (decision L14);
// the runtime overlay smoke reads the rendered DOM.
const base: OverlayPresentation = {source: 'ETS2', origin: 'game', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '250.0', fuelUnit: 'L',
  freshness: 'current', layout: 'strip', paused: false, sections: [
    {id: 'speed', state: 'value', text: '90 km/h'}, {id: 'rpm', state: 'value', text: '1500 rpm', ring: 0.5},
    {id: 'fuel', state: 'value', text: '250.0 L', detail: '25%'}, {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'},
    {id: 'cargo', state: 'value', text: 'cargo.logs'}, {id: 'game-time', state: 'value', text: 'Day 1, 08:00'}], editing: false};

// ET-045a (owner request): the consumption section is labelled "Consumption" without the SDK qualifier and the strip's
// "SDK mean" caption is gone; the value is still the SDK mean in the same unit.
it('keeps the speed and fuel number apart from their unit and labels the consumption without an SDK caption', () => {
  const view = overlayView(base);
  expect(view.items.map(item => [item.testId, item.value, item.unit, item.detail, item.detailTestId])).toEqual([
    ['overlay-speed', '90', 'km/h', undefined, undefined],
    ['overlay-rpm', '1500', 'rpm', undefined, undefined],
    ['overlay-fuel', '250.0', 'L', '25%', 'overlay-fuel-level'],
    ['overlay-sdk-consumption', '25.0 L/100 km', undefined, undefined, undefined],
    ['overlay-cargo', 'cargo.logs', undefined, undefined, undefined],
    ['overlay-game-time', 'Day 1, 08:00', undefined, undefined, undefined]
  ]);
  expect(view.items.map(item => item.label)).toEqual(['Speed', 'Engine RPM', 'Fuel', 'Consumption', 'Cargo', 'Game time']);
  expect(view.items.map(item => item.short)).toEqual(['Speed', 'RPM', 'Fuel', 'Consumption', 'Cargo', 'Time']);
  expect(view.items[1].ring).toBe(0.5);
  expect(view).toMatchObject({layout: 'strip', dim: false, tags: []});
});

it('groups the strip items with only non-empty groups, so dividers never stand alone', () => {
  expect(overlayView(base).groups.map(group => [group.id, group.items.map(item => item.id)])).toEqual([
    ['driving', ['speed', 'rpm']], ['fuel', ['fuel', 'sdk-consumption']], ['job', ['cargo']], ['time', ['game-time']]]);
  expect(overlayView({...base, sections: [{id: 'game-time', state: 'value', text: 'Day 1, 08:00'}]}).groups.map(group => group.id)).toEqual(['time']);
});

it('splits the cluster into a gauge and a side panel, and drops the gauge without speed, gear or RPM', () => {
  const view = overlayView({...base, layout: 'cluster'});
  expect(view.gauge?.speed?.id).toBe('speed'); expect(view.gauge?.gear).toBeUndefined(); expect(view.gauge?.rpm?.ring).toBe(0.5);
  expect(view.panel.map(item => item.id)).toEqual(['fuel', 'sdk-consumption', 'cargo', 'game-time']);
  const panelOnly = overlayView({...base, layout: 'cluster', sections: base.sections.filter(section => section.id === 'cargo' || section.id === 'fuel')});
  expect(panelOnly.gauge).toBeUndefined(); expect(panelOnly.panel.map(item => item.id)).toEqual(['fuel', 'cargo']);
});

// ET-045f: the speed item carries the projection's speed arc fraction only while the speed is available.
it('passes the speed arc fraction onto an available speed item in both languages and onto the Cluster gauge', () => {
  const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '90 km/h', speedRing: 9 / 13}, ...base.sections.slice(1)];
  for (const language of ['en', 'ru'] as const) {
    const view = overlayView({...base, layout: 'cluster', sections, language});
    expect(view.items[0], language).toMatchObject({id: 'speed', value: '90', speedRing: 9 / 13});
    expect(view.gauge?.speed?.speedRing, language).toBe(9 / 13);
    expect(view.gauge?.rpm?.ring, language).toBe(0.5); expect(view.gauge?.rpm?.speedRing, language).toBeUndefined();
    expect(view.items.filter(item => item.speedRing !== undefined).map(item => item.id), language).toEqual(['speed']);
  }
  expect(overlayView({...base, layout: 'cluster', sections: [{id: 'speed', state: 'value', text: '0 km/h', speedRing: 0}]}).gauge?.speed?.speedRing).toBe(0);
  const unavailable = overlayView({...base, layout: 'cluster', freshness: 'stale', speed: '—', sections: [{id: 'speed', state: 'unavailable'}]});
  expect(unavailable.gauge?.speed).toMatchObject({value: '—', unavailable: true}); expect('speedRing' in unavailable.gauge!.speed!).toBe(false);
  expect('speedRing' in overlayView(base).items[0]).toBe(false);
});

it('dims stale placeholders and tags no signal, paused and non-game origins', () => {
  const stale = overlayView({...base, status: 'stale', freshness: 'stale', speed: '—', fuel: '—',
    sections: base.sections.map(section => ({id: section.id, state: 'unavailable' as const}))});
  expect(stale.dim).toBe(true); expect(stale.tags).toEqual([{id: 'stale', testId: 'overlay-tag-stale', text: 'Stale'}]);
  expect(stale.items.map(item => [item.value, item.unit, item.unavailable, item.ring, item.detail])).toEqual([
    ['—', 'km/h', true, undefined, undefined], ['—', 'rpm', true, undefined, undefined], ['—', 'L', true, undefined, undefined],
    ['—', undefined, true, undefined, undefined], ['—', undefined, true, undefined, undefined], ['—', undefined, true, undefined, undefined]]);
  expect(overlayView({...base, freshness: 'unavailable', status: 'disconnected'}).tags).toEqual([{id: 'no-signal', testId: 'overlay-tag-no-signal', text: 'No signal'}]);
  expect(overlayView({...base, paused: true, status: 'paused'}).tags).toEqual([{id: 'paused', testId: 'overlay-tag-paused', text: 'Paused'}]);
  expect(overlayView({...base, origin: 'synthetic'}).tags).toEqual([{id: 'origin', testId: 'overlay-tag-origin', text: 'Synthetic'}]);
  expect(overlayView({...base, origin: 'replay', freshness: 'stale'}).tags).toEqual([{id: 'stale', testId: 'overlay-tag-stale', text: 'Stale'}, {id: 'origin', testId: 'overlay-tag-origin', text: 'Replay'}]);
});

it('shows no signal and no sections before the first delivery', () => {
  expect(overlayView()).toMatchObject({layout: 'strip', source: 'No game', dim: true, items: [], groups: [], panel: [],
    tags: [{id: 'no-signal', testId: 'overlay-tag-no-signal', text: 'No signal'}]});
});

// ET-012b: the renderer only outlines the overlay and marks it as a drag region while editing.
it('passes the edit mode through and starts in driving mode before the first delivery', () => {
  expect(overlayView(base).editing).toBe(false);
  expect(overlayView({...base, editing: true}).editing).toBe(true);
  expect(overlayView().editing).toBe(false);
  // The arrangement is the same in both modes.
  expect({...overlayView({...base, editing: true}), editing: false}).toEqual(overlayView(base));
});
it('localizes labels, units and tags in Russian when language is ru', () => {
  const ruBase: OverlayPresentation = {...base, language: 'ru'};
  const view = overlayView(ruBase);
  expect(view.items.map(item => [item.testId, item.value, item.unit])).toEqual([
    ['overlay-speed', '90', 'км/ч'],
    ['overlay-rpm', '1500', 'об/мин'],
    ['overlay-fuel', '250.0', 'л'],
    ['overlay-sdk-consumption', '25.0 л/100 км', undefined],
    ['overlay-cargo', 'cargo.logs', undefined],
    ['overlay-game-time', 'День 1, 08:00', undefined]
  ]);
  expect(view.items.map(item => item.label)).toEqual(['Скорость', 'Обороты двигателя', 'Топливо', 'Расход', 'Груз', 'Игровое время']);
  expect(view.items.map(item => item.short)).toEqual(['Скорость', 'Обороты', 'Топливо', 'Расход', 'Груз', 'Время']);

  const paused = overlayView({...ruBase, paused: true, status: 'paused'});
  expect(paused.tags).toEqual([{id: 'paused', testId: 'overlay-tag-paused', text: 'Пауза'}]);

  const noSignal = overlayView({...ruBase, freshness: 'unavailable', status: 'disconnected'});
  expect(noSignal.tags).toEqual([{id: 'no-signal', testId: 'overlay-tag-no-signal', text: 'Нет сигнала'}]);

  const synthetic = overlayView({...ruBase, origin: 'synthetic'});
  expect(synthetic.tags).toEqual([{id: 'origin', testId: 'overlay-tag-origin', text: 'Синтетический'}]);

  const replay = overlayView({...ruBase, origin: 'replay', freshness: 'stale'});
  expect(replay.tags).toEqual([{id: 'stale', testId: 'overlay-tag-stale', text: 'Устарело'}, {id: 'origin', testId: 'overlay-tag-origin', text: 'Повтор'}]);

  const deadlineEarly = overlayView({...ruBase, sections: [{id: 'deadline', state: 'value', text: 'in 1 h 30 min'}]});
  expect(deadlineEarly.items[0]?.value).toBe('через 1 ч 30 мин');
  const deadlineLate = overlayView({...ruBase, sections: [{id: 'deadline', state: 'value', text: 'late by 45 min'}]});
  expect(deadlineLate.items[0]?.value).toBe('опоздание на 45 мин');
});

// ET-045d (W2): the RPM number and its localized unit are separate, like speed and fuel; SDK names are never localized.
it('localizes only numeric RPM/consumption units, preserving names equal to those units or UI words', () => {
  const sections: OverlayPresentation['sections'] = [{id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
    {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'}, {id: 'cargo', state: 'value', text: 'Speed'},
    {id: 'origin', state: 'value', text: '600 rpm, Settings'}, {id: 'destination', state: 'value', text: 'Łódź, Скорость'}];
  const en = overlayView({...base, sections, language: 'en'}), ru = overlayView({...base, sections, language: 'ru'});
  expect(en.items.map(item => [item.value, item.unit])).toEqual([['600', 'rpm'], ['25.0 L/100 km', undefined], ['Speed', undefined],
    ['600 rpm, Settings', undefined], ['Łódź, Скорость', undefined]]);
  expect(ru.items.map(item => [item.value, item.unit])).toEqual([['600', 'об/мин'], ['25.0 л/100 км', undefined], ['Speed', undefined],
    ['600 rpm, Settings', undefined], ['Łódź, Скорость', undefined]]);
  expect(ru.items[0].ring).toBe(0.2);
});
it('reserves exactly the existing rows for all eight card hero subsets, including no hero, RPM-only and speed-only', () => {
  const ids = ['speed', 'gear', 'rpm'] as const;
  for (let mask = 0; mask < 8; mask++) {
    const chosen = ids.filter((_id, index) => (mask & (1 << index)) !== 0);
    const presentation: OverlayPresentation = {...base, layout: 'card', sections: [
      ...chosen.map(id => ({id, state: 'unavailable' as const})), {id: 'fuel', state: 'value', text: '0.0 L'}]};
    const parts = overlayCardParts(overlayView(presentation));
    expect(parts.hero.map(item => item.id)).toEqual(chosen); expect(parts.rows.map(item => item.id)).toEqual(['fuel']);
    expect(parts.heroHeight).toBe(chosen.length * 24);
    expect(parts.hero.every(item => item.value === '—' && item.ring === undefined)).toBe(true);
  }
});


it.each(['strip', 'card', 'cluster', 'hud'] as const)('uses one short localized stale tag slot in %s, including paused/section subsets', layout => {
  for (const language of ['en', 'ru'] as const) for (const freshness of ['current', 'stale', 'unavailable'] as const) for (let mask = 0; mask < 8; mask++) {
    const ids = ['speed', 'gear', 'rpm'];
    const view = overlayView({...base, layout, language, freshness, paused: true, origin: 'synthetic', sections: base.sections.filter(item => !ids.includes(item.id) || (mask & (1 << ids.indexOf(item.id))) !== 0)});
    expect(view.tags.map(tag => tag.id)).toEqual([freshness === 'stale' ? 'stale' : freshness === 'unavailable' ? 'no-signal' : 'paused', 'origin']);
    if (freshness === 'stale') expect(view.tags[0].text).toBe(language === 'en' ? 'Stale' : 'Устарело');
    expect(view.dim).toBe(freshness !== 'current'); expect(view.paused).toBe(true);
  }
});

it.each(['strip', 'card', 'cluster', 'hud'] as const)('validates display-only %s content anchors for sparse and populated projections', layout => {
  for (const sections of [[], base.sections]) {
    for (const y of [0, 0.5, 1]) expect(overlayView({...base, layout, sections, contentAnchorY: y}).contentAnchorY).toBe(y);
    for (const value of [undefined, null, NaN, Infinity, -0.1, 1.1, '1', {}, true])
      expect(overlayView({...base, layout, sections, contentAnchorY: value as number}).contentAnchorY).toBe(layout === 'cluster' ? 1 : 0);
  }
});

it('carries no SDK caption on any item in any layout or language, and keeps the income amount without a suffix (ET-045a)', () => {
  const sections: OverlayPresentation['sections'] = [...base.sections, {id: 'expected-income', state: 'value', text: '1234567 EUR'},
    {id: 'range', state: 'value', text: '900 km'}];
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) for (const language of ['en', 'ru'] as const) {
    const view = overlayView({...base, layout, language, sections});
    for (const item of view.items) {
      expect(Object.keys(item), `${layout} ${language} ${item.id}`).not.toContain('caption');
      expect(`${item.label} ${item.short} ${item.value} ${item.detail ?? ''}`, `${layout} ${language} ${item.id}`).not.toMatch(/SDK/);
    }
    expect(view.items.find(item => item.id === 'expected-income')?.value).toBe('1234567 EUR');
    const consumption = view.items.find(item => item.id === 'sdk-consumption')!;
    expect([consumption.label, consumption.short]).toEqual(language === 'en' ? ['Consumption', 'Consumption'] : ['Расход', 'Расход']);
  }
  expect(overlayView({...base, language: 'ru', sections: [{id: 'expected-income', state: 'value', text: '12345 (currency unknown)'}]}).items[0]?.value)
    .toBe('12345 (валюта неизвестна)');
});

// ET-045d (W2): the view splits only telemetry-core's fixed ' rpm' suffix; it parses no number. Any other text stays whole
// without a unit, and an unavailable RPM keeps its unit beside the dash, like speed and fuel.
it.each(['en', 'ru'] as const)('splits the RPM number from its localized unit in %s and keeps any other text whole', language => {
  const unit = language === 'en' ? 'rpm' : 'об/мин';
  const rpm = (section: OverlayPresentation['sections'][number]) => overlayView({...base, language, sections: [section]}).items[0];
  expect(rpm({id: 'rpm', state: 'value', text: '1500 rpm', ring: 0.5})).toMatchObject({value: '1500', unit, ring: 0.5, unavailable: false});
  expect(rpm({id: 'rpm', state: 'value', text: '0 rpm'})).toMatchObject({value: '0', unit});
  expect(rpm({id: 'rpm', state: 'value', text: '1000 rpm'})).toMatchObject({value: '1000', unit});
  expect(rpm({id: 'rpm', state: 'unavailable'})).toMatchObject({value: '—', unit, unavailable: true});
  const other = rpm({id: 'rpm', state: 'value', text: 'abc'});
  expect(other.value).toBe('abc'); expect(other.unit).toBeUndefined();
  expect(rpm({id: 'rpm', state: 'value', text: '1500rpm'}).unit).toBeUndefined();
});

// ET-045d (W1): the strip reserves a three-digit speed, a two-character reverse gear and a four-digit RPM, so 9↔10, 99↔100 and
// 999↔1000 never resize a section. Other sections keep their content width under their caps.
it('reserves stable value widths for speed, gear and RPM only, in every layout, language and state', () => {
  const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '9 km/h'}, {id: 'gear', state: 'value', text: 'N'},
    {id: 'rpm', state: 'value', text: '999 rpm'}, {id: 'fuel', state: 'value', text: '7.0 L'}, {id: 'range', state: 'value', text: '90 km'},
    {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'}, {id: 'game-time', state: 'value', text: 'Day 1, 08:00'}];
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) for (const language of ['en', 'ru'] as const) for (const available of [true, false]) {
    const view = overlayView({...base, layout, language, speed: available ? '9' : '—', fuel: available ? '7.0' : '—',
      sections: available ? sections : sections.map(section => ({id: section.id, state: 'unavailable' as const}))});
    expect(view.items.map(item => [item.id, item.reserve]), `${layout} ${language} ${available}`).toEqual([['speed', '000'], ['gear', 'R0'], ['rpm', '0000'],
      ['fuel', undefined], ['range', undefined], ['sdk-consumption', undefined], ['game-time', undefined]]);
  }
});
