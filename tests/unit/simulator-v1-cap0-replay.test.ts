import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {replayV1, transcriptLines} from '../../tools/telemetry-simulator/src/v1/replay';
import {clientPlan, pipeDifferences, runV1PipeClient, serveV1} from '../../tools/telemetry-simulator/src/v1/pipe';
import {cap01Manifest, scenarioPath, expectedPath} from '../shared/simulator-v1-expected';
import type {CaptureStep} from '../../tools/telemetry-simulator/src/v1/cap0-schema';

const load = (run: number) => readFixtureFile(scenarioPath(`cap01/cap01-run${run}`));
function replay(run: number) {
  const result = replayV1(load(run));
  const steps = result.scenario.steps.filter((s): s is CaptureStep => s.action === 'capture');
  const events = result.transcript.flatMap(l => l.message.kind === 'event' ? [l.message] : []);
  const atEnvelope = (n: number) => events.find(m => m.data.occurred.boundaryOrder === steps[n - 1].data.sharedBoundaryOrder)!;
  return {result, steps, events, atEnvelope};
}

describe('minimized CAP-01 replay corpus', () => {
  for (const id of cap01Manifest()) {
    it(`${id} meets the independent source-order oracle with exact callback context and deterministic bytes`, () => {
      const input = readFixtureFile(scenarioPath(id)), result = replayV1(input);
      const expected = JSON.parse(readFileSync(expectedPath(id), 'utf8')) as {scenario: string; envelopes: number; authoredFrom: string[]; coverage: {envelope: number; event: string; type: string}[]; ledger: unknown};
      const steps = result.scenario.steps.filter((s): s is CaptureStep => s.action === 'capture');
      expect(expected.scenario).toBe(result.scenario.id); expect(expected.authoredFrom.length).toBeGreaterThan(0);
      expect(steps).toHaveLength(expected.envelopes); expect(result.scenario.origin).toBe('replay');
      const events = result.transcript.flatMap(l => l.message.kind === 'event' ? [l.message] : []);
      expect(events.map(m => ({envelope: steps.findIndex(s => s.data.sharedBoundaryOrder === m.data.occurred.boundaryOrder) + 1, event: m.data.eventSeq, type: m.data.record.type}))).toEqual(expected.coverage);
      for (const m of events) {
        const s = steps.find(s => s.data.sharedBoundaryOrder === m.data.occurred.boundaryOrder)!;
        expect(m.source.origin).toBe('replay'); expect(m.data.redelivered).toBe(false);
        expect(m.data.occurred.simulation).toBe(s.data.simulation);
        expect(m.data.occurred.gameTime.minutes).toEqual(s.data.gameTime.minutes.available ? {available: true, value: s.data.gameTime.minutes.value} : {available: false, reason: s.data.gameTime.minutes.reason});
        expect(m.data.occurred.utcUnixMs).toEqual({available: false, reason: 'not-observed'});
        expect(m.data.occurred.monotonicNs).toEqual({available: true, value: String(1_000_000_000_000n + BigInt(s.data.callbackMonotonicNs.available ? s.data.callbackMonotonicNs.value : '0'))});
      }
      const snapshots = result.transcript.flatMap(l => l.message.kind === 'snapshot' || l.message.kind === 'checkpoint' ? [l.message] : []);
      for (const m of snapshots) for (const channel of ['speed', 'fuel', 'odometer', 'averageConsumption', 'navigationDistance'] as const) expect(m.data.state[channel]).toMatchObject({available: false, reason: 'not-observed'});
      expect(result.ledger).toEqual(expected.ledger); expect(result.store.retainedEntries).toBe(0);
      expect(result.transcript.filter(l => l.message.kind === 'gap')).toEqual([]);
      expect(transcriptLines(result)).toEqual(transcriptLines(replayV1(input)));
    });
    it(`${id} serves replay origin and identical coverage over an actual named pipe`, async () => {
      const input = readFixtureFile(scenarioPath(id)), expected = replayV1(input), server = await serveV1(input, {scale: 0});
      try {
        const client = await runV1PipeClient(server.endpoint, clientPlan(expected), {scale: 0});
        const report = await server.done;
        expect(pipeDifferences(expected, report.result, client)).toEqual([]);
      } finally { await server.stop(); }
    }, 30_000);
  }
  it('retains late attachment, cargo-market re-send, ferry pause and its unlocated game-time jumps (O2/O3/O11)', () => {
    const {steps, events, atEnvelope} = replay(8);
    expect(events.filter(m => m.data.record.type === 'timers.restart' || m.data.record.type === 'job.delivered')).toEqual([]);
    expect(steps.slice(0, 8).some(s => s.data.callback.group === 'configuration')).toBe(false);
    expect(atEnvelope(9).data.record).toMatchObject({type: 'job.configured', market: {value: 'cargo_market'}, cargoLoaded: {value: false}, expectedIncome: {value: {raw: '11621'}}, plannedDistance: {value: 203000}});
    expect(atEnvelope(12).data.record).toMatchObject({type: 'job.configured', cargoLoaded: {value: true}});
    const a = steps[8].data.observations, b = steps[11].data.observations;
    expect(a.filter(o => o.name.available && o.name.value !== 'cargo.loaded')).toEqual(b.filter(o => o.name.available && o.name.value !== 'cargo.loaded'));
    expect(atEnvelope(27).data.record).toMatchObject({type: 'player.use.ferry', amount: {value: {raw: '677'}}});
    expect([26, 27, 28].map(n => atEnvelope(n).data.occurred.gameTime.minutes)).toEqual(Array(3).fill({available: true, value: '251528'}));
    expect([atEnvelope(27).data.occurred.simulation, atEnvelope(29).data.occurred.gameTime.minutes]).toEqual(['paused', {available: true, value: '251751'}]);
  });
  it('keeps the save-load start on the old clock and regression 30,100 ns later on the new clock, then cancel after clear (O7/O9/O10)', () => {
    const {steps, events, atEnvelope} = replay(9);
    expect(events.some(m => m.data.record.type === 'timers.restart')).toBe(false);
    expect(steps.slice(0, 6).some(s => s.data.callback.group === 'configuration')).toBe(false);
    expect(atEnvelope(37).data.occurred.gameTime.minutes).toEqual({available: true, value: '251808'});
    expect(atEnvelope(38).data.record).toMatchObject({type: 'gameTime.regression', from: {minutes: {available: false, reason: 'not-observed'}, clockId: atEnvelope(37).data.occurred.gameTime.clockId}, to: {minutes: {value: '251789'}}});
    expect(atEnvelope(37).data.occurred.gameTime.clockId).not.toBe(atEnvelope(38).data.occurred.gameTime.clockId);
    const ns = (n: number) => { const v = atEnvelope(n).data.occurred.monotonicNs; return BigInt(v.available ? v.value : '0'); };
    expect(ns(38) - ns(37)).toBe(30100n);
    expect(atEnvelope(41).data.record.type).toBe('job.cleared');
    expect(atEnvelope(54).data.record).toMatchObject({type: 'job.cancelled', penalty: {value: {raw: '12000'}}});
    expect(atEnvelope(54).data.occurred.simulation).toBe('paused');
  });
  it('retains observed delivery order, amounts and duration without generalizing O4 or inferring fines caused lost revenue', () => {
    for (const [run, delivery, clear, revenue, duration, gameTime] of [[2, 54, 55, '0', '636', '246892'], [4, 58, 59, '2577', '244', '62909'], [7, 43, 44, '4625', '76', '63923']] as const) {
      const {atEnvelope} = replay(run);
      expect(atEnvelope(delivery - 1).data.record.type).toBe('simulation.paused');
      expect(atEnvelope(delivery).data.record).toMatchObject({type: 'job.delivered', revenue: {value: {raw: revenue}}, deliveryDuration: {value: duration}});
      expect(atEnvelope(delivery).data.occurred).toMatchObject({gameTime: {minutes: {value: gameTime}}, simulation: 'paused'});
      expect(atEnvelope(clear).data.record.type).toBe('job.cleared');
    }
    expect(replay(7).atEnvelope(39).data.record).toMatchObject({type: 'player.tollgate.paid', amount: {value: {raw: '4'}}});
  });
});

