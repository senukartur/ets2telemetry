// Bounded-memory soak source for the protocol v1 simulator (ET-019 PR-12a). A v1 scenario holds at most 1,000 steps and a
// run at most 20,000 transcript messages, while 30 minutes of frames at 20 Hz are 36,000 steps. `serveV1Soak` therefore
// serves a generated timeline in the reactive server's soak mode (ReactiveSoakOptions): one plugin session, ETS2, seed
// `soak-v1`, a frame every 50 ms, one job cycle per minute, then a trip-free tail. Every step is built as scenario JSON
// and checked by the per-step validators of scenario.ts before it is served; nothing keeps the steps or the messages.
// The schedule is documented in docs/simulator-v1.md#soak-source-et-019-pr-12a, and the tests hand-write it instead of
// calling this generator. Synthetic only: it opens no database and writes no file.
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {type DurableAckCursor} from '../../../../packages/contracts/src/protocol-v1-delivery';
import {CommitLedger, ScriptedClient, type ClientPolicy} from './client';
import {TEST_PIPE_PATTERN_V1, bounded} from './pipe-host';
import {serveV1Reactive, type ReactivePipeServer, type ReactiveReport, type SoakStatus} from './reactive';
import {scenarioSource} from './replay';
import {SCENARIO_FORMAT, sourceStep, transportStep, validateScenario, type TimelineEntry} from './scenario';

export const SOAK_SCENARIO_ID = 'soak-v1';
export const SOAK_SEED = 'soak-v1';
export const SOAK_MIN_MINUTES = 1;
export const SOAK_MAX_MINUTES = 90;
export const SOAK_CYCLE_MS = 60_000;
export const SOAK_FRAME_MS = 50;
export const SOAK_TAIL_MS = 300_000;
/** The session start: the client connects at 0, then simulation.started and the truck and trailer.0 configuration at 25 ms. */
export const SOAK_START_MS = 25;
/**
 * Offsets inside cycle k, which starts at k × 60,000 ms. Lifecycle, gameplay, configuration and transport steps sit on
 * 25 ms offsets, between two frames, so none of them shares a millisecond with a frame or a second boundary.
 */
export const SOAK_OFFSETS = {jobConfigured: 25, tollgate: 5_025, paused: 20_025, started: 30_025, disconnect: 35_025, reconnect: 38_025, jobEnded: 45_025, jobCleared: 45_525} as const;
/** Cycle k disconnects and reconnects when k % 10 === 1, and cancels its job instead of delivering it when k % 4 === 2. */
export const SOAK_RECONNECT_CYCLE = {every: 10, at: 1} as const;
export const SOAK_CANCEL_CYCLE = {every: 4, at: 2} as const;
/** The client reconnects this long after its connection closed. */
export const SOAK_RECONNECT_DELAY_MS = 250;
/** How long the soak's scripted connects wait for a client (the reactive server's `connectTimeoutMs`). */
export const SOAK_CONNECT_TIMEOUT_MS = 60_000;

/** Validates a soak length in whole minutes, 1 to 90. */
export function soakMinutes(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < SOAK_MIN_MINUTES || value > SOAK_MAX_MINUTES) throw new Error(`Soak minutes must be an integer ${SOAK_MIN_MINUTES}..${SOAK_MAX_MINUTES}`);
  return value;
}

const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
/** The scenario header of the soak: its identity and source, with no steps (they come from `soakEntries`). */
export function soakScenario(): Record<string, unknown> {
  return {format: SCENARIO_FORMAT, schemaVersion: 1, id: SOAK_SCENARIO_ID,
    purpose: 'ET-019 soak source: one ETS2 plugin session with 20 Hz frames and one job cycle per minute (toll, pause, delivery or cancellation, a reconnect every tenth cycle), then a trip-free tail.',
    reg: ['REG-010', 'REG-011', 'REG-018'], origin: 'synthetic', game: 'ets2', seed: SOAK_SEED, provenance: null, source: structuredClone(SOURCE), steps: [], transport: []};
}

