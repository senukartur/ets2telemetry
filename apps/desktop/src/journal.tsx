import {journalCompletenessText, journalPageBound, journalPageSync, journalRangeText, journalSiteFacts, journalSiteRow, journalTimelineItems, journalTotalsText, journalTripSideText, type JournalSiteFacts} from './journal-view';
import {type DashboardUploadStatus} from '../../../packages/contracts/src/dashboard-upload';
import {journalTileValues} from './screens/journal-tiles';
import {SampleChart} from './screens/sample-chart';
import {t} from './i18n';
import {ChevronLeft, ChevronRight, Download, RefreshCw} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import type {
  AppLanguage, JournalCallResult, JournalCompleteness, JournalDatabase, JournalGame, JournalGameMode, JournalJobFilter, JournalOutcome, JournalTripDetail, JournalTripPage, JournalTripsQuery, JournalTripTotals, RecordingHealth, UnitProfiles
} from '../../../packages/contracts/src';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {
  journalBannerText, journalDetailText, journalErrorText, journalEventText, journalExportText, journalIntervalText, journalListText, journalSampleText, type JournalTextOptions
} from './journal-view';
import {getJobMarketText, JOURNAL_COMPLETENESS_TEXT, JOURNAL_EXPORT_STRINGS, JOURNAL_GAME_MODE_TEXT, JOURNAL_GAME_TEXT, JOURNAL_LABEL_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_STRINGS} from './strings';
import {copyTable} from './screens/app-copy';
import {ACTIVE_CHANNEL} from './channel';
import {ShellSlot} from './shell/shell-slots';
import {TripTable, type JournalOpenTrip} from './journal-table';
import {TripCompleteness, TripFields, TripHeading, TripKpis, TripSide, TripTimelineList} from './trip-details';
import type {JournalSyncRow} from '../../../packages/contracts/src/journal';
const JournalLanguage = React.createContext<AppLanguage>('en');
const baseCopy = {JOURNAL_COMPLETENESS_TEXT, JOURNAL_EXPORT_STRINGS, JOURNAL_GAME_MODE_TEXT, JOURNAL_GAME_TEXT, JOURNAL_LABEL_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_STRINGS};
const journalCopy = {en: baseCopy, ru: copyTable(baseCopy, 'ru')};
const useJournalCopy = () => journalCopy[React.useContext(JournalLanguage)];

/**
 * The Journal tab (ET-016 PR-4, J12; compact list ET-076): a paged trip list with filters and one trip's detail, both thin maps over the pure
 * texts of journal-view.ts. It reads only through the five journal bridge methods and holds one page of each list at a
 * time; Next and Previous walk a stack of cursors. Since PR-5 a trip's detail has an Export button, which calls the sixth
 * method; main owns the Save dialog and the file, and the tab shows only the fixed result text. Nothing refreshes by itself: a list loads when it opens and on
 * Refresh. A synthetic or replay database shows a persistent banner (J3). There are no React component tests (B4); the
 * texts are unit-tested in tests/unit/journal-view.test.ts and the tab is exercised by the journal runtime smoke.
 */
type Loaded<T> = {state: 'loading'} | {state: 'error'; text: (language: AppLanguage) => string} | {state: 'value'; value: T};
interface Paged {database: JournalDatabase; nextCursor: string | null}
type Read<T> = (cursor: string | undefined) => Promise<JournalCallResult<T>>;

/**
 * One paged read: the cursor stack, the current page and its loading state. Only the latest request may set the page,
 * so a slow answer to an earlier page is dropped. Each answer reports its database to `onDatabase` for the banner.
 */
