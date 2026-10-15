import {expect, it, vi} from 'vitest';
import type {AppHealth, ScaffoldStatus} from '../../packages/contracts/src';
import {createStartupLine} from '../../apps/desktop/src/dashboard-startup';

const ready: ScaffoldStatus = {service: 'ready', storage: 'verified', synthetic: true};
const health = (service: AppHealth['service']): AppHealth => ({service, storage: service === 'ready' ? 'verified' : 'pending', recording: 'unavailable', lastError: null});
const flush = async () => {for (let turn = 0; turn < 5; turn++) await Promise.resolve();};
function fixture(answers: (ScaffoldStatus | null | Error)[]) {
  const getStatus = vi.fn(() => {const answer = answers.shift() ?? null; return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);});
  const publish = vi.fn<(text: string) => void>();
  return {getStatus, publish, line: createStartupLine(getStatus, publish), last: () => publish.mock.lastCall?.[0]};
}

it('shows the unchanged ready text on a normal start', async () => {
  const f = fixture([ready]); f.line.start(); await flush();
  expect(f.last()).toBe('Telemetry service ready; isolated storage probe verified');
  f.line.health(health('ready')); await flush();
  expect(f.getStatus).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce();
});

it('waits instead of failing when opened during a restart, then shows ready after the service recovers', async () => {
  const f = fixture([null, ready]); f.line.start(); f.line.health(health('restarting')); await flush();
  expect(f.last()).toBe('Waiting for the telemetry service');
  expect(f.publish.mock.calls.flat()).not.toContain('Startup failed');
  f.line.health(health('ready')); await flush();
  expect(f.getStatus).toHaveBeenCalledTimes(2);
  expect(f.last()).toBe('Telemetry service ready; isolated storage probe verified');
});

it('keeps waiting after restart exhaustion and never reports startup failure for a not-ready answer', async () => {
  const f = fixture([null]); f.line.start(); await flush();
  f.line.health(health('failed')); await flush();
  expect(f.last()).toBe('Waiting for the telemetry service');
  expect(f.publish.mock.calls.flat()).not.toContain('Startup failed');
});

it('reports a rejected query as failed but recovers on the next readiness', async () => {
  const f = fixture([new Error('Untrusted status request'), ready]); f.line.start(); await flush();
  expect(f.last()).toBe('Startup failed');
  f.line.health(health('restarting')); f.line.health(health('ready')); await flush();
  expect(f.last()).toBe('Telemetry service ready; isolated storage probe verified');
});

it('does not let a superseded query failure replace a later ready answer', async () => {
  let reject!: (error: Error) => void;
  const getStatus = vi.fn().mockReturnValueOnce(new Promise<ScaffoldStatus | null>((_resolve, fail) => {reject = fail;})).mockResolvedValueOnce(ready);
  const publish = vi.fn(); const line = createStartupLine(getStatus, publish);
  line.start(); line.health(health('ready')); await flush();
  reject(new Error('late')); await flush();
  expect(publish.mock.lastCall?.[0]).toBe('Telemetry service ready; isolated storage probe verified');
  expect(publish.mock.calls.flat()).not.toContain('Startup failed');
});
