import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {OverlayContent} from '../../apps/desktop/src/overlay-renderer';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {LiveDashboard} from '../../apps/desktop/src/live-dashboard';
import {smokeV0} from '../shared/live-v1-fixtures';
import type {OverlayPresentation} from '../../packages/contracts/src';
// Only the surrounding shadcn containers are substituted; the real SVG and text render unchanged.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/badge', () => ({Badge: 'span'}));
const base: OverlayPresentation = {source: 'ETS2', origin: 'synthetic', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L',
  freshness: 'current', layout: 'strip', paused: false, editing: false, sections: [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'fuel', state: 'value', text: '73.0 L'}]};
it.each(['strip', 'card', 'cluster', 'hud'] as const)('renders sparse/populated %s inside one display anchor at top/centre/bottom', layout => {
  for (const sections of [[], base.sections]) for (const y of [0, 0.5, 1]) {
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, sections, contentAnchorY: y})}));
    expect(html.match(/data-testid="overlay-content"/g)).toHaveLength(1);
    expect(html).toContain('top:' + y * 100 + '%'); expect(html).toContain('transform:translateY(-' + y * 100 + '%)');
    expect(html).not.toContain('latency-marker');
  }
});
it.each(['en', 'ru'] as const)('renders exactly one visible speed number/unit and a localized gauge image name in %s', language => {
  const live = smokeV0(); live.observation!.state.speed = {available: true, value: 25, unit: 'm/s'};
  const html = renderToStaticMarkup(React.createElement(LiveDashboard, {live, units: {ets2: 'metric', ats: 'metric'}, language}));
  expect(html).not.toContain('data-testid="speed"');
  for (const id of ['live-speed-number', 'live-speed-unit', 'live-speed-gauge']) expect(html.match(new RegExp('data-testid="' + id + '"', 'g'))).toHaveLength(1);
  expect(html).toContain('data-testid="live-speed-number">90</text>');
  expect(html).toContain(language === 'en' ? 'aria-label="Speed: 90 km/h; Engine RPM:' : 'aria-label="Скорость: 90 км/ч; Обороты:');
  live.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  const missing = renderToStaticMarkup(React.createElement(LiveDashboard, {live, units: undefined, language}));
  expect(missing).toContain(language === 'en' ? 'aria-label="Speed: unavailable;' : 'aria-label="Скорость: недоступно;');
});

// ET-045d: the strip's stable widths come from data-reserve on the value element, while the value's text stays exactly the
// number (the reserve is CSS content); the RPM unit is its own element, and the cluster gauge marks its RPM track.
it.each(['en', 'ru'] as const)('renders reserves beside exact value texts and a separate RPM unit in %s', language => {
  const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '9 km/h'}, {id: 'gear', state: 'value', text: 'N'},
    {id: 'rpm', state: 'value', text: '999 rpm', ring: 0.333}, {id: 'fuel', state: 'value', text: '73.0 L'}];
  const unit = language === 'en' ? 'rpm' : 'об/мин';
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, speed: '9', sections})}));
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-speed" data-reserve="000">9</strong>');
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-gear" data-reserve="R0">N</strong>');
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-rpm" data-reserve="0000">999</strong>');
    expect(html, layout).toContain(`<span class="overlay-unit" data-testid="overlay-rpm-unit">${unit}</span>`);
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-fuel">73.0</strong>');
    expect(html.match(/data-reserve=/g), layout).toHaveLength(3);
  }
  const cluster = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout: 'cluster', language, speed: '9', sections})}));
  expect(cluster).toContain('data-testid="overlay-rpm-track"');
  const centre = /<div class="overlay-gauge-centre">(.*?)<\/div><\/div><div class="overlay-surface overlay-panel">/.exec(cluster)?.[1] ?? '';
  expect([...centre.matchAll(/<div class="(overlay-gauge-[a-z]+)" data-testid="(overlay-section-[a-z]+)"/g)].map(match => [match[1], match[2]]))
    .toEqual([['overlay-gauge-speed', 'overlay-section-speed'], ['overlay-gauge-gear', 'overlay-section-gear'], ['overlay-gauge-rpm', 'overlay-section-rpm']]);
  const speedOnly = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout: 'cluster', language, speed: '9', sections: sections.slice(0, 1)})}));
  expect(speedOnly).toContain('data-testid="overlay-speed-track"'); expect(speedOnly).not.toContain('overlay-rpm-track');
});

it.each(['strip', 'card', 'cluster', 'hud'] as const)('applies saved alpha only to background tokens in %s', layout => {
  for (const backgroundOpacity of [40, 65, 80, 100]) {
    const view = overlayView({...base, layout, backgroundOpacity});
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view}));
    expect(html).toContain(`--yu-ov-panel:rgba(11, 17, 32, ${backgroundOpacity / 100})`);
    expect(html).not.toContain('opacity:');
    expect(html).toContain('data-testid="overlay-speed"');
    expect(view.contentAnchorY).toBe(layout === 'cluster' ? 1 : 0);
  }
  for (const backgroundOpacity of [undefined, 39, 101, NaN, 60.5])
    expect(overlayView({...base, layout, backgroundOpacity}).backgroundOpacity).toBe(80);
});