function usePagedRead<T extends Paged>(read: Read<T>, onDatabase: (database: JournalDatabase) => void) {
  const [view, setView] = useState<{cursors: (string | undefined)[]; loaded: Loaded<T>}>({cursors: [undefined], loaded: {state: 'loading'}});
  const latest = useRef(0);
  const apply = useCallback((id: number, cursors: (string | undefined)[]) => [
    (result: JournalCallResult<T>) => {
      if (id !== latest.current) return;
      if (result.ok) onDatabase(result.value.database);
      setView({cursors, loaded: result.ok ? {state: 'value', value: result.value} : {state: 'error', text: language => journalErrorText(result, language)}});
    },
    () => { if (id === latest.current) setView({cursors, loaded: {state: 'error', text: language => journalCopy[language].JOURNAL_STRINGS.requestRefused}}); }
  ] as const, [onDatabase]);
  // The first page loads when the list opens; the initial state is already `loading`. Unmounting drops the answer.
  useEffect(() => {
    const requests = latest, id = ++requests.current;
    void read(undefined).then(...apply(id, [undefined]));
    return () => { requests.current++; };
  }, [read, apply]);
  const load = (cursors: (string | undefined)[]) => {
    const id = ++latest.current;
    setView({cursors, loaded: {state: 'loading'}});
    void read(cursors.at(-1)).then(...apply(id, cursors));
  };
  const page = view.loaded.state === 'value' ? view.loaded.value : undefined;
  return {
    loaded: view.loaded, number: view.cursors.length,
    refresh: () => load(view.cursors),
    next: page?.nextCursor ? () => load([...view.cursors, page.nextCursor ?? undefined]) : undefined,
    previous: view.cursors.length > 1 ? () => load(view.cursors.slice(0, -1)) : undefined
  };
}

function Status<T>({loaded, testId}: {loaded: Loaded<T>; testId: string}) {
  const {JOURNAL_STRINGS} = useJournalCopy(), language = React.useContext(JournalLanguage);
  if (loaded.state === 'loading') return <p role="status" data-testid={`${testId}-loading`}>{JOURNAL_STRINGS.loading}</p>;
  if (loaded.state === 'error') return <Alert variant="destructive"><AlertDescription data-testid={`${testId}-error`}>{loaded.text(language)}</AlertDescription></Alert>;
  return null;
}
function Pager({paged, testId}: {paged: ReturnType<typeof usePagedRead>; testId: string}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  const busy = paged.loaded.state === 'loading';
  return <div className="flex flex-wrap items-center gap-2">
    <Button size="sm" variant="outline" disabled={busy || !paged.previous} onClick={paged.previous} data-testid={`${testId}-previous`}>{JOURNAL_STRINGS.previous}</Button>
    <Button size="sm" variant="outline" disabled={busy || !paged.next} onClick={paged.next} data-testid={`${testId}-next`}>{JOURNAL_STRINGS.next}</Button>
    <Button size="sm" variant="outline" disabled={busy} onClick={paged.refresh} data-testid={`${testId}-refresh`}>{JOURNAL_STRINGS.refresh}</Button>
    <span className="text-xs text-muted-foreground" data-testid={`${testId}-page`}>{JOURNAL_STRINGS.pageNote.replace('{page}', String(paged.number))}</span>
  </div>;
}

interface Filters {game?: JournalGame; outcome?: JournalOutcome; completeness?: JournalCompleteness; mode?: JournalGameMode['mode']; jobType?: JournalJobFilter}
/** A query with only the filters that are set; the preload refuses unknown keys. */
function tripsQuery(filters: Filters, cursor: string | undefined): JournalTripsQuery {
  return {...(cursor ? {cursor} : {}), ...(filters.game ? {game: filters.game} : {}), ...(filters.outcome ? {outcome: filters.outcome} : {}),
    ...(filters.completeness ? {completeness: filters.completeness} : {}), ...(filters.mode ? {mode: filters.mode} : {}), ...(filters.jobType ? {jobType: filters.jobType} : {})};
}
/** Radix Select items cannot have an empty value, so the "any" item (no filter) is this fixed item value. */
const ALL = 'all';
function FilterSelect<T extends string>({label, any, value, options, text, onChange, testId}: {
  label: string; any: string; value: T | undefined; options: readonly T[]; text: Readonly<Record<T, string>>; onChange: (value: T | undefined) => void; testId: string;
}) {
  return <Select value={value ?? ALL} onValueChange={next => onChange(options.find(option => option === next))}>
    <SelectTrigger size="sm" aria-label={label} data-testid={testId}><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem value={ALL}>{any}</SelectItem>
      {options.map(option => <SelectItem key={option} value={option}>{text[option]}</SelectItem>)}
    </SelectContent>
  </Select>;
}

