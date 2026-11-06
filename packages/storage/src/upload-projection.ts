// Private service/worker contract. No renderer DTOs or durable publication authority.
import type {Available, GameMode, JobConfiguration, Measure, Money} from '../../contracts/src/protocol-v1';
import type {CloseReason, RecordingCompleteness, TripOutcome} from './api';

export const UPLOAD_PAGE_KINDS = ['members', 'configurations', 'intervals'] as const;
export type UploadPageKind = typeof UPLOAD_PAGE_KINDS[number];
export type UploadReadiness = 'ready' | 'identity-pending';
export interface QualifiedOccurrence {pluginSessionId: string; rawTripUuid: string; eventSeq: string; type: string; utcMs: number | null}
export interface UploadVersions {nativeProtocol: {major: number; minor: number}; sdkArchive: Available<string>;
  telemetryApi: Available<{major: number; minor: number}>; gameTelemetryApi: Available<{major: number; minor: number}>}
export interface UploadMember {id: string; rawTripUuid: string; pluginSessionId: string; game: 'ets2' | 'ats'; origin: 'game' | 'synthetic' | 'replay'; versions: UploadVersions}
export interface UploadConfiguration {id: string; occurrence: QualifiedOccurrence; index: number; idValue: Available<string>; bodyType: Available<string>; chainType: Available<string>}
export interface UploadInterval {id: string; rawTripUuid: string; pluginSessionId: string; kind: 'event-loss' | 'not-connected' | 'storage-unavailable' | 'sample-loss' | 'discontinuity' | 'restore-loss'}
export interface UploadFacts {
  game: 'ets2' | 'ats'; pluginSessionId: string; outcome: TripOutcome; closeReason: CloseReason | null; recordingCompleteness: RecordingCompleteness;
  openedBy: 'event' | 'checkpoint'; checkpointNextEventSeq: string | null; checkpointUtcMs: number | null;
  opening: QualifiedOccurrence | null; outcomeOccurrence: QualifiedOccurrence | null; close: QualifiedOccurrence | null;
  gameMode: Pick<GameMode, 'mode' | 'method' | 'confidence'> & {ambiguous: boolean}; job: JobConfiguration;
  observedDistance: Measure<'m'>; fuelUsed: Measure<'L'>; deliveredDistance: Measure<'m'>; cargoDamage: Measure<'fraction'>;
  revenue: Available<Money>; penalty: Available<Money>; moneyIncomplete: boolean;
  clockAnomaly: boolean;
}
export interface UploadProjection {
  requestedTripUuid: string; rootTripUuid: string; readiness: UploadReadiness | 'redirected'; rootReadiness: UploadReadiness;
  snapshot: string; databaseUuid: string; purpose: 'history' | 'synthetic' | 'replay'; revision: string;
  bounds: {members: string; events: string; gaps: string; samples: string; intervals: string; accountingHead: string | null};
  totals: Record<UploadPageKind, number>; facts: UploadFacts;
}
export interface UploadProjectionPageQuery {snapshot: string; kind: UploadPageKind; cursor?: string; limit: number}
export interface UploadProjectionPage {snapshot: string; kind: UploadPageKind; cursor: string | null; nextCursor: string | null;
  total: number; rows: (UploadMember | UploadConfiguration | UploadInterval)[]}

type Check = (v: unknown) => boolean;
const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shape = (fields: Record<string, Check>): Check => v => record(v) && Object.keys(v).length === Object.keys(fields).length
  && Object.entries(fields).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]));
const one = (...values: unknown[]): Check => v => values.includes(v);
const nullable = (check: Check): Check => v => v === null || check(v);
const bool: Check = v => typeof v === 'boolean';
const count: Check = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const real: Check = v => typeof v === 'number' && Number.isFinite(v);
const text: Check = v => typeof v === 'string' && v.length <= 65_536;
export const isUploadUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const decimal: Check = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= 9_223_372_036_854_775_807n;
const positive: Check = v => decimal(v) && v !== '0';
const sequence: Check = v => typeof v === 'string' && /^[1-9][0-9]{0,19}$/.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n;
const unavailable = {available: one(false), reason: one('not-observed', 'not-supported', 'invalid')};
const available = (check: Check, unit?: string): Check => v => shape({...unavailable, ...(unit ? {unit: one(unit)} : {})})(v)
  || shape({available: one(true), value: check, ...(unit ? {unit: one(unit)} : {})})(v);
