import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {LiveTelemetry, OverlayPresentation, OverlaySectionView} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {
  SYNTHETIC_V1_OVERLAY_CURRENT, SYNTHETIC_V1_OVERLAY_STOPPED, SYNTHETIC_V1_OVERLAY_V0_STALE, SYNTHETIC_V1_OVERLAY_V1_STALE, SYNTHETIC_V1_STRIP_SECTIONS
} from '../../scripts/ci/renderer-observation.mjs';
import {smokePair, v1Projection, type V1Options} from '../shared/live-v1-fixtures';

// REG-009 partial (ET-012a): the overlay sections over the v0 snapshot fixture. Expected texts are hand-computed from the
// fixture: speed 0 m/s, fuel not observed, capacity 1000 L, 600 rpm, gear -1, SDK mean 25 L/100 km, range not observed,
// game minute 12345678 (day 8574, minute 558 of the day), cargo.logs to city.warszawa and an expected income of
// 9007199254740993.123456 in an unknown currency.
function live(): LiveTelemetry {
  const snapshot = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (snapshot.kind !== 'snapshot') throw new Error('Expected snapshot');
  return {...initialLive('ets2'), status: 'connected', fresh: true, observation: {
    source: {...snapshot.source, origin: 'game'}, state: snapshot.data.state, capture: snapshot.capture, seq: snapshot.seq,
    receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: snapshot.data.continuity}
  }};
}
const ALL = OVERLAY_PRESETS['everything'];
// ET-012b: the placements do not affect the projection; only main's window placement uses them.
const PLACEMENTS = DEFAULT_OVERLAY_PLACEMENTS;
const ids = (sections: readonly OverlaySectionView[]) => sections.map(section => section.id);

