import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect, it, vi} from 'vitest';
import type {AppLanguage} from '../../packages/contracts/src';
import type {Measure} from '../../packages/contracts/src/protocol-v1';
import {LiveDashboard} from '../../apps/desktop/src/live-dashboard';
import {smokePair} from '../shared/live-v1-fixtures';

// ET-052 D3: the Live details row of the next mandatory break renders its Coffee icon, the value and an urgency badge that
// never relies on colour alone: an icon, a word and an accessible name. The shadcn cards are substituted by plain
// containers; the row, its icon and the badge are the real component. Expected markup is written by hand.
vi.mock('@/components/ui/button', () => ({Button: 'button'}));
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
// The badge keeps its variant as an attribute; the real component maps it to the Yukon warn and error tones.
vi.mock('@/components/ui/badge', () => ({
  Badge: ({variant, children, ...props}: {variant?: string; children?: React.ReactNode}) => React.createElement('span', {...props, 'data-variant': variant}, children)
}));

const render = (measure: Measure<'min'> | undefined, language: AppLanguage = 'en', options: Parameters<typeof smokePair>[0] = {}) =>
  renderToStaticMarkup(React.createElement(LiveDashboard, {live: smokePair({...(measure ? {nextMandatoryBreak: measure} : {}), ...options}), units: undefined, language}));
const rowOf = (html: string) => html.match(/<div class="yu-kv"><dt>(?:(?!<div class="yu-kv">).)*?data-testid="live-mandatory-break"(?:(?!<div class="yu-kv">).)*?<\/dd><\/div>/s)?.[0] ?? '';
const available = (value: number): Measure<'min'> => ({available: true, value, unit: 'min'});

it('renders the Coffee icon beside the label and the value, with a warning badge for a soon break', () => {
  const row = rowOf(render(available(95)));
  expect(row).toContain('data-testid="live-mandatory-break-icon"');
  expect(row).toContain('Next mandatory break');
  expect(row).toMatch(/<span data-testid="live-mandatory-break">1 h 35 min<\/span>/);
  // The badge pairs the Hourglass icon with the word "Soon" and names itself; the tone is the warn variant.
  const badge = row.match(/<span[^>]*data-testid="live-mandatory-break-badge"[^>]*>.*?<\/span>/s)?.[0] ?? '';
  expect(badge).toContain('data-urgency="soon"');
  expect(badge).toContain('data-variant="warn"');
  expect(badge).toContain('role="img"');
  expect(badge).toContain('aria-label="Next mandatory break: Soon"');
  expect(badge).toContain('lucide-hourglass');
  expect(badge).toContain('aria-hidden="true"');
  expect(badge).toMatch(/Soon<\/span>$/);
});
it('renders an error badge with the TriangleAlert icon and the word "Break due" for zero and for a negative reading, and "0 min" as the value', () => {
  for (const value of [0, -30]) {
    const row = rowOf(render(available(value)));
    expect(row).toMatch(/<span data-testid="live-mandatory-break">0 min<\/span>/);
    const badge = row.match(/<span[^>]*data-testid="live-mandatory-break-badge"[^>]*>.*?<\/span>/s)?.[0] ?? '';
    expect(badge).toContain('data-urgency="due"');
    expect(badge).toContain('data-variant="error"');
    expect(badge).toContain('aria-label="Next mandatory break: Break due"');
    expect(badge).toContain('lucide-triangle-alert');
    expect(badge).toMatch(/Break due<\/span>$/);
  }
});
it('renders no badge for a normal break (120 minutes or more) or for an unavailable one', () => {
  for (const measure of [available(120), available(600), {available: false, reason: 'not-observed', unit: 'min'} as const, {available: false, reason: 'not-supported', unit: 'min'} as const]) {
    const row = rowOf(render(measure));
    expect(row).toContain('data-testid="live-mandatory-break"');
    expect(row).not.toContain('live-mandatory-break-badge');
  }
  expect(rowOf(render({available: false, reason: 'not-supported', unit: 'min'}))).toContain('unavailable</span> (<span data-testid="live-mandatory-break-reason">not provided by the game</span>)');
});
it('renders the Russian label, value and badge words', () => {
  const soon = rowOf(render(available(95), 'ru')), due = rowOf(render(available(0), 'ru'));
  expect(soon).toContain('До обязательного перерыва');
  expect(soon).toMatch(/<span data-testid="live-mandatory-break">1 ч 35 мин<\/span>/);
  expect(soon).toContain('aria-label="До обязательного перерыва: Скоро"');
  expect(soon).toContain('Скоро</span></dd>');
  expect(due).toContain('aria-label="До обязательного перерыва: Пора"');
  expect(due).toContain('Пора</span></dd>');
});
it('renders no row and no icon when v1 is not carried, and no badge when the v1 data is not current', () => {
  const v0Only = renderToStaticMarkup(React.createElement(LiveDashboard, {live: { ...smokePair(), v1: undefined }, units: undefined, language: 'en'}));
  expect(v0Only).not.toContain('live-mandatory-break');
  const stale = rowOf(render(available(0), 'en', {status: 'stale', fresh: false, reason: 'Main has no recent v1 SDK capture'}));
  expect(stale).toContain('unavailable</span> (<span data-testid="live-mandatory-break-reason">not current</span>)');
  expect(stale).not.toContain('live-mandatory-break-badge');
});
