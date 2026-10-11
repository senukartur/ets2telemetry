'use strict';
const net = require('node:net');
const { Decoder } = require('./codec.cjs');
const game = process.argv[2];
const sid = process.argv[3];
const suffix = process.argv[4] ?? '';
if (!['eut2', 'ats'].includes(game) || !/^S-1-[0-9-]+$/.test(sid) || !process.parentPort || (suffix && !/^\.synthetic\.[1-9][0-9]{0,9}$/.test(suffix))) process.exit(2);
const pipe = `\\\\.\\pipe\\ETS2Telemetry.SP01.${sid}.${game}${suffix}`;
let socket, retry, latest, lastReceived = 0, lastFrame = '', lastFrameChanged = 0, stopped = false;
function connect() {
  if (stopped) return;
  const decoder = new Decoder(game);
  socket = net.createConnection(pipe);
  socket.on('data', (chunk) => {
    try {
      for (const frame of decoder.push(chunk)) {
        latest = frame; lastReceived = performance.now();
        if (frame.frame !== lastFrame) { lastFrame = frame.frame; lastFrameChanged = lastReceived; }
      }
    } catch { socket.destroy(); latest = undefined; }
  });
  socket.on('error', () => {});
  socket.on('close', () => { latest = undefined; lastFrame = ''; lastFrameChanged = 0; if (!stopped) retry = setTimeout(connect, 250); });
}
const timer = setInterval(() => {
  const now = performance.now();
  const current = latest && now - lastReceived <= 500 && (latest.paused || now - lastFrameChanged <= 1000);
  process.parentPort.postMessage({ type: 'snapshot', value: current ? latest : null });
}, 50);
process.parentPort.on('message', ({ data }) => {
  if (data?.type !== 'stop') return;
  stopped = true; clearInterval(timer); clearTimeout(retry); socket?.destroy(); process.exit(0);
});
connect();
