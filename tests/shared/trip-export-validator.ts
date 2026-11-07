// An independent check of an `ets2telemetry.trip-export` format version 1 document (ET-016 PR-5, J15, J17), written by
// hand from docs/journal-export.md and never from the serializer. It has no runtime imports, so the unit and storage
// suites import it directly and the journal runtime smoke bundles it with Vite. It returns every problem it finds as a
// fixed text with a JSON path; an empty list means the document is valid.

const TOP_KEYS = ['format', 'formatVersion', 'header', 'units', 'bounds', 'trip', 'job', 'truck', 'trailers', 'outcomeDetails', 'money', 'window', 'intervals', 'events', 'samples'];
const UNITS = {
  distance: 'm', speed: 'm/s', fuel: 'L', averageConsumption: 'L/100 km (the SDK mean, not a trip average)', mass: 'kg', engineSpeed: 'rpm',
  gear: 'gear index (0 neutral, negative reverse)', cargoDamage: 'fraction (0 to 1)', position: 'm (game-world coordinates, not latitude or longitude)',
  gameTime: 'min (game minutes of the game clock named by clockId)', monotonicTime: 'ns (the source clock named by its clock id)',
  utcLabel: 'ms since the Unix epoch (a label, not monotonic time)',
  money: 'exact decimal text in the SDK type; currency as documented by the SDK header or unknown, never converted'
};
const ORIGIN: Record<string, string> = {history: 'game', synthetic: 'synthetic', replay: 'replay'};
const TRIP_KEYS = ['tripUuid', 'pluginSessionId', 'game', 'gameMode', 'gameModeAmbiguous', 'outcome', 'closeReason', 'recordingCompleteness', 'startedUtcMs', 'endedUtcMs',
  'observedDistanceM', 'fuelUsedL', 'openedBy', 'openedEventSeq', 'outcomeEventSeq', 'closedBy'];