const version = shape({major: v => count(v) && (v as number) <= 65_535, minor: v => count(v) && (v as number) <= 65_535});
const versions = shape({nativeProtocol: version, sdkArchive: available(text), telemetryApi: available(version), gameTelemetryApi: available(version)});
const currency = (v: unknown) => shape({status: one('unknown')})(v) || shape({status: one('sdk-documented'), code: text, source: text})(v);
const money = available(shape({raw: v => typeof v === 'string' && /^(0|-?[1-9][0-9]{0,19})$/.test(v)
  && BigInt(v) >= -9_223_372_036_854_775_808n && BigInt(v) <= 18_446_744_073_709_551_615n, sdkType: one('s64', 'u64'), currency}));
const moneyOf = (type: Money['sdkType']): Check => v => money(v) && (!record(v) || v.available !== true
  || record(v.value) && v.value.sdkType === type && typeof v.value.raw === 'string'
    && BigInt(v.value.raw) >= (type === 'u64' ? 0n : -9_223_372_036_854_775_808n)
    && BigInt(v.value.raw) <= (type === 'u64' ? 18_446_744_073_709_551_615n : 9_223_372_036_854_775_807n));
const jobFields: [string, Check][] = [
  ...['sourceCityId','sourceCity','sourceCompanyId','sourceCompany','destinationCityId','destinationCity','destinationCompanyId','destinationCompany','cargoId','cargo','market'].map((k): [string, Check] => [k, available(text)]),
  ['cargoMass', available(real, 'kg')], ['cargoUnitMass', available(real, 'kg')], ['cargoUnitCount', available(count)],
  ['isSpecialJob', available(bool)], ['cargoLoaded', available(bool)], ['plannedDistance', available(real, 'm')],
  ['expectedIncome', moneyOf('u64')], ['deliveryDeadline', available(v => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v), 'min')]
];
const jobCheck = shape(Object.fromEntries(jobFields));
const occurrence = shape({pluginSessionId: isUploadUuid, rawTripUuid: isUploadUuid, eventSeq: sequence, type: text, utcMs: nullable(count)});
const mode = shape({mode: one('unknown','single-player','truckersmp'), method: one('none','module-scan','process-scan'), confidence: one('none','weak','strong'), ambiguous: bool});
const facts = shape({game: one('ets2','ats'), pluginSessionId: isUploadUuid, outcome: one('open','none','delivered','cancelled'),
  closeReason: nullable(one('outcome','configuration-cleared','different-job','restart','discontinuity','gap')), recordingCompleteness: one('complete','partial','unknown'),
  openedBy: one('event','checkpoint'), checkpointNextEventSeq: nullable(sequence), checkpointUtcMs: nullable(count), opening: nullable(occurrence), outcomeOccurrence: nullable(occurrence), close: nullable(occurrence),
  gameMode: mode, job: jobCheck, observedDistance: available(real,'m'), fuelUsed: available(real,'L'), deliveredDistance: available(real,'m'), cargoDamage: available(real,'fraction'),
  revenue: moneyOf('s64'), penalty: moneyOf('s64'), moneyIncomplete: bool, clockAnomaly: bool});
