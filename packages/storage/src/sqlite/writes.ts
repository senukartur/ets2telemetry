// Write commands. Each command is one BEGIN IMMEDIATE transaction on the verified writer connection; a commit result
// exists only after COMMIT returned. Events and gaps are keyed UNIQUE(plugin session, eventSeq range): a redelivery
// is a no-op whose effects are never applied again (protocol v1 §10, docs/storage.md "Write commands").
import type Database from 'better-sqlite3';
import {validateServerMessage, type Available, type EventRecord, type GapData, type ServerMessage, type SourceIdentity} from '../../../contracts/src/protocol-v1';
import {
  MAX_EFFECTS, MAX_SAMPLE_BATCH, type CommitOptions, type CommitResult, type CompletenessInterval, type CompletenessOptions, type EventReference, type SampleAppendOptions,
  type SampleAppendResult, type SampleInput, type TripEffect, type Uint64
} from '../api';
import {
  AMOUNT_FIELD, availabilityColumns, canonicalJson, DELIVERY_FIELDS, fromU64Key, isUuid, JOB_FIELDS, maskBits, moneyColumns, SAMPLE_FIELDS, sampleMonotonicNs,
  specColumns, specValues, TRAILER_FIELDS, TRUCK_FIELDS, u64Key, type FieldSpec
} from '../codec';
import {fail} from '../errors';
import type {StorageConnection} from './connection';

