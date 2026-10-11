import assert from 'node:assert/strict';
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';

// Isolated synthetic test endpoint, never a production peer-identity claim.
export async function startLiveSmokeSource(checkout) {
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-${process.pid}-${randomUUID()}`;
  const checkpoint = JSON.parse(await readFile(`${checkout}/tests/fixtures/protocol-v0/checkpoint.json`, 'utf8'));
  checkpoint.source.pluginSessionId = randomUUID(); checkpoint.source.processInstanceId = randomUUID();
  checkpoint.capture.clockId = randomUUID(); checkpoint.source.processId = process.pid;
  checkpoint.data.state.speed = {available: true, value: 25, unit: 'm/s'};
  checkpoint.data.state.fuel = {available: true, value: 73, unit: 'L'};
  checkpoint.data.state.window = {available: false, reason: 'not-observed'};
  checkpoint.data.continuity = {coalescedSnapshots: '0', lostObservations: '0', offlineTransitions: '0'};
  let seq = 0n, connections = 0, frames = 0, stopped = false;
  const origin = performance.now(), clients = new Set();
  const frame = value => {
    const payload = Buffer.from(JSON.stringify(value)); assert.ok(payload.length <= 65536);
    const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); return Buffer.concat([header, payload]);
  };
  const message = kind => {
    const value = structuredClone(checkpoint); value.kind = kind; value.seq = (++seq).toString();
    value.capture.monotonicNs = BigInt(Math.floor((performance.now() - origin) * 1e6)).toString();
    if (kind === 'welcome') value.data = {diagnostics: false, durableRecording: false};
    else if (kind === 'checkpoint') value.data.boundarySeq = value.seq;
    else delete value.data.boundarySeq;
    return value;
  };
  const server = net.createServer(socket => {
    if (stopped || clients.size) {socket.destroy(); return;}
    clients.add(socket); connections++;
    let hello = Buffer.alloc(0), started = false, timer;
    const deadline = setTimeout(() => socket.destroy(), 5000);
    const send = (kind, then) => {
      if (stopped || socket.destroyed) return;
      socket.write(frame(message(kind)), error => {if (error) socket.destroy(); else {frames++; then();}});
    };
    const loop = () => {timer = setTimeout(() => send('snapshot', loop), 50);};
    socket.on('data', bytes => {
      if (started || hello.length + bytes.length > 4100) {socket.destroy(); return;}
      hello = Buffer.concat([hello, bytes]);
      if (hello.length < 4) return;
      const length = hello.readUInt32LE(0);
      if (!length || length > 4096 || hello.length > 4 + length) {socket.destroy(); return;}
      if (hello.length < 4 + length) return;
      try {
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(hello.subarray(4)));
        assert.equal(value.kind, 'hello'); assert.deepEqual(value.version, {major: 0, minor: 0});
        assert.equal(value.data.diagnostics, false);
        started = true; clearTimeout(deadline); hello = Buffer.alloc(0);
        send('welcome', () => send('checkpoint', loop));
      } catch {socket.destroy();}
    });
    socket.on('error', () => {});
    socket.on('close', () => {clearTimeout(deadline); clearTimeout(timer); clients.delete(socket);});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
  const stop = async () => {
    if (stopped) return; stopped = true;
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  };
  return {endpoint, stop,
    setReading: (speedMps, fuelL) => {
      assert.ok(Number.isFinite(speedMps) && Number.isFinite(fuelL) && fuelL >= 0);
      checkpoint.data.state.speed.value = speedMps; checkpoint.data.state.fuel.value = fuelL;
    },
    statistics: () => ({connections, frames, origin: 'synthetic', history: false})};
}
