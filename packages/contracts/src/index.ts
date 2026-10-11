// Scaffold status only. The telemetry wire protocol belongs to ET-002a.
export interface ScaffoldStatus { service: 'ready'; storage: 'verified'; synthetic: true }
import type {CurrentState, SourceIdentity, AppliedState, CaptureTime} from './protocol-v0';
export type SourceSelection = 'game' | 'ets2' | 'ats' | 'synthetic' | 'replay';
export interface LiveTelemetry {
  selection: SourceSelection;
  status: 'waiting' | 'connected' | 'paused' | 'stale' | 'incompatible' | 'disconnected' | 'unavailable' | 'service-failed' | 'restarting';
  reason: string;
  // Current observations are never durable history; freshness is explicit on every update.
  fresh: boolean;
  recording: false;
  coverage: 'unknown';
  observation?: {source: SourceIdentity; state: CurrentState; seq: string; capture: CaptureTime;
    // SDK receipt advances only with a new capture; window receipt has its own conservative TTL.
    receivedMonotonicMs: number; windowReceivedMonotonicMs: number; windowFresh: boolean; applied: AppliedState};
}
export interface DesktopBridge {
  getStatus(): Promise<ScaffoldStatus>;
  selectSource(source: SourceSelection): Promise<void>;
  subscribeLive(listener: (update: LiveTelemetry) => void): () => void;
}
/** Read-only display projection: no source selection, HWND or native placement authority. */
export interface OverlayPresentation {
  source: 'ETS2' | 'ATS' | 'No game';
  origin: 'game' | 'synthetic' | 'replay' | 'none';
  status: LiveTelemetry['status'];
  speed: string;
  speedUnit: 'km/h' | 'mph';
  fuel: string;
  fuelUnit: 'L' | 'US gal';
  freshness: 'current' | 'stale' | 'unavailable';
}
export interface OverlayBridge {
  subscribeOverlay(listener: (update: OverlayPresentation) => void): () => void;
}
export * from './protocol-v0';
