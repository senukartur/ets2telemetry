import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import {InfoHint} from '../../apps/desktop/src/info-hint';
import {HardModeCard} from '../../apps/desktop/src/hard-mode/card';
import {evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

// ET-057: the Info-icon hint and the Hard Mode grid that uses it. Only the shadcn primitives the card imports are
// substituted; the Radix tooltip stays real, so a closed tooltip renders no content. Expected texts are hand-written.
vi.mock('../../apps/desktop/src/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('../../apps/desktop/src/components/ui/button', () => ({Button: 'button'}));
vi.mock('../../apps/desktop/src/components/ui/badge', () => ({Badge: 'span'}));

const hint = (props: {id?: string} = {}) =>
  renderToStaticMarkup(React.createElement(InfoHint, {label: 'More about: Range', testId: 'range-help', children: "The game's estimate.", ...props}));

it('names its button and describes it by the hidden text that stays in the document', () => {
  const html = hint();
  const describedBy = /<button[^>]*aria-describedby="([^"]+)"/.exec(html)?.[1];
  expect(html).toMatch(/<button type="button" class="yu-info-hint" aria-label="More about: Range"/);
  expect(describedBy).toBeTruthy();
  expect(html).toContain(`<span id="${describedBy}" class="sr-only" data-testid="range-help">The game&#x27;s estimate.</span>`);
  // The tooltip itself is closed: its copy is not rendered until hover or focus.
  expect(html).not.toContain('range-help-tooltip');
});

it('uses a given id, so a control can be described by the same text', () => {
  expect(hint({id: 'overlay-opacity-help'})).toMatch(/aria-describedby="overlay-opacity-help"[\s\S]*<span id="overlay-opacity-help" class="sr-only"/);
});

it('shows current and required values only for a failing Hard Mode rule, and the caveats behind one hint', () => {
  const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')), 0, 'fixture');
  const html = renderToStaticMarkup(React.createElement(HardModeCard, {language: 'en', controller: {status: {assessment, trip: null}, now: 0, busy: false, error: false, loaded: true, check: () => undefined}}));
  expect(html.match(/data-testid="hard-mode-rule-[a-z]+"/g)).toHaveLength(12);
  expect(html.match(/data-testid="hard-mode-detail-rule-[a-z]+"/g)).toEqual(['data-testid="hard-mode-detail-rule-fatigue"']);
  expect(html).toContain('data-testid="hard-mode-detail-rule-fatigue"><p>Now Off · required On</p></div>');
  // A failing rule makes the in-game fix visible and names it; the caveats are the headline hint's description, not a paragraph.
  expect(html).toMatch(/data-testid="hard-mode-fix">.*Options → Gameplay: Fatigue simulation\./);
  expect(html).toMatch(/<button type="button" class="yu-info-hint" aria-label="How Hard Mode is checked"/);
  expect(html).toMatch(/<span id="[^"]+" class="sr-only" data-testid="hard-mode-caveats">[\s\S]*Read-only checks observe persisted settings\./);
  expect(html).not.toMatch(/g_fatigue|g_fuel_simulation/);
});

it('shows no in-game fix line when every Hard Mode rule passes', () => {
  const assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 0, 'fixture');
  const html = renderToStaticMarkup(React.createElement(HardModeCard, {language: 'en', controller: {status: {assessment, trip: null}, now: 0, busy: false, error: false, loaded: true, check: () => undefined}}));
  expect(html).not.toContain('hard-mode-detail-rule-');
  expect(html).not.toContain('data-testid="hard-mode-fix"');
});
