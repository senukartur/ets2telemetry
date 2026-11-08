import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {AppLanguage, JournalTripDetail} from '../../packages/contracts/src';
import {TripCompleteness, TripFields, TripHeading, TripKpis, TripSide, TripSite, TripTimelineList} from '../../apps/desktop/src/trip-details';
import {journalCompletenessText, journalDetailText, journalTripSideText, type JournalTimelineItem} from '../../apps/desktop/src/journal-view';
import {journalTileValues} from '../../apps/desktop/src/screens/journal-tiles';
import {newHardModeDetails, evaluateHardMode, parseHardModeConfig} from '../../packages/telemetry-core/src/hard-mode';
import {DETAIL} from '../shared/journal-replies';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';

// ET-077 (mockup T4; REG-009, REG-014): the static markup of the compact trip page, without the journal bridge. Expected
// texts are written by hand from en.ts and ru.ts. The site badge is the one shadcn-alias import of the module graph.
vi.mock('@/components/ui/badge', () => ({
  Badge: ({variant, children, ...props}: {variant?: string; children?: React.ReactNode}) => React.createElement('span', {...props, 'data-variant': variant}, children)
}));

const money = (raw: string) => ({available: true as const, value: {raw, sdkType: 's64' as const, currency: {status: 'unknown' as const}}});
const OPEN = DETAIL as unknown as JournalTripDetail;
const DELIVERED: JournalTripDetail = {...OPEN, trip: {...OPEN.trip, outcome: 'delivered', closeReason: 'outcome', recordingCompleteness: 'complete'}, outcomeDetails: {eventSeq: '9', record: {type: 'job.delivered', revenue: money('15000'), earnedXp: {available: true, value: 250}, cargoDamage: {available: true, value: 0, unit: 'fraction'},
  distance: {available: true, value: 150_000, unit: 'm'}, deliveryDuration: {available: true, value: '471', unit: 'min'}, autoParkUsed: {available: true, value: false}, autoLoadUsed: {available: true, value: true}}}};
const sentRow = {tripUuid: OPEN.trip.tripUuid, state: 'sent' as const, materialVersion: '1', latestRevision: 3, lastDurableUploadUtcMs: 1_000, reason: null};
const side = (detail: JournalTripDetail, language: AppLanguage, site: typeof sentRow | null = null) => renderToStaticMarkup(React.createElement(TripSide, {detail, side: journalTripSideText(detail, {language}), site, language}));
const kpis = (detail: JournalTripDetail, language: AppLanguage) => renderToStaticMarkup(React.createElement(TripKpis, {tiles: journalTileValues(detail, {language}), outcome: detail.trip.outcome, language}));
const hardMode = (assessment = evaluateHardMode(parseHardModeConfig(HARD_MODE_CONFIG), 0, 'fixture')) => newHardModeDetails(assessment, null);

