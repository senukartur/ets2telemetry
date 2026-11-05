// The simulated plugin has its own event loop, like the real game's transport worker. Playwright/trace work must
// not stop its 100 ms snapshots and accidentally trigger the production consumer's 500 ms stale boundary.
import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {startHardModeSource} from './hard-mode-observation.mjs';

if (!isMainThread) {
  const source = await startHardModeSource(workerData);
  const state = () => ({errors: source.errors, peerDisconnects: source.peerDisconnects, connected: source.connected()});
  const timer = setInterval(() => parentPort.postMessage({state: state()}), 100);
  parentPort.on('message', async ({id, method, args}) => {
    try {
      const value = await source[method](...args);
      parentPort.postMessage({id, value, state: state()});
      if (method === 'stop') {clearInterval(timer); parentPort.close();}
    } catch {parentPort.postMessage({id, error: 'HARD_MODE_SOURCE_COMMAND_FAILED', state: state()});}
  });
  parentPort.postMessage({ready: source.endpoint, state: state()});
}

export function startHardModeWorker(config) {
  const worker = new Worker(new URL(import.meta.url), {workerData: config});
  const errors = [], peerDisconnects = [], pending = new Map();
  let connected = false, next = 0, stopping, failure, readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => {readyResolve = resolve; readyReject = reject;});
  const exited = new Promise(resolve => worker.once('exit', resolve));
  const fail = () => {
    failure ??= new Error('HARD_MODE_SOURCE_WORKER_FAILED');
    if (!errors.includes(failure.message)) errors.push(failure.message);
    connected = false; readyReject(failure);
    for (const request of pending.values()) request.reject(failure);
    pending.clear();
  };
  worker.on('error', fail);
  worker.on('exit', code => {if (!stopping || code !== 0 || pending.size) fail();});
  worker.on('message', message => {
    if (message.state) {
      errors.splice(0, errors.length, ...message.state.errors);
      peerDisconnects.splice(0, peerDisconnects.length, ...message.state.peerDisconnects);
      connected = message.state.connected;
    }
    if (message.ready) readyResolve(message.ready);
    const request = pending.get(message.id);
    if (request) {
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  });
  const call = (method, ...args) => {
    if (failure) return Promise.reject(failure);
    const id = ++next;
    return new Promise((resolve, reject) => {pending.set(id, {resolve, reject}); worker.postMessage({id, method, args});});
  };
  return ready.then(endpoint => ({endpoint, errors, peerDisconnects, connected: () => connected,
    settings: value => call('settings', value), begin: label => call('begin', label), deliver: () => call('deliver'),
    stop: () => stopping ??= (async () => {
      try {await call('stop'); await exited;} catch (error) {await worker.terminate(); throw error;}
    })()
  }));
}
