import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it, vi} from 'vitest';
import type {AppLanguage, CargoClassification, JournalTripListItem, JournalTripPage} from '../../packages/contracts/src';
import {TripTable} from '../../apps/desktop/src/journal-table';
import {JobTypeBadge, ModeBadge} from '../../apps/desktop/src/trip-badges';
import {journalListText} from '../../apps/desktop/src/journal-view';
import {LIST_ITEM, TRIP} from '../shared/journal-replies';

// ET-076 (mockup T3; REG-009, REG-014): the compact trip table's static markup, without the journal bridge. The site
// badge is the one shadcn-alias import of the module graph. Expected texts are written by hand from en.ts and ru.ts.
vi.mock('@/components/ui/badge', () => ({
  Badge: ({variant, children, ...props}: {variant?: string; children?: React.ReactNode}) => React.createElement('span', {...props, 'data-variant': variant}, children)
}));

const page = (trips: JournalTripListItem[]): JournalTripPage => ({database: {purpose: 'synthetic', schemaVersion: 6}, trips, nextCursor: null});
const ITEM = LIST_ITEM as unknown as JournalTripListItem;
const owner = {origin: 'https://dashboard.example', accountId: 'a', companyId: 'c', identityEpoch: 'e'};
const sync = {owner, connectionVersion: '1', rows: [{tripUuid: TRIP, state: 'sent' as const, materialVersion: '1', latestRevision: 1, lastDurableUploadUtcMs: 1_000, reason: null}]};
function render(trips: JournalTripListItem[], language: AppLanguage, withSync = false): string {
  const {rows} = journalListText(page(trips), {filtered: false, language});
  return renderToStaticMarkup(React.createElement(TripTable, {rows, language, onOpen: () => undefined, ...(withSync ? {sync} : {})}));
}
/** The visible header texts: the hint's hidden description is not a heading, and the Open column's hidden name is shown as [open]. */
const headers = (html: string) => [...html.matchAll(/<th[^>]*>(.*?)<\/th>/g)].map(match => match[1].replace(/<span id="[^"]*" class="sr-only"[^>]*>.*?<\/span>/, '').replace(/<span class="sr-only">.*?<\/span>/, '[open]').replace(/<[^>]+>/g, ''));

describe('TripTable (ET-076)', () => {
  it.each([
    ['single-player', 'Single-player', 'neutral', 'user-round'], ['truckersmp', 'TruckersMP', 'ok', 'users-round'],
    ['haulmp', 'HaulMP', 'ok', 'users-round'], ['convoy', 'Convoy', 'neutral', 'users-round'], ['unknown', 'Mode unknown', 'neutral', 'circle-help'],
    ['truckersmp', 'TruckersMP · unconfirmed', 'warn', 'triangle-alert']
  ] as const)('uses a shared semantic badge for %s (%s)', (kind, text, tone, icon) => {
    const html = renderToStaticMarkup(React.createElement(ModeBadge, {mode: {kind, text, tone}}));
    expect(html).toContain(`data-variant="${tone}"`);
    expect(html).toContain(`lucide-${icon}`);
    expect(html).not.toContain('<button'); expect(html).not.toContain('title=');
    if (tone === 'warn') expect(html).toContain('<small class="yu-badge-note"> · unconfirmed</small>');
  });
  it('keeps unsupported job values and missing reasons visible outside their compact badges', () => {
    for (const [kind, text, label] of [['other', 'A long game-provided market value', 'Other job type'], ['unavailable', 'unavailable (not observed)', 'Job type unknown']] as const) {
      const html = renderToStaticMarkup(React.createElement(JobTypeBadge, {job: {kind, text}, language: 'en'}));
      expect(html).toContain(`<span>${label}</span></span><small class="yu-badge-note">${text}</small>`);
      expect(html).toContain('lucide-circle-help');
    }
  });
  it.each([['en', 'Cancelled'], ['ru', 'Отменён']] as const)('presents a superseded job as a red cancellation badge (%s)', (language, label) => {
    const trip = {...ITEM, outcome: 'none' as const, closeReason: 'different-job' as const};
    const html = render([trip], language);
    expect(html).toMatch(new RegExp(`data-testid="journal-row-outcome"><span[^>]*data-variant="error"[^>]*>.*?${label}</span>`));
    expect(trip.outcome).toBe('none');
    expect(trip.closeReason).toBe('different-job');
  });
  it('marks only confirmed Hard Mode trips with a green badge and flame', () => {
    const html = render([{...ITEM, isHardMode: true}], 'ru');
    expect(html.match(/<span[^>]*data-testid="hard-mode-badge"[^>]*>/)?.[0]).toContain('data-variant="ok"');
    expect(html).toContain('lucide-flame');
    expect(html).toContain('aria-label="Hard Mode"');
    expect(render([ITEM], 'ru')).not.toContain('hard-mode-badge');
  });
  it('shows the compact date and preserves the full date in its title', () => {
    const rows = journalListText(page([ITEM]), {filtered: false, language: 'ru', timeZone: 'UTC'}).rows;
    const html = renderToStaticMarkup(React.createElement(TripTable, {rows, language: 'ru', onOpen: () => undefined}));
    expect(html).toContain('<time title="2026-10-11 00:00:00">11 окт, 00:00</time>');
  });
  it.each([
    ['en', ['Started', 'Game · mode', 'Cargo', 'Job type', 'Route', 'Distance', 'Revenue', 'Outcome', 'Recording', '[open]'], 'Site'],
    ['ru', ['Начало', 'Игра · режим', 'Груз', 'Тип заказа', 'Маршрут', 'Дистанция', 'Выручка', 'Итог', 'Запись', '[open]'], 'Сайт']
  ] as const)('lists its columns in the mockup order in %s and adds Site only with sync facts', (language, columns, site) => {
    expect(headers(render([ITEM], language))).toEqual(columns);
    const withSync = headers(render([ITEM], language, true));
    expect(withSync).toEqual([...columns.slice(0, 9), site, columns[9]]);
    const html = render([ITEM], language);
    expect(html).not.toContain('journal-sync-column');
    expect(render([ITEM], language, true)).toContain('journal-sync-column');
    // AC: the fuel column is gone, and the row carries no duplicate cell for it.
    expect(html).not.toContain('journal-row-fuel');
  });

  it('shows the mode line and the job type cell on every row', () => {
    const quick = {...ITEM, job: {...ITEM.job, market: {available: true as const, value: 'quick_job'}}};
    const external = {...ITEM, tripUuid: '7a000000-0000-4000-8000-000000000002', job: {...ITEM.job, market: {available: true as const, value: 'external_market'}}};
    const html = render([quick, external], 'en');
    expect(html.match(/data-testid="journal-row"/g)).toHaveLength(2);
    expect(html.match(/data-testid="journal-row-mode"/g)).toHaveLength(2);
    expect(html.match(/data-testid="journal-row-job-type"/g)).toHaveLength(2);
    expect(html).not.toContain('journal-mode-evidence-');
    // The fixture trip has an unknown mode: it shows as unknown, never as single-player.
    expect(html).toMatch(/data-testid="journal-row-mode"[^>]*data-kind="unknown"[^>]*>.*?Mode unknown/);
    expect(html).not.toContain('Single-player');
    expect(html).toMatch(/data-testid="journal-row-job-type"[^>]*data-kind="quick-job"[^>]*>.*?lucide-zap.*?<span>Quick job<\/span>/);
    expect(html).toMatch(/data-testid="journal-row-job-type"[^>]*data-kind="world-of-trucks"[^>]*>.*?lucide-globe.*?<span>World of Trucks<\/span>/);
    expect(html).toMatch(/<small[^>]*data-testid="journal-row-job-sub">External market<\/small>/);
  });

  it('marks special transport with a line of its own only when the game flagged the job', () => {
    const special = {...ITEM, job: {...ITEM.job, isSpecialJob: {available: true as const, value: true}}};
    expect(render([special], 'en')).toContain('data-testid="journal-row-special"');
    expect(render([special], 'en')).toContain('Special transport');
    expect(render([ITEM], 'en')).not.toContain('journal-row-special');
    expect(render([special], 'en')).not.toContain('data-cargo-classification="heavy"');
  });

  it.each([['en', 'ADR 8: Corrosive substances', 'Heavy', 'Fragile', 'Valuable'],
    ['ru', 'ADR 8: Едкие вещества', 'Тяжёлый', 'Хрупкий', 'Ценный']] as const)(
    'places accessible compact cargo badges beside the cargo name in %s', (language, adr, heavy, fragile, valuable) => {
      const cargoClassification: CargoClassification = {version: 1, fragility: 0.8, fragile: true, valuable: true,
        adr: {state: 'class', class: 8}, overweight: true, oversize: null, groups: ['machinery']};
      const item = {...ITEM, cargoClassification, job: {...ITEM.job, cargo: {available: true as const, value: 'Steel'}}};
      const html = render([item], language);
      const cargo = html.match(/data-testid="journal-row-cargo"><span>Steel<\/span>(.*?)<\/div>/)?.[1] ?? '';
      expect(cargo).toContain('data-layout="compact"');
      expect([...cargo.matchAll(/data-cargo-classification="([^"]+)"/g)].map(match => match[1])).toEqual(['adr', 'heavy', 'fragile', 'valuable']);
      for (const [label, icon, variant] of [[adr, 'diamond', 'warn'], [heavy, 'weight', 'neutral'],
        [fragile, 'wine', 'neutral'], [valuable, 'gem', 'neutral']]) {
        expect(cargo).toMatch(new RegExp(`data-variant="${variant}"[^>]*role="img" aria-label="${label}" title="${label}"[^>]*><svg[^>]*lucide-${icon}`));
        expect(cargo).not.toContain(`<span>${label}</span>`);
      }
      expect(cargo).toContain('</svg><span>8</span>');
      expect(render([ITEM], language)).not.toContain('cargo-badges');
      expect(render([ITEM], language)).not.toContain('cargo-unknown');
    });

  it('names the trip in its Open control and shows only the odometer distance', () => {
    const cargo = {...ITEM, job: {...ITEM.job, cargo: {available: true as const, value: 'Steel'}, sourceCompany: {available: true as const, value: 'Vltava'}, destinationCompany: {available: true as const, value: 'Donau'}}};
    const html = render([cargo], 'ru');
    expect(html.match(/data-testid="journal-row-open"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Открыть рейс Steel"');
    expect(html).toContain('data-testid="journal-row-observed">0.0 км</div>');
    expect(html).not.toContain('journal-row-planned');
    expect(html).toContain('<small data-testid="journal-row-companies">Vltava · Donau</small>');
  });

  it('keeps the profile check chip while omitting distance sublines (ET-112e)', () => {
    const accounting = {engine: 1 as const, distance: {status: 'partial' as const, breaks: ['reading-hole' as const], quality: []}, fuel: {status: 'complete' as const, breaks: [], quality: []}};
    const marked = render([{...ITEM, accounting, membership: 'pending'}], 'en');
    expect(marked).toContain('data-testid="journal-row-observed">0.0 km</div>');
    expect(marked).not.toContain('journal-row-planned');
    expect(marked).not.toContain('journal-row-distance-partial');
    expect(marked).toMatch(/data-testid="journal-row-membership"[^>]*>.*?lucide-circle-help.*?<span>Profile check pending<\/span>/);
    expect(marked).toContain('This recording may still join an earlier trip of the same job if the profile is confirmed in this game session; otherwise it stays separate.');
    expect(render([{...ITEM, accounting, membership: 'pending'}], 'ru')).toMatch(/data-testid="journal-row-membership"[^>]*>.*?<span>Ожидает проверки профиля<\/span>/);
    const plain = render([{...ITEM, accounting: {...accounting, distance: {status: 'complete' as const, breaks: [], quality: []}}}], 'en');
    expect(plain).not.toContain('journal-row-distance-partial'); expect(plain).not.toContain('journal-row-membership');
    expect(render([ITEM], 'en')).not.toContain('journal-row-distance-partial');
  });
});
