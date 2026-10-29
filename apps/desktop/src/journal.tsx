import {journalTileValues} from './screens/journal-tiles';
import {SampleChart} from './screens/sample-chart';
import {t} from './i18n';
import {HardModeBadge, HardModeTrip} from './hard-mode/card';
import {ArrowLeft, Check, ChevronRight, Circle, X, Route, Fuel, Coins} from 'lucide-react';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {
  AppLanguage, JournalCallResult, JournalCompleteness, JournalDatabase, JournalGame, JournalOutcome, JournalTripDetail, JournalTripPage, JournalTripsQuery, RecordingHealth, UnitProfiles
} from '../../../packages/contracts/src';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Badge} from '@/components/ui/badge';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardTitle} from '@/components/ui/card';
import {Select, SelectContent, SelectItem, SelectTrigger, SelectValue} from '@/components/ui/select';
import {Table, TableBody, TableCell, TableHead, TableHeader, TableRow} from '@/components/ui/table';
import {Tabs, TabsContent, TabsList, TabsTrigger} from '@/components/ui/tabs';
import {
  journalBannerText, journalDetailText, journalErrorText, journalEventText, journalExportText, journalIntervalText, journalListText, journalSampleText, type JournalBadge,
  type JournalTextOptions
} from './journal-view';
import {JOURNAL_COMPLETENESS_TEXT, JOURNAL_EXPORT_STRINGS, JOURNAL_GAME_TEXT, JOURNAL_LABEL_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_STRINGS} from './strings';
import {copyTable} from './screens/app-copy';
import {InfoHint} from './info-hint';
const JournalLanguage = React.createContext<AppLanguage>('en');
const baseCopy = {JOURNAL_COMPLETENESS_TEXT, JOURNAL_EXPORT_STRINGS, JOURNAL_GAME_TEXT, JOURNAL_LABEL_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_STRINGS};
const journalCopy = {en: baseCopy, ru: copyTable(baseCopy, 'ru')};
const useJournalCopy = () => journalCopy[React.useContext(JournalLanguage)];

/**
 * The Journal tab (ET-016 PR-4, J12): a paged trip list with filters and one trip's detail, both thin maps over the pure
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

const completenessBadge = (badge: JournalBadge, testId: string) => <Badge variant={badge.variant === 'secondary' ? 'ok' : badge.variant === 'destructive' ? 'warn' : 'neutral'} data-testid={testId}>{badge.text}</Badge>;
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

interface Filters {game?: JournalGame; outcome?: JournalOutcome; completeness?: JournalCompleteness}
/** A query with only the filters that are set; the preload refuses unknown keys. */
function tripsQuery(filters: Filters, cursor: string | undefined): JournalTripsQuery {
  return {...(cursor ? {cursor} : {}), ...(filters.game ? {game: filters.game} : {}), ...(filters.outcome ? {outcome: filters.outcome} : {}),
    ...(filters.completeness ? {completeness: filters.completeness} : {})};
}
/** Radix Select items cannot have an empty value, so `All` (no filter) is this fixed item value. */
const ALL = 'all';
function FilterSelect<T extends string>({label, value, options, text, onChange, testId}: {
  label: string; value: T | undefined; options: readonly T[]; text: Readonly<Record<T, string>>; onChange: (value: T | undefined) => void; testId: string;
}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  return <div className="flex items-center gap-1 text-sm"><span id={`${testId}-label`}>{label}</span>
    <Select value={value ?? ALL} onValueChange={next => onChange(options.find(option => option === next))}>
      <SelectTrigger size="sm" aria-labelledby={`${testId}-label`} data-testid={testId}><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>{JOURNAL_STRINGS.allFilter}</SelectItem>
        {options.map(option => <SelectItem key={option} value={option}>{text[option]}</SelectItem>)}
      </SelectContent>
    </Select></div>;
}

