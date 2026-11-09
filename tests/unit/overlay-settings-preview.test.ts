import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {OverlaySectionId} from '../../packages/contracts/src';
import {OverlaySettingsPreview} from '../../apps/desktop/src/overlay-settings-preview';
import {overlayExample, overlayPreviewSize} from '../../apps/desktop/src/overlay-settings-preview-model';
import {DEFAULT_OVERLAY_SETTINGS, OVERLAY_LAYOUTS, OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {getOverlayLayoutText, getOverlaySectionText, getStrings} from '../../apps/desktop/src/strings';

vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));

const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const driving: OverlaySectionId[] = ['speed', 'gear', 'rpm', 'cruise-control', 'speed-limit', 'fuel', 'range'];

it.each(['en', 'ru'] as const)('shares enabled order, localized values and the fixed Hard Mode footer in every layout (%s)', language => {
  for (const layout of OVERLAY_LAYOUTS) {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, layout, sections: OVERLAY_PRESETS['driving-only']};
    const example = overlayExample(settings, language, 'active'), view = overlayView(example);
    expect(example.sections.map(section => section.id)).toEqual(driving);
    expect(view.items.map(item => item.id)).toEqual(driving);
    expect(view.items.map(item => item.label)).toEqual(driving.map(id => getOverlaySectionText(id, language)));
    expect(view.items[3]).toMatchObject({value: '90', unit: language === 'ru' ? 'км/ч' : 'km/h'});
    const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings, language, scale: 1}));
    expect(html).toContain(escaped(`${language === 'ru' ? 'Предпросмотр' : 'Preview'} · ${getOverlayLayoutText(layout, language)}`));
    for (const id of driving) expect(html.match(new RegExp(`data-testid="overlay-section-${id}"`, 'g')), id).toHaveLength(1);
    expect(html).not.toContain('data-testid="overlay-section-cargo"');
    expect(html.match(/data-testid="overlay-hard-mode"/g)).toHaveLength(1);
    expect(html.indexOf('data-testid="overlay-hard-mode"')).toBeGreaterThan(html.indexOf('data-testid="overlay-section-range"'));
    expect(html).toContain(escaped(language === 'ru' ? 'Пример данных · не текущая телеметрия' : 'Example data · not live telemetry'));
    expect(html).not.toMatch(/overlay-root|overlay-body|is-editing|latency-marker/);
  }
});

// ET-084: the example shows a 90 km/h sign, the fixed circle of the ETS2 example, so the preview draws the real sign.
it.each(['en', 'ru'] as const)('shows the speed limit sign in the example in every layout (%s)', language => {
  for (const layout of OVERLAY_LAYOUTS) {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, layout};
    expect(overlayView(overlayExample(settings, language, 'active')).items.find(item => item.id === 'speed-limit'), layout).toMatchObject({value: '90', unit: language === 'ru' ? 'км/ч' : 'km/h',
      sign: {shape: 'circle', state: 'limit', number: '90', digits: 2, name: language === 'ru' ? 'Ограничение скорости: 90 км/ч' : 'Speed limit: 90 km/h'}});
    const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings, language, scale: 1}));
    expect(html.match(/data-testid="overlay-section-speed-limit"/g), layout).toHaveLength(1);
    if (layout === 'hud') expect(html, layout).toContain('class="overlay-sign-glyph" data-shape="circle" data-state="limit"');
    else expect(html, layout).toContain(`class="overlay-sign overlay-sign-${layout}" data-shape="circle" data-state="limit" data-digits="2"`);
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

it.each(['en', 'ru'] as const)('names the preview as one example image before its layout/cruise state and hides visual metrics (%s)', language => {
  const html = renderToStaticMarkup(React.createElement(OverlaySettingsPreview, {settings: DEFAULT_OVERLAY_SETTINGS, language, scale: 1}));
  const image = html.match(/<div[^>]*data-testid="overlay-preview-card"[^>]*>/)?.[0] ?? '';
  expect(image).toContain('role="img"');
  const labelIds = /aria-labelledby="([^"]+)"/.exec(image)?.[1].split(' ') ?? [];
  expect(labelIds).toHaveLength(3);
  const names = labelIds.map(id => new RegExp(`id="${id}"[^>]*>([^<]+)<`).exec(html)?.[1]);
  const strings = getStrings(language);
  expect(names).toEqual([escaped(strings.overlayPreviewExample), escaped(`${strings.overlayPreviewTitle} · ${getOverlayLayoutText('strip', language)}`),
    `${strings.overlayPreviewCruise}: 90 ${language === 'ru' ? 'км/ч' : 'km/h'}`]);
  const visual = html.match(/<div[^>]*class="yu-overlay-preview-space"[^>]*>/)?.[0] ?? '';
  expect(visual).toContain('aria-hidden="true"');
  expect(html.indexOf(visual)).toBeLessThan(html.indexOf('data-testid="overlay-content"'));
  expect(html).not.toContain('aria-live=');
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
    // ET-082: the preview scene carries the dark token scope, so it stays dark in the light theme.
    expect(render()).toMatch(/class="yu-overlay-scene yu-theme-dark" data-testid="overlay-preview-scene"/);
    expect(overlayExample(settings, 'en', 'active')).toMatchObject({origin: 'none', editing: false, speed: '84', fuel: '620'});
  } finally {vi.unstubAllGlobals();}
});
