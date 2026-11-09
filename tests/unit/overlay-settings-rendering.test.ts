import {DEFAULT_NOW_PLAYING} from '../../apps/desktop/src/now-playing/contract';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {OverlaySettingsCard} from '../../apps/desktop/src/overlay-settings-card';
import {DEFAULT_OVERLAY_SETTINGS, OVERLAY_PRESETS, OVERLAY_SECTION_IDS, OVERLAY_SECTION_REQUIREMENTS} from '../../apps/desktop/src/overlay-sections';
import {getOverlayRequirementText, getOverlaySectionText, getStrings} from '../../apps/desktop/src/strings';
import type {AppLanguage, OverlayEditState, SettingsView} from '../../packages/contracts/src';

// Substitute only shadcn primitives; the card's grouping, labels, guards and edit branches remain real.
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/button', () => ({Button: 'button'}));
vi.mock('@/components/ui/label', () => ({Label: 'label'}));
vi.mock('@/components/ui/radio-group', () => ({RadioGroup: 'fieldset', RadioGroupItem: 'button'}));
vi.mock('@/components/ui/slider', () => ({Slider: 'input'}));
vi.mock('@/components/ui/switch', () => ({Switch: ({checked, ...props}: {checked: boolean}) =>
  React.createElement('button', {...props, role: 'switch', 'aria-checked': checked})}));

const settings = (language: AppLanguage): SettingsView => ({nowPlaying: DEFAULT_NOW_PLAYING, language, autostart: false, theme: 'system', units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'automatic', ats: 'automatic'},
  overlay: DEFAULT_OVERLAY_SETTINGS, state: 'loaded', writable: true, saveError: null});
const render = (view: SettingsView, edit: OverlayEditState = {active: false}) => renderToStaticMarkup(React.createElement(OverlaySettingsCard,
  {settings: view, edit, onSaved: vi.fn(), onRequest: vi.fn(), showSaveError: true}));
const escaped = (text: string) => renderToStaticMarkup(React.createElement(React.Fragment, null, text));
const control = (html: string, id: string) => html.match(new RegExp('<[^>]*data-testid="' + id + '"[^>]*>'))?.[0] ?? '';

it.each(['en', 'ru'] as const)('renders every overlay control together with unique IDs and localized groups in %s', language => {
  const html = render(settings(language)), strings = getStrings(language);
  expect(html).not.toMatch(/<[^>]*\shidden(?:="[^"]*")?[\s>]/);
  expect(html).not.toContain('data-testid="overlay-requirement-');
  for (const id of ['overlay-settings', 'overlay-enabled', 'overlay-layout', 'overlay-opacity-value', 'overlay-placement', 'overlay-presets',
    ...['everything', 'job-focus', 'driving-only'].map(id => `overlay-preset-${id}`), ...OVERLAY_SECTION_IDS.map(id => `overlay-switch-${id}`)])
    expect(html.match(new RegExp('data-testid="' + id + '"', 'g')), id).toHaveLength(1);
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
  expect(new Set(ids).size).toBe(ids.length);
  for (const label of [strings.overlayEnabledLabel, strings.overlayLayoutLabel, strings.overlayPlacementLabel, strings.overlayPresetsLabel, strings.overlaySectionsLabel, strings.overlayHiddenNote])
    expect(html).toContain(escaped(label));
  // ET-053: presets are a labelled group inside the Sections block, before its grouped switches.
  const sectionsAt = html.indexOf('data-testid="overlay-sections"'), presetsAt = html.indexOf('data-testid="overlay-presets"');
  expect(sectionsAt).toBeGreaterThan(-1);
  expect(presetsAt).toBeGreaterThan(sectionsAt);
  expect(presetsAt).toBeLessThan(html.indexOf('data-testid="overlay-switch-'));
  expect(html).toContain('role="group" aria-labelledby="overlay-presets-label"');
  for (const id of Object.keys(OVERLAY_PRESETS)) expect(control(html, `overlay-preset-${id}`), id).toMatch(/aria-pressed="(true|false)"/);
  for (const id of OVERLAY_SECTION_IDS) {
    expect(html).toContain(`for="overlay-section-${id}"`);
    expect(html).toContain(escaped(getOverlaySectionText(id, language)));
    const requirement = OVERLAY_SECTION_REQUIREMENTS[id];
    if (requirement) expect(html).not.toContain(escaped(getOverlayRequirementText(requirement, language)));
  }
  expect(html).toContain('data-testid="overlay-sections-count"');
  expect(html).toContain(language === 'ru' ? 'показано 16 из 16' : 'shown 16 of 16');
  expect(html.match(/class="yu-layout-option" data-selected="true"/g)).toHaveLength(1);
  expect(html).toContain('data-testid="overlay-preview" data-layout="strip"');
});

it('keeps final-section and read-only guards on the unified controls', () => {
  const view = settings('en');
  view.overlay = {...view.overlay, sections: {...Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, false])), speed: true} as typeof view.overlay.sections};
  const single = render(view);
  expect(control(single, 'overlay-switch-speed')).toContain('disabled');
  expect(control(single, 'overlay-switch-rpm')).not.toContain('disabled');
  expect(single).toContain('data-testid="overlay-last-section"');
  expect(single).toContain('shown 1 of 16');
  const locked = render({...view, writable: false});
  for (const id of ['overlay-enabled', 'overlay-edit-start', ...OVERLAY_SECTION_IDS.map(id => `overlay-switch-${id}`),
    ...Object.keys(OVERLAY_PRESETS).map(id => `overlay-preset-${id}`), 'overlay-layout']) expect(control(locked, id), id).toContain('disabled');
  expect(control(render({...view, overlay: {...view.overlay, enabled: false}}), 'overlay-edit-start')).toContain('disabled');
});

