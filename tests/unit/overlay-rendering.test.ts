import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {OverlayContent} from '../../apps/desktop/src/overlay-renderer';
import {OverlayContent as PureOverlayContent} from '../../apps/desktop/src/overlay-content';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {LiveDashboard} from '../../apps/desktop/src/live-dashboard';
import {smokeV0} from '../shared/live-v1-fixtures';
import type {OverlayHardMode, OverlayPresentation, OverlaySectionId} from '../../packages/contracts/src';
import {OVERLAY_PRESETS, OVERLAY_SECTION_IDS} from '../../apps/desktop/src/overlay-sections';
// Only the surrounding shadcn containers are substituted; the real SVG and text render unchanged.
vi.mock('@/components/ui/button', () => ({Button: 'button'}));
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/badge', () => ({Badge: 'span'}));
const base: OverlayPresentation = {source: 'ETS2', origin: 'synthetic', status: 'connected', speed: '90', speedUnit: 'km/h', fuel: '73.0', fuelUnit: 'L',
  freshness: 'current', layout: 'strip', paused: false, editing: false, sections: [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'fuel', state: 'value', text: '73.0 L'}]};
it('retains the runtime export as the shared display-only component', () => {expect(OverlayContent).toBe(PureOverlayContent);});
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
// ET-050 (GD6): the gear reserve requirement changed to the mode-independent multi-line 'R0\n0H\n0L'.
// ET-050b (B8): the requirement changed again; the reserve adds the crawler labels, 'R0\n0H\n0L\nLH\nLL'.
// ET-050b ETS2 crawler amendment (October 26, 2026): it changed once more, adding the ETS2 crawler labels C1 and C2.
it.each(['en', 'ru'] as const)('renders reserves beside exact value texts and a separate RPM unit in %s', language => {
  const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '9 km/h'}, {id: 'gear', state: 'value', text: 'N'},
    {id: 'rpm', state: 'value', text: '999 rpm', ring: 0.333}, {id: 'fuel', state: 'value', text: '73.0 L'}];
  const unit = language === 'en' ? 'rpm' : 'об/мин';
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, speed: '9', sections})}));
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-speed" data-reserve="000">9</strong>');
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-gear" data-reserve="R0\n0H\n0L\nLH\nLL\nC1\nC2">N</strong>');
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-rpm" data-reserve="0000">999</strong>');
    expect(html, layout).toContain(`<span class="overlay-unit" data-testid="overlay-rpm-unit">${unit}</span>`);
    expect(html, layout).toContain('<strong class="overlay-value" data-testid="overlay-fuel">73.0</strong>');
    expect(html.match(/data-reserve=/g), layout).toHaveLength(3);
  }
  const cluster = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout: 'cluster', language, speed: '9', sections})}));
  expect(cluster).toContain('data-testid="overlay-rpm-track"');
  // ET-050: [\s\S] because the gear's multi-line reserve attribute puts newlines inside the centre's markup.
  const centre = /<div class="overlay-gauge-centre">([\s\S]*?)<\/div><\/div><div class="overlay-surface overlay-panel">/.exec(cluster)?.[1] ?? '';
  expect([...centre.matchAll(/<div class="(overlay-gauge-[a-z]+)" data-testid="(overlay-section-[a-z]+)"/g)].map(match => [match[1], match[2]]))
    .toEqual([['overlay-gauge-speed', 'overlay-section-speed'], ['overlay-gauge-gear', 'overlay-section-gear'], ['overlay-gauge-rpm', 'overlay-section-rpm']]);
  const speedOnly = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout: 'cluster', language, speed: '9', sections: sections.slice(0, 1)})}));
  expect(speedOnly).toContain('data-testid="overlay-speed-track"'); expect(speedOnly).not.toContain('overlay-rpm-track');
});

// ET-050: manual gear text reaches every layout unchanged in both languages, with the same mode-independent reserve.
it.each(['en', 'ru'] as const)('renders manual gear labels exactly in every layout in %s', language => {
  // ET-050b: the gearbox-aware crawler labels reach every layout the same way.
  for (const text of ['1L', '1H', '8H', '9H', 'R1', 'N', 'LL', 'LH', 'L', 'C1', 'C2', 'C']) {
    const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '9 km/h'}, {id: 'gear', state: 'value', text}];
    for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
      const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, speed: '9', sections})}));
      expect(html, `${layout} ${text}`).toContain(`<strong class="overlay-value" data-testid="overlay-gear" data-reserve="R0\n0H\n0L\nLH\nLL\nC1\nC2">${text}</strong>`);
    }
  }
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