interface Selected {tripUuid: string; game: JournalGame; site: JournalSiteFacts | null}
function TripList({filters, options, recording, onDatabase, onOpen, uploadStatus, visible, pageNoteSlot}: {
  uploadStatus?: DashboardUploadStatus | null; filters: Filters; options: JournalTextOptions; recording: RecordingHealth['state'] | undefined;
  onDatabase: (database: JournalDatabase) => void; onOpen: (trip: Selected) => void;
  /** False while a trip is open: the mounted list keeps its page, but its top-bar Refresh and totals line go away. */
  visible: boolean;
  /** The toolbar element that shows this list's page note. */
  pageNoteSlot: HTMLElement | null;
}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  const language = options.language ?? 'en';
  const {game, outcome, completeness, mode, jobType} = filters;
  const read = useCallback<Read<JournalTripPage>>(cursor => window.desktop.listJournalTrips(tripsQuery({game, outcome, completeness, mode, jobType}, cursor)), [game, outcome, completeness, mode, jobType]);
  const paged = usePagedRead(read, onDatabase);
  const filtered = game !== undefined || outcome !== undefined || completeness !== undefined || mode !== undefined || jobType !== undefined;
  const page = paged.loaded.state === 'value' ? paged.loaded.value : undefined;
  // The answer without a cursor carries the totals; the later pages of the list keep showing them.
  const [totals, setTotals] = useState<JournalTripTotals>();
  if (page?.totals && page.totals !== totals) setTotals(page.totals);
  const sync = journalPageSync(page, uploadStatus);
  const text = paged.loaded.state === 'value' ? journalListText(paged.loaded.value, {...options, filtered, recording, firstPage: paged.number === 1}) : undefined;
  const busy = paged.loaded.state === 'loading';
  const range = page ? journalRangeText(paged.number, page.trips.length, language) : null;
  const open = (trip: JournalOpenTrip) => onOpen({...trip, site: journalSiteFacts(page, uploadStatus, trip.tripUuid)});
  return <div data-testid="journal-list">
    {visible ? <ShellSlot name="actions"><Button size="sm" variant="outline" disabled={busy} onClick={paged.refresh} data-testid="journal-list-refresh"><RefreshCw aria-hidden="true" />{JOURNAL_STRINGS.refresh}</Button></ShellSlot> : null}
    {visible && totals && paged.loaded.state !== 'error' ? <ShellSlot name="subline"><p className="yu-page-sub" data-testid="journal.count">{journalTotalsText(totals, language)}</p></ShellSlot> : null}
    {pageNoteSlot ? createPortal(<span data-testid="journal-list-page">{t('j.page', {p: paged.number}, language)}</span>, pageNoteSlot) : null}
    <section className="yu-journal-card" aria-label={t('j.tripsTable', undefined, language)}>
      <Status loaded={paged.loaded} testId="journal-list" />
      {text?.empty ? <div className="yu-journal-empty" data-testid="journal-empty-block"><p data-testid="journal-empty">{text.empty}</p>
        {text.emptyNote ? <p className="text-muted-foreground" data-testid="journal-empty-note">{text.emptyNote}</p> : null}</div> : null}
      {text?.rows.length ? <TripTable rows={text.rows} sync={sync} language={language} onOpen={open} /> : null}
      <div className="yu-journal-footer"><span data-testid="journal-list-footer">{sync ? t('j.syncNote', undefined, language) : range}</span>
        <Button size="sm" variant="outline" disabled={busy || !paged.previous} onClick={paged.previous} data-testid="journal-list-previous">{JOURNAL_STRINGS.previous}</Button>
        <Button size="sm" variant="outline" disabled={busy || !paged.next} onClick={paged.next} data-testid="journal-list-next">{JOURNAL_STRINGS.next}</Button></div>
    </section>
  </div>;
}