it('always shows saved size and disabled draft actions until Move starts the explicit edit session', () => {
  const view = settings('en');
  view.overlay = {...view.overlay, layout: 'card', placements: {...view.overlay.placements, card: {x: 1, y: 0, scale: 1.4}}};
  const html = render(view);
  expect(html).toContain('data-testid="overlay-saved-scale">Scale: 140%');
  expect(html).toContain('data-testid="overlay-preview" data-layout="card" data-scale="1.4"');
  for (const id of ['overlay-scale-down', 'overlay-scale-up', 'overlay-placement-reset']) expect(control(html, id)).toContain('disabled');
  expect(html).toContain('Choose Move overlay to change size. Reset restores position and size.');
  expect(html).not.toContain('data-testid="overlay-edit-scale"');
});

it.each([0.5, 3])('shows main-owned draft scale %s in the row and preview with range guards', scale => {
  const html = render(settings('en'), {active: true, layout: 'strip', scale, placement: 'waiting-for-game'});
  expect(html).toContain(`data-testid="overlay-edit-scale">Scale: ${scale * 100}%`);
  expect(html).toContain(`data-testid="overlay-preview" data-layout="strip" data-scale="${scale}"`);
  expect(control(html, 'overlay-scale-down').includes('disabled')).toBe(scale === 0.5);
  expect(control(html, 'overlay-scale-up').includes('disabled')).toBe(scale === 3);
  expect(html).not.toContain('data-testid="overlay-saved-scale"');
});

it('shows draft controls and locks layout while presets and sections remain available during edit', () => {
  const html = render(settings('ru'), {active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'});
  expect(control(html, 'overlay-layout')).toContain('disabled');
  expect(html).not.toContain('data-testid="overlay-edit-start"');
  for (const id of ['overlay-scale-down', 'overlay-scale-up', 'overlay-placement-reset', 'overlay-edit-done', 'overlay-edit-cancel',
    'overlay-preset-everything', 'overlay-switch-cargo']) expect(control(html, id), id).not.toContain('disabled');
});

it.each(['en', 'ru'] as const)('associates the size actions with the current idle/edit instructions (%s)', language => {
  const strings = getStrings(language), idle = render(settings(language));
  const editing = render(settings(language), {active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'});
  for (const [html, current, stale] of [[idle, strings.overlaySizeHelp, strings.overlaySizeEditingHelp], [editing, strings.overlaySizeEditingHelp, strings.overlaySizeHelp]]) {
    expect(html).toContain(`id="overlay-size-help" class="yu-overlay-row-hint">${escaped(current)}</p>`);
    expect(html).not.toContain(escaped(stale));
    expect(html.match(/id="overlay-size-help"/g)).toHaveLength(1);
    expect(html).toContain('aria-describedby="overlay-size-help"');
  }
});

// ET-082: the layout thumbnails keep the held-dark look of the T6 board.
it('renders the layout thumbnails in the dark token scope', () => {
  const html = render(settings('en'));
  expect(html.match(/yu-layout-preview-[a-z]+ yu-theme-dark/g)).toHaveLength(4);
});
