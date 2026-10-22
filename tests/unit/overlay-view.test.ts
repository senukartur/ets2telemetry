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

it('keeps the speed and fuel number apart from their unit and labels the SDK mean', () => {
  const view = overlayView(base);
  expect(view.items.map(item => [item.testId, item.value, item.unit, item.detail, item.detailTestId, item.caption])).toEqual([
    ['overlay-speed', '90', 'km/h', undefined, undefined, undefined],
    ['overlay-rpm', '1500 rpm', undefined, undefined, undefined, undefined],
    ['overlay-fuel', '250.0', 'L', '25%', 'overlay-fuel-level', undefined],
    ['overlay-sdk-consumption', '25.0 L/100 km', undefined, undefined, undefined, 'SDK mean'],
    ['overlay-cargo', 'cargo.logs', undefined, undefined, undefined, undefined],
    ['overlay-game-time', 'Day 1, 08:00', undefined, undefined, undefined, undefined]
  ]);
  expect(view.items.map(item => item.label)).toEqual(['Speed', 'Engine RPM', 'Fuel', 'SDK average consumption', 'Cargo', 'Game time']);
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

it('dims stale placeholders and tags no signal, paused and non-game origins', () => {
  const stale = overlayView({...base, status: 'stale', freshness: 'stale', speed: '—', fuel: '—',
    sections: base.sections.map(section => ({id: section.id, state: 'unavailable' as const}))});
  expect(stale.dim).toBe(true); expect(stale.tags).toEqual([{id: 'stale', testId: 'overlay-tag-stale', text: 'Stale'}]);
  expect(stale.items.map(item => [item.value, item.unit, item.unavailable, item.ring, item.detail])).toEqual([
    ['—', 'km/h', true, undefined, undefined], ['—', undefined, true, undefined, undefined], ['—', 'L', true, undefined, undefined],
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
  expect(view.items.map(item => [item.testId, item.value, item.unit, item.caption])).toEqual([
    ['overlay-speed', '90', 'км/ч', undefined],
    ['overlay-rpm', '1500 об/мин', undefined, undefined],
    ['overlay-fuel', '250.0', 'л', undefined],
    ['overlay-sdk-consumption', '25.0 л/100 км', undefined, 'среднее SDK'],
    ['overlay-cargo', 'cargo.logs', undefined, undefined],
    ['overlay-game-time', 'День 1, 08:00', undefined, undefined]
  ]);
  expect(view.items.map(item => item.label)).toEqual(['Скорость', 'Обороты двигателя', 'Топливо', 'Средний расход по SDK', 'Груз', 'Игровое время']);
  expect(view.items.map(item => item.short)).toEqual(['Скорость', 'Обороты', 'Топливо', 'Расход SDK', 'Груз', 'Время']);

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

it('localizes only numeric RPM/consumption units, preserving names equal to those units or UI words', () => {
  const sections: OverlayPresentation['sections'] = [{id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
    {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'}, {id: 'cargo', state: 'value', text: 'Speed'},
    {id: 'origin', state: 'value', text: '600 rpm, Settings'}, {id: 'destination', state: 'value', text: 'Łódź, Скорость'}];
  const en = overlayView({...base, sections, language: 'en'}), ru = overlayView({...base, sections, language: 'ru'});
  expect(en.items.map(item => item.value)).toEqual(['600 rpm', '25.0 L/100 km', 'Speed', '600 rpm, Settings', 'Łódź, Скорость']);
  expect(ru.items.map(item => item.value)).toEqual(['600 об/мин', '25.0 л/100 км', 'Speed', '600 rpm, Settings', 'Łódź, Скорость']);
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
