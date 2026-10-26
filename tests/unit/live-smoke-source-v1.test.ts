// ET-010c decision F8: the synthetic protocol v1 smoke source over an actual Windows named pipe, consumed by the
// production V1Ingestion (strict validation, live-only hello). REG-003 (hydrating checkpoint shown as current state
// only), REG-010 (hold on the same connection goes stale, never reconnects) and REG-011 (stop disconnects).
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {expect, it, vi} from 'vitest';
import {liveV1Projection} from '../../apps/desktop/src/live-v1';
import {TEST_PIPE_PATTERN_V1, V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import type {LiveSmokeSourceV1} from '../../scripts/ci/live-smoke-source-v1.mjs';

// Runtime helpers are JavaScript outside the application TypeScript project.
const sourceModule = pathToFileURL(path.resolve('scripts/ci/live-smoke-source-v1.mjs')).href;

it('serves validated live-only v1 data that goes stale while held on the same connection and disconnects on stop', async () => {
  const {startLiveSmokeSourceV1} = await import(sourceModule) as {startLiveSmokeSourceV1: (checkout: string) => Promise<LiveSmokeSourceV1>};
  const source = await startLiveSmokeSourceV1(path.resolve('.'));
  const states: V1SourceState[] = [];
  const ingestion = new V1Ingestion({onState: state => states.push(state)});
  try {
    expect(source.endpoint).toMatch(TEST_PIPE_PATTERN_V1);
    ingestion.select('synthetic', source.endpoint);
    await vi.waitFor(() => expect(ingestion.current).toMatchObject({status: 'connected', fresh: true, observation: {kind: 'snapshot'}}), {timeout: 3000, interval: 20});
    // The first observation is the hydrating checkpoint; later snapshots are not.
    expect(states.find(state => state.observation)!.observation).toMatchObject({kind: 'checkpoint', hydration: true});
    const identity = source.statistics().identity, observation = ingestion.current.observation!;
    expect(observation.source).toEqual({game: 'ets2', pluginSessionId: identity.pluginSessionId, processInstanceId: identity.processInstanceId,
      processId: process.pid, windowsSessionId: 1, origin: 'synthetic'});
    expect(observation.capture.clockId).toBe(identity.clockId);
    const job = observation.state.configuration.job;
    expect(job.available && [job.value.cargoId, job.value.destinationCityId]).toEqual([{available: true, value: 'cargo.logs'}, {available: true, value: 'city.warszawa'}]);
    // ET-052: the source selects minor 2 (the service offers it), so every state also carries a next mandatory break of 95
    // game minutes until setBreak names another reading; setBreak(undefined) restores 95.
    expect(observation.state.nextMandatoryBreak).toEqual({available: true, value: 95, unit: 'min'});
    expect(liveV1Projection(ingestion.current)?.observation?.state.nextMandatoryBreak).toEqual({available: true, value: 95, unit: 'min'});
    const breakNow = () => ingestion.current.observation!.state.nextMandatoryBreak;
    for (const reading of [{available: true, value: 0, unit: 'min'}, {available: true, value: -30, unit: 'min'}, {available: false, reason: 'not-observed', unit: 'min'}] as const) {
      source.setBreak(structuredClone(reading));
      await vi.waitFor(() => expect(breakNow()).toEqual(reading), {timeout: 2000, interval: 20});
    }
    source.setBreak(undefined);
    await vi.waitFor(() => expect(breakNow()).toEqual({available: true, value: 95, unit: 'min'}), {timeout: 2000, interval: 20});
    // ET-050b: the source also carries the Mack gearbox of the minor-1 fixture in every state, and the v1
    // truck keeps the fixture's model id until setTruckId names v0's.
    const mack = (JSON.parse(readFileSync('tests/fixtures/protocol-v1/minor1/checkpoint-ats-mack.json', 'utf8')) as {data: {state: {gearbox: unknown}}}).data.state.gearbox;
    expect(observation.state.gearbox).toEqual(mack);
    expect(liveV1Projection(ingestion.current)?.observation?.state.gearbox).toEqual(mack);
    const truckId = () => {const truck = ingestion.current.observation!.state.configuration.truck; return truck.available ? truck.value.id : undefined;};
    expect(truckId()).toEqual({available: true, value: 'vehicle.synthetic_truck'});
    source.setTruckId('truck.volvo');
    await vi.waitFor(() => expect(truckId()).toEqual({available: true, value: 'truck.volvo'}), {timeout: 2000, interval: 20});
    source.setTruckId(undefined);
    await vi.waitFor(() => expect(truckId()).toEqual({available: true, value: 'vehicle.synthetic_truck'}), {timeout: 2000, interval: 20});
    // The fixture window reaches the service and is stripped by its projection.
    expect(observation.state.window.available).toBe(true);
    // ET-050b: the gearbox's `handlePosition` keys are legitimate, so the window handle is matched as its own key.
    expect(JSON.stringify(liveV1Projection(ingestion.current))).not.toMatch(/"window"|"handle"|65538/);
    // The service's own 500 ms expiry: held data goes stale on the same connection within one second.
    const boundary = BigInt(observation.state.boundaryOrder);
    source.hold();
    await vi.waitFor(() => expect(ingestion.current).toMatchObject({status: 'stale', fresh: false, reason: 'No recent SDK capture'}), {timeout: 1000, interval: 20});
    source.resume();
    await vi.waitFor(() => expect(ingestion.current).toMatchObject({status: 'connected', fresh: true}), {timeout: 2000, interval: 20});
    expect(BigInt(ingestion.current.observation!.state.boundaryOrder)).toBeGreaterThan(boundary);
    expect(source.statistics()).toMatchObject({connections: 1, activeClients: 1, held: false, origin: 'synthetic', history: false});
    expect(source.statistics().probes).toBeGreaterThanOrEqual(1);
    await source.stop();
    await vi.waitFor(() => expect(ingestion.current).toMatchObject({status: 'disconnected', fresh: false}), {timeout: 2000, interval: 20});
    // The last observation stays, so the dashboard shows its values as not current.
    expect(ingestion.current.observation).toBeDefined();
    expect(source.statistics()).toMatchObject({connections: 1, activeClients: 0, stopped: true});
  } finally {await ingestion.stop(); await source.stop();}
}, 10000);