const text = (name: string, value: string) => ({name, sdkType: 'string', value});
const TRUCK = [text('brand_id', 'synthetic_brand'), text('id', 'vehicle.synthetic_truck'), {name: 'fuel.capacity', sdkType: 'float', value: 800}];
const TRAILER = [text('id', 'trailer.synthetic_box'), text('body.type', 'dryvan')];
const JOB = [text('cargo.id', 'synthetic_cargo'), text('source.city.id', 'synthetic_city_a'), text('destination.city.id', 'synthetic_city_b'),
  {name: 'planned_distance.km', sdkType: 'u32', value: 152}, {name: 'income', sdkType: 'u64', value: '12345'}, {name: 'cargo.loaded', sdkType: 'bool', value: true}];
const TOLL = [{name: 'pay.amount', sdkType: 's64', value: '150'}];
const DELIVERED = [{name: 'revenue', sdkType: 's64', value: '12000'}, {name: 'earned.xp', sdkType: 's32', value: 250}, {name: 'cargo.damage', sdkType: 'float', value: 0.03125},
  {name: 'distance.km', sdkType: 'float', value: 152.5}, {name: 'delivery.time', sdkType: 'u32', value: 300}, {name: 'auto.park.used', sdkType: 'bool', value: false},
  {name: 'auto.load.used', sdkType: 'bool', value: false}];
const CANCELLED = [{name: 'cancel.penalty', sdkType: 's64', value: '1000'}];
const CLIENT = {durable: true, commit: 'each', ack: 'each'};

/** One generated step in scenario JSON form, before validation. */
export interface SoakRawStep {lane: 'source' | 'transport'; step: Record<string, unknown>}
/**
 * The frame at `atMs`, a multiple of 50 ms: values derived from the frame index n = atMs / 50 only, all float32-exact
 * (speed 19.53125 m/s, fuel 400 − n/4,096 L, odometer 1,000 + n/1,024 km, game time 480 + ⌊n/60⌋ min).
 */
export function soakFrame(atMs: number): Record<string, unknown> {
  const n = atMs / SOAK_FRAME_MS;
  return {atMs, action: 'frame', channels: {speed: 19.53125, 'fuel.amount': 400 - n / 4_096, odometer: 1_000 + n / 1_024, 'game.time': 480 + Math.floor(n / 60)}};
}
/** Every step but the frames, in time order. */
function* soakEvents(minutes: number): Generator<SoakRawStep> {
  const source = (step: Record<string, unknown>): SoakRawStep => ({lane: 'source', step});
  yield {lane: 'transport', step: {atMs: 0, action: 'connect', client: {...CLIENT}}};
  yield source({atMs: SOAK_START_MS, action: 'lifecycle', event: 'simulation.started'});
  yield source({atMs: SOAK_START_MS, action: 'configuration', id: 'truck', attributes: structuredClone(TRUCK)});
  yield source({atMs: SOAK_START_MS, action: 'configuration', id: 'trailer.0', attributes: structuredClone(TRAILER)});
  for (let k = 0; k < minutes; k++) {
    const b = k * SOAK_CYCLE_MS, o = SOAK_OFFSETS;
    yield source({atMs: b + o.jobConfigured, action: 'configuration', id: 'job', attributes: structuredClone(JOB)});
    yield source({atMs: b + o.tollgate, action: 'gameplay', id: 'player.tollgate.paid', attributes: structuredClone(TOLL)});
    yield source({atMs: b + o.paused, action: 'lifecycle', event: 'simulation.paused'});
    yield source({atMs: b + o.started, action: 'lifecycle', event: 'simulation.started'});
    if (k % SOAK_RECONNECT_CYCLE.every === SOAK_RECONNECT_CYCLE.at) {
      yield {lane: 'transport', step: {atMs: b + o.disconnect, action: 'disconnect'}};
      yield {lane: 'transport', step: {atMs: b + o.reconnect, action: 'connect', client: {...CLIENT}}};
    }
    yield k % SOAK_CANCEL_CYCLE.every === SOAK_CANCEL_CYCLE.at
      ? source({atMs: b + o.jobEnded, action: 'gameplay', id: 'job.cancelled', attributes: structuredClone(CANCELLED)})
      : source({atMs: b + o.jobEnded, action: 'gameplay', id: 'job.delivered', attributes: structuredClone(DELIVERED)});
    yield source({atMs: b + o.jobCleared, action: 'configuration', id: 'job', attributes: []});
  }
}
/**
 * The whole soak timeline in scenario JSON form, generated lazily in time order: a frame every 50 ms from 0 until
 * minutes × 60 s + 300 s, merged with the cycle steps. At one time a frame (a source step) precedes a transport step,
 * as in every scenario (`timeline` in scenario.ts).
 */
