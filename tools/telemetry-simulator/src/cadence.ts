import {type Emission} from './scenario';

/** Scheduled gaps below this are under Windows timer and pipe resolution, so the smoke skips them. */
export const MIN_MEASURABLE_GAP_MS=20;
/** Smoke tolerance for late real-time delivery; it is not a latency target. */
export const MAX_LATE_MS=1000;
export interface CadenceCheck { index:number; expectedMs:number; actualMs:number }

/**
 * Compares the first measurable gap with the fixture schedule. Both values are
 * measured from the connection's first message, matching how the server paces
 * writes. Returns undefined when the fixture has no measurable gap.
 */
export function checkCadence(emissions:ReadonlyArray<Pick<Emission,'atMs'|'connection'>>,arrivalsMs:readonly number[]):CadenceCheck|undefined {
  if(arrivalsMs.length!==emissions.length)throw new Error('Arrival count differs from synthetic emissions');
  let first=0;
  for(let i=1;i<emissions.length;i++) {
    if(emissions[i].connection!==emissions[i-1].connection){first=i;continue;}
    const expectedMs=emissions[i].atMs-emissions[first].atMs;
    if(expectedMs<MIN_MEASURABLE_GAP_MS)continue;
    const actualMs=arrivalsMs[i]-arrivalsMs[first];
    if(actualMs<expectedMs/2||actualMs>expectedMs+MAX_LATE_MS)throw new Error(`Real cadence outside smoke bounds: expected ${expectedMs} ms, observed ${actualMs.toFixed(2)} ms`);
    return {index:i,expectedMs,actualMs};
  }
  return undefined;
}
