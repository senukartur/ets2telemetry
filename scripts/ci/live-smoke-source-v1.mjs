import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

// Isolated synthetic protocol v1 test endpoint for the telemetry smoke (ET-010c decision F8), never a production
// peer-identity claim. It serves the shared live fixtures: welcome-live, checkpoint-live, then snapshot-live every 50 ms
// with a new seq and SDK boundary on a monotonic capture clock. The job's cargo and destination city ids are set to the
// v0 smoke checkpoint's in memory (fixture files are untouched), so the dashboard shows both sources for the same job.
// The fixtures' game window is kept, so the service's projection must strip it. Clock probes are read and ignored.
const CLIENT_FRAME_BYTES = 4096;
/** Every capture is at least snapshot-live's own capture, so its oldest retained event never lies in the future. */
const CAPTURE_BASE_NS = 1_000_250_000_000n;

export async function startLiveSmokeSourceV1(checkout) {
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  const fixture = async name => JSON.parse(await readFile(`${checkout}/tests/fixtures/protocol-v1/${name}.json`, 'utf8'));
  const [welcome, checkpoint, snapshot] = await Promise.all([fixture('welcome-live'), fixture('checkpoint-live'), fixture('snapshot-live')]);
  const source = {...welcome.source, pluginSessionId: randomUUID(), processInstanceId: randomUUID(), processId: process.pid};
  const clockId = randomUUID();
  for (const message of [checkpoint, snapshot]) {
    const job = message.data.state.configuration.job.value;
    job.cargoId = {available: true, value: 'cargo.logs'};
    job.destinationCityId = {available: true, value: 'city.warszawa'};
  }
  let seq = 0n, boundary = BigInt(checkpoint.data.state.boundaryOrder), connections = 0, frames = 0, probes = 0, stopped = false, held = false;
  const origin = performance.now(), clients = new Set();
  const frame = value => {
    const payload = Buffer.from(JSON.stringify(value)); assert.ok(payload.length <= 65536);
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
  };
  const message = template => {
    const value = structuredClone(template);
    value.source = source; value.seq = (++seq).toString();
    value.capture = {clockId, monotonicNs: (CAPTURE_BASE_NS + BigInt(Math.floor((performance.now() - origin) * 1e6))).toString()};
    if (value.kind === 'checkpoint') value.data.boundarySeq = value.seq;
    // Each state message is a new SDK boundary, which is what renews the service's v1 freshness.
    if (value.kind !== 'welcome') value.data.state.boundaryOrder = (++boundary).toString();
    return value;
  };
  const server = net.createServer(socket => {
    if (stopped || clients.size) {socket.destroy(); return;}
    clients.add(socket); connections++;
    let input = Buffer.alloc(0), started = false, timer;
    const deadline = setTimeout(() => socket.destroy(), 5000);
    const send = (template, then) => {
      if (stopped || socket.destroyed) return;
      socket.write(frame(message(template)), error => {if (error) socket.destroy(); else {frames++; then();}});
    };
    const loop = () => {timer = setTimeout(() => {if (held) loop(); else send(snapshot, loop);}, 50);};
    const accept = value => {
      if (!started) {
        assert.equal(value.kind, 'hello'); assert.deepEqual(value.version, {major: 1, minor: 0});
        assert.deepEqual({minMinor: value.data.minMinor, maxMinor: value.data.maxMinor, durableEvents: value.data.durableEvents}, {minMinor: 0, maxMinor: 0, durableEvents: false});
        started = true; clearTimeout(deadline);
        send(welcome, () => send(checkpoint, loop));
      } else {
        // The live-only client measures the source clock; no reply is required, so a probe stays outstanding.
        assert.equal(value.kind, 'clock.probe'); probes++;
      }
    };
    socket.on('data', bytes => {
      input = Buffer.concat([input, bytes]);
      try {
        while (input.length >= 4) {
          const length = input.readUInt32LE(0);
          assert.ok(length > 0 && length <= CLIENT_FRAME_BYTES);
          if (input.length < 4 + length) return;
          accept(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(input.subarray(4, 4 + length))));
          input = input.subarray(4 + length);
        }
      } catch {socket.destroy();}
    });
    socket.on('error', () => {});
    socket.on('close', () => {clearTimeout(deadline); clearTimeout(timer); clients.delete(socket);});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
  const stop = async () => {
    if (stopped) return; stopped = true;
    const closed = [...clients].map(socket => new Promise(resolve => {socket.once('close', resolve); socket.destroy();}));
    await Promise.all([new Promise(resolve => server.close(resolve)), ...closed]);
  };
  return {endpoint, stop,
    hold: () => {held = true;}, resume: () => {held = false;},
    statistics: () => ({connections, frames, probes, activeClients: clients.size, held, stopped, origin: 'synthetic', history: false,
      identity: {...source, clockId}})};
}
