import React from 'react';
import {Check, ChevronRight, Circle, CircleHelp, Construction, Globe, Package, TriangleAlert, Truck, UserRound, UsersRound, X, Zap} from 'lucide-react';
import type {AppLanguage, JournalGame, JournalOutcome, JournalTripDetail} from '../../../packages/contracts/src';
import type {JournalSyncRow} from '../../../packages/contracts/src/journal';
// Relative imports, so that renderer tests load the page without the '@' alias (like journal-table.tsx).
import {Badge} from './components/ui/badge';
import {JournalSyncBadge} from './dashboard-upload/journal-sync';
import {journalSyncView} from './dashboard-upload/view';
import {HardModeBadge, HardModeTrip} from './hard-mode/card';
import {t} from './i18n';
import {journalSiteSaved, type JournalBadge, type JournalCompletenessText, type JournalDetailText, type JournalJobBadge, type JournalModeBadge, type JournalSection, type JournalTextOptions, type JournalTimelineItem, type JournalTripSideText} from './journal-view';
import type {journalTileValues} from './screens/journal-tiles';

/**
 * The compact trip page (ET-077, mockup T4). These components only present text that journal-view.ts and journal-tiles.ts
 * built: the planned, game-reported and observed values each keep their own label, an unavailable value keeps its reason,
 * and every status has an icon and a word. journal.tsx owns the reads and the actions.
 */
type Tiles = ReturnType<typeof journalTileValues>;

function ModeBadge({mode, testId}: {mode: JournalModeBadge; testId: string}) {
  const Icon = mode.tone === 'warn' ? TriangleAlert : mode.kind === 'single-player' ? UserRound : mode.kind === 'truckersmp' || mode.kind === 'haulmp' ? UsersRound : CircleHelp;
  return <Badge variant={mode.tone} className="yu-trip-chip" data-testid={testId}><Icon aria-hidden="true" strokeWidth={1.8} /><span>{mode.text}</span></Badge>;
}
/** The job market badge (ET-072): one neutral badge whose icon names the market kind, never a good or bad tone. */
function JobTypeBadge({job, testId}: {job: JournalJobBadge; testId: string}) {
  const Icon = job.kind === 'world-of-trucks' ? Globe : job.kind === 'quick-job' ? Zap : job.kind === 'cargo-market' ? Package : job.kind === 'freight-market' ? Truck : CircleHelp;
  return <Badge variant="neutral" className="yu-trip-chip" data-testid={testId} data-kind={job.kind}><Icon aria-hidden="true" strokeWidth={1.8} /><span>{job.text}</span></Badge>;
}
function CompletenessChip({badge, testId}: {badge: JournalBadge; testId: string}) {
  const Icon = badge.variant === 'secondary' ? Check : badge.variant === 'destructive' ? TriangleAlert : CircleHelp;
  return <Badge variant={badge.variant === 'secondary' ? 'ok' : badge.variant === 'destructive' ? 'warn' : 'neutral'} className="yu-trip-chip" data-testid={testId}><Icon aria-hidden="true" strokeWidth={1.8} /><span>{badge.text}</span></Badge>;
}
function OutcomeChip({outcome, text}: {outcome: JournalOutcome; text: string}) {
  const Icon = outcome === 'delivered' ? Check : outcome === 'cancelled' ? X : Circle;
  return <Badge variant={outcome === 'delivered' ? 'ok' : outcome === 'cancelled' ? 'error' : 'neutral'} className="yu-trip-chip" data-testid="journal-detail-outcome"><Icon aria-hidden="true" strokeWidth={1.8} /><span>{text}</span></Badge>;
}

/** The cargo, the chips and the route line. The accessible trip title stays for readers that name the trip by its cities. */
export function TripHeading({game, outcome, isHardMode, cargo, text, side, language}: {game: JournalGame; outcome: JournalOutcome; isHardMode: boolean; cargo: string; text: JournalDetailText; side: JournalTripSideText; language: AppLanguage}) {
  return <div className="yu-trip-heading">
    <div className="yu-trip-titleline">
      <h1 data-testid="trip.header.cargo">{cargo}</h1>
      <Badge variant={game} className="yu-trip-chip">{game.toUpperCase()}</Badge>
      <ModeBadge mode={text.mode} testId="journal-detail-mode" />
      <JobTypeBadge job={text.jobType} testId="journal-detail-job-type" />
      {text.specialTransport ? <Badge variant="neutral" className="yu-trip-chip" data-testid="journal-detail-special"><Construction aria-hidden="true" strokeWidth={1.8} /><span>{text.specialTransport}</span></Badge> : null}
      <OutcomeChip outcome={outcome} text={text.outcome} />
      <CompletenessChip badge={text.completeness} testId="journal-detail-completeness" />
      {isHardMode ? <HardModeBadge language={language} /> : null}
      {text.membership ? <Badge variant="neutral" className="yu-trip-chip" data-testid="journal-detail-membership" title={t('j.membershipPendingHint', undefined, language)}><CircleHelp aria-hidden="true" strokeWidth={1.8} /><span>{text.membership}</span></Badge> : null}
    </div>
    <p className="yu-trip-route" data-testid="trip.header.route">{side.route}</p>
    <p className="sr-only" data-testid="journal-detail-title">{text.title}</p>
  </div>;
}

