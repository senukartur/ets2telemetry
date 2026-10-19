import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtempSync, rmSync} from 'node:fs';
import {builtinModules} from 'node:module';
import net from 'node:net';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {PROTOCOL_V1, encodeFrame} from '../../packages/contracts/src/protocol-v1';
import {reactiveConflicts, serveV1Reactive, type ReactiveReport} from '../../tools/telemetry-simulator/src/v1/reactive';
import {MAX_TRANSCRIPT_MESSAGES, replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {sourceStep, transportStep, validateScenario} from '../../tools/telemetry-simulator/src/v1/scenario';
import {runSoakClient, serveV1Soak, soakEntries, soakMinutes, soakRawSteps, soakScenario, type SoakClientResult, type SoakRawStep} from '../../tools/telemetry-simulator/src/v1/soak';

// ET-019 PR-12a: the soak source of the protocol v1 simulator (docs/simulator-v1.md#soak-source-et-019-pr-12a). Every
// expectation below is written by hand from the schedule table in that section, never produced by the generator.
type Json = Record<string, unknown>;

/** Hand-written schedule, in time order, without frames: [atMs, step]. */
const CYCLE_0: [number, string][] = [
  [25, 'configuration job'], [5_025, 'gameplay player.tollgate.paid'], [20_025, 'lifecycle simulation.paused'], [30_025, 'lifecycle simulation.started'],
  [45_025, 'gameplay job.delivered'], [45_525, 'configuration job cleared']];
const START: [number, string][] = [[0, 'connect'], [25, 'lifecycle simulation.started'], [25, 'configuration truck'], [25, 'configuration trailer.0']];
const PLAN_M1: [number, string][] = [...START, ...CYCLE_0];
const PLAN_M3: [number, string][] = [...PLAN_M1,
  [60_025, 'configuration job'], [65_025, 'gameplay player.tollgate.paid'], [80_025, 'lifecycle simulation.paused'], [90_025, 'lifecycle simulation.started'],
  [95_025, 'disconnect'], [98_025, 'connect'], [105_025, 'gameplay job.delivered'], [105_525, 'configuration job cleared'],
  [120_025, 'configuration job'], [125_025, 'gameplay player.tollgate.paid'], [140_025, 'lifecycle simulation.paused'], [150_025, 'lifecycle simulation.started'],
  [165_025, 'gameplay job.cancelled'], [165_525, 'configuration job cleared']];
/** The record types of eventSeq 1..9 of one cycle, in order. */
const EVENTS_M1 = ['simulation.started', 'truck.configured', 'trailer.configured', 'job.configured', 'player.tollgate.paid', 'simulation.paused', 'simulation.started', 'job.delivered', 'job.cleared'];

function label(step: Json): string {
  const action = step.action as string;
  if (action === 'lifecycle') return `lifecycle ${step.event as string}`;
  if (action === 'configuration' || action === 'gameplay') return `${action} ${step.id as string}${(step.attributes as unknown[]).length ? '' : ' cleared'}`;
  return action;
}
function plan(minutes: number): {steps: [number, string][]; frames: number[]} {
  const steps: [number, string][] = [], frames: number[] = [];
  for (const {step} of soakRawSteps(minutes)) {
    if (step.action === 'frame') frames.push(step.atMs as number); else steps.push([step.atMs as number, label(step)]);
  }
  return {steps, frames};
}
/** One scenario from soak steps: the frames kept only every `frameEveryMs`, all other steps unchanged. */
function reduced(minutes: number, frameEveryMs: number): Json {
  const steps: Json[] = [], transport: Json[] = [];
  for (const {lane, step} of soakRawSteps(minutes)) {
    if (step.action === 'frame' && (step.atMs as number) % frameEveryMs !== 0) continue;
    (lane === 'source' ? steps : transport).push(step);
  }
  return {...soakScenario(), steps, transport};
}
async function served(minutes: number, scale: number, before?: (endpoint: string) => Promise<void>): Promise<{report: ReactiveReport; client: SoakClientResult}> {
  const server = await serveV1Soak(minutes, {scale}), abort = new AbortController();
  try {
    await before?.(server.endpoint);
    const client = runSoakClient(server.endpoint, abort.signal);
    client.catch(() => undefined);
    const report = await server.done.finally(() => abort.abort());
    return {report, client: await client};
  } finally { abort.abort(); await server.stop(); }
}
/** A raw client that sends one live-only hello and resolves with the bytes it received before the server closed it. */
function liveOnlyHello(endpoint: string): Promise<number> {
  return new Promise(resolve => {
    const socket = net.connect(endpoint); let bytes = 0;
    socket.on('error', () => undefined);
    socket.on('connect', () => socket.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents: false}})));
    socket.on('data', (c: Buffer) => { bytes += c.length; });
    socket.on('close', () => resolve(bytes));
  });
}
async function until(check: () => boolean, ms = 20_000): Promise<void> {
  const start = performance.now();
  while (!check()) { if (performance.now() - start > ms) throw new Error('Condition deadline'); await new Promise(r => setTimeout(r, 5)); }
}
/**
 * Bounds CPU work, not behaviour timing: an unpaced run serves every frame of the schedule through a real pipe, one
 * write and flush at a time (7,200 frames for one minute, 20,400 for twelve).
 */
