// ET-010b live telemetry card text: REG-009, with partial REG-002 (paused banner) and REG-003 (hydrated checkpoint
// shown live) protection for the live display only. Expected texts are written by hand from the shared v0 fixtures,
// the exact unit definitions and docs/live-telemetry-fields.md, never produced by the code under test.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {LEGACY_ROW_IDS, liveDashboardText, type LiveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {initialLive} from '../../apps/desktop/src/live-state';
import {FIELD_NOTE_TEXT, LIVE_FIELD_TEXT} from '../../apps/desktop/src/strings';
import {SYNTHETIC_V0_HIDDEN_ROWS, SYNTHETIC_V0_LIVE_ROWS, SYNTHETIC_V0_VALUE_IDS} from '../../scripts/ci/renderer-observation.mjs';

type V0State = Extract<v0.ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
function v0Message(name: string): V0State {
  const message = v0.decodePayload(new Uint8Array(readFileSync(`tests/fixtures/protocol-v0/${name}.json`)));
  if (message.kind !== 'checkpoint' && message.kind !== 'snapshot') throw new Error(`${name} is not a state message`);
  return message;
}
function live(name: string, selection: LiveTelemetry['selection'], patch: Partial<LiveTelemetry> = {}): LiveTelemetry {
  const message = v0Message(name);
  return {
    selection, status: 'connected', reason: 'Validated current observation', fresh: true, recording: false, coverage: 'unknown',
    observation: {
      source: message.source, state: message.data.state, seq: message.seq, capture: message.capture,
      receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
      applied: {hydration: message.kind === 'checkpoint', skippedSequences: '0', continuity: message.data.continuity}
    },
    ...patch
  };
}
/** The checkpoint as scripts/ci/live-smoke-source.mjs serves it: 25 m/s and 73 L under the synthetic selection. */
function smokeCheckpoint(patch: Partial<LiveTelemetry> = {}): LiveTelemetry {
  const telemetry = live('checkpoint', 'synthetic', patch);
  telemetry.observation!.state.speed = {available: true, value: 25, unit: 'm/s'};
  telemetry.observation!.state.fuel = {available: true, value: 73, unit: 'L'};
  return telemetry;
}
/** Rendered elements in builder order: each row's value, then its reason and note, as [data-testid, text]. */
function rendered(text: LiveDashboardText): [string, string][] {
  return text.sections.flatMap(section => section.rows.flatMap(row => [
    [row.testId, row.value] as [string, string],
    ...(row.reason ? [[`${row.testId}-reason`, row.reason] as [string, string]] : []),
    ...(row.note ? [[`${row.testId}-note`, row.note] as [string, string]] : [])
  ]));
}
const values = (text: LiveDashboardText) => Object.fromEntries(text.sections.flatMap(section => section.rows.map(row => [row.id, row.value])));
const row = (text: LiveDashboardText, id: string) => text.sections.flatMap(section => section.rows).find(candidate => candidate.id === id);