function Kpi({label, value, notes, testId}: {label: string; value: string; notes: readonly (string | null)[]; testId: string}) {
  return <div className="yu-trip-kpi" data-testid={testId}><span>{label}</span><strong>{value}</strong>{notes.map(note => note ? <small key={note}>{note}</small> : null)}</div>;
}
/**
 * The totals row: what the odometer observed, what the job planned and what the game reported are separate labels. A
 * delivered trip shows the game's distance as the hero and the odometer distance as a note (ET-112e).
 */
export function TripKpis({tiles, outcome, language}: {tiles: Tiles; outcome: JournalOutcome; language: AppLanguage}) {
  const text = (key: Parameters<typeof t>[0], values?: Record<string, string | number>) => t(key, values, language);
  return <section className="yu-trip-kpis" data-testid="trip.tiles" aria-label={text('tr.kpis')}>
    <Kpi testId="trip.tile.distance" label={tiles.distanceTile.label} value={tiles.distanceTile.value} notes={tiles.distanceTile.notes} />
    <Kpi testId="trip.tile.money" label={text(outcome === 'cancelled' ? 'tr.penalty' : 'tr.revenue')} value={tiles.money.value} notes={[tiles.money.note, text('tr.expected', {v: tiles.expected})]} />
    <Kpi testId="trip.tile.time" label={text('tr.recordedTime')} value={tiles.recorded.value} notes={[tiles.recorded.note, tiles.gameTime]} />
    <Kpi testId="trip.tile.fuel" label={text('tr.fuel')} value={tiles.fuel.value} notes={[tiles.fuel.note, text('tr.fuelNote'), tiles.fuelPartial]} />
  </section>;
}

function SideRows({rows, testId}: {rows: JournalTripSideText['money']['rows']; testId: string}) {
  return <dl>{rows.map(row => <div className="yu-trip-row" key={row.id}><dt>{row.label}</dt><dd data-testid={`${testId}.${row.id}`}>{row.value}</dd></div>)}</dl>;
}
function SideCard({title, testId, badge, children}: {title: string; testId: string; badge?: React.ReactNode; children: React.ReactNode}) {
  return <section className="yu-trip-card" data-testid={testId} aria-label={title}>
    <div className="yu-trip-card-head"><h2>{title}</h2>{badge}</div>
    <div className="yu-trip-card-body">{children}</div>
  </section>;
}
/**
 * The site card, only for a trip whose list row carried validated sync facts of the current owner. The upload state says
 * what the app sent and the site saved; whether the company accepts a trip is decided on the site and is never implied.
 */
export function TripSite({row, language, options}: {row: JournalSyncRow; language: AppLanguage; options?: JournalTextOptions}) {
  const saved = journalSiteSaved(row, {...options, language});
  return <SideCard title={t('tr.site', undefined, language)} testId="trip.site" badge={<JournalSyncBadge row={row} language={language} testId="trip.site.state" />}>
    {saved ? <p data-testid="trip.site.saved">{saved}</p> : null}
    <p className="yu-trip-note" data-testid="trip.site.note">{t('j.syncNote', undefined, language)}</p>
    <p className="yu-trip-note" data-testid="trip.site.hint">{journalSyncView(row, language).hint}</p>
  </SideCard>;
}
/** The side column: Hard Mode, the money that left the trip, the vehicle and, when sync is configured, the site. */
export function TripSide({detail, side, site, language, options}: {detail: JournalTripDetail; side: JournalTripSideText; site: JournalSyncRow | null; language: AppLanguage; options?: JournalTextOptions}) {
  return <div className="yu-trip-side">
    <div data-testid="trip.hardMode"><HardModeTrip qualified={detail.trip.isHardMode} details={detail.trip.hardModeDetails} delivered={detail.trip.outcome === 'delivered'} language={language} /></div>
    <SideCard title={t('tr.money', undefined, language)} testId="trip.money">
      {side.money.rows.length ? <SideRows rows={side.money.rows} testId="trip.money" /> : null}
      {side.money.notes.map(note => <p className="yu-trip-note" key={note}>{note}</p>)}
    </SideCard>
    <SideCard title={t('tr.truck', undefined, language)} testId="trip.vehicle">
      <SideRows rows={side.vehicle.rows} testId="trip.vehicle" />
      {side.vehicle.notes.map(note => <p className="yu-trip-note" key={note}>{note}</p>)}
    </SideCard>
    {site ? <TripSite row={site} language={language} {...(options ? {options} : {})} /> : null}
  </div>;
}

