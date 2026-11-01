// Strictly selected connection evidence for one trip. Logs are optional and bounded; missing evidence never changes
// trip accounting or implies that no disconnect happened. No raw log text, arbitrary facts, names or paths are copied.
import type {JournalTripDetail, TripExportDiagnosticRecord, TripExportDiagnostics} from '../../../packages/contracts/src';
import {diagnosticLogRow, pluginCloseLogRow, type DiagnosticBundleInput, type DiagnosticLogRow} from './diagnostic-bundle';

export const TRIP_DIAGNOSTIC_RECORD_LIMIT = 256;
export function emptyTripDiagnostics(detail: JournalTripDetail): TripExportDiagnostics {
  return {collection: 'retained-logs-at-export', matchedBy: 'plugin-session-and-utc-window',
    status: detail.database.purpose === 'history' ? 'unavailable' : 'not-applicable', notes: [], records: []};
}
const BROKER_OUTCOMES = new Set(['ended', 'rejected', 'startup-deadline', 'control-closed', 'start-failed', 'incomplete-frame', 'busy',
  'relay-rejected', 'hello-rejected', 'duplicate-credit', 'client-frame-rejected']);
// Every stage is a fixed, bounded code from the broker parser, never raw stderr.
const BROKER_STAGE = /^(arguments|identity|directory|own-image|policy-(lock|image|existing|json|current|write|publish)|discovery|server-(process|image)|connected-peer|authority-receipt|hello|relay|retained-(authority|process|identity|pipe)|wire-(frame|payload)|client-(frame|write)|unreported|unrecognized)$/;
const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function brokerRow(row: DiagnosticLogRow): DiagnosticLogRow | undefined {
  const f = row.facts;
  if (row.event !== 'NATIVE_BROKER_V1_EXIT' || !f || !BROKER_OUTCOMES.has(String(f.outcome)) || !BROKER_STAGE.test(String(f.stage)) || !BROKER_STAGE.test(String(f.slowStage))) return undefined;
  if (!(f.exitCode === null || (typeof f.exitCode === 'number' && Number.isInteger(f.exitCode) && f.exitCode >= -0x80000000 && f.exitCode <= 0xffffffff))) return undefined;
  for (const key of ['serviceMs', 'elapsedMs', 'slowMs', 'win32Error'] as const) if (!(f[key] === null || safeInteger(f[key]))) return undefined;
  if (!safeInteger(f.serviceMs) || (typeof f.win32Error === 'number' && f.win32Error > 0xffffffff)) return undefined;
  const facts: NonNullable<DiagnosticLogRow['facts']> = Object.fromEntries(['game', 'pluginSessionId', 'outcome', 'exitCode', 'serviceMs', 'stage', 'win32Error', 'elapsedMs', 'slowStage', 'slowMs'].map(key => [key, f[key]]));
  return {time: row.time, event: row.event, facts};
}

/** Revalidates a normalized plugin row through the native grammar before copying its facts. */
function pluginRow(row: DiagnosticLogRow): DiagnosticLogRow | undefined {
  const f = row.facts;
  if (row.event !== 'PLUGIN_V1_CONNECTION_CLOSED' || !f || (f.game !== 'ets2' && f.game !== 'ats')) return undefined;
  const durable = f.durable === null ? 'unknown' : f.durable === true ? '1' : f.durable === false ? '0' : 'invalid';
  return pluginCloseLogRow(`ETS2Telemetry: V1_CONNECTION_CLOSED reason=${f.reason} phase=${f.phase} write=${f.write} end=${f.end} win32=${f.win32} durable=${durable} connection=${f.connection} utcMs=${Date.parse(row.time)} durationMs=${f.durationMs} session=${f.pluginSessionId}`, f.game, false);
}

/** Exact plugin-session/game match plus the trip's UTC labels; event coverage is separate and unchanged. */
export function collectTripDiagnostics(detail: JournalTripDetail, exportedUtcMs: number, logs: DiagnosticBundleInput['logs']): TripExportDiagnostics {
  const result = emptyTripDiagnostics(detail);
  if (result.status === 'not-applicable') return result;
  const start = detail.trip.startedUtcMs, end = Math.min(detail.trip.endedUtcMs ?? exportedUtcMs, exportedUtcMs);
  result.notes.push('LOGS_MAY_BE_INCOMPLETE');
  if (!safeInteger(start) || !safeInteger(end) || end < start) { result.notes.push('INVALID_TIME_WINDOW'); return result; }
  if (!logs.plugin) result.notes.push('GAME_LOG_UNAVAILABLE');
  if (logs.service.current === undefined && logs.service.previous === undefined) result.notes.push('SERVICE_LOG_UNAVAILABLE');
  const records: TripExportDiagnosticRecord[] = [], seen = new Set<string>();
  // Files have already been bounded to 256 KiB each by readDiagnosticLogs. Only relevant sanitized records count.
  for (const [kind, text] of [['plugin', logs.plugin], ['broker', logs.service]] as const) {
    for (const content of [text?.previous, text?.current]) {
      for (const line of (content ?? '').split(/\r?\n/)) {
        const row = diagnosticLogRow(line);
        if (!row) continue;
        const utc = Date.parse(row.time), f = row.facts;
        if (!Number.isFinite(utc) || utc < start || utc > end || f?.game !== detail.trip.game || f.pluginSessionId !== detail.trip.pluginSessionId) continue;
        const safe = kind === 'plugin' ? pluginRow(row) : brokerRow(row);
        if (!safe) continue;
        const key = JSON.stringify(safe);
        if (seen.has(key)) continue;
        seen.add(key); records.push(safe as TripExportDiagnosticRecord);
      }
    }
  }
  records.sort((a, b) => a.time.localeCompare(b.time));
  if (records.length > TRIP_DIAGNOSTIC_RECORD_LIMIT) result.notes.push('RECORD_LIMIT');
  result.records = records.slice(-TRIP_DIAGNOSTIC_RECORD_LIMIT);
  result.status = result.records.length ? 'records-found' : !logs.plugin && logs.service.current === undefined && logs.service.previous === undefined ? 'unavailable' : 'no-matching-records';
  return result;
}