describe('ET-010b card for the synthetic smoke checkpoint', () => {
  const text = liveDashboardText(smokeCheckpoint());
  it('renders exactly the smoke rows, in order', () => {
    expect(rendered(text)).toEqual(SYNTHETIC_V0_LIVE_ROWS.map(([id, value]) => [id, value]));
    expect(SYNTHETIC_V0_VALUE_IDS).toEqual(['live-gear', 'live-engine-rpm', 'live-fuel-capacity', 'live-fuel-level', 'live-sdk-average-consumption',
      'live-estimated-range', 'live-odometer', 'live-game-time', 'live-cargo', 'live-destination-city', 'live-planned-distance', 'live-expected-income', 'live-truck']);
  });
  it('labels sections and rows with the application strings', () => {
    expect(text.sections.map(section => [section.testId, section.title])).toEqual([
      ['live-section-motion', 'Driving'], ['live-section-fuel', 'Fuel'], ['live-section-distance', 'Distance'], ['live-section-time', 'Time'],
      ['live-section-job', 'Job'], ['live-section-vehicle', 'Vehicle']
    ]);
    expect(text.sections.flatMap(section => section.rows.map(entry => entry.label))).toEqual([
      'Gear', 'Engine RPM', 'Fuel capacity', 'Fuel level', 'SDK average consumption', 'Estimated range', 'Odometer', 'Game time', 'Cargo',
      'Destination city', 'Planned distance', 'Expected income', 'Truck'
    ]);
  });
  it('keeps speed and fuel in the legacy lines and renders no hidden or v0-uncarried row', () => {
    expect([...LEGACY_ROW_IDS]).toEqual(['speed', 'fuel']);
    const ids = rendered(text).map(([id]) => id);
    for (const id of SYNTHETIC_V0_HIDDEN_ROWS) expect(ids).not.toContain(id);
    expect(text.sections.map(section => section.id)).not.toContain('position');
    expect(text.paused).toBe(false);
    expect(text.sections.some(section => section.missing)).toBe(false);
  });
  it('shows a hydrated checkpoint job as current state only', () => {
    const telemetry = smokeCheckpoint();
    expect(telemetry.observation!.applied.hydration).toBe(true);
    expect(values(liveDashboardText(telemetry)).cargo).toBe('cargo.logs');
    expect(JSON.stringify(liveDashboardText(telemetry))).not.toMatch(/revenue|delivered|cancel|penalty/i);
  });
});

