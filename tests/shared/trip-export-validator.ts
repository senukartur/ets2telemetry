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
  if (!sameKeys(document, TOP_KEYS)) problem('$', `keys are not ${TOP_KEYS.join(', ')} in this order`);
  if (document.format !== 'ets2telemetry.trip-export') problem('$.format', 'not ets2telemetry.trip-export');
  if (document.formatVersion !== 1) problem('$.formatVersion', 'not 1');

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
  if (!isObject(trip) || !sameKeys(trip, TRIP_KEYS) || !UUID.test(textOf(trip.tripUuid)) || !UUID.test(textOf(trip.pluginSessionId))) problem('$.trip', 'malformed');
  else if ((trip.outcome === 'open') !== (trip.closeReason === null) || (trip.outcome === 'open') !== (trip.endedUtcMs === null)) problem('$.trip', 'outcome, close reason and end disagree');
  if (!isObject(bounds) || !sameKeys(bounds, ['committedThroughEventSeq', 'lastSampleId', 'lastIntervalId', 'snapshot']) || !U64.test(textOf(bounds.committedThroughEventSeq))
    || (bounds.lastSampleId !== null && !ROW_ID.test(textOf(bounds.lastSampleId))) || (bounds.lastIntervalId !== null && !ROW_ID.test(textOf(bounds.lastIntervalId)))
    || bounds.snapshot !== (isObject(trip) && trip.outcome === 'open')) { problem('$.bounds', 'malformed'); return problems; }
  const window = document.window;
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
      if (!isObject(row) || !sameKeys(row, keys)) { problem(where, 'keys differ'); return; }
      const key = textOf(id(row));
      if (!U64.test(key)) { problem(where, 'id is not decimal text'); return; }
      if (BigInt(key) <= previous) problem(where, 'not in ascending order');
      previous = BigInt(key);
      if (last === null || BigInt(key) > BigInt(last)) problem(where, 'past the export bounds');
    });
  };
  rows('intervals', INTERVAL_KEYS, row => row.id, bounds.lastIntervalId as string | null, true);
  rows('events', EVENT_KEYS, row => row.eventSeq, bounds.committedThroughEventSeq as string);
  rows('samples', SAMPLE_KEYS, row => row.id, bounds.lastSampleId as string | null, true);
  for (const [index, event] of (Array.isArray(document.events) ? document.events : []).entries()) {
    if (!isObject(event) || !isObject(event.record) || event.record.type !== event.type) problem(`$.events[${index}]`, 'record type differs');
    const attribution = isObject(event) ? event.attribution : undefined;
    if (attribution !== null && !(isObject(attribution) && sameKeys(attribution, ['kind', 'tripUuid']))) problem(`$.events[${index}].attribution`, 'malformed');
  }
  return problems;
}
