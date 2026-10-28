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

const settings = (language: AppLanguage): SettingsView => ({language, autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'automatic', ats: 'automatic'},
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
});

it('keeps final-section and read-only guards on the unified controls', () => {
  const view = settings('en');
  view.overlay = {...view.overlay, sections: {...Object.fromEntries(OVERLAY_SECTION_IDS.map(id => [id, false])), speed: true} as typeof view.overlay.sections};
  const single = render(view);
  expect(control(single, 'overlay-switch-speed')).toContain('disabled');
  expect(control(single, 'overlay-switch-rpm')).not.toContain('disabled');
  expect(single).toContain('data-testid="overlay-last-section"');
  const locked = render({...view, writable: false});
  for (const id of ['overlay-enabled', 'overlay-edit-start', ...OVERLAY_SECTION_IDS.map(id => `overlay-switch-${id}`),
    ...Object.keys(OVERLAY_PRESETS).map(id => `overlay-preset-${id}`), 'overlay-layout']) expect(control(locked, id), id).toContain('disabled');
  expect(control(render({...view, overlay: {...view.overlay, enabled: false}}), 'overlay-edit-start')).toContain('disabled');
});

it('shows draft controls and locks layout while presets and sections remain available during edit', () => {
  const html = render(settings('ru'), {active: true, layout: 'strip', scale: 1, placement: 'waiting-for-game'});
  expect(control(html, 'overlay-layout')).toContain('disabled');
  expect(html).not.toContain('data-testid="overlay-edit-start"');
  for (const id of ['overlay-scale-down', 'overlay-scale-up', 'overlay-placement-reset', 'overlay-edit-done', 'overlay-edit-cancel',
    'overlay-preset-everything', 'overlay-switch-cargo']) expect(control(html, id), id).not.toContain('disabled');
});
