import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {dashboardSpeed} from '../../apps/desktop/src/speed-display';

function live(): LiveTelemetry {
  const snapshot = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot');
  return {...initialLive('ets2'), status: 'connected', fresh: true, observation: {
    source: {...snapshot.source, origin: 'game'}, state: snapshot.data.state, capture: snapshot.capture, seq: snapshot.seq,
    receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: snapshot.data.continuity}
  }};
}

it.each([
  {raw: -0.001, displayed: '0.0 km/h'},
  {raw: -0, displayed: '0.0 km/h'},
  {raw: 0, displayed: '0.0 km/h'},
  // Straddle 0.05 km/h on both sides, safely away from binary rounding ties.
  {raw: -0.0136, displayed: '0.0 km/h'},
  {raw: -0.0142, displayed: '-0.1 km/h'},
  {raw: 0.0136, displayed: '0.0 km/h'},
  {raw: 0.0142, displayed: '0.1 km/h'},
  {raw: -2, displayed: '-7.2 km/h'},
  {raw: 10, displayed: '36.0 km/h'}
])('projects dashboard speed $raw m/s as $displayed without changing telemetry', ({raw, displayed}) => {
  const current = live();
  current.observation!.state.speed = {available: true, value: raw, unit: 'm/s'};
  const before = structuredClone(current);
  expect(dashboardSpeed(current)).toBe(displayed);
  expect(current).toStrictEqual(before);
  expect(current.observation!.state.speed.value).toBe(raw);
});

it.each(['not-started', 'no-observation', 'missing-channel', 'stale'] as const)('keeps %s dashboard speed unavailable', fault => {
  const current = live();
  current.observation!.state.speed = {available: true, value: -0.001, unit: 'm/s'};
  if (fault === 'not-started') {expect(dashboardSpeed(undefined)).toBe('unavailable'); return;}
  if (fault === 'no-observation') current.observation = undefined;
  if (fault === 'missing-channel') current.observation!.state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  if (fault === 'stale') {current.fresh = false; current.status = 'stale';}
  expect(dashboardSpeed(current)).toBe('unavailable');
});

it.each(['ets2', 'ats', 'synthetic', 'replay'] as const)('retains diagnostic km/h for fresh %s telemetry', selection => {
  const current = live();
  current.selection = selection;
  current.observation!.source.game = selection === 'ats' ? 'ats' : 'ets2';
  current.observation!.source.origin = selection === 'synthetic' || selection === 'replay' ? selection : 'game';
  current.observation!.state.speed = {available: true, value: 10, unit: 'm/s'};
  expect(dashboardSpeed(current)).toBe('36.0 km/h');
  current.status = 'paused';
  expect(dashboardSpeed(current)).toBe('36.0 km/h');
});