/** Timeline rows. Each keeps the event table's five cells in order, so the eventSeq and the attribution stay on the row. */
export function TripTimelineList({items}: {items: readonly JournalTimelineItem[]}) {
  return <ol className="yu-trip-timeline">{items.map(item => <li key={item.key} className="yu-trip-event" data-tone={item.tone}
    data-testid={item.kind === 'event' ? 'journal-event-row' : item.kind === 'gap' ? 'journal-timeline-gap' : 'journal-timeline-refuel'} data-item-key={item.key} {...(item.kind === 'event' ? {'data-event-seq': item.eventSeq} : {})}>
    <span data-cell="seq" className="yu-trip-event-seq">{item.eventSeq}</span><span data-cell="time" className="yu-trip-event-time">{item.time}</span>
    <span data-cell="type" className="yu-trip-event-type">{item.type}</span><span data-cell="detail" className="yu-trip-event-detail">{item.detail}</span>
    <span data-cell="attribution" className="yu-trip-event-who">{item.attribution}</span>
  </li>)}</ol>;
}

/** The recorded and gap aggregate above the paged interval table. The bar is a total, not a time axis. */
export function TripCompleteness({text, language}: {text: JournalCompletenessText; language: AppLanguage}) {
  const {bar} = text;
  return <div className="yu-trip-completeness" data-testid="trip.completeness">
    <div className="yu-trip-bar" role="img" aria-label={bar.label} data-testid="trip.completeness.bar">
      {bar.recordedSeconds > 0 ? <span className="yu-trip-bar-recorded" style={{flexGrow: bar.recordedSeconds}} /> : null}
      {bar.gapCount > 0 ? <span className="yu-trip-bar-gap" style={{flexGrow: bar.gapSeconds}} /> : null}
    </div>
    <dl>
      <div className="yu-trip-row"><dt>{t('tr.ivRecorded', undefined, language)}</dt><dd data-testid="trip.completeness.recorded">{text.recorded}</dd></div>
      <div className="yu-trip-row"><dt>{t('tr.ivGap', undefined, language)}</dt><dd data-testid="trip.completeness.gaps">{text.gaps}</dd></div>
      <div className="yu-trip-row"><dt>{t('tr.ivNoSamples', undefined, language)}</dt><dd data-testid="trip.completeness.withoutSamples">{bar.gaps}</dd></div>
      <div className="yu-trip-row"><dt>{t('tr.ivCount', undefined, language)}</dt><dd data-testid="trip.completeness.intervals">{text.intervals}</dd></div>
    </dl>
    <p className="yu-trip-note" data-testid="trip.completeness.recordedNote">{text.recordedNote}</p>
    {text.partial ? <p className="yu-trip-note" data-testid="trip.completeness.partial">{text.partial}</p> : null}
    <p className="yu-trip-note">{text.note}</p>
  </div>;
}

/** Every J13 field, collapsed below the page. The rows stay in the document while closed, so the page is not a summary only. */
export function TripFields({sections, language}: {sections: readonly JournalSection[]; language: AppLanguage}) {
  return <details className="yu-trip-fields" data-testid="trip.fields">
    <summary data-testid="trip.fields.toggle"><ChevronRight aria-hidden="true" />{t('tr.allFields', undefined, language)}</summary>
    <div className="yu-trip-fields-grid">{sections.map(section => <section key={section.id} className="yu-trip-section" data-testid={`journal-section-${section.id}`}>
      <h3>{section.title}</h3>
      {section.fields.length ? <dl>{section.fields.map(field => <div key={field.id} className="yu-trip-row">
        <dt>{field.label}{field.note ? <span className="yu-trip-field-note"> ({field.note})</span> : null}</dt>
        <dd data-testid={`journal-field-${section.id}-${field.id}`}>{field.value}</dd>
      </div>)}</dl> : null}
      {section.notes.map(note => <p key={note} className="yu-trip-note" data-testid={`journal-section-${section.id}-note`}>{note}</p>)}
    </section>)}</div>
  </details>;
}
