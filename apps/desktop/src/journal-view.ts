import type {
  AppLanguage, JournalCallResult, JournalDatabase, JournalExportResult, JournalEvent, JournalEventPage, JournalGame, JournalGameMode, JournalInterval, JournalIntervalPage, JournalMoneyTotals,
  JournalSample, JournalSamplePage, JournalTripDetail, JournalTripListItem, JournalTripPage, JournalWindow, RecordingHealth, UnitProfiles
} from '../../../packages/contracts/src';
import type {Currency, EventRecord, Money, UnavailableReason} from '../../../packages/contracts/src/protocol-v1';
import {resolveDisplayUnits, type DisplayUnits} from '../../../packages/telemetry-core/src/display-profile';
import {
  formatConsumption as coreFormatConsumption, formatDistance as coreFormatDistance, formatGear, formatMass as coreFormatMass, formatMoney as coreFormatMoney, formatPercent, formatPosition, formatRpm as coreFormatRpm,
  formatSpeed as coreFormatSpeed, formatVolume as coreFormatVolume
} from '../../../packages/telemetry-core/src/format';
import type {MoneyCurrency} from '../../../packages/telemetry-core/src/readings';
import * as BASE_COPY from './strings';
import {copyTable, localizedMeasurement} from './screens/app-copy';
import {DEFAULT_UNIT_PROFILES} from './unit-profiles';
import {formatLocalizedBoolean, formatLocalizedGameDuration, formatLocalizedGameTime} from './i18n';

// Text of the trip journal (ET-016 PR-4, J12-J14): every string the Journal tab shows, built from one journal page or
// trip detail at a time. Pure, safe for renderer bundles and plain Node tests: type imports, telemetry-core formatting
// and the fixed texts of strings.ts only. Values arrive in canonical units and are converted here to the trip's own
// game profile (ETS2 metric, ATS US customary by default). An unavailable value is always `unavailable (reason)`, never
// zero; outcome and recording completeness are separate; distances and money kinds are never mixed, and money is never
// converted, netted or added across currencies. There is no trip average consumption (J21). See docs/journal.md.

export interface JournalTextOptions {
  /** The per-game display profiles; the ET-000 defaults until main sends the saved settings. */
  units?: UnitProfiles;
  /** The IANA time zone of the clock times; the system's local zone when absent. Tests pass a fixed zone. */
  timeZone?: string;
  /**
   * Whether the page is the first of its list (read without a cursor); true when absent. A read sets its next cursor
   * whenever a page is full, so a later page can be empty: it then says that nothing more follows, never that nothing
   * was recorded.
   */
  firstPage?: boolean;
  /** The user's active UI language. */
  language?: AppLanguage;
}
/** One labelled value. `note` says what the value means, such as "job offer, excludes ferries". */
export interface JournalField {id: string; label: string; value: string; note?: string}
export interface JournalSection {id: string; title: string; fields: JournalField[]; notes: string[]}
/** A badge's text and shadcn variant. */
export interface JournalBadge {text: string; variant: 'secondary' | 'destructive' | 'outline'}

export interface JournalTripRow {
  tripUuid: string; isHardMode: boolean; gameId: JournalGame; started: string; game: string; route: string; cargo: string;
  /** `Delivered`, `Cancelled`, `In progress` or `No outcome — <why it closed>`. */
  outcome: string;
  /** Recording completeness, always shown as its own badge. */
  completeness: JournalBadge;
  plannedDistance: string; observedDistance: string; fuelUsed: string; expectedIncome: string;
}
export interface JournalListText {rows: JournalTripRow[]; empty: string | null; emptyNote: string | null; hasNext: boolean}
export interface JournalDetailText {title: string; outcome: string; completeness: JournalBadge; sections: JournalSection[]}
export interface JournalIntervalRow {id: string; kind: string; cause: string; start: string; end: string; events: string}
export interface JournalIntervalText {total: string; rows: JournalIntervalRow[]; empty: string | null; hasNext: boolean}
export interface JournalEventRow {eventSeq: string; time: string; type: string; detail: string; attribution: string}
export interface JournalEventText {window: string; rows: JournalEventRow[]; empty: string | null; hasNext: boolean}
export type JournalSampleRow =
  | {kind: 'gap'; key: string; text: string}
  | {kind: 'restart'; key: string; text: string}
  | {kind: 'sample'; key: string; time: string; speed: string; fuel: string; consumption: string; range: string; rpm: string; gear: string; odometer: string;
    gameTime: string; position: string};
