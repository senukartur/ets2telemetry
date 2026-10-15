import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {builtinModules} from 'node:module';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {FrameDecoder, PROTOCOL_V1, encodeFrame, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {V1Consumer} from '../../packages/contracts/src/protocol-v1-delivery';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {checkStateRate, checkV1Cadence} from '../../tools/telemetry-simulator/src/v1/cadence';
import {TEST_PIPE_PATTERN_V1, TEST_PIPE_PREFIX_V1, clientPlan, pipeDifferences, pipeRoundTrip, runV1PipeClient, serveV1} from '../../tools/telemetry-simulator/src/v1/pipe';
import {runIndependentClient} from '../../tools/telemetry-simulator/src/v1/reactive';
import {replayV1, transcriptLines} from '../../tools/telemetry-simulator/src/v1/replay';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {expectedPath, manifest, mismatches, scenarioPath, type Expected} from '../shared/simulator-v1-expected';

type Json = Record<string, unknown>;
const load = (id: string) => readFixtureFile(scenarioPath(id));
const SOURCE = {versions: {telemetryApi: {major: 1, minor: 1}, gameTelemetry: {major: 1, minor: 19}, sdkArchive: 'scs-sdk-1.15'}, gameplayEvents: 'registered', currency: 'unknown', gameMode: 'unknown'};
const inline = (steps: Json[], transport: Json[]): Json => ({format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id: 'pipe-test', purpose: 'Pipe test', reg: ['REG-011'], origin: 'synthetic',
  game: 'ets2', seed: 'pipe-test', provenance: null, source: SOURCE, steps, transport});
/** The hello of the inline scenario's first client instance, as its script sends it. */
const hello = (durableEvents = true) => encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: seededId('pipe-test', 'client-instance-1'), minMinor: 0, maxMinor: 0, durableEvents}});

/** A raw test client: connects, sends `first`, decodes server frames and records how the connection ended. */
function rawClient(endpoint: string, first?: Uint8Array) {
  const socket = net.connect(endpoint), decoder = new FrameDecoder('server'), messages: ServerMessage[] = [];
  let bytes = 0;
  const closed = new Promise<{bytes: number; messages: ServerMessage[]}>((resolve, reject) => {
    socket.on('data', chunk => { bytes += chunk.length; decoder.push(chunk, m => messages.push(m as ServerMessage)); });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve({bytes, messages}));
    setTimeout(() => reject(new Error('Raw client deadline')), 20_000).unref();
  });
  socket.on('connect', () => { if (first) socket.write(first); });
  return {socket, messages, closed};
}
async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = performance.now();
  while (!check()) { if (performance.now() - start > ms) throw new Error('Condition deadline'); await new Promise(r => setTimeout(r, 5)); }
}
/** Runs the built CLI to its exit; only the test's own timeout bounds it, so a slow host cannot fail a launch. */
function runCli(args: string[]): Promise<{status: number | null; stdout: string; stderr: string}> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, {windowsHide: true}); let stdout = '', stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); }); child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
    child.on('close', status => resolve({status, stdout, stderr}));
  });
}
/** Bundles the current CLI source into an owned directory, so tests never use a cached artifact. */
async function buildCli(directory: string): Promise<string> {
  const {build} = await import('vite'), bundle = join(directory, 'bundle');
  await build({configFile: false, logLevel: 'silent', build: {outDir: bundle, emptyOutDir: true, lib: {entry: resolve('tools/telemetry-simulator/src/cli.ts'), formats: ['cjs'], fileName: () => 'cli.cjs'},
    rollupOptions: {external: [...builtinModules, ...builtinModules.map(x => `node:${x}`)]}}});
  return join(bundle, 'cli.cjs');
}

