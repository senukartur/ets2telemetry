// ET-010c decision F4: the one combiner of the v0 observation and the v1 projection, shared by the dashboard card and
// the overlay. Expected texts are written by hand from tests/fixtures/protocol-v0/checkpoint.json and
// tests/fixtures/protocol-v1/snapshot-live.json in the ETS2 metric profile.
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import {resolveDisplayUnits} from '../../packages/telemetry-core/src/display-profile';
import {initialLive} from '../../apps/desktop/src/live-state';
import {liveSources} from '../../apps/desktop/src/live-sources';
import {smokePair, smokeV0, v1Projection} from '../shared/live-v1-fixtures';

const METRIC = resolveDisplayUnits('ets2', {profile: 'metric'});
const sources = (live: LiveTelemetry) => liveSources(live, METRIC);
const NOT_CURRENT = {state: 'missing', text: 'unavailable', reason: 'not-current'};

describe('one source per field', () => {
  it('takes every field v0 carries from v0, even when v1 reports another value (R1 against gear 3)', () => {
    const combined = sources(smokePair());
    expect(combined).toMatchObject({v1Carried: true, v1Current: true, job: 'match', paused: false});
    expect(combined.field('gear')).toMatchObject({state: 'value', text: 'R1'});
    expect(combined.field('odometer')).toMatchObject({state: 'value', text: '1234.6 km'});
    // v1 reports 1263 km; the row stays v0's, which is not observed.
    expect(combined.field('estimated-range')).toMatchObject({state: 'missing', reason: 'not-observed'});
    expect(combined.field('truck')).toMatchObject({state: 'value', text: 'truck.volvo'});
    expect(combined.field('planned-distance')).toMatchObject({state: 'value', text: '200 km'});
  });
  it('takes the fields only v1 carries from v1', () => {
    const combined = sources(smokePair());
    expect(combined.field('route-remaining')).toMatchObject({state: 'value', text: '151.0 km'});
    expect(combined.field('deadline')).toMatchObject({state: 'value', text: 'in 10 h 55 min', notes: ['game-time']});
    expect(combined.field('cargo-mass')).toMatchObject({state: 'value', text: '18.0 t'});
    expect(combined.field('truck-plate')).toMatchObject({state: 'value', text: 'SYN 0001'});
    expect(combined.field('trailers')).toMatchObject({state: 'value', text: 'dryvan'});
    expect(combined.field('position')).toMatchObject({state: 'value', text: 'x -31234.5, y 42.3, z 18800.8'});
    expect(combined.field('bearing')).toMatchObject({state: 'value', text: '270°'});
    expect(combined.field('game-mode')).toMatchObject({state: 'value', text: 'single-player (weak evidence, module-scan)'});
    expect(combined.field('event-loss')).toMatchObject({state: 'value', text: '2'});
  });
  it('formats v1 fields in the displayed profile: 18000 kg is 39683 lb', () => {
    const combined = liveSources(smokePair(), resolveDisplayUnits('ets2', {profile: 'us-customary'}));
    expect(combined.field('cargo-mass')).toMatchObject({state: 'value', text: '39683 lb'});
    expect(combined.field('route-remaining')).toMatchObject({state: 'value', text: '93.8 mi'});
  });
  it('hides every v1-only field without a v1 observation, as before ET-010c', () => {
    for (const live of [smokeV0(), {...smokeV0(), v1: {...v1Projection(), observation: undefined, fresh: false, status: 'waiting' as const}}]) {
      const combined = sources(live);
      expect(combined).toMatchObject({v1Carried: false, v1Current: false});
      for (const id of ['route-remaining', 'deadline', 'source-city', 'position', 'game-mode', 'event-loss'] as const) expect(combined.field(id).state).toBe('hidden');
      expect(combined.field('cargo')).toMatchObject({state: 'value', text: 'cargo.logs'});
    }
  });
  it('ignores a projection of another selection', () => {
    const combined = sources({...smokeV0(), v1: v1Projection('snapshot-live', {selection: 'replay'})});
    expect(combined.v1Carried).toBe(false);
    expect(combined.field('route-remaining').state).toBe('hidden');
  });
});

describe('localized names (decision F4(c))', () => {
  it('shows the v1 names of the same job while both sources are current', () => {
    const combined = sources(smokePair());
    expect(combined.field('cargo')).toMatchObject({state: 'value', text: 'Synthetic Cargo'});
    expect(combined.field('destination-city')).toMatchObject({state: 'value', text: 'Synthetic City B'});
  });
  it('keeps the v0 ids for another job, a stale v1 source or without v1', () => {
    for (const live of [smokePair({ids: 'fixture'}), smokePair({status: 'stale', fresh: false, reason: 'No recent SDK capture'}), smokeV0()]) {
      const combined = sources(live);
      expect(combined.field('cargo')).toMatchObject({state: 'value', text: 'cargo.logs'});
      expect(combined.field('destination-city')).toMatchObject({state: 'value', text: 'city.warszawa'});
    }
  });
  it('keeps the v0 presence and currentness: a stale v0 row stays not current', () => {
    const combined = sources(smokePair({}, {status: 'stale', fresh: false}));
    expect(combined.field('cargo')).toMatchObject(NOT_CURRENT);
    expect(combined.field('destination-city')).toMatchObject(NOT_CURRENT);
  });
});