const cache = new WeakMap<Database.Database, Map<string, Database.Statement>>();
/** Prepared statements are cached per connection; SQL text is always a constant of this module. */
export function statement(db: Database.Database, sql: string): Database.Statement {
  let map = cache.get(db); if (!map) cache.set(db, map = new Map<string, Database.Statement>());
  let prepared = map.get(sql); if (!prepared) map.set(sql, prepared = db.prepare(sql));
  return prepared;
}
const insert = (table: string, columns: readonly string[]) => `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
const GAMES = ['ets2', 'ats'], MODES = ['single-player', 'truckersmp', 'unknown', 'convoy'], METHODS = ['module-scan', 'process-scan', 'none'], CONFIDENCES = ['strong', 'weak', 'none'];
const COMPLETENESS = ['complete', 'partial', 'unknown'], OUTCOMES = ['delivered', 'cancelled', 'none'];
const CLOSE_REASONS = ['outcome', 'configuration-cleared', 'different-job', 'restart', 'discontinuity', 'gap'];
const ATTRIBUTIONS = ['trip', 'trip-before-loaded', 'free-driving', 'ambiguous'];
const INTERVAL_KINDS = ['event-loss', 'not-connected', 'storage-unavailable', 'sample-loss', 'discontinuity', 'restore-loss'];

function serverMessage(input: unknown, kind: 'welcome' | 'event' | 'gap'): ServerMessage {
  let message: ServerMessage;
  try { message = validateServerMessage(input); } catch { fail('INVALID_INPUT'); }
  if (message.kind !== kind) fail('INVALID_INPUT');
  return message;
}
interface SessionRow {id: bigint; game: string; origin: string; process_instance_uuid: string; process_id: bigint; windows_session_id: bigint; committed_through_event_seq: string}
function findSession(db: Database.Database, pluginSessionId: string): SessionRow | undefined {
  return statement(db, 'SELECT id, game, origin, process_instance_uuid, process_id, windows_session_id, committed_through_event_seq FROM plugin_sessions WHERE plugin_session_uuid = ?').get(pluginSessionId) as SessionRow | undefined;
}
/** The stored session of an envelope; any identity field that differs is SESSION_CONFLICT. */
function requireSession(db: Database.Database, source: SourceIdentity): SessionRow {
  const row = findSession(db, source.pluginSessionId);
  if (!row) fail('UNKNOWN_SESSION');
  if (row.game !== source.game || row.origin !== source.origin || row.process_instance_uuid !== source.processInstanceId ||
    Number(row.process_id) !== source.processId || Number(row.windows_session_id) !== source.windowsSessionId) fail('SESSION_CONFLICT');
  return row;
}
function clockRef(db: Database.Database, session: bigint, kind: 'source-monotonic' | 'game', uuid: string): bigint {
  if (!isUuid(uuid)) fail('INVALID_INPUT');
  statement(db, 'INSERT OR IGNORE INTO clocks (plugin_session_ref, kind, clock_uuid) VALUES (?, ?, ?)').run(session, kind, uuid);
  return statement(db, 'SELECT id FROM clocks WHERE plugin_session_ref = ? AND kind = ? AND clock_uuid = ?').pluck().get(session, kind, uuid) as bigint;
}
const transact = <T>(conn: StorageConnection, body: (db: Database.Database) => T): T => { const db = conn.writer(); return db.transaction(() => body(db)).immediate(); };

/**
 * Stores the plugin session from its welcome, idempotently: a repeated welcome of the same session changes nothing, and
 * one whose identity, versions or capabilities differ is SESSION_CONFLICT. The welcome's game mode is the session's
 * first evidence; later changes arrive as durable `source.gameMode` events and are kept beside it.
 */
export function upsertSession(conn: StorageConnection, input: {message: unknown}): {created: boolean; committedThroughEventSeq: Uint64} {
  const m = serverMessage(input?.message, 'welcome');
  if (m.kind !== 'welcome') fail('INVALID_INPUT');
  const s = m.source, d = m.data, eventTypes = JSON.stringify(d.capabilities.eventTypes);
  const [module, moduleState] = availabilityColumns(d.gameMode.module, value => value);
  const values = {game: s.game, origin: s.origin, process_instance_uuid: s.processInstanceId, process_id: BigInt(s.processId), windows_session_id: BigInt(s.windowsSessionId),
    protocol_minor: BigInt(d.minor), telemetry_api_major: BigInt(d.versions.telemetryApi.major), telemetry_api_minor: BigInt(d.versions.telemetryApi.minor),
    game_telemetry_major: BigInt(d.versions.gameTelemetry.major), game_telemetry_minor: BigInt(d.versions.gameTelemetry.minor), sdk_archive: d.versions.sdkArchive,
    gameplay_events: d.capabilities.gameplayEvents, event_types_json: eventTypes};
  return transact(conn, db => {
    const existing = statement(db, `SELECT committed_through_event_seq, ${Object.keys(values).join(', ')} FROM plugin_sessions WHERE plugin_session_uuid = ?`).get(s.pluginSessionId) as Record<string, unknown> | undefined;
    if (existing) {
      if (Object.entries(values).some(([column, value]) => existing[column] !== value)) fail('SESSION_CONFLICT');
      return {created: false, committedThroughEventSeq: fromU64Key(existing.committed_through_event_seq)};
    }
    const columns = ['plugin_session_uuid', ...Object.keys(values), 'protocol_major', 'game_mode', 'game_mode_method', 'game_mode_confidence', 'game_mode_module', 'game_mode_module_state', 'committed_through_event_seq', 'first_seen_utc_ms'];
    statement(db, insert('plugin_sessions', columns)).run(s.pluginSessionId, ...Object.values(values), 1n, d.gameMode.mode, d.gameMode.method, d.gameMode.confidence, module, moduleState, u64Key(0n), conn.now());
    return {created: true, committedThroughEventSeq: '0'};
  });
}

/**
 * Normalized configuration, amount and delivery rows of a newly inserted event, in the same transaction. A job
 * configuration records its plugin session and its source `event` (schema version 2); checkpoint job configurations
 * are written by their own command (ET-016b).
 */
function normalize(db: Database.Database, session: bigint, eventRef: bigint, record: EventRecord): void {
  const fields = record as unknown as Record<string, unknown>;
  const write = (table: string, specs: readonly FieldSpec[], extra: [string, unknown][] = []) =>
    statement(db, insert(table, ['event_ref', ...extra.map(([c]) => c), ...specColumns(specs)])).run(eventRef, ...extra.map(([, v]) => v), ...specValues(specs, fields));
  if (record.type === 'job.configured') write('job_configurations', JOB_FIELDS, [['plugin_session_ref', session], ['source', 'event']]);
  else if (record.type === 'truck.configured') write('truck_configurations', TRUCK_FIELDS);
  else if (record.type === 'trailer.configured') write('trailer_configurations', TRAILER_FIELDS, [['slot_index', BigInt(record.index)]]);
  else if (record.type === 'job.delivered') write('job_deliveries', DELIVERY_FIELDS);
  const amountField = AMOUNT_FIELD[record.type];
  if (amountField) {
    const m = moneyColumns(fields[amountField] as Parameters<typeof moneyColumns>[0], 's64');
    statement(db, insert('event_amounts', ['event_ref', 'amount_raw', 'amount_sdk_type', 'amount_currency_status', 'amount_currency_code', 'amount_currency_source', 'amount_state']))
      .run(eventRef, m.raw, m.sdkType, m.currencyStatus, m.currencyCode, m.currencySource, m.state);
  }
}

/**
 * Advances the session's contiguous committed coverage in the same transaction. A range that starts at or before
 * coverage + 1 extends it; stored events and gaps that continue from there are absorbed too, so commits {1, 2, 4} give
 * 2, and committing 3 later gives 4.
 */
function advanceCoverage(db: Database.Database, session: SessionRow, first: bigint, last: bigint): Uint64 {
  let through = BigInt(fromU64Key(session.committed_through_event_seq));
  if (first > through + 1n || last <= through) return through.toString();
  through = last;
  for (;;) {
    const next = u64Key(through + 1n);
    if (statement(db, 'SELECT 1 FROM events WHERE plugin_session_id = ? AND event_seq = ?').pluck().get(session.id, next)) { through += 1n; continue; }
    const gapLast = statement(db, 'SELECT max(last_event_seq) FROM event_gaps WHERE plugin_session_ref = ? AND first_event_seq <= ? AND last_event_seq >= ?').pluck().get(session.id, next, next) as string | null;
    if (gapLast === null) break;
    through = BigInt(fromU64Key(gapLast));
  }
  statement(db, 'UPDATE plugin_sessions SET committed_through_event_seq = ? WHERE id = ?').run(u64Key(through), session.id);
  return through.toString();
}

/**
 * `carrierEventSeq` is the item being committed, in the current plugin session: the event's eventSeq key, or for a gap
 * the first eventSeq it newly covers. A trip.close records it as the trip's close carrier (ET-016, J7). Only commitEvent and
 * commitGap set it; no other command applies effects.
 */
interface EffectContext {db: Database.Database; session: SessionRow; game: string; now: number; eventRef?: bigint; eventType?: string; carrierEventSeq?: string}
const enumValue = (value: unknown, options: readonly string[]) => { if (typeof value !== 'string' || !options.includes(value)) fail('INVALID_INPUT'); return value; };
const utcMs = (value: unknown) => { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('INVALID_INPUT'); return value; };
const optionalBoolean = (value: unknown) => { if (value !== undefined && typeof value !== 'boolean') fail('INVALID_INPUT'); return value === undefined ? undefined : value ? 1n : 0n; };
function eventRefOf(c: EffectContext, ref: EventReference): {id: bigint; type: string} {
  if (ref === 'this-event') { if (c.eventRef === undefined) fail('INVALID_INPUT'); return {id: c.eventRef, type: c.eventType!}; }
  if (typeof ref !== 'object' || ref === null) fail('INVALID_INPUT');
  const row = statement(c.db, 'SELECT id, type FROM events WHERE plugin_session_id = ? AND event_seq = ?').get(c.session.id, u64Key(ref.eventSeq)) as {id: bigint; type: string} | undefined;
  if (!row) fail('INVALID_INPUT');
  return row;
}
/** A configuration row created by an event of this session; the reference must name that kind of configuration event. */
function configurationRef(c: EffectContext, table: 'job_configurations' | 'truck_configurations' | 'trailer_configurations', ref: EventReference): bigint {
  const id = statement(c.db, `SELECT id FROM ${table} WHERE event_ref = ?`).pluck().get(eventRefOf(c, ref).id) as bigint | undefined;
  if (id === undefined) fail('INVALID_INPUT');
  return id;
}
/**
 * A stored trip of the current session's game. Every trip reference (update, close, attribution, completeness and
 * samples) goes through here, so an ATS session can never bind data to an ETS2 trip or the reverse. A trip of an
 * earlier plugin session of the same game is allowed: ET-014 closes it with close_reason 'restart' from the new session.
 */
function tripRow(c: EffectContext, tripUuid: unknown): {id: bigint; outcome: string} {
  if (!isUuid(tripUuid)) fail('INVALID_INPUT');
  const row = statement(c.db, 'SELECT id, outcome, game FROM trips WHERE trip_uuid = ?').get(tripUuid) as {id: bigint; outcome: string; game: string} | undefined;
  if (!row) fail('UNKNOWN_TRIP');
  if (row.game !== c.game) fail('INVALID_INPUT');
  return row;
}
function addTrailers(c: EffectContext, trip: bigint, refs: unknown) {
  if (refs === undefined) return;
  if (!Array.isArray(refs) || refs.length > 10) fail('INVALID_INPUT');
  for (const ref of refs as EventReference[]) statement(c.db, 'INSERT OR IGNORE INTO trip_trailers (trip_ref, trailer_configuration_ref) VALUES (?, ?)').run(trip, configurationRef(c, 'trailer_configurations', ref));
}
/**
 * Inserts one completeness interval. With `ifAbsent` (recordCompleteness only, ET-015a) every value is validated first,
 * then nothing is written, not even the clock row, when the session already holds an interval with the same trip
 * reference, kind, first and last eventSeq and canonical detail. `ifAbsent` requires both eventSeq bounds: labels are
 * not compared, so two distinct outages without bounds would otherwise look equal and the second would be dropped.
 */
function addInterval(c: EffectContext, interval: CompletenessInterval, ifAbsent = false) {
  const trip = interval.tripUuid === undefined || interval.tripUuid === null ? null : tripRow(c, interval.tripUuid).id;
  const optionalUtc = (value: unknown) => value === undefined ? null : utcMs(value);
  const optionalKey = (value: unknown) => value === undefined ? null : u64Key(value as Uint64);
  const hasMonotonic = interval.startMonotonicNs !== undefined || interval.endMonotonicNs !== undefined;
  if (interval.sourceClockId !== undefined && !isUuid(interval.sourceClockId)) fail('INVALID_INPUT');
  if (hasMonotonic && interval.sourceClockId === undefined) fail('INVALID_INPUT');
  let detail: string | null = null;
  if (interval.detail !== undefined) { if (typeof interval.detail !== 'object' || interval.detail === null || Array.isArray(interval.detail)) fail('INVALID_INPUT'); detail = canonicalJson(interval.detail); }
  const kind = enumValue(interval.kind, INTERVAL_KINDS), startUtc = optionalUtc(interval.startUtcMs), endUtc = optionalUtc(interval.endUtcMs);
  const startMonotonic = optionalKey(interval.startMonotonicNs), endMonotonic = optionalKey(interval.endMonotonicNs);
  const first = optionalKey(interval.firstEventSeq), last = optionalKey(interval.lastEventSeq);
  if (ifAbsent && (first === null || last === null)) fail('INVALID_INPUT');
  if (ifAbsent && statement(c.db, `SELECT 1 FROM completeness_intervals WHERE plugin_session_ref = ? AND trip_ref IS ? AND kind = ? AND first_event_seq IS ? AND last_event_seq IS ?
    AND detail_json IS ? LIMIT 1`).pluck().get(c.session.id, trip, kind, first, last, detail) !== undefined) return;
  const clock = interval.sourceClockId === undefined ? null : clockRef(c.db, c.session.id, 'source-monotonic', interval.sourceClockId);
  statement(c.db, insert('completeness_intervals', ['plugin_session_ref', 'trip_ref', 'kind', 'start_utc_ms', 'end_utc_ms', 'start_monotonic_ns', 'end_monotonic_ns', 'source_clock_ref', 'first_event_seq', 'last_event_seq', 'detail_json', 'created_utc_ms']))
    .run(c.session.id, trip, kind, startUtc, endUtc, startMonotonic, endMonotonic, clock, first, last, detail, c.now);
}

/** Applies typed trip effects in order. Every reference is resolved inside the transaction; any failure aborts it. */
function applyEffects(c: EffectContext, effects: unknown): void {
  if (effects === undefined) return;
  if (!Array.isArray(effects) || effects.length > MAX_EFFECTS) fail('INVALID_INPUT');
  for (const effect of effects as TripEffect[]) {
    if (typeof effect !== 'object' || effect === null) fail('INVALID_INPUT');
    switch (effect.kind) {
      case 'trip.open': {
        // A trip opens at the job configuration event that defines it, never at a gap (opened_by 'event'; a checkpoint
        // opening is a separate command of ET-016b).
        if (c.eventRef === undefined || !isUuid(effect.tripUuid) || enumValue(effect.game, GAMES) !== c.game || typeof effect.gameMode !== 'object' || effect.gameMode === null) fail('INVALID_INPUT');
        const job = configurationRef(c, 'job_configurations', effect.jobConfiguration);
        const truck = effect.truckConfiguration === undefined ? null : configurationRef(c, 'truck_configurations', effect.truckConfiguration);
        const id = statement(c.db, insert('trips', ['trip_uuid', 'plugin_session_ref', 'game', 'game_mode', 'game_mode_method', 'game_mode_confidence', 'game_mode_ambiguous', 'job_configuration_ref',
          'truck_configuration_ref', 'opened_event_ref', 'opened_by', 'outcome', 'recording_completeness', 'started_utc_ms', 'observed_distance_m', 'observed_distance_m_state', 'created_utc_ms', 'updated_utc_ms']))
          .run(effect.tripUuid, c.session.id, effect.game, enumValue(effect.gameMode.mode, MODES), enumValue(effect.gameMode.method, METHODS), enumValue(effect.gameMode.confidence, CONFIDENCES),
            optionalBoolean(effect.gameModeAmbiguous) ?? 0n, job, truck, c.eventRef, 'event', 'open', enumValue(effect.recordingCompleteness, COMPLETENESS), utcMs(effect.startedUtcMs), null, 'not-observed', c.now, c.now).lastInsertRowid;
        addTrailers(c, BigInt(id), effect.trailerConfigurations);
        break;
      }
      case 'trip.update': {
        const trip = tripRow(c, effect.tripUuid), set = effect.set;
        if (typeof set !== 'object' || set === null) fail('INVALID_INPUT');
        // A closed trip may still learn about its recording (a late gap can downgrade completeness, a final distance can
        // arrive), but its configuration and game-mode evidence are fixed once it is closed.
        const allowed = trip.outcome === 'open' ? ['recordingCompleteness', 'gameModeAmbiguous', 'observedDistanceM', 'truckConfiguration', 'trailerConfigurations']
          : ['recordingCompleteness', 'observedDistanceM'];
        if (Object.keys(set).some(key => !allowed.includes(key))) fail('INVALID_INPUT');
        if (set.recordingCompleteness !== undefined) statement(c.db, 'UPDATE trips SET recording_completeness = ? WHERE id = ?').run(enumValue(set.recordingCompleteness, COMPLETENESS), trip.id);
        const ambiguous = optionalBoolean(set.gameModeAmbiguous);
        if (ambiguous !== undefined) statement(c.db, 'UPDATE trips SET game_mode_ambiguous = ? WHERE id = ?').run(ambiguous, trip.id);
        if (set.observedDistanceM !== undefined) {
          const [value, state] = availabilityColumns(availability(set.observedDistanceM) as Available<number>, v => { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) fail('INVALID_INPUT'); return v; });
          statement(c.db, 'UPDATE trips SET observed_distance_m = ?, observed_distance_m_state = ? WHERE id = ?').run(value, state, trip.id);
        }
        if (set.truckConfiguration !== undefined) statement(c.db, 'UPDATE trips SET truck_configuration_ref = ? WHERE id = ?').run(configurationRef(c, 'truck_configurations', set.truckConfiguration), trip.id);
        addTrailers(c, trip.id, set.trailerConfigurations);
        statement(c.db, 'UPDATE trips SET updated_utc_ms = ? WHERE id = ?').run(c.now, trip.id);
        break;
      }
      case 'trip.close': {
        const trip = tripRow(c, effect.tripUuid), outcome = enumValue(effect.outcome, OUTCOMES);
        if (trip.outcome !== 'open') fail('INVALID_INPUT');
        let outcomeEvent: bigint | null = null;
        // Only the gameplay outcome event decides delivery or cancellation (concept.md §7).
        if (outcome !== 'none') {
          if (effect.outcomeEvent === undefined) fail('INVALID_INPUT');
          const event = eventRefOf(c, effect.outcomeEvent);
          if (event.type !== (outcome === 'delivered' ? 'job.delivered' : 'job.cancelled')) fail('INVALID_INPUT');
          outcomeEvent = event.id;
        } else if (effect.outcomeEvent !== undefined) fail('INVALID_INPUT');
        // The close carrier is the committed item itself, in the current session: a restart close made by a later
        // plugin session records that session, not the trip's own.
        if (c.carrierEventSeq === undefined) fail('INVALID_INPUT');
        statement(c.db, `UPDATE trips SET outcome = ?, close_reason = ?, outcome_event_ref = ?, recording_completeness = ?, ended_utc_ms = ?, updated_utc_ms = ?,
          closed_by_session_ref = ?, closed_by_event_seq = ? WHERE id = ?`)
          .run(outcome, enumValue(effect.closeReason, CLOSE_REASONS), outcomeEvent, enumValue(effect.recordingCompleteness, COMPLETENESS), utcMs(effect.endedUtcMs), c.now,
            c.session.id, c.carrierEventSeq, trip.id);
        break;
      }
      case 'event.attribute': {
        const attribution = enumValue(effect.attribution, ATTRIBUTIONS), unattributed = attribution === 'free-driving' || attribution === 'ambiguous';
        if (c.eventRef === undefined || unattributed !== (effect.tripUuid === null)) fail('INVALID_INPUT');
        const trip = effect.tripUuid === null ? null : tripRow(c, effect.tripUuid).id;
        statement(c.db, 'INSERT INTO event_attributions (event_ref, trip_ref, attribution) VALUES (?, ?, ?)').run(c.eventRef, trip, attribution);
        break;
      }
      case 'completeness.add': if (typeof effect.interval !== 'object' || effect.interval === null) fail('INVALID_INPUT'); addInterval(c, effect.interval); break;
      default: fail('INVALID_INPUT');
    }
  }
}

/**
 * Commits one protocol v1 event with its effects in one transaction. The message is validated again here, and its
 * session must be stored with the same identity. A new eventSeq inserts the event, its normalized rows and its effects
 * and advances coverage; an existing one is `duplicate` (same canonical payload) or `conflict` (the stored row is kept),
 * and neither writes anything.
 */
export function commitEvent(conn: StorageConnection, input: {message: unknown; effects?: TripEffect[]}, options: CommitOptions = {}): CommitResult {
  const m = serverMessage(input?.message, 'event');
  if (m.kind !== 'event') fail('INVALID_INPUT');
  const {eventSeq, occurred, record, redelivered} = m.data, seqKey = u64Key(eventSeq);
  const payload = canonicalJson({occurred, record});
  return transact(conn, db => {
    const session = requireSession(db, m.source);
    const stored = statement(db, 'SELECT payload_json FROM events WHERE plugin_session_id = ? AND event_seq = ?').pluck().get(session.id, seqKey) as string | undefined;
    if (stored !== undefined) {
      options.testHooks?.beforeCommit?.();
      return {status: stored === payload ? 'duplicate' : 'conflict', committedThroughEventSeq: fromU64Key(session.committed_through_event_seq)};
    }
    const now = conn.now(), sourceClock = clockRef(db, session.id, 'source-monotonic', m.capture.clockId), gameClock = clockRef(db, session.id, 'game', occurred.gameTime.clockId);
    if (record.type === 'gameTime.regression') clockRef(db, session.id, 'game', record.from.clockId);
    const [monotonic, monotonicState] = availabilityColumns(occurred.monotonicNs, u64Key);
    const [minutes, minutesState] = availabilityColumns(occurred.gameTime.minutes, value => BigInt(value));
    const [utc, utcState] = availabilityColumns(occurred.utcUnixMs, u64Key);
    const result = statement(db, `INSERT OR IGNORE INTO events (plugin_session_id, event_seq, type, occurred_monotonic_ns, occurred_monotonic_ns_state, source_clock_ref,
      occurred_game_minutes, occurred_game_minutes_state, occurred_game_clock_ref, occurred_utc_ms, occurred_utc_ms_state, occurred_simulation, configuration_revision,
      boundary_order, payload_json, protocol_minor, first_redelivered, committed_utc_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(session.id, seqKey, record.type, monotonic, monotonicState, sourceClock, minutes, minutesState, gameClock, utc, utcState, occurred.simulation,
        u64Key(occurred.configurationRevision), u64Key(occurred.boundaryOrder), payload, BigInt(m.version.minor), redelivered ? 1n : 0n, now);
    if (result.changes !== 1) fail('CONSTRAINT_VIOLATION');
    const eventRef = BigInt(result.lastInsertRowid);
    normalize(db, session.id, eventRef, record);
    applyEffects({db, session, game: session.game, now, eventRef, eventType: record.type, carrierEventSeq: seqKey}, input.effects);
    const through = advanceCoverage(db, session, BigInt(eventSeq), BigInt(eventSeq));
    options.testHooks?.beforeCommit?.();
    return {status: 'committed', committedThroughEventSeq: through};
  });
}

