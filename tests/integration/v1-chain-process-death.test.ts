import type {ChildProcess, ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterEach, expect, it, vi} from 'vitest';
import {NativeClientError, NativePipeClient, type BrokerDiagnostic} from '../../apps/desktop/src/native-pipe-client';
import {V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ServerMessage, type SourceIdentity} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';

// ET-019 PR-8: processes of the E14 controlled chain end mid-session (REG-003, REG-011). The tests-only fake SDK host
// (named eurotrucks2.exe) loads the test plugin DLL with its v1 directory seam, the real broker runs in its v1 mode, and
// the service side is the production NativePipeClient with the ET-002b V1Consumer, or the production V1Ingestion.
// Processes are ended with TerminateProcess at reported barriers, never on a timer. Every expectation is written by hand
// from docs/telemetry-service-v0.md (native broker control, current state and recovery), docs/telemetry-service-v1.md
// (E9), docs/native-transport-boundary-v0.md (discovery), docs/native-transport-v1.md (store rules, endpoint) and
// docs/protocol/v1.md (§7, §9, §10). The test DLL marks its source synthetic, so V1Ingestion with a game selection fails
// closed at every welcome (E14); the in-session reactions are therefore observed on the broker client. Synthetic only:
// no game, game directory, user history or registry key is touched.
const root = path.resolve(import.meta.dirname, '../..');
const artifacts = {
  host: path.join(root, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'),
  dll: path.join(root, 'native/telemetry-plugin/build/Release/snapshot-transport-test-plugin.dll'),
  broker: path.join(root, 'native/telemetry-client/build/Release/telemetry-pipe-client.exe')
};

// Hang guards only: no case asserts a duration, and every wait ends at a reported barrier or state.
/** The fake host's ready line and its v1 discovery record. */
const HOST_READY_GUARD_MS = 10_000;
/** A connection reaching its checkpoint, including retries while the plugin's single pipe instance is still busy. */
const CONNECT_GUARD_MS = 15_000;
/** Events, snapshots, ACK releases and process exits after a barrier. */
const DELIVERY_GUARD_MS = 10_000;
/** V1Ingestion's waiting brokers and the reconnection that reaches the new host: 250 + 500 + 1,000 + 2,000 + 4,000 ms of backoff. */
const RECONNECT_GUARD_MS = 30_000;
/**
 * E9 reconnection delays, written by hand from docs/telemetry-service-v1.md: 250, 500, 1000, 2000, then 4000 ms. They
 * are checked as lower bounds only; a loaded host can only lengthen them.
 */
const DOCUMENTED_BACKOFF_MS = [250, 500, 1000, 2000, 4000];
/** Node may fire a timer up to about a millisecond before performance.now() shows its full delay. */
const TIMER_EARLY_ALLOWANCE_MS = 5;
/** The six eventLoss keys with zero counts (§7). */
const NO_LOSS = {offline: '0', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'};
const DISCOVERY_RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;

// Records the broker processes the production client spawns, so a test can end one with TerminateProcess. The spawn
// itself is unchanged.
const spawned = vi.hoisted(() => ({children: [] as Array<{file: string; child: ChildProcess}>}));
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const spawn = ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawned.children.push({file: String(args[0]), child});
    return child;
  }) as typeof actual.spawn;
  return {...actual, spawn};
});
const {spawn} = await import('node:child_process');

/** The pid of the broker process the client constructed last; the constructor spawns synchronously. */
function lastBrokerPid(): number {
  const last = spawned.children.at(-1);
  if (!last || path.resolve(last.file) !== path.resolve(artifacts.broker) || last.child.pid === undefined) throw new Error('broker spawn not recorded');
  return last.child.pid;
}
/** TerminateProcess: Node's process.kill on Windows ends the process with exit code 1 and runs none of its own code. */
function terminate(pid: number): void { process.kill(pid); }

async function until(predicate: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await new Promise(r => setTimeout(r, 25)); } return predicate(); }

