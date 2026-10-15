// Scaffold status only. The telemetry wire protocol belongs to ET-002a.
export interface ScaffoldStatus { service: 'ready'; storage: 'verified'; synthetic: true }
import type {CurrentState, SourceIdentity, AppliedState, CaptureTime} from './protocol-v0';
import type {AppState, OverlayLayout, OverlaySectionId, OverlaySections, SettingsView, UnitGame, UnitProfile} from './app-state';
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
  /** `null` while the telemetry service is not ready, for example during a supervised restart. */
  getStatus(): Promise<ScaffoldStatus | null>;
  selectSource(source: SourceSelection): Promise<void>;
  subscribeLive(listener: (update: LiveTelemetry) => void): () => void;
  /** Current main-owned application state: fixed health codes only. */
  getAppState(): Promise<AppState>;
  /** One listener per document; main pushes the full state on every change. */
  subscribeAppState(listener: (state: AppState) => void): () => void;
  /** Explicit, orderly application exit; closing the window only hides it to the tray. */
  exitApplication(): Promise<void>;
  /**
   * Persists one game's display unit profile and resolves with the settings that now apply. Main applies the change only
   * after the durable write; it rejects a newer-version (read-only) file, a failed write and invalid values.
   */
  setUnitProfile(game: UnitGame, profile: UnitProfile): Promise<SettingsView>;
  /** Persists the overlay layout; like a unit profile, main applies it only after the durable write. */
  setOverlayLayout(layout: OverlayLayout): Promise<SettingsView>;
  /** Persists the complete overlay section set: exactly the fourteen ids, booleans only, at least one enabled. */
  setOverlaySections(sections: OverlaySections): Promise<SettingsView>;
}
/**
 * One overlay section, formatted by main in the displayed game's unit profile. `value`: current text with an optional
 * secondary `detail` (such as the fuel level) and, for engine RPM, a `ring` fraction in [0, 1] of the fixed 0-3000 rpm
 * display scale. `unavailable`: rendered as a dash, never as zero or a last-known value. A disabled section, one the
 * protocol in use does not carry, or (except speed and fuel) one without data while current is left out of the list.
 */
export type OverlaySectionView =
  | {id: OverlaySectionId; state: 'value'; text: string; detail?: string; ring?: number}
  | {id: OverlaySectionId; state: 'unavailable'};
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
  /** The saved layout; the renderer arranges the sections with it. */
  layout: OverlayLayout;
  /** Current telemetry from a paused game; always false while not current. */
  paused: boolean;
  /** The sections to render, in canonical order. */
  sections: readonly OverlaySectionView[];
}
export interface OverlayBridge {
  subscribeOverlay(listener: (update: OverlayPresentation) => void): () => void;
}
export * from './protocol-v0';
export * from './app-state';