const CAUSES: [keyof GapData['causes'], string][] = [['offline', 'cause_offline'], ['noDurableConsumer', 'cause_no_durable_consumer'], ['queueCount', 'cause_queue_count'],
  ['queueBytes', 'cause_queue_bytes'], ['retentionExpired', 'cause_retention_expired'], ['encodingFailed', 'cause_encoding_failed']];
/**
 * Commits one gap marker (an eventSeq range the producer no longer holds) with its effects. The same range is a
 * duplicate or conflict; a new range wholly inside committed coverage is `covered` and stores nothing; a new range that
 * extends beyond coverage is stored with its own cause counts, even where it overlaps earlier gap rows, and events
 * already committed inside it keep their rows. Every result carries `previouslyCoveredThrough` (see CommitResult).
 */
export function commitGap(conn: StorageConnection, input: {message: unknown; effects?: TripEffect[]}, options: CommitOptions = {}): CommitResult {
  const m = serverMessage(input?.message, 'gap');
  if (m.kind !== 'gap') fail('INVALID_INPUT');
  const d = m.data, firstKey = u64Key(d.firstEventSeq), lastKey = u64Key(d.lastEventSeq);
  const payload = canonicalJson({causes: d.causes, firstLostMonotonicNs: d.firstLostMonotonicNs, lastLostMonotonicNs: d.lastLostMonotonicNs});
  return transact(conn, db => {
    const session = requireSession(db, m.source), previouslyCoveredThrough = fromU64Key(session.committed_through_event_seq);
    const stored = statement(db, `SELECT ${CAUSES.map(([, c]) => c).join(', ')}, first_lost_monotonic_ns, first_lost_monotonic_ns_state, last_lost_monotonic_ns, last_lost_monotonic_ns_state
      FROM event_gaps WHERE plugin_session_ref = ? AND first_event_seq = ? AND last_event_seq = ?`).get(session.id, firstKey, lastKey) as Record<string, string | null> | undefined;
    if (stored) {
      const lost = (prefix: string) => stored[`${prefix}_state`] === 'available' ? {available: true, value: fromU64Key(stored[prefix])} : {available: false, reason: stored[`${prefix}_state`]};
      const storedPayload = canonicalJson({causes: Object.fromEntries(CAUSES.map(([key, c]) => [key, fromU64Key(stored[c])])),
        firstLostMonotonicNs: lost('first_lost_monotonic_ns'), lastLostMonotonicNs: lost('last_lost_monotonic_ns')});
      options.testHooks?.beforeCommit?.();
      return {status: storedPayload === payload ? 'duplicate' : 'conflict', committedThroughEventSeq: previouslyCoveredThrough, previouslyCoveredThrough};
    }
    // A range already inside committed coverage adds no information: its events and earlier gap markers are stored, and
    // its effects were applied when they were committed. Storing it again would count the same losses twice.
    if (BigInt(d.lastEventSeq) <= BigInt(fromU64Key(session.committed_through_event_seq))) {
      options.testHooks?.beforeCommit?.();
      return {status: 'covered', committedThroughEventSeq: previouslyCoveredThrough, previouslyCoveredThrough};
    }
    const now = conn.now(), clock = clockRef(db, session.id, 'source-monotonic', m.capture.clockId);
    const [firstLost, firstLostState] = availabilityColumns(d.firstLostMonotonicNs, u64Key), [lastLost, lastLostState] = availabilityColumns(d.lastLostMonotonicNs, u64Key);
    statement(db, insert('event_gaps', ['plugin_session_ref', 'first_event_seq', 'last_event_seq', ...CAUSES.map(([, c]) => c), 'first_lost_monotonic_ns', 'first_lost_monotonic_ns_state',
      'last_lost_monotonic_ns', 'last_lost_monotonic_ns_state', 'source_clock_ref', 'redelivered', 'committed_utc_ms']))
      .run(session.id, firstKey, lastKey, ...CAUSES.map(([key]) => u64Key(d.causes[key])), firstLost, firstLostState, lastLost, lastLostState, clock, d.redelivered ? 1n : 0n, now);
    // The carrier of a gap is the first eventSeq it newly covers: previouslyCoveredThrough + 1, or the gap's own first
    // eventSeq when it starts beyond that (ET-016, J7). It is at most lastEventSeq, which is above the coverage here.
    const firstNew = BigInt(previouslyCoveredThrough) + 1n, carrier = BigInt(d.firstEventSeq) > firstNew ? BigInt(d.firstEventSeq) : firstNew;
    applyEffects({db, session, game: session.game, now, carrierEventSeq: u64Key(carrier)}, input.effects);
    const through = advanceCoverage(db, session, BigInt(d.firstEventSeq), BigInt(d.lastEventSeq));
    options.testHooks?.beforeCommit?.();
    return {status: 'committed', committedThroughEventSeq: through, previouslyCoveredThrough};
  });
}

