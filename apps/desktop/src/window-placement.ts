import type {LiveTelemetry} from '../../../packages/contracts/src';

export interface PhysicalClientBounds {x: number; y: number; width: number; height: number}
/** Placement input only. A numeric HWND never authorizes native window operations. */
export function currentGameClientBounds(live: LiveTelemetry): PhysicalClientBounds | undefined {
  const observation = live.observation;
  if ((live.selection !== 'ets2' && live.selection !== 'ats') || !['connected', 'paused', 'stale'].includes(live.status) ||
      !observation || observation.source.origin !== 'game' || observation.source.game !== live.selection || !observation.windowFresh)
    return;
  const window = observation.state.window;
  if (!window.available || !window.value.foreground || window.value.minimized || window.value.width <= 0 || window.value.height <= 0)
    return;
  const {x, y, width, height} = window.value;
  return {x, y, width, height};
}