// ET-045f: the Cluster's speed arc on the outer track (r 52) from 12 o'clock clockwise; its dash offset is the unfilled part
// of the circumference 2π × 52, so a fraction of 0.5 leaves half of it. No arc at 0, without a fraction or while the speed is
// unavailable; the RPM arc keeps its static markup, and the other layouts draw no speed arc.
const SPEED_C = 2 * Math.PI * 52, RPM_C = 2 * Math.PI * 40;
const arcSections = (speedRing?: number): OverlayPresentation['sections'] => [{id: 'speed', state: 'value', text: '90 km/h', ...(speedRing === undefined ? {} : {speedRing})},
  {id: 'rpm', state: 'value', text: '1500 rpm', ring: 0.5}, {id: 'fuel', state: 'value', text: '73.0 L'}];
const renderView = (presentation: OverlayPresentation) => renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView(presentation)}));
it('renders the Cluster speed arc on the outer track only for a positive fraction, before the RPM ring', () => {
  const html = renderView({...base, layout: 'cluster', sections: arcSections(0.5)});
  expect(html.match(/data-testid="overlay-speed-arc"/g)).toHaveLength(1);
  expect(html).toContain(`<circle class="overlay-speed-arc" data-testid="overlay-speed-arc" cx="60" cy="60" r="52" transform="rotate(-90 60 60)" stroke-dasharray="${String(SPEED_C)} ${String(SPEED_C)}" style="stroke-dashoffset:${String(SPEED_C * 0.5)}"></circle>`);
  expect(html).toContain(`<circle class="overlay-ring-value" data-testid="overlay-rpm-arc" cx="60" cy="60" r="40" transform="rotate(-90 60 60)" stroke-dasharray="${String(0.5 * RPM_C)} ${String(RPM_C)}"></circle>`);
  const order = ['overlay-speed-track', 'overlay-speed-arc', 'overlay-rpm-track', 'overlay-rpm-arc'].map(id => html.indexOf(`data-testid="${id}"`));
  expect(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]))).toBe(true);
  for (const presentation of [{...base, layout: 'cluster' as const, sections: arcSections(0)}, {...base, layout: 'cluster' as const, sections: arcSections()},
    {...base, layout: 'cluster' as const, freshness: 'stale' as const, speed: '—', sections: [{id: 'speed' as const, state: 'unavailable' as const}, ...arcSections().slice(1)]}]) {
    const without = renderView(presentation);
    expect(without).not.toContain('overlay-speed-arc');
    expect(without).toContain('data-testid="overlay-speed-track"');
  }
  for (const layout of ['strip', 'card', 'hud'] as const) expect(renderView({...base, layout, sections: arcSections(0.5)}), layout).not.toContain('overlay-speed-arc');
});
it('eases only the speed arc over 150 ms, not under reduced motion, and colours the RPM arc with its own token', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8'), tokens = readFileSync('apps/desktop/src/shell/overlay-tokens.css', 'utf8');
  expect(css).toMatch(/\.overlay-speed-arc \{[^}]*stroke: var\(--yu-ov-accent\);[^}]*transition: stroke-dashoffset 150ms linear;[^}]*\}/);
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{ \.overlay-speed-arc \{ transition: none; \} \}/);
  expect(css.match(/transition\s*:/g)).toHaveLength(2);
  expect(css).toMatch(/\.overlay-ring-value \{[^}]*stroke: var\(--yu-ov-rpm\);/);
  expect(tokens).toMatch(/--yu-ov-rpm: #2563EB;/);
  expect(tokens).toMatch(/--yu-ov-accent: #60A5FA;/);
});