describe('ET-010b units and notes', () => {
  it('shows the ATS replay fixture in its US customary default with the ATS consumption note', () => {
    const text = liveDashboardText(live('ats', 'replay'));
    expect(values(text)).toMatchObject({
      'fuel-capacity': '264 US gal', 'sdk-average-consumption': '9.4 US mpg', 'odometer': '767.1 mi', 'planned-distance': '124 mi',
      'expected-income': '9007199254740993.123456 USD (SDK-documented)', 'gear': 'R1', 'game-time': 'Day 8574, 09:18'
    });
    expect(row(text, 'sdk-average-consumption')!.note).toBe('SDK mean, not a trip average; mostly static in ATS per the SDK header');
    expect(row(text, 'fuel-level')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
  });
  it('applies saved per-game profiles and the ET-000 defaults without settings', () => {
    const metric = liveDashboardText(smokeCheckpoint(), {ets2: 'metric', ats: 'us-customary'});
    expect(liveDashboardText(smokeCheckpoint())).toEqual(metric);
    expect(liveDashboardText(smokeCheckpoint(), undefined)).toEqual(metric);
    const us = liveDashboardText(smokeCheckpoint(), {ets2: 'us-customary', ats: 'metric'});
    expect(values(us)).toMatchObject({'fuel-capacity': '264 US gal', 'sdk-average-consumption': '9.4 US mpg', 'odometer': '767.1 mi', 'planned-distance': '124 mi', 'fuel-level': '7%'});
    expect(row(us, 'sdk-average-consumption')!.note).toBe('SDK mean, not a trip average');
    expect(values(liveDashboardText(live('ats', 'replay'), {ets2: 'us-customary', ats: 'metric'}))).toMatchObject({
      'fuel-capacity': '1000 L', 'sdk-average-consumption': '25.0 L/100 km', 'odometer': '1234.6 km', 'planned-distance': '200 km'
    });
  });
  it('uses metric under "Select a game" while the note follows the source game (decision B5)', () => {
    const text = liveDashboardText(live('ats', 'game'));
    expect(values(text)).toMatchObject({'fuel-capacity': '1000 L', 'sdk-average-consumption': '25.0 L/100 km'});
    expect(row(text, 'sdk-average-consumption')!.note).toBe('SDK mean, not a trip average; mostly static in ATS per the SDK header');
  });
  it('never labels the SDK average consumption or any other row as a trip value', () => {
    expect(LIVE_FIELD_TEXT['sdk-average-consumption']).toBe('SDK average consumption');
    for (const label of Object.values(LIVE_FIELD_TEXT)) expect(label).not.toMatch(/trip/i);
    for (const note of Object.values(FIELD_NOTE_TEXT)) expect(note.replace('not a trip average', '')).not.toMatch(/trip/i);
    const all = liveDashboardText(undefined).sections.flatMap(section => section.rows);
    expect(all.find(entry => entry.id === 'sdk-average-consumption')!.label).toBe('SDK average consumption');
    for (const entry of all) expect(`${entry.label} ${entry.note ?? ''}`.replace('not a trip average', '')).not.toMatch(/trip/i);
  });
});

describe('ET-010b non-current, paused and missing input', () => {
  const FIXTURE_VALUES = /R1|cargo\.logs|truck\.volvo|city\.warszawa|1234\.6|600 rpm|Day 8574/;
  // Fix round 1: before the first observation the card shows only the fields v0 carries (review finding 1). The 15 v0
  // fields minus speed and fuel leave 13 rows; without the deadline the Time section keeps game time, and no Position.
  it.each([
    ['without any update', undefined],
    ['while waiting for an ATS source', initialLive('ats')],
    ['after a service restart without an observation', {...initialLive('synthetic'), status: 'restarting' as const}]
  ])('shows only the v0 rows, each not current, %s', (_name, telemetry) => {
    const text = liveDashboardText(telemetry);
    const rows = text.sections.flatMap(section => section.rows);
    expect(rows.map(entry => entry.testId)).toEqual(SYNTHETIC_V0_VALUE_IDS);
    expect(rows).toHaveLength(13);
    expect(text.sections.map(section => section.id)).toEqual(['motion', 'fuel', 'distance', 'time', 'job', 'vehicle']);
    for (const entry of rows) expect(entry).toMatchObject({value: 'unavailable', reason: 'not current'});
    for (const id of SYNTHETIC_V0_HIDDEN_ROWS) expect(rendered(text).map(([testId]) => testId)).not.toContain(id);
    expect(text.paused).toBe(false);
  });
  it.each(['waiting', 'stale', 'incompatible', 'disconnected', 'unavailable', 'service-failed', 'restarting'] as const)(
    'hides every carried value while %s', status => {
      const text = liveDashboardText(smokeCheckpoint({status, fresh: status !== 'stale' && status !== 'disconnected'}));
      expect(rendered(text).filter(([id]) => !/-(reason|note)$/.test(id)).map(([id]) => id)).toEqual(SYNTHETIC_V0_VALUE_IDS);
      for (const entry of text.sections.flatMap(section => section.rows)) expect(entry).toMatchObject({value: 'unavailable', reason: 'not current'});
      expect(JSON.stringify(text)).not.toMatch(FIXTURE_VALUES);
      expect(text.paused).toBe(false);
    });
  it('hides every value of a connected update that is not fresh', () => {
    const text = liveDashboardText(smokeCheckpoint({fresh: false}));
    expect(text.sections.flatMap(section => section.rows)).toHaveLength(13);
    for (const entry of text.sections.flatMap(section => section.rows)) expect(entry).toMatchObject({value: 'unavailable', reason: 'not current'});
    expect(JSON.stringify(text)).not.toMatch(FIXTURE_VALUES);
  });
  it('shows current values with the paused flag', () => {
    const paused = liveDashboardText(smokeCheckpoint({status: 'paused'}));
    expect(paused.paused).toBe(true);
    expect(rendered(paused)).toEqual(SYNTHETIC_V0_LIVE_ROWS.map(([id, value]) => [id, value]));
    const simulation = smokeCheckpoint();
    simulation.observation!.state.simulation = 'paused';
    expect(liveDashboardText(simulation).paused).toBe(true);
    expect(values(liveDashboardText(simulation)).gear).toBe('R1');
  });
  it('shows the unavailable fixture with reasons and the job section as no job reported', () => {
    const text = liveDashboardText(live('unavailable', 'synthetic'));
    expect(rendered(text)).toEqual([
      ['live-gear', 'unavailable'], ['live-gear-reason', 'not yet observed'],
      ['live-engine-rpm', 'unavailable'], ['live-engine-rpm-reason', 'not yet observed'],
      ['live-fuel-capacity', 'unavailable'], ['live-fuel-capacity-reason', 'not yet observed'],
      ['live-fuel-level', 'unavailable'], ['live-fuel-level-reason', 'not yet observed'],
      ['live-sdk-average-consumption', 'unavailable'], ['live-sdk-average-consumption-reason', 'not yet observed'], ['live-sdk-average-consumption-note', 'SDK mean, not a trip average'],
      ['live-estimated-range', 'unavailable'], ['live-estimated-range-reason', 'not yet observed'], ['live-estimated-range-note', "the game's estimate"],
      ['live-odometer', 'unavailable'], ['live-odometer-reason', 'not yet observed'],
      ['live-game-time', 'unavailable'], ['live-game-time-reason', 'not yet observed'], ['live-game-time-note', 'game time'],
      ['live-truck', 'unavailable'], ['live-truck-reason', 'not yet observed']
    ]);
    const job = text.sections.find(section => section.id === 'job')!;
    expect(job).toEqual({id: 'job', testId: 'live-section-job', title: 'Job', missing: 'No job reported', rows: []});
  });
  it('hides job rows of a current update without a job', () => {
    const telemetry = live('snapshot', 'synthetic');
    telemetry.observation!.state.configuration.job = {available: false, reason: 'not-observed'};
    const text = liveDashboardText(telemetry);
    expect(text.sections.find(section => section.id === 'job')).toMatchObject({missing: 'No job reported', rows: []});
    expect(text.sections.find(section => section.id === 'time')!.rows.map(entry => entry.id)).toEqual(['game-time']);
  });
  it('keeps the reason of a job reading that was rejected or not provided instead of reporting no job', () => {
    for (const [reason, expected] of [['invalid', 'Job unavailable (invalid reading)'], ['not-supported', 'Job unavailable (not provided by the game)']] as const) {
      const telemetry = live('snapshot', 'synthetic');
      telemetry.observation!.state.configuration.job = {available: false, reason};
      const job = liveDashboardText(telemetry).sections.find(section => section.id === 'job');
      expect(job).toMatchObject({missing: expected, rows: []});
      expect(JSON.stringify(job)).not.toContain('No job reported');
    }
  });
  it('rejects the zero-with-unavailable fixture before display and keeps legitimate zero values distinct from unavailable', () => {
    expect(() => v0Message('zero-unavailable')).toThrow();
    const telemetry = smokeCheckpoint();
    const state = telemetry.observation!.state;
    state.gear = {available: true, value: 0, unit: 'index'};
    state.engineRpm = {available: true, value: 0, unit: 'rpm'};
    state.fuel = {available: true, value: 0, unit: 'L'};
    state.odometer = {available: true, value: 0, unit: 'm'};
    state.averageConsumption = {available: true, value: 0, unit: 'L/100km'};
    state.estimatedRange = {available: true, value: 0, unit: 'm'};
    const metric = liveDashboardText(telemetry);
    expect(values(metric)).toMatchObject({'gear': 'N', 'engine-rpm': '0 rpm', 'fuel-level': '0%', 'odometer': '0.0 km', 'sdk-average-consumption': '0.0 L/100 km', 'estimated-range': '0 km'});
    for (const id of ['gear', 'engine-rpm', 'fuel-level', 'odometer', 'sdk-average-consumption', 'estimated-range']) expect(row(metric, id)!.reason).toBeUndefined();
    const us = liveDashboardText(telemetry, {ets2: 'us-customary', ats: 'us-customary'});
    expect(row(us, 'sdk-average-consumption')).toMatchObject({value: 'unavailable', reason: 'no consumption recorded', note: 'SDK mean, not a trip average'});
    expect(values(us)).toMatchObject({'odometer': '0.0 mi', 'estimated-range': '0 mi'});
  });
});

it('repeats no conversion constant or rounding in the card modules', () => {
  // Same pattern as unit-profiles.test.ts: telemetry-core is the single numeric source (ET-010 N2).
  for (const file of ['live-dashboard-text.ts', 'live-dashboard.tsx']) {
    const source = readFileSync(`apps/desktop/src/${file}`, 'utf8');
    expect(source, file).not.toMatch(/\b(?:3\.6|2\.236\d*|3\.785\d*|1609\.344|0\.6213\d*|0\.4535\d*|235\.21\d*)\b/);
    expect(source, file).not.toMatch(/\.toFixed\(/);
  }
});