const INTERVAL_KEYS = ['id', 'kind', 'annotation', 'cause', 'startUtcMs', 'endUtcMs', 'startMonotonicNs', 'endMonotonicNs', 'sourceClockId', 'firstEventSeq', 'lastEventSeq', 'detail'];
const EVENT_KEYS = ['eventSeq', 'type', 'occurred', 'record', 'attribution'];
const SAMPLE_KEYS = ['id', 'utcMs', 'sourceClockId', 'monotonicNs', 'gameTime', 'speed', 'fuel', 'averageConsumption', 'estimatedRange', 'engineRpm', 'gear', 'odometer', 'position'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const ROW_ID = /^[1-9][0-9]{0,18}$/;
const REASONS = ['not-observed', 'not-supported', 'invalid'];

type Json = Record<string, unknown>;
/** Text for a pattern test; anything but a string tests as empty text. */
const textOf = (value: unknown) => typeof value === 'string' ? value : '';
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const sameKeys = (value: Json, keys: readonly string[]) => Object.keys(value).length === keys.length && keys.every((key, index) => Object.keys(value)[index] === key);

/** Every problem of `document` as a format version 1 trip export; an empty list for a valid one. */
export function tripExportProblems(document: unknown): string[] {
  const problems: string[] = [];
  const problem = (where: string, what: string) => { problems.push(`${where}: ${what}`); };
  if (!isObject(document)) return ['$: not an object'];
  const topKeys = (document.formatVersion === 4 || document.formatVersion === 5) ? [...TOP_KEYS.slice(0,12),'diagnostics','sources',...TOP_KEYS.slice(12)] : document.formatVersion === 3 ? [...TOP_KEYS.slice(0,12),'diagnostics',...TOP_KEYS.slice(12)] : TOP_KEYS;
  if (!sameKeys(document, topKeys)) problem('$', `keys are not ${topKeys.join(', ')} in this order`);
  if (document.format !== 'ets2telemetry.trip-export') problem('$.format', 'not ets2telemetry.trip-export');
  if (document.formatVersion !== 1 && document.formatVersion !== 2 && document.formatVersion !== 3 && document.formatVersion !== 4 && document.formatVersion !== 5) problem('$.formatVersion', 'not 1, 2, 3, 4 or 5');

  const header = document.header;
  if (!isObject(header) || !isObject(header.application) || header.application.name !== 'ETS2Telemetry' || typeof header.application.version !== 'string'
    || !Number.isSafeInteger(header.exportedUtcMs) || (header.exportedUtcMs as number) < 0 || !isObject(header.database)
    || !UUID.test(textOf(header.database.uuid)) || !(textOf(header.database.purpose) in ORIGIN) || !Number.isSafeInteger(header.database.schemaVersion)
    || (header.database.schemaVersion as number) < 1 || header.sessionOrigin !== ORIGIN[textOf(header.database.purpose)]) problem('$.header', 'malformed');
  if (JSON.stringify(document.units) !== JSON.stringify(UNITS)) problem('$.units', 'not the canonical units of format version 1');

  // Availability and money shapes anywhere in the document (protocol v1).
  const walk = (value: unknown, where: string) => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${where}[${index}]`)); return; }
    if (!isObject(value)) return;
    if ('available' in value) {
      const keys = Object.keys(value).filter(key => key !== 'unit');
      if (value.available === true ? !(keys.length === 2 && 'value' in value) : !(value.available === false && keys.length === 2 && REASONS.includes(textOf(value.reason))))
        problem(where, 'not an availability shape');
      if ('unit' in value && typeof value.unit !== 'string') problem(where, 'unit is not text');
    }
    if ('raw' in value && 'sdkType' in value) {
      const currency = value.currency;
      if (typeof value.raw !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(value.raw) || (value.sdkType !== 's64' && value.sdkType !== 'u64')) problem(where, 'money is not exact decimal text');
      if (!isObject(currency) || !(currency.status === 'unknown' ? Object.keys(currency).length === 1
        : currency.status === 'sdk-documented' && /^[A-Z]{3}$/.test(textOf(currency.code)) && typeof currency.source === 'string' && currency.source.length > 0 && Object.keys(currency).length === 3))
        problem(where, 'currency is neither sdk-documented with a code and source nor unknown');
    }
    for (const [key, item] of Object.entries(value)) walk(item, `${where}.${key}`);
  };
  walk(document, '$');

  const trip = document.trip, bounds = document.bounds;
  if (!isObject(trip) || !sameKeys(trip, document.formatVersion !== 1 ? ['is_hard_mode', 'hard_mode_details', ...TRIP_KEYS] : TRIP_KEYS) || !UUID.test(textOf(trip.tripUuid)) || !UUID.test(textOf(trip.pluginSessionId))) problem('$.trip', 'malformed');
  else if ((trip.outcome === 'open') !== (trip.closeReason === null) || (trip.outcome === 'open') !== (trip.endedUtcMs === null)) problem('$.trip', 'outcome, close reason and end disagree');
  if (!isObject(bounds) || !sameKeys(bounds, [...((document.formatVersion === 4 || document.formatVersion === 5) && isObject(bounds) && bounds.projection !== undefined ? ['projection','sources','sourceTotal','accountingHead']:[]), 'committedThroughEventSeq', 'lastSampleId', 'lastIntervalId', 'snapshot']) || !U64.test(textOf(bounds.committedThroughEventSeq))
    || (bounds.lastSampleId !== null && !ROW_ID.test(textOf(bounds.lastSampleId))) || (bounds.lastIntervalId !== null && !ROW_ID.test(textOf(bounds.lastIntervalId)))
    || bounds.snapshot !== (isObject(trip) && trip.outcome === 'open')) { problem('$.bounds', 'malformed'); return problems; }
  if ((document.formatVersion === 4 || document.formatVersion === 5) && bounds.projection !== undefined) {
    if (!isObject(bounds.projection) || !sameKeys(bounds.projection,['events','intervals','samples','sources']) || !Array.isArray(bounds.sources) || bounds.sources.length>256) problem('$.bounds','invalid logical projection');
    else for (const [kind,name] of [['e','events'],['i','intervals'],['s','samples'],['r','sources']]) if (!new RegExp('^v4:[0-9a-f-]{36}:[0-9a-f-]{36}:[1-9][0-9]{0,18}:'+kind+':0$').test(textOf(bounds.projection[name]))) problem('$.bounds.projection','invalid page token');
    for (const source of Array.isArray(bounds.sources)?bounds.sources:[]) if (!isObject(source) || !sameKeys(source,['pluginSessionId','committedThroughEventSeq']) || !UUID.test(textOf(source.pluginSessionId)) || !U64.test(textOf(source.committedThroughEventSeq))) problem('$.bounds.sources','invalid source bound');
  }
  if (document.formatVersion !== 1 && isObject(trip)) {
    if (typeof trip.is_hard_mode !== 'boolean') problem('$.trip.is_hard_mode', 'not boolean');
    const audit = trip.hard_mode_details;
    const keys = ['version', 'binding', 'opening', 'latest', 'firstLoss', 'manualDelivery'];
    if (document.formatVersion === 5 && isObject(audit) && audit.version === 2) {
      const safe = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
      const countKeys = ['passingChecks', 'failingChecks', 'unknownChecks'];
      const codes = ['settings-changing', 'settings-unavailable', 'profile-verification', 'source-changed', 'guard-deadline', 'session-transition', 'storage-failure', 'rule-failed'];
      const ruleIds = ['fuel','air','police','fatigue','limiter','truck','trailer','parking','rain','events','braking','traffic'];
      const values = (v: unknown, rule: unknown) => Array.isArray(v) && v.length === (rule === 'parking' ? 2 : 1) && v.every(n => n === null || typeof n === 'number' && Number.isFinite(n));
      const assessment = (v: unknown) => {
        if (!isObject(v) || !(Object.keys(v).length === 4 && ['observedUtcMs','state','source','rules'].every(k=>Object.hasOwn(v,k))) || !safe(v.observedUtcMs) || !['local','cloud','fixture','unknown'].includes(textOf(v.source)) || !Array.isArray(v.rules) || v.rules.length !== 12) return false;
        const rules = v.rules;
        if (!rules.every((r,i) => isObject(r) && sameKeys(r,['id','state','values','reason']) && r.id === ruleIds[i] && values(r.values,r.id)
          && (r.state === 'pass' ? r.reason === 'compliant' && (r.values as unknown[]).every(n=>n!==null) : r.state === 'fail' ? r.reason === 'outside-limit' && (r.values as unknown[]).every(n=>n!==null)
            : r.state === 'unknown' && ['missing','malformed','conflicting','source-unproven','interrupted','historical','source-changed','parking-unproven'].includes(textOf(r.reason))))) return false;
        return v.state === (rules.some(r=>(r as Json).state==='unknown')?'unknown':rules.every(r=>(r as Json).state==='pass')?'pass':'fail');
      };
      const diag = (v: unknown) => v === null || isObject(v) && sameKeys(v,['atUtcMs','code','rule','values']) && safe(v.atUtcMs) && codes.includes(textOf(v.code))
        && (v.rule === null ? v.values === null : ruleIds.includes(textOf(v.rule)) && values(v.values,v.rule));
      const countsValid = countKeys.every(k=>safe(audit[k])) && Number.isSafeInteger(Number(audit.passingChecks)+Number(audit.failingChecks)+Number(audit.unknownChecks));
      const checkpoint = audit.checkpoint;
      const checkpointValid = checkpoint === null || isObject(checkpoint) && sameKeys(checkpoint,['tripUuid','producer','sequence',...countKeys])
        && UUID.test(textOf(checkpoint.tripUuid)) && UUID.test(textOf(checkpoint.producer)) && safe(checkpoint.sequence) && checkpoint.sequence > 0
        && countKeys.every(k=>safe(checkpoint[k]) && Number(checkpoint[k])<=Number(audit[k])) && checkpoint.sequence === Number(checkpoint.passingChecks)+Number(checkpoint.failingChecks)+Number(checkpoint.unknownChecks);
      if (!sameKeys(audit,[...keys,...countKeys,'checkpoint','firstDiagnostic','latestDiagnostic']) || !(audit.binding===null || /^[0-9a-f]{64}$/.test(textOf(audit.binding)))
        || !assessment(audit.opening) || !assessment(audit.latest) || audit.firstLoss !== null || audit.manualDelivery !== null || !countsValid || !checkpointValid
        || !diag(audit.firstDiagnostic) || !diag(audit.latestDiagnostic) || (audit.firstDiagnostic===null)!==(audit.latestDiagnostic===null)) problem('$.trip.hard_mode_details','malformed v2');
      if (countsValid) {
        const known = BigInt(Number(audit.passingChecks))+BigInt(Number(audit.failingChecks));
        const qualified = trip.outcome === 'delivered' && known > 0n && BigInt(Number(audit.passingChecks))*100n >= known*95n;
        if (trip.is_hard_mode !== qualified) problem('$.trip.is_hard_mode','does not match the v2 ratio');
      }
    } else {
      if (audit !== null && (!isObject(audit) || !sameKeys(audit, keys) || audit.version !== 1
        || !(audit.binding === null || /^[0-9a-f]{64}$/.test(textOf(audit.binding)))
        || !(audit.manualDelivery === null || typeof audit.manualDelivery === 'boolean'))) problem('$.trip.hard_mode_details', 'malformed');
      if (trip.is_hard_mode && (trip.outcome !== 'delivered' || !isObject(audit) || audit.firstLoss !== null || audit.manualDelivery === false)) problem('$.trip.is_hard_mode', 'qualification lacks delivery proof');
    }
  }
  const window = document.window;
  if ((document.formatVersion === 3 || (document.formatVersion === 4 || document.formatVersion === 5))) {
    const d = document.diagnostics;
    if (!isObject(d) || !sameKeys(d, ['collection', 'matchedBy', 'status', 'notes', 'records']) || d.collection !== 'retained-logs-at-export'
      || d.matchedBy !== 'plugin-session-and-utc-window' || !['records-found', 'no-matching-records', 'unavailable', 'not-applicable'].includes(textOf(d.status))
      || !Array.isArray(d.notes) || !d.notes.every(n => ['LOGS_MAY_BE_INCOMPLETE', 'GAME_LOG_UNAVAILABLE', 'SERVICE_LOG_UNAVAILABLE', 'RECORD_LIMIT', 'COLLECTION_FAILED', 'SOURCE_MODE_ISOLATED', 'INVALID_TIME_WINDOW', 'RESTART_CLOSE_CONTEXT'].includes(textOf(n)))
      || !Array.isArray(d.records) || d.records.length > 256) problem('$.diagnostics', 'malformed');
    else for (const row of d.records) {
      if (!isObject(row) || !sameKeys(row, ['time', 'event', 'facts']) || !Number.isFinite(Date.parse(textOf(row.time)))
        || !['PLUGIN_V1_CONNECTION_CLOSED', 'NATIVE_BROKER_V1_EXIT'].includes(textOf(row.event)) || !isObject(row.facts) || !isObject(trip)
        || row.facts.game !== trip.game || !((document.formatVersion===4 || document.formatVersion===5) && Array.isArray(document.sources) && document.sources.length?document.sources:Array.isArray(bounds.sources)?bounds.sources:[{pluginSessionId:trip.pluginSessionId}]).some(s=>isObject(s)&&s.pluginSessionId===(row.facts as Json).pluginSessionId)) { problem('$.diagnostics.records', 'malformed or unrelated'); continue; }
      const allowed = row.event === 'PLUGIN_V1_CONNECTION_CLOSED'
        ? ['game', 'pluginSessionId', 'reason', 'phase', 'write', 'end', 'win32', 'durable', 'connection', 'durationMs']
        : ['game', 'pluginSessionId', 'outcome', 'exitCode', 'serviceMs', 'stage', 'win32Error', 'elapsedMs', 'slowStage', 'slowMs', 'repeats'];
      if (Object.keys(row.facts).length !== allowed.length || !Object.keys(row.facts).every(k => allowed.includes(k))) problem('$.diagnostics.records.facts', 'unexpected facts');
      if (row.event === 'NATIVE_BROKER_V1_EXIT' && row.facts.repeats !== null && !(Number.isSafeInteger(row.facts.repeats) && (row.facts.repeats as number) > 0)) problem('$.diagnostics.records.facts.repeats', 'not a positive safe integer or null');
    }
  }
  if (!isObject(window) || !isObject(trip) || window.pluginSessionId !== trip.pluginSessionId) problem('$.window', 'not the trip session');

  // Rows: their own keys, ascending ids and inside the bounds (J17). A null sample or interval bound means the trip had
  // no such rows at the detail read, so any row is past it. A non-null one is the trip's largest id at that read, and
  // storage deletes no history rows, so the section must hold that row; with ascending ids inside the bound it is the last.
  // The event bound is the session's committed coverage, not a row of the trip: its window can be empty (J7).
  const rows = (name: 'intervals' | 'events' | 'samples', keys: readonly string[], id: (row: Json) => unknown, last: string | null, rowAtBound = false) => {
    const list = document[name];
    if (!Array.isArray(list)) { problem(`$.${name}`, 'not an array'); return; }
    if (rowAtBound && last !== null && !list.some((row: unknown) => isObject(row) && id(row) === last)) problem(`$.${name}`, 'no row at the export bound');
    let previous = -1n;
    list.forEach((row: unknown, index) => {
      const where = `$.${name}[${index}]`;
      const qualified = (document.formatVersion === 4 || document.formatVersion === 5) && isObject(row) && row.pluginSessionId !== undefined;
      const sourceKeys = qualified ? name === 'events' ? ['id','pluginSessionId','rawTripUuid'] : name === 'samples' ? ['pluginSessionId','rawTripUuid','accountingIncluded'] : ['pluginSessionId','rawTripUuid'] : [];
      if (!isObject(row) || !sameKeys(row, [...sourceKeys,...keys])) { problem(where, 'keys differ'); return; }
      if (qualified && (!UUID.test(textOf(row.pluginSessionId)) || !UUID.test(textOf(row.rawTripUuid)) || name==='samples' && typeof row.accountingIncluded!=='boolean')) problem(where,'invalid source provenance');
      const key = textOf(qualified && name==='events' ? row.id : id(row));
      if (!U64.test(key)) { problem(where, 'id is not decimal text'); return; }
      if (BigInt(key) <= previous) problem(where, 'not in ascending order');
      previous = BigInt(key);
      if (qualified && name==='events') {
        const source=Array.isArray(document.sources)?document.sources.find(s=>isObject(s)&&s.pluginSessionId===row.pluginSessionId):undefined;
        if (!isObject(source) || !U64.test(textOf(row.eventSeq)) || BigInt(textOf(row.eventSeq))>BigInt(textOf(source.throughEventSeq ?? source.committedThroughEventSeq))) problem(where,'past source export bound');
      } else if (last === null || BigInt(key) > BigInt(last)) problem(where, 'past the export bounds');
    });
  };
  rows('intervals', INTERVAL_KEYS, row => row.id, bounds.lastIntervalId as string | null, true);
  rows('events', EVENT_KEYS, row => row.eventSeq, bounds.committedThroughEventSeq as string);
  rows('samples', SAMPLE_KEYS, row => row.id, bounds.lastSampleId as string | null, true);
  if((document.formatVersion===4 || document.formatVersion===5)){
    if(!Array.isArray(document.sources)) problem('$.sources','not an array');
    else {let previous=0n;for(const source of document.sources){
      if(!isObject(source)||!sameKeys(source,['id','rawTripUuid','pluginSessionId','fromEventSeq','throughEventSeq','lastSampleId','lastIntervalId'])||!ROW_ID.test(textOf(source.id))||!UUID.test(textOf(source.rawTripUuid))||!UUID.test(textOf(source.pluginSessionId))||!U64.test(textOf(source.fromEventSeq))||!U64.test(textOf(source.throughEventSeq))) {problem('$.sources','invalid source');continue;}
      if(BigInt(textOf(source.id))<=previous)problem('$.sources','not ascending');previous=BigInt(textOf(source.id));
    }
    if(bounds.sourceTotal!==undefined && document.sources.length!==bounds.sourceTotal)problem('$.sources','source count differs');}
  }
  for (const [index, event] of (Array.isArray(document.events) ? document.events : []).entries()) {
    if (!isObject(event) || !isObject(event.record) || event.record.type !== event.type) problem(`$.events[${index}]`, 'record type differs');
    const attribution = isObject(event) ? event.attribution : undefined;
    if (attribution !== null && !(isObject(attribution) && sameKeys(attribution, [...((document.formatVersion===4 || document.formatVersion===5) && attribution.logicalTripUuid!==undefined?['logicalTripUuid']:[]),'kind', 'tripUuid']))) problem(`$.events[${index}].attribution`, 'malformed');
  }
  return problems;
}
