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