// ET-052 (MB8, MB10): the next mandatory break in every layout. The icon is the lucide coffee cup, the strip item is capped at
// 150 px and reserves the width of the longest text through data-reserve, and the urgency has a cue beyond colour only in part (due is underlined; soon has the accessible name):
// data-urgency and an accessible name with the state word on the item, in both languages. Colours and the underline are
// stylesheet rules (overlay-strip.test.ts reads them).
const breakSections = (patch: object): OverlayPresentation['sections'] => [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'mandatory-break', state: 'value', text: '1 h 35 min', ...patch}] as OverlayPresentation['sections'];
it.each([
  ['en', 'soon', 'Break: 1 h 35 min, soon', 'Next mandatory break: 1 h 35 min, soon', '00 h 00 min'],
  ['en', 'due', 'Break: 1 h 35 min, due now', 'Next mandatory break: 1 h 35 min, due now', '00 h 00 min'],
  ['ru', 'soon', 'Перерыв: 1 ч 35 мин, скоро', 'До обязательного перерыва: 1 ч 35 мин, скоро', '00 ч 00 мин'],
  ['ru', 'due', 'Перерыв: 1 ч 35 мин, пора', 'До обязательного перерыва: 1 ч 35 мин, пора', '00 ч 00 мин']
] as const)('renders the break item with its icon, reserve, state word and urgency in %s (%s)', (language, urgency, shortName, fullName, reserve) => {
  const render = (layout: 'strip' | 'card' | 'cluster' | 'hud') => renderToStaticMarkup(React.createElement(OverlayContent,
    {view: overlayView({...base, layout, language, sections: breakSections({urgency})})}));
  const strip = render('strip');
  expect(strip).toContain(`data-testid="overlay-section-mandatory-break" aria-label="${shortName}" data-urgency="${urgency}" style="max-width:150px"`);
  expect(strip).toContain(`<strong class="overlay-value" data-testid="overlay-mandatory-break" data-reserve="${reserve}">${language === 'en' ? '1 h 35 min' : '1 ч 35 мин'}</strong>`);
  expect(strip.match(/lucide-coffee/g)).toHaveLength(1);
  expect(render('card')).toContain(`class="overlay-row" data-testid="overlay-section-mandatory-break" data-urgency="${urgency}" aria-label="${fullName}"`);
  expect(render('cluster')).toContain(`class="overlay-panel-row" data-testid="overlay-section-mandatory-break" data-urgency="${urgency}" aria-label="${shortName}"`);
  expect(render('hud')).toContain(`class="overlay-hud-line" data-testid="overlay-section-mandatory-break" data-urgency="${urgency}" aria-label="${shortName}"`);
});
it('adds no urgency marks to a normal or unavailable break, nor to any other section', () => {
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
    for (const sections of [breakSections({}), [{id: 'speed', state: 'value', text: '90 km/h'}, {id: 'mandatory-break', state: 'unavailable'}] as OverlayPresentation['sections']]) {
      const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, sections})}));
      expect(html, layout).not.toContain('data-urgency');
      expect(html, layout).toContain('data-testid="overlay-mandatory-break"');
    }
  }
  // A dash keeps the reserve and shows the dash text only.
  const dash = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, sections: [{id: 'mandatory-break', state: 'unavailable'}]})}));
  expect(dash).toContain('<strong class="overlay-value" data-testid="overlay-mandatory-break" data-reserve="00 h 00 min">—</strong>');
});

// ET-071: cruise control in every layout with the lucide CircleGauge, a three-digit reserve like speed, and in the strip a
// strip sizing matching speed with a 140 px cap. The texts are
// hand-written from strings.ts: a set speed splits into number and unit, OFF is localized and the dash has no unit.
const CRUISE_STATES: {section: OverlayPresentation['sections'][number]; en: {value: string; unit?: string}; ru: {value: string; unit?: string}}[] = [
  {section: {id: 'cruise-control', state: 'value', text: '90 km/h'}, en: {value: '90', unit: 'km/h'}, ru: {value: '90', unit: 'км/ч'}},
  {section: {id: 'cruise-control', state: 'value', text: 'off'}, en: {value: 'OFF'}, ru: {value: 'ВЫКЛ'}},
  {section: {id: 'cruise-control', state: 'unavailable'}, en: {value: '—'}, ru: {value: '—'}}
];
const CRUISE_LABELS = {en: {short: 'Cruise', label: 'Cruise control'}, ru: {short: 'Круиз', label: 'Круиз-контроль'}} as const;
it.each(['en', 'ru'] as const)('renders cruise control with its icon, reserve and a content-sized strip item in every state and layout in %s', language => {
  const labels = CRUISE_LABELS[language];
  for (const expected of CRUISE_STATES) {
    const sections: OverlayPresentation['sections'] = [{id: 'speed', state: 'value', text: '90 km/h'}, expected.section, {id: 'fuel', state: 'value', text: '73.0 L'}];
    const text = expected[language];
    for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
      const label = `${layout} ${language} ${text.value}`;
      const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, sections})}));
      expect(html.match(/data-testid="overlay-section-cruise-control"/g), label).toHaveLength(1);
      expect(html.match(/lucide-circle-gauge/g), label).toHaveLength(1);
      expect(html, label).toContain(`<strong class="overlay-value" data-testid="overlay-cruise-control" data-reserve="000">${text.value}</strong>`);
      if (text.unit) expect(html, label).toContain(`<span class="overlay-unit" data-testid="overlay-cruise-control-unit">${text.unit}</span>`);
      else expect(html, label).not.toContain('overlay-cruise-control-unit');
      expect(html, label).not.toContain('min-width');
      if (layout === 'strip') {
        expect(html, label).toContain(`data-testid="overlay-section-cruise-control" aria-label="${labels.short}" style="max-width:140px"`);
        expect(html, label).toContain('data-testid="overlay-section-speed" aria-label="' + (language === 'en' ? 'Speed' : 'Скорость') + '" style="max-width:140px"');
      } else {
        expect(html, label).toContain(layout === 'card' ? `</svg>${labels.label}</dt>` : layout === 'cluster' ? `</svg>${labels.short}</span>` : `<span class="overlay-label">${labels.short}</span>`);
      }
    }
  }
});