interface Host {child: ChildProcessWithoutNullStreams; processId: number; output: string; exit?: {code: number | null; signal: NodeJS.Signals | null}}
const hosts: Host[] = [];
const clients: NativePipeClient[] = [];
let ingestion: V1Ingestion | undefined, directory: string | undefined;
afterEach(async () => {
  await ingestion?.stop(); ingestion = undefined;
  for (const client of clients.splice(0)) { client.destroy(); await client.completion; }
  for (const host of hosts.splice(0)) {
    if (host.child.exitCode !== null || host.child.signalCode !== null) continue;
    host.child.stdin.end('exit\n'); await until(() => host.exit !== undefined, 5_000);
    if (!host.exit) { host.child.kill(); await until(() => host.exit !== undefined, 5_000); }
  }
  if (directory) await rm(directory, {recursive: true, force: true});
  directory = undefined; spawned.children.length = 0;
});

async function workspace() {
  directory = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-v1-death-'));
  const transport = path.join(directory, 'transport');
  return {v0: path.join(transport, 'v0'), v1: path.join(transport, 'v1')};
}
const records = (v1: string) => existsSync(v1) ? readdirSync(v1).filter(name => DISCOVERY_RECORD.test(name)).sort() : [];

/** Starts the fake SDK host; its ready line names its process and its v1 endpoint. */
async function startHost(v0: string, v1: string): Promise<Host> {
  const before = records(v1);
  const child = spawn(artifacts.host, ['host', artifacts.dll, v0, v1], {stdio: 'pipe', windowsHide: true});
  const host: Host = {child, processId: 0, output: ''};
  hosts.push(host);
  child.stdout.on('data', (chunk: Buffer) => { host.output += chunk.toString('utf8'); }); child.stderr.on('data', () => {});
  child.once('exit', (code, signal) => { host.exit = {code, signal}; });
  expect(await until(() => host.output.includes('"ready":true') || host.exit !== undefined, HOST_READY_GUARD_MS), 'fake SDK host ready').toBe(true);
  const ready = JSON.parse(host.output.split('\n')[0]) as {processId: number; v1Endpoint: string};
  expect(ready.v1Endpoint).toContain('\\\\.\\pipe\\ETS2Telemetry-ets2-v1-');
  host.processId = ready.processId;
  expect(await until(() => records(v1).length > before.length, HOST_READY_GUARD_MS), 'v1 discovery record').toBe(true);
  return host;
}
/** Sends host commands and waits for each one's phase line, printed after its SDK callback returned. */
async function command(host: Host, ...actions: string[]) {
  // The host writes its lines through a text-mode stdout, so each ends in CRLF.
  const phases = (action: string) => host.output.split(/\r?\n/).filter(line => line === `{"phase":"${action}"}`).length;
  const expected = new Map(actions.map(action => [action, phases(action) + actions.filter(other => other === action).length]));
  host.child.stdin.write(actions.map(action => `${action}\n`).join(''));
  expect(await until(() => [...expected].every(([action, count]) => phases(action) >= count), DELIVERY_GUARD_MS), `host phases ${actions.join(',')}`).toBe(true);
}