it('shows the v0 sections of the fixture in metric for ETS2, in canonical order, with absent ones left out', () => {
  expect(overlayPresentation(live()).sections).toEqual([
    {id: 'speed', state: 'value', text: '0.0 km/h'},
    {id: 'gear', state: 'value', text: 'R1'},
    {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
    // Fuel is not observed: the baseline section stays as a dash, never 0.
    {id: 'fuel', state: 'unavailable'},
    {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'},
    {id: 'cargo', state: 'value', text: 'cargo.logs'},
    {id: 'destination', state: 'value', text: 'city.warszawa'},
    {id: 'expected-income', state: 'value', text: '9007199254740993.123456 (currency unknown)'},
    {id: 'game-time', state: 'value', text: 'Day 8574, 09:18'}
  ]);
});

it('formats every section in the US customary profile for ATS, leaving canonical values unchanged', () => {
  const current = live(), state = current.observation!.state;
  current.selection = 'ats'; current.observation!.source.game = 'ats';
  state.fuel = {available: true, value: 250, unit: 'L'}; state.estimatedRange = {available: true, value: 160934.4, unit: 'm'};
  state.speed = {available: true, value: 25, unit: 'm/s'};
  const before = structuredClone(current);
  const presentation = overlayPresentation(current, {ets2: 'metric', ats: 'us-customary'});
  expect(presentation).toMatchObject({source: 'ATS', speed: '55.9', speedUnit: 'mph', fuel: '66.0', fuelUnit: 'US gal', freshness: 'current'});
  expect(presentation.sections.slice(0, 6)).toEqual([
    {id: 'speed', state: 'value', text: '55.9 mph'},
    {id: 'gear', state: 'value', text: 'R1'},
    {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
    {id: 'fuel', state: 'value', text: '66.0 US gal', detail: '25%'},
    {id: 'range', state: 'value', text: '100 mi'},
    {id: 'sdk-consumption', state: 'value', text: '9.4 US mpg'}
  ]);
  expect(current).toStrictEqual(before);
});

it('keeps the speed section text equal to the legacy speed number and unit', () => {
  const current = live();
  current.observation!.state.speed = {available: true, value: 25, unit: 'm/s'};
  const presentation = overlayPresentation(current);
  expect(presentation.sections[0]).toEqual({id: 'speed', state: 'value', text: `${presentation.speed} ${presentation.speedUnit}`});
  expect(presentation.speed).toBe('90.0');
});

it('shows zero speed and zero fuel as values, distinct from an unavailable dash', () => {
  const current = live(), state = current.observation!.state;
  state.fuel = {available: true, value: 0, unit: 'L'};
  expect(overlayPresentation(current).sections.filter(section => section.id === 'speed' || section.id === 'fuel')).toEqual([
    {id: 'speed', state: 'value', text: '0.0 km/h'}, {id: 'fuel', state: 'value', text: '0.0 L', detail: '0%'}]);
  state.speed = {available: false, reason: 'not-observed', unit: 'm/s'};
  expect(overlayPresentation(current).sections[0]).toEqual({id: 'speed', state: 'unavailable'});
});

it('leaves the fuel level out while the capacity is unknown', () => {
  const current = live(), state = current.observation!.state;
  state.fuel = {available: true, value: 250, unit: 'L'}; state.fuelCapacity = {available: false, reason: 'not-supported', unit: 'L'};
  expect(overlayPresentation(current).sections.find(section => section.id === 'fuel')).toEqual({id: 'fuel', state: 'value', text: '250.0 L'});
});

it('hides current sections without data, except speed and fuel (decision L5)', () => {
  const current = live(), state = current.observation!.state;
  state.speed = {available: false, reason: 'not-supported', unit: 'm/s'};
  state.gear = {available: false, reason: 'invalid', unit: 'index'};
  state.engineRpm = {available: false, reason: 'not-observed', unit: 'rpm'};
  state.averageConsumption = {available: false, reason: 'not-observed', unit: 'L/100km'};
  state.gameTime = {available: false, reason: 'not-observed', unit: 'min', clockId: state.gameTime.clockId};
  state.configuration = {...state.configuration, job: {available: false, reason: 'not-observed'}};
  expect(overlayPresentation(current).sections).toEqual([{id: 'speed', state: 'unavailable'}, {id: 'fuel', state: 'unavailable'}]);
});

it('never shows origin, distance driven, distance remaining or the deadline under protocol v0', () => {
  const presentation = overlayPresentation(live());
  for (const id of ['origin', 'distance-driven', 'distance-remaining', 'deadline']) expect(ids(presentation.sections)).not.toContain(id);
  // Not even as placeholders while not current: v0 does not carry them.
  const stale = {...live(), fresh: false, status: 'stale' as const};
  for (const id of ['origin', 'distance-driven', 'distance-remaining', 'deadline']) expect(ids(overlayPresentation(stale).sections)).not.toContain(id);
});

it.each([
  ['stale', (current: LiveTelemetry) => {current.fresh = false; current.status = 'stale';}, 'stale'],
  ['disconnected', (current: LiveTelemetry) => {current.status = 'disconnected';}, 'unavailable'],
  ['a game origin mismatch', (current: LiveTelemetry) => {current.observation!.source.game = 'ats';}, 'unavailable'],
  ['a synthetic origin under a game selection', (current: LiveTelemetry) => {current.observation!.source.origin = 'synthetic';}, 'unavailable']
])('keeps the previous shape with every shown section unavailable while %s (decisions L5 and L6)', (_name, fault, freshness) => {
  const previous = overlayPresentation(live());
  const current = live(); fault(current);
  const presentation = overlayPresentation(current, undefined, undefined, previous);
  expect(presentation).toMatchObject({freshness, paused: false, speed: '—', fuel: '—'});
  // Range was hidden while current (not observed in the fixture), so it stays hidden.
  expect(presentation.sections).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']
    .map(id => ({id, state: 'unavailable'})));
});

it('keeps hidden sections hidden when current data with no job goes stale', () => {
  // Advisory review on PR #70: the stale projection must not add back the sections hidden while current.
  const noJob = live();
  noJob.observation!.state.configuration = {...noJob.observation!.state.configuration, job: {available: false, reason: 'not-observed'}};
  const previous = overlayPresentation(noJob);
  expect(ids(previous.sections)).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'game-time']);
  const stale = {...noJob, fresh: false, status: 'stale' as const};
  const presentation = overlayPresentation(stale, undefined, undefined, previous);
  expect(presentation.sections).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'game-time'].map(id => ({id, state: 'unavailable'})));
  // A further stale delivery keeps the same shape, and current data with a job shows the job sections again.
  expect(overlayPresentation(stale, undefined, undefined, presentation).sections).toEqual(presentation.sections);
  expect(ids(overlayPresentation(live(), undefined, undefined, presentation).sections)).toContain('cargo');
});