describe('compact trip page (ET-077)', () => {
  it.each([
    ['en', ['Distance observed', 'planned 152.0 km', 'game reported 150.0 km', 'Revenue', 'expected 12345 (currency unknown)', 'Recorded time', 'from 1 Hz samples, without pauses and gaps; may include samples not counted in distance and fuel', '7 h 51 min game time', 'Fuel used', 'from samples, refuels excluded']],
    ['ru', ['Пройдено по одометру', 'по заказу 152.0 км', 'по данным игры 150.0 км', 'Выручка', 'ожидалось 12345 (валюта неизвестна)', 'Записано времени', 'по сэмплам 1 Гц, без пауз и пропусков; могут входить сэмплы, не учтённые в дистанции и расходе', '7 ч 51 мин игрового', 'Израсходовано', 'по сэмплам, без заправок']]
  ] as const)('labels the planned, game-reported and observed totals separately in %s', (language, texts) => {
    const html = kpis(DELIVERED, language);
    for (const text of texts) expect(html).toContain(text);
    expect(html.match(/data-testid="trip\.tile\./g)).toHaveLength(4);
  });
  it('does not show a game-reported distance for a trip the game never delivered, and says that game time is missing', () => {
    const html = kpis(OPEN, 'en');
    expect(html).not.toContain('game reported'); expect(html).toContain('game time not available');
  });

  it.each([['en', 'Delivered', 'Complete', 'started'], ['ru', 'Доставлен', 'Полная', 'начат']] as const)('shows the cargo title and every chip with a word and an icon in %s', (language, outcome, completeness, started) => {
    const text = journalDetailText(DELIVERED, {language});
    const html = renderToStaticMarkup(React.createElement(TripHeading, {game: 'ets2', outcome: 'delivered', isHardMode: true, cargo: 'Synthetic Cargo', text, side: journalTripSideText(DELIVERED, {language}), language}));
    expect(html).toContain('<h1 data-testid="trip.header.cargo">Synthetic Cargo</h1>');
    expect(html).toMatch(new RegExp(`data-testid="journal-detail-outcome"[^>]*><svg.*?<span>${outcome}</span>`));
    expect(html).toMatch(new RegExp(`data-testid="journal-detail-completeness"[^>]*><svg.*?<span>${completeness}</span>`));
    expect(html).toContain(started); expect(html).toContain('hard-mode-badge');
    expect(html).toMatch(/<p class="sr-only" data-testid="journal-detail-title">ETS2: /);
    expect(html).not.toContain('journal-delete');
  });

  it.each([['en', 'Site', 'Saved by the site', '"Sent" means the site saved the trip. The company decides on the site.'], ['ru', 'Сайт', 'Сохранено сайтом', 'Решение компании принимается на сайте.']] as const)('shows the site card only with a site row, never as company acceptance, in %s', (language, title, saved, note) => {
    expect(side(OPEN, language)).not.toContain('trip.site');
    const html = side(OPEN, language, sentRow);
    expect(html).toContain('data-testid="trip.site"'); expect(html).toContain(`<h2>${title}</h2>`); expect(html).toContain(saved);
    expect(html).toContain(note.replaceAll('"', '&quot;'));
    expect(html).toContain('data-testid="trip.site.state"');
    expect(html).toContain(language === 'en' ? 'Synchronization assessed when this page was read.' : 'Состояние синхронизации на момент чтения страницы.');
    expect(html).not.toMatch(/accepted|approved|принят\b|одобрен/i);
    expect(html).not.toContain('journal-delete');
  });
  it('keeps the site text free of acceptance wording for a state other than sent', () => {
    const html = renderToStaticMarkup(React.createElement(TripSite, {row: {...sentRow, state: 'held', reason: 'validation', lastDurableUploadUtcMs: null}, language: 'en'}));
    expect(html).not.toContain('trip.site.saved');
    expect(html).toContain('A source needs validation.');
  });

  it('names the latest evaluation by the outcome and counts the passing rules', () => {
    const details = hardMode();
    const delivered = side({...DELIVERED, trip: {...DELIVERED.trip, isHardMode: true, hardModeDetails: details}}, 'en');
    expect(delivered).toContain('At job start'); expect(delivered).toContain('At delivery'); expect(delivered).not.toContain('Latest check');
    expect(delivered).toContain('This trip qualifies'); expect(delivered).toContain('Settings snapshot kept with the trip');
    expect(delivered).toMatch(/data-testid="trip\.hardMode\.opening" data-state="pass"><span aria-hidden="true">✓ <\/span><span class="sr-only">pass: <\/span>12 of 12/);
    const open = side({...OPEN, trip: {...OPEN.trip, hardModeDetails: details}}, 'ru');
    expect(open).toContain('В начале заказа'); expect(open).toContain('Последняя проверка'); expect(open).not.toContain('При доставке');
  });
  it('says that a trip without Hard Mode details was not evaluated', () => {
    const html = side(OPEN, 'en');
    expect(html).toContain('Not evaluated.'); expect(html).not.toContain('At job start');
  });

  it('keeps money per category and adds nothing a trip does not store', () => {
    const html = side(OPEN, 'en');
    for (const label of ['Fines', 'Tolls', 'Ferries', 'Trains', 'Truck', 'Trailer', 'Cargo mass']) expect(html).toContain(`<dt>${label}</dt>`);
    expect(html.match(/journal-field-/g)).toBeNull();
    expect(html).not.toMatch(/Length|Refuel cost/);
  });

  it('marks gaps and refuels apart from the event rows and keeps the five cells in order', () => {
    const items: JournalTimelineItem[] = [{kind: 'event', key: 'a', tone: 'info', eventSeq: '4', time: 't', type: 'Job configured', detail: 'd', attribution: 'this trip'},
      {kind: 'gap', key: 'b', tone: 'warn', eventSeq: '—', time: '—', type: 'Gap: lost events', detail: 'Lost events · 46 s', attribution: '—'},
      {kind: 'refuel', key: 'c', tone: 'ok', eventSeq: '—', time: 't2', type: 'Refuelled', detail: '286.0 L', attribution: '—'}];
    const html = renderToStaticMarkup(React.createElement(TripTimelineList, {items}));
    expect(html.match(/data-testid="journal-event-row"/g)).toHaveLength(1);
    expect(html).toContain('data-testid="journal-timeline-gap"'); expect(html).toContain('data-testid="journal-timeline-refuel"');
    expect(html).toContain('data-event-seq="4"');
    expect([...html.matchAll(/data-cell="(\w+)"/g)].slice(0, 5).map(match => match[1])).toEqual(['seq', 'time', 'type', 'detail', 'attribution']);
  });

  it('shows the completeness totals and the no-guessing note', () => {
    const html = renderToStaticMarkup(React.createElement(TripCompleteness, {text: journalCompletenessText(OPEN, 'ru'), language: 'ru'}));
    expect(html).toContain('role="img"'); expect(html).toContain('aria-label="Записано 1 с, пропуски без сэмплов нет"');
    expect(html).toContain('Пропуски без сэмплов'); expect(html).toMatch(/data-testid="trip\.completeness\.withoutSamples">нет</);
    expect(html).toMatch(/data-testid="trip\.completeness\.recordedNote">В записанное время могут входить сэмплы/);
    expect(html).toContain('Пропуск не заполняется догадками');
    expect(html).toMatch(/data-testid="trip\.completeness\.intervals">1</);
  });

  it('keeps every field in a closed section', () => {
    const html = renderToStaticMarkup(React.createElement(TripFields, {sections: journalDetailText(DELIVERED, {language: 'en'}).sections, language: 'en'}));
    expect(html).toMatch(/^<details class="yu-trip-fields" data-testid="trip\.fields">/);
    expect(html).toContain('data-testid="journal-field-trip-tripId"'); expect(html).toContain('data-testid="journal-section-trip-note"');
  });
});
