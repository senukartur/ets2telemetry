import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync, readdirSync, readFileSync, realpathSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {NativePipeClient, type BrokerDiagnostic} from '../../apps/desktop/src/native-pipe-client';
import {V1Ingestion, type V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';

// ET-006b E14 controlled chain: the tests-only fake SDK host (named eurotrucks2.exe) loads the isolated test plugin DLL
// with its v1 directory seam -> the plugin's protocol v1 endpoint -> the fixed native broker in its v1 mode -> TypeScript.
// It proves that the plugin accepts the policy the broker provisions, that a client ACK relayed through the broker
// releases retained entries, and that V1Ingestion with a game selection fails closed on the test DLL's fixed synthetic
// origin under game authority. Production sends no ACK (E2); the ACK here comes from a test-level durable driver.
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
  expect(ready.v1Endpoint).toContain('\\\\.\\pipe\\ETS2Telemetry-ets2-v1-');
  expect(await until(() => existsSync(v1) && readdirSync(v1).some(name => DISCOVERY_RECORD.test(name)), 10_000), 'v1 discovery record').toBe(true);
  // The plugin creates transport\v1 but never a service policy: until a broker provisions it, no client is authorized.
  const policyFile = path.join(v1, 'service-policy.json');
  expect(existsSync(policyFile)).toBe(false);

  // Test-level durable driver over the production NativePipeClient in v1 mode.
  const diagnostics: BrokerDiagnostic[] = [], errors: unknown[] = [];
  const driver = new NativePipeClient({executable: artifacts.broker, discoveryDirectory: v1}, 'ets2', diagnostic => diagnostics.push(diagnostic), 'v1');
  owned.push(driver);
  const decoder = new FrameDecoder('server'), consumer = new V1Consumer(true), messages: ServerMessage[] = [];
  let covered = 0n;
  driver.on('connect', () => driver.write(encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents: true}})));
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
  // The broker reports the verified host process with origin game; the test DLL marks its own source synthetic.
  expect(driver.authority).toMatchObject({game: 'ets2', origin: 'game', processId: ready.processId});
  expect(welcome.source).toEqual({...driver.authority, origin: 'synthetic'});

  const delivery = (message: ServerMessage): Delivery | undefined => message.kind === 'checkpoint' || message.kind === 'snapshot' ? message.data.status.delivery : undefined;
  expect(delivery(messages.find(message => message.kind === 'checkpoint')!)?.ackedThroughEventSeq).toBe('0');
  host.stdin.write('pause\nstart\n');
  const recorded = () => messages.flatMap(message => message.kind === 'event' ? [message.data.record.type] : []);
  expect(await until(() => recorded().includes('simulation.started'), 10_000), 'two lifecycle events delivered').toBe(true);
  expect(recorded()).toEqual(['simulation.paused', 'simulation.started']);
  const through = covered;
  expect(through).toBeGreaterThanOrEqual(2n);
  // Nothing is released before an ACK: the latest status still retains the delivered entries.
  expect(await until(() => messages.some(message => Number(delivery(message)?.retainedEvents ?? 0) > 0), 5_000)).toBe(true);
  expect(diagnostics).toEqual([]);

  const ackAt = messages.length;
  driver.write(encodeFrame({version: PROTOCOL_V1, kind: 'ack', data: {pluginSessionId: welcome.source.pluginSessionId, throughEventSeq: through.toString()}}));
  const released = () => messages.slice(ackAt).map(delivery).find(status => status?.ackedThroughEventSeq === through.toString());
  expect(await until(() => released() !== undefined || errors.length > 0, 10_000), 'a later snapshot reports the relayed ACK').toBe(true);
  expect(errors).toEqual([]);
  expect(released()).toMatchObject({durable: true, ackedThroughEventSeq: through.toString(), nextEventSeq: (through + 1n).toString(), retainedEvents: 0, retainedBytes: 0});
  driver.destroy(); await driver.completion;

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
