import {expect, it} from 'vitest';
import {failureCode, initialHealth, reduceHealth, sameHealth, type HealthEvent} from '../../apps/desktop/src/app-health';

const run = (...events: HealthEvent[]) => events.reduce(reduceHealth, initialHealth());

it('starts pending with an unknown recording status and becomes ready only on readiness', () => {
  expect(initialHealth()).toEqual({service: 'starting', storage: 'pending', recording: {state: 'unknown'}, lastError: null});
  expect(run({type: 'service-ready'})).toEqual({service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: null});
});

it('never returns to ready after a failure without a new readiness', () => {
  const failed = run({type: 'service-ready'}, {type: 'service-exited', afterFailure: false});
  expect(failed).toMatchObject({service: 'failed', storage: 'pending', lastError: 'SERVICE_EXITED'});
  const restarting = reduceHealth(failed, {type: 'service-restarting'});
  expect(restarting).toMatchObject({service: 'restarting', storage: 'pending'});
  for (const event of [{type: 'service-restarting'}, {type: 'service-exited', afterFailure: false}] as HealthEvent[]) expect(reduceHealth(restarting, event).service).not.toBe('ready');
  // The last problem stays visible after recovery.
  expect(reduceHealth(restarting, {type: 'service-ready'})).toEqual({service: 'ready', storage: 'verified', recording: {state: 'unknown'}, lastError: 'SERVICE_EXITED'});
});

it('keeps a reported failure cause through the induced exit and shows a failed storage self-test', () => {
  const health = run({type: 'service-ready'}, {type: 'service-failure', code: 'STORAGE_FAILED'}, {type: 'service-exited', afterFailure: true}, {type: 'service-restarting'});
  expect(health).toEqual({service: 'restarting', storage: 'failed', recording: {state: 'unknown'}, lastError: 'STORAGE_FAILED'});
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

// ET-015c (G4, G5, G12): the recording status of the current service, written by hand.
const RECORDING = {state: 'recording', target: 'synthetic', code: null, losses: {lostEvents: 0, eventLoss: 0, notConnected: 1, sampleLoss: 0, restoreLoss: 0, droppedSamples: 0},
  trip: {phase: 'active', completeness: 'partial', untrackedJob: false}} as const;
it('keeps a reported recording status through readiness and resets it to unknown whenever the service fails, exits or restarts', () => {
  // A status reported before readiness stays; readiness never clears it.
  const reported = run({type: 'recording', status: RECORDING}, {type: 'service-ready'});
  expect(reported).toEqual({service: 'ready', storage: 'verified', recording: RECORDING, lastError: null});
  expect(run({type: 'service-ready'}, {type: 'recording', status: {state: 'disabled'}}, {type: 'service-ready'}).recording).toEqual({state: 'disabled'});
  for (const event of [{type: 'service-failure', code: 'STORAGE_FAILED'}, {type: 'service-exited', afterFailure: false}, {type: 'service-restarting'},
    {type: 'service-restart-exhausted'}] as HealthEvent[]) expect(reduceHealth(reported, event).recording, event.type).toEqual({state: 'unknown'});
  // A new service's report after the restart replaces unknown.
  const restarted = run({type: 'recording', status: RECORDING}, {type: 'service-ready'}, {type: 'service-exited', afterFailure: false}, {type: 'service-restarting'},
    {type: 'recording', status: {state: 'disabled'}}, {type: 'service-ready'});
  expect(restarted).toEqual({service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: 'SERVICE_EXITED'});
});

it('ignores recording reports once exiting and compares the recording status by value', () => {
  const stopping = run({type: 'recording', status: RECORDING}, {type: 'exit-requested'});
  expect(reduceHealth(stopping, {type: 'recording', status: {state: 'disabled'}})).toBe(stopping);
  const recording = run({type: 'recording', status: RECORDING});
  expect(sameHealth(recording, run({type: 'recording', status: structuredClone(RECORDING)}))).toBe(true);
  expect(sameHealth(recording, initialHealth())).toBe(false);
  expect(sameHealth(recording, run({type: 'recording', status: {...RECORDING, losses: {...RECORDING.losses, notConnected: 2}}}))).toBe(false);
});
