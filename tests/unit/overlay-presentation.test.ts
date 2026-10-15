import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {LiveTelemetry, OverlaySectionView} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {initialLive} from '../../apps/desktop/src/live-state';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {OVERLAY_PRESETS} from '../../apps/desktop/src/overlay-sections';
import {DEFAULT_OVERLAY_PLACEMENTS} from '../../apps/desktop/src/overlay-placement';

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