function sessionByUuid(db: Database.Database, pluginSessionId: unknown): SessionRow {
  if (!isUuid(pluginSessionId)) fail('INVALID_INPUT');
  const row = findSession(db, pluginSessionId); if (!row) fail('UNKNOWN_SESSION');
  return row;
}
function finiteNumber(value: unknown, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))) fail('INVALID_INPUT');
  return value;
}
const REASONS = ['not-observed', 'not-supported', 'invalid'];
/**
 * A strictly shaped availability object: exactly `{available: true, value}` with a present value, or exactly
 * `{available: false, reason}` with a known reason. Anything else is INVALID_INPUT, never a silent not-observed.
 */
function availability(input: unknown): Available<unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail('INVALID_INPUT');
  const o = input as Record<string, unknown>, keys = Object.keys(o).sort().join(',');
  if (o.available === true) { if (keys !== 'available,value' || o.value === null || o.value === undefined) fail('INVALID_INPUT'); }
  else if (o.available !== false || keys !== 'available,reason' || !REASONS.includes(o.reason as string)) fail('INVALID_INPUT');
  return o as Available<unknown>;
}
/** Validates one sample and returns its column values; nothing is written for a batch with any invalid sample. */
function sampleColumns(row: SampleInput): {trip: string | null; clock: string; gameClock: string | null; monotonic: bigint; values: unknown[]} {
  if (typeof row !== 'object' || row === null || !isUuid(row.sourceClockId)) fail('INVALID_INPUT');
  if (row.tripUuid !== undefined && row.tripUuid !== null && !isUuid(row.tripUuid)) fail('INVALID_INPUT');
  let notSupported = 0, invalid = 0;
  const monotonic = sampleMonotonicNs(row.monotonicNs);
  const values: unknown[] = [utcMs(row.utcMs), monotonic];
  // Game time is either absent (null) or a game clock with an availability object for its minutes.
  const gameTime = row.gameTime as unknown;
  if (gameTime !== null && (typeof gameTime !== 'object' || Object.keys(gameTime).sort().join(',') !== 'clockId,minutes' || !isUuid((gameTime as {clockId: unknown}).clockId))) fail('INVALID_INPUT');
  const game = gameTime as SampleInput['gameTime'];
  for (const {field, bit, integer} of SAMPLE_FIELDS) {
    // Only an absent game time (null) defaults to not observed; a present game time must carry valid minutes.
    const input = availability(field !== 'gameTime' ? row[field] : game === null ? {available: false, reason: 'not-observed'} : game.minutes);
    const mask = maskBits(input, bit); notSupported |= mask.notSupported; invalid |= mask.invalid;
    if (field === 'position') {
      let p: unknown[] = [null, null, null];
      if (input.available) {
        const value = input.value as Record<string, unknown>;
        if (typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'x,y,z') fail('INVALID_INPUT');
        p = [finiteNumber(value.x), finiteNumber(value.y), finiteNumber(value.z)];
      }
      values.push(...p);
    } else if (field === 'gameTime') {
      const minutes = input.available ? finiteNumber(input.value, true) : null;
      if (minutes !== null && (minutes < 0 || minutes > 4_294_967_295)) fail('INVALID_INPUT');
      values.push(minutes === null ? null : BigInt(minutes));
    } else {
      const value = input.available ? finiteNumber(input.value, integer) : null;
      values.push(value === null ? null : integer ? BigInt(value) : value);
    }
  }
  values.push(BigInt(notSupported), BigInt(invalid));
  return {trip: row.tripUuid ?? null, clock: row.sourceClockId, gameClock: game === null ? null : game.clockId, monotonic, values};
}
const SAMPLE_COLUMNS = ['utc_ms', 'monotonic_ns', ...SAMPLE_FIELDS.flatMap(f => f.columns), 'not_supported_mask', 'invalid_mask'];
const NS_PER_SECOND = 1_000_000_000n;
/**
 * Appends up to 3,600 samples of one session in one transaction: all of them, or none. With `uniqueSeconds` (ET-015b,
 * H6) a row whose source second is not after the last accepted second of its clock is skipped (SampleAppendOptions);
 * the comparison starts from the session's latest stored row, read through the samples_session index.
 */
