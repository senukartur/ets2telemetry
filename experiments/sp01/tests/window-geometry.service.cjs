'use strict';
// Synthetic lifecycle fixture only; no telemetry, storage or game transport.
const timer = setInterval(() => process.parentPort.postMessage({ type: 'heartbeat' }), 50);
process.parentPort.on('message', ({ data }) => {
  if (data?.type === 'stop') { clearInterval(timer); process.exit(0); }
});