export function* soakRawSteps(minutes: number): Generator<SoakRawStep> {
  const m = soakMinutes(minutes), end = m * SOAK_CYCLE_MS + SOAK_TAIL_MS;
  let frameAt = 0;
  for (const e of soakEvents(m)) {
    const at = e.step.atMs as number;
    for (; frameAt < end && (frameAt < at || (frameAt === at && e.lane === 'transport')); frameAt += SOAK_FRAME_MS) yield {lane: 'source', step: soakFrame(frameAt)};
    yield e;
  }
  for (; frameAt < end; frameAt += SOAK_FRAME_MS) yield {lane: 'source', step: soakFrame(frameAt)};
}
/** The soak timeline as reactive entries: each step through the per-step validator, connections numbered from 1. */
export function* soakEntries(minutes: number): Generator<TimelineEntry> {
  const source = validateScenario(soakScenario()).source;
  let connection = 0, index = 0;
  for (const {lane, step} of soakRawSteps(minutes)) {
    const path = `$.soak[${index++}]`;
    if (lane === 'source') { const s = sourceStep(step, path, source); yield {atMs: s.atMs, lane, step: s}; continue; }
    const s = transportStep(step, path, false);
    if (s.action === 'connect') connection++;
    yield {atMs: s.atMs, lane, step: s, connection};
  }
}

/** A soak server; `status` reads its counters while it serves. */
export type SoakPipeServer = ReactivePipeServer & {status: () => SoakStatus};
/**
 * Serves the soak timeline on a new synthetic endpoint in the reactive server's soak mode. Scripted connections commit
 * and acknowledge each item, so `awaitScriptedAcks` holds the server at each action until the client acknowledged
 * everything written to it: a missing ACK fails the run within the 30 s settle bound, which makes it a hang detector.
 */
export async function serveV1Soak(minutes: number, options: {scale?: number; signal?: AbortSignal} = {}): Promise<SoakPipeServer> {
  soakMinutes(minutes);
  const server = await serveV1Reactive(soakScenario(), {scale: options.scale, signal: options.signal, awaitScriptedAcks: true, connectTimeoutMs: SOAK_CONNECT_TIMEOUT_MS,
    soak: {entries: soakEntries(minutes)}});
  const status = server.status;
  if (!status) throw new Error('Soak server without status');
  return {...server, status};
}

export interface SoakClientResult {
  attempts: number; welcomed: number; acks: number;
  ledger: {committedThroughEventSeq: string; committedEvents: number; committedGapMarkers: string; duplicates: number};
}
const CLIENT_POLICY: ClientPolicy = {durable: true, commit: {kind: 'each'}, ack: {kind: 'each'}};
/**
 * A minimal durable consumer for the soak source: one ScriptedClient per connection (commit and ACK each, the ET-002b
 * helpers and the in-memory ledger), one client instance for the whole run, reconnecting 250 ms after each close until
 * `signal` aborts. It keeps no message: ScriptedClient lists every applied message in `received`, which is emptied after
 * each read, so memory does not grow with the frames. The ledger keeps one row per committed event, which the schedule
 * bounds (3 + 6 per minute).
 */