function Intervals({trip, options, onDatabase}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void}) {
  const {JOURNAL_LABEL_TEXT} = useJournalCopy();
  const {tripUuid} = trip;
  const read = useCallback((cursor: string | undefined) => window.desktop.listJournalIntervals(tripUuid, cursor), [tripUuid]);
  const paged = usePagedRead(read, onDatabase);
  const text = paged.loaded.state === 'value' ? journalIntervalText(paged.loaded.value, {...options, firstPage: paged.number === 1}) : undefined;
  return <div className="yu-trip-panel" data-testid="journal-intervals">
    <Status loaded={paged.loaded} testId="journal-intervals" />
    {text ? <p data-testid="journal-intervals-total">{text.total}</p> : null}
    {text?.empty ? <p data-testid="journal-intervals-empty">{text.empty}</p> : null}
    {text?.rows.length ? <Table><TableHeader><TableRow><TableHead>{JOURNAL_LABEL_TEXT.kind}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.cause}</TableHead>
      <TableHead>{JOURNAL_LABEL_TEXT.start}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.end}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.events}</TableHead></TableRow></TableHeader>
    <TableBody>{text.rows.map(row => <TableRow key={row.id} data-testid="journal-interval-row">
      <TableCell>{row.kind}</TableCell><TableCell>{row.cause}</TableCell><TableCell>{row.start}</TableCell><TableCell>{row.end}</TableCell><TableCell>{row.events}</TableCell>
    </TableRow>)}</TableBody></Table> : null}
    <Pager paged={paged} testId="journal-intervals" />
  </div>;
}

/**
 * The events of one page with the trip's gaps and refuels between them. A page's upper bound is kept for the page after it,
 * because the pager re-reads pages and holds only the current one; labels may not grow, so `journalPageBound` keeps each bound at or above the last and every gap lands on one page.
 */
function Timeline({trip, options, onDatabase, intervals}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void; intervals: JournalTripDetail['intervals']}) {
  const language = options.language ?? 'en';
  const {tripUuid, game} = trip;
  const read = useCallback((cursor: string | undefined) => window.desktop.listJournalEvents(tripUuid, cursor), [tripUuid]);
  const paged = usePagedRead(read, onDatabase);
  const [pageBounds, setPageBounds] = useState<Readonly<Record<number, number | null>>>({});
  const page = paged.loaded.state === 'value' ? paged.loaded.value : undefined;
  const after = paged.number > 1 ? pageBounds[paged.number - 1] ?? null : null;
  const through = page ? journalPageBound(page, after) : null;
  if (page && pageBounds[paged.number] !== through) setPageBounds(bounds => ({...bounds, [paged.number]: through}));
  const text = page ? journalEventText(page, trip, {...options, firstPage: paged.number === 1}) : undefined;
  const items = page && text ? journalTimelineItems(page, text, intervals.items, {after, through}, game, options) : [];
  return <div className="yu-trip-panel" data-testid="journal-timeline">
    <Status loaded={paged.loaded} testId="journal-events" />
    {text ? <p className="yu-trip-note" data-testid="journal-window">{text.window}</p> : null}
    {text?.empty ? <p data-testid="journal-events-empty">{text.empty}</p> : null}
    {items.length ? <TripTimelineList items={items} /> : null}
    {page && intervals.total > intervals.items.length ? <p className="yu-trip-note" data-testid="trip.timeline.more">{t('tr.intervalsMore', undefined, language)}</p> : null}
    <Pager paged={paged} testId="journal-events" />
  </div>;
}

/**
 * The chart of the current sample page, with that page's table in a collapsed section below it (ET-057). The table is
 * rendered only while the section is open, so a trip's first view does not build up to 300 rows nobody looks at.
 */
