import type {LiveTelemetry} from '../../contracts/src';

// ET-051, display only. The games send 0.0 for the SDK average consumption for about a quarter of a second every two to
// three seconds while the mean itself goes on, and for longer while standing. The dashboard and the overlay show the last
// non-zero value through such a zero for up to HOLD_NS of source time; a longer zero, an unavailable value and history
// are left as the SDK sent them.

/** How long a zero may follow the last non-zero reading and still show it, in nanoseconds of the plugin capture clock. */
export const CONSUMPTION_HOLD_NS = 10_000_000_000n;

/** Applies the hold to the v0 observation of each live update, in arrival order. One instance per live stream. */
export class ConsumptionHold {
  private last?: {sessionId: string; clockId: string; value: number; atNs: bigint};

  apply(live: LiveTelemetry): LiveTelemetry {
    const observation = live.observation;
    if (!observation) return live;
    const reading = observation.state.averageConsumption, atNs = BigInt(observation.capture.monotonicNs);
    const last = this.last?.sessionId === observation.source.pluginSessionId && this.last.clockId === observation.capture.clockId ? this.last : undefined;
    // An unavailable reading ends the hold: only a zero right after a non-zero value is bridged.
    if (!reading.available) {this.last = undefined; return live;}
    if (reading.value !== 0) {this.last = {sessionId: observation.source.pluginSessionId, clockId: observation.capture.clockId, value: reading.value, atNs}; return live;}
    this.last = last;
    if (!last || atNs < last.atNs || atNs - last.atNs > CONSUMPTION_HOLD_NS) return live;
    return {...live, observation: {...observation, state: {...observation.state, averageConsumption: {...reading, value: last.value}}}};
  }
}
