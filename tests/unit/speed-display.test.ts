import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {dashboardFuel, dashboardSpeed} from '../../apps/desktop/src/speed-display';

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
  {raw: -0.001, displayed: '0 km/h'},
  {raw: -0, displayed: '0 km/h'},
  {raw: 0, displayed: '0 km/h'},
  // Straddle 0.05 km/h on both sides, safely away from binary rounding ties.
  {raw: -0.136, displayed: '0 km/h'},
  {raw: -0.142, displayed: '-1 km/h'},
  {raw: 0.136, displayed: '0 km/h'},
  {raw: 0.142, displayed: '1 km/h'},
  {raw: -2, displayed: '-7 km/h'},
  {raw: 10, displayed: '36 km/h'}
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

// dashboardSpeed without a profile argument defaults to metric for every source; the dashboard itself passes the
// displayed game's profile (see unit-profiles.test.ts for the ATS US customary default).
it.each(['ets2', 'ats', 'synthetic', 'replay'] as const)('defaults dashboardSpeed to metric when no profile is given for fresh %s telemetry', selection => {
  const current = live();
  current.selection = selection;
  current.observation!.source.game = selection === 'ats' ? 'ats' : 'ets2';
  current.observation!.source.origin = selection === 'synthetic' || selection === 'replay' ? selection : 'game';
  current.observation!.state.speed = {available: true, value: 10, unit: 'm/s'};
  expect(dashboardSpeed(current)).toBe('36 km/h');
  current.status = 'paused';
  expect(dashboardSpeed(current)).toBe('36 km/h');
});

// ET-011b: the dashboard follows the persisted profile of the displayed game.
it.each([
  {profile: 'metric' as const, raw: 25, liters: 73, speed: '90 km/h', fuel: '73.0 L'},
  {profile: 'us-customary' as const, raw: 25, liters: 73, speed: '56 mph', fuel: '19.3 US gal'},
  {profile: 'us-customary' as const, raw: -0.001, liters: -0, speed: '0 mph', fuel: '0.0 US gal'},
  {profile: 'us-customary' as const, raw: -2, liters: 0, speed: '-4 mph', fuel: '0.0 US gal'}
])('projects dashboard speed $raw m/s and fuel $liters L in $profile', ({profile, raw, liters, speed, fuel}) => {
  const current = live();
  current.observation!.state.speed = {available: true, value: raw, unit: 'm/s'};
  current.observation!.state.fuel = {available: true, value: liters, unit: 'L'};
  expect(dashboardSpeed(current, profile)).toBe(speed);
  expect(dashboardFuel(current, profile)).toBe(fuel);
});

it.each(['not-started', 'missing-channel', 'stale'] as const)('keeps %s dashboard fuel unavailable in every profile', fault => {
  const current = live();
  current.observation!.state.fuel = {available: true, value: 0, unit: 'L'};
  if (fault === 'missing-channel') current.observation!.state.fuel = {available: false, reason: 'not-observed', unit: 'L'};
  if (fault === 'stale') {current.fresh = false; current.status = 'stale';}
  for (const profile of ['metric', 'us-customary'] as const) expect(dashboardFuel(fault === 'not-started' ? undefined : current, profile)).toBe('unavailable');
});