type Coverage = {kind: 'event'; eventSeq: string; type: string; redelivered: boolean} | {kind: 'gap'; first: string; last: string; causes: Record<string, string>; redelivered: boolean};
/** A test-level client over the production broker client and the ET-002b consumer, durable or live-only. */
class Driver {
  readonly client: NativePipeClient;
  readonly pid: number;
  readonly messages: ServerMessage[] = [];
  readonly errors: unknown[] = [];
  readonly diagnostics: BrokerDiagnostic[] = [];
  readonly consumer: V1Consumer;
  readonly decoder = new FrameDecoder('server');
  connected = false; ended = false; closed = false;
  constructor(v1: string, readonly durable: boolean) {
    this.consumer = new V1Consumer(durable);
    this.client = new NativePipeClient({executable: artifacts.broker, discoveryDirectory: v1}, 'ets2', diagnostic => this.diagnostics.push(diagnostic), 'v1');
    this.pid = lastBrokerPid();
    clients.push(this.client);
    this.client.on('connect', () => {
      this.connected = true;
      this.client.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents: durable}}));
    });
    this.client.on('data', (bytes: Uint8Array) => {
      try { this.decoder.push(bytes, decoded => { const message = decoded as ServerMessage; this.consumer.accept(message); this.messages.push(message); }); }
      catch (error) { this.errors.push(error); this.client.destroy(); }
    });
    this.client.on('error', error => this.errors.push(error));
    this.client.on('end', () => { this.ended = true; });
    this.client.on('close', () => { this.closed = true; });
  }
  get welcome() { const first = this.messages[0]; if (first?.kind !== 'welcome') throw new Error('welcome expected first'); return first; }
  get checkpoint() { const found = this.messages.find(message => message.kind === 'checkpoint'); if (found?.kind !== 'checkpoint') throw new Error('checkpoint expected'); return found; }
  get coverage(): Coverage[] {
    return this.messages.flatMap((message): Coverage[] => message.kind === 'event' ? [{kind: 'event', eventSeq: message.data.eventSeq, type: message.data.record.type, redelivered: message.data.redelivered}]
      : message.kind === 'gap' ? [{kind: 'gap', first: message.data.firstEventSeq, last: message.data.lastEventSeq, causes: {...message.data.causes}, redelivered: message.data.redelivered}] : []);
  }
  /** The latest checkpoint or snapshot status. */
  get status() {
    for (let index = this.messages.length - 1; index >= 0; index--) { const message = this.messages[index]; if (message.kind === 'checkpoint' || message.kind === 'snapshot') return message.data.status; }
    throw new Error('no status yet');
  }
  ack(throughEventSeq: bigint) {
    this.client.write(encodeFrame({version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: this.welcome.source.pluginSessionId, throughEventSeq: throughEventSeq.toString()}}));
  }
  async stop() { this.client.destroy(); await this.client.completion; }
}
/**
 * Connects a new broker and waits for its checkpoint. While the plugin has not yet returned its single pipe instance to
 * listening, the broker cannot open it and exits 3 before any receipt; such an attempt is retried, as the service retries
 * a disconnected source (E9). Any other outcome fails.
 */
async function connect(v1: string, durable: boolean): Promise<Driver> {
  const end = Date.now() + CONNECT_GUARD_MS;
  for (;;) {
    const driver = new Driver(v1, durable);
    await until(() => driver.messages.some(message => message.kind === 'checkpoint') || driver.closed || driver.errors.length > 0, Math.max(0, end - Date.now()));
    if (driver.messages.some(message => message.kind === 'checkpoint')) return driver;
    const retry = !driver.connected && (driver.errors.length === 0 ? driver.ended : driver.errors.every(error => error instanceof NativeClientError && error.transient));
    await driver.stop();
    if (!retry || Date.now() >= end) throw new Error(`broker connection failed: ${JSON.stringify({connected: driver.connected, ended: driver.ended, errors: driver.errors.map(String), diagnostics: driver.diagnostics})}`);
  }
}
async function events(driver: Driver, count: number) {
  expect(await until(() => driver.coverage.filter(item => item.kind === 'event').length >= count || driver.errors.length > 0 || driver.closed, DELIVERY_GUARD_MS), `${count} events`).toBe(true);
  expect(driver.errors).toEqual([]);
}
/** Waits for a checkpoint or snapshot received at index `from` or later whose status satisfies the predicate. */
async function statusUntil(driver: Driver, predicate: (status: Driver['status']) => boolean, what: string, from = 0) {
  expect(await until(() => driver.messages.slice(from).some(message => (message.kind === 'snapshot' || message.kind === 'checkpoint') && predicate(message.data.status)) || driver.errors.length > 0, DELIVERY_GUARD_MS), what).toBe(true);
  expect(driver.errors).toEqual([]);
}
/**
 * A broker ended by TerminateProcess after its authority receipt (telemetry-service-v0.md, native broker control: any
 * exit other than 0 and 3 after a receipt is a rejection, and "Exit 1, receipt/relay violations and protocol or identity
 * failures remain final incompatible states"; E9: "other broker rejections" are `incompatible` without a reconnection).
 * A frame cut by the kill is the client's incomplete-frame rejection, equally final. The broker wrote no diagnostic line.
 */
