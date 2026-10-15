// REG-006 at the process boundary for protocol v1 ingestion (ET-006b): a telemetry-service process running V1Ingestion
// with the real storage worker is terminated with TerminateProcess at a commit barrier, then a new process on the same
// database continues against the same reactive simulator over actual pipes. Barriers are counted in commits, never in
// elapsed time: "before commit X" and "committed X, before its ACK". Expected rows and ACKs are written by hand from
// crash-before-commit.expected.json and crash-after-commit.expected.json.
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {ClientMessage} from '../../packages/contracts/src/protocol-v1';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {reactiveConflicts, reactiveDifferences, serveV1Reactive, type ReactiveReport} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, scenarioSource} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath} from '../shared/simulator-v1-expected';
import {ok, readOnly, workspace} from './helpers';

/** Liveness bound for a child line; never a measured duration. */
const CHILD_LIVENESS_MS = 20_000;
const CHILD = path.resolve('tests/storage/fixtures/v1-ingestion-child.cjs');
if (!process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES) throw new Error('Storage test bundles are missing; run npm run test:storage.');

let ws: Awaited<ReturnType<typeof workspace>>;
beforeEach(async () => { ws = await workspace(); });
afterEach(async () => { await ws.dispose(); });

type Barrier = {kind: 'before' | 'after'; eventSeq: string} | null;
/** One service process. `until` resolves at the first stdout line that matches; stderr must stay empty. */
function service(endpoint: string, barrier: Barrier, name: string) {
  const config = path.join(ws.directory, `${name}.json`);
  writeFileSync(config, JSON.stringify({endpoint, barrier, open: {path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: '0.1.0-test'}}));
  const child = spawn(process.execPath, [CHILD, config], {env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  // 'close' follows the exit and the end of both pipes, so every line written before the kill has been read.
  const closed = once(child, 'close');
  const lines: string[] = [], waiters: {match: (line: string) => boolean; resolve: () => void}[] = [];
  let stdout = '', stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    const parts = stdout.split('\n'); stdout = parts.pop() ?? '';
    for (const line of parts.map(p => p.trim())) {
      lines.push(line);
      for (const w of waiters.splice(0)) if (w.match(line)) w.resolve(); else waiters.push(w);
    }
  });
  // A liveness bound only: a cooperative child reaches each line within milliseconds; on failure the lines are reported.
  const until = (match: (line: string) => boolean) => lines.some(match) ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${name}: expected line not reached; stdout ${JSON.stringify(lines)}; stderr ${JSON.stringify(stderr)}`)), CHILD_LIVENESS_MS);
    waiters.push({match, resolve: () => { clearTimeout(timer); resolve(); }});
  });
  // TerminateProcess on Windows: no exit handlers, no SQLite close, no checkpoint.
  let terminated = false;
  const terminate = async () => { if (!terminated) { terminated = true; child.kill(); } await closed; expect(stderr).toBe(''); };
  return {lines, until, terminate, acks: () => lines.filter(l => l.startsWith('ack ')).map(l => l.slice(4))};
}

async function crash(id: string, barrier: NonNullable<Barrier>) {
  const input = readFixtureFile(scenarioPath(id)) as Record<string, unknown>, replay = replayV1(input);
  expect(reactiveConflicts(input)).toEqual([]);
  const server = await serveV1Reactive(input, {scale: 0}), children: ReturnType<typeof service>[] = [];
  try {
    const first = service(server.endpoint, barrier, 'first'); children.push(first);
    await first.until(line => line.startsWith('barrier '));
    await first.terminate();
    const second = service(server.endpoint, null, 'second'); children.push(second);
    // The second connection ends at its scripted disconnect; the process is then terminated before it reconnects.
    await second.until(line => line === 'disconnected');
    await second.terminate();
    const report = await server.done;
    return {replay, report, first, second};
  } finally {
    // No child outlives its test, whatever failed.
    await Promise.all(children.map(c => c.terminate().catch(() => undefined)));
    await server.stop();
  }
}
const served = (report: ReactiveReport, connection: number) => report.transcript.filter(l => l.connection === connection && l.direction === 'client' && l.message.kind === 'ack')
  .map(l => (l.message as Extract<ClientMessage, {kind: 'ack'}>).data.throughEventSeq);
async function reopened(session: string) {
  const storage = await ws.open();
  const through = ok(storage.committedThrough(session)), events = ok(storage.listEvents(session)).map(e => `${e.eventSeq} ${e.type}`);
  storage.close();
  return readOnly(ws.database, db => ({
    through, events,
    gaps: (db.prepare('SELECT first_event_seq AS f, last_event_seq AS l FROM event_gaps ORDER BY id').all() as {f: string; l: string}[]).map(g => `${BigInt(g.f)}-${BigInt(g.l)}`),
    integrity: db.pragma('integrity_check', {simple: true}), foreignKeys: db.prepare('PRAGMA foreign_key_check').all()
  }));
}

describe('REG-006 killed ingestion process', () => {
  it('terminated before committing eventSeq 2 sends no ACK for it; a new process commits it after redelivery', async () => {
    const {replay, report, first, second} = await crash('crash-before-commit', {kind: 'before', eventSeq: '2'});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(first.lines.filter(l => !l.startsWith('ready'))).toEqual(['committed 1 1', 'ack 1', 'barrier before 2']);
    expect([served(report, 1), served(report, 2), second.acks()]).toEqual([['1'], ['2', '3'], ['2', '3']]);
    const db = await reopened(scenarioSource(replay.scenario).pluginSessionId);
    expect(db).toEqual({through: '3', events: ['1 job.configured', '2 simulation.started'], gaps: ['3-3'], integrity: 'ok', foreignKeys: []});
    // Coverage is never behind an ACK either process handed to the pipe.
    for (const ack of [...first.acks(), ...second.acks()]) expect(BigInt(db.through)).toBeGreaterThanOrEqual(BigInt(ack));
  }, 60_000);

  it('terminated after committing eventSeq 2 but before its ACK keeps the commit; the redelivery is a duplicate', async () => {
    const {replay, report, first, second} = await crash('crash-after-commit', {kind: 'after', eventSeq: '2'});
    expect(reactiveDifferences(replay, report)).toEqual([]);
    expect(first.lines.filter(l => !l.startsWith('ready'))).toEqual(['committed 1 1', 'ack 1', 'committed 2 2', 'barrier after 2']);
    // The second process's cursor starts from storage (C = 2) and acknowledges the duplicate once it is redelivered.
    expect([served(report, 1), served(report, 2), second.lines.filter(l => l.startsWith('committed') || l.startsWith('ack'))]).toEqual([['1'], ['2'], ['committed 2 2', 'ack 2']]);
    const db = await reopened(scenarioSource(replay.scenario).pluginSessionId);
    expect(db).toEqual({through: '2', events: ['1 job.configured', '2 simulation.started'], gaps: [], integrity: 'ok', foreignKeys: []});
    for (const ack of [...first.acks(), ...second.acks()]) expect(BigInt(db.through)).toBeGreaterThanOrEqual(BigInt(ack));
  }, 60_000);
});
