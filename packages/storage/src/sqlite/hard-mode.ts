import type Database from 'better-sqlite3';
import {isHardModeDetails, isHardModeObservation, type HardModeDetails, type HardModeObservation, type HardModeReason} from '../../../contracts/src/hard-mode';
import type {ServerMessage} from '../../../contracts/src/protocol-v1';
import {advanceHardMode, hardModeLoss, unknownHardMode} from '../../../telemetry-core/src/hard-mode';
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
function write(db: Database.Database, id: unknown, details: HardModeDetails, qualifies = false): void {
  const text = JSON.stringify(details);
  if (text.length > 16384) fail('INVALID_INPUT');
  db.prepare('UPDATE trips SET is_hard_mode = ?, hard_mode_details = ? WHERE id = ?').run(qualifies ? 1 : 0, text, id);
}
/** One bounded observer command; storage's own FIFO serializes it with event commits, without any ACK. */
export function updateOpenHardMode(db: Database.Database, game: string, observation: HardModeObservation, now: number, fresh = false, latest: 'publication' | 'frozen' = 'publication'): void {
  if (typeof fresh !== 'boolean' || !isHardModeObservation(observation)) fail('INVALID_INPUT');
  const rows = db.prepare("SELECT id, hard_mode_details FROM trips WHERE game = ? AND outcome = 'open' LIMIT 101").all(game) as {id: unknown; hard_mode_details: unknown}[];
  if (rows.length > 100) fail('INVALID_INPUT');
  for (const row of rows) {
    const previous = readHardModeDetails(row.hard_mode_details);
    // Historical and late-attached trips never gain opening evidence from an observation.
    if (!previous) continue;
    // Freshness was frozen at offer/intake on the service's monotonic clock, before this FIFO/transaction.
    const assessment = !fresh && observation.assessment.state === 'pass' ? unknownHardMode(now, 'interrupted') : observation.assessment;
    const loss = assessment.state === 'unknown' ? 'interrupted' : previous.binding !== observation.binding ? 'source-changed' : undefined;
    write(db, row.id, advanceHardMode(previous, assessment, loss, latest));
  }
}
/** Runs after the ordinary effects, within their event transaction. Duplicates return before this function. */
export function applyEventHardMode(db: Database.Database, message: Extract<ServerMessage, {kind: 'event'}>, effects: readonly {kind: string; tripUuid?: string | null}[] | undefined,
  observation: HardModeObservation | undefined, now: number, pendingLoss?: HardModeObservation, admittedFresh = false): void {
  checkHardModeObservation(observation);
  if (observation === undefined) return;
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
      let details = advanceHardMode(null, assessment, fresh || assessment.state === 'fail' ? undefined : 'historical');
      // This row is being created now: preserve the opening snapshot and the first unsafe observation captured
      // during its queue/write awaits, even if redelivery itself cannot establish positive opening proof.
      if (pendingLoss && observation.assessment.state === 'pass') details = advanceHardMode({...details, firstLoss: null}, pendingLoss.assessment);
      details.binding = fresh ? observation.binding : null;
      write(db, row.id, details);
    } else if (previous) {
      const loss: HardModeReason | undefined = assessment.state === 'fail' ? undefined : previous.binding !== observation?.binding ? 'source-changed' : fresh ? undefined : 'interrupted';
      let details = advanceHardMode(previous, assessment, loss, 'frozen');
      const delivered = message.data.record;
      details.manualDelivery = delivered.type === 'job.delivered' && delivered.autoParkUsed.available ? delivered.autoParkUsed.value === false : null;
      if (row.outcome === 'delivered' && details.manualDelivery !== true) details = hardModeLoss(details, now, 'parking-unproven');
      write(db, row.id, details, row.outcome === 'delivered' && details.firstLoss === null && details.manualDelivery === true);
    }
  }
}
