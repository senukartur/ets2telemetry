import type Database from 'better-sqlite3';
import {isHardModeDetails, isHardModeObservation, type HardModeDetails, type HardModeObservation, type HardModeReason} from '../../../contracts/src/hard-mode';
import type {ServerMessage} from '../../../contracts/src/protocol-v1';
import {hardModeDiagnostic, advanceHardMode, advanceHardModeV2, newHardModeDetails, qualifiesHardMode, unknownHardMode} from '../../../telemetry-core/src/hard-mode';
import {fail} from '../errors';
export function readHardModeDetails(value: unknown): HardModeDetails | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail('DATABASE_CORRUPT');
  let details: unknown;
  try {details = JSON.parse(value);} catch {fail('DATABASE_CORRUPT');}
  if (!isHardModeDetails(details)) fail('DATABASE_CORRUPT');
  return details;
}
export function checkHardModeObservation(value: unknown): asserts value is HardModeObservation | undefined {
  if (value !== undefined && !isHardModeObservation(value)) fail('INVALID_INPUT');
}
export function write(db: Database.Database, id: unknown, details: HardModeDetails, qualifies = false): void {
  const text = JSON.stringify(details);
  if (text.length > 16384) fail('INVALID_INPUT');
  db.prepare('UPDATE trips SET is_hard_mode = ?, hard_mode_details = ? WHERE id = ?').run(qualifies ? 1 : 0, text, id);
}
/** One bounded observer command; storage's own FIFO serializes it with event commits, without any ACK. */
export function updateOpenHardMode(db: Database.Database, game: string, observation: HardModeObservation, now: number, fresh = false, latest: 'publication' | 'frozen' = 'publication'): void {
  if (typeof fresh !== 'boolean' || !isHardModeObservation(observation)) fail('INVALID_INPUT');
  const rows = db.prepare("SELECT t.id, t.trip_uuid, p.plugin_session_uuid, t.hard_mode_details FROM trips t JOIN plugin_sessions p ON p.id=t.plugin_session_ref WHERE t.game = ? AND t.outcome = 'open' LIMIT 101").all(game) as {id: unknown; trip_uuid: string; plugin_session_uuid: string; hard_mode_details: unknown}[];
  if (rows.length > 100) fail('INVALID_INPUT');
  for (const row of rows) {
    const previous = readHardModeDetails(row.hard_mode_details);
    // Historical and late-attached trips never gain opening evidence from an observation.
    if (!previous) continue;
    const scoped = observation.batch?.tripUuid ?? observation.member;
    if (scoped !== undefined && scoped !== row.trip_uuid) continue;
    if (previous.version === 2) {
      const target = observation.batch?.tripUuid ?? observation.member;
      if (target !== row.trip_uuid) continue;
      const batch = observation.batch;
      const changesCounts = batch && (previous.checkpoint?.producer !== batch.producer || batch.sequence > previous.checkpoint.sequence);
      if (changesCounts && (observation.batchSessionId ?? observation.pluginSessionId) !== row.plugin_session_uuid) fail('INVALID_INPUT');
      write(db, row.id, advanceHardModeV2(previous, !fresh && observation.assessment.state === 'pass' ? {...observation, assessment: unknownHardMode(now, 'interrupted'), diagnostic: 'profile-verification'} : observation, latest));
      continue;
    }
    // Freshness was frozen at offer/intake on the service's monotonic clock, before this FIFO/transaction.
    const assessment = !fresh && observation.assessment.state === 'pass' ? unknownHardMode(now, 'interrupted') : observation.assessment;
    const loss = assessment.state === 'unknown' ? 'interrupted' : previous.binding !== observation.binding ? 'source-changed' : undefined;
    write(db, row.id, advanceHardMode(previous, assessment, loss, latest));
  }
}
/** The authenticated gap owns only its source session's open members; no counts or newer publication are replaced. */
export function recordGapHardMode(db: Database.Database, pluginSessionId: string, now: number): void {
  const rows = db.prepare(`SELECT t.id, t.hard_mode_details FROM trips t JOIN plugin_sessions p ON p.id=t.plugin_session_ref
    WHERE p.plugin_session_uuid=? AND t.outcome='open' LIMIT 101`).all(pluginSessionId) as {id: unknown; hard_mode_details: unknown}[];
  if (rows.length > 100) fail('INVALID_INPUT');
  const observation: HardModeObservation = {assessment: unknownHardMode(now, 'interrupted'), diagnostic: 'session-transition',
    binding: null, pluginSessionId, sourceMonotonicNs: null};
  for (const row of rows) {
    const previous = readHardModeDetails(row.hard_mode_details);
    if (previous?.version === 2) write(db, row.id, advanceHardModeV2(previous, observation, 'frozen'));
  }
}
/** Runs after the ordinary effects, within their event transaction. Duplicates return before this function. */
export function applyEventHardMode(db: Database.Database, message: Extract<ServerMessage, {kind: 'event'}>, effects: readonly {kind: string; tripUuid?: string | null}[] | undefined,
  observation: HardModeObservation | undefined, now: number, pendingLoss?: HardModeObservation, admittedFresh = false): void {
  checkHardModeObservation(observation);
  if (observation === undefined) {
    for (const effect of effects ?? []) if (effect.kind === 'trip.close') {
      const row = db.prepare('SELECT id, hard_mode_details, outcome FROM trips WHERE trip_uuid=?').get(effect.tripUuid) as {id:unknown;hard_mode_details:unknown;outcome:string};
      const details = readHardModeDetails(row.hard_mode_details);
      if (details?.version === 2) write(db,row.id,details,qualifiesHardMode(details,row.outcome === 'delivered'));
    }
    return;
  }
  const fresh = admittedFresh && observation && observation.pluginSessionId === message.source.pluginSessionId && observation.binding !== null && observation.sourceMonotonicNs !== null
    && message.data.occurred.monotonicNs.available
    && BigInt(message.data.occurred.monotonicNs.value) >= BigInt(observation.sourceMonotonicNs) && !message.data.redelivered;
  // Failing evidence is conservative even without current positive proof; never discard its original detected value.
  const assessment = observation.assessment.state === 'fail' || fresh ? observation.assessment : unknownHardMode(now, 'historical');
  for (const effect of effects ?? []) {
    if (effect.kind !== 'trip.open' && effect.kind !== 'trip.close') continue;
    const row = db.prepare('SELECT id, hard_mode_details, outcome, opened_by FROM trips WHERE trip_uuid = ?').get(effect.tripUuid) as {id: unknown; hard_mode_details: unknown; outcome: string; opened_by: string};
    const previous = readHardModeDetails(row.hard_mode_details);
    if (effect.kind === 'trip.open') {
      if (observation.batch?.tripUuid === effect.tripUuid && (observation.batchSessionId ?? observation.pluginSessionId) !== message.source.pluginSessionId) fail('INVALID_INPUT');
      const diagnostics = [hardModeDiagnostic(observation), pendingLoss ? hardModeDiagnostic(pendingLoss) : null].filter(value => value !== null);
      const details = advanceHardModeV2(newHardModeDetails(assessment, fresh ? observation.binding : null), {...observation, assessment,
        ...(diagnostics.length ? {diagnostics} : {}), ...(observation.batch?.tripUuid === effect.tripUuid ? {} : {batch: undefined})});
      details.binding = fresh ? observation.binding : null;
      write(db, row.id, details);
    } else if (previous?.version === 2) {
      const details = advanceHardModeV2(previous, {...observation, batch: undefined}, 'frozen');
      write(db, row.id, details, qualifiesHardMode(details, row.outcome === 'delivered'));
    } else if (previous) {
      const loss: HardModeReason | undefined = assessment.state === 'fail' ? undefined : previous.binding !== observation?.binding ? 'source-changed' : fresh ? undefined : 'interrupted';
      const details = advanceHardMode(previous, assessment, loss, 'frozen');
      write(db, row.id, details, row.outcome === 'delivered' && details.firstLoss === null);
    }
  }
}
