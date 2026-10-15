import {expect, it} from 'vitest';
import {failureCode, initialHealth, reduceHealth, sameHealth, type HealthEvent} from '../../apps/desktop/src/app-health';

const run = (...events: HealthEvent[]) => events.reduce(reduceHealth, initialHealth());

it('starts pending with recording unavailable and becomes ready only on readiness', () => {
  expect(initialHealth()).toEqual({service: 'starting', storage: 'pending', recording: 'unavailable', lastError: null});
  expect(run({type: 'service-ready'})).toEqual({service: 'ready', storage: 'verified', recording: 'unavailable', lastError: null});
});

it('never returns to ready after a failure without a new readiness', () => {
  const failed = run({type: 'service-ready'}, {type: 'service-exited', afterFailure: false});
  expect(failed).toMatchObject({service: 'failed', storage: 'pending', lastError: 'SERVICE_EXITED'});
  const restarting = reduceHealth(failed, {type: 'service-restarting'});
  expect(restarting).toMatchObject({service: 'restarting', storage: 'pending'});
  for (const event of [{type: 'service-restarting'}, {type: 'service-exited', afterFailure: false}] as HealthEvent[]) expect(reduceHealth(restarting, event).service).not.toBe('ready');
  // The last problem stays visible after recovery.
  expect(reduceHealth(restarting, {type: 'service-ready'})).toEqual({service: 'ready', storage: 'verified', recording: 'unavailable', lastError: 'SERVICE_EXITED'});
});

it('keeps a reported failure cause through the induced exit and shows a failed storage self-test', () => {
  const health = run({type: 'service-ready'}, {type: 'service-failure', code: 'STORAGE_FAILED'}, {type: 'service-exited', afterFailure: true}, {type: 'service-restarting'});
  expect(health).toEqual({service: 'restarting', storage: 'failed', recording: 'unavailable', lastError: 'STORAGE_FAILED'});
  expect(run({type: 'service-ready'}, {type: 'service-failure', code: 'SERVICE_START_TIMEOUT'}, {type: 'service-exited', afterFailure: true}))
    .toMatchObject({service: 'failed', lastError: 'SERVICE_START_TIMEOUT'});
});

it('keeps restart exhaustion failed and makes an exit request final', () => {
  const exhausted = run({type: 'service-ready'}, {type: 'service-exited', afterFailure: false}, {type: 'service-restart-exhausted'});
  expect(exhausted).toMatchObject({service: 'failed', lastError: 'SERVICE_RESTART_EXHAUSTED'});
  const stopping = reduceHealth(exhausted, {type: 'exit-requested'});
  expect(stopping.service).toBe('stopping');
  for (const event of [{type: 'service-ready'}, {type: 'service-restarting'}, {type: 'service-exited', afterFailure: false}, {type: 'service-failure', code: 'STORAGE_FAILED'}] as HealthEvent[])
    expect(reduceHealth(stopping, event)).toBe(stopping);
});

it('maps supervisor and service report codes to fixed application error codes only', () => {
  expect(failureCode('SERVICE_START_TIMEOUT')).toBe('SERVICE_START_TIMEOUT');
  for (const code of ['STORAGE_TIMEOUT', 'STORAGE_PROBE_FAILED', 'STORAGE_WORKER_FAILED', 'STORAGE_WORKER_EXIT']) expect(failureCode('SERVICE_START_FAILED', code)).toBe('STORAGE_FAILED');
  for (const code of ['INVALID_SOURCE_COMMAND', undefined, 42, 'C:\\path\\STORAGE_']) expect(failureCode('SERVICE_START_FAILED', code)).toBe('SERVICE_EXITED');
});

it('compares health by value', () => {
  expect(sameHealth(initialHealth(), initialHealth())).toBe(true);
  expect(sameHealth(initialHealth(), run({type: 'service-ready'}))).toBe(false);
});