export async function runSoakClient(endpoint: string, signal: AbortSignal, options: {reconnectDelayMs?: number} = {}): Promise<SoakClientResult> {
  if (!TEST_PIPE_PATTERN_V1.test(endpoint)) throw new Error('Private synthetic v1 endpoint required');
  const delay = bounded(options.reconnectDelayMs, SOAK_RECONNECT_DELAY_MS, 0, 10_000, 'reconnect delay');
  const ledger = new CommitLedger(), cursors = new Map<string, DurableAckCursor>(), instance = randomUUID();
  let attempts = 0, welcomed = 0, acks = 0;
  const connectOnce = () => new Promise<void>((resolve, reject) => {
    attempts++;
    const socket = net.connect(endpoint), client = new ScriptedClient(ledger, CLIENT_POLICY, instance, randomUUID(), cursors);
    let welcome = false, failed = false;
    const abort = () => socket.destroy();
    signal.addEventListener('abort', abort, {once: true});
    const fail = (error: unknown) => { failed = true; socket.destroy(); reject(error instanceof Error ? error : new Error('Soak client failed')); };
    socket.on('error', () => undefined);
    socket.on('connect', () => { for (const f of client.hello().frames) socket.write(f); });
    socket.on('data', (chunk: Buffer) => {
      if (failed) return;
      let out;
      try { out = client.receive(chunk, () => process.hrtime.bigint()); } catch (error) { fail(error); return; }
      if (!welcome && client.received.some(m => m.kind === 'welcome')) { welcome = true; welcomed++; }
      client.received.length = 0;
      for (const f of out.frames) socket.write(f);
      acks += out.frames.length;
    });
    socket.on('close', () => {
      signal.removeEventListener('abort', abort);
      if (failed) return;
      // A frame cut by the server's close is a violation; one cut by this client's own abort is not.
      if (!signal.aborted) try { client.end(); } catch (error) { fail(error); return; }
      resolve();
    });
  });
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, delay);
    signal.addEventListener('abort', done, {once: true});
  });
  while (!signal.aborted) { await connectOnce(); if (!signal.aborted) await pause(); }
  const through = ledger.through(scenarioSource({game: 'ets2', seed: SOAK_SEED}).pluginSessionId);
  return {attempts, welcomed, acks, ledger: {committedThroughEventSeq: through.toString(), committedEvents: ledger.committedEvents, committedGapMarkers: ledger.committedGapMarkers.toString(), duplicates: ledger.duplicates}};
}

/**
 * The totals a soak run of `minutes` must reach, in closed form from the schedule table (docs/simulator-v1.md): 3 start
 * events plus 6 per cycle, all committed and acknowledged once, no gap, and one connection plus one per reconnect cycle.
 */
export function soakTotals(minutes: number): {events: number; connections: number} {
  const m = soakMinutes(minutes);
  return {events: 3 + 6 * m, connections: 1 + Math.floor((m + 8) / 10)};
}
/** Why a soak run stopped in its tail differs from its totals and planned connection closes, or an empty list. */
export function soakDifferences(minutes: number, report: ReactiveReport, client: SoakClientResult): string[] {
  const t = soakTotals(minutes), s = report.soak, out: string[] = [];
  if (!s) return ['no soak counters'];
  const check = (name: string, actual: unknown, expected: unknown) => { if (actual !== expected) out.push(`${name} ${String(actual)}, expected ${String(expected)}`); };
  check('last eventSeq', s.lastEventSeq, String(t.events));
  check('server events', s.messages.server.event ?? 0, t.events);
  check('gaps', s.messages.server.gap ?? 0, 0);
  check('ACK through', s.maxAckThroughEventSeq, String(t.events));
  check('connections', s.connections, t.connections);
  check('live-only refusals', s.refusedLiveOnly, 0);
  check('welcomed client connections', client.welcomed, t.connections);
  check('committed through', client.ledger.committedThroughEventSeq, String(t.events));
  check('committed events', client.ledger.committedEvents, t.events);
  check('duplicates', client.ledger.duplicates, 0);
  check('transcript lines', report.transcript.length, 0);
  // Every connection but the last ends at its scripted disconnect and the last at the stop's `end`; a connection ended
  // otherwise (a write deadline, a client close) before a scripted disconnect would leave every total above unchanged.
  const closes = report.connections.map(c => c.closedBy).join(','), expectedCloses = [...Array<string>(t.connections - 1).fill('disconnect'), 'end'].join(',');
  check('connection closes', closes, expectedCloses);
  check('end messages', s.messages.server.end ?? 0, 1);
  return out;
}