function expectKilledBroker(driver: Driver) {
  expect(driver.errors).toHaveLength(1);
  const error = driver.errors[0];
  expect(error).toBeInstanceOf(NativeClientError);
  const failure = error as NativeClientError;
  expect(failure.transient).toBe(false);
  expect(['rejected', 'incomplete-frame']).toContain(failure.outcome);
  expect(driver.diagnostics).toEqual([expect.objectContaining({outcome: failure.outcome, exitCode: 1, stage: 'unreported', win32Error: null, slowStage: 'unreported'})]);
  expect(driver.ended).toBe(false);
  expect(driver.messages.some(message => message.kind === 'end')).toBe(false);
}
const identity = (source: SourceIdentity) => ({pluginSessionId: source.pluginSessionId, processInstanceId: source.processInstanceId, processId: source.processId});

it('ends the broker mid-session: the client reports a final rejection, and a fresh broker resumes the same plugin session with its retained events redelivered and its live-only losses counted (REG-003, REG-011)', async () => {
  for (const [name, file] of Object.entries(artifacts)) expect(existsSync(file), `${name} artifact missing: build the native plugin and client first`).toBe(true);
  const {v0, v1} = await workspace();
  const host = await startHost(v0, v1);

  // A durable test-level driver: the plugin's offline coverage before it (the host's initial `started` callback, gate
  // `none`) is acknowledged, so the store retains only what follows.
  const first = await connect(v1, true);
  expect(first.welcome.data.durableEvents).toBe(true);
  expect(first.welcome.source).toMatchObject({game: 'ets2', origin: 'synthetic', processId: host.processId});
  expect(first.welcome.source).toEqual({...first.client.authority, origin: 'synthetic'});
  const baseline = BigInt(first.checkpoint.data.status.delivery.nextEventSeq);
  expect(first.checkpoint.data.status.delivery.ackedThroughEventSeq).toBe('0');
  expect(await until(() => BigInt(first.consumer.nextEventSeq) >= baseline || first.errors.length > 0, DELIVERY_GUARD_MS), 'baseline coverage').toBe(true);
  expect(first.coverage.every(item => item.kind === 'gap' && !item.redelivered)).toBe(true);
  if (baseline > 1n) {
    first.ack(baseline - 1n);
    await statusUntil(first, status => status.delivery.ackedThroughEventSeq === (baseline - 1n).toString() && status.delivery.retainedEvents === 0, 'baseline released');
  }
  const acked = (baseline - 1n).toString();

  // Barrier: both lifecycle events were delivered and the store retains them unacknowledged; then the broker is killed.
  const beforeEvents = first.messages.length;
  await command(host, 'pause', 'start');
  await events(first, 2);
  const delivered = first.coverage.filter(item => item.kind === 'event');
  expect(delivered).toEqual([
    {kind: 'event', eventSeq: baseline.toString(), type: 'simulation.paused', redelivered: false},
    {kind: 'event', eventSeq: (baseline + 1n).toString(), type: 'simulation.started', redelivered: false}
  ]);
  await statusUntil(first, status => status.delivery.retainedEvents === 2, 'two retained events', beforeEvents);
  terminate(first.pid);
  expect(await until(() => first.closed, DELIVERY_GUARD_MS), 'killed broker closed').toBe(true);
  expectKilledBroker(first);
  expect(host.exit).toBeUndefined();

  // A live-only broker (the production E2 shape, D9) finds the same plugin session. The ACK persists across connections
  // (§7), the two events stay retained, and a live-only connection never carries an event or gap (§4, native endpoint).
  const live = await connect(v1, false);
  expect(live.welcome.source).toEqual(first.welcome.source);
  expect(live.welcome.data.durableEvents).toBe(false);
  expect(live.checkpoint.data.status.delivery).toMatchObject({durable: false, ackedThroughEventSeq: acked, nextEventSeq: (baseline + 2n).toString(), retainedEvents: 2});
  const lostBefore = BigInt(live.checkpoint.data.status.eventLoss.noDurableConsumer);
  // An event observed while only a live-only client is connected is noDurableConsumer coverage (OD-4).
  await command(host, 'pause');
  await statusUntil(live, status => status.delivery.nextEventSeq === (baseline + 3n).toString(), 'the live-only loss stored');
  expect(BigInt(live.status.eventLoss.noDurableConsumer)).toBe(lostBefore + 1n);
  expect(live.coverage).toEqual([]);
  const pausedState = live.status;
  terminate(live.pid);
  expect(await until(() => live.closed, DELIVERY_GUARD_MS), 'killed live-only broker closed').toBe(true);
  expectKilledBroker(live);

  // The live state recovers on a new live-only connection: the same session, hydrated from its checkpoint (the paused
  // simulation), followed by live snapshots; the loss counters never decrease (§7, I7).
  const recovered = await connect(v1, false);
  expect(recovered.welcome.source).toEqual(first.welcome.source);
  expect(recovered.checkpoint.data.state.simulation).toBe('paused');
  expect(recovered.checkpoint.data.status.eventLoss).toEqual(pausedState.eventLoss);
  expect(await until(() => recovered.messages.some(message => message.kind === 'snapshot') || recovered.errors.length > 0, DELIVERY_GUARD_MS), 'live snapshots after the checkpoint').toBe(true);
  expect(recovered.errors).toEqual([]); expect(recovered.coverage).toEqual([]);
  await recovered.stop();
  // Owner cancellation is not a failure and is not logged.
  expect([recovered.errors, recovered.diagnostics]).toEqual([[], []]);

  // A durable reconnection inside the retention window redelivers the retained entries from A + 1 in order: the two events
  // marked redelivered, then the live-only loss as a gap that no earlier connection received (§9, I5, I6). Nothing in
  // [A + 1, N) is missing or invented, and the ACK releases everything.
  const resumed = await connect(v1, true);
  expect(resumed.welcome.source).toEqual(first.welcome.source);
  expect(resumed.checkpoint.data.status.delivery).toMatchObject({durable: true, ackedThroughEventSeq: acked, nextEventSeq: (baseline + 3n).toString(), retainedEvents: 3});
  expect(await until(() => resumed.coverage.length >= 3 || resumed.errors.length > 0, DELIVERY_GUARD_MS), 'redelivery').toBe(true);
  expect(resumed.errors).toEqual([]);
  expect(resumed.coverage).toEqual([
    {kind: 'event', eventSeq: baseline.toString(), type: 'simulation.paused', redelivered: true},
    {kind: 'event', eventSeq: (baseline + 1n).toString(), type: 'simulation.started', redelivered: true},
    {kind: 'gap', first: (baseline + 2n).toString(), last: (baseline + 2n).toString(), causes: {...NO_LOSS, noDurableConsumer: '1'}, redelivered: false}
  ]);
  resumed.ack(baseline + 2n);
  await statusUntil(resumed, status => status.delivery.ackedThroughEventSeq === (baseline + 2n).toString(), 'redelivered entries released');
  expect(resumed.status.delivery).toMatchObject({retainedEvents: 0, retainedBytes: 0, nextEventSeq: (baseline + 3n).toString()});
  await resumed.stop();
  expect([resumed.errors, resumed.diagnostics]).toEqual([[], []]);

  host.child.stdin.end('exit\n');
  expect(await until(() => host.exit !== undefined, DELIVERY_GUARD_MS)).toBe(true);
  expect(host.exit).toEqual({code: 0, signal: null});
  console.log(JSON.stringify({case: 'broker-killed', baseline: baseline.toString(), brokers: spawned.children.filter(entry => path.resolve(entry.file) === path.resolve(artifacts.broker)).length}));
});