interface Selected {tripUuid: string; game: JournalGame}
function TripList({filters, options, recording, onDatabase, onOpen}: {
  filters: Filters; options: JournalTextOptions; recording: RecordingHealth['state'] | undefined;
  onDatabase: (database: JournalDatabase) => void; onOpen: (trip: Selected) => void;
}) {
  const {JOURNAL_LABEL_TEXT, JOURNAL_STRINGS} = useJournalCopy();
  const {game, outcome, completeness} = filters;
  const read = useCallback<Read<JournalTripPage>>(cursor => window.desktop.listJournalTrips(tripsQuery({game, outcome, completeness}, cursor)), [game, outcome, completeness]);
  const paged = usePagedRead(read, onDatabase);
  const filtered = game !== undefined || outcome !== undefined || completeness !== undefined;
  const text = paged.loaded.state === 'value' ? journalListText(paged.loaded.value, {...options, filtered, recording, firstPage: paged.number === 1}) : undefined;
  return <div className="space-y-2" data-testid="journal-list">
    <Pager paged={paged} testId="journal-list" />
    <Status loaded={paged.loaded} testId="journal-list" />
    {text?.empty ? <div data-testid="journal-empty-block"><p data-testid="journal-empty">{text.empty}</p>
      {text.emptyNote ? <p className="text-muted-foreground" data-testid="journal-empty-note">{text.emptyNote}</p> : null}</div> : null}
    {text?.rows.length ? <Table data-testid="journal-table"><TableHeader><TableRow>
      <TableHead>{JOURNAL_LABEL_TEXT.started}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.game}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.cargo}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.route}</TableHead>
      <TableHead>{JOURNAL_LABEL_TEXT.observedDistance}</TableHead><TableHead><span className="yu-label-hint">{JOURNAL_LABEL_TEXT.expectedIncome}<InfoHint label={t('ui.moreAbout', {v: JOURNAL_LABEL_TEXT.expectedIncome}, options.language)}>{t('j.incomeNote', undefined, options.language)}</InfoHint></span></TableHead><TableHead>{JOURNAL_LABEL_TEXT.outcome}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.completeness}</TableHead>
      <TableHead>{JOURNAL_LABEL_TEXT.fuelUsed}</TableHead><TableHead />
    </TableRow></TableHeader><TableBody>
      {text.rows.map(row => {const outcome = paged.loaded.state === 'value' ? paged.loaded.value.trips.find(trip => trip.tripUuid === row.tripUuid)?.outcome : undefined;
        const OutcomeIcon = outcome === 'delivered' ? Check : outcome === 'cancelled' ? X : Circle;
        return <TableRow key={row.tripUuid} data-testid="journal-row" data-trip={row.tripUuid}>
          <TableCell data-testid="journal-row-started">{row.started}</TableCell><TableCell data-testid="journal-row-game"><Badge variant={row.gameId}>{row.game}</Badge></TableCell>
          <TableCell data-testid="journal-row-cargo">{row.cargo}{row.isHardMode ? <> <HardModeBadge short language={options.language} /></> : null}</TableCell>
          <TableCell data-testid="journal-row-route">{row.route}</TableCell>
          <TableCell><div data-testid="journal-row-observed">{row.observedDistance}</div><small className="yu-muted" data-testid="journal-row-planned">{row.plannedDistance}</small></TableCell>
          <TableCell><div data-testid="journal-row-expected">{row.expectedIncome}</div></TableCell>
          <TableCell data-testid="journal-row-outcome"><Badge variant={outcome === 'delivered' ? 'ok' : outcome === 'cancelled' ? 'error' : 'neutral'}><OutcomeIcon aria-hidden="true" className="size-3" />{row.outcome}</Badge></TableCell>
          <TableCell>{completenessBadge(row.completeness, 'journal-row-completeness')}</TableCell>
          <TableCell data-testid="journal-row-fuel">{row.fuelUsed}</TableCell>
          <TableCell><Button size="sm" variant="outline" data-testid="journal-row-open" onClick={() => onOpen({tripUuid: row.tripUuid, game: row.gameId})}>{JOURNAL_STRINGS.open}</Button></TableCell>
        </TableRow>;
      })}
    </TableBody></Table> : null}
  </div>;
}

function Summary({trip, options, detail, text, onDatabase}: {trip: Selected; options: JournalTextOptions; detail: JournalTripDetail; text: ReturnType<typeof journalDetailText>; onDatabase: (database: JournalDatabase) => void}) {
  return <div className="space-y-3 yu-trip-summary" data-testid="journal-summary">
    <div className="yu-summary-chart"><Samples trip={trip} options={options} onDatabase={onDatabase} /></div>
    <div className="yu-trip-section" data-testid="trip.hardMode"><HardModeTrip qualified={detail.trip.isHardMode} details={detail.trip.hardModeDetails} language={options.language} /></div>
      {text.sections.map(section => <section key={section.id} className="space-y-1 yu-trip-section" data-testid={`journal-section-${section.id}`}>
        <h4 className="font-medium">{section.title}</h4>
        {section.fields.length ? <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          {section.fields.map(field => <div key={field.id} className="contents">
            <dt>{field.label}{field.note ? <span className="text-xs text-muted-foreground"> ({field.note})</span> : null}</dt>
            <dd data-testid={`journal-field-${section.id}-${field.id}`}>{field.value}</dd>
          </div>)}
        </dl> : null}
        {section.notes.map(note => <p key={note} className="text-xs text-muted-foreground" data-testid={`journal-section-${section.id}-note`}>{note}</p>)}
      </section>)}
  </div>;
}