function Samples({trip, options, onDatabase}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  const [tableOpen, setTableOpen] = useState(false);
  const {tripUuid, game} = trip;
  const read = useCallback((cursor: string | undefined) => window.desktop.listJournalSamples(tripUuid, cursor), [tripUuid]);
  const paged = usePagedRead(read, onDatabase);
  const text = paged.loaded.state === 'value' ? journalSampleText(paged.loaded.value, game, {...options, firstPage: paged.number === 1}) : undefined;
  return <div className="yu-trip-panel" data-testid="journal-samples">
    <Status loaded={paged.loaded} testId="journal-samples" />
    {paged.loaded.state === 'value' ? <SampleChart samples={paged.loaded.value.samples} game={game} units={options.units} language={options.language} /> : null}
    {text?.empty ? <p data-testid="journal-samples-empty">{text.empty}</p> : null}
    <Pager paged={paged} testId="journal-samples" />
    {text?.rows.length ? <details className="yu-trip-samples" data-testid="trip.samples" onToggle={event => setTableOpen(event.currentTarget.open)}><summary data-testid="trip.samples.toggle"><ChevronRight aria-hidden="true" />{JOURNAL_STRINGS.samplesTab}</summary>{tableOpen ? <Table><TableHeader><TableRow>{text.columns.map(column => <TableHead key={column.label}>{column.label}
      {column.note ? <span className="block text-xs font-normal text-muted-foreground" data-testid="journal-samples-column-note">{column.note}</span> : null}</TableHead>)}</TableRow></TableHeader>
    <TableBody>{text.rows.map(row => row.kind === 'sample'
      ? <TableRow key={row.key} data-testid="journal-sample-row" data-kind="sample">
        {[row.time, row.speed, row.fuel, row.gear, row.rpm, row.odometer, row.range, row.consumption, row.gameTime, row.position].map((cell, index) => <TableCell key={index}>{cell}</TableCell>)}
      </TableRow>
      : <TableRow key={row.key} data-testid="journal-sample-row" data-kind={row.kind}><TableCell colSpan={text.columns.length} className="text-muted-foreground italic">{row.text}</TableCell></TableRow>)}
    </TableBody></Table> : null}</details> : null}
  </div>;
}

/**
 * The trip export (ET-016 PR-5, J16, J18): one button, the fixed result text and the uninstall note. The export runs in
 * main, which answers with a code and row counts only; the button is disabled while it runs. An answer that arrives after
 * the detail closed is dropped.
 */
function ExportTrip({tripUuid, children}: {tripUuid: string; children?: React.ReactNode}) {
  const {JOURNAL_EXPORT_STRINGS} = useJournalCopy(), language = React.useContext(JournalLanguage);
  const [state, setState] = useState<{busy: boolean; result: Awaited<ReturnType<typeof window.desktop.exportJournalTrip>> | 'refused' | null}>({busy: false, result: null});
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const run = () => {
    setState({busy: true, result: null});
    void window.desktop.exportJournalTrip(tripUuid).then(
      result => { if (mounted.current) setState({busy: false, result}); },
      () => { if (mounted.current) setState({busy: false, result: 'refused'}); });
  };
  const result = state.result === null ? null : state.result === 'refused' ? {text: JOURNAL_EXPORT_STRINGS.refused, failed: true} : journalExportText(state.result, language);
  return <div className="yu-trip-export" data-testid="journal-export">
    <div className="yu-trip-actions">
      <Button size="sm" variant="outline" disabled={state.busy} onClick={run} data-testid="journal-export-button"><Download aria-hidden="true" />{state.busy ? JOURNAL_EXPORT_STRINGS.exporting : JOURNAL_EXPORT_STRINGS.button}</Button>
      {children}
      {result ? <span role="status" className={result.failed ? 'text-destructive' : undefined} data-testid="journal-export-result" data-failed={result.failed ? 'true' : 'false'}>
        {result.text}</span> : null}
    </div>
    {/* Data loss on uninstall stays visible next to the only export action (ET-057 keeps such warnings inline). */}
    <p className="yu-trip-note yu-trip-export-note" data-testid="journal-export-note">{JOURNAL_EXPORT_STRINGS.note}</p>
  </div>;
}

/**
 * Staging-only trip deletion action (ET-065). Completely hidden in production builds.
 * Displays a destructive confirmation warning before executing deletion.
 * On success, triggers `onDeleted` to return to the list and refresh it.
 */
