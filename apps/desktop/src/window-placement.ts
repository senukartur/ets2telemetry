import type {LiveTelemetry} from '../../../packages/contracts/src';

export interface PhysicalClientBounds {x: number; y: number; width: number; height: number}

/**
 * The game's physical client area from a current game window report of the selected game: a live connection, a game
 * origin matching the selection, a fresh window receipt, not minimized and a positive size. The foreground is not
 * checked here. Placement input only: a numeric HWND never authorizes native window operations.
 */
export function visibleGameClientBounds(live: LiveTelemetry): PhysicalClientBounds | undefined {
  const observation = live.observation;
  if ((live.selection !== 'ets2' && live.selection !== 'ats') || !['connected', 'paused', 'stale'].includes(live.status) ||
      !observation || observation.source.origin !== 'game' || observation.source.game !== live.selection || !observation.windowFresh)
    return;
  const window = observation.state.window;
  if (!window.available || window.value.minimized || window.value.width <= 0 || window.value.height <= 0)
    return;
  const {x, y, width, height} = window.value;
  return {x, y, width, height};
}

/** True when the last window report says the game is the foreground window. */
export function gameForeground(live: LiveTelemetry): boolean {
  const window = live.observation?.state.window;
  return Boolean(window?.available && window.value.foreground);
}

/** Driving mode: the visible client area, and only while the game is the foreground window. */
export function currentGameClientBounds(live: LiveTelemetry): PhysicalClientBounds | undefined {
  return gameForeground(live) ? visibleGameClientBounds(live) : undefined;
}
