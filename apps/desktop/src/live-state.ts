import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry, SourceSelection, UnitGame} from '../../../packages/contracts/src';
export function sourceSelection(value: unknown): SourceSelection {
  if (value !== 'game' && value !== 'ets2' && value !== 'ats' && value !== 'synthetic' && value !== 'replay') throw new Error('Invalid source selection');
  return value;
}
export function initialLive(selection: SourceSelection = 'game'): LiveTelemetry {
  return {selection, status: 'waiting', reason: 'Awaiting selected source', fresh: false, recording: false, coverage: 'unknown'};
}
/** Matches an already validated real source to automatic intent or its explicit game; freshness is a separate gate. */
export function gameForSource(selection: SourceSelection, source: SourceIdentity | undefined): UnitGame | undefined {
  return source?.origin === 'game' && (source.game === 'ets2' || source.game === 'ats') && (selection === 'game' || selection === source.game) ? source.game : undefined;
}
export function sameGameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.game === right.game && left.origin === right.origin && left.processId === right.processId && left.windowsSessionId === right.windowsSessionId &&
    left.processInstanceId === right.processInstanceId && left.pluginSessionId === right.pluginSessionId;
}