it.each(['en', 'ru'] as const)('renders explicit simultaneous game choices as semantic buttons in %s', language => {
  const html = renderToStaticMarkup(React.createElement(LiveDashboard, {live: {selection: 'game', status: 'waiting', fresh: false, recording: false, coverage: 'unknown',
    reason: 'Both games are available; choose ETS2 or ATS'}, units: undefined, language, onSelect: () => Promise.resolve()}));
  expect(html).toContain('data-testid="live-game-choice"');
  expect(html).toContain('<button type="button"');
  expect(html).toContain('data-testid="live-choose-ets2"'); expect(html).toContain('Euro Truck Simulator 2</button>');
  expect(html).toContain('data-testid="live-choose-ats"'); expect(html).toContain('American Truck Simulator</button>');
  expect(html).toContain(language === 'ru' ? 'Доступны обе игры. Выберите игру для подключения.' : 'Both games are available. Choose which game to connect to.');
});

// ET-070 (D1-D4, REG-016): the fixed Hard Mode indicator in every layout: exactly one, always last, never a section, with
// its state, accessible name, lucide Flame, a 14 px cue slot that is present in every state (Check, X or empty) and, in the
// strip and HUD, "HM" struck through on a loss. The texts are hand-written from strings.ts.
const enabled = (preset: keyof typeof OVERLAY_PRESETS) => OVERLAY_SECTION_IDS.filter(id => OVERLAY_PRESETS[preset][id]);
const SECTION_SETS: [string, readonly OverlaySectionId[]][] = [['every section', OVERLAY_SECTION_IDS], ['driving-only', enabled('driving-only')],
  ['job-focus', enabled('job-focus')], ['speed only', ['speed']], ['fuel only', ['fuel']], ['gauge only', ['speed', 'gear', 'rpm']]];
