import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {AppLanguage, LiveTelemetry, RecordingHealth} from '../../packages/contracts/src';
import {LiveDashboard} from '../../apps/desktop/src/live-dashboard';
import {liveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {smokePair, smokeV0} from '../shared/live-v1-fixtures';

// ET-074 (REG-009, REG-002): the compact Live page in its four states. The shadcn containers are substituted by plain
// elements that keep their attributes; the page markup, the gauge and the badges are the real components. Expected texts
// are written by hand from the fixtures (tests/shared/live-v1-fixtures.ts) and the dictionaries.
vi.mock('@/components/ui/button', () => ({Button: 'button'}));
vi.mock('@/components/ui/card', () => ({Card: 'div', CardContent: 'div', CardHeader: 'div', CardTitle: 'div'}));
vi.mock('@/components/ui/badge', () => ({
  Badge: ({variant, children, ...props}: {variant?: string; children?: React.ReactNode}) => React.createElement('span', {...props, 'data-variant': variant}, children)
}));

const recording = (completeness: 'complete' | 'partial' | 'unknown' | null): RecordingHealth => ({state: 'recording', target: 'synthetic', code: null,
  losses: {lostEvents: 0, eventLoss: 0, notConnected: 0, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0}, trip: {phase: 'active', completeness, untrackedJob: false}});
const render = (live: LiveTelemetry | undefined, language: AppLanguage = 'en', health?: RecordingHealth) =>
  renderToStaticMarkup(React.createElement(LiveDashboard, {live, units: undefined, language, recording: health}));
/** The markup from one test id to the next, enough to scope an assertion to one card. */
const between = (html: string, from: string, to: string) => {
  const start = html.indexOf(`data-testid="${from}"`), end = html.indexOf(`data-testid="${to}"`, start + 1);
  expect(start, from).toBeGreaterThan(-1); expect(end, to).toBeGreaterThan(start);
  return html.slice(start, end);
};
const state = (html: string) => /data-testid="live-telemetry" data-live-state="([a-z]+)"/.exec(html)?.[1];
const STALE = {status: 'stale', fresh: false, reason: 'Main has no recent SDK capture'} as const;
/** Both sources stopped, as when the game stops sending: v0 and v1 are stale. */
const stalePair = () => smokePair({status: 'stale', fresh: false, reason: 'Main has no recent v1 SDK capture'}, STALE);

describe('connected', () => {
  it.each([
    ['en', {market: 'Freight market', deadline: 'Deadline', trip: ['This trip', 'Recording', 'Complete'], truck: 'Truck', session: ['Game session', 'Single-player'], noTrip: ['Real time', 'Game time', 'Fuel used'],
      breakLabel: 'Next mandatory break', breakValue: '1 h 35 min', badge: 'Next mandatory break: Soon', mass: '18.0 t'}],
    ['ru', {market: 'Грузоперевозки', deadline: 'Срок', trip: ['Этот рейс', 'Запись', 'Полная'], truck: 'Грузовик', session: ['Игровая сессия', 'Одиночная игра'], noTrip: ['Реальное время', 'Игровое время', 'Израсходовано'],
      breakLabel: 'До обязательного перерыва', breakValue: '1 ч 35 мин', badge: 'До обязательного перерыва: Скоро', mass: '18.0 т'}]
  ] as const)('renders the job tags, the route, the break, This trip and the Game session in %s', (language, expected) => {
    const html = render(smokePair(), language, recording('complete'));
    expect(state(html)).toBe('connected');
    expect(html).not.toContain('data-testid="live.waiting"');
    expect(html).not.toContain('data-testid="live.stale"');
    // Tags: cargo with its mass, the market label and the deadline; game names stay as the game sent them.
    const tags = between(html, 'live.job.tags', 'live.job.route');
    expect(tags).toContain(`Synthetic Cargo · ${expected.mass}</span>`);
    expect(tags).toContain(`data-testid="live.job.market" data-variant="neutral">${expected.market}</span>`);
    expect(tags).toContain(`${expected.deadline} `);
    // The route: origin and destination with their companies, and a plain line without a progress fill or truck marker.
    const route = between(html, 'live.job.route', 'live.job.break');
    expect(route).toContain('<strong data-testid="live.job.origin">Synthetic City A</strong><small>Synthetic Company A</small>');
    expect(route).toContain('<strong data-testid="live.job.destination">Synthetic City B</strong><small>Synthetic Company B</small>');
    expect(route).toContain('<span class="yu-route-line" aria-hidden="true"></span>');
    expect(route).not.toMatch(/lucide-truck|role="img"|width:/);
    // The next mandatory break with its own badge id, never the details row's.
    const job = between(html, 'live.job.break', 'live.trip');
    expect(job).toContain(expected.breakLabel);
    expect(job).toContain(`<strong>${expected.breakValue}</strong>`);
    expect(job).toMatch(new RegExp(`<span role="img" aria-label="${expected.badge}" data-testid="live.job.break.badge" data-urgency="soon" data-variant="warn">`));
    expect(job).not.toContain('live-mandatory-break');
    // This trip: only the recording completeness, no placeholder rows.
    const trip = between(html, 'live.trip', 'live.truck');
    for (const text of expected.trip) expect(trip).toContain(text);
    expect(trip).toContain('data-variant="ok">');
    for (const text of expected.noTrip) expect(trip).not.toContain(text);
    expect(between(html, 'live.truck', 'live.session')).toContain(expected.truck);
    const session = between(html, 'live.session', 'live.details');
    for (const text of expected.session) expect(session).toContain(text);
    expect(session).toContain('<dd data-testid="live.session.protocol">v0 + v1</dd>');
    expect(session).toContain('<dd data-testid="live.session.lostEvents">2</dd>');
  });
  it('shows a partial or unknown recording as its word with the warn or neutral tone, and a dash without an open trip', () => {
    expect(between(render(smokePair(), 'en', recording('partial')), 'live.trip', 'live.truck')).toContain('<span data-variant="warn">Partial</span>');
    expect(between(render(smokePair(), 'ru', recording('unknown')), 'live.trip', 'live.truck')).toContain('<span data-variant="neutral">Неизвестно</span>');
    for (const health of [recording(null), {state: 'unknown'} as const, undefined]) expect(between(render(smokePair(), 'en', health), 'live.trip', 'live.truck')).toContain('<dd data-testid="live.trip.recording">—</dd>');
  });
});

it('without v1 shows no break, no Mode and no Lost events row, and the v0 protocol', () => {
  const html = render(smokeV0(), 'en');
  expect(state(html)).toBe('connected');
  expect(html).not.toContain('live.job.break');
  const session = between(html, 'live.session', 'live.details');
  expect(session).not.toContain('live.session.mode');
  expect(session).not.toContain('live.session.lostEvents');
  expect(session).toContain('<dd data-testid="live.session.protocol">v0</dd>');
});

it.each(['en', 'ru'] as const)('paused keeps current values with the paused badge and no stale badge in %s', language => {
  const html = render(smokePair({}, {status: 'paused'}), language);
  expect(state(html)).toBe('paused');
  expect(html).toContain(`data-testid="live-paused" data-variant="warn">${language === 'en' ? 'Game paused' : 'Игра на паузе'}</span>`);
  expect(html).not.toContain('data-testid="live.stale"');
  expect(html).toContain('data-testid="live-speed-number">90</text>');
});

it.each([['en', 'No current data'], ['ru', 'Нет текущих данных']] as const)('stale shows its badge and dashes, not the waiting banner, in %s', (language, word) => {
  const html = render(stalePair(), language);
  expect(state(html)).toBe('stale');
  expect(html).toMatch(new RegExp(`data-testid="live.stale" data-variant="error"><svg[^>]*lucide-wifi-off[^>]*aria-hidden="true"[^>]*>.*?</svg>${word}</span>`));
  expect(html).not.toContain('data-testid="live.waiting"');
  expect(html).toContain('data-testid="live-speed-number">—</text>');
  expect(between(html, 'live.instrument.gear', 'live.instrument.fuel')).toContain('<strong>—</strong>');
  // The job of the stale observation keeps its body, with dashes and without the tags of current values.
  const job = between(html, 'live.job', 'live.trip');
  expect(job).not.toContain('live.job.tags');
  expect(job).toContain('<strong data-testid="live.job.origin">—</strong><small>—</small>');
  expect(job).not.toContain('Synthetic City');
});

describe('partial', () => {
  const PARTIAL = {en: 'Game connection is incomplete. Waiting for the other telemetry stream.', ru: 'Подключение к игре неполное. Ожидание второго потока телеметрии.'} as const;
  it.each(['en', 'ru'] as const)('v0 stale while v1 is current shows the banner and the current v1 values, not the stale badge, in %s', language => {
    const html = render(smokePair({}, STALE), language);
    expect(state(html)).toBe('partial');
    expect(between(html, 'live.waiting', 'live.instrument')).toContain(`<p>${PARTIAL[language]}</p>`);
    expect(html).not.toContain('data-testid="live.stale"');
    // v0's values are dashes; v1's job values for the same job stay current.
    expect(html).toContain('data-testid="live-speed-number">—</text>');
    const job = between(html, 'live.job.break', 'live.trip');
    expect(job).toContain(`<strong>${language === 'en' ? '1 h 35 min' : '1 ч 35 мин'}</strong>`);
    expect(job).toContain('data-testid="live.job.break.badge"');
    expect(between(html, 'live.session', 'live.details')).toContain(`<dd data-testid="live.session.mode">${language === 'en' ? 'Single-player' : 'Одиночная игра'}</dd>`);
  });
  it.each(['en', 'ru'] as const)('v0 current while v1 is stale shows the banner and the current v0 values in %s', language => {
    const html = render(smokePair({status: 'stale', fresh: false, reason: 'Main has no recent v1 SDK capture'}), language);
    expect(state(html)).toBe('partial');
    expect(between(html, 'live.waiting', 'live.instrument')).toContain(`<p>${PARTIAL[language]}</p>`);
    expect(html).not.toContain('data-testid="live.stale"');
    expect(html).toContain('data-testid="live-speed-number">90</text>');
    expect(html).toContain('<dd data-testid="live.session.mode">—</dd>');
  });
});

it('puts the tank fill inside the inset track with its inline height', () => {
  expect(render(smokePair())).toMatch(/data-testid="live.instrument.tank" data-state="value" aria-hidden="true"><span class="yu-tank-track"><i style="height:7.3%;background:var\(--yu-progress-pending\)"><\/i><\/span><\/div>/);
  expect(render(stalePair())).toContain('data-state="unavailable" aria-hidden="true"><span class="yu-tank-unavailable">—</span></div>');
});

it.each([
  ['en', {title: 'Waiting for the game', text: 'Start Euro Truck Simulator 2 or American Truck Simulator. The plugin connects on its own; nothing to click here.',
    noJob: 'No active job. The fields appear when the game reports a job.'}],
  ['ru', {title: 'Ожидание игры', text: 'Запустите Euro Truck Simulator 2 или American Truck Simulator. Плагин подключится сам, здесь ничего нажимать не нужно.',
    noJob: 'Нет активного заказа. Поля появятся, когда игра передаст заказ.'}]
] as const)('waiting shows the banner, dashes and the no-job hint without badges in %s', (language, expected) => {
  const html = render(undefined, language);
  expect(state(html)).toBe('waiting');
  const banner = between(html, 'live.waiting', 'live.instrument');
  expect(banner).toContain(`<strong>${expected.title}</strong><p>${expected.text}</p>`);
  expect(html).toContain('data-testid="live-speed-number">—</text>');
  expect(between(html, 'live.job', 'live.trip')).toContain(`<p class="yu-muted" data-testid="live.job.none">${expected.noJob}</p>`);
  expect(html).not.toContain('live.job.route');
  expect(html).toContain('<dd data-testid="live.trip.recording">—</dd>');
  expect(html).toContain('<dd data-testid="live.session.protocol">—</dd>');
  for (const id of ['live-paused', 'live.stale', 'live.job.break.badge']) expect(html).not.toContain(`data-testid="${id}"`);
});

it('keeps a current zero speed apart from a missing one', () => {
  const zero = smokeV0(); zero.observation!.state.speed = {available: true, value: 0, unit: 'm/s'};
  expect(render(zero)).toContain('data-testid="live-speed-number">0</text>');
  const missing = smokeV0(); missing.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  expect(render(missing)).toContain('data-testid="live-speed-number">—</text>');
});

it('keeps the fuel text contract and renders every field test id in the details exactly once', () => {
  for (const [language, fuel] of [['en', 'Fuel: 73.0 L'], ['ru', 'Топливо: 73.0 л']] as const) {
    const html = render(smokePair(), language);
    expect(html).toContain(`<strong class="yu-metric" data-testid="fuel">${fuel}</strong>`);
    expect(html.match(/data-testid="fuel"/g)).toHaveLength(1);
    // Every details row's test id, as the smokes read them: one element each, never repeated by the cards above.
    for (const {testId} of liveDashboardText(smokePair(), undefined, language).sections.flatMap(section => section.rows)) expect(html.match(new RegExp(`data-testid="${testId}"`, 'g')), testId).toHaveLength(1);
    for (const id of ['cargo', 'source-city', 'destination-city', 'truck', 'mandatory-break', 'game-mode', 'event-loss', 'cruise-control']) expect(html.match(new RegExp(`data-testid="live-${id}"`, 'g')), id).toHaveLength(1);
    // Cruise control (ET-071) has no slot in the compact layout: it stays a details row only, after the cards.
    expect(html.indexOf('data-testid="live-cruise-control"')).toBeGreaterThan(html.indexOf('data-testid="live.details"'));
    // The field list stays last and collapsed (no open attribute).
    expect(html).toContain('<details class="yu-live-details" data-testid="live.details">');
    expect(html.indexOf('data-testid="live.details"')).toBeGreaterThan(html.indexOf('data-testid="live.session"'));
  }
});