it('shows only the speed and fuel placeholders while not current without a previous projection', () => {
  const stale = {...live(), fresh: false, status: 'stale' as const};
  expect(overlayPresentation(stale).sections).toEqual([{id: 'speed', state: 'unavailable'}, {id: 'fuel', state: 'unavailable'}]);
  // A section disabled since the previous projection is left out.
  const previous = overlayPresentation(live());
  expect(ids(overlayPresentation(stale, undefined, {layout: 'strip', sections: {...ALL, gear: false, fuel: false}, placements: PLACEMENTS}, previous).sections))
    .toEqual(['speed', 'rpm', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']);
});

it('shows placeholders before the first observation', () => {
  expect(overlayPresentation(initialLive('game'))).toMatchObject({source: 'No game', freshness: 'unavailable', layout: 'strip', paused: false});
  expect(overlayPresentation(initialLive('game')).sections.every(section => section.state === 'unavailable')).toBe(true);
});

it('leaves disabled sections out and passes the layout through', () => {
  const presentation = overlayPresentation(live(), undefined, {layout: 'cluster', sections: OVERLAY_PRESETS['driving-only'], placements: PLACEMENTS});
  expect(presentation.layout).toBe('cluster');
  expect(ids(presentation.sections)).toEqual(['speed', 'gear', 'rpm', 'fuel']);
  const stale = {...live(), fresh: false, status: 'stale' as const};
  const jobFocus = {layout: 'hud' as const, sections: OVERLAY_PRESETS['job-focus'], placements: PLACEMENTS};
  expect(ids(overlayPresentation(stale, undefined, jobFocus, overlayPresentation(live(), undefined, jobFocus)).sections))
    .toEqual(['speed', 'gear', 'fuel', 'cargo', 'destination']);
  // The legacy speed and fuel fields stay in the projection whatever the sections are.
  expect(overlayPresentation(live(), undefined, {layout: 'strip', sections: {...ALL, speed: false, fuel: false}, placements: PLACEMENTS})).toMatchObject({speed: '0.0', fuel: '—'});
});

it('reports a paused game only while current', () => {
  const current = live(); current.status = 'paused';
  expect(overlayPresentation(current)).toMatchObject({paused: true, freshness: 'current'});
  current.observation!.state.simulation = 'paused'; current.status = 'connected';
  expect(overlayPresentation(current).paused).toBe(true);
  current.fresh = false; current.status = 'stale';
  expect(overlayPresentation(current).paused).toBe(false);
});

it.each([
  {rpm: 0, ring: 0},
  {rpm: 1500, ring: 0.5},
  {rpm: 3000, ring: 1},
  {rpm: 4000, ring: 1}
])('maps $rpm rpm to a ring fraction of $ring on the fixed 3000 rpm scale', ({rpm, ring}) => {
  const current = live(); current.observation!.state.engineRpm = {available: true, value: rpm, unit: 'rpm'};
  expect(overlayPresentation(current).sections.find(section => section.id === 'rpm')).toEqual({id: 'rpm', state: 'value', text: `${rpm} rpm`, ring});
});

it('keeps the exact raw income digits without grouping and states a documented currency', () => {
  const current = live(), job = current.observation!.state.configuration.job;
  if (!job.available) throw new Error('Expected job');
  job.value.expectedIncome = {rawValue: '1234567', currency: {status: 'verified', code: 'EUR', source: 'scssdk_telemetry_job.h'}};
  expect(overlayPresentation(current).sections.find(section => section.id === 'expected-income')).toEqual(
    {id: 'expected-income', state: 'value', text: '1234567 EUR (SDK-documented)'});
});

// ET-010c decision F7: protocol v1 sections from the same combiner as the card. The v1 input is the hand projection of
// tests/fixtures/protocol-v1/snapshot-live.json with the v0 job ids (cargo.logs, city.warszawa), under the same ETS2
// game origin: 151000 m remaining, deadline minute 13000 at game minute 12345 (10 h 55 min), 18000 kg of Synthetic
// Cargo from Synthetic City A (Synthetic Company A) to Synthetic City B (Synthetic Company B).
function withV1(options: V1Options = {}, v0 = live()): LiveTelemetry {
  return {...v0, v1: v1Projection('snapshot-live', {selection: v0.selection, origin: 'game', ...options})};
}
const V1_STALE: V1Options = {status: 'stale', fresh: false, reason: 'Main has no recent v1 SDK capture'};
const FULL: OverlaySectionView[] = [
  {id: 'speed', state: 'value', text: '0.0 km/h'},
  {id: 'gear', state: 'value', text: 'R1'},
  {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
  {id: 'fuel', state: 'unavailable'},
  {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'},
  {id: 'cargo', state: 'value', text: 'Synthetic Cargo', detail: '18.0 t'},
  {id: 'origin', state: 'value', text: 'Synthetic City A, Synthetic Company A'},
  {id: 'destination', state: 'value', text: 'Synthetic City B, Synthetic Company B'},
  {id: 'distance-remaining', state: 'value', text: '151.0 km'},
  {id: 'deadline', state: 'value', text: 'in 10 h 55 min'},
  {id: 'expected-income', state: 'value', text: '9007199254740993.123456 (currency unknown)'},
  {id: 'game-time', state: 'value', text: 'Day 8574, 09:18'}
];
it('shows the v1 sections and names beside the v0 sections while both are current (ET-010c)', () => {
  const presentation = overlayPresentation(withV1());
  expect(presentation.sections).toEqual(FULL);
  expect(presentation).toMatchObject({source: 'ETS2', origin: 'game', freshness: 'current', speed: '0.0', paused: false});
});
it('formats the v1 sections in the ATS US customary profile: 18000 kg is 39683 lb', () => {
  const current = live(); current.selection = 'ats'; current.observation!.source.game = 'ats';
  const sections = overlayPresentation(withV1({game: 'ats'}, current)).sections;
  expect(sections.find(section => section.id === 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'Synthetic Cargo', detail: '39683 lb'});
  expect(sections.find(section => section.id === 'distance-remaining')).toEqual({id: 'distance-remaining', state: 'value', text: '93.8 mi'});
});
it('keeps v1 sections as dashes when v1, then v0, stops being current, and drops them without v1 (ET-010c)', () => {
  const first = overlayPresentation(withV1());
  const v1Stale = overlayPresentation(withV1(V1_STALE), undefined, undefined, first);
  expect(v1Stale.sections).toEqual([
    {id: 'speed', state: 'value', text: '0.0 km/h'},
    {id: 'gear', state: 'value', text: 'R1'},
    {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
    {id: 'fuel', state: 'unavailable'},
    {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'},
    // Mixed sections keep their v0 part: the game ids, without the v1 mass and company.
    {id: 'cargo', state: 'value', text: 'cargo.logs'},
    {id: 'origin', state: 'unavailable'},
    {id: 'destination', state: 'value', text: 'city.warszawa'},
    {id: 'distance-remaining', state: 'unavailable'},
    {id: 'deadline', state: 'unavailable'},
    {id: 'expected-income', state: 'value', text: '9007199254740993.123456 (currency unknown)'},
    {id: 'game-time', state: 'value', text: 'Day 8574, 09:18'}
  ]);
  expect(v1Stale.freshness).toBe('current');
  const v0Stale = overlayPresentation(withV1(V1_STALE, {...live(), fresh: false, status: 'stale'}), undefined, undefined, v1Stale);
  expect(v0Stale).toMatchObject({freshness: 'stale', speed: '—', fuel: '—', paused: false});
  expect(v0Stale.sections).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'origin', 'destination', 'distance-remaining', 'deadline',
    'expected-income', 'game-time'].map(id => ({id, state: 'unavailable'})));
  // A new selection clears the v1 projection: v1 sections are no longer carried, even as placeholders.
  const cleared = overlayPresentation(initialLive('ats'), undefined, undefined, v0Stale);
  expect(cleared.sections).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']
    .map(id => ({id, state: 'unavailable'})));
});
it('shows no v1 value while v0 is not current, even with current v1 data', () => {
  const stale = overlayPresentation(withV1({}, {...live(), fresh: false, status: 'stale'}), undefined, undefined, overlayPresentation(withV1()));
  expect(stale.sections.every(section => section.state === 'unavailable')).toBe(true);
  expect(ids(stale.sections)).toEqual(ids(FULL));
  // Without a previous projection only the baseline placeholders appear.
  expect(overlayPresentation(withV1({}, {...live(), fresh: false, status: 'stale'})).sections).toEqual([{id: 'speed', state: 'unavailable'}, {id: 'fuel', state: 'unavailable'}]);
});
it('leaves out v1 job sections for another job unless they were shown, and keeps distance remaining', () => {
  const mismatch = overlayPresentation(withV1({ids: 'fixture'}));
  expect(ids(mismatch.sections)).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'distance-remaining', 'expected-income', 'game-time']);
  expect(mismatch.sections.find(section => section.id === 'cargo')).toEqual({id: 'cargo', state: 'value', text: 'cargo.logs'});
  expect(mismatch.sections.find(section => section.id === 'distance-remaining')).toEqual({id: 'distance-remaining', state: 'value', text: '151.0 km'});
  const afterShown = overlayPresentation(withV1({ids: 'fixture'}), undefined, undefined, overlayPresentation(withV1()));
  expect(afterShown.sections.find(section => section.id === 'origin')).toEqual({id: 'origin', state: 'unavailable'});
  expect(afterShown.sections.find(section => section.id === 'deadline')).toEqual({id: 'deadline', state: 'unavailable'});
});
it('leaves the v1 job sections out once v0 reports no job, without keeping dashes', () => {
  const noJob = withV1();
  noJob.observation!.state.configuration = {...noJob.observation!.state.configuration, job: {available: false, reason: 'not-observed'}};
  const presentation = overlayPresentation(noJob, undefined, undefined, overlayPresentation(withV1()));
  expect(ids(presentation.sections)).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'distance-remaining', 'game-time']);
});
it('keeps v1 sections that were never shown absent without v1 data (fix round 1)', () => {
  // Fix round 1 checked this with a previous projection that showed v1 sections; the PR #73 advisory review changed that
  // case (a shown section now keeps a dash, below), so the no-v1 case is checked against a v0-only previous projection.
  const v0Only = overlayPresentation(live(), undefined, undefined, overlayPresentation(live()));
  for (const telemetry of [live(), {...live(), v1: v1Projection('snapshot-live', {selection: 'ats', origin: 'game'})}]) {
    const presentation = overlayPresentation(telemetry, undefined, undefined, overlayPresentation(live()));
    expect(presentation).toEqual(v0Only);
    expect(ids(presentation.sections)).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']);
  }
});
// PR #73 advisory review: a v1-only section that was shown keeps an `unavailable` dash when its v1 carriage is lost while
// an update still carries a v0 observation (ET-012a L5), for example when main strips an invalid projection or the v1 origin stops
// matching. An update without a v0 observation (a selection change, a service restart or a lost channel) clears it.
const LOST_V1: OverlaySectionView[] = [
  {id: 'speed', state: 'value', text: '0.0 km/h'},
  {id: 'gear', state: 'value', text: 'R1'},
  {id: 'rpm', state: 'value', text: '600 rpm', ring: 0.2},
  {id: 'fuel', state: 'unavailable'},
  {id: 'sdk-consumption', state: 'value', text: '25.0 L/100 km'},
  {id: 'cargo', state: 'value', text: 'cargo.logs'},
  {id: 'origin', state: 'unavailable'},
  {id: 'destination', state: 'value', text: 'city.warszawa'},
  {id: 'distance-remaining', state: 'unavailable'},
  {id: 'deadline', state: 'unavailable'},
  {id: 'expected-income', state: 'value', text: '9007199254740993.123456 (currency unknown)'},
  {id: 'game-time', state: 'value', text: 'Day 8574, 09:18'}
];
it.each([
  ['main strips the projection', () => live()],
  ['the v1 origin stops matching', () => withV1({origin: 'replay'})],
  ['the v1 game stops matching', () => withV1({game: 'ats'})]
])('keeps shown v1 sections as dashes while v0 stays current when %s', (_name, lost) => {
  const shown = overlayPresentation(withV1());
  const presentation = overlayPresentation(lost(), undefined, undefined, shown);
  expect(presentation).toMatchObject({freshness: 'current', speed: '0.0'});
  expect(presentation.sections).toEqual(LOST_V1);
  // The dash stays while the same source continues without v1, and the value returns with v1.
  expect(overlayPresentation(lost(), undefined, undefined, presentation).sections).toEqual(LOST_V1);
  expect(overlayPresentation(withV1(), undefined, undefined, presentation).sections).toEqual(FULL);
});
it('keeps shown v1 sections as dashes while v0 is stale and the v1 projection is lost', () => {
  const stale = overlayPresentation({...live(), fresh: false, status: 'stale'}, undefined, undefined, overlayPresentation(withV1()));
  expect(stale.sections).toEqual(ids(FULL).map(id => ({id, state: 'unavailable'})));
});
it('clears shown v1 sections on an update without a v0 observation, such as a selection change', () => {
  const lost = overlayPresentation(live(), undefined, undefined, overlayPresentation(withV1()));
  const cleared = overlayPresentation(initialLive('ets2'), undefined, undefined, lost);
  expect(cleared.sections).toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']
    .map(id => ({id, state: 'unavailable'})));
  // Current v0 data of the new selection without v1 then shows no v1 section at all.
  expect(ids(overlayPresentation(live(), undefined, undefined, cleared).sections))
    .toEqual(['speed', 'gear', 'rpm', 'fuel', 'sdk-consumption', 'cargo', 'destination', 'expected-income', 'game-time']);
});
it('uses no v1 data of another origin or selection', () => {
  for (const telemetry of [{...live(), v1: v1Projection('snapshot-live', {selection: 'ets2'})}, {...live(), v1: v1Projection('snapshot-live', {selection: 'ats', origin: 'game'})}])
    expect(overlayPresentation(telemetry)).toEqual(overlayPresentation(live()));
});
// The telemetry smoke's overlay constants (scripts/ci/renderer-observation.mjs) against the projection and the overlay
// renderer's view for the same smoke pair, so a wrong constant fails here rather than only in the Electron smoke.
function rendered(presentation: OverlayPresentation): Record<string, string | null> {
  const view = overlayView(presentation), texts: Record<string, string | null> = {freshness: view.freshness};
  for (const item of view.items) {texts[item.testId] = item.value; if (item.detailTestId) texts[item.detailTestId] = item.detail ?? null;}
  return texts;
}
const expectRendered = (presentation: OverlayPresentation, expected: Readonly<Record<string, string | null>>) => {
  const texts = rendered(presentation);
  for (const [key, text] of Object.entries(expected)) expect(texts[key] ?? null, key).toBe(text);
};
it('produces the overlay texts the telemetry smoke expects for the smoke pair', () => {
  const current = overlayPresentation(smokePair());
  expectRendered(current, SYNTHETIC_V1_OVERLAY_CURRENT);
  // The strip containment assertion (ET-012c) in the telemetry smoke expects exactly these sections for the pair.
  expect(ids(current.sections)).toEqual(SYNTHETIC_V1_STRIP_SECTIONS);
  expectRendered(overlayPresentation(smokePair({}, {status: 'stale', fresh: false}), undefined, undefined, current), SYNTHETIC_V1_OVERLAY_V0_STALE);
  expectRendered(overlayPresentation(smokePair({status: 'stale', fresh: false, reason: 'Main has no recent v1 SDK capture'}), undefined, undefined, current),
    SYNTHETIC_V1_OVERLAY_V1_STALE);
  expectRendered(overlayPresentation(smokePair({status: 'disconnected', fresh: false, reason: 'Source closed; interval coverage unknown'},
    {status: 'disconnected', fresh: false}), undefined, undefined, current), SYNTHETIC_V1_OVERLAY_STOPPED);
});
it('leaves disabled v1 sections out and passes no source identity, boundary, window or clock data to the renderer', () => {
  expect(ids(overlayPresentation(withV1(), undefined, {layout: 'hud', sections: OVERLAY_PRESETS['job-focus'], placements: PLACEMENTS}).sections))
    .toEqual(['speed', 'gear', 'fuel', 'cargo', 'destination', 'distance-remaining', 'deadline']);
  const json = JSON.stringify(overlayPresentation(withV1()));
  for (const text of ['10000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'pluginSessionId', 'boundaryOrder', 'handle', '65538', 'clockMapping'])
    expect(json).not.toContain(text);
});
// ET-012b: the edit mode flag is display-only and changes no section, value or freshness.
it('marks the edit mode without changing any section or value, and defaults to driving mode', () => {
  const driving = overlayPresentation(live());
  expect(driving.editing).toBe(false);
  const editing = overlayPresentation(live(), undefined, undefined, undefined, true);
  expect(editing).toEqual({...driving, editing: true});
  const stale = {...live(), fresh: false, status: 'stale' as const};
  expect(overlayPresentation(stale, undefined, undefined, editing, true)).toMatchObject({freshness: 'stale', editing: true, speed: '—'});
  expect(overlayPresentation(initialLive('game'), undefined, undefined, undefined, true)).toMatchObject({source: 'No game', freshness: 'unavailable', editing: true});
});