const UNPACED_ONE_MINUTE_BUDGET_MS = 60_000;
const UNPACED_TWELVE_MINUTES_BUDGET_MS = 120_000;
/** Bounds the one-time Vite build of the CLI, not behaviour timing. */
const CLI_BUILD_BUDGET_MS = 60_000;

describe('simulator v1 soak schedule', () => {
  it('generates the hand-written plan for one minute', () => {
    const {steps, frames} = plan(1);
    expect(steps).toEqual(PLAN_M1);
    // A frame every 50 ms from 0 through 60 s plus the 300 s tail.
    expect(frames).toHaveLength(7_200);
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(359_950);
    expect(frames.every((at, i) => at === i * 50)).toBe(true);
  });

  it('generates the hand-written plan for three minutes: a reconnect in cycle 1, a cancellation in cycle 2', () => {
    const {steps, frames} = plan(3);
    expect(steps).toEqual(PLAN_M3);
    // Steps per cycle other than frames: 6, 8 with the reconnect, 6.
    const cycle = (k: number) => steps.filter(([at, s]) => at >= k * 60_000 && at < (k + 1) * 60_000 && !(k === 0 && at <= 25 && s !== 'configuration job')).length;
    expect([cycle(0), cycle(1), cycle(2)]).toEqual([6, 8, 6]);
    expect(frames).toHaveLength(9_600);
    expect(frames.at(-1)).toBe(479_950);
  });

  it('orders the frame at 0 before the connect at 0, and keeps every other step off the 50 ms frame grid', () => {
    const first = [...soakRawSteps(1)].slice(0, 7).map(({lane, step}: SoakRawStep) => [lane, step.action, step.atMs]);
    expect(first).toEqual([['source', 'frame', 0], ['transport', 'connect', 0], ['source', 'lifecycle', 25], ['source', 'configuration', 25], ['source', 'configuration', 25],
      ['source', 'configuration', 25], ['source', 'frame', 50]]);
    expect(plan(3).steps.filter(([at]) => at !== 0).every(([at]) => at % 50 === 25)).toBe(true);
  });

  it('derives float32-exact frame values from the frame index', () => {
    const frames = new Map([...soakRawSteps(1)].filter(s => s.step.action === 'frame').map(s => [s.step.atMs as number, s.step.channels]));
    expect(frames.get(0)).toEqual({speed: 19.53125, 'fuel.amount': 400, odometer: 1_000, 'game.time': 480});
    // n = 60: fuel 400 - 60/4,096, odometer 1,000 + 60/1,024 km, one game minute later.
    expect(frames.get(3_000)).toEqual({speed: 19.53125, 'fuel.amount': 399.9853515625, odometer: 1_000.05859375, 'game.time': 481});
    // n = 7,199: 7,199/4,096 = 1.757568359375 L used, 7,199/1,024 = 7.0302734375 km, ⌊7,199/60⌋ = 119 minutes.
    expect(frames.get(359_950)).toEqual({speed: 19.53125, 'fuel.amount': 398.242431640625, odometer: 1_007.0302734375, 'game.time': 599});
  });

  it('passes every step of a two-minute run through the per-step validators', () => {
    const source = validateScenario(soakScenario()).source;
    let count = 0, connects = 0;
    for (const {lane, step} of soakRawSteps(2)) {
      if (lane === 'source') sourceStep(step, `$.steps[${count}]`, source);
      else if (transportStep(step, `$.transport[${count}]`, false).action === 'connect') connects++;
      count++;
    }
    // 8,400 frames, 4 start steps, 6 + 8 cycle steps.
    expect(count).toBe(8_418);
    expect(connects).toBe(2);
    const entries = [...soakEntries(2)];
    expect(entries).toHaveLength(8_418);
    expect(entries.filter(e => e.lane === 'transport').map(e => e.lane === 'transport' && [e.atMs, e.step.action, e.connection])).toEqual([[0, 'connect', 1], [95_025, 'disconnect', 1], [98_025, 'connect', 2]]);
  });

  it('keeps the transport steps of twelve minutes valid as one scenario: one client at a time', () => {
    const transport = [...soakRawSteps(12)].filter(s => s.lane === 'transport').map(s => s.step);
    expect(transport.map(s => [s.atMs, s.action])).toEqual([[0, 'connect'], [95_025, 'disconnect'], [98_025, 'connect'], [695_025, 'disconnect'], [698_025, 'connect']]);
    expect(() => validateScenario({...soakScenario(), transport})).not.toThrow();
  });

  it('accepts 1 to 90 whole minutes only', () => {
    expect(soakMinutes(1)).toBe(1);
    expect(soakMinutes(90)).toBe(90);
    for (const bad of [0, 91, 1.5, '30', Number.NaN]) expect(() => soakMinutes(bad)).toThrow(/integer 1\.\.90/);
    expect(() => soakRawSteps(0).next()).toThrow(/integer 1\.\.90/);
  });

  it('has no reactive conflict and replays to the hand-written events on reduced-frame cycles with the same events and ACK policy', () => {
    // One frame per second instead of twenty: the same events, connects and ACK policy, within the 1,000-step bound.
    for (const minutes of [1, 2]) expect(reactiveConflicts(reduced(minutes, 1_000))).toEqual([]);
    const replay = replayV1(reduced(1, 1_000)), events = replay.transcript.flatMap(l => l.direction === 'server' && l.message.kind === 'event' ? [l.message.data] : []);
    expect(events.map(e => e.eventSeq)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
    expect(events.map(e => e.record.type)).toEqual(EVENTS_M1);
    expect(replay.transcript.some(l => l.message.kind === 'gap')).toBe(false);
    expect(replay.ledger).toEqual({committedThroughEventSeq: '9', committedEvents: 9, committedGapMarkers: '0', duplicates: 0});
    // Cycle 1 reconnects without redelivery: everything was acknowledged before the disconnect.
    const two = replayV1(reduced(2, 1_000));
    expect(two.connections.map(c => c.closedBy)).toEqual(['disconnect', 'open']);
    expect(two.transcript.some(l => l.message.kind === 'event' && l.message.data.redelivered)).toBe(false);
    expect(two.ledger).toEqual({committedThroughEventSeq: '15', committedEvents: 15, committedGapMarkers: '0', duplicates: 0});
  });
});

describe('simulator v1 soak serving', () => {
  it('serves one minute unpaced to the soak client: eventSeq 1..9 once each, all acknowledged, counters only', async () => {
    const {report, client} = await served(1, 0);
    expect(report.cancelled).toBe(false);
    expect(report.transcript).toEqual([]);
    expect(report.connections).toHaveLength(1);
    expect(report.connections[0]).toMatchObject({connection: 1, durable: true, closedBy: 'open', rejectedAttempts: 0});
    // Recorded from the hello without a transcript: the soak client's own random instance.
    expect(report.connections[0].clientInstanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const s = report.soak!;
    expect(s.lastEventSeq).toBe('9');
    expect(s.maxAckThroughEventSeq).toBe('9');
    expect(s.ackCount).toBe(9);
    expect(s.refusedLiveOnly).toBe(0);
    // Frames 50 ms through 359,950 ms each write one snapshot; the state of the frame at 0 is in the checkpoint.
    expect(s.snapshots).toBe(7_199);
    expect(s.messages.server).toEqual({welcome: 1, checkpoint: 1, event: 9, snapshot: 7_199});
    expect(s.messages.client).toEqual({hello: 1, ack: 9});
    expect(s.scenarioMs).toBe(359_950);
    expect(client.welcomed).toBe(1);
    expect(client.acks).toBe(9);
    expect(client.ledger).toEqual({committedThroughEventSeq: '9', committedEvents: 9, committedGapMarkers: '0', duplicates: 0});
  }, UNPACED_ONE_MINUTE_BUDGET_MS);

  it('keeps no transcript: twelve minutes write more messages than a transcript may hold', async () => {
    // A retained transcript would fail this run at its 20,000-message limit.
    const {report, client} = await served(12, 0);
    const s = report.soak!, server = Object.values(s.messages.server).reduce((a, b) => a + b, 0);
    expect(report.cancelled).toBe(false);
    expect(report.transcript).toEqual([]);
    expect(server).toBeGreaterThan(MAX_TRANSCRIPT_MESSAGES);
    // 3 + 6 × 12 events, three cancellations among them (cycles 2, 6, 10); reconnects in cycles 1 and 11.
    expect([s.lastEventSeq, s.maxAckThroughEventSeq, s.messages.server.event, s.messages.server.gap]).toEqual(['75', '75', 75, undefined]);
    expect(report.connections.map(c => c.closedBy)).toEqual(['disconnect', 'disconnect', 'open']);
    expect(client.welcomed).toBe(3);
    expect(client.ledger).toEqual({committedThroughEventSeq: '75', committedEvents: 75, committedGapMarkers: '0', duplicates: 0});
  }, UNPACED_TWELVE_MINUTES_BUDGET_MS);

  it('refuses and counts a live-only hello for its durable connection, then serves the durable client', async () => {
    let bytes = -1;
    const {report, client} = await served(1, 0, async endpoint => { bytes = await liveOnlyHello(endpoint); });
    expect(bytes).toBe(0);
    expect(report.soak!.refusedLiveOnly).toBe(1);
    expect(report.connections.map(c => [c.closedBy, c.rejectedAttempts])).toEqual([['open', 0]]);
    expect(report.soak!.lastEventSeq).toBe('9');
    expect(client.ledger.committedEvents).toBe(9);
  }, UNPACED_ONE_MINUTE_BUDGET_MS);

  it('ends with a cancelled report and `end` when stopped while paced', async () => {
    const server = await serveV1Soak(1), abort = new AbortController();
    try {
      const client = runSoakClient(server.endpoint, abort.signal);
      client.catch(() => undefined);
      await until(() => server.status().snapshots >= 10);
      await server.stop();
      const report = await server.done;
      abort.abort();
      await client;
      expect(report.cancelled).toBe(true);
      expect(report.transcript).toEqual([]);
      expect(report.connections.map(c => c.closedBy)).toEqual(['end']);
      expect(report.soak!.messages.server.end).toBe(1);
      // The start events at 25 ms were written before the tenth snapshot at 500 ms.
      expect(BigInt(report.soak!.lastEventSeq)).toBeGreaterThanOrEqual(4n);
    } finally { abort.abort(); await server.stop(); }
  }, 30_000);

  it('rejects soak entries beside scenario steps', async () => {
    await expect(serveV1Reactive({...soakScenario(), transport: [{atMs: 0, action: 'connect', client: {durable: true}}]}, {soak: {entries: soakEntries(1)}}))
      .rejects.toThrow(/generated entries only/);
  });
});

describe('simulator v1 soak CLI', () => {
  let directory = '', cli = '';
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'ETS2Telemetry-SYNTHETIC-TEST-v1-soak-cli-'));
    const {build} = await import('vite'), bundle = join(directory, 'bundle');
    await build({configFile: false, logLevel: 'silent', build: {outDir: bundle, emptyOutDir: true, lib: {entry: resolve('tools/telemetry-simulator/src/cli.ts'), formats: ['cjs'], fileName: () => 'cli.cjs'},
      rollupOptions: {external: [...builtinModules, ...builtinModules.map(x => `node:${x}`)]}}});
    cli = join(bundle, 'cli.cjs');
  }, CLI_BUILD_BUDGET_MS);
  afterAll(() => { if (directory) rmSync(directory, {recursive: true, force: true}); });

  it('stops serve-v1-soak on a `stop` line and prints a cancelled summary', async () => {
    const child = spawn(process.execPath, [cli, 'serve-v1-soak', '--minutes', '1'], {windowsHide: true});
    let stdout = '', stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    const exited = new Promise<number | null>(r => child.on('close', code => r(code)));
    await until(() => stdout.includes('\n'));
    const serving = JSON.parse(stdout.split('\n')[0]) as Json;
    expect(serving).toMatchObject({type: 'serving', origin: 'synthetic', mode: 'soak', minutes: 1, history: false});
    child.stdin.write('stop\n');
    expect(await exited).toBe(0);
    const lines = stdout.trim().split('\n').map(l => JSON.parse(l) as Json);
    // Stopped while its first scripted connection was still waiting for a client: no hello, nothing written.
    expect(lines.at(-1)).toMatchObject({type: 'summary', mode: 'soak', cancelled: true, connections: 1, lastEventSeq: '0', snapshots: 0, history: false,
      sessions: [{connection: 1, durable: true, clientInstanceId: '', closedBy: 'open', rejectedAttempts: 0}]});
    expect(stderr).toBe('');
  }, 30_000);

  it('refuses soak lengths outside 1..90 minutes', async () => {
    for (const args of [['serve-v1-soak', '--minutes', '0'], ['smoke-soak-v1', '--minutes', '91'], ['smoke-soak-v1', '--minutes', '1.5'], ['serve-v1-soak'], ['smoke-soak-v1', '--minutes', '3', 'x']]) {
      const result = await new Promise<{code: number | null; stderr: string}>(r => {
        const child = spawn(process.execPath, [cli, ...args], {windowsHide: true}); let stderr = '';
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
        child.on('close', code => r({code, stderr}));
      });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/--minutes <1-90>/);
    }
  }, 30_000);
});