describe('simulator v1 over an actual Windows named pipe', () => {
  // Every corpus scenario, unpaced: the served transcript is byte-identical to the replay, the scripted client wrote and
  // applied exactly the replayed bytes and messages, its ledger equals the replay's, and the served run meets the
  // scenario's hand-written expectation. Only the scenario with a silent client gets a shorter, 200 ms hello deadline;
  // every other connection keeps the 5,000 ms default.
  for (const id of manifest()) it(`serves ${id} exactly as replayed and as expected`, async () => {
    const run = await pipeRoundTrip(load(id), {scale: 0, ...(id === 'client-hello-faults' ? {helloTimeoutMs: 200} : {})});
    expect(run.differences).toEqual([]);
    expect(run.served.cancelled).toBe(false);
    expect(mismatches(run.served.result, JSON.parse(readFileSync(expectedPath(id), 'utf8')) as Expected)).toEqual([]);
  }, 30_000);

  it('paces connected segments in real time within the smoke cadence, at no more than 20 state messages per second', async () => {
    const run = await pipeRoundTrip(load('pipe-reconnect'), {scale: 1});
    expect(run.differences).toEqual([]);
    // No message is written before its schedule (server clock, by construction); the first measurable gap, the 50 ms
    // snapshot, arrives no more than 1,000 ms late (client clock).
    const cadence = checkV1Cadence(run.served.writes, run.served.result.transcript, new Map(run.client.connections.map(c => [c.connection, c.arrivalsMs])));
    expect(cadence?.expectedMs).toBe(50);
    expect(run.served.writes.length).toBe(run.served.result.transcript.filter(l => l.direction === 'server').length);
    for (const w of run.served.writes) expect(w.actualMs).toBeGreaterThanOrEqual(w.scheduledMs);
    expect(BigInt(checkStateRate(run.served.result.transcript)!)).toBeGreaterThanOrEqual(50_000_000n);
  }, 30_000);

  it('maps the clock from one real probe round trip of the scripted client', async () => {
    const run = await pipeRoundTrip(load('pipe-reconnect'), {scale: 1}), captureClock = seededId('et005b-pipe-reconnect', 'capture-clock');
    const [probe] = run.client.connections[0].mappings;
    expect(run.client.connections.flatMap(c => c.mappings)).toHaveLength(1);
    expect(probe.probeId).toBe('1');
    // A reply later than 1 s yields no mapping (§11); otherwise the uncertainty is half the measured round trip.
    if (probe.mapping === null) expect(probe.roundTripNs).toBeNull();
    else {
      expect(probe.mapping.sourceClockId).toBe(captureClock);
      expect(BigInt(probe.mapping.uncertaintyNs)).toBe((BigInt(probe.roundTripNs!) + 1n) / 2n);
    }
  }, 30_000);

  it('serves only synthetic endpoints and its client accepts only the selected synthetic origin', async () => {
    const server = await serveV1(load('normal-delivery'), {scale: 0});
    try {
      expect(server.endpoint).toMatch(TEST_PIPE_PATTERN_V1);
      expect(server.endpoint.startsWith(`${TEST_PIPE_PREFIX_V1}${process.pid}-`)).toBe(true);
    } finally { await server.stop(); }
    const plan = clientPlan(replayV1(load('normal-delivery')));
    await expect(runV1PipeClient('\\\\.\\pipe\\ETS2Telemetry-ets2-v1-real', plan)).rejects.toThrow(/synthetic v1 endpoint/);
    // A hand-rolled server on a synthetic name that labels its source `game`.
    const endpoint = `${TEST_PIPE_PREFIX_V1}${process.pid}-${randomUUID()}`, welcome = replayV1(load('normal-delivery')).transcript[1].message as ServerMessage;
    const game = net.createServer(socket => { socket.on('error', () => undefined); socket.resume(); socket.write(encodeFrame({...welcome, source: {...welcome.source, origin: 'game'}})); });
    await new Promise<void>(r => game.listen(endpoint, r));
    try { await expect(runV1PipeClient(endpoint, plan, {scale: 0})).rejects.toThrow(/requires origin synthetic/); }
    finally { await new Promise<void>(r => game.close(() => r())); }
  }, 30_000);

  it('refuses a second client without a byte while the first one continues', async () => {
    // A live-only client sends nothing after its hello, so a raw client can follow this script.
    const s = inline([{atMs: 10, action: 'frame', channels: {speed: 1}}, {atMs: 300, action: 'frame', channels: {speed: 2}}],
      [{atMs: 0, action: 'connect', client: {durable: false}}, {atMs: 100, action: 'secondClient'}, {atMs: 400, action: 'disconnect'}]);
    const server = await serveV1(s, {scale: 1});
    try {
      const first = rawClient(server.endpoint, hello(false));
      await until(() => first.messages.length >= 3);
      // The second client sends a valid hello, yet is closed without a byte; the first keeps receiving.
      const second = rawClient(server.endpoint, hello(false));
      expect(await second.closed).toEqual({bytes: 0, messages: []});
      const {messages} = await first.closed, consumer = new V1Consumer(false);
      for (const m of messages) consumer.accept(m);
      expect(messages.map(m => m.kind === 'snapshot' && m.data.state.speed.available ? m.data.state.speed.value : m.kind)).toEqual(['welcome', 'checkpoint', 1, 2]);
      const report = await server.done;
      expect([report.refusedClients, report.result.connections.map(c => c.closedBy)]).toEqual([1, ['disconnect']]);
    } finally { await server.stop(); }
  }, 30_000);

  it('closes a silent client at the injected hello deadline, not earlier', async () => {
    const s = inline([], [{atMs: 0, action: 'clientFault', fault: 'helloTimeout'}, {atMs: 10, action: 'connect', client: {durable: true}}, {atMs: 20, action: 'disconnect'}]);
    const server = await serveV1(s, {scale: 0, helloTimeoutMs: 300});
    try {
      // The server measures its deadline on performance.now() from accepting the connection, which follows `start`.
      const start = performance.now(), silent = rawClient(server.endpoint);
      expect(await silent.closed).toEqual({bytes: 0, messages: []});
      expect(performance.now() - start).toBeGreaterThanOrEqual(300);
      const next = rawClient(server.endpoint, hello());
      expect((await next.closed).messages.map(m => m.kind)).toEqual(['welcome', 'checkpoint']);
      expect((await server.done).result.connections.map(c => c.closedBy)).toEqual(['helloTimeout', 'disconnect']);
    } finally { await server.stop(); }
  }, 30_000);

  it('ends a live connection with plugin-shutdown on cancel and retires its endpoint', async () => {
    const s = inline([{atMs: 60_000, action: 'lifecycle', event: 'simulation.started'}], [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 61_000, action: 'disconnect'}]);
    const controller = new AbortController(), server = await serveV1(s, {scale: 1, signal: controller.signal});
    try {
      const client = rawClient(server.endpoint, hello());
      await until(() => client.messages.length === 2);
      controller.abort();
      const {messages} = await client.closed, consumer = new V1Consumer(true);
      for (const m of messages) consumer.accept(m);
      expect(messages.map(m => m.kind)).toEqual(['welcome', 'checkpoint', 'end']);
      expect(messages[2].data).toEqual({reason: 'plugin-shutdown', nextEventSeq: '1', ackedThroughEventSeq: '0', retainedUnacked: '0'});
      expect((await server.done).cancelled).toBe(true);
      // The endpoint is gone: a new client cannot connect.
      await expect(new Promise((resolve, reject) => { const s2 = net.connect(server.endpoint); s2.on('connect', () => { s2.destroy(); resolve('connected'); }); s2.on('error', reject); })).rejects.toThrow();
    } finally { await server.stop(); }
  }, 30_000);

  it('paces a stalled reader: the next connection queues until the write deadline ends the stalled one', async () => {
    const run = await pipeRoundTrip(load('pipe-stalled-reader'), {scale: 1});
    expect(run.differences).toEqual([]);
    expect(run.served.result.connections.map(c => c.closedBy)).toEqual(['writeDeadline', 'disconnect']);
    expect(mismatches(run.served.result, JSON.parse(readFileSync(expectedPath('pipe-stalled-reader'), 'utf8')) as Expected)).toEqual([]);
  }, 30_000);

  it('stamps the end of a cancelled connection at the paced progress, not at the next step', async () => {
    const s = inline([{atMs: 60_000, action: 'lifecycle', event: 'simulation.started'}], [{atMs: 0, action: 'connect', client: {durable: true}}, {atMs: 61_000, action: 'disconnect'}]);
    const server = await serveV1(s, {scale: 1});
    const client = rawClient(server.endpoint, hello());
    await until(() => client.messages.length === 2);
    await server.stop();
    const end = (await client.closed).messages[2], capture = BigInt(end.capture.monotonicNs) - 1_000_000_000_000n;
    expect(end.kind).toBe('end');
    // The segment reached some point after the checkpoint but far before the step at 60,000 ms.
    expect(capture).toBeGreaterThanOrEqual(0n);
    expect(capture).toBeLessThan(30_000_000_000n);
  }, 30_000);

  it('fails visibly when the client deviates from its script', async () => {
    const server = await serveV1(load('normal-delivery'), {scale: 0});
    try {
      // A hello from another client instance where the script has its own.
      const client = rawClient(server.endpoint, encodeFrame({version: PROTOCOL_V1, kind: 'hello', data: {clientInstanceId: randomUUID(), minMinor: 0, maxMinor: 0, durableEvents: true}}));
      await expect(server.done).rejects.toThrow(/differ from its script/);
      await client.closed;
    } finally { await server.stop(); }
  }, 30_000);
});

