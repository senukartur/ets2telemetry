// Scaffold status only. The telemetry wire protocol belongs to ET-002a.
export interface ScaffoldStatus { service: 'ready'; storage: 'verified'; synthetic: true }
import type {CurrentState, SourceIdentity, AppliedState} from './protocol-v0';
export type SourceSelection = 'game' | 'ets2' | 'ats' | 'synthetic' | 'replay';
export interface LiveTelemetry {
  selection: SourceSelection;
  status: 'waiting' | 'connected' | 'paused' | 'stale' | 'incompatible' | 'disconnected' | 'unavailable' | 'service-failed' | 'restarting';
  reason: string;
  // Current observations are never durable history; freshness is explicit on every update.
  fresh: boolean;
  recording: false;
  coverage: 'unknown';
  observation?: {source: SourceIdentity; state: CurrentState; seq: string; receivedMonotonicMs: number; applied: AppliedState};
}
export interface DesktopBridge {
  getStatus(): Promise<ScaffoldStatus>;
  selectSource(source: SourceSelection): Promise<void>;
  subscribeLive(listener: (update: LiveTelemetry) => void): () => void;
}
export * from './protocol-v0';
