/**
 * Fixed service and storage error codes. They never carry paths, error text or other runtime details. Settings save
 * errors are separate (`SettingsSaveError`), so they never replace a service problem.
 */
export type AppErrorCode = 'SERVICE_EXITED' | 'SERVICE_RESTART_EXHAUSTED' | 'STORAGE_FAILED' | 'SERVICE_START_TIMEOUT';
export type ServiceHealth = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping';
export type StorageHealth = 'pending' | 'verified' | 'failed';
export interface AppHealth {
  service: ServiceHealth;
  /** The isolated storage self-test of the current service; not production history. */
  storage: StorageHealth;
  /** This version records no history, so recording is always unavailable. */
  recording: 'unavailable';
  lastError: AppErrorCode | null;
}
/** Games with their own display unit profile. */
export type UnitGame = 'ets2' | 'ats';
/**
 * Display unit profile ids. They must equal telemetry-core's `DisplayProfileId`; apps/desktop/src/unit-profiles.ts
 * asserts that at compile time.
 */
export type UnitProfile = 'metric' | 'us-customary';
export type UnitProfiles = Readonly<Record<UnitGame, UnitProfile>>;
/**
 * How the persisted settings were obtained at startup or by the last save. `defaults`: no file. `loaded-with-fallbacks`:
 * some fields were invalid and use defaults. `invalid-file`, `unsupported-older`: the file is kept unchanged until the
 * first save quarantines it. `newer-version`: written by a newer version; read-only. `unreadable`: the file or its
 * directory could not be read safely, or the read hung; `unavailable`: no valid settings location. Both are read-only.
 * `loading`: the startup read outlasted its 1000 ms budget and is still pending; defaults apply and saving is refused
 * until the read's own result replaces this state.
 */
export type SettingsState = 'loading' | 'defaults' | 'loaded' | 'loaded-with-fallbacks' | 'invalid-file' | 'unsupported-older'
  | 'newer-version' | 'unreadable' | 'unavailable';
/** Why the last settings save was refused: it could not be written, or the file is read-only (newer version). */
export type SettingsSaveError = 'SETTINGS_WRITE_FAILED' | 'SETTINGS_READ_ONLY';
/**
 * Overlay layouts (ET-012a): a 38 px strip at the top centre, a card at the top right, a cluster with a round speed
 * gauge at the bottom left, or a minimal text HUD at the top left of the game's client area.
 */
export type OverlayLayout = 'strip' | 'card' | 'cluster' | 'hud';
/** The fourteen overlay sections in canonical order; apps/desktop/src/overlay-sections.ts groups them. */
export type OverlaySectionId = 'speed' | 'gear' | 'rpm' | 'fuel' | 'range' | 'sdk-consumption' | 'cargo' | 'origin' | 'destination'
  | 'distance-driven' | 'distance-remaining' | 'deadline' | 'expected-income' | 'game-time';
/** Which overlay sections are enabled: always all fourteen keys, at least one of them true. */
export type OverlaySections = Readonly<Record<OverlaySectionId, boolean>>;
/**
 * One layout's saved position and size (ET-012b). `x` and `y` are fractions in [0, 1] of the free space left inside the
 * game's client area once the margins and the scaled overlay are taken away: 0 is the left or top margin, 1 the right
 * or bottom one. `scale` multiplies the layout's size and content, in [0.5, 2]. Never pixels, so a placement stays
 * inside any client area it fits by construction.
 */
export interface OverlayPlacement {
  x: number;
  y: number;
  scale: number;
}
/** One placement per layout: always all four keys. */
export type OverlayPlacements = Readonly<Record<OverlayLayout, OverlayPlacement>>;
export interface OverlaySettings {
  layout: OverlayLayout;
  sections: OverlaySections;
  /** The saved position and scale of every layout (ET-012b). */
  placements: OverlayPlacements;
}
/**
 * Why the overlay is or is not shown while its position is edited (ET-012b). `visible`: shown over the game and
 * draggable. `waiting-for-game`: no usable game window (no game source, the game minimized, a stale window report or
 * an overlay that is not loaded). `too-large`: the layout at this scale does not fit the game's client area.
 * `not-foreground`: neither of this application's windows is focused, or the game itself is in front.
 */
export type OverlayEditPlacement = 'visible' | 'waiting-for-game' | 'too-large' | 'not-foreground';
/** Main-owned overlay edit mode. It lives in memory only: every start is in driving mode. */
export type OverlayEditState =
  | {active: false}
  | {active: true; layout: OverlayLayout; scale: number; placement: OverlayEditPlacement};
/** The settings that apply now. Never carries paths, file content or error text. */
export interface SettingsView {
  units: UnitProfiles;
  /** The saved overlay layout, sections and placements, or their defaults (strip, every section, the default anchors). */
  overlay: OverlaySettings;
  state: SettingsState;
  /** False when a change cannot be saved: a pending read, or a newer-version, unreadable or unavailable settings file. */
  writable: boolean;
  /** The last save's refusal, cleared by the next successful save. Independent of the service's `lastError`. */
  saveError: SettingsSaveError | null;
}
/** Main-owned application state pushed to the dashboard. */
export interface AppState {
  health: AppHealth;
  settings: SettingsView;
  /** The overlay edit mode; pushed whenever it changes. */
  overlayEdit: OverlayEditState;
}
