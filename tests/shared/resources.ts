import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

// One resource owner per test. No production history or game directory is accepted.
export async function temporaryResources() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-test-'));
  return {
    directory,
    database: path.join(directory, 'synthetic.sqlite'),
    pipe: `\\\\.\\pipe\\ets2telemetry-test-${randomUUID()}`,
    async dispose() {await rm(directory, {recursive: true, force: true});}
  };
}

// Domain tests opt in to a controlled clock and stable project-owned identities.
export function deterministicContext(initialMilliseconds = 0) {
  let milliseconds = initialMilliseconds;
  let identity = 0;
  return {
    now: () => milliseconds,
    nextId: () => `synthetic-${++identity}`,
    advance(delta: number) {
      if (!Number.isFinite(delta) || delta < 0) throw new RangeError('Clock must advance by finite nonnegative time');
      milliseconds += delta;
    }
  };
}