export function appendSamples(conn: StorageConnection, pluginSessionId: string, rows: SampleInput[], options: SampleAppendOptions = {}, commitOptions: CommitOptions = {}): SampleAppendResult {
  if (!Array.isArray(rows) || rows.length > MAX_SAMPLE_BATCH) fail('INVALID_INPUT');
  if (typeof options !== 'object' || options === null || Array.isArray(options) || (options.uniqueSeconds !== undefined && typeof options.uniqueSeconds !== 'boolean')) fail('INVALID_INPUT');
  const uniqueSeconds = options.uniqueSeconds === true;
  const prepared = rows.map(sampleColumns);
  return transact(conn, db => {
    const session = sessionByUuid(db, pluginSessionId), trips = new Map<string, bigint>();
    const c: EffectContext = {db, session, game: session.game, now: conn.now()};
    const sql = insert('samples', ['plugin_session_ref', 'trip_ref', 'source_clock_ref', 'game_clock_ref', ...SAMPLE_COLUMNS]);
    // The last accepted source second per source clock UUID, seeded with the session's latest stored row.
    const lastSecond = new Map<string, bigint>();
    if (uniqueSeconds) {
      const last = statement(db, `SELECT samples.monotonic_ns AS monotonic, clocks.clock_uuid AS clock FROM samples JOIN clocks ON clocks.id = samples.source_clock_ref
        WHERE samples.plugin_session_ref = ? ORDER BY samples.id DESC LIMIT 1`).get(session.id) as {monotonic: bigint; clock: string} | undefined;
      if (last) lastSecond.set(last.clock, BigInt(last.monotonic) / NS_PER_SECOND);
    }
    let appended = 0;
    for (const row of prepared) {
      // The trip is resolved for a skipped row too, so an unknown or foreign trip refuses the batch either way.
      let trip: bigint | null = null;
      if (row.trip !== null) { trip = trips.get(row.trip) ?? tripRow(c, row.trip).id; trips.set(row.trip, trip); }
      if (uniqueSeconds) {
        const second = row.monotonic / NS_PER_SECOND, previous = lastSecond.get(row.clock);
        if (previous !== undefined && second <= previous) continue;
        lastSecond.set(row.clock, second);
      }
      statement(db, sql).run(session.id, trip, clockRef(db, session.id, 'source-monotonic', row.clock), row.gameClock === null ? null : clockRef(db, session.id, 'game', row.gameClock), ...row.values);
      appended++;
    }
    commitOptions.testHooks?.beforeCommit?.();
    return {appended, skipped: prepared.length - appended};
  });
}

/**
 * Records a known missing or discontinuous interval outside an event commit, for example while storage was unavailable.
 * With `ifAbsent` an interval that the session already holds is not stored again (CompletenessOptions).
 */
export function recordCompleteness(conn: StorageConnection, pluginSessionId: string, interval: CompletenessInterval, options: CompletenessOptions = {}): void {
  if (typeof interval !== 'object' || interval === null) fail('INVALID_INPUT');
  if (typeof options !== 'object' || options === null || Array.isArray(options) || (options.ifAbsent !== undefined && typeof options.ifAbsent !== 'boolean')) fail('INVALID_INPUT');
  const ifAbsent = options.ifAbsent === true;
  transact(conn, db => { const session = sessionByUuid(db, pluginSessionId); addInterval({db, session, game: session.game, now: conn.now()}, interval, ifAbsent); });
}