function Intervals({trip, options, onDatabase}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void}) {
  const {JOURNAL_LABEL_TEXT} = useJournalCopy();
  const {tripUuid} = trip;
  const read = useCallback((cursor: string | undefined) => window.desktop.listJournalIntervals(tripUuid, cursor), [tripUuid]);
  const paged = usePagedRead(read, onDatabase);
  const text = paged.loaded.state === 'value' ? journalIntervalText(paged.loaded.value, {...options, firstPage: paged.number === 1}) : undefined;
  return <div className="space-y-2" data-testid="journal-intervals">
    <Pager paged={paged} testId="journal-intervals" /><Status loaded={paged.loaded} testId="journal-intervals" />
    {text ? <p data-testid="journal-intervals-total">{text.total}</p> : null}
    {text?.empty ? <p data-testid="journal-intervals-empty">{text.empty}</p> : null}
    {text?.rows.length ? <Table><TableHeader><TableRow><TableHead>{JOURNAL_LABEL_TEXT.kind}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.cause}</TableHead>
      <TableHead>{JOURNAL_LABEL_TEXT.start}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.end}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.events}</TableHead></TableRow></TableHeader>
    <TableBody>{text.rows.map(row => <TableRow key={row.id} data-testid="journal-interval-row">
      <TableCell>{row.kind}</TableCell><TableCell>{row.cause}</TableCell><TableCell>{row.start}</TableCell><TableCell>{row.end}</TableCell><TableCell>{row.events}</TableCell>
    </TableRow>)}</TableBody></Table> : null}
  </div>;
}

