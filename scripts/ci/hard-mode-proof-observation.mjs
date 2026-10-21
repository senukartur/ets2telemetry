import {performance} from 'node:perf_hooks';

/** Drive the existing trusted refresh boundary while observing genuine, persisted positive proof. */
export async function waitForHardModeProof({refresh, read, accept, record, message, timeoutMs = 8000}) {
  const started = performance.now();
  let active = true, deadline, poll, wake;
  record.refreshRequests = 0;
  const observe = async () => {
    while (active) {
      record.phase = 'refresh'; record.refreshRequests++;
      await refresh();
      if (!active) return;
      record.phase = 'read';
      const status = await read();
      if (!active) return;
      record.lastStatus = status;
      if (status.trip?.firstLoss) throw new Error(`${message}_QUALIFICATION_LOST`);
      record.phase = 'accept';
      const accepted = await accept(status);
      if (!active) return;
      if (accepted) {record.phase = 'complete'; return status;}
      record.phase = 'poll';
      await new Promise(resolve => {wake = resolve; poll = setTimeout(resolve, 100);});
    }
  };
  try {
    return await Promise.race([observe(), new Promise((_, reject) => {
      // One bound covers every pending trusted request, status read, predicate and poll; it is never reset.
      deadline = setTimeout(() => {active = false; wake?.(); reject(new Error(`${message} within ${timeoutMs} ms`));}, timeoutMs);
    })]);
  } finally {
    active = false; clearTimeout(deadline); clearTimeout(poll); wake?.();
    record.elapsedMilliseconds = Math.round(performance.now() - started);
  }
}
