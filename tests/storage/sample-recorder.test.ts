// ET-015b PR-3: one-second samples recorded by V1Ingestion, DurableDelivery and TripRecorderSink through the bundled
// storage worker under the pinned Electron runtime, against the reactive v1 simulator on actual Windows pipes, unpaced,
// into a temporary synthetic-purpose database. The scenario tests/fixtures/recording/one-second-samples.json is not in
// the simulator manifest; its served stream must equal its own replay. The stored rows must equal the hand-written
// tests/fixtures/recording/one-second-samples.rows.expected.json (REG-001, REG-002, REG-003, REG-005, REG-009, REG-012).
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {reactiveDifferences} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {ok, readOnly, workspace} from './helpers';
import {RECORDING_FIXTURES, replayOf, runRecording, storedSamples, terminateWorkers, withTransport, type RecordingRun} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

const input = () => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string};
const expected = JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.rows.expected.json'), 'utf8')) as {samples: unknown[]; restartSamples: unknown[];
  coverage: {committedThroughEventSeq: string}};
const durable = {durable: true, commit: 'each', ack: 'each'};

/** Every service ended cleanly: no incompatible state, no durable failure and no sample retry, drop or discard. */
async function expectClean(run: RecordingRun) {
  for (const ack of run.acks) expect(ack.through, `ACK ${ack.through} on connection ${ack.connection}`).toBeLessThanOrEqual(ack.coverage);
  for (const service of run.services) {
    expect(await service.client.close()).toEqual({clean: true});
    expect(service.states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
    expect(service.logs.filter(([event]) => /^V1_(DURABLE|SAMPLES_(RETRY|DROPPED|DISCARDED))/.test(event))).toEqual([]);
  }
}
const sampleChecks = () => readOnly(ws.database, db => ({
  integrity: db.pragma('integrity_check', {simple: true}),
  // H6: never more than one stored row per session, source clock and source second.
  duplicates: db.prepare(`SELECT count(*) FROM (SELECT plugin_session_ref, source_clock_ref, monotonic_ns / 1000000000 AS second FROM samples
    GROUP BY plugin_session_ref, source_clock_ref, second HAVING count(*) > 1)`).pluck().get()
}));

describe('ET-015b one-second samples through the trip recorder and the real storage worker', () => {
  it('stores one row per fresh running source second, with no row for pauses or holes and no catch-up', async () => {
    const scenario = input(), replay = replayOf(scenario), session = scenarioSource(replay.scenario).pluginSessionId;
    const run = await runRecording(scenario, {path: ws.database, backups: ws.backups});
    expect(reactiveDifferences(replay, run.report)).toEqual([]);
    expect(run.services).toHaveLength(1);
    await expectClean(run);
    const reader = await ws.open(); expect(ok(reader.committedThrough(session))).toBe(expected.coverage.committedThroughEventSeq); reader.close();
    expect(await storedSamples(ws, scenario.seed, session)).toEqual(expected.samples);
    expect(sampleChecks()).toEqual({integrity: 'ok', duplicates: 0});
  }, 90_000);

  it('skips the second a restarted service samples again, so no row is stored twice and earlier rows survive the new worker (H6)', async () => {
    const base = input(), scenario = withTransport(base, 'one-second-samples-restart', [{atMs: 0, action: 'connect', client: durable}, {atMs: 12300, action: 'disconnect'},
      {atMs: 12400, action: 'connect', client: durable}, {atMs: 17500, action: 'disconnect'}]);
    const replay = replayOf(scenario), session = scenarioSource(replay.scenario).pluginSessionId;
    const run = await runRecording(scenario, {path: ws.database, backups: ws.backups}, {restartAfter: [0]});
    expect(reactiveDifferences(replay, run.report)).toEqual([]);
    expect(run.services).toHaveLength(2);
    await expectClean(run);
    // Only the second service sampled second 1012 again; storage skipped that one row (uniqueSeconds).
    expect(run.services.map(service => service.logs.filter(([event]) => event === 'V1_SAMPLES_SKIPPED'))).toEqual([[], [['V1_SAMPLES_SKIPPED', {count: 1}]]]);
    expect(await storedSamples(ws, base.seed, session)).toEqual([...expected.samples.slice(0, 10), ...expected.restartSamples]);
    expect(sampleChecks()).toEqual({integrity: 'ok', duplicates: 0});
  }, 90_000);
});