const HARD_MODE_STATES: {hardMode: OverlayHardMode; state: string; cue: string; en: {name: string; row: string}; ru: {name: string; row: string}}[] = [
  {hardMode: {state: 'active'}, state: 'active', cue: 'check', en: {name: 'Hard Mode active, 12 of 12', row: '12/12'}, ru: {name: 'Hard Mode активен, 12 из 12', row: '12/12'}},
  {hardMode: {state: 'inactive', passed: 11}, state: 'inactive', cue: 'none', en: {name: 'Hard Mode not active, 11 of 12', row: '11/12'}, ru: {name: 'Hard Mode не активен, 11 из 12', row: '11/12'}},
  {hardMode: {state: 'inactive'}, state: 'inactive', cue: 'none', en: {name: 'Hard Mode not active', row: ''}, ru: {name: 'Hard Mode не активен', row: ''}},
  {hardMode: {state: 'lost'}, state: 'lost', cue: 'cross', en: {name: 'Hard Mode lost for this trip', row: 'lost'}, ru: {name: 'Hard Mode потерян для этого рейса', row: 'потерян'}}
];
const CUE_ICON: Record<string, string | undefined> = {check: 'lucide-check', cross: 'lucide-x', none: undefined};
it.each(['strip', 'card', 'cluster', 'hud'] as const)('renders exactly one Hard Mode indicator last in the %s, for every section set, state and language', layout => {
  for (const [setName, ids] of SECTION_SETS) for (const language of ['en', 'ru'] as const) for (const expected of HARD_MODE_STATES) {
    const sections: OverlayPresentation['sections'] = ids.map(id => ({id, state: 'unavailable'}));
    const label = `${layout} ${setName} ${language} ${expected.en.name}`;
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, sections, hardMode: expected.hardMode})}));
    expect(html.match(/data-testid="overlay-hard-mode"/g), label).toHaveLength(1);
    expect(html.match(/data-testid="overlay-section-/g) ?? [], label).toHaveLength(ids.length);
    const text = expected[language];
    const start = html.indexOf(`data-testid="overlay-hard-mode" data-state="${expected.state}" aria-label="${text.name}"`);
    expect(start, label).toBeGreaterThan(-1);
    // Last: no section follows the indicator.
    expect(html.lastIndexOf('data-testid="overlay-section-'), label).toBeLessThan(start);
    const element = html.slice(html.lastIndexOf('<', start));
    expect(element, label).toContain('lucide-flame');
    expect(element, label).toContain(`<span class="overlay-hm-cue" data-cue="${expected.cue}" aria-hidden="true">`);
    const icon = CUE_ICON[expected.cue];
    if (icon) expect(element, label).toContain(icon);
    else expect(element, label).toContain('<span class="overlay-hm-cue" data-cue="none" aria-hidden="true"></span>');
    expect(element, label).not.toContain('data-reserve');
    const struck = expected.state === 'lost' && (layout === 'strip' || layout === 'hud');
    expect(element.includes('overlay-hm-struck'), label).toBe(struck);
    if (layout === 'strip') {
      expect(element, label).toMatch(/^<span class="overlay-item( overlay-group-start)? overlay-hard-mode" [^>]*style="max-width:100px">/);
      // A group divider precedes the indicator only when a section precedes it.
      expect(element.startsWith('<span class="overlay-item overlay-group-start'), label).toBe(ids.length > 0);
      expect(element, label).toContain(`<span class="overlay-value overlay-hm-text${struck ? ' overlay-hm-struck' : ''}">HM</span>`);
      expect(element, label).not.toContain('/12');
      expect(element, label).toMatch(/<\/span><\/span><\/div><\/div>$/);
    } else if (layout === 'hud') {
      expect(element, label).toMatch(/^<div class="overlay-hud-line overlay-hard-mode" /);
      expect(element, label).toContain(`<span class="overlay-label overlay-hm-text${struck ? ' overlay-hm-struck' : ''}">HM</span>`);
      // The HUD shows the count only while not active.
      const count = expected.state === 'inactive' ? text.row : '';
      if (count) expect(element, label).toContain(`<strong class="overlay-value">${count}</strong>`);
      else expect(element, label).not.toContain('class="overlay-value"');
    } else {
      expect(element, label).toMatch(layout === 'card' ? /^<div class="overlay-row overlay-hard-mode" / : /^<div class="overlay-panel-row overlay-hard-mode" /);
      expect(element, label).toContain('Hard Mode</' + (layout === 'card' ? 'dt>' : 'span>'));
      expect(element, label).toContain(`<strong class="overlay-value">${text.row}</strong>`);
      if (layout === 'card') expect(element, label).toMatch(/<\/dd><\/div><\/dl>/);
    }
  }
});
it('renders a missing Hard Mode field as not active in every layout', () => {
  for (const layout of ['strip', 'card', 'cluster', 'hud'] as const) {
    const html = renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout})}));
    expect(html, layout).toContain('data-testid="overlay-hard-mode" data-state="inactive" aria-label="Hard Mode not active"');
  }
});
it('colours the indicator per state with its own tokens, mirrored in the design tokens, without a transition', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8'), tokens = readFileSync('apps/desktop/src/shell/overlay-tokens.css', 'utf8');
  const design = readFileSync('docs/design/tokens.css', 'utf8');
  for (const [state, colour] of [['active', '#8FD3AE'], ['inactive', '#E8C58A'], ['lost', '#F87171']]) {
    expect(css).toContain(`.overlay-hard-mode[data-state="${state}"] { --yu-ov-hm: var(--yu-ov-hm-${state}); }`);
    expect(tokens).toContain(`--yu-ov-hm-${state}: ${colour};`); expect(design).toContain(`--yu-ov-hm-${state}: ${colour};`);
  }
  expect(css).toMatch(/\.overlay-hm-cue \{[^}]*width: 14px;[^}]*height: 14px;[^}]*\}/);
  expect(css).toMatch(/\.overlay-hm-struck \{ text-decoration: line-through; \}/);
});

