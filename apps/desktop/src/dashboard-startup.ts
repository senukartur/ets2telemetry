import type {AppHealth, ScaffoldStatus, ServiceHealth} from '../../../packages/contracts/src';
import {STRINGS} from './strings';

/**
 * The dashboard's startup line. A dashboard can open while the service restarts or after restart
 * exhaustion (from the tray or a second launch), when the status query answers `null`. The line then
 * shows a waiting state and queries again each time the pushed health enters `ready`. Pure logic, so it
 * is testable without a DOM; `publish` receives every change of the displayed text.
 */
export function createStartupLine(getStatus: () => Promise<ScaffoldStatus | null>, publish: (text: string) => void) {
  let outcome: 'pending' | 'ready' | 'failed' = 'pending', service: ServiceHealth | undefined, generation = 0, shown: string | undefined;
  const render = () => {
    if (outcome === 'ready') return STRINGS.startupReady;
    if (service === 'restarting' || service === 'failed') return STRINGS.startupWaiting;
    return outcome === 'failed' ? STRINGS.startupFailed : STRINGS.startupPending;
  };
  const show = () => {const text = render(); if (text !== shown) {shown = text; publish(text);}};
  const query = () => {
    const own = ++generation;
    // Any ready answer is genuine; only a superseded query's failure is ignored.
    getStatus().then(status => {if (status) {outcome = 'ready'; show();}},
      () => {if (own === generation && outcome !== 'ready') {outcome = 'failed'; show();}});
  };
  return {
    start: query,
    health(next: AppHealth): void {
      const previous = service; service = next.service;
      if (outcome !== 'ready' && next.service === 'ready' && previous !== 'ready') {outcome = 'pending'; query();}
      show();
    }
  };
}