/** A column heading of the sample table; `note` says what its values are, such as the SDK mean. */
export interface JournalColumn {label: string; note?: string}
export interface JournalSampleText {columns: JournalColumn[]; rows: JournalSampleRow[]; empty: string | null; hasNext: boolean}

type JournalFailure = Extract<JournalCallResult<unknown>, {ok: false}>;
type Avail<T> = {available: true; value: T} | {available: false; reason: UnavailableReason};

function createJournalText(language: AppLanguage) {
 const formatVolume = (...args: Parameters<typeof coreFormatVolume>) => localizedMeasurement(coreFormatVolume(...args), language);

 const formatSpeed = (...args: Parameters<typeof coreFormatSpeed>) => localizedMeasurement(coreFormatSpeed(...args), language);

 const formatRpm = (...args: Parameters<typeof coreFormatRpm>) => localizedMeasurement(coreFormatRpm(...args), language);

 const formatMoney = (...args: Parameters<typeof coreFormatMoney>) => localizedMeasurement(coreFormatMoney(...args), language);

 const formatMass = (...args: Parameters<typeof coreFormatMass>) => localizedMeasurement(coreFormatMass(...args), language);

 const formatDistance = (...args: Parameters<typeof coreFormatDistance>) => localizedMeasurement(coreFormatDistance(...args), language);

 const formatConsumption = (...args: Parameters<typeof coreFormatConsumption>): ReturnType<typeof coreFormatConsumption> => {const result = coreFormatConsumption(...args); return 'text' in result ? {text: localizedMeasurement(result.text, language)} : result;};

  const {JOURNAL_ATTRIBUTION_TEXT, JOURNAL_CLOSE_REASON_TEXT, JOURNAL_COMPLETENESS_TEXT, JOURNAL_ERROR_TEXT, JOURNAL_EVENT_TYPE_TEXT, JOURNAL_EXPORT_ERROR_TEXT, JOURNAL_EXPORT_STRINGS, JOURNAL_GAME_MODE_EVIDENCE_TEXT, JOURNAL_GAME_MODE_TEXT, JOURNAL_GAME_TEXT, JOURNAL_INTERVAL_CAUSE_TEXT, JOURNAL_INTERVAL_KIND_TEXT, JOURNAL_JOB_SOURCE_TEXT, JOURNAL_LABEL_TEXT, JOURNAL_MONEY_CATEGORY_TEXT, JOURNAL_NOTE_TEXT, JOURNAL_OPENED_BY_TEXT, JOURNAL_OTHER_CAUSE, JOURNAL_OUTCOME_TEXT, JOURNAL_PURPOSE_TEXT, JOURNAL_REASON_TEXT, JOURNAL_SECTION_TEXT, JOURNAL_STRINGS, UNIT_GAME_TEXT} = copyTable(BASE_COPY, language);
const fill = (template: string, values: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, key: string) => Object.hasOwn(values, key) ? String(values[key]) : match);
const unavailable = (reason: UnavailableReason) => `${JOURNAL_STRINGS.unavailable} (${JOURNAL_REASON_TEXT[reason]})`;
/** A value, or `unavailable (reason)`. Zero and false are values. */
function show<T>(input: Avail<T>, format: (value: T) => string): string {
  return input.available ? format(input.value) : unavailable(input.reason);
}
/** Game names; an empty name is a value and shows as `(empty)`. */
const name = (value: string) => value === '' ? JOURNAL_STRINGS.emptyText : value;
const nameOf = (input: Avail<string>) => show(input, name);