// ET-084 (REG-009, REG-016): the speed limit road sign in every layout, sized only by its fixed box per layout and shape: the
// markup carries no size of its own, so a limit, no limit and no reading never move anything. The texts are hand-written from
// strings.ts and the plan's sign table.
type SignLayout = 'strip' | 'card' | 'cluster';
const SIGN_LAYOUTS: readonly SignLayout[] = ['strip', 'card', 'cluster'];
const limitSections = (text?: string): OverlayPresentation['sections'] => [{id: 'speed', state: 'value', text: '90 km/h'}, text === undefined ? {id: 'speed-limit', state: 'unavailable'} : {id: 'speed-limit', state: 'value', text}];
const signHtml = (layout: 'strip' | 'card' | 'cluster' | 'hud', source: string, sections: OverlayPresentation['sections'], language: 'en' | 'ru' = 'en') =>
  renderToStaticMarkup(React.createElement(OverlayContent, {view: overlayView({...base, layout, language, source, speedUnit: source === 'ATS' ? 'mph' : 'km/h', sections} as OverlayPresentation)}));
const SIGN_CASES = [
  {source: 'ETS2', text: '90 km/h', shape: 'circle', state: 'limit', digits: 2, number: '90', name: 'Speed limit: 90 km/h'},
  {source: 'ETS2', text: '120 km/h', shape: 'circle', state: 'limit', digits: 3, number: '120', name: 'Speed limit: 120 km/h'},
  {source: 'ETS2', text: 'none', shape: 'circle', state: 'no-limit', digits: 1, number: '—', name: 'Speed limit: no limit'},
  {source: 'ETS2', text: undefined, shape: 'circle', state: 'no-limit', digits: 1, number: '—', name: 'Speed limit: unavailable'},
  {source: 'ATS', text: '65 mph', shape: 'rectangle', state: 'limit', digits: 2, number: '65', name: 'Speed limit: 65 mph'},
  {source: 'ATS', text: 'none', shape: 'rectangle', state: 'no-limit', digits: 1, number: '—', name: 'Speed limit: no limit'},
  {source: 'ATS', text: undefined, shape: 'rectangle', state: 'no-limit', digits: 1, number: '—', name: 'Speed limit: unavailable'}
] as const;
it.each(SIGN_CASES)('renders the $source sign "$number" ($state) in the strip, card and cluster, with its name and no inline size', ({source, text, shape, state, digits, number, name}) => {
  for (const layout of SIGN_LAYOUTS) {
    const html = signHtml(layout, source, limitSections(text));
    expect(html.match(/data-testid="overlay-section-speed-limit"/g), layout).toHaveLength(1);
    expect(html, layout).toContain(`class="overlay-sign overlay-sign-${layout}" data-shape="${shape}" data-state="${state}" data-digits="${digits}"`);
    expect(html, layout).toContain(`<strong class="overlay-sign-number" data-testid="overlay-speed-limit">${number}</strong>`);
    expect(html, layout).toContain(`aria-label="${name}"`);
    // The box is the stylesheet's alone: no value can reach an inline size.
    expect(html, layout).not.toMatch(/class="overlay-sign [^>]*style=/);
    expect(html, layout).not.toContain('overlay-speed-limit-unit');
    // The words are sign art beside a number on the larger ATS signs only, hidden from assistive technology.
    const words = '<span class="overlay-sign-words" aria-hidden="true"><span>SPEED</span><span>LIMIT</span></span>';
    if (shape === 'rectangle' && state === 'limit' && layout !== 'strip') expect(html, layout).toContain(words);
    else expect(html, layout).not.toContain('overlay-sign-words');
    expect(html, layout).not.toContain('lucide-signpost');
  }
});
it('keeps the sign art untranslated and the accessible names localized in Russian', () => {
  const html = signHtml('card', 'ATS', limitSections('65 mph'), 'ru');
  expect(html).toContain('<span>SPEED</span><span>LIMIT</span>');
  expect(html).toContain('aria-label="Ограничение скорости: 65 миль/ч"');
  expect(signHtml('strip', 'ETS2', limitSections('none'), 'ru')).toContain('aria-label="Ограничение скорости: без ограничения"');
  expect(signHtml('cluster', 'ETS2', limitSections(), 'ru')).toContain('aria-label="Ограничение скорости: нет данных"');
});
it('reserves the strip sign its fixed 32 px slot in every state, and only the sign item has a minimum width', () => {
  for (const {source, text, name} of SIGN_CASES) {
    const html = signHtml('strip', source, limitSections(text));
    expect(html, name).toContain(`data-testid="overlay-section-speed-limit" aria-label="${name}" style="max-width:32px;min-width:32px"`);
    expect(html.match(/min-width/g), name).toHaveLength(1);
  }
  const both = signHtml('strip', 'ETS2', [{id: 'cruise-control', state: 'value', text: 'off'}, ...limitSections('90 km/h')]);
  expect(both.match(/min-width/g)).toHaveLength(1);
});
it.each([
  {sections: ['speed', 'gear', 'rpm'], height: 96, count: 3, withSpeed: true},
  {sections: ['speed', 'gear'], height: 74, count: 2, withSpeed: true},
  {sections: ['speed', 'rpm'], height: 74, count: 2, withSpeed: true},
  {sections: ['gear', 'rpm'], height: 74, count: 2, withSpeed: false},
  {sections: ['speed'], height: 74, count: 1, withSpeed: true},
  {sections: ['gear'], height: 74, count: 1, withSpeed: false},
  {sections: ['rpm'], height: 74, count: 1, withSpeed: false},
  {sections: [], height: 74, count: 0, withSpeed: false}
] as {sections: OverlaySectionId[]; height: number; count: number; withSpeed: boolean}[])('sizes the card hero $height px with the sign for $sections', ({sections, height, count, withSpeed}) => {
  const html = signHtml('card', 'ETS2', [...sections.map(id => ({id, state: 'unavailable' as const})), {id: 'speed-limit', state: 'value', text: '90 km/h'}]);
  expect(html).toContain(`class="overlay-card-hero" data-count="${count}" data-sign="true" data-speed="${withSpeed}" data-testid="overlay-card-hero" style="height:${height}px"`);
  expect(html).toContain('class="overlay-card-speed-limit" data-testid="overlay-section-speed-limit" aria-label="Speed limit: 90 km/h"');
  // The sign is not one of the card's rows.
  expect(html).not.toMatch(/class="overlay-row"[^>]*overlay-section-speed-limit/);
});
it('renders no hero and no data-sign for a card without the sign, and marks it false beside the parts', () => {
  expect(signHtml('card', 'ETS2', [{id: 'fuel', state: 'value', text: '73.0 L'}])).not.toContain('overlay-card-hero');
  expect(signHtml('card', 'ETS2', [{id: 'speed', state: 'value', text: '90 km/h'}])).toContain('data-count="1" data-sign="false" data-speed="true" data-testid="overlay-card-hero" style="height:24px"');
});
it('places the cluster sign in the gauge, and without a gauge section alone before the panel, never as a panel row', () => {
  const onGauge = signHtml('cluster', 'ETS2', limitSections('90 km/h'));
  expect(onGauge).toContain('class="overlay-cluster-sign" data-testid="overlay-section-speed-limit" aria-label="Speed limit: 90 km/h"');
  expect(onGauge.indexOf('class="overlay-gauge"')).toBeLessThan(onGauge.indexOf('class="overlay-cluster-sign"'));
  expect(onGauge.indexOf('class="overlay-cluster-sign"')).toBeLessThan(onGauge.indexOf('overlay-panel-tags'));
  const alone = signHtml('cluster', 'ATS', [{id: 'speed-limit', state: 'value', text: '65 mph'}, {id: 'fuel', state: 'value', text: '19.3 US gal'}]);
  expect(alone).not.toContain('class="overlay-gauge"');
  expect(alone).toMatch(/^.*class="overlay-cluster-body"><div class="overlay-cluster-sign" data-testid="overlay-section-speed-limit"/);
  expect(alone).not.toMatch(/class="overlay-panel-row"[^>]*overlay-section-speed-limit/);
});
it.each([
  ['ETS2', '90 km/h', 'circle', 'limit', '90', 'km/h', 'Speed limit: 90 km/h'],
  ['ATS', '65 mph', 'rectangle', 'limit', '65', 'mph', 'Speed limit: 65 mph'],
  ['ETS2', 'none', 'circle', 'no-limit', '—', undefined, 'Speed limit: no limit'],
  ['ATS', undefined, 'rectangle', 'no-limit', '—', undefined, 'Speed limit: unavailable']
] as const)('renders the %s %s HUD line with a CSS glyph in the icon place, the short label and the value', (source, text, shape, state, value, unit, name) => {
  const html = signHtml('hud', source, limitSections(text));
  expect(html).toContain(`class="overlay-hud-line" data-testid="overlay-section-speed-limit" aria-label="${name}"><span class="overlay-sign-glyph" data-shape="${shape}" data-state="${state}" aria-hidden="true"></span><span class="overlay-label">Limit</span>`);
  expect(html).toContain(`data-testid="overlay-speed-limit">${value}</strong>`);
  if (unit) expect(html).toContain(`<span class="overlay-unit" data-testid="overlay-speed-limit-unit">${unit}</span>`);
  else expect(html).not.toContain('overlay-speed-limit-unit');
  expect(html).not.toContain('class="overlay-sign ');
  expect(html).not.toContain('lucide-signpost');
});
it('fixes every sign box, border and font in the stylesheet per layout and shape, and dims and mirrors its tokens', () => {
  const css = readFileSync('apps/desktop/src/renderer.css', 'utf8'), tokens = readFileSync('apps/desktop/src/shell/overlay-tokens.css', 'utf8');
  const design = readFileSync('docs/design/tokens.css', 'utf8');
  for (const rule of [
    '.overlay-sign-strip[data-shape="circle"] {width:32px;height:32px;border-width:3.5px;font-size:14px}',
    '.overlay-sign-strip[data-shape="rectangle"] {width:26px;height:34px;border-width:1.5px;border-radius:3px;font-size:14px}',
    '.overlay-sign-strip[data-digits="3"] {font-size:12px}',
    '.overlay-sign-card[data-shape="circle"] {width:72px;height:72px;border-width:9px;font-size:30px}',
    '.overlay-sign-card[data-shape="rectangle"] {width:58px;height:72px;border-width:2px;border-radius:6px;font-size:30px;gap:3px}',
    '.overlay-sign-card[data-digits="3"] {font-size:25px}',
    '.overlay-sign-card .overlay-sign-words {font-size:9px}',
    '.overlay-sign-cluster[data-shape="circle"] {width:56px;height:56px;border-width:6px;font-size:22px}',
    '.overlay-sign-cluster[data-shape="rectangle"] {width:46px;height:58px;border-width:1.5px;border-radius:5px;font-size:22px;gap:2px}',
    '.overlay-sign-cluster[data-digits="3"] {font-size:18px}',
    '.overlay-sign-cluster .overlay-sign-words {font-size:7.5px}',
    '.overlay-sign[data-state="no-limit"] {background:var(--yu-ov-sign-none-face);border:2px dashed var(--yu-ov-sign-none-border);box-shadow:none;color:var(--yu-ov-sign-none-dash)}',
    '.overlay-gauge>.overlay-cluster-sign {position:absolute;left:0;top:0}',
    '.overlay-cluster-body>.overlay-cluster-sign {flex:none;display:flex;align-items:flex-end;justify-content:center;width:58px;height:60px}',
    '.overlay-sign-glyph {box-sizing:border-box;flex:none;width:14px;height:14px;background:var(--yu-ov-sign-face)}',
    '.overlay-card-hero[data-sign="true"] {grid-template-columns:minmax(0,1.2fr) minmax(0,1fr) 74px}',
    '.overlay-card-hero[data-sign="true"][data-speed="false"],.overlay-card-hero[data-sign="true"][data-count="1"],.overlay-card-hero[data-sign="true"][data-count="0"] {grid-template-columns:minmax(0,1fr) 74px}',
    '.overlay.is-dim .overlay-ring, .overlay.is-dim .overlay-sign, .overlay.is-dim .overlay-sign-glyph { opacity: .5; }'
  ]) expect(css, rule).toContain(rule);
  // Every box clips a longer number instead of growing with it.
  expect(css).toMatch(/\.overlay-sign \{[^}]*overflow:hidden;[^}]*white-space:nowrap\}/);
  for (const [name, value] of [['--yu-ov-sign-red', '#D32F2F'], ['--yu-ov-sign-ink', '#111827'], ['--yu-ov-sign-face', '#FFFFFF'], ['--yu-ov-sign-shadow', 'rgba(11, 17, 32, 0.55)'],
    ['--yu-ov-sign-none-face', 'rgba(11, 17, 32, 0.35)'], ['--yu-ov-sign-none-border', 'rgba(209, 213, 219, 0.5)'], ['--yu-ov-sign-none-dash', 'rgba(209, 213, 219, 0.72)']]) {
    expect(tokens, name).toContain(`${name}: ${value};`); expect(design, name).toContain(`${name}: ${value};`);
  }
});