function Timeline({trip, options, onDatabase}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void}) {
  const {JOURNAL_LABEL_TEXT} = useJournalCopy();
  const {tripUuid} = trip;
  const read = useCallback((cursor: string | undefined) => window.desktop.listJournalEvents(tripUuid, cursor), [tripUuid]);
  const paged = usePagedRead(read, onDatabase);
  const text = paged.loaded.state === 'value' ? journalEventText(paged.loaded.value, trip, {...options, firstPage: paged.number === 1}) : undefined;
  return <div className="space-y-2" data-testid="journal-timeline">
    <Pager paged={paged} testId="journal-events" /><Status loaded={paged.loaded} testId="journal-events" />
    {text ? <p data-testid="journal-window">{text.window}</p> : null}
    {text?.empty ? <p data-testid="journal-events-empty">{text.empty}</p> : null}
    {text?.rows.length ? <Table><TableHeader><TableRow><TableHead>{JOURNAL_LABEL_TEXT.eventSeq}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.time}</TableHead>
      <TableHead>{JOURNAL_LABEL_TEXT.type}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.detail}</TableHead><TableHead>{JOURNAL_LABEL_TEXT.attribution}</TableHead></TableRow></TableHeader>
    <TableBody>{text.rows.map(row => <TableRow key={row.eventSeq} data-testid="journal-event-row" data-event-seq={row.eventSeq}>
      <TableCell>{row.eventSeq}</TableCell><TableCell>{row.time}</TableCell><TableCell>{row.type}</TableCell><TableCell>{row.detail}</TableCell><TableCell>{row.attribution}</TableCell>
    </TableRow>)}</TableBody></Table> : null}
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
  return <div className="space-y-2" data-testid="journal-samples">
    <Pager paged={paged} testId="journal-samples" /><Status loaded={paged.loaded} testId="journal-samples" />
    {paged.loaded.state === 'value' ? <SampleChart samples={paged.loaded.value.samples} game={game} units={options.units} language={options.language} /> : null}
    {text?.empty ? <p data-testid="journal-samples-empty">{text.empty}</p> : null}
    {text?.rows.length ? <details className="yu-trip-raw" data-testid="trip.samples" onToggle={event => setTableOpen(event.currentTarget.open)}><summary data-testid="trip.samples.toggle"><ChevronRight aria-hidden="true" />{JOURNAL_STRINGS.samplesTab}</summary>{tableOpen ? <Table><TableHeader><TableRow>{text.columns.map(column => <TableHead key={column.label}>{column.label}
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
function ExportTrip({tripUuid}: {tripUuid: string}) {
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
  return <div className="space-y-1" data-testid="journal-export">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={state.busy} onClick={run} data-testid="journal-export-button">{state.busy ? JOURNAL_EXPORT_STRINGS.exporting : JOURNAL_EXPORT_STRINGS.button}</Button>
      <InfoHint label={t('ui.moreAbout', {v: JOURNAL_EXPORT_STRINGS.button}, language)} align="end" testId="journal-export-note">{JOURNAL_EXPORT_STRINGS.note}</InfoHint>
      {result ? <span role="status" className={result.failed ? 'text-destructive' : undefined} data-testid="journal-export-result" data-failed={result.failed ? 'true' : 'false'}>
        {result.text}</span> : null}
    </div>
  </div>;
}

function TripDetail({trip, options, onDatabase, onBack}: {trip: Selected; options: JournalTextOptions; onDatabase: (database: JournalDatabase) => void; onBack: () => void}) {
  const {JOURNAL_STRINGS} = useJournalCopy();
  const read = useCallback<Read<JournalTripDetail & {nextCursor: null}>>(
    () => window.desktop.getJournalTrip(trip.tripUuid).then(result => result.ok ? {ok: true, value: {...result.value, nextCursor: null}} : result), [trip.tripUuid]);
  const paged = usePagedRead(read, onDatabase), detail = paged.loaded.state === 'value' ? paged.loaded.value : undefined;
  const text = detail ? journalDetailText(detail, options) : undefined, language = options.language ?? 'en';
  const value = (section: string, id: string) => text?.sections.find(item => item.id === section)?.fields.find(field => field.id === id)?.value ?? '—';
  const cargoTitle = value('job', 'cargo'), tiles = detail ? journalTileValues(detail, options) : undefined;
  return <div className="space-y-3" data-testid="journal-detail" data-trip={trip.tripUuid}>
    <header className="yu-trip-header" data-testid="trip.header">
      <div className="yu-trip-actions"><Button size="sm" variant="ghost" onClick={onBack} data-testid="journal-back"><ArrowLeft className="size-4" aria-hidden="true" />{JOURNAL_STRINGS.back}</Button>
        <Button size="sm" variant="outline" disabled={paged.loaded.state === 'loading'} onClick={paged.refresh} data-testid="journal-summary-refresh">{JOURNAL_STRINGS.refresh}</Button></div>
      <Status loaded={paged.loaded} testId="journal-summary" />
      {text && detail ? <><div className="flex flex-wrap gap-2 items-center"><Badge variant={trip.game}>{trip.game.toUpperCase()}</Badge><Badge variant={detail.trip.outcome === 'delivered' ? 'ok' : detail.trip.outcome === 'cancelled' ? 'error' : 'neutral'} data-testid="journal-detail-outcome">{text.outcome}</Badge>
        {completenessBadge(text.completeness, 'journal-detail-completeness')}{detail.trip.isHardMode ? <HardModeBadge language={language} /> : null}</div>
        <h2 data-testid="trip.header.cargo">{cargoTitle}</h2><p data-testid="journal-detail-title">{text.title}</p>
        <p className="yu-muted">{value('job', 'sourceCompany')} → {value('job', 'destinationCompany')} · {value('trip', 'started')}</p>
      </> : null}
      <ExportTrip tripUuid={trip.tripUuid} />
    </header>
    {text && tiles ? <div className="yu-trip-tiles" data-testid="trip.tiles">
      <div className="yu-trip-tile yu-tile-distance"><span><Route aria-hidden="true" />{t('tr.distance', undefined, language)}</span><strong>{tiles.distance.value}</strong>{tiles.distance.note ? <small>{tiles.distance.note}</small> : null}<small>{t('tr.planned', {v: value('distance', 'plannedDistance')}, language)}</small><small>{t('tr.delivered', {v: value('distance', 'deliveredDistance')}, language)}</small></div>
      <div className="yu-trip-tile yu-tile-money"><span><Coins aria-hidden="true" />{detail?.trip.outcome === 'cancelled' ? t('tr.penalty', undefined, language) : t('tr.revenue', undefined, language)}</span><strong>{tiles.money.value}</strong><small>{tiles.money.note}</small><small>{t('tr.expected', {v: value('money', 'expectedIncome')}, language)}</small></div>
      <div className="yu-trip-tile"><span><Fuel aria-hidden="true" />{t('tr.fuel', undefined, language)}<InfoHint label={t('ui.moreAbout', {v: t('tr.fuel', undefined, language)}, language)}>{t('tr.fuelNote', undefined, language)}</InfoHint></span><strong>{tiles.fuel.value}</strong>{tiles.fuel.note ? <small>{tiles.fuel.note}</small> : null}</div>
    </div> : null}
    {text && detail ? <Summary trip={trip} options={options} detail={detail} text={text} onDatabase={onDatabase} /> : null}
    {/* ET-057: the raw intervals, events and samples are a collapsed section, not the trip's first view. Each tab reads when
        it opens; an inactive tab is unmounted and holds no page. */}
    <details className="yu-trip-raw" data-testid="trip.raw"><summary data-testid="trip.raw.toggle"><ChevronRight aria-hidden="true" />{t('tr.raw', undefined, language)}</summary>
    <Tabs defaultValue="intervals" data-testid="trip.detailTabs">
      <TabsList>
        <TabsTrigger value="intervals" data-testid="journal-detail-tab-intervals">{JOURNAL_STRINGS.intervalsTab}</TabsTrigger>
        <TabsTrigger value="timeline" data-testid="journal-detail-tab-timeline">{JOURNAL_STRINGS.timelineTab}</TabsTrigger>
      </TabsList>
      <TabsContent value="intervals"><Intervals trip={trip} options={options} onDatabase={onDatabase} /></TabsContent>
      <TabsContent value="timeline"><Timeline trip={trip} options={options} onDatabase={onDatabase} /></TabsContent>
    </Tabs></details>
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

const GAMES: readonly JournalGame[] = ['ets2', 'ats'];
const OUTCOMES: readonly JournalOutcome[] = ['open', 'delivered', 'cancelled', 'none'];
const COMPLETENESS: readonly JournalCompleteness[] = ['complete', 'partial', 'unknown'];

export function Journal({units, recording, language}: {units: UnitProfiles | undefined; recording: RecordingHealth['state'] | undefined; language?: AppLanguage}) {
  const {JOURNAL_STRINGS, JOURNAL_GAME_TEXT, JOURNAL_OUTCOME_TEXT, JOURNAL_COMPLETENESS_TEXT} = journalCopy[language ?? 'en'];
  const [database, setDatabase] = useState<JournalDatabase>();
  const [filters, setFilters] = useState<Filters>({});
  const [selected, setSelected] = useState<Selected | null>(null);
  const options = useMemo<JournalTextOptions>(() => ({...(units ? {units} : {}), ...(language ? {language} : {})}), [units, language]);
  const banner = journalBannerText(database, language);
  const filterKey = `${filters.game ?? ''}|${filters.outcome ?? ''}|${filters.completeness ?? ''}`;
  return <JournalLanguage.Provider value={language ?? 'en'}><Card size="sm" data-testid="journal"><CardHeader hidden={selected !== null}><CardTitle><h2>{JOURNAL_STRINGS.title}</h2></CardTitle></CardHeader>
    <CardContent className="space-y-3">
      {banner ? <Alert variant="destructive"><AlertDescription data-testid="journal-banner">{banner}</AlertDescription></Alert> : null}
      {selected ? <TripDetail key={selected.tripUuid} trip={selected} options={options} onDatabase={setDatabase} onBack={() => setSelected(null)} /> : null}
      {/* The list stays mounted, hidden, while a trip is open, so Back returns to the same page without reading it again. */}
      <div className="space-y-3" hidden={selected !== null}>
        <div className="flex flex-wrap gap-3 yu-journal-filters">
          <FilterSelect label={JOURNAL_STRINGS.gameFilter} value={filters.game} options={GAMES} text={JOURNAL_GAME_TEXT} testId="journal-filter-game"
            onChange={game => setFilters(current => ({...current, game}))} />
          <FilterSelect label={JOURNAL_STRINGS.outcomeFilter} value={filters.outcome} options={OUTCOMES} text={JOURNAL_OUTCOME_TEXT} testId="journal-filter-outcome"
            onChange={outcome => setFilters(current => ({...current, outcome}))} />
          <FilterSelect label={JOURNAL_STRINGS.completenessFilter} value={filters.completeness} options={COMPLETENESS} text={JOURNAL_COMPLETENESS_TEXT}
            testId="journal-filter-completeness" onChange={completeness => setFilters(current => ({...current, completeness}))} />
        </div>
        {/* A filter change starts a new list at its first page. */}
        <TripList key={filterKey} filters={filters} options={options} recording={recording} onDatabase={setDatabase} onOpen={setSelected} />
      </div>
    </CardContent></Card></JournalLanguage.Provider>;
}