describe('job identity guard (decision F4(b))', () => {
  it('shows v1 job fields as not current for another cargo or destination city, and leaves the other v1 fields alone', () => {
    const combined = sources(smokePair({ids: 'fixture'}));
    expect(combined.job).toBe('mismatch');
    for (const id of ['deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job'] as const)
      expect(combined.field(id), id).toMatchObject(NOT_CURRENT);
    // SDK 1.15 defines cargo loaded only for the cargo market; v1's own job is a freight market job, so it stays hidden.
    expect(combined.field('cargo-loaded').state).toBe('hidden');
    expect(combined.field('route-remaining')).toMatchObject({state: 'value', text: '151.0 km'});
    expect(combined.field('position')).toMatchObject({state: 'value', text: 'x -31234.5, y 42.3, z 18800.8'});
    expect(combined.field('truck-plate')).toMatchObject({state: 'value', text: 'SYN 0001'});
  });
  it('treats a v1 source without a job as another job', () => {
    const live = smokePair();
    live.v1!.observation!.state.configuration.job = {available: false, reason: 'not-observed'};
    const combined = sources(live);
    expect(combined.job).toBe('mismatch');
    expect(combined.field('source-city')).toMatchObject(NOT_CURRENT);
    expect(combined.field('cargo-loaded')).toMatchObject(NOT_CURRENT);
  });
  it('reports no job comparison, never another job, without a carried v1 observation (fix round 1)', () => {
    for (const live of [smokeV0(), {...smokeV0(), v1: v1Projection('snapshot-live', {selection: 'replay'})},
      {...smokeV0(), v1: {...v1Projection(), observation: undefined, fresh: false, status: 'waiting' as const}}]) {
      const combined = sources(live);
      expect(combined.job).toBe('no-v1');
      expect(combined.field('cargo')).toMatchObject({state: 'value', text: 'cargo.logs'});
    }
  });
  it('hides v1 job fields without a v0 job, without a v0 observation, and keeps the non-job fields', () => {
    const noJob = smokePair();
    noJob.observation!.state.configuration.job = {available: false, reason: 'not-observed'};
    const withoutV0: LiveTelemetry = {...initialLive('synthetic'), v1: v1Projection()};
    for (const live of [noJob, withoutV0]) {
      const combined = sources(live);
      expect(combined.job).toBe('none');
      for (const id of ['deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job', 'cargo-loaded'] as const)
        expect(combined.field(id).state, id).toBe('hidden');
      expect(combined.field('route-remaining')).toMatchObject({state: 'value', text: '151.0 km'});
      expect(combined.field('bearing')).toMatchObject({state: 'value', text: '270°'});
    }
  });
});

describe('currentness and origin (decisions F3, F4(d) and F4(e))', () => {
  it('shows current v1 values while v0 is stale, and no v0-carried value from v1', () => {
    const combined = sources(smokePair({}, {status: 'stale', fresh: false}));
    expect(combined).toMatchObject({v1Current: true, job: 'match'});
    expect(combined.field('gear')).toMatchObject(NOT_CURRENT);
    expect(combined.field('source-city')).toMatchObject({state: 'value', text: 'Synthetic City A'});
  });
  it('shows no v0 field without a v0 observation, although v1 reports gear 3', () => {
    const combined = sources({...initialLive('synthetic'), v1: v1Projection()});
    expect(combined.field('gear')).toMatchObject(NOT_CURRENT);
    expect(combined.field('engine-rpm')).toMatchObject(NOT_CURRENT);
  });
  it('keeps a disconnected v1 observation with every v1 field unavailable as not current', () => {
    const combined = sources(smokePair({status: 'disconnected', fresh: false, reason: 'Source closed; interval coverage unknown'}));
    expect(combined).toMatchObject({v1Carried: true, v1Current: false});
    for (const id of ['route-remaining', 'source-city', 'deadline', 'position', 'bearing', 'truck-plate', 'trailers', 'game-mode', 'event-loss'] as const)
      expect(combined.field(id), id).toMatchObject(NOT_CURRENT);
    expect(combined.field('deadline').notes).toEqual(['game-time']);
  });
  it.each([
    ['origin', {origin: 'replay' as const}],
    ['game', {game: 'ats' as const}]
  ])('does not use v1 data of another %s than the v0 observation', (_name, options) => {
    const combined = sources(smokePair(options));
    expect(combined).toMatchObject({v1Carried: false, v1Current: false});
    expect(combined.field('route-remaining').state).toBe('hidden');
    expect(combined.field('cargo')).toMatchObject({state: 'value', text: 'cargo.logs'});
  });
  it('lets v0 decide the paused state while current, then current v1 data', () => {
    expect(sources(smokePair({status: 'paused'})).paused).toBe(false);
    expect(sources(smokePair({}, {status: 'paused'})).paused).toBe(true);
    expect(sources(smokePair({status: 'paused'}, {status: 'stale', fresh: false})).paused).toBe(true);
    expect(sources(smokePair({}, {status: 'stale', fresh: false})).paused).toBe(false);
    expect(sources(smokePair({status: 'stale', fresh: false, reason: 'No recent SDK capture'}, {status: 'stale', fresh: false})).paused).toBe(false);
    const simulation = smokePair({}, {status: 'stale', fresh: false});
    simulation.v1!.observation!.state.simulation = 'paused';
    expect(sources(simulation).paused).toBe(true);
  });
});