function DeleteTrip({tripUuid, onDeleted}: {tripUuid: string; onDeleted?: () => void}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  const language = React.useContext(JournalLanguage);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  if (ACTIVE_CHANNEL !== 'staging') return null;

  const handleDelete = () => {
    setBusy(true);
    setError(null);
    void window.desktop.deleteJournalTrip(tripUuid).then(
      result => {
        if (!mounted.current) return;
        if (result.ok) {
          onDeleted?.();
        } else {
          setBusy(false);
          setError(journalErrorText(result, language));
        }
      },
      () => {
        if (!mounted.current) return;
        setBusy(false);
        setError(JOURNAL_STRINGS.requestRefused);
      }
    );
  };

  if (!confirming) {
    return <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setConfirming(true)} data-testid="journal-delete-button">
      {JOURNAL_STRINGS.deleteTripButton}
    </Button>;
  }

  return <div className="flex flex-wrap items-center gap-2 p-2 border border-destructive/50 rounded-md bg-destructive/10" data-testid="journal-delete-confirmation">
    <span className="text-xs font-medium text-destructive">{JOURNAL_STRINGS.deleteTripWarning}</span>
    <Button size="sm" variant="destructive" disabled={busy} onClick={handleDelete} data-testid="journal-delete-confirm-button">
      {busy ? JOURNAL_STRINGS.deletingTrip : JOURNAL_STRINGS.deleteTripConfirm}
    </Button>
    <Button size="sm" variant="outline" disabled={busy} onClick={() => { setConfirming(false); setError(null); }} data-testid="journal-delete-cancel-button">
      {JOURNAL_STRINGS.deleteTripCancel}
    </Button>
    {error ? <span role="status" className="text-xs text-destructive" data-testid="journal-delete-error">{error}</span> : null}
  </div>;
}

/**
 * One trip's page (ET-077, mockup T4): the header and totals of one detail read, then the tabs beside the side column. Each
 * tab reads when it opens and an inactive tab is unmounted, so it holds no page and a late answer is dropped.
 */
