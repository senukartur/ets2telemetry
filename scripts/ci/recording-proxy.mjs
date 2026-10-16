import net from 'node:net';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';

// ET-015a PR-4: the recording proxy of the recording runtime journey (recording-observation.mjs). It sits between the
// telemetry service and the reactive simulator on its own synthetic test pipe and:
// - refuses a hello that does not request durable delivery (the service's R10 window while storage is still opening), so
//   the simulator only serves the durable clients its script expects; the refusals are counted;
// - holds a durable hello until the journey admits it, one connection at a time, and never longer than `holdLimitMs`:
//   the service closes a connection whose checkpoint has not arrived 5 s after it opened (V1_HANDSHAKE_MS), so a hold
//   that admission reaches late would consume the admission and then be closed. An expired hold is destroyed instead; the
//   service reconnects on its backoff and its fresh hello is admitted with the full margin;
// - delivers the first `deliveredAcks[i]` ACKs of connection i and drops the rest, as a scenario's `dropAfter` scripts;
// - records each connection's checkpoint, events, ACKs and the time from each event to the ACK that covers it.
// Server bytes pass unchanged; only whole client frames are forwarded or dropped.

/**
 * About half the service's 5 s handshake deadline. That deadline starts at the service's `open()`, before its hello reaches
 * the proxy, so an admitted hello keeps about 3 s for its checkpoint, less the time from open to hello.
 */
export const HOLD_LIMIT_MS = 2000;
const CLIENT_FRAME_BYTES = 4096, SERVER_FRAME_BYTES = 65536;

/** A wire uint64 in canonical decimal form. */
const key = value => value === null || value === undefined ? null : String(value).replace(/^0+(?=.)/, '');

/** Splits length-prefixed frames; `onFrame` gets each whole frame with its decoded JSON payload. */
export function frameReader(limit, onFrame) {
  let input = Buffer.alloc(0);
  return bytes => {
    input = Buffer.concat([input, bytes]);
    while (input.length >= 4) {
      const length = input.readUInt32LE(0);
      if (length < 1 || length > limit) throw new Error('Invalid frame length');
      if (input.length < 4 + length) return;
      const frame = input.subarray(0, 4 + length);
      input = input.subarray(4 + length);
      onFrame(frame, JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(frame.subarray(4))));
    }
  };
}

/**
 * Starts the proxy in front of `upstream` (the simulator's endpoint). Nothing is admitted until `admit()`.
 * `now` is the hold clock (tests only).
 */
export async function startRecordingProxy({upstream, deliveredAcks = [], holdLimitMs = HOLD_LIMIT_MS, now = () => performance.now()}) {
  const endpoint = `\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v1-${process.pid}-${randomUUID()}`;
  const connections = [], sockets = new Set();
  let admissions = 0, attempts = 0, refusedLiveOnly = 0, expiredHolds = 0, stopped = false, held, active;
  const expire = hold => {
    if (held !== hold) return;
    held = undefined; clearTimeout(hold.timer); expiredHolds++; hold.socket.destroy();
  };
  // Starts the held connection once it is admitted and no other connection is open (the simulator serves one at a time).
  const startHeld = () => {
    if (!held || active || admissions < 1 || stopped) return;
    const hold = held;
    if (hold.socket.destroyed) {held = undefined; clearTimeout(hold.timer); return;}
    // A hold whose timer has not run yet but is already too old is not admitted either.
    const heldMs = now() - hold.heldAt;
    if (heldMs >= holdLimitMs) {expire(hold); return;}
    held = undefined; clearTimeout(hold.timer);
    admissions--;
    const {socket, hello} = hold, index = connections.length;
    const record = {connection: index + 1, heldMs: Math.round(heldMs), checkpointAckedThrough: null, events: [], gaps: 0, end: null, acks: [], forwardedAcks: [],
      withheldAcks: [], ackLatencyMs: [], closedBy: null};
    connections.push(record);
    const written = new Map(), upstreamSocket = active = net.connect(upstream);
    sockets.add(upstreamSocket); upstreamSocket.on('close', () => sockets.delete(upstreamSocket));
    const finish = by => {record.closedBy ??= by; if (active === upstreamSocket) active = undefined; socket.destroy(); upstreamSocket.destroy(); startHeld();};
    const observe = frameReader(SERVER_FRAME_BYTES, (_frame, message) => {
      if (message.kind === 'checkpoint') record.checkpointAckedThrough = key(message.data.status.delivery.ackedThroughEventSeq);
      else if (message.kind === 'event') {
        const eventSeq = key(message.data.eventSeq);
        record.events.push({eventSeq, redelivered: message.data.redelivered});
        if (!written.has(eventSeq)) written.set(eventSeq, performance.now());
      } else if (message.kind === 'gap') record.gaps++;
      else if (message.kind === 'end') record.end = message.data.reason;
    });
    upstreamSocket.on('connect', () => upstreamSocket.write(hello));
    upstreamSocket.on('data', bytes => {try {observe(bytes);} catch {record.decodeFailure = true;} socket.write(bytes);});
    upstreamSocket.on('end', () => {record.closedBy ??= 'server'; socket.end();});
    upstreamSocket.on('close', () => finish('server'));
    upstreamSocket.on('error', () => undefined);
    socket.removeAllListeners('data');
    const forward = frameReader(CLIENT_FRAME_BYTES, (frame, message) => {
      if (message.kind !== 'ack') {upstreamSocket.write(frame); return;}
      const through = key(message.data.throughEventSeq), at = performance.now();
      record.acks.push(through);
      // Each event's latency is measured once, to the first ACK that covers it (the service writes it after the commit).
      for (const [eventSeq, sent] of written) {
        if (BigInt(eventSeq) > BigInt(through)) continue;
        record.ackLatencyMs.push({eventSeq, ms: Math.round(at - sent)}); written.delete(eventSeq);
      }
      if (record.forwardedAcks.length < (deliveredAcks[index] ?? Infinity)) {record.forwardedAcks.push(through); upstreamSocket.write(frame);}
      else record.withheldAcks.push(through);
    });
    socket.on('data', bytes => {try {forward(bytes);} catch {record.decodeFailure = true; finish('proxy');}});
    socket.on('close', () => finish('client'));
  };
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
    if (stopped) {socket.destroy(); return;}
    attempts++;
    const read = frameReader(CLIENT_FRAME_BYTES, (frame, message) => {
      if (message.kind !== 'hello') {socket.destroy(); return;}
      if (message.data.durableEvents !== true) {refusedLiveOnly++; socket.destroy(); return;}
      // A newer hello replaces an older hold (the service has only one connection at a time).
      if (held) {const old = held; held = undefined; clearTimeout(old.timer); old.socket.destroy();}
      const hold = held = {socket, hello: frame, heldAt: now(), timer: undefined};
      hold.timer = setTimeout(() => expire(hold), holdLimitMs);
      socket.once('close', () => {if (held === hold) {held = undefined; clearTimeout(hold.timer);}});
      startHeld();
    });
    socket.on('data', bytes => {try {read(bytes);} catch {socket.destroy();}});
  });
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(endpoint, resolve);});
  return {
    endpoint,
    /** Lets the next durable connection through: the one held now, or the next durable hello. */
    admit: () => {admissions++; startHeld();},
    statistics: () => ({attempts, refusedLiveOnly, expiredHolds, admissionsPending: admissions, held: Boolean(held), connections: structuredClone(connections)}),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      if (held) {clearTimeout(held.timer); held = undefined;}
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    }
  };
}
