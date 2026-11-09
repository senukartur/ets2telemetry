// ET-052 D4 (REG-003, REG-005, REG-009, REG-014): the next mandatory break is live only. A protocol v1 minor-2 source whose
// break changes in every frame (soon, due, zero, negative, overdue) is recorded by the real pipeline (the reactive v1
// simulator on actual Windows pipes, V1Ingestion, the trip recorder and the real storage worker into a temporary
// synthetic-purpose database) into exactly the rows the same source records at minor 1, which carries no break: every
// table of the two databases is equal except the stored `protocol_minor` (2 against 1), the wall-clock bookkeeping stamps and
// the database identity, and the hand-written sample rows of tests/fixtures/recording/one-second-samples.rows.expected.json
// are the minor-2 run's rows. Nothing is added to
// samples, trips, events, gaps or attributions for the break, and a break that changes does not change a sample, a trip,
// a completeness interval or an ACK. The existing recording, journal and export suites are unchanged by this proof.
// ET-071 applies the same proof to the cruise control set speed of minor 3: a source whose cruise control changes in every
// frame (off, set speeds, the bound, out of range, not observed, invalid) records exactly the rows of the same source at
// minor 2, which carries no cruise control. Since ET-071 the simulator serves minor 3 by default, so the minor-2 runs of
// the ET-052 cases name `highestMinor` 2.
// ET-084 applies the same proof to the navigation speed limit of minor 4: a source whose limit changes in every frame (limits,
// no limit as zero and negative, the bounds, out of range, not observed, invalid) records exactly the rows of the same source
// at minor 3, which carries no limit, apart from the stored protocol minor. Since ET-084 the simulator serves minor 4 by
// default, so the ET-071 cases name their highest minor.
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

/** Cruise control readings by frame in m/s: off, set speeds, the bound, out of range (invalid), not observed and invalid. */
const CRUISE = [0, 25, 22.5, 0, 1000, 0.5, -1, 1000.5, null, 'invalid', 30.5, 0];

/** Speed limit readings by frame in m/s: limits, no limit (zero and negative), the bounds, out of range (invalid), not observed and invalid. */
const LIMITS = [25, 13.75, 0, -1, 1000, -1000, 22.5, 1000.5, -1000.5, null, 'invalid', 29.5];

/** The scenario with a different break in every frame; `highestMinor` models an older plugin (minor 1 or 2). */
function withBreaks(id: string, highestMinor?: 1 | 2): Json & {seed: string} {
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
/** The scenario with a different cruise control reading in every frame; `highestMinor` 2 models a plugin from before ET-071 and 3 one from before ET-084. */
function withCruise(id: string, highestMinor?: 2 | 3): Json & {seed: string} {
  const scenario = base();
  let index = 0;
  for (const step of scenario.steps) {
    if (step.action !== 'frame') continue;
    step.channels = {...(step.channels as Json | undefined), 'cruise_control': CRUISE[index++ % CRUISE.length]};
  }
  scenario.id = id;
  if (highestMinor !== undefined) scenario.source = {...scenario.source, highestMinor};
  return scenario;
}

/** The scenario with a different speed limit in every frame; `highestMinor` 3 models a plugin from before ET-084. */
function withLimits(id: string, highestMinor?: 3): Json & {seed: string} {
  const scenario = base();
  let index = 0;
  for (const step of scenario.steps) {
    if (step.action !== 'frame') continue;
    step.channels = {...(step.channels as Json | undefined), 'navigation.speed.limit': LIMITS[index++ % LIMITS.length]};
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
      .map(row => Object.fromEntries(Object.entries(row).filter(([column]) => !NOT_RECORDED.has(column))
        .map(([column, value]) => [column, table === 'logical_projection_states' && column === 'row_json'
          ? Object.fromEntries(Object.entries(JSON.parse(value as string) as Json).filter(([key]) => !NOT_RECORDED.has(key))) : value])))]));
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
    const withBreak = await record(withBreaks('break-minor-2', 2), 'minor2');
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
    // Both runs are minor 4; one lists a different break in every frame, the other never calls the channel back (not-observed).
    // Their databases hold the same rows, so the break's value, changes and absence store nothing.
    expect(dump(withBreak.database.path)).toEqual(dump(absent.database.path));
  }, 120_000);
});

describe('ET-071: the cruise control set speed is never recorded', () => {
  it('records a changing minor-3 cruise control into exactly the rows a minor-2 plugin gives, and stores protocol minor 3', async () => {
    const withReading = await record(withCruise('cruise-minor-3', 3), 'minor3');
    const older = await record(withCruise('cruise-minor-2', 2), 'minor2');
    expect(minors(withReading.database.path)).toEqual({sessions: [3], events: [3]});
    expect(minors(older.database.path)).toEqual({sessions: [2], events: [2]});
    const left = dump(withReading.database.path), right = dump(older.database.path);
    expect(Object.keys(left)).toEqual(Object.keys(right));
    for (const table of Object.keys(left)) expect(left[table], table).toEqual(right[table]);
    expect(left.samples.length).toBeGreaterThan(0);
    expect(left.events.length).toBeGreaterThan(0);
    expect(left.trips.length).toBeGreaterThan(0);
    expect(withReading.run.acks.map(a => [a.connection, a.through, a.coverage])).toEqual(older.run.acks.map(a => [a.connection, a.through, a.coverage]));
    // No stored value names cruise control: no column, no JSON field.
    const text = JSON.stringify(left, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
    expect(text).not.toMatch(/[Cc]ruise/);
    // The hand-written one-second sample rows are this run's rows too.
    const reader = {database: withReading.database.path, open: () => ws.open({path: withReading.database.path, backupsDirectory: withReading.database.backups})};
    expect(await storedSamples(reader, base().seed, withReading.session)).toEqual(expected.samples);
  }, 120_000);
});

describe('ET-084: the navigation speed limit is never recorded', () => {
  it('records a changing minor-4 speed limit into exactly the rows a minor-3 plugin gives, and stores protocol minor 4', async () => {
    const withReading = await record(withLimits('limit-minor-4'), 'minor4');
    const older = await record(withLimits('limit-minor-3', 3), 'minor3');
    expect(minors(withReading.database.path)).toEqual({sessions: [4], events: [4]});
    expect(minors(older.database.path)).toEqual({sessions: [3], events: [3]});
    const left = dump(withReading.database.path), right = dump(older.database.path);
    expect(Object.keys(left)).toEqual(Object.keys(right));
    for (const table of Object.keys(left)) expect(left[table], table).toEqual(right[table]);
    expect(left.samples.length).toBeGreaterThan(0);
    expect(left.events.length).toBeGreaterThan(0);
    expect(left.trips.length).toBeGreaterThan(0);
    expect(withReading.run.acks.map(a => [a.connection, a.through, a.coverage])).toEqual(older.run.acks.map(a => [a.connection, a.through, a.coverage]));
    // No stored value names the speed limit: no column, no JSON field.
    const text = JSON.stringify(left, (_key, v: unknown) => typeof v === 'bigint' ? v.toString() : v);
    expect(text).not.toMatch(/[Ss]peed.?[Ll]imit/);
    // The hand-written one-second sample rows are this run's rows too.
    const reader = {database: withReading.database.path, open: () => ws.open({path: withReading.database.path, backupsDirectory: withReading.database.backups})};
    expect(await storedSamples(reader, base().seed, withReading.session)).toEqual(expected.samples);
  }, 120_000);
});
