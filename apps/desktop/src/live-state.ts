import type {SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import type {LiveTelemetry, SourceSelection} from '../../../packages/contracts/src';
export function sourceSelection(value: unknown): SourceSelection {
  if (value !== 'game' && value !== 'ets2' && value !== 'ats' && value !== 'synthetic' && value !== 'replay') throw new Error('Invalid source selection');
  return value;
}
export function initialLive(selection: SourceSelection = 'game'): LiveTelemetry {
  return {selection, status: 'waiting', reason: 'Awaiting selected source', fresh: false, recording: false, coverage: 'unknown'};
}
export function sameGameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.game === right.game && left.origin === right.origin && left.processId === right.processId && left.windowsSessionId === right.windowsSessionId &&
    left.processInstanceId === right.processInstanceId && left.pluginSessionId === right.pluginSessionId;
}
