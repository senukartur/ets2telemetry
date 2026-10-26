// ET-010b live telemetry card text: REG-009, with partial REG-002 (paused banner) and REG-003 (hydrated checkpoint
// shown live) protection for the live display only. Expected texts are written by hand from the shared v0 fixtures,
// the exact unit definitions and docs/live-telemetry-fields.md, never produced by the code under test.
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {LiveTelemetry} from '../../packages/contracts/src';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import {LEGACY_ROW_IDS, liveDashboardText, liveFieldValue, type LiveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {initialLive} from '../../apps/desktop/src/live-state';
import {FIELD_NOTE_TEXT, LIVE_FIELD_TEXT} from '../../apps/desktop/src/strings';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import {liveV1Projection} from '../../apps/desktop/src/live-v1';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {replayV1} from '../../tools/telemetry-simulator/src/v1/replay';
import {
  SYNTHETIC_V0_HIDDEN_ROWS, SYNTHETIC_V0_LIVE_ROWS, SYNTHETIC_V0_VALUE_IDS, SYNTHETIC_V0V1_HIDDEN_ROWS, SYNTHETIC_V0V1_LIVE_ROWS, SYNTHETIC_V1_LIVE_ROWS,
  SYNTHETIC_V1_VALUE_IDS
} from '../../scripts/ci/renderer-observation.mjs';
import {gearboxPair, smokePair, smokeV0, v0Live, v1Projection} from '../shared/live-v1-fixtures';
import {NOT_SUPPORTED_GEARBOX} from '../../packages/contracts/src/protocol-v1';
import {scenarioPath} from '../shared/simulator-v1-expected';

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

// ET-010c: protocol v1 rows (decisions F4 and F5). Expected texts are written by hand from the v0 checkpoint and
// tests/fixtures/protocol-v1/snapshot-live.json (see scripts/ci/renderer-observation.mjs), or from the ET-005b scenario
// files and their hand-written expectations for the transcripts.
/** Rendered elements with the v1 status line before its section's rows, as the card renders them. */
function renderedWithStatus(text: LiveDashboardText): [string, string][] {
  return text.sections.flatMap(section => [
    ...(section.status ? [['live-v1-status', section.status] as [string, string]] : []),
    ...rendered({paused: text.paused, sections: [section]})
  ]);
}
describe('ET-010c card with the v1 smoke projection', () => {
  const text = liveDashboardText(smokePair());
  it('renders exactly the combined smoke rows, in section order with the source section last', () => {
    expect(renderedWithStatus(text)).toEqual(SYNTHETIC_V0V1_LIVE_ROWS.map(([id, value]) => [id, value]));
    expect(text.sections.map(section => [section.testId, section.title])).toEqual([
      ['live-section-motion', 'Driving'], ['live-section-fuel', 'Fuel'], ['live-section-distance', 'Distance'], ['live-section-time', 'Time'],
      ['live-section-job', 'Job'], ['live-section-vehicle', 'Vehicle'], ['live-section-position', 'Position'], ['live-section-source', 'Protocol v1 source']
    ]);
    const ids = renderedWithStatus(text).map(([id]) => id);
    for (const id of SYNTHETIC_V0V1_HIDDEN_ROWS) expect(ids).not.toContain(id);
    expect(text.paused).toBe(false);
  });
  it('lists the v1 rows of the smoke as the combined rows that v0 does not carry', () => {
    const v0Ids = new Set(SYNTHETIC_V0_LIVE_ROWS.map(([id]) => id));
    expect(SYNTHETIC_V0V1_LIVE_ROWS.filter(([id]) => !v0Ids.has(id))).toEqual(SYNTHETIC_V1_LIVE_ROWS);
    expect(SYNTHETIC_V1_VALUE_IDS).toEqual(['live-route-remaining', 'live-deadline', 'live-source-city', 'live-source-company', 'live-destination-company',
      'live-cargo-mass', 'live-market', 'live-special-job', 'live-truck-plate', 'live-trailers', 'live-position', 'live-bearing', 'live-game-mode', 'live-event-loss']);
  });
  it('labels the v1 rows', () => {
    const source = text.sections.find(section => section.id === 'source')!;
    expect(source).toMatchObject({status: 'connected: Validated current observation'});
    expect(source.rows.map(entry => [entry.label, entry.value])).toEqual([['Game mode', 'single-player (weak evidence, module-scan)'], ['Lost events', '2']]);
    expect(row(text, 'route-remaining')!.label).toBe('Route remaining');
    expect(row(text, 'truck-plate')!.label).toBe('License plate');
  });
});

describe('ET-045a job market labels', () => {
  const marketOf = (raw: string) => {
    const telemetry = smokePair(), job = telemetry.v1!.observation!.state.configuration.job;
    if (!job.available) throw new Error('fixture job');
    job.value.market = {available: true, value: raw};
    return telemetry;
  };
  it.each([
    ['cargo_market', 'Cargo market', 'Рынок грузов'], ['quick_job', 'Quick job', 'Быстрый заказ'], ['freight_market', 'Freight market', 'Грузоперевозки'],
    ['external_contracts', 'External contracts', 'Внешние контракты'], ['external_market', 'External market', 'Внешний рынок']
  ])('shows the SDK market %s as %s / %s without changing the state', (raw, en, ru) => {
    const telemetry = marketOf(raw), before = structuredClone(telemetry);
    expect(row(liveDashboardText(telemetry), 'market')).toMatchObject({value: en});
    expect(row(liveDashboardText(telemetry, undefined, 'ru'), 'market')).toMatchObject({value: ru});
    expect(telemetry).toEqual(before);
  });
  it('keeps an unknown, inherited or empty market value verbatim in both languages', () => {
    for (const language of ['en', 'ru'] as const) {
      for (const raw of ['some_future_market', 'constructor', 'toString']) expect(row(liveDashboardText(marketOf(raw), undefined, language), 'market'), raw).toMatchObject({value: raw});
      expect(row(liveDashboardText(marketOf(''), undefined, language), 'market')).toMatchObject({value: '(empty)'});
      expect(liveFieldValue({id: 'market', state: 'value', text: '(empty)'}, language)).toBe('(empty)');
    }
  });
});

describe('ET-010c v1 rows under each source state', () => {
  it('shows no v0 row from v1 without a v0 observation, while the v1 rows stay current', () => {
    const text = liveDashboardText({...initialLive('synthetic'), v1: v1Projection()});
    expect(row(text, 'gear')).toMatchObject({value: 'unavailable', reason: 'not current'});
    expect(row(text, 'cargo')).toMatchObject({value: 'unavailable', reason: 'not current'});
    expect(row(text, 'route-remaining')).toMatchObject({value: '151.0 km'});
    expect(row(text, 'position')).toMatchObject({value: 'x -31234.5, y 42.3, z 18800.8'});
    // Without a v0 job the v1 job rows do not apply.
    for (const id of ['deadline', 'source-city', 'cargo-mass']) expect(row(text, id)).toBeUndefined();
    expect(text.sections.find(section => section.id === 'source')).toMatchObject({status: 'connected: Validated current observation'});
  });
  it.each([
    ['without a v1 projection', undefined],
    ['with a projection of another selection', v1Projection('snapshot-live', {selection: 'replay'})],
    ['before the first v1 observation', {...v1Projection(), observation: undefined, fresh: false, status: 'waiting' as const, reason: 'Awaiting selected source'}],
    ['with v1 data of another origin', v1Projection('snapshot-live', {origin: 'replay'})]
  ])('equals the ET-010b card %s', (_name, v1) => {
    expect(liveDashboardText({...smokeV0(), ...(v1 ? {v1} : {})})).toEqual(liveDashboardText(smokeV0()));
    const stale = smokeV0({status: 'stale', fresh: false});
    expect(liveDashboardText({...stale, ...(v1 ? {v1} : {})})).toEqual(liveDashboardText(stale));
  });
  it.each([
    ['stale', {status: 'stale' as const, fresh: false, reason: 'Main has no recent v1 SDK capture'}, 'stale: Main has no recent v1 SDK capture'],
    ['disconnected', {status: 'disconnected' as const, fresh: false, reason: 'Source closed; interval coverage unknown'}, 'disconnected: Source closed; interval coverage unknown']
  ])('shows every v1 row as not current while v1 is %s and leaves the v0 rows alone', (_name, options, status) => {
    const text = liveDashboardText(smokePair(options));
    for (const id of SYNTHETIC_V1_VALUE_IDS) expect(rendered(text)).toContainEqual([id, 'unavailable']);
    for (const id of SYNTHETIC_V1_VALUE_IDS) expect(rendered(text)).toContainEqual([`${id}-reason`, 'not current']);
    expect(text.sections.find(section => section.id === 'source')!.status).toBe(status);
    // The v0 rows are those of the v0-only card, with game ids because v1 is not current.
    const v0Rows = rendered(text).filter(([id]) => SYNTHETIC_V0_LIVE_ROWS.some(([v0Id]) => v0Id === id));
    expect(v0Rows).toEqual(SYNTHETIC_V0_LIVE_ROWS.map(([id, value]) => [id, value]));
    expect(JSON.stringify(text)).not.toMatch(/Synthetic City|Synthetic Cargo|SYN 0001|151\.0|270°|dryvan/);
  });
  it('keeps the v1 rows current while only v0 is stale', () => {
    const text = liveDashboardText(smokePair({}, {status: 'stale', fresh: false}));
    const v1Rows = renderedWithStatus(text).filter(([id]) => SYNTHETIC_V1_LIVE_ROWS.some(([v1Id]) => v1Id === id));
    expect(v1Rows).toEqual(SYNTHETIC_V1_LIVE_ROWS.map(([id, value]) => [id, value]));
    for (const id of SYNTHETIC_V0_VALUE_IDS) expect(row(text, id.slice('live-'.length))).toMatchObject({value: 'unavailable', reason: 'not current'});
  });
  it('shows no v1 job row while v0 reports no job', () => {
    const telemetry = {...v0Live('unavailable', 'synthetic'), v1: v1Projection()};
    const text = liveDashboardText(telemetry);
    expect(text.sections.find(section => section.id === 'job')).toEqual({id: 'job', testId: 'live-section-job', title: 'Job', missing: 'No job reported', rows: []});
    expect(text.sections.find(section => section.id === 'time')!.rows.map(entry => entry.id)).toEqual(['game-time']);
    expect(row(text, 'route-remaining')).toMatchObject({value: '151.0 km'});
  });
  it('shows the v1 job rows of another job as not current', () => {
    const text = liveDashboardText(smokePair({ids: 'fixture'}));
    for (const id of ['deadline', 'source-city', 'source-company', 'destination-company', 'cargo-mass', 'market', 'special-job'])
      expect(row(text, id), id).toMatchObject({value: 'unavailable', reason: 'not current'});
    expect(row(text, 'cargo')!.value).toBe('cargo.logs');
    expect(row(text, 'trailers')!.value).toBe('dryvan');
  });
  it('shows the paused banner from current v1 data only while v0 is not current', () => {
    expect(liveDashboardText(smokePair({status: 'paused'})).paused).toBe(false);
    expect(liveDashboardText(smokePair({status: 'paused'}, {status: 'stale', fresh: false})).paused).toBe(true);
  });
});

// ET-005b transcripts through the projection (base plan step (f)). Expected texts are derived by hand from the scenario
// files and the rules their hand-written expectations cite: an unset channel is `not-observed`, world placement is
// copied, and the SDK heading is a counterclockwise unit fraction (bearing = ((1 - heading) mod 1) x 360°).
function transcriptLive(id: string, atMs: number, v0: LiveTelemetry): LiveTelemetry {
  const result = replayV1(readFixtureFile(scenarioPath(id)));
  const line = result.transcript.filter(entry => entry.direction === 'server' && entry.atMs <= atMs &&
    (entry.message.kind === 'checkpoint' || entry.message.kind === 'snapshot')).at(-1)!;
  const message = line.message as Extract<v1.ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
  const projection = liveV1Projection({selection: v0.selection, status: 'connected', reason: 'Validated current observation', fresh: true, durable: {state: 'off'},
    observation: {kind: message.kind, source: message.source, seq: message.seq, capture: message.capture, state: message.data.state, status: message.data.status,
      continuity: message.data.continuity, receivedMonotonicMs: atMs, hydration: message.kind === 'checkpoint'}});
  return {...v0, v1: projection};
}
/** A v0 observation whose job has the given ids; game and origin follow the transcript. */
function v0WithJob(game: 'ets2' | 'ats', cargoId: string, destinationCityId: string): LiveTelemetry {
  const telemetry = v0Live(game === 'ats' ? 'ats' : 'snapshot', 'synthetic', {}, 'synthetic');
  const job = telemetry.observation!.state.configuration.job;
  if (!job.available) throw new Error('Expected a v0 job');
  job.value.cargoId = cargoId; job.value.destinationCityId = destinationCityId;
  return telemetry;
}
describe('ET-010c v1 rows from ET-005b transcripts', () => {
  it('sleep-teleport: shows the copied world placement before and after the teleport, without a job', () => {
    const before = liveDashboardText(transcriptLive('sleep-teleport', 100, v0Live('snapshot', 'synthetic')));
    expect(row(before, 'position')).toMatchObject({value: 'x 101.5, y 10.0, z -200.3', note: 'game-world coordinates, not GPS'});
    expect(row(before, 'bearing')).toMatchObject({value: '180°'});
    const after = liveDashboardText(transcriptLive('sleep-teleport', 300, v0Live('snapshot', 'synthetic')));
    expect(row(after, 'position')).toMatchObject({value: 'x 25000.5, y 15.0, z 9000.8'});
    expect(row(after, 'bearing')).toMatchObject({value: '90°'});
    expect(row(after, 'route-remaining')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
    expect(row(after, 'game-mode')).toMatchObject({value: 'unknown'});
    expect(row(after, 'event-loss')).toMatchObject({value: '0', note: 'this version records no gameplay events'});
    // The v0 job (cargo.logs to city.warszawa) is not the transcript's, which has none.
    expect(row(after, 'source-city')).toMatchObject({value: 'unavailable', reason: 'not current'});
  });
  it('save-load: shows the job rows for the same job before and after the reload', () => {
    for (const atMs of [100, 240]) {
      const text = liveDashboardText(transcriptLive('save-load', atMs, v0WithJob('ets2', 'synthetic_cargo', 'synthetic_city_b')));
      expect(row(text, 'cargo')!.value, `${atMs}`).toBe('synthetic_cargo');
      expect(row(text, 'destination-city')!.value).toBe('synthetic_city_b');
      expect(row(text, 'source-city')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
      expect(row(text, 'deadline')).toMatchObject({value: 'unavailable', reason: 'not yet observed', note: 'game time'});
      expect(row(text, 'cargo-mass')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
      // No market observed: cargo loaded is defined for the cargo market only and stays hidden.
      expect(row(text, 'cargo-loaded')).toBeUndefined();
      expect(row(text, 'trailers')!.value).toBe('trailer.synthetic_box');
      expect(row(text, 'truck-plate')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
    }
  });
  it('timers-truck-refuel: shows no plate and no trailer after the truck change', () => {
    const text = liveDashboardText(transcriptLive('timers-truck-refuel', 500, v0Live('snapshot', 'synthetic')));
    expect(row(text, 'truck-plate')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
    expect(row(text, 'trailers')).toMatchObject({value: 'none', reason: 'no trailer attached'});
  });
  it('units-currency (ATS): keeps the guard for a job whose destination city is not observed', () => {
    const text = liveDashboardText(transcriptLive('units-currency', 100, v0WithJob('ats', 'cargo.logs', 'city.warszawa')));
    // The transcript's cargo id is the provided empty string and its destination city is not observed, so no v0 job can
    // be the same job: the 0 kg cargo mass is not current rather than "0 lb" (difference from the base plan, reported).
    for (const id of ['cargo-mass', 'source-city', 'special-job']) expect(row(text, id), id).toMatchObject({value: 'unavailable', reason: 'not current'});
    expect(row(text, 'route-remaining')).toMatchObject({value: 'unavailable', reason: 'not yet observed'});
    expect(row(text, 'game-mode')).toMatchObject({value: 'unknown'});
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


it('localizes an absent trailer sentinel without translating an SDK trailer named none', () => {
  expect(liveFieldValue({id: 'trailers', state: 'absent', text: 'none'}, 'ru')).toBe('нет');
  expect(liveFieldValue({id: 'trailers', state: 'value', text: 'none'}, 'ru')).toBe('none');
  expect(liveFieldValue({id: 'trailers', state: 'absent', text: 'none'}, 'en')).toBe('none');
});

// ET-050: the gear row follows the displayed game's gear display mode in both languages; L and H stay Latin in RU.
describe('gear display mode (ET-050)', () => {
  const withGear = (value: number, game: 'ets2' | 'ats' = 'ets2') => {
    const telemetry = smokeCheckpoint(); telemetry.observation!.source.game = game; telemetry.observation!.state.gear = {available: true, value, unit: 'index'};
    return telemetry;
  };
  const UNITS = {ets2: 'metric', ats: 'us-customary'} as const;
  it.each(['en', 'ru'] as const)('formats the gear row by the displayed game in %s', language => {
    const ets2Manual = {ets2: 'manual', ats: 'automatic'} as const;
    expect(values(liveDashboardText(withGear(3), UNITS, language, ets2Manual)).gear).toBe('2L');
    expect(values(liveDashboardText(withGear(3), UNITS, language, {ets2: 'automatic', ats: 'manual'})).gear).toBe('3');
    expect(values(liveDashboardText(withGear(3), UNITS, language)).gear).toBe('3');
    expect(values(liveDashboardText(withGear(3, 'ats'), UNITS, language, ets2Manual)).gear).toBe('3');
    expect(values(liveDashboardText(withGear(3, 'ats'), UNITS, language, {ets2: 'automatic', ats: 'manual'})).gear).toBe('2L');
    for (const [gear, text] of [[1, '1L'], [2, '1H'], [16, '8H'], [-1, 'R1'], [-2, 'R2'], [0, 'N']] as const)
      expect(values(liveDashboardText(withGear(gear), UNITS, language, ets2Manual)).gear).toBe(text);
    for (const [gear, text] of [[-1, 'R1'], [0, 'N']] as const) expect(values(liveDashboardText(withGear(gear), UNITS, language, AUTO)).gear).toBe(text);
  });
  it('keeps a not-current gear row unavailable in manual mode', () => {
    const stale = smokeCheckpoint({status: 'stale', fresh: false});
    expect(row(liveDashboardText(stale, UNITS, 'en', {ets2: 'manual', ats: 'manual'}), 'gear')).toMatchObject({value: 'unavailable', reason: 'not current'});
  });
});
const AUTO = {ets2: 'automatic', ats: 'automatic'} as const;

// ET-050b B6: the Live details row shows the gearbox-aware labels in manual mode for the current v1 truck with v0's model
// id, in both languages; L and H stay Latin in RU. Anything else keeps the GD2 formula.
describe('gearbox-aware gear labels (ET-050b)', () => {
  const UNITS = {ets2: 'metric', ats: 'us-customary'} as const, MANUAL = {ets2: 'manual', ats: 'manual'} as const;
  // The Mack is an ATS truck: ATS sources name its crawler LL/LH (B5 as amended on October 26, 2026).
  const ATS = {game: 'ats'} as const;
  it.each(['en', 'ru'] as const)('shows the Mack layout labels in %s', language => {
    for (const [gear, text] of [[1, 'LL'], [2, 'LH'], [3, '1L'], [18, '8H'], [-2, 'R2'], [0, 'N']] as const)
      expect(values(liveDashboardText(gearboxPair(gear, ATS), UNITS, language, MANUAL)).gear).toBe(text);
    expect(values(liveDashboardText(gearboxPair(1, ATS), UNITS, language, AUTO)).gear).toBe('1');
    expect(values(liveDashboardText(gearboxPair(1, {...ATS, truckId: 'vehicle.synthetic_truck'}), UNITS, language, MANUAL)).gear).toBe('1L');
    expect(values(liveDashboardText(gearboxPair(18, {...ATS, v1: {status: 'stale', fresh: false}}), UNITS, language, MANUAL)).gear).toBe('9H');
    expect(values(liveDashboardText(gearboxPair(1, {...ATS, gearbox: NOT_SUPPORTED_GEARBOX}), UNITS, language, MANUAL)).gear).toBe('1L');
  });
});
