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
  // `ticks` counts snapshot timer firings, held or not, so a test can observe time passing on the source's own schedule.
  let seq = 0n, connections = 0, frames = 0, ticks = 0, stopped = false, held = false;
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
    const loop = () => {timer = setTimeout(() => {ticks++; if (held) loop(); else send('snapshot', loop);}, 50);};
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
    const closed = [...clients].map(socket => new Promise(resolve => {socket.once('close', resolve); socket.destroy();}));
    await Promise.all([new Promise(resolve => server.close(resolve)), ...closed]);
  };
  return {endpoint, stop,
    setReading: (speedMps, fuelL) => {
      assert.ok(Number.isFinite(speedMps) && Number.isFinite(fuelL) && fuelL >= 0);
      checkpoint.data.state.speed = {available: true, value: speedMps, unit: 'm/s'};
      checkpoint.data.state.fuel = {available: true, value: fuelL, unit: 'L'};
    },
    // ET-045d: engine RPM and the gear index (negative is reverse, 0 neutral) for the overlay's digit-count transitions.
    setEngine: (rpm, gearIndex) => {
      assert.ok(Number.isFinite(rpm) && rpm >= 0 && Number.isInteger(gearIndex));
      checkpoint.data.state.engineRpm = {available: true, value: rpm, unit: 'rpm'};
      checkpoint.data.state.gear = {available: true, value: gearIndex, unit: 'index'};
    },
    setCapacity: value => {checkpoint.data.state.fuelCapacity = value === null ? {available: false, reason: 'not-observed', unit: 'L'} : {available: true, value, unit: 'L'};},
    setPaused: value => {checkpoint.data.state.simulation = value ? 'paused' : 'running';},
    setUnavailable: () => {
      checkpoint.data.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
      checkpoint.data.state.fuel = {available: false, reason: 'not-observed', unit: 'L'};
    },
    hold: () => {held = true;}, resume: () => {held = false;},
    statistics: () => ({connections, frames, ticks, activeClients: clients.size, held, stopped, origin: 'synthetic', history: false,
      identity: {...checkpoint.source, clockId: checkpoint.capture.clockId}})};
}