// ET-050b: the CAP-01 hshifter and truck captures become the minor-1 gearbox; trip outputs above are unchanged. The
// layouts are the CAP-01 slot tables of the ET-050b plan, written by hand (slot order: handle position, then selectors).
describe('CAP-01 replay gearbox (ET-050b)', () => {
  const slots = (rows: [number, number, number][]) => rows.map(([gear, handlePosition, selectors]) => ({gear, handlePosition, selectors}));
  const eighteen = slots([[-1, 2, 0], [-3, 2, 1], [-2, 2, 2], [-4, 2, 3], [1, 3, 0], [2, 3, 2], [3, 4, 0], [11, 4, 1], [4, 4, 2], [12, 4, 3], [5, 5, 0], [13, 5, 1],
    [6, 5, 2], [14, 5, 3], [7, 6, 0], [15, 6, 1], [8, 6, 2], [16, 6, 3], [9, 7, 0], [17, 7, 1], [10, 7, 2], [18, 7, 3]]);
  const twelve = slots([[-1, 1, 0], [-3, 1, 1], [-2, 1, 2], [-4, 1, 3], [1, 2, 0], [7, 2, 1], [2, 2, 2], [8, 2, 3], [3, 3, 0], [9, 3, 1], [4, 3, 2], [10, 3, 3],
    [5, 4, 0], [11, 4, 1], [6, 4, 2], [12, 4, 3]]);
  const states = (run: number) => replay(run).result.transcript.flatMap(l => l.message.kind === 'snapshot' || l.message.kind === 'checkpoint' ? [l.message] : []);
  it('serves the minor-1 gearbox on every state message of the replay connection', () => {
    for (const run of [2, 4, 7, 8, 9]) {
      const all = states(run);
      expect(all.length).toBeGreaterThan(0);
      for (const m of all) { expect(m.version).toEqual({major: 1, minor: 1}); expect(m.data.state.gearbox).toBeDefined(); }
    }
  });
  it('carries the ATS Mack 18F/4R layout once run4 and run7 configured their trucks', () => {
    for (const run of [4, 7]) {
      expect(states(run).at(-1)!.data.state.gearbox).toEqual({forwardGears: {available: true, value: 18}, reverseGears: {available: true, value: 4},
        hshifter: {available: true, value: {selectorCount: 2, slots: eighteen}}});
    }
  });
  it('carries the ETS2 12-speed layout in run9 and none in run8, which captured no hshifter callback', () => {
    expect(states(9).at(-1)!.data.state.gearbox).toEqual({forwardGears: {available: true, value: 12}, reverseGears: {available: true, value: 4},
      hshifter: {available: true, value: {selectorCount: 2, slots: twelve}}});
    expect(states(8).at(-1)!.data.state.gearbox?.hshifter).toEqual({available: false, reason: 'not-observed'});
  });
});
