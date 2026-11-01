import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {NativePipeClient, type BrokerDiagnostic} from '../../apps/desktop/src/native-pipe-client';
import {V1_CLIENT_MAX_MINOR, V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type GearboxState, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {nativeTreeIdentity} from '../shared/native-tree-channel';

// ET-006b E14 controlled chain: the tests-only fake SDK host (named eurotrucks2.exe) loads the isolated test plugin DLL
// with its v1 directory seam -> the plugin's protocol v1 endpoint -> the fixed native broker in its v1 mode -> TypeScript.
// It proves that the plugin accepts the policy the broker provisions, that a client ACK relayed through the broker
// releases retained entries, and that V1Ingestion with a game selection fails closed on the test DLL's fixed synthetic
// origin under game authority. Production sends no ACK (E2); the ACK here comes from a test-level durable driver.
// ET-050b, ET-052: the driver offers minor 2 as the service does; the plugin selects it, the host's `gearbox` command sends
// the CAP-01 12-speed hshifter layout and a 12F/4R truck, and the broker relays the driver's {1,2} ACKs and clock probe.
// The host's frames never call the optional `mandatory.break` channel back, so the minor-2 state carries it not-observed.
// Later live-only drivers that offer only minor 1 (a service from ET-050b) or minor 0 (before it) get the original minor-1
// bytes (the gearbox, no break) and the original minor-0 bytes (neither).
// Synthetic only: no game, game directory or user history is touched.
const root = path.resolve(import.meta.dirname, '../..');
const artifacts = {
  host: path.join(root, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'),
  dll: path.join(root, 'native/telemetry-plugin/build/Release/snapshot-transport-test-plugin.dll'),
  broker: path.join(root, 'native/telemetry-client/build/Release/telemetry-pipe-client.exe')
};
const DISCOVERY_RECORD = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
let host: ChildProcessWithoutNullStreams | undefined, directory: string | undefined;
const owned: Array<{destroy(): unknown; completion: Promise<void>}> = [];
let ingestion: V1Ingestion | undefined;
afterEach(async () => {
  await ingestion?.stop(); ingestion = undefined;
  for (const client of owned.splice(0)) { client.destroy(); await client.completion; }
  if (host && host.exitCode === null) { host.stdin.end('exit\n'); await until(() => host!.exitCode !== null, 5_000); if (host.exitCode === null) host.kill(); }
  host = undefined;
  if (directory) await rm(directory, {recursive: true, force: true});
  directory = undefined;
});
async function until(predicate: () => boolean, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (predicate()) return true; await new Promise(r => setTimeout(r, 25)); } return predicate(); }
type Delivery = Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>['data']['status']['delivery'];

it('relays a broker-provisioned v1 session and its ACK, and fails a synthetic origin closed under game authority', async () => {
  for (const [name, file] of Object.entries(artifacts)) expect(existsSync(file), `${name} artifact missing: build the native plugin and client first`).toBe(true);
  directory = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-v1-chain-'));
  const transport = path.join(directory, 'transport'), v0 = path.join(transport, 'v0'), v1 = path.join(transport, 'v1');
  host = spawn(artifacts.host, ['host', artifacts.dll, v0, v1], {stdio: 'pipe', windowsHide: true});
  let output = ''; host.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); }); host.stderr.on('data', () => {});
  expect(await until(() => output.includes('"ready":true'), 10_000), 'fake SDK host ready').toBe(true);
  const ready = JSON.parse(output.split('\n')[0]) as {processId: number; v1Endpoint: string};
  expect(ready.v1Endpoint).toContain(`${nativeTreeIdentity().pipePrefix}ets2-v1-`);
  expect(await until(() => existsSync(v1) && readdirSync(v1).some(name => DISCOVERY_RECORD.test(name)), 10_000), 'v1 discovery record').toBe(true);
  // The plugin creates transport\v1 but never a service policy: until a broker provisions it, no client is authorized.
  const policyFile = path.join(v1, 'service-policy.json');
  expect(existsSync(policyFile)).toBe(false);

  // Test-level durable driver over the production NativePipeClient in v1 mode.
  const diagnostics: BrokerDiagnostic[] = [], errors: unknown[] = [];
  const driver = new NativePipeClient({executable: artifacts.broker, discoveryDirectory: v1}, 'ets2', diagnostic => diagnostics.push(diagnostic), 'v1');
  owned.push(driver);
  const decoder = new FrameDecoder('server', {maxMinor: V1_CLIENT_MAX_MINOR}), consumer = new V1Consumer(true, {maxMinor: V1_CLIENT_MAX_MINOR}), messages: ServerMessage[] = [];
  let covered = 0n;
  driver.on('connect', () => driver.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: V1_CLIENT_MAX_MINOR, durableEvents: true}})));
  driver.on('data', (bytes: Uint8Array) => {
    try {
      decoder.push(bytes, decoded => {
        const message = decoded as ServerMessage, applied = consumer.accept(message);
        messages.push(message);
        if (applied.coverage) covered = BigInt(applied.coverage.lastEventSeq);
      });
    } catch (error) { errors.push(error); throw error; }
  });
  driver.on('error', error => errors.push(error));
  expect(await until(() => messages.some(message => message.kind === 'checkpoint') || errors.length > 0, 15_000), 'welcome and checkpoint through the broker').toBe(true);
  expect(errors).toEqual([]);

  // The plugin accepted the policy the broker just provisioned: it names this broker's final DOS path and bytes.
  expect(existsSync(policyFile)).toBe(true);
  const policy = JSON.parse(readFileSync(policyFile, 'utf8')) as {allowedExecutables: Array<{path: string; sha256: string}>};
  const brokerSha256 = createHash('sha256').update(readFileSync(artifacts.broker)).digest('hex');
  const brokerFinalPath = `\\\\?\\${realpathSync.native(artifacts.broker)}`.toLowerCase();
  expect(policy.allowedExecutables.map(entry => ({path: entry.path.toLowerCase(), sha256: entry.sha256}))).toEqual([{path: brokerFinalPath, sha256: brokerSha256}]);
  // The v1 mode never touches the v0 directory.
  expect(existsSync(path.join(v0, 'service-policy.json'))).toBe(false);

  const welcome = messages[0];
  if (welcome.kind !== 'welcome') throw new Error('welcome expected first');
  expect(welcome.data.durableEvents).toBe(true);
  expect(welcome.data.capabilities.eventTypes).toContain('source.gameMode');
  const mode = {mode: 'single-player', method: 'module-scan', confidence: 'weak', module: {available: false, reason: 'not-observed'}};
  expect(welcome.data.gameMode).toEqual(mode);
  for (const message of messages) if (message.kind === 'checkpoint' || message.kind === 'snapshot') expect(message.data.status.gameMode).toEqual(mode);
  // ET-050b B1, ET-052: the plugin selected minor 2, and every message of the connection carries it.
  expect(V1_CLIENT_MAX_MINOR).toBe(2);
  expect({envelope: welcome.version, minor: welcome.data.minor, consumer: consumer.minor}).toEqual({envelope: {major: 1, minor: 2}, minor: 2, consumer: 2});
  expect(messages.every(message => message.version.minor === 2)).toBe(true);
  const breakOf = (message: ServerMessage) => message.kind === 'checkpoint' || message.kind === 'snapshot' ? message.data.state.nextMandatoryBreak : undefined;
  // The registered channel was never called back: not-observed on the checkpoint and on every later state, never zero.
  expect(breakOf(messages.find(message => message.kind === 'checkpoint')!)).toEqual({available: false, reason: 'not-observed', unit: 'min'});
  const gearboxOf = (message: ServerMessage): GearboxState | undefined => message.kind === 'checkpoint' || message.kind === 'snapshot' ? message.data.state.gearbox : undefined;
  // Before any truck or hshifter callback every part is not-observed.
  expect(gearboxOf(messages.find(message => message.kind === 'checkpoint')!)).toEqual({forwardGears: {available: false, reason: 'not-observed'},
    reverseGears: {available: false, reason: 'not-observed'}, hshifter: {available: false, reason: 'not-observed'}});
  // The broker reports the verified host process with origin game; the test DLL marks its own source synthetic.
  expect(driver.authority).toMatchObject({game: 'ets2', origin: 'game', processId: ready.processId});
  expect(welcome.source).toEqual({...driver.authority, origin: 'synthetic'});

  const delivery = (message: ServerMessage): Delivery | undefined => message.kind === 'checkpoint' || message.kind === 'snapshot' ? message.data.status.delivery : undefined;
  expect(delivery(messages.find(message => message.kind === 'checkpoint')!)?.ackedThroughEventSeq).toBe('0');
  const recorded = () => messages.flatMap(message => message.kind === 'event' ? [message.data.record.type] : []);
  expect(await until(() => recorded().includes('source.gameMode'), 10_000), 'cached evidence published after durable attachment').toBe(true);
  const source = messages.find(message => message.kind === 'event' && message.data.record.type === 'source.gameMode');
  expect(source?.kind === 'event' && source.data.eventSeq).toBe('2');
  expect(source?.kind === 'event' && source.data.record).toEqual({type: 'source.gameMode', ...mode});
  expect(messages.flatMap(message => message.kind === 'gap' ? [message.data] : [])).toEqual([{firstEventSeq: '1', lastEventSeq: '1', causes: {offline: '1', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'}, firstLostMonotonicNs: expect.any(Object), lastLostMonotonicNs: expect.any(Object), redelivered: false}]);
  host.stdin.write('pause\nstart\n');
  expect(await until(() => recorded().includes('simulation.started'), 10_000), 'two lifecycle events delivered').toBe(true);
  expect(recorded()).toEqual(['source.gameMode', 'simulation.paused', 'simulation.started']);
  expect(messages.flatMap(message => message.kind === 'event' ? [message.data.eventSeq] : [])).toEqual(['2', '3', '4']);
  expect(messages.flatMap(message => message.kind === 'gap' ? [message.data] : [])).toEqual([{firstEventSeq: '1', lastEventSeq: '1', causes: {offline: '1', noDurableConsumer: '0', queueCount: '0', queueBytes: '0', retentionExpired: '0', encodingFailed: '0'}, firstLostMonotonicNs: expect.any(Object), lastLostMonotonicNs: expect.any(Object), redelivered: false}]);
  const through = covered;
  expect(through).toBe(4n);
  // Nothing is released before an ACK: the latest status still retains the delivered entries.
  expect(await until(() => messages.some(message => Number(delivery(message)?.retainedEvents ?? 0) > 0), 5_000)).toBe(true);
  expect(diagnostics).toEqual([]);

  const ackAt = messages.length;
  const M2 = {major: 1, minor: 2} as const;
  driver.write(encodeFrame({version: M2, kind: 'ack', data: {pluginSessionId: welcome.source.pluginSessionId, throughEventSeq: through.toString()}}, {maxMinor: 2}));
  const released = () => messages.slice(ackAt).map(delivery).find(status => status?.ackedThroughEventSeq === through.toString());
  expect(await until(() => released() !== undefined || errors.length > 0, 10_000), 'a later snapshot reports the cumulative ACK through source and lifecycle events').toBe(true);
  expect(errors).toEqual([]);
  expect(released()).toMatchObject({durable: true, ackedThroughEventSeq: through.toString(), nextEventSeq: (through + 1n).toString(), retainedEvents: 0, retainedBytes: 0});

  // The gearbox reaches the client: the layout lists the 16 nonzero slots in SDK slot order, the counts are the truck's.
  host.stdin.write('gearbox\n');
  const geared = () => messages.map(gearboxOf).find(gearbox => gearbox?.hshifter.available === true && gearbox.forwardGears.available);
  expect(await until(() => geared() !== undefined || errors.length > 0, 10_000), 'a snapshot carries the h-shifter layout and gear counts').toBe(true);
  expect(errors).toEqual([]);
  const slots: [number, number, number][] = [[-1, 1, 0], [-3, 1, 1], [-2, 1, 2], [-4, 1, 3], [1, 2, 0], [7, 2, 1], [2, 2, 2], [8, 2, 3], [3, 3, 0], [9, 3, 1], [4, 3, 2], [10, 3, 3],
    [5, 4, 0], [11, 4, 1], [6, 4, 2], [12, 4, 3]];
  for (const message of messages) if (message.kind === 'checkpoint' || message.kind === 'snapshot') expect(message.data.status.gameMode).toEqual(mode);
  expect(geared()).toEqual({forwardGears: {available: true, value: 12}, reverseGears: {available: true, value: 4},
    hshifter: {available: true, value: {selectorCount: 2, slots: slots.map(([gear, handlePosition, selectors]) => ({gear, handlePosition, selectors}))}}});
  // The truck callback is a durable event; the hshifter callback is none (B2).
  expect(await until(() => recorded().includes('truck.configured'), 10_000)).toBe(true);
  expect(recorded()).toEqual(['source.gameMode', 'simulation.paused', 'simulation.started', 'truck.configured']);
  const truckThrough = covered, probeAt = messages.length;
  consumer.expectClockReply('1');
  driver.write(encodeFrame({version: M2, kind: 'clock.probe', data: {probeId: '1'}}, {maxMinor: 2}));
  driver.write(encodeFrame({version: M2, kind: 'ack', data: {pluginSessionId: welcome.source.pluginSessionId, throughEventSeq: truckThrough.toString()}}, {maxMinor: 2}));
  expect(await until(() => messages.slice(probeAt).some(message => message.kind === 'clock.reply') || errors.length > 0, 10_000), 'the relayed {1,2} clock probe is answered').toBe(true);
  expect(await until(() => messages.slice(probeAt).some(message => delivery(message)?.ackedThroughEventSeq === truckThrough.toString()) || errors.length > 0, 10_000)).toBe(true);
  expect(errors).toEqual([]);
  expect(messages.every(message => message.version.minor === 2)).toBe(true);
  // The break stayed not-observed on every state of the connection, including those after the gearbox commands.
  expect(messages.flatMap(message => { const b = breakOf(message); return b ? [b] : []; }).every(b => !b.available && b.reason === 'not-observed' && b.unit === 'min')).toBe(true);
  driver.destroy(); await driver.completion;

  // A live-only client that offers less gets the lower minor of the same session: minor 1 with the gearbox and without the
  // break, minor 0 with neither (the bytes before ET-052 and before ET-050b), through the same broker.
  for (const offered of [1, 0] as const) {
    const old = new NativePipeClient({executable: artifacts.broker, discoveryDirectory: v1}, 'ets2', diagnostic => diagnostics.push(diagnostic), 'v1');
    owned.push(old);
    const oldMax = { maxMinor: offered }, oldDecoder = new FrameDecoder('server', oldMax), oldConsumer = new V1Consumer(false, oldMax), oldMessages: ServerMessage[] = [];
    old.on('connect', () => old.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: offered, durableEvents: false}})));
    old.on('data', (bytes: Uint8Array) => {
      try { oldDecoder.push(bytes, decoded => { const message = decoded as ServerMessage; oldConsumer.accept(message); oldMessages.push(message); }); }
      catch (error) { errors.push(error); throw error; }
    });
    old.on('error', error => errors.push(error));
    expect(await until(() => oldMessages.some(message => message.kind === 'checkpoint') || errors.length > 0, 15_000), `a minor-${offered} welcome and checkpoint`).toBe(true);
    expect(errors).toEqual([]);
    const oldWelcome = oldMessages[0];
    if (oldWelcome.kind !== 'welcome') throw new Error('welcome expected first');
    expect({offered, envelope: oldWelcome.version, minor: oldWelcome.data.minor}).toEqual({offered, envelope: {major: 1, minor: offered}, minor: offered});
    const oldCheckpoint = oldMessages.find(message => message.kind === 'checkpoint');
    expect(oldCheckpoint?.kind === 'checkpoint' && Object.hasOwn(oldCheckpoint.data.state, 'gearbox')).toBe(offered === 1);
    expect(oldCheckpoint?.kind === 'checkpoint' && Object.hasOwn(oldCheckpoint.data.state, 'nextMandatoryBreak')).toBe(false);
    expect(oldMessages.every(message => message.version.minor === offered)).toBe(true);
    old.destroy(); await old.completion;
  }

  // The production ingestion, live-only through the same broker v1 mode: a synthetic origin under game authority is incompatible.
  const states: V1SourceState[] = [];
  ingestion = new V1Ingestion({connectGame: (configuration, game) => new NativePipeClient(configuration, game, undefined, 'v1'), broker: {executable: artifacts.broker, discoveryDirectory: v1},
    onState: state => states.push(state)});
  ingestion.select('ets2');
  expect(await until(() => ingestion!.current.status === 'incompatible', 15_000), 'fail closed on the synthetic origin').toBe(true);
  expect(ingestion.current).toMatchObject({status: 'incompatible', reason: 'Invalid protocol, ordering or selected source identity', fresh: false, durable: {state: 'off'}});
  expect(ingestion.current.observation).toBeUndefined();
  expect(states.some(state => state.status === 'connected' || state.status === 'paused' || state.status === 'stale')).toBe(false);
  await ingestion.stop(); ingestion = undefined;

  host.stdin.end('exit\n');
  expect(await until(() => host!.exitCode !== null, 5_000)).toBe(true); expect(host.exitCode).toBe(0);
  console.log(JSON.stringify({chain: 'passed', ackedThroughEventSeq: through.toString(), messages: messages.length}));
});