function TripDetail({trip, site, options, onDatabase, onBack, onDeleted}: {trip: Selected; site: JournalSyncRow | null; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void; onBack: () => void; onDeleted?: () => void}) {
  const [tab, setTab] = useState('summary');
  const read = useCallback<Read<JournalTripDetail & {nextCursor: null}>>(
    () => window.desktop.getJournalTrip(trip.tripUuid).then(result => result.ok ? {ok: true, value: {...result.value, nextCursor: null}} : result), [trip.tripUuid]);
  const paged = usePagedRead(read, onDatabase), detail = paged.loaded.state === 'value' ? paged.loaded.value : undefined;
  const {JOURNAL_STRINGS} = useJournalCopy();
  const text = detail ? journalDetailText(detail, options) : undefined, language = options.language ?? 'en';
  const cargoTitle = text?.sections.find(item => item.id === 'job')?.fields.find(field => field.id === 'cargo')?.value ?? '—';
  const tiles = detail ? journalTileValues(detail, options) : undefined, side = detail ? journalTripSideText(detail, options) : undefined;
  return <div className="yu-trip" data-testid="journal-detail" data-trip={trip.tripUuid}>
    <ShellSlot name="actions"><Button size="sm" variant="outline" disabled={paged.loaded.state === 'loading'} onClick={paged.refresh} data-testid="journal-summary-refresh"><RefreshCw aria-hidden="true" />{JOURNAL_STRINGS.refresh}</Button></ShellSlot>
    {text ? <ShellSlot name="breadcrumb"><span className="yu-breadcrumb-separator" aria-hidden="true">/</span><span className="yu-trip-crumb" title={cargoTitle} data-testid="trip.breadcrumb">{cargoTitle}</span></ShellSlot> : null}
    <button type="button" className="yu-trip-back" onClick={onBack} data-testid="journal-back"><ChevronLeft aria-hidden="true" />{t('tr.back', undefined, language)}</button>
    <Status loaded={paged.loaded} testId="journal-summary" />
    <header className="yu-trip-header" data-testid="trip.header">
      {detail && text && side ? <TripHeading game={trip.game} outcome={detail.trip.outcome} isHardMode={detail.trip.isHardMode} cargo={cargoTitle} text={text} side={side} language={language} /> : <div className="yu-trip-heading" />}
      <ExportTrip tripUuid={trip.tripUuid}><DeleteTrip tripUuid={trip.tripUuid} onDeleted={onDeleted} /></ExportTrip>
    </header>
    {detail && text && tiles && side ? <>
      <TripKpis tiles={tiles} outcome={detail.trip.outcome} language={language} />
      <div className="yu-trip-columns">
        <section className="yu-trip-card yu-trip-main" aria-label={t('tr.tabs', undefined, language)}>
          <Tabs value={tab} onValueChange={setTab} className="yu-trip-tabs" data-testid="trip.detailTabs">
            <TabsList variant="line" aria-label={t('tr.tabs', undefined, language)}>
              <TabsTrigger value="summary" data-testid="journal-detail-tab-summary">{t('tr.tab.summary', undefined, language)}</TabsTrigger>
              <TabsTrigger value="timeline" data-testid="journal-detail-tab-timeline">{t('tr.tab.timeline', undefined, language)}</TabsTrigger>
              <TabsTrigger value="intervals" data-testid="journal-detail-tab-intervals">{t('tr.tab.completeness', undefined, language)}</TabsTrigger>
            </TabsList>
            <TabsContent value="summary"><div data-testid="journal-summary"><Samples trip={trip} options={options} onDatabase={onDatabase} /></div></TabsContent>
            <TabsContent value="timeline"><Timeline trip={trip} options={options} onDatabase={onDatabase} intervals={detail.intervals} /></TabsContent>
            <TabsContent value="intervals"><div className="yu-trip-panel"><TripCompleteness text={journalCompletenessText(detail, language)} language={language} /><Intervals trip={trip} options={options} onDatabase={onDatabase} /></div></TabsContent>
          </Tabs>
        </section>
        <TripSide detail={detail} side={side} site={site} language={language} options={options} />
      </div>
      <TripFields sections={text.sections} language={language} />
    </> : null}
  </div>;
}

/**
 * Keeps a render fault of the journal inside its tab: React unmounts the whole tree on an uncaught render error, which
 * would also blank the Live tab. It shows fixed text, never the error. Closing the tab unmounts the boundary, so opening
 * it again retries.
 */
export class JournalBoundary extends React.Component<{children: React.ReactNode; language?: AppLanguage}, {failed: boolean}> {
  override state = {failed: false};
  static getDerivedStateFromError(): {failed: boolean} { return {failed: true}; }
  override render() {
    return this.state.failed ? <Alert variant="destructive"><AlertDescription data-testid="journal-render-failed">{journalCopy[this.props.language ?? 'en'].JOURNAL_STRINGS.renderFailed}</AlertDescription></Alert>
      : this.props.children;
  }
}

const GAMES: readonly (JournalGame | 'all')[] = ['all', 'ets2', 'ats'];
const MODES: readonly JournalGameMode['mode'][] = ['single-player', 'truckersmp', 'haulmp', 'convoy', 'unknown'];
const JOB_TYPES: readonly JournalJobFilter[] = ['quick-job', 'cargo-market', 'freight-market', 'world-of-trucks', 'other'];
const OUTCOMES: readonly JournalOutcome[] = ['open', 'delivered', 'cancelled', 'none'];
const COMPLETENESS: readonly JournalCompleteness[] = ['complete', 'partial', 'unknown'];