describe('simulator v1 pipe CLI', () => {
  it('serves in lockstep in one process for the scripted client of another; smoke-v1 reports the same transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ETS2Telemetry-SYNTHETIC-TEST-v1-pipe-cli-'));
    try {
      const cli = await buildCli(directory), path = scenarioPath('pipe-reconnect'), replay = replayV1(load('pipe-reconnect'));
      const hash = createHash('sha256').update(transcriptLines(replay).map(l => `${l}\n`).join('')).digest('hex');
      const child = spawn(process.execPath, [cli, 'serve-v1', path, '--scale', '0', '--lockstep'], {windowsHide: true});
      let stdout = '', stderr = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); }); child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
      await until(() => stdout.includes('\n'), 150_000);
      const {endpoint} = JSON.parse(stdout.split('\n')[0]) as {endpoint: string};
      const client = await runV1PipeClient(endpoint, clientPlan(replay), {scale: 0});
      expect([await exited, stderr]).toEqual([0, '']);
      const report = JSON.parse(stdout.trim().split('\n')[1]) as {transcriptSha256: string; refusedClients: number; cancelled: boolean};
      expect(report).toMatchObject({mode: 'lockstep', transcriptSha256: hash, refusedClients: 1, cancelled: false});
      // The served transcript hashes equal, so the replay stands for it in the client comparison.
      expect(pipeDifferences(replay, replay, client)).toEqual([]);
      const smoke = await runCli([cli, 'smoke-v1', path]);
      expect([smoke.status, smoke.stderr]).toEqual([0, '']);
      expect(JSON.parse(smoke.stdout)).toMatchObject({origin: 'synthetic', mode: 'lockstep', scenario: 'pipe-reconnect', transcriptSha256: hash, connections: 2, refusedClients: 1, history: false,
        ledger: replay.ledger, cadence: {expectedMs: 50}});
      const usage = await runCli([cli, 'smoke-v1', path, '--scale']);
      expect([usage.status, usage.stdout]).toEqual([1, '']);
      const wrongFlag = await runCli([cli, 'serve-v1', path, '--reactive']);
      expect([wrongFlag.status, wrongFlag.stdout]).toEqual([1, '']);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  }, 180_000);

  it('serves reactively by default to an independent consumer in another process; smoke-v1 --reactive checks it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ETS2Telemetry-SYNTHETIC-TEST-v1-reactive-cli-'));
    try {
      const cli = await buildCli(directory), path = scenarioPath('reconnect-lost-ack'), input = load('reconnect-lost-ack'), replay = replayV1(input);
      const child = spawn(process.execPath, [cli, 'serve-v1', path], {windowsHide: true});
      let stdout = '', stderr = '';
      child.stdout.on('data', (c: Buffer) => { stdout += c.toString('utf8'); }); child.stderr.on('data', (c: Buffer) => { stderr += c.toString('utf8'); });
      const exited = new Promise<number | null>(r => child.on('exit', code => r(code)));
      await until(() => stdout.includes('\n'), 150_000);
      const first = JSON.parse(stdout.split('\n')[0]) as {endpoint: string; mode: string};
      expect(first.mode).toBe('reactive');
      const client = await runIndependentClient(first.endpoint, input, {seed: 3});
      expect([await exited, stderr]).toEqual([0, '']);
      expect(client.ledger).toEqual(replay.ledger);
      expect(JSON.parse(stdout.trim().split('\n')[1])).toMatchObject({mode: 'reactive', scenario: 'reconnect-lost-ack', cancelled: false, refusedClients: 0});
      const smoke = await runCli([cli, 'smoke-v1', scenarioPath('pipe-reconnect'), '--reactive']);
      expect([smoke.status, smoke.stderr]).toEqual([0, '']);
      expect(JSON.parse(smoke.stdout)).toMatchObject({mode: 'reactive', scenario: 'pipe-reconnect', connections: 2, ledger: replayV1(load('pipe-reconnect')).ledger});
    } finally { rmSync(directory, {recursive: true, force: true}); }
  }, 180_000);
});
