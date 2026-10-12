import {spawn, type ChildProcessWithoutNullStreams} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it} from 'vitest';
import {CaptureSession, NativeCaptureClient} from '../../apps/desktop/src/capture-session';
import {exportCapture} from '../../tools/capture-export/src/sanitize';

// Controlled chain: tests-only fake SDK host (named eurotrucks2.exe) loading the isolated test plugin
// DLL -> CAP0 endpoint -> fixed native broker in capture mode -> TypeScript session and writer.
// Synthetic evidence only; it never launches or touches a game or the user's history.
const root = path.resolve(import.meta.dirname, '../..');
const artifacts = {
  host: path.join(root, 'native/telemetry-plugin/build/cap0-host/Release/eurotrucks2.exe'),
  dll: path.join(root, 'native/telemetry-plugin/build/Release/snapshot-transport-test-plugin.dll'),
  broker: path.join(root, 'native/telemetry-client/build/Release/telemetry-pipe-client.exe')
};
let host: ChildProcessWithoutNullStreams | undefined, directory: string | undefined;
afterEach(async () => {
  if (host && host.exitCode === null) { host.stdin.end('exit\n'); await new Promise(resolve => setTimeout(resolve, 1500)); if (host.exitCode === null) host.kill(); }
  if (directory) await rm(directory, {recursive: true, force: true});
});
async function until(predicate: () => boolean | Promise<boolean>, ms: number) { const end = Date.now() + ms; while (Date.now() < end) { if (await predicate()) return true; await new Promise(r => setTimeout(r, 50)); } return false; }

it('captures fake-SDK evidence through the plugin endpoint, native broker and bounded writer', async () => {
  for (const [name, file] of Object.entries(artifacts)) expect(existsSync(file), `${name} artifact missing: build native plugin and client first`).toBe(true);
  directory = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-cap0-chain-'));
  const transport = path.join(directory, 'transport', 'v0'), captures = path.join(directory, 'captures');
  host = spawn(artifacts.host, ['host', artifacts.dll, transport], {stdio: 'pipe', windowsHide: true});
  let output = ''; host.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); }); host.stderr.on('data', () => {});
  expect(await until(() => output.includes('"ready":true'), 10_000), 'fake SDK host ready').toBe(true);
  const ready = JSON.parse(output.split('\n')[0]) as {processId: number; captureEndpoint: string; fixture: string};
  expect(ready.fixture).toBe('fake-sdk-host'); expect(ready.captureEndpoint).toContain('-cap0-');
  const session = new CaptureSession({root: captures, game: 'ets2', retryMs: 100, connect: () => new NativeCaptureClient({executable: artifacts.broker, discoveryDirectory: transport}, 'ets2'),
    context: {activation: {mechanism: 'environment', deadlineMs: 60_000, operatorLabel: 'controlled-chain'}, code: {}, platform: {}, displays: []}});
  await session.start();
  const packets = path.join(captures, session.captureSessionId, 'packets.ndjson');
  expect(await until(async () => existsSync(packets) && (await readFile(packets, 'utf8')).includes('"kind":"header"'), 10_000), 'CAP0 header written').toBe(true);
  host.stdin.write('job\ndeliver\npause\n');
  expect(await until(async () => (await readFile(packets, 'utf8')).includes('simulation.paused'), 10_000), 'lifecycle envelope written').toBe(true);
  host.stdin.end('exit\n');
  const manifest = await session.done;
  expect(manifest).toMatchObject({status: 'complete', origin: 'synthetic', stop: {reason: 'source-end'}, loss: {endMarkerReceived: true, end: {reason: 'plugin-shutdown'}},
    authority: {game: 'ets2', processId: ready.processId}, header: {source: {processId: ready.processId, sdkGameId: 'eut2'}}});
  const text = await readFile(packets, 'utf8');
  for (const expected of ['"18446744073709551615"', '"-9223372036854775808"', '"job.delivered"', '"cargo.fixture"', '"simulation.paused"']) expect(text).toContain(expected);
  const exported = await exportCapture(path.join(captures, session.captureSessionId), path.join(directory, 'export'));
  const sanitized = await readFile(path.join(exported.outputDirectory, 'packets.ndjson'), 'utf8');
  expect(sanitized).not.toContain(manifest!.authority!.processInstanceId); expect(sanitized).toContain('"18446744073709551615"');
  expect(await until(() => host!.exitCode !== null, 5_000)).toBe(true); expect(host.exitCode).toBe(0);
  console.log(JSON.stringify({chain: 'passed', packets: manifest!.counts.packetsWritten, envelopes: manifest!.counts.envelopesCompleted, captureSessionId: 'redacted'}));
});
