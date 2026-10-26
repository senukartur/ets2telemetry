// ET-052 D4 (REG-003, REG-005, REG-009, REG-014): the next mandatory break is live only. A protocol v1 minor-2 source whose
// break changes in every frame (soon, due, zero, negative, overdue) is recorded by the real pipeline (the reactive v1
// simulator on actual Windows pipes, V1Ingestion, the trip recorder and the real storage worker into a temporary
// synthetic-purpose database) into exactly the rows the same source records at minor 1, which carries no break: every
// table of the two databases is equal except the stored `protocol_minor` (2 against 1), the wall-clock bookkeeping stamps and
// the database identity, and the hand-written sample rows of tests/fixtures/recording/one-second-samples.rows.expected.json
// are the minor-2 run's rows. Nothing is added to
// samples, trips, events, gaps or attributions for the break, and a break that changes does not change a sample, a trip,
// a completeness interval or an ACK. The existing recording, journal and export suites are unchanged by this proof.
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readOnly, workspace} from './helpers';
import {reactiveDifferences} from '../../tools/telemetry-simulator/src/v1/reactive';
import {scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {checkHistoryInvariants, formatViolations} from '../../scripts/ci/history-invariants.mjs';
import {readHistoryRows} from './history-rows';
import {RECORDING_FIXTURES, replayOf, runRecording, storedRows, storedSamples, terminateWorkers, type RecordingRun} from './recording-helpers';

type Json = Record<string, unknown>;
let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await terminateWorkers(); await ws.dispose(); });

const base = () => JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.json'), 'utf8')) as Json & {seed: string; steps: Json[]; source: Json};
const expected = JSON.parse(readFileSync(path.join(RECORDING_FIXTURES, 'one-second-samples.rows.expected.json'), 'utf8')) as {samples: unknown[]};
/** Break readings by frame: soon, an hour apart from due, zero, overdue and the s32 minimum, repeating, so every urgency occurs. */
const BREAKS = [95, 94, 61, 60, 59, 15, 1, 0, -1, -30, 120, 119, 121, -2147483648, 2147483647];

/** The scenario with a different break in every frame; `highestMinor` models a plugin from before ET-052 (minor 1). */
function withBreaks(id: string, highestMinor?: 1): Json & {seed: string} {
  const scenario = base();
  let index = 0;
  for (const step of scenario.steps) {
    if (step.action !== 'frame') continue;
    step.channels = {...(step.channels as Json | undefined), 'mandatory.break': BREAKS[index++ % BREAKS.length]};
  }
  scenario.id = id;
  if (highestMinor !== undefined) scenario.source = {...scenario.source, highestMinor};
  return scenario;
}

/**
 * Columns that are not part of what was recorded: the connection's protocol minor, and the wall-clock bookkeeping stamps and
 * the identity of the database, which differ between any two runs (a database is created at the time of its run).
 */
const NOT_RECORDED = new Set(['protocol_minor', 'applied_utc_ms', 'committed_utc_ms', 'created_utc_ms', 'first_seen_utc_ms', 'updated_utc_ms', 'database_uuid']);
/** Every table row of a closed database in rowid order, without the columns above. */
function dump(file: string): Record<string, Json[]> {
  return readOnly(file, db => {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[]);
    return Object.fromEntries(tables.map(table => [table, (db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).safeIntegers(true).all() as Json[])
      .map(row => Object.fromEntries(Object.entries(row).filter(([column]) => !NOT_RECORDED.has(column))))]));
  });
}
const minors = (file: string) => readOnly(file, db => ({
  sessions: db.prepare('SELECT DISTINCT protocol_minor AS minor FROM plugin_sessions ORDER BY 1').pluck().all(),
  events: db.prepare('SELECT DISTINCT protocol_minor AS minor FROM events ORDER BY 1').pluck().all()
}));

async function record(scenario: Json & {seed: string}, name: string) {
  const database = {path: path.join(ws.directory, `${name}.sqlite`), backups: path.join(ws.directory, `${name}-backups`)};
  const replay = replayOf(scenario), session = scenarioSource(replay.scenario).pluginSessionId;
  const run: RecordingRun = await runRecording(scenario, database);
  expect(reactiveDifferences(replay, run.report)).toEqual([]);
  for (const service of run.services) {
    expect(await service.client.close()).toEqual({clean: true});
    expect(service.states.filter(s => s.status === 'incompatible' || s.durable.state === 'failed')).toEqual([]);
  }
  return {database, session, run, replay};
}

describe('ET-052 D4: the next mandatory break is never recorded', () => {
  it('records a changing minor-2 break into exactly the rows a minor-1 plugin gives, and stores protocol minor 2', async () => {
    const withBreak = await record(withBreaks('break-minor-2'), 'minor2');
    const older = await record(withBreaks('break-minor-1', 1), 'minor1');
    // The break reached the service on one connection and not on the other (the stored minor is the envelope minor).
    expect(minors(withBreak.database.path)).toEqual({sessions: [2], events: [2]});
    expect(minors(older.database.path)).toEqual({sessions: [1], events: [1]});
    // Table by table, row by row, equal in everything but protocol_minor: events, gaps, trips, attributions, completeness
    // intervals, samples, clocks, sessions and every other table.
    const left = dump(withBreak.database.path), right = dump(older.database.path);
    expect(Object.keys(left)).toEqual(Object.keys(right));
    for (const table of Object.keys(left)) expect(left[table], table).toEqual(right[table]);
    expect(left.samples.length).toBeGreaterThan(0);
    expect(left.events.length).toBeGreaterThan(0);
    expect(left.trips.length).toBeGreaterThan(0);
    // The ACKs written to the pipes are the same too, apart from the minor of their envelope.
    expect(withBreak.run.acks.map(a => [a.connection, a.through, a.coverage])).toEqual(older.run.acks.map(a => [a.connection, a.through, a.coverage]));
    // No stored value names the break: no column, no JSON field.
    const text = JSON.stringify(left, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
    expect(text).not.toMatch(/[Bb]reak|mandatory/);
  }, 120_000);

  it('stores the hand-written one-second sample rows and the same trips as a run that never lists the break', async () => {
    const withBreak = await record(withBreaks('break-samples'), 'samples'), absent = await record(Object.assign(base(), {id: 'break-absent'}), 'absent');
    const reader = (run: {database: {path: string; backups: string}}) => ({database: run.database.path, open: () => ws.open({path: run.database.path, backupsDirectory: run.database.backups})});
    const seed = base().seed;
    // The scenario's hand-written rows are the minor-2 run's rows, whether the break changes in every frame or is never listed.
    expect(await storedSamples(reader(withBreak), seed, withBreak.session)).toEqual(expected.samples);
    expect(await storedSamples(reader(absent), seed, absent.session)).toEqual(expected.samples);
    const rows = await storedRows(reader(withBreak), seed);
    expect(rows).toEqual(await storedRows(reader(absent), seed));
    expect(rows.trips.length).toBeGreaterThan(0);
    // The history invariants hold over the stored rows and every ACK written (I1-I5).
    const written = withBreak.run.acks.map(ack => ({pluginSessionId: withBreak.session, throughEventSeq: ack.through.toString()}));
    const violations = checkHistoryInvariants(readHistoryRows(withBreak.database.path), written);
    expect(violations, formatViolations(violations)).toEqual([]);
    // Both runs are minor 2; one lists a different break in every frame, the other never calls the channel back (not-observed).
    // Their databases hold the same rows, so the break's value, changes and absence store nothing.
    expect(dump(withBreak.database.path)).toEqual(dump(absent.database.path));
  }, 120_000);
});