const formatters = new Map<string, Intl.DateTimeFormat>();
/** A UTC label as local clock time, `YYYY-MM-DD HH:MM:SS`. The label is never used for real durations. */
function localTime(utcMs: number, timeZone?: string): string {
  // A label outside the Date range (about ±8.64e15 ms) is an invalid reading, never a thrown RangeError.
  const date = new Date(utcMs);
  if (!Number.isFinite(date.getTime())) return unavailable('invalid');
  const key = timeZone ?? '';
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat('en-GB', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'});
    formatters.set(key, format);
  }
  const parts = Object.fromEntries(format.formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

const unitsFor = (game: JournalGame, options: JournalTextOptions): DisplayUnits => resolveDisplayUnits(game, {profile: (options.units ?? DEFAULT_UNIT_PROFILES)[game]});
const currencyOf = (currency: Currency): MoneyCurrency => currency.status === 'sdk-documented' ? {basis: 'sdk-documented', code: currency.code, source: currency.source} : {basis: 'unknown'};
/** Exact raw digits with `CODE (SDK-documented)` or `(currency unknown)`; telemetry-core's formatMoney. */
const moneyText = (money: {raw: string; sdkType: Money['sdkType']; currency: Currency}) =>
  formatMoney({kind: 'revenue', raw: money.raw, sdkType: money.sdkType, currency: currencyOf(money.currency)});
const distance = (units: DisplayUnits) => (meters: number) => formatDistance(meters, units.distance, 1);
const volume = (units: DisplayUnits) => (liters: number) => formatVolume(liters, units.volume, 1);
/** Absolute game minutes (a decimal uint64) as `Day N, HH:MM`. */
const gameTime = (minutes: string, gameLanguage: AppLanguage = language) => formatLocalizedGameTime(BigInt(minutes), gameLanguage);

/** Fixed text for every journal refusal code (J11); a storage code adds its fixed cause, never error text. */
function journalErrorText(failure: JournalFailure): string {
  if (failure.code === 'DATABASE_UNAVAILABLE') return fill(JOURNAL_ERROR_TEXT.DATABASE_UNAVAILABLE, {cause: BASE_COPY.getRecordingCodeText(failure.storageCode, language)});
  return JOURNAL_ERROR_TEXT[failure.code];
}
/** The fixed result text of a trip export (ET-016 PR-5, J16): the row counts, a cancellation or the refusal code's sentence. */
function journalExportText(result: JournalExportResult): {text: string; failed: boolean} {
  if (result.ok) {
    const value = result.value;
    return value.outcome === 'cancelled' ? {text: JOURNAL_EXPORT_STRINGS.cancelled, failed: false}
      : {text: fill(JOURNAL_EXPORT_STRINGS.saved, {events: String(value.events), intervals: String(value.intervals), samples: String(value.samples)}), failed: false};
  }
  if (Object.hasOwn(JOURNAL_EXPORT_ERROR_TEXT, result.code)) return {text: JOURNAL_EXPORT_ERROR_TEXT[result.code as keyof typeof JOURNAL_EXPORT_ERROR_TEXT], failed: true};
  return {text: journalErrorText(result as JournalFailure), failed: true};
}
/** The persistent banner of a synthetic or replay test database (J3); null for history and before the first answer. */
function journalBannerText(database: JournalDatabase | undefined): string | null {
  return database ? JOURNAL_PURPOSE_TEXT[database.purpose] : null;
}

/** `Delivered`, `Cancelled`, `In progress`, or `No outcome — <close reason>`; never inferred from completeness. */
function outcomeText(trip: Pick<JournalTripListItem, 'outcome' | 'closeReason'>): string {
  const text = JOURNAL_OUTCOME_TEXT[trip.outcome];
  return trip.outcome === 'none' && trip.closeReason !== null ? `${text} — ${JOURNAL_CLOSE_REASON_TEXT[trip.closeReason]}` : text;
}
function completenessBadge(completeness: JournalTripListItem['recordingCompleteness']): JournalBadge {
  return {text: JOURNAL_COMPLETENESS_TEXT[completeness], variant: completeness === 'complete' ? 'secondary' : completeness === 'partial' ? 'destructive' : 'outline'};
}
/** The mode with its detection evidence; a weak result is never presented as confirmed (D9). */
function gameModeText(mode: JournalGameMode, ambiguous: boolean): string {
  const evidence = mode.mode === 'unknown' ? '' : ` (${JOURNAL_GAME_MODE_EVIDENCE_TEXT.confidence[mode.confidence]}, ${JOURNAL_GAME_MODE_EVIDENCE_TEXT.method[mode.method]})`;
  return `${JOURNAL_GAME_MODE_TEXT[mode.mode]}${evidence}${ambiguous ? `; ${JOURNAL_STRINGS.gameModeChanged}` : ''}`;
}
const routeText = (job: JournalTripListItem['job']) => `${nameOf(job.sourceCity)} → ${nameOf(job.destinationCity)}`;

function tripRow(trip: JournalTripListItem, options: JournalTextOptions): JournalTripRow {
  const units = unitsFor(trip.game, options);
  return {
    tripUuid: trip.tripUuid, gameId: trip.game, started: localTime(trip.startedUtcMs, options.timeZone), game: JOURNAL_GAME_TEXT[trip.game], route: routeText(trip.job),
    isHardMode: trip.isHardMode, cargo: nameOf(trip.job.cargo), outcome: outcomeText(trip), completeness: completenessBadge(trip.recordingCompleteness),
    plannedDistance: show(trip.job.plannedDistance, distance(units)), observedDistance: show(trip.observedDistanceM, distance(units)),
    fuelUsed: show(trip.fuelUsedL, volume(units)), expectedIncome: show(trip.job.expectedIncome, moneyText)
  };
}

/**
 * One page of the trip list. An empty first page without filters is `No trips recorded`; with the recording state
 * `disabled` (GAME_HISTORY_RECORDING false) it adds that game recording is off in this version. An empty later page
 * only says that no more trips follow.
 */
function journalListText(page: JournalTripPage, options: JournalTextOptions & {filtered: boolean; recording?: RecordingHealth['state']}): JournalListText {
  const first = options.firstPage ?? true;
  const empty = page.trips.length ? null : !first ? JOURNAL_STRINGS.noMoreTrips : options.filtered ? JOURNAL_STRINGS.emptyFiltered : JOURNAL_STRINGS.empty;
  return {rows: page.trips.map(trip => tripRow(trip, options)), empty,
    emptyNote: empty !== null && first && !options.filtered && options.recording === 'disabled' ? JOURNAL_STRINGS.recordingOffNote : null, hasNext: page.nextCursor !== null};
}

const field = (id: keyof typeof JOURNAL_LABEL_TEXT, value: string, note?: string): JournalField =>
  ({id, label: JOURNAL_LABEL_TEXT[id], value, ...(note ? {note} : {})});
const section = (id: keyof typeof JOURNAL_SECTION_TEXT, fields: JournalField[], notes: string[] = []): JournalSection =>
  ({id, title: JOURNAL_SECTION_TEXT[id], fields, notes});

function moneyLines(totals: JournalMoneyTotals): {fields: JournalField[]; notes: string[]} {
  if (totals.incomplete) return {fields: [], notes: [JOURNAL_STRINGS.moneyIncomplete]};
  const fields = (['fine', 'toll', 'ferry', 'train'] as const).map(category => {
    const parts = [
      ...totals.totals.filter(total => total.category === category).map(total =>
        `${moneyText(total)}, ${total.count === 1 ? JOURNAL_STRINGS.moneyCountOne : fill(JOURNAL_STRINGS.moneyCount, {count: total.count})}`),
      ...totals.unavailable.filter(entry => entry.category === category).map(entry =>
        fill(JOURNAL_STRINGS.moneyUnavailable, {count: entry.count, reason: JOURNAL_REASON_TEXT[entry.reason]}))
    ];
    return {id: category, label: JOURNAL_MONEY_CATEGORY_TEXT[category], value: parts.length ? parts.join('; ') : JOURNAL_STRINGS.moneyNone};
  });
  return {fields, notes: []};
}

/** The trip detail's summary sections (J13). */
function journalDetailText(detail: JournalTripDetail, options: JournalTextOptions = {}): JournalDetailText {
  const {trip, job: {values: job}} = detail, language = options.language ?? 'en';
  const units = unitsFor(trip.game, options), zone = options.timeZone;
  const record = detail.outcomeDetails?.record ?? null;
  const delivered = record?.type === 'job.delivered' ? record : null, cancelled = record?.type === 'job.cancelled' ? record : null;
  const ended = trip.endedUtcMs === null ? JOURNAL_STRINGS.inProgress : localTime(trip.endedUtcMs, zone);
  const openedBy = trip.openedBy === 'event' ? fill(JOURNAL_OPENED_BY_TEXT.event, {eventSeq: trip.openedEventSeq ?? ''}) : JOURNAL_OPENED_BY_TEXT.checkpoint;
  const sections: JournalSection[] = [
    section('trip', [
      field('game', UNIT_GAME_TEXT[trip.game]), field('gameMode', gameModeText(trip.gameMode, trip.gameModeAmbiguous)), field('outcome', outcomeText(trip)),
      field('completeness', JOURNAL_COMPLETENESS_TEXT[trip.recordingCompleteness]), field('started', localTime(trip.startedUtcMs, zone)), field('ended', ended),
      field('openedBy', openedBy), field('session', trip.pluginSessionId), field('tripId', trip.tripUuid)
    ], [JOURNAL_STRINGS.timeNote]),
    section('distance', [
      field('plannedDistance', show(job.plannedDistance, distance(units)), JOURNAL_NOTE_TEXT.plannedDistance),
      field('observedDistance', show(trip.observedDistanceM, distance(units)), JOURNAL_NOTE_TEXT.observedDistance),
      field('deliveredDistance', delivered ? show(delivered.distance, distance(units)) : JOURNAL_STRINGS.notDelivered, JOURNAL_NOTE_TEXT.deliveredDistance)
    ]),
    section('fuel', [field('fuelUsed', show(trip.fuelUsedL, volume(units)), JOURNAL_NOTE_TEXT.fuelUsed)])
  ];
  const money = moneyLines(detail.money);
  const outcomeMoney = delivered ? field('revenue', show(delivered.revenue, moneyText), JOURNAL_NOTE_TEXT.revenue)
    : cancelled ? field('penalty', show(cancelled.penalty, moneyText), JOURNAL_NOTE_TEXT.penalty)
      : field('revenueOrPenalty', trip.outcome === 'open' ? JOURNAL_STRINGS.inProgress : JOURNAL_STRINGS.noOutcome);
  sections.push(section('money', [field('expectedIncome', show(job.expectedIncome, moneyText), JOURNAL_NOTE_TEXT.expectedIncome), outcomeMoney, ...money.fields],
    [...money.notes, JOURNAL_STRINGS.moneyNote]));
  const jobSource = detail.job.source === 'event' ? fill(JOURNAL_JOB_SOURCE_TEXT.event, {eventSeq: detail.job.eventSeq ?? ''})
    : fill(JOURNAL_JOB_SOURCE_TEXT.checkpoint, {eventSeq: detail.job.checkpointNextEventSeq ?? ''});
  sections.push(section('job', [
    field('sourceCity', nameOf(job.sourceCity)), field('sourceCompany', nameOf(job.sourceCompany)), field('destinationCity', nameOf(job.destinationCity)),
    field('destinationCompany', nameOf(job.destinationCompany)), field('cargo', nameOf(job.cargo)), field('cargoMass', show(job.cargoMass, kg => formatMass(kg, units.mass))),
    field('market', show(job.market, market => market === '' ? name(market) : BASE_COPY.getJobMarketText(market, language))), field('specialJob', show(job.isSpecialJob, v => formatLocalizedBoolean(v, language))), field('cargoLoaded', show(job.cargoLoaded, v => formatLocalizedBoolean(v, language))),
    field('deadline', show(job.deliveryDeadline, minutes => gameTime(minutes, language)), JOURNAL_NOTE_TEXT.deadline), field('jobSource', jobSource)
  ]));
  if (delivered) {
    sections.push(section('delivery', [
      field('earnedXp', show(delivered.earnedXp, String)), field('cargoDamage', show(delivered.cargoDamage, formatPercent)),
      field('deliveryDuration', show(delivered.deliveryDuration, minutes => formatLocalizedGameDuration(BigInt(minutes), language)), JOURNAL_NOTE_TEXT.deliveryDuration),
      field('autoPark', show(delivered.autoParkUsed, v => formatLocalizedBoolean(v, language))), field('autoLoad', show(delivered.autoLoadUsed, v => formatLocalizedBoolean(v, language)))
    ]));
  }
  // A trip attached late has no truck or trailer identity until the game sends them again (J22).
  const truck = detail.truck?.values;
  sections.push(truck ? section('truck', [
    field('brand', nameOf(truck.brand)), field('model', nameOf(truck.name)), field('licensePlate', nameOf(truck.licensePlate)),
    field('plateCountry', nameOf(truck.plateCountry)), field('fuelCapacity', show(truck.fuelCapacity, volume(units)))
  ]) : section('truck', [], [JOURNAL_STRINGS.noTruck]));
  // Trailers in commit order; the label numbers the game's trailer slot (index 0 is trailer 1).
  const trailerFields = detail.trailers.items.flatMap(({values}, position) => {
    const number = values.index + 1, key = `trailer-${position}`;
    return [
      {id: `${key}-brand`, label: fill(JOURNAL_LABEL_TEXT.trailerBrand, {number}), value: nameOf(values.brand)},
      {id: `${key}-model`, label: fill(JOURNAL_LABEL_TEXT.trailerModel, {number}), value: nameOf(values.name)},
      {id: `${key}-body`, label: fill(JOURNAL_LABEL_TEXT.trailerBody, {number}), value: nameOf(values.bodyType)},
      {id: `${key}-plate`, label: fill(JOURNAL_LABEL_TEXT.trailerPlate, {number}), value: nameOf(values.licensePlate)}
    ];
  });
  const trailerNotes = detail.trailers.total === 0 ? [JOURNAL_STRINGS.noTrailers]
    : detail.trailers.total > detail.trailers.items.length ? [fill(JOURNAL_STRINGS.trailerTotal, {shown: detail.trailers.items.length, total: detail.trailers.total})] : [];
  sections.push(section('trailers', trailerFields, trailerNotes));
  const samples = detail.samples;
  sections.push(section('samples', [
    field('sampleCount', String(samples.count)),
    ...(samples.firstUtcMs !== null && samples.lastUtcMs !== null ? [field('firstSample', localTime(samples.firstUtcMs, zone)), field('lastSample', localTime(samples.lastUtcMs, zone))] : [])
  ]));
  return {title: `${JOURNAL_GAME_TEXT[trip.game]}: ${routeText(trip.job)}`, outcome: outcomeText(trip), completeness: completenessBadge(trip.recordingCompleteness), sections};
}

/** An interval cause from the recorder's fixed list; anything else is `other`, never stored text. */
function causeText(interval: JournalInterval): string {
  const cause = interval.cause === null ? JOURNAL_STRINGS.none : Object.hasOwn(JOURNAL_INTERVAL_CAUSE_TEXT, interval.cause) ? JOURNAL_INTERVAL_CAUSE_TEXT[interval.cause] : JOURNAL_OTHER_CAUSE;
  return interval.annotation ? `${cause} (${JOURNAL_STRINGS.annotation})` : cause;
}
/** One page of the trip's completeness intervals with the trip's total. */
function journalIntervalText(page: JournalIntervalPage, options: JournalTextOptions = {}): JournalIntervalText {
  const time = (utcMs: number | null) => utcMs === null ? '—' : localTime(utcMs, options.timeZone);
  return {
    total: fill(JOURNAL_STRINGS.intervalsTotal, {count: page.total}),
    rows: page.intervals.map(interval => ({id: interval.id, kind: JOURNAL_INTERVAL_KIND_TEXT[interval.kind], cause: causeText(interval),
      start: time(interval.startUtcMs), end: time(interval.endUtcMs),
      events: interval.firstEventSeq !== null && interval.lastEventSeq !== null ? fill(JOURNAL_STRINGS.eventRange, {first: interval.firstEventSeq, last: interval.lastEventSeq}) : '—'})),
    empty: page.intervals.length ? null : (options.firstPage ?? true) ? JOURNAL_STRINGS.noIntervals : JOURNAL_STRINGS.noMoreIntervals, hasNext: page.nextCursor !== null
  };
}

function windowText(window: JournalWindow): string {
  if (!window.known) return JOURNAL_STRINGS.windowUnknown;
  const values = {from: window.fromEventSeq, through: window.throughEventSeq ?? ''};
  const template = {'open': JOURNAL_STRINGS.windowOpen, 'close-event': JOURNAL_STRINGS.windowCloseEvent, 'close-gap': JOURNAL_STRINGS.windowCloseGap,
    'end-of-session': JOURNAL_STRINGS.windowEndOfSession}[window.end];
  return fill(template, values);
}
const transferText = (record: Extract<EventRecord, {type: 'player.use.ferry' | 'player.use.train'}>) =>
  `${nameOf(record.sourceName)} → ${nameOf(record.targetName)}: ${show(record.amount, moneyText)}`;
function eventDetail(record: EventRecord, units: DisplayUnits): string {
  switch (record.type) {
    case 'job.configured': return `${nameOf(record.cargo)}, ${nameOf(record.sourceCity)} → ${nameOf(record.destinationCity)}`;
    case 'truck.configured': return `${nameOf(record.brand)} ${nameOf(record.name)}, ${nameOf(record.licensePlate)}`;
    case 'trailer.configured': return `${fill(JOURNAL_LABEL_TEXT.trailer, {number: record.index + 1})}: ${nameOf(record.bodyType)}, ${nameOf(record.licensePlate)}`;
    case 'trailer.cleared': return fill(JOURNAL_LABEL_TEXT.trailer, {number: record.index + 1});
    case 'gameTime.regression': return `${show(record.from.minutes, gameTime)} → ${show(record.to.minutes, gameTime)}`;
    case 'job.delivered': return `${JOURNAL_LABEL_TEXT.revenue} ${show(record.revenue, moneyText)}, ${JOURNAL_LABEL_TEXT.deliveredDistance.toLowerCase()} ${show(record.distance, distance(units))}`;
    case 'job.cancelled': return `${JOURNAL_LABEL_TEXT.penalty} ${show(record.penalty, moneyText)}`;
    case 'player.fined': return `${nameOf(record.offence)}: ${show(record.amount, moneyText)}`;
    case 'player.tollgate.paid': return show(record.amount, moneyText);
    case 'player.use.ferry': case 'player.use.train': return transferText(record);
    case 'source.gameMode': return gameModeText(record, false);
    default: return '';
  }
}
function attributionText(event: JournalEvent, tripUuid: string): string {
  const a = event.attribution;
  if (a === null) return JOURNAL_ATTRIBUTION_TEXT.none;
  if ((a.kind === 'trip' || a.kind === 'trip-before-loaded') && a.tripUuid !== tripUuid) return JOURNAL_ATTRIBUTION_TEXT['other-trip'];
  return JOURNAL_ATTRIBUTION_TEXT[a.kind];
}
/** One page of the trip's timeline (J7) in the trip's own game profile. */
function journalEventText(page: JournalEventPage, trip: {tripUuid: string; game: JournalGame}, options: JournalTextOptions = {}): JournalEventText {
  const units = unitsFor(trip.game, options);
  return {
    window: windowText(page.window),
    rows: page.events.map(event => ({eventSeq: event.eventSeq, time: show(event.occurred.utcUnixMs, value => localTime(Number(value), options.timeZone)),
      type: JOURNAL_EVENT_TYPE_TEXT[event.type], detail: eventDetail(event.record, units), attribution: attributionText(event, trip.tripUuid)})),
    empty: page.events.length ? null : (options.firstPage ?? true) ? JOURNAL_STRINGS.noEvents : JOURNAL_STRINGS.noMoreEvents, hasNext: page.nextCursor !== null
  };
}

/** Game minutes of a sample: a whole, non-negative number; anything else reads as invalid. */
const sampleGameTime = (sample: JournalSample, language: AppLanguage = 'en') => sample.gameTime === null ? unavailable('not-observed')
  : show(sample.gameTime.minutes, minutes => Number.isSafeInteger(minutes) && minutes >= 0 ? formatLocalizedGameTime(BigInt(minutes), language) : unavailable('invalid'));
/** The SDK mean in the profile's unit. Zero L/100 km has no US mpg value and is shown as no consumption, never as zero mpg. */
function consumptionText(litersPer100Km: number, units: DisplayUnits): string {
  const result = formatConsumption(litersPer100Km, units.consumption);
  return 'text' in result ? result.text : result.reason === 'zero-consumption' ? JOURNAL_STRINGS.zeroConsumption : unavailable('invalid');
}
const sourceSecond = (sample: JournalSample) => BigInt(sample.monotonicNs) / 1_000_000_000n;
/**
 * One page of the trip's one-second samples (J14). Between consecutive rows of the same source clock whose source
 * seconds are more than 1 apart, a `no samples for N s` row names the N missing seconds; a change of source clock is a
 * `source restarted` row. Only the current page is held, so the first row of a page is compared with nothing.
 */
function journalSampleText(page: JournalSamplePage, game: JournalGame, options: JournalTextOptions = {}): JournalSampleText {
  const units = unitsFor(game, options), rows: JournalSampleRow[] = [], language = options.language ?? 'en';
  let previous: JournalSample | undefined;
  for (const sample of page.samples) {
    if (previous && previous.sourceClockId !== sample.sourceClockId) rows.push({kind: 'restart', key: `restart-${sample.id}`, text: JOURNAL_STRINGS.sourceRestarted});
    else if (previous) {
      const missing = sourceSecond(sample) - sourceSecond(previous) - 1n;
      if (missing > 0n) rows.push({kind: 'gap', key: `gap-${sample.id}`, text: fill(JOURNAL_STRINGS.sampleGap, {seconds: missing.toString()})});
    }
    rows.push({kind: 'sample', key: sample.id, time: localTime(sample.utcMs, options.timeZone), speed: show(sample.speed, value => formatSpeed(value, units.speed)),
      fuel: show(sample.fuel, volume(units)),
      consumption: show(sample.averageConsumption, value => consumptionText(value, units)),
      range: show(sample.estimatedRange, distance(units)), rpm: show(sample.engineRpm, formatRpm), gear: show(sample.gear, formatGear),
      odometer: show(sample.odometer, distance(units)), gameTime: sampleGameTime(sample, language), position: show(sample.position, formatPosition)});
    previous = sample;
  }
  const L = JOURNAL_LABEL_TEXT;
  const columns: JournalColumn[] = [{label: L.time}, {label: L.speed}, {label: L.fuel}, {label: L.gear}, {label: L.rpm}, {label: L.odometer}, {label: L.range},
    {label: L.consumption, note: JOURNAL_NOTE_TEXT.consumption}, {label: L.gameTime}, {label: L.position, note: JOURNAL_NOTE_TEXT.position}];
  return {columns, rows, empty: page.samples.length ? null : (options.firstPage ?? true) ? JOURNAL_STRINGS.noSamples : JOURNAL_STRINGS.noMoreSamples,
    hasNext: page.nextCursor !== null};
}

  return {localTime, journalErrorText, journalExportText, journalBannerText, outcomeText, completenessBadge, gameModeText, journalListText, journalDetailText, journalIntervalText, journalEventText, journalSampleText};
}
const texts = {en: createJournalText('en'), ru: createJournalText('ru')};
export const journalListText = (...args: Parameters<typeof texts.en.journalListText>): ReturnType<typeof texts.en.journalListText> => texts[args[1]?.language ?? 'en'].journalListText(...args);
export const journalDetailText = (...args: Parameters<typeof texts.en.journalDetailText>): ReturnType<typeof texts.en.journalDetailText> => texts[args[1]?.language ?? 'en'].journalDetailText(...args);
export const journalIntervalText = (...args: Parameters<typeof texts.en.journalIntervalText>): ReturnType<typeof texts.en.journalIntervalText> => texts[args[1]?.language ?? 'en'].journalIntervalText(...args);
export const journalEventText = (...args: Parameters<typeof texts.en.journalEventText>): ReturnType<typeof texts.en.journalEventText> => texts[args[2]?.language ?? 'en'].journalEventText(...args);
export const journalSampleText = (...args: Parameters<typeof texts.en.journalSampleText>): ReturnType<typeof texts.en.journalSampleText> => texts[args[2]?.language ?? 'en'].journalSampleText(...args);
export const journalErrorText = (failure: JournalFailure, language: AppLanguage = 'en'): ReturnType<typeof texts.en.journalErrorText> => texts[language].journalErrorText(failure);
export const journalExportText = (result: JournalExportResult, language: AppLanguage = 'en'): ReturnType<typeof texts.en.journalExportText> => texts[language].journalExportText(result);
export const journalBannerText = (database: JournalDatabase | undefined, language: AppLanguage = 'en'): ReturnType<typeof texts.en.journalBannerText> => texts[language].journalBannerText(database);
export const outcomeText = (trip: Pick<JournalTripListItem, 'outcome' | 'closeReason'>, language: AppLanguage = 'en'): ReturnType<typeof texts.en.outcomeText> => texts[language].outcomeText(trip);
export const completenessBadge = (completeness: JournalTripListItem['recordingCompleteness'], language: AppLanguage = 'en'): ReturnType<typeof texts.en.completenessBadge> => texts[language].completenessBadge(completeness);
export const localTime = texts.en.localTime;
export const gameModeText = (mode: JournalGameMode, ambiguous: boolean, language: AppLanguage = 'en'): string => texts[language].gameModeText(mode, ambiguous);