it('ends the fake game host mid-session: the source ends, the service waits on the documented backoff, and a new host is a new plugin session that inherits nothing; a clean exit sends end instead (REG-003, REG-011)', async () => {
  for (const [name, file] of Object.entries(artifacts)) expect(existsSync(file), `${name} artifact missing: build the native plugin and client first`).toBe(true);
  const {v0, v1} = await workspace();
  const killed = await startHost(v0, v1);
  const durable = await connect(v1, true);
  const old = durable.welcome.source;
  expect(old).toMatchObject({origin: 'synthetic', processId: killed.processId});
  const beforeEvents = durable.messages.length;
  await command(killed, 'pause', 'start');
  await events(durable, 2);
  await statusUntil(durable, status => status.delivery.retainedEvents >= 2, 'retained events', beforeEvents);
  const oldRecord = `${old.processInstanceId}.json`;
  expect(records(v1)).toEqual([oldRecord]);

  // TerminateProcess on the host: its plugin runs no shutdown, so no `end` is written (§9: plugin exit loses the retained
  // unacknowledged events). The broker sees the source disconnect and exits 3, which the client reports as a plain end,
  // not an error (telemetry-service-v0.md: "Source disconnect/cancellation exits 3"; E9: EOF or close is `disconnected`
  // and reconnects). Nothing partial is left in the decoder.
  terminate(killed.processId);
  expect(await until(() => killed.exit !== undefined && durable.closed, DELIVERY_GUARD_MS), 'host and broker ended').toBe(true);
  expect(killed.exit).toEqual({code: 1, signal: null});
  expect(durable.errors).toEqual([]);
  expect(durable.ended).toBe(true);
  expect(durable.messages.some(message => message.kind === 'end')).toBe(false);
  expect(() => durable.decoder.end()).not.toThrow();
  expect(durable.diagnostics).toEqual([expect.objectContaining({outcome: 'ended', exitCode: 3})]);
  // The killed plugin could not remove its discovery record; only the still-owned record is cleaned up at exit.
  expect(records(v1)).toEqual([oldRecord]);

  // The production V1Ingestion selects the game. The broker ignores the record of the exited process and reports waiting
  // (exit 2), so the source is `waiting` and reconnects on the E9 backoff after each broker has exited
  // (native-transport-boundary-v0.md: records of an exited process are ignored and the client reports waiting).
  const brokers: Array<{spawnedAt: number; waitingAt?: number; authority?: SourceIdentity}> = [];
  const states: V1SourceState[] = [];
  ingestion = new V1Ingestion({
    connectGame: (configuration, game) => {
      const socket = new NativePipeClient(configuration, game, undefined, 'v1');
      const entry: (typeof brokers)[number] = {spawnedAt: performance.now()};
      brokers.push(entry); clients.push(socket);
      socket.on('waiting', () => { entry.waitingAt = performance.now(); });
      socket.on('connect', () => { entry.authority = socket.authority; });
      return socket;
    },
    broker: {executable: artifacts.broker, discoveryDirectory: v1}, onState: state => states.push(state)
  });
  ingestion.select('ets2');
  expect(await until(() => brokers.filter(entry => entry.waitingAt !== undefined).length >= 3, RECONNECT_GUARD_MS), 'three waiting brokers').toBe(true);
  expect(ingestion.current).toMatchObject({status: 'waiting', reason: 'No selected game discovery record', fresh: false, durable: {state: 'off'}});
  expect(ingestion.current.observation).toBeUndefined();

  // A new host is a new plugin session in a new process (§9: a new pluginSessionId restarts eventSeq at 1).
  const restarted = await startHost(v0, v1);
  expect(await until(() => ingestion!.current.status === 'incompatible', RECONNECT_GUARD_MS), 'a later broker reaches the new host').toBe(true);
  const reached = brokers.filter(entry => entry.authority !== undefined);
  expect(reached).toHaveLength(1);
  expect(brokers.at(-1)).toBe(reached[0]);
  const fresh = reached[0].authority!;
  expect(fresh).toMatchObject({game: 'ets2', origin: 'game', processId: restarted.processId});
  expect(fresh.pluginSessionId).not.toBe(old.pluginSessionId);
  expect(fresh.processInstanceId).not.toBe(old.processInstanceId);
  // Every earlier broker ended waiting, and each reconnection came no sooner than its documented delay after it.
  expect(brokers.slice(0, -1).every(entry => entry.waitingAt !== undefined)).toBe(true);
  const delays = brokers.slice(1).map((entry, index) => entry.spawnedAt - brokers[index].waitingAt!);
  delays.forEach((delay, index) => expect(delay, `reconnection ${index + 1}`).toBeGreaterThanOrEqual(DOCUMENTED_BACKOFF_MS[Math.min(index, DOCUMENTED_BACKOFF_MS.length - 1)] - TIMER_EARLY_ALLOWANCE_MS));
  // The synthetic origin under game authority fails closed as in E14, and no state of either session was applied.
  expect(ingestion.current).toMatchObject({status: 'incompatible', reason: 'Invalid protocol, ordering or selected source identity', fresh: false});
  expect(ingestion.current.observation).toBeUndefined();
  expect(states.some(state => state.status === 'connected' || state.status === 'paused' || state.status === 'stale' || state.observation !== undefined)).toBe(false);
  await ingestion.stop(); ingestion = undefined;
  const incompatibleBrokers = brokers.length;

  // A durable driver on the new host: every message names the new session, its coverage starts again at eventSeq 1, and
  // nothing is redelivered. The killed session's retained events (the plugin's memory) are gone with its process.
  const next = await connect(v1, true);
  expect(next.welcome.source).toEqual({...fresh, origin: 'synthetic'});
  expect(identity(next.welcome.source)).not.toEqual(identity(old));
  expect(next.checkpoint.data.status.delivery).toMatchObject({durable: true, ackedThroughEventSeq: '0'});
  const nextBaseline = BigInt(next.checkpoint.data.status.delivery.nextEventSeq);
  await command(restarted, 'pause');
  await events(next, 1);
  expect(next.messages.every(message => message.source.pluginSessionId === fresh.pluginSessionId)).toBe(true);
  const coverage = next.coverage;
  expect(coverage[0]).toMatchObject(coverage[0].kind === 'gap' ? {first: '1'} : {eventSeq: '1'});
  expect(coverage.every(item => !item.redelivered)).toBe(true);
  expect(coverage.filter(item => item.kind === 'event')).toEqual([{kind: 'event', eventSeq: nextBaseline.toString(), type: 'simulation.paused', redelivered: false}]);
  await statusUntil(next, status => status.delivery.retainedEvents >= 1 && status.delivery.nextEventSeq === (nextBaseline + 1n).toString(), 'the new event retained');
  expect(records(v1)).toEqual([oldRecord, `${fresh.processInstanceId}.json`].sort());

  // Optional comparison: the clean exit runs the SDK shutdown, so the plugin writes `end` with plugin-shutdown, its
  // cursor and the one retained unacknowledged event (§9, I8), then the broker exits 3. The host exits 0 and removes its
  // own discovery record; the killed host's record stays, because the client never deletes records.
  restarted.child.stdin.end('exit\n');
  expect(await until(() => restarted.exit !== undefined && next.closed, DELIVERY_GUARD_MS), 'clean exit').toBe(true);
  expect(restarted.exit).toEqual({code: 0, signal: null});
  const ends = next.messages.filter(message => message.kind === 'end');
  expect(ends.map(message => message.data)).toEqual([{reason: 'plugin-shutdown', nextEventSeq: (nextBaseline + 1n).toString(), ackedThroughEventSeq: '0', retainedUnacked: '1'}]);
  expect(next.messages.at(-1)?.kind).toBe('end');
  expect([next.errors, next.ended]).toEqual([[], true]);
  expect(next.diagnostics).toEqual([expect.objectContaining({outcome: 'ended', exitCode: 3})]);
  expect(records(v1)).toEqual([oldRecord]);
  console.log(JSON.stringify({case: 'host-killed', reconnections: incompatibleBrokers - 1, delaysMs: delays.map(delay => Math.round(delay))}));
});
