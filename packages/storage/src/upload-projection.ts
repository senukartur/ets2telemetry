import {chainComplete,isRuleContext,usable,type RuleContext} from './upload-rule-context';
// Private service/worker contract. No renderer DTOs or durable publication authority.
import {EVENT_TYPES, type Available, type GameMode, type JobConfiguration, type Measure, type Money} from '../../contracts/src/protocol-v1';
import type {CloseReason, RecordingCompleteness, TripOutcome} from './api';

export const MAX_UPLOAD_PROJECTION_PINS=8;
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
  revenue: Available<Money>; penalty: Available<Money>;
  /** Aggregate accounting uncertainty does not invalidate native terminal money. */
  moneyIncomplete: boolean;
  clockAnomaly: boolean;
  hardModeResult: 'qualified' | 'not-qualified';
}
export interface UploadProjection {
  requestedTripUuid: string; rootTripUuid: string; readiness: UploadReadiness | 'redirected'; rootReadiness: UploadReadiness;
  snapshot: string; databaseUuid: string; purpose: 'history' | 'synthetic' | 'replay'; revision: string;
  bounds: {members: string; events: string; gaps: string; samples: string; intervals: string; accountingHead: string | null};
  totals: Record<UploadPageKind, number>; facts: UploadFacts;
  /** Optional only for retained pre-proof pins. Never part of the HTTP summary. */
  ruleContext?: RuleContext;
}
export interface UploadProjectionBegin {pinId: string; tripUuid: string}
export interface UploadProjectionPreparation {
  pinId: string; state: 'preparing' | 'ready' | 'invalidated' | 'releasing' | 'released';
  /** Rows examined or empty-stream/phase transitions in the last committed turn, at most 100. */
  examined: number; projection: UploadProjection | null;
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
const occurrence = shape({pluginSessionId: isUploadUuid, rawTripUuid: isUploadUuid, eventSeq: sequence, type: one(...EVENT_TYPES), utcMs: nullable(count)});
const mode = shape({mode: one('unknown','single-player','truckersmp','haulmp'), method: one('none','module-scan','process-scan'), confidence: one('none','weak','strong'), ambiguous: bool});
const facts = shape({game: one('ets2','ats'), pluginSessionId: isUploadUuid, outcome: one('open','none','delivered','cancelled'),
  closeReason: nullable(one('outcome','configuration-cleared','different-job','restart','discontinuity','gap')), recordingCompleteness: one('complete','partial','unknown'),
  openedBy: one('event','checkpoint'), checkpointNextEventSeq: nullable(sequence), checkpointUtcMs: nullable(count), opening: nullable(occurrence), outcomeOccurrence: nullable(occurrence), close: nullable(occurrence),
  gameMode: mode, job: jobCheck, observedDistance: available(real,'m'), fuelUsed: available(real,'L'), deliveredDistance: available(real,'m'), cargoDamage: available(real,'fraction'),
  revenue: moneyOf('s64'), penalty: moneyOf('s64'), moneyIncomplete: bool, clockAnomaly: bool, hardModeResult: one('qualified', 'not-qualified')});
const totals = shape({members: count, configurations: count, intervals: count});
const readiness = one('ready','identity-pending');
export const uploadSnapshotParts = (v: unknown): string[] | undefined => {
  if (typeof v !== 'string' || v.length > 256) return undefined;
  const p = v.split(':');
  return p.length === 6 && p[0] === 'u2' && isUploadUuid(p[1]) && isUploadUuid(p[2]) && isUploadUuid(p[3]) && isUploadUuid(p[4]) && positive(p[5]) ? p : undefined;
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
  if (!record(v)) return false;
  const {ruleContext,...legacy}=v;
  if (ruleContext!==undefined&&!isRuleContext(ruleContext))return false;
  if (!shape({requestedTripUuid: isUploadUuid, rootTripUuid: isUploadUuid, readiness: one('ready','identity-pending','redirected'), rootReadiness: readiness,
    snapshot: v => !!uploadSnapshotParts(v), databaseUuid: isUploadUuid, purpose: one('history','synthetic','replay'), revision: positive,
    bounds: shape({members: decimal, events: decimal, gaps: decimal, samples: decimal, intervals: decimal, accountingHead: nullable(positive)}), totals, facts})(legacy)) return false;
  const p = v as unknown as UploadProjection, token = uploadSnapshotParts(p.snapshot)!;
  return (requested === undefined || requested === p.requestedTripUuid) && token[1] === p.databaseUuid && token[4] === p.rootTripUuid && token[5] === p.revision && (p.requestedTripUuid !== p.rootTripUuid ? p.readiness === 'redirected' : p.readiness === p.rootReadiness);
}
export const isUploadProjectionBegin = (v: unknown): v is UploadProjectionBegin => shape({pinId: isUploadUuid, tripUuid: isUploadUuid})(v);
export function isUploadPreparation(v: unknown, pinId: string): v is UploadProjectionPreparation {
  if (!shape({pinId: one(pinId), state: one('preparing','ready','invalidated','releasing','released'), examined: v => count(v) && (v as number)<=100,
    projection: nullable(v => isUploadProjection(v))})(v)) return false;
  const p = v as UploadProjectionPreparation;
  return p.state === 'ready' ? p.projection !== null && uploadSnapshotParts(p.projection.snapshot)![2] === p.pinId : p.projection === null;
}
const rowChecks: Record<UploadPageKind, Check> = {
  members: shape({id: positive, rawTripUuid: isUploadUuid, pluginSessionId: isUploadUuid, game: one('ets2','ats'), origin: one('game','synthetic','replay'), versions}),
  configurations: shape({id: positive, occurrence, index: v => count(v) && (v as number) <= 9, idValue: available(text), bodyType: available(text), chainType: available(text)}),
  intervals: shape({id: positive, rawTripUuid: isUploadUuid, pluginSessionId: isUploadUuid, kind: one('event-loss','not-connected','storage-unavailable','sample-loss','discontinuity','restore-loss')})
};
export function isUploadProjectionPage(v: unknown, query: UploadProjectionPageQuery): v is UploadProjectionPage {
  if (!isUploadPageQuery(query) || !shape({snapshot: one(query.snapshot), kind: one(query.kind), cursor: one(query.cursor ?? null), nextCursor: nullable(text), total: count,
    rows: v => Array.isArray(v) && v.length <= query.limit && v.every(rowChecks[query.kind])})(v)) return false;
  const p = v as UploadProjectionPage, total = p.total;
  let after = query.cursor ? BigInt(query.cursor.split(':').at(-1)!) : 0n;
  for (const row of p.rows) {if (BigInt(row.id) <= after) return false; after = BigInt(row.id);}
  return p.rows.length <= total && (p.nextCursor === null || p.rows.length === query.limit
    && p.nextCursor === `${query.snapshot}:${query.kind}:${after}`);
}

export interface UploadTime {utcMs: number | null; basis: 'event' | 'checkpoint' | 'last-known' | 'receipt' | 'unknown'; eventSeq: string | null}
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
    hardModeResult?: 'qualified' | 'not-qualified';
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
      if (done || page.total !== pin.totals[kind] || !isUploadProjectionPage(page, {snapshot: pin.snapshot, kind, cursor, limit: Math.max(1, page.rows.length)})) return hold('evidence-incomplete');
      collected[kind].push(...page.rows); cursor = page.nextCursor ?? undefined; done = page.nextCursor === null;
    }
    if (!done || collected[kind].length !== pin.totals[kind]) return hold('evidence-incomplete');
  }
  if (pages.some(p => !UPLOAD_PAGE_KINDS.includes(p.kind))) return hold('evidence-incomplete');
  const members = collected.members as UploadMember[], configs = collected.configurations as UploadConfiguration[], intervals = collected.intervals as UploadInterval[];
  const f = pin.facts, openingMember = members.find(m => m.rawTripUuid === pin.rootTripUuid && m.pluginSessionId === f.pluginSessionId);
  if (!openingMember || members.some(m => m.origin !== 'game' || m.game !== f.game)) return hold('source-ineligible');
  const owned = (e: QualifiedOccurrence | null) => !e || members.some(m => m.rawTripUuid === e.rawTripUuid && m.pluginSessionId === e.pluginSessionId);
  // Restart carriers may come from a new session while closing an earlier raw trip.
  const closeOwned = !f.close || owned(f.close) || f.closeReason === 'restart' && members.some(m => m.rawTripUuid === f.close!.rawTripUuid);
  if (![f.opening,f.outcomeOccurrence].every(owned) || !closeOwned || configs.some(c => !owned(c.occurrence))
 || !lifecycleValid(pin)) return hold('evidence-contradictory');
  const changed=new Set(configs.map(c=>c.index)).size!==configs.length;
  return projectedSummary(pin,openingMember.versions,changed?[]:configs.map(c=>({index:c.index,id:c.idValue,bodyType:c.bodyType,chainType:c.chainType})),configs.length>0,intervals.some(i=>i.kind!=='sample-loss'),changed);
}
function lifecycleValid(pin:UploadProjection):boolean {
  const f=pin.facts;
  return !(f.outcome === 'open' && f.close !== null
    || f.close && f.outcomeOccurrence && f.close.rawTripUuid !== f.outcomeOccurrence.rawTripUuid
    || f.openedBy === 'event' && (!f.opening || f.opening.type !== 'job.configured' || f.opening.rawTripUuid !== pin.rootTripUuid || f.opening.pluginSessionId !== f.pluginSessionId)
    || f.openedBy === 'event' && f.checkpointNextEventSeq !== null
    || f.openedBy === 'checkpoint' && (f.opening !== null || !f.checkpointNextEventSeq)
    || (f.outcome === 'delivered' || f.outcome === 'cancelled') && f.outcomeOccurrence?.type !== `job.${f.outcome}`
    || (f.outcome === 'open' || f.outcome === 'none') && f.outcomeOccurrence !== null
    || f.outcome === 'open' && f.closeReason !== null || f.outcome !== 'open' && f.closeReason === null
    || (f.outcome === 'delivered' || f.outcome === 'cancelled') && f.closeReason !== 'outcome'
    || f.outcome === 'none' && f.closeReason === 'outcome');
}
function projectedSummary(pin:UploadProjection,openingVersions:UploadVersions,items:UploadSummary['snapshot']['trailers']['items'],hasConfigurations:boolean,hasIntervals:boolean,changed:boolean):UploadMapping {
  const f=pin.facts,j=f.job;
  const hold=(reason:Extract<UploadMapping,{status:'hold'}>['reason']):UploadMapping=>({status:'hold',reason});
  const time = (e: QualifiedOccurrence | null): UploadTime => e?.utcMs !== null && e?.utcMs !== undefined && e.utcMs <= 253_402_300_799_999
    ? {utcMs: e.utcMs, basis: 'event', eventSeq: e.eventSeq} : {utcMs: null, basis: 'unknown', eventSeq: null};
  const start: UploadTime = f.openedBy === 'checkpoint' ? {utcMs: f.checkpointUtcMs, basis: 'checkpoint', eventSeq: null} : time(f.opening);
  const end = f.outcome === 'open' ? null : time(f.outcomeOccurrence ?? f.close);
  const clockAnomaly = f.clockAnomaly || start.utcMs !== null && end?.utcMs !== null && end?.utcMs !== undefined && end.utcMs < start.utcMs;
  const proof=pin.ruleContext?.status==='proven'&&(pin.ruleContext.version===1||!chainComplete(pin.ruleContext.items))?{...pin.ruleContext,status:'unproven' as const}:pin.ruleContext,reasons=new Set<string>();
  if(proof){
    if(proof.status==='proven'||proof.items.length||proof.status==='changed')items=proof.items;
    if(proof.status!=='proven')reasons.add(`trailer-context-${proof.status}`);
    if(proof.recordingLoss)reasons.add('recording-intervals');
  }else{
    reasons.add('trailer-context-unproven');
    if(changed)reasons.add('trailer-context-changed');
    if(!hasConfigurations)reasons.add('trailer-context-unavailable');
    if(hasIntervals)reasons.add('recording-intervals');
  }
  // v1 has no separate accounting-uncertainty field; retain its existing wire-visible reason.
  if(f.moneyIncomplete)reasons.add('accounting-unavailable');
  if(!usable(j.sourceCityId)||!usable(j.destinationCityId)||!usable(j.cargoId))reasons.add('job-context-unavailable');
  if(!j.cargoMass.available||!Number.isFinite(j.cargoMass.value)||j.cargoMass.value<0)reasons.add('cargo-mass-unavailable');
  if (items.length > 10) return hold('unrepresentable');
  const place = (prefix: 'source' | 'destination'): UploadPlace => ({cityId: j[`${prefix}CityId`], cityName: j[`${prefix}City`], companyId: j[`${prefix}CompanyId`], companyName: j[`${prefix}Company`]});
  const summary: UploadSummary = {source: {provider: 'ets2telemetry', game: f.game, tripId: pin.rootTripUuid, pluginSessionId: f.pluginSessionId, databaseUuid: pin.databaseUuid, origin: 'game'}, snapshot: {
    outcome: f.outcome, closeReason: f.closeReason, recordingCompleteness: f.outcome === 'none' ? 'partial' : f.recordingCompleteness,
    start, end, openedBy: f.openedBy, openedEventSeq: f.opening?.eventSeq ?? null, checkpointNextEventSeq: f.checkpointNextEventSeq, outcomeEventSeq: f.outcomeOccurrence?.eventSeq ?? null,
    context: {gameBuild: absent, sourceLocale: absent, mapId: absent, dlcIds: absent, versions: openingVersions}, gameMode: f.gameMode,
    job: {origin: place('source'), destination: place('destination'), cargoId: j.cargoId, cargoName: j.cargo, cargoMass: j.cargoMass, cargoUnitMass: j.cargoUnitMass,
      cargoUnitCount: j.cargoUnitCount, market: j.market, isSpecialJob: j.isSpecialJob, cargoLoaded: j.cargoLoaded},
    trailers: {complete: proof?.status==='proven', items}, plannedDistance: j.plannedDistance, observedDistance: f.observedDistance, deliveredDistance: f.deliveredDistance,
    fuelUsed: f.fuelUsed, cargoDamage: f.cargoDamage, expectedIncome: j.expectedIncome, revenue: f.revenue, penalty: f.penalty,
    evidence: {startObserved: start.basis === 'event' && !clockAnomaly, endObserved: !!f.outcomeOccurrence && end?.basis === 'event' && !clockAnomaly,
      ruleContextComplete: reasons.size===0, clockAnomaly, reasons: [...reasons].sort()},
    hardModeResult: f.hardModeResult
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

/** Constant-size durable fold: at most ten trailer slots and three occurrence checks, never full history arrays. */
export interface UploadFold {
  ruleContextVersion?:1;kind:number;cursor:string|null;counts:Record<UploadPageKind,number>;openingVersions:UploadVersions|null;
  openingOwned:boolean;outcomeOwned:boolean;closeOwned:boolean;hasIntervals:boolean;changed:boolean;
  items:UploadSummary['snapshot']['trailers']['items'];invalid:Extract<UploadMapping,{status:'hold'}>['reason']|null;
}
export function beginUploadFold(pin:UploadProjection):UploadFold {
  return {ruleContextVersion:1,kind:0,cursor:null,counts:{members:0,configurations:0,intervals:0},openingVersions:null,openingOwned:pin.facts.opening===null,
    outcomeOwned:pin.facts.outcomeOccurrence===null,closeOwned:pin.facts.close===null,hasIntervals:false,changed:false,items:[],invalid:null};
}
export function advanceUploadFold(pin:UploadProjection,prior:UploadFold,page:UploadProjectionPage,isMember:(rawTripUuid:string,pluginSessionId:string)=>boolean):UploadFold {
  const fold=structuredClone(prior),kind=UPLOAD_PAGE_KINDS[fold.kind];
  if(!kind||page.kind!==kind||page.total!==pin.totals[kind]||!isUploadProjectionPage(page,{snapshot:pin.snapshot,kind,cursor:fold.cursor??undefined,limit:Math.max(1,page.rows.length)})){
    fold.invalid='evidence-incomplete';return fold;
  }
  for(const row of page.rows){
    if(kind==='members'){
      const member=row as UploadMember;
      if(member.origin!=='game'||member.game!==pin.facts.game)fold.invalid='source-ineligible';
      if(member.rawTripUuid===pin.rootTripUuid&&member.pluginSessionId===pin.facts.pluginSessionId)fold.openingVersions=member.versions;
      const owns=(ref:QualifiedOccurrence|null)=>!!ref&&ref.rawTripUuid===member.rawTripUuid&&ref.pluginSessionId===member.pluginSessionId;
      fold.openingOwned ||= owns(pin.facts.opening);fold.outcomeOwned ||= owns(pin.facts.outcomeOccurrence);
      fold.closeOwned ||= owns(pin.facts.close)||pin.facts.closeReason==='restart'&&pin.facts.close?.rawTripUuid===member.rawTripUuid;
    }else if(kind==='configurations'){
      const config=row as UploadConfiguration;
      if(!isMember(config.occurrence.rawTripUuid,config.occurrence.pluginSessionId))fold.invalid='evidence-contradictory';
      if(!fold.changed){
        if(fold.items.some(item=>item.index===config.index)){fold.changed=true;fold.items=[];}
        else fold.items.push({index:config.index,id:config.idValue,bodyType:config.bodyType,chainType:config.chainType});
      }
    }else if((row as UploadInterval).kind!=='sample-loss')fold.hasIntervals=true;
  }
  fold.counts[kind]+=page.rows.length;fold.cursor=page.nextCursor;
  if(page.nextCursor===null){if(fold.counts[kind]!==pin.totals[kind])fold.invalid='evidence-incomplete';fold.kind++;}
  return fold;
}
export function finishUploadFold(pin:UploadProjection,fold:UploadFold):UploadMapping {
  if(!isUploadProjection(pin))return {status:'hold',reason:'evidence-contradictory'};
  if(pin.rootReadiness!=='ready')return {status:'hold',reason:'identity-pending'};
  if(pin.purpose!=='history')return {status:'hold',reason:'source-ineligible'};
  if(fold.invalid)return {status:'hold',reason:fold.invalid};
  if(fold.kind!==3||UPLOAD_PAGE_KINDS.some(kind=>fold.counts[kind]!==pin.totals[kind]))return {status:'hold',reason:'evidence-incomplete'};
  if(!fold.openingVersions)return {status:'hold',reason:'source-ineligible'};
  if(!fold.openingOwned||!fold.outcomeOwned||!fold.closeOwned||!lifecycleValid(pin))return {status:'hold',reason:'evidence-contradictory'};
  return projectedSummary(fold.ruleContextVersion===1?pin:{...pin,ruleContext:undefined},fold.openingVersions,fold.items,fold.counts.configurations>0,fold.hasIntervals,fold.changed);
}

/** Exact closed source/snapshot shape shared with the frozen-envelope boundary. */
export function isUploadSummary(value:unknown, minor = 0):value is UploadSummary {
  const time=shape({utcMs:nullable(count),basis:one('event','checkpoint','last-known','receipt','unknown'),eventSeq:nullable(sequence)});
  const place=shape({cityId:available(text),cityName:available(text),companyId:available(text),companyName:available(text)});
  const metric=(unit:string)=>available(real,unit);
  const snapshotFields: Record<string, Check> = {
    outcome:one('open','none','delivered','cancelled'),closeReason:nullable(one('outcome','configuration-cleared','different-job','restart','discontinuity','gap')),recordingCompleteness:one('complete','partial','unknown'),
    start:time,end:nullable(time),openedBy:one('event','checkpoint'),openedEventSeq:nullable(sequence),checkpointNextEventSeq:nullable(sequence),outcomeEventSeq:nullable(sequence),
    context:shape({gameBuild:available(text),sourceLocale:available(text),mapId:available(text),dlcIds:available(v=>Array.isArray(v)&&v.length<=256&&v.every(text)&&new Set(v).size===v.length),versions}),gameMode:mode,
    job:shape({origin:place,destination:place,cargoId:available(text),cargoName:available(text),cargoMass:metric('kg'),cargoUnitMass:metric('kg'),cargoUnitCount:available(v=>count(v)&&(v as number)<=4_294_967_295),market:available(text),isSpecialJob:available(bool),cargoLoaded:available(bool)}),
    trailers:shape({complete:bool,items:v=>Array.isArray(v)&&v.length<=10&&v.every(shape({index:v=>count(v)&&(v as number)<=9,id:available(text),bodyType:available(text),chainType:available(text)}))}),
    plannedDistance:metric('m'),observedDistance:metric('m'),deliveredDistance:metric('m'),fuelUsed:metric('L'),cargoDamage:metric('fraction'),expectedIncome:moneyOf('u64'),revenue:moneyOf('s64'),penalty:moneyOf('s64'),
    evidence:shape({startObserved:bool,endObserved:bool,ruleContextComplete:bool,clockAnomaly:bool,reasons:v=>Array.isArray(v)&&v.length<=32&&new Set(v).size===v.length&&v.every(x=>typeof x==='string'&&/^[a-z][a-z0-9-]{0,63}$/.test(x))})
  };
  if(minor === 1) snapshotFields.hardModeResult = one('qualified', 'not-qualified');
  const check=shape({source:shape({provider:one('ets2telemetry'),game:one('ets2','ats'),tripId:isUploadUuid,pluginSessionId:isUploadUuid,databaseUuid:isUploadUuid,origin:one('game')}),
    snapshot:shape(snapshotFields)});
  if(!check(value))return false;
  const summary=value as UploadSummary,s=summary.snapshot;
  const validTime=(t:UploadTime)=>t.basis==='unknown'?t.utcMs===null&&t.eventSeq===null:t.utcMs!==null&&(t.basis==='event'?t.eventSeq!==null:t.eventSeq===null);
  return wireValuesFit(summary)&&validTime(s.start)&&(s.end===null||validTime(s.end))
    && (s.outcome==='open'?s.end===null&&s.closeReason===null:s.end!==null&&s.closeReason!==null)
    && (s.openedBy==='event'?s.openedEventSeq!==null&&s.checkpointNextEventSeq===null:s.openedEventSeq===null&&s.checkpointNextEventSeq!==null)
    && (s.outcome==='delivered'||s.outcome==='cancelled'?s.outcomeEventSeq!==null&&s.closeReason==='outcome':s.outcomeEventSeq===null)
    && (!s.evidence.startObserved||s.start.basis==='event'&&s.start.eventSeq===s.openedEventSeq)
    && (!s.evidence.endObserved||s.end?.basis==='event'&&s.end.eventSeq===s.outcomeEventSeq)
    && (s.start.utcMs===null||s.end?.utcMs===null||s.end?.utcMs===undefined||s.end.utcMs>=s.start.utcMs||s.evidence.clockAnomaly)
    && (!s.trailers.complete||chainComplete(s.trailers.items))
    && (!s.evidence.ruleContextComplete||s.evidence.reasons.length===0&&s.trailers.complete&&usable(s.job.origin.cityId)&&usable(s.job.destination.cityId)&&usable(s.job.cargoId)&&s.job.cargoMass.available)
    && new Set(s.trailers.items.map(item=>item.index)).size===s.trailers.items.length;
}