const totals = shape({members: count, configurations: count, intervals: count});
const readiness = one('ready','identity-pending');
export const uploadSnapshotParts = (v: unknown): string[] | undefined => {
  if (typeof v !== 'string' || v.length > 256) return undefined;
  const p = v.split(':');
  return p.length === 8 && p[0] === 'u1' && isUploadUuid(p[1]) && isUploadUuid(p[2]) && positive(p[3]) && p.slice(4).every(decimal) ? p : undefined;
};
export function isUploadPageQuery(v: unknown): v is UploadProjectionPageQuery {
  if (!record(v) || !Object.keys(v).every(k => ['snapshot','kind','cursor','limit'].includes(k)) || !uploadSnapshotParts(v.snapshot)
    || !UPLOAD_PAGE_KINDS.includes(v.kind as UploadPageKind) || !count(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 100) return false;
  if (v.cursor === undefined) return true;
  if (typeof v.cursor !== 'string') return false;
  const prefix = `${String(v.snapshot)}:${String(v.kind)}:`;
  return v.cursor.startsWith(prefix) && positive(v.cursor.slice(prefix.length));
}
export function isUploadProjection(v: unknown, requested?: string): v is UploadProjection {
  if (!shape({requestedTripUuid: isUploadUuid, rootTripUuid: isUploadUuid, readiness: one('ready','identity-pending','redirected'), rootReadiness: readiness,
    snapshot: v => !!uploadSnapshotParts(v), databaseUuid: isUploadUuid, purpose: one('history','synthetic','replay'), revision: positive,
    bounds: shape({members: decimal, events: decimal, gaps: decimal, samples: decimal, intervals: decimal, accountingHead: nullable(positive)}), totals, facts})(v)) return false;
  const p = v as UploadProjection, token = uploadSnapshotParts(p.snapshot)!;
  return (requested === undefined || requested === p.requestedTripUuid) && token[1] === p.databaseUuid && token[2] === p.rootTripUuid && token[3] === p.revision
    && token[4] === String(p.totals.members) && token[5] === String(p.totals.configurations) && token[6] === String(p.totals.intervals)
    && token[7] === p.bounds.members && (p.requestedTripUuid !== p.rootTripUuid ? p.readiness === 'redirected' : p.readiness === p.rootReadiness);
}
const rowChecks: Record<UploadPageKind, Check> = {
  members: shape({id: positive, rawTripUuid: isUploadUuid, pluginSessionId: isUploadUuid, game: one('ets2','ats'), origin: one('game','synthetic','replay'), versions}),
  configurations: shape({id: positive, occurrence, index: v => count(v) && (v as number) <= 9, idValue: available(text), bodyType: available(text), chainType: available(text)}),
  intervals: shape({id: positive, rawTripUuid: isUploadUuid, pluginSessionId: isUploadUuid, kind: one('event-loss','not-connected','storage-unavailable','sample-loss','discontinuity','restore-loss')})
};
export function isUploadProjectionPage(v: unknown, query: UploadProjectionPageQuery): v is UploadProjectionPage {
  if (!isUploadPageQuery(query) || !shape({snapshot: one(query.snapshot), kind: one(query.kind), cursor: one(query.cursor ?? null), nextCursor: nullable(text), total: count,
    rows: v => Array.isArray(v) && v.length <= query.limit && v.every(rowChecks[query.kind])})(v)) return false;
  const p = v as UploadProjectionPage, parts = uploadSnapshotParts(query.snapshot)!, total = Number(parts[4 + UPLOAD_PAGE_KINDS.indexOf(query.kind)]);
  let after = query.cursor ? BigInt(query.cursor.split(':').at(-1)!) : 0n;
  for (const row of p.rows) {if (BigInt(row.id) <= after) return false; after = BigInt(row.id);}
  return p.total === total && p.rows.length <= total && (p.nextCursor === null || p.rows.length === query.limit
    && p.nextCursor === `${query.snapshot}:${query.kind}:${after}`);
}

export interface UploadTime {utcMs: number | null; basis: 'event' | 'checkpoint' | 'unknown'; eventSeq: string | null}
export interface UploadSummary {
  source: {provider: 'ets2telemetry'; game: 'ets2' | 'ats'; tripId: string; pluginSessionId: string; databaseUuid: string; origin: 'game'};
  snapshot: {
    outcome: TripOutcome; closeReason: CloseReason | null; recordingCompleteness: RecordingCompleteness; start: UploadTime; end: UploadTime | null;
    openedBy: 'event' | 'checkpoint'; openedEventSeq: string | null; checkpointNextEventSeq: string | null; outcomeEventSeq: string | null;
    context: {gameBuild: Available<string>; sourceLocale: Available<string>; mapId: Available<string>; dlcIds: Available<string[]>; versions: UploadVersions};
    gameMode: UploadFacts['gameMode']; job: {origin: UploadPlace; destination: UploadPlace; cargoId: Available<string>; cargoName: Available<string>;
      cargoMass: Measure<'kg'>; cargoUnitMass: Measure<'kg'>; cargoUnitCount: Available<number>; market: Available<string>; isSpecialJob: Available<boolean>; cargoLoaded: Available<boolean>};
    trailers: {complete: boolean; items: {index: number; id: Available<string>; bodyType: Available<string>; chainType: Available<string>}[]};
    plannedDistance: Measure<'m'>; observedDistance: Measure<'m'>; deliveredDistance: Measure<'m'>; fuelUsed: Measure<'L'>; cargoDamage: Measure<'fraction'>;
    expectedIncome: Available<Money>; revenue: Available<Money>; penalty: Available<Money>;
    evidence: {startObserved: boolean; endObserved: boolean; ruleContextComplete: boolean; clockAnomaly: boolean; reasons: string[]};
  };
}
interface UploadPlace {cityId: Available<string>; cityName: Available<string>; companyId: Available<string>; companyName: Available<string>}
export type UploadMapping = {status: 'hold'; reason: 'identity-pending' | 'evidence-incomplete' | 'source-ineligible' | 'evidence-contradictory' | 'unrepresentable'}
  | {status: 'projected'; summary: UploadSummary; provenance: {snapshot: string; opening: QualifiedOccurrence | null; outcome: QualifiedOccurrence | null; close: QualifiedOccurrence | null}};
const absent = {available: false, reason: 'not-observed'} as const;

/** Complete private pages are required. This result still needs a transactional root/owner freeze before publication. */
export function mapUploadProjection(pin: UploadProjection, pages: readonly UploadProjectionPage[]): UploadMapping {
  const hold = (reason: Extract<UploadMapping, {status: 'hold'}>['reason']): UploadMapping => ({status: 'hold', reason});
  if (!isUploadProjection(pin)) return hold('evidence-contradictory');
  if (pin.rootReadiness !== 'ready') return hold('identity-pending');
  if (pin.purpose !== 'history') return hold('source-ineligible');
  const collected: Record<UploadPageKind, (UploadMember | UploadConfiguration | UploadInterval)[]> = {members: [], configurations: [], intervals: []};
  for (const kind of UPLOAD_PAGE_KINDS) {
    let cursor: string | undefined, done = false;
    for (const page of pages.filter(p => p.kind === kind)) {
      if (done || !isUploadProjectionPage(page, {snapshot: pin.snapshot, kind, cursor, limit: Math.max(1, page.rows.length)})) return hold('evidence-incomplete');
      collected[kind].push(...page.rows); cursor = page.nextCursor ?? undefined; done = page.nextCursor === null;
    }
    if (!done || collected[kind].length !== pin.totals[kind]) return hold('evidence-incomplete');
  }
  if (pages.some(p => !UPLOAD_PAGE_KINDS.includes(p.kind))) return hold('evidence-incomplete');
  const members = collected.members as UploadMember[], configs = collected.configurations as UploadConfiguration[], intervals = collected.intervals as UploadInterval[];
  const f = pin.facts, j = f.job, openingMember = members.find(m => m.rawTripUuid === pin.rootTripUuid && m.pluginSessionId === f.pluginSessionId);
  if (!openingMember || members.some(m => m.origin !== 'game' || m.game !== f.game)) return hold('source-ineligible');
  const owned = (e: QualifiedOccurrence | null) => !e || members.some(m => m.rawTripUuid === e.rawTripUuid && m.pluginSessionId === e.pluginSessionId);
  if (![f.opening,f.outcomeOccurrence].every(owned) || configs.some(c => !owned(c.occurrence))
    || f.openedBy === 'event' && (!f.opening || f.opening.type !== 'job.configured' || f.opening.rawTripUuid !== pin.rootTripUuid || f.opening.pluginSessionId !== f.pluginSessionId)
    || f.openedBy === 'event' && f.checkpointNextEventSeq !== null
    || f.openedBy === 'checkpoint' && (f.opening !== null || !f.checkpointNextEventSeq)
    || (f.outcome === 'delivered' || f.outcome === 'cancelled') && f.outcomeOccurrence?.type !== `job.${f.outcome}`
    || (f.outcome === 'open' || f.outcome === 'none') && f.outcomeOccurrence !== null
    || f.outcome === 'open' && f.closeReason !== null || f.outcome !== 'open' && f.closeReason === null
    || (f.outcome === 'delivered' || f.outcome === 'cancelled') && f.closeReason !== 'outcome'
    || f.outcome === 'none' && f.closeReason === 'outcome') return hold('evidence-contradictory');
  const time = (e: QualifiedOccurrence | null): UploadTime => e?.utcMs !== null && e?.utcMs !== undefined && e.utcMs <= 253_402_300_799_999
    ? {utcMs: e.utcMs, basis: 'event', eventSeq: e.eventSeq} : {utcMs: null, basis: 'unknown', eventSeq: null};
  const start: UploadTime = f.openedBy === 'checkpoint' ? {utcMs: f.checkpointUtcMs, basis: 'checkpoint', eventSeq: null} : time(f.opening);
  const end = f.outcome === 'open' ? null : time(f.outcomeOccurrence ?? f.close);
  const clockAnomaly = f.clockAnomaly || start.utcMs !== null && end?.utcMs !== null && end?.utcMs !== undefined && end.utcMs < start.utcMs;
  const reasons = new Set<string>(['catalog-context-unavailable']);
  if (intervals.length) reasons.add('recording-intervals');
  if (clockAnomaly) reasons.add('clock-anomaly');
  if (f.gameMode.ambiguous) reasons.add('game-mode-ambiguous');
  if (f.moneyIncomplete) reasons.add('accounting-unavailable');
  // History is rule context, not ten active slots. Never describe changing configurations as a complete current chain.
  const changed = new Set(configs.map(c => c.index)).size !== configs.length;
  if (changed) reasons.add('trailer-context-changed');
  if (!configs.length) reasons.add('trailer-context-unavailable');
  const items = changed ? [] : configs.map(c => ({index: c.index, id: c.idValue, bodyType: c.bodyType, chainType: c.chainType}));
  if (items.length > 10) return hold('unrepresentable');
  const place = (prefix: 'source' | 'destination'): UploadPlace => ({cityId: j[`${prefix}CityId`], cityName: j[`${prefix}City`], companyId: j[`${prefix}CompanyId`], companyName: j[`${prefix}Company`]});
  const summary: UploadSummary = {source: {provider: 'ets2telemetry', game: f.game, tripId: pin.rootTripUuid, pluginSessionId: f.pluginSessionId, databaseUuid: pin.databaseUuid, origin: 'game'}, snapshot: {
    outcome: f.outcome, closeReason: f.closeReason, recordingCompleteness: f.outcome === 'none' ? 'partial' : f.recordingCompleteness,
    start, end, openedBy: f.openedBy, openedEventSeq: f.opening?.eventSeq ?? null, checkpointNextEventSeq: f.checkpointNextEventSeq, outcomeEventSeq: f.outcomeOccurrence?.eventSeq ?? null,
    context: {gameBuild: absent, sourceLocale: absent, mapId: absent, dlcIds: absent, versions: openingMember.versions}, gameMode: f.gameMode,
    job: {origin: place('source'), destination: place('destination'), cargoId: j.cargoId, cargoName: j.cargo, cargoMass: j.cargoMass, cargoUnitMass: j.cargoUnitMass,
      cargoUnitCount: j.cargoUnitCount, market: j.market, isSpecialJob: j.isSpecialJob, cargoLoaded: j.cargoLoaded},
    trailers: {complete: false, items}, plannedDistance: j.plannedDistance, observedDistance: f.observedDistance, deliveredDistance: f.deliveredDistance,
    fuelUsed: f.fuelUsed, cargoDamage: f.cargoDamage, expectedIncome: j.expectedIncome, revenue: f.moneyIncomplete ? absent : f.revenue, penalty: f.moneyIncomplete ? absent : f.penalty,
    evidence: {startObserved: start.basis === 'event' && !clockAnomaly, endObserved: !!f.outcomeOccurrence && end?.basis === 'event' && !clockAnomaly,
      ruleContextComplete: false, clockAnomaly, reasons: [...reasons].sort()}
  }};
  // Validate the exact allowlisted wire subset, including Dashboard's UTF-8, numeric and money limits.
  if (!wireValuesFit(summary)) return hold('unrepresentable');
  return structuredClone({status: 'projected', summary, provenance: {snapshot: pin.snapshot, opening: f.opening, outcome: f.outcomeOccurrence, close: f.close}});
}

function wireValuesFit(summary: UploadSummary): boolean {
  const walk = (v: unknown, key = ''): boolean => {
    if (typeof v === 'string') return Array.from(v).every(c => c.charCodeAt(0) > 31 && c.charCodeAt(0) !== 127) && Buffer.byteLength(v) <= 256;
    if (!record(v) && !Array.isArray(v)) return typeof v !== 'number' || Number.isFinite(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER;
    if (record(v) && v.available === true) {
      if (typeof v.value === 'string' && Buffer.byteLength(v.value) > (['cityName','companyName','cargoName'].includes(key) ? 256 : 128)) return false;
      if (typeof v.value === 'number' && (v.value < 0 || v.value > (v.unit === 'm' ? 1e12 : v.unit === 'fraction' ? 1000 : key === 'cargoUnitCount' ? 4_294_967_295 : 1e9))) return false;
      if (record(v.value) && 'raw' in v.value) {
        const m = v.value, signed = key !== 'expectedIncome';
        if (m.sdkType !== (signed ? 's64' : 'u64') || typeof m.raw !== 'string' || BigInt(m.raw) < (signed ? -9_223_372_036_854_775_808n : 0n)
          || BigInt(m.raw) > (signed ? 9_223_372_036_854_775_807n : 18_446_744_073_709_551_615n)) return false;
        if (record(m.currency) && m.currency.status === 'sdk-documented' && typeof m.currency.code === 'string' && m.currency.code.length > 16) return false;
      }
    }
    return Object.entries(v).every(([k, value]) => walk(value, k));
  };
  const m = summary.snapshot.gameMode;
  return (m.mode === 'unknown' ? m.method === 'none' && m.confidence === 'none' : m.method !== 'none' && m.confidence !== 'none' && (m.mode !== 'single-player' || m.confidence === 'weak'))
    && walk(summary) && Buffer.byteLength(JSON.stringify(summary)) < 60_000;
}
