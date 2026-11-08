import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {OverlaySectionId} from '../../packages/contracts/src';
import {OverlaySettingsPreview} from '../../apps/desktop/src/overlay-settings-preview';
import {overlayExample, overlayPreviewSize} from '../../apps/desktop/src/overlay-settings-preview-model';
import {DEFAULT_OVERLAY_SETTINGS, OVERLAY_LAYOUTS, OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {getOverlaySectionText} from '../../apps/desktop/src/strings';

vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));

const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const driving: OverlaySectionId[] = ['speed', 'gear', 'rpm', 'cruise-control', 'fuel', 'range'];

it.each(['en', 'ru'] as const)('shares enabled order, localized values and the fixed Hard Mode footer in every layout (%s)', language => {
  for (const layout of OVERLAY_LAYOUTS) {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, layout, sections: OVERLAY_PRESETS['driving-only']};
    const example = overlayExample(settings, language, 'active'), view = overlayView(example);
    expect(example.sections.map(section => section.id)).toEqual(driving);
    expect(view.items.map(item => item.id)).toEqual(driving);
    expect(view.items.map(item => item.label)).toEqual(driving.map(id => getOverlaySectionText(id, language)));
    expect(view.items[3]).toMatchObject({value: '90', unit: language === 'ru' ? 'км/ч' : 'km/h'});
    const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings, language, scale: 1}));
    for (const id of driving) expect(html.match(new RegExp(`data-testid="overlay-section-${id}"`, 'g')), id).toHaveLength(1);
    expect(html).not.toContain('data-testid="overlay-section-cargo"');
    expect(html.match(/data-testid="overlay-hard-mode"/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="overlay-hard-mode"')).toBeGreaterThan(html.indexOf('data-testid="overlay-section-range"'));
    expect(html).toContain(escaped(language === 'ru' ? 'Пример данных · не текущая телеметрия' : 'Example data · not live telemetry'));
    expect(html).not.toMatch(/overlay-root|overlay-body|is-editing|latency-marker/);
  }
});

it.each(['en', 'ru'] as const)('keeps off and unavailable distinct in the example and its cruise badge (%s)', language => {
  for (const [cruise, value] of [['active', '90'], ['off', language === 'ru' ? 'ВЫКЛ' : 'OFF'], ['unavailable', '—']] as const) {
    const view = overlayView(overlayExample(DEFAULT_OVERLAY_SETTINGS, language, cruise));
    expect(view.items.find(item => item.id === 'cruise-control')).toMatchObject({value, unavailable: cruise === 'unavailable'});
    const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings: DEFAULT_OVERLAY_SETTINGS, language, cruise, scale: 1}));
    expect(html).toContain(`data-state="${cruise}" data-testid="overlay-preview-cruise"`);
    expect(html).toContain(`>${language === 'ru' ? 'Круиз' : 'Cruise'}: ${value}${cruise === 'active' ? language === 'ru' ? ' км/ч' : ' km/h' : ''}</span>`);
  }
});

it('localizes production-formatted example measurements without translating invented game names', () => {
  const view = overlayView(overlayExample(DEFAULT_OVERLAY_SETTINGS, 'ru', 'active'));
  expect(view.items.find(item => item.id === 'cargo')).toMatchObject({value: 'Machine parts', detail: '18 т'});
  expect(view.items.find(item => item.id === 'destination')?.value).toBe('Pinehaven');
  expect(view.items.find(item => item.id === 'deadline')?.value).toBe('8 ч 25 мин');
  expect(view.items.find(item => item.id === 'range')?.value).toBe('1820 км');
});

it('keeps the header cruise state when the cruise overlay section is hidden', () => {
  const settings = {...DEFAULT_OVERLAY_SETTINGS, sections: {...DEFAULT_OVERLAY_SETTINGS.sections, 'cruise-control': false}};
  for (const [cruise, label] of [['active', '90 km/h'], ['off', 'OFF'], ['unavailable', '—']] as const) {
    const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings, language: 'en', cruise, scale: 1}));
    expect(html).not.toContain('data-testid="overlay-section-cruise-control"');
    expect(html).toContain(`data-testid="overlay-preview-cruise">Cruise: ${label}</span>`);
  }
});

it.each([0.5, 1, 3])('contains all enabled rows at scale %s using the production zoom conversion', scale => {
  for (const layout of OVERLAY_LAYOUTS) for (const width of [220, 600, 1000]) {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, layout};
    const size = overlayPreviewSize(settings, scale, width);
    expect(size.width).toBeLessThanOrEqual(width + 0.001);
    expect(size.height).toBeGreaterThan(0);
    expect(size.width).toBeCloseTo(size.cssWidth * size.factor);
    expect(size.height).toBeCloseTo(size.cssHeight * size.factor);
    expect(size.factor).toBeLessThanOrEqual(scale * 0.7 + 0.000001);
    if (layout === 'strip') expect(size.cssHeight).toBeGreaterThanOrEqual(40);
    if (layout === 'card') expect(size.cssHeight).toBe(456);
  }
  const card = overlayPreviewSize({...DEFAULT_OVERLAY_SETTINGS, layout: 'card'}, scale, 1000);
  expect(card.factor).toBe(scale === 0.5 ? 0.35 : scale === 1 ? 0.7 : 2.1);
});

it('renders deterministic settings-only data and applies background opacity without accessing a desktop bridge', () => {
  vi.stubGlobal('window', undefined);
  try {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, backgroundOpacity: 43};
    const render = () => renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings, language: 'en', scale: 1.3}));
    expect(render()).toBe(render());
    expect(render()).toContain('--yu-ov-panel:rgba(11, 17, 32, 0.43)');
    expect(render()).toContain('data-scale="1.3"');
    expect(overlayExample(settings, 'en', 'active')).toMatchObject({origin: 'none', editing: false, speed: '84', fuel: '620'});
  } finally {vi.unstubAllGlobals();}
});