export function Journal({units, recording, language, uploadStatus}: {uploadStatus?: DashboardUploadStatus | null; units: UnitProfiles | undefined; recording: RecordingHealth['state'] | undefined; language?: AppLanguage}) {
  const active = language ?? 'en';
  const {JOURNAL_STRINGS, JOURNAL_GAME_TEXT, JOURNAL_GAME_MODE_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_COMPLETENESS_TEXT} = journalCopy[active];
  const [database, setDatabase] = useState<JournalDatabase>();
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<Selected | null>(null);
  const [listVersion, setListVersion] = useState(0);
  const [pageNoteSlot, setPageNoteSlot] = useState<HTMLElement | null>(null);
  const handleDeleted = useCallback(() => {
    setSelected(null);
    setListVersion(v => v + 1);
  }, []);
  const options = useMemo<JournalTextOptions>(() => ({...(units ? {units} : {}), ...(language ? {language} : {})}), [units, language]);
  const banner = journalBannerText(database, language);
  const filterKey = `${filters.game ?? ''}|${filters.outcome ?? ''}|${filters.completeness ?? ''}|${filters.mode ?? ''}|${filters.jobType ?? ''}`;
  const jobTypeText: Readonly<Record<JournalJobFilter, string>> = {'quick-job': getJobMarketText('quick_job', active), 'cargo-market': getJobMarketText('cargo_market', active), 'freight-market': getJobMarketText('freight_market', active),
    'world-of-trucks': t('j.worldOfTrucks', undefined, active), 'other': t('j.jobOther', undefined, active)};
  return <JournalLanguage.Provider value={active}><div className="yu-journal" data-testid="journal">
    {banner ? <Alert variant="destructive"><AlertDescription data-testid="journal-banner">{banner}</AlertDescription></Alert> : null}
    {selected ? <TripDetail key={selected.tripUuid} trip={selected} site={journalSiteRow(selected.site, uploadStatus)} options={options} onDatabase={setDatabase} onBack={() => setSelected(null)} onDeleted={handleDeleted} /> : null}
    {/* The list stays mounted, hidden, while a trip is open, so Back returns to the same page without reading it again. */}
    <div className="yu-journal" hidden={selected !== null}>
      <div className="yu-journal-toolbar" role="group" aria-label={t('j.filters', undefined, active)} data-testid="journal-toolbar">
        <div className="yu-segmented" role="group" aria-label={JOURNAL_STRINGS.gameFilter}>
          {GAMES.map(game => <button key={game} type="button" aria-pressed={(filters.game ?? 'all') === game} data-testid={`journal-filter-game-${game}`}
            onClick={() => setFilters(current => ({...current, game: game === 'all' ? undefined : game}))}>{game === 'all' ? t('j.all', undefined, active) : JOURNAL_GAME_TEXT[game]}</button>)}
        </div>
        <FilterSelect label={t('j.mode', undefined, active)} any={t('j.anyMode', undefined, active)} value={filters.mode} options={MODES} text={JOURNAL_GAME_MODE_TEXT} testId="journal-filter-mode"
          onChange={mode => setFilters(current => ({...current, mode}))} />
        <FilterSelect label={t('col.jobType', undefined, active)} any={t('j.anyJobType', undefined, active)} value={filters.jobType} options={JOB_TYPES} text={jobTypeText} testId="journal-filter-job"
          onChange={jobType => setFilters(current => ({...current, jobType}))} />
        <FilterSelect label={JOURNAL_STRINGS.outcomeFilter} any={t('j.anyOutcome', undefined, active)} value={filters.outcome} options={OUTCOMES} text={JOURNAL_OUTCOME_TEXT} testId="journal-filter-outcome"
          onChange={outcome => setFilters(current => ({...current, outcome}))} />
        <FilterSelect label={JOURNAL_STRINGS.completenessFilter} any={t('j.anyRecording', undefined, active)} value={filters.completeness} options={COMPLETENESS} text={JOURNAL_COMPLETENESS_TEXT}
          testId="journal-filter-completeness" onChange={completeness => setFilters(current => ({...current, completeness}))} />
        <span className="yu-journal-note" ref={setPageNoteSlot} />
      </div>
      {/* A filter change starts a new list at its first page. */}
      <TripList key={`${filterKey}|${listVersion}`} uploadStatus={uploadStatus} filters={filters} options={options} recording={recording} onDatabase={setDatabase} onOpen={setSelected} visible={selected === null} pageNoteSlot={pageNoteSlot} />
    </div>
  </div></JournalLanguage.Provider>;
}
