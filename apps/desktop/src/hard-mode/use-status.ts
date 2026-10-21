import {useEffect, useState} from 'react';
import type {HardModeStatus} from '../../../../packages/contracts/src/hard-mode';
import {unknownHardMode} from '../../../../packages/telemetry-core/src/hard-mode';
/** One dashboard-lifetime poll/refresh controller shared by the shell and card, independent of route changes. */
export function useHardModeStatus() {
  const [status, setStatus] = useState<HardModeStatus>(() => ({assessment: unknownHardMode(Date.now()), trip: null}));
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true, pending = false;
    const read = () => {
      if (pending) return;
      pending = true;
      void window.desktop.getHardModeStatus().then(value => {if (active) {setStatus(value); setNow(Date.now()); setError(false); setLoaded(true);}}, () => {if (active) {setStatus({assessment: unknownHardMode(Date.now()), trip: null}); setError(true);}}).finally(() => {pending = false;});
    };
    read(); const timer = setInterval(read, 1000);
    return () => {active = false; clearInterval(timer);};
  }, []);
  const check = () => {setBusy(true); void window.desktop.refreshHardMode().then(setStatus, () => setError(true)).finally(() => setBusy(false));};
  return {status, now, busy, error, loaded, check};
}
export type HardModeController = ReturnType<typeof useHardModeStatus>;
