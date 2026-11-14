import {readFileSync} from 'node:fs';
import {expect, it} from 'vitest';
import type {JournalInterval, JournalSample, JournalTripDetail, LiveTelemetry} from '../../packages/contracts/src';
import {validateMessage} from '../../packages/contracts/src/protocol-v0';
import {truckPowertrain} from '../../packages/telemetry-core/src/truck-powertrain';
import {initialLive} from '../../apps/desktop/src/live-state';
import {liveDashboardText} from '../../apps/desktop/src/live-dashboard-text';
import {dashboardFuel} from '../../apps/desktop/src/speed-display';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {DEFAULT_OVERLAY_SETTINGS, OVERLAY_LAYOUTS} from '../../apps/desktop/src/overlay-sections';
import {overlayView} from '../../apps/desktop/src/overlay-view';
import {journalDetailText, journalSampleText} from '../../apps/desktop/src/journal-view';
import {TripExportSerializer, tripExportHeader} from '../../apps/desktop/src/journal-export';
import {DETAIL, INTERVAL, SAMPLE} from '../shared/journal-replies';

const DAF = 'vehicle.daf.xf_electric', VOLVO = 'vehicle.volvo.vnr_e';
const noId = {available: false, reason: 'not-observed'} as const;
const value = <T>(value: T) => ({available: true as const, value});

function current(game: 'ets2' | 'ats', id: string | null): LiveTelemetry {
  const message = validateMessage(JSON.parse(readFileSync('tests/fixtures/protocol-v0/snapshot.json', 'utf8')));
  if (message.kind !== 'snapshot') throw new Error('Expected snapshot');
  const state = message.data.state;
  state.configuration.truckId = id === null ? noId : value(id);
  state.fuel = {...value(73), unit: 'L'};
  state.fuelCapacity = {...value(525), unit: 'L'};
  state.averageConsumption = {...value(101.15), unit: 'L/100km'};
  return {...initialLive(game), fresh: true, status: 'connected', observation: {
    source: {...message.source, game, origin: 'game'}, capture: message.capture, state, seq: message.seq,
    receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0, windowFresh: true,
    applied: {hydration: false, skippedSequences: '0', continuity: message.data.continuity}
  }};
}

it('recognizes the stock model IDs in the corresponding game and treats other IDs as diesel', () => {
  expect([DAF, 'vehicle.renault.etech_t', 'vehicle.scania.s_2024e'].map(id => truckPowertrain('ets2', id))).toEqual(['electric', 'electric', 'electric']);
  expect(truckPowertrain('ats', VOLVO)).toBe('electric');
  expect(truckPowertrain('ats', DAF)).toBe('diesel');
  expect(truckPowertrain('ets2', 'vehicle.scania.s_2016')).toBe('diesel');
  expect(truckPowertrain('ats', 'vehicle.volvo.vnr_e_custom')).toBe('diesel');
  expect(truckPowertrain('ets2', null)).toBe('unknown');
});

it.each([['ets2', DAF], ['ats', VOLVO]] as const)('shows electric values through Live and every %s overlay layout', (game, id) => {
  const live = current(game, id);
  expect(dashboardFuel(live, 'us-customary', 'ru')).toBe('73.0 кВт·ч');
  const rows = liveDashboardText(live, undefined, 'ru').sections.flatMap(section => section.rows);
  expect(rows.find(row => row.id === 'fuel-capacity')).toMatchObject({label: 'Ёмкость батареи', value: '525 кВт·ч'});
  expect(rows.find(row => row.id === 'sdk-average-consumption')).toMatchObject({value: '101.2 кВт·ч/100 км'});
  for (const layout of OVERLAY_LAYOUTS) {
    const settings = {...DEFAULT_OVERLAY_SETTINGS, layout, sections: {...DEFAULT_OVERLAY_SETTINGS.sections, 'sdk-consumption': true}};
    const presentation = overlayPresentation(live, undefined, settings, undefined, false, 'ru');
    expect(presentation).toMatchObject({layout, fuel: '73', fuelUnit: 'kWh'});
    const {items} = overlayView(presentation);
    expect(items.find(item => item.id === 'fuel')).toMatchObject({label: 'Заряд', value: '73', unit: 'кВт·ч', detail: '14%'});
    expect(items.find(item => item.id === 'sdk-consumption')).toMatchObject({value: '101 кВт·ч/100 км'});
    const missing = overlayPresentation(current(game, null), undefined, settings, presentation);
    expect(missing).toMatchObject({fuel: '—', fuelUnit: null});
    expect(missing.sections.find(section => section.id === 'fuel')?.state).toBe('unavailable');
    expect(dashboardFuel(current(game, null))).toBe('unavailable');
  }
});

it('uses recorded units in Journal and in the version 7 export, including a mixed sample page and a charge increase', () => {
  const detail = structuredClone(DETAIL) as unknown as JournalTripDetail;
  detail.truck!.values.id = value(DAF);
  detail.truck!.values.fuelCapacity = {...value(525), unit: 'L'};
  detail.energyPowertrain = 'electric';
  detail.trip.fuelUsedL = value(176.2);
  const rows = journalDetailText(detail).sections.flatMap(section => section.fields);
  expect(rows.find(row => row.id === 'fuelUsed')).toMatchObject({label: 'Energy used', value: '176.2 kWh'});
  expect(rows.find(row => row.id === 'fuelCapacity')).toMatchObject({label: 'Battery capacity', value: '525.0 kWh'});
  const sample = {...SAMPLE, fuel: value(358.3), averageConsumption: value(101.15)} as unknown as JournalSample;
  const electric = {...sample, powertrain: 'electric' as const};
  const diesel = {...sample, id: '12', powertrain: 'diesel' as const, fuel: value(73)};
  const unknown = {...sample, id: '13', powertrain: 'unknown' as const};
  const page = journalSampleText({database: detail.database, samples: [electric, diesel, unknown], nextCursor: null}, 'ets2');
  expect(page.rows).toMatchObject([
    {fuel: '358.3 kWh', consumption: '101.2 kWh/100 km'},
    {fuel: '73.0 L', consumption: '101.2 L/100 km'},
    {fuel: 'unavailable (not observed)', consumption: 'unavailable (not observed)'}
  ]);
  const header = tripExportHeader({uuid: 'f0000000-0000-4000-8000-000000000001', ...detail.database}, 'test', 0);
  const serializer = new TripExportSerializer(detail, header);
  const interval = {...INTERVAL, cause: 'refuel', detail: {cause: 'refuel', annotation: true, addedLiters: 30, powertrain: 'electric'}} as unknown as JournalInterval;
  const exported = JSON.parse(serializer.begin() + serializer.rows('intervals', [interval]) + serializer.rows('samples', [electric, diesel, unknown]) + serializer.end());
  expect(exported).toMatchObject({formatVersion: 7, trip: {powertrain: 'electric', energyUsed: {available: true, value: 176.2, unit: 'kWh'}},
    truck: {values: {fuelCapacity: {value: 525, unit: 'kWh'}}}, samples: [{powertrain: 'electric'}, {powertrain: 'diesel'}, {powertrain: 'unknown'}],
    intervals: [{detail: {powertrain: 'electric', amountAdded: {value: 30, unit: 'kWh'}}}]});
  expect(exported.trip).not.toHaveProperty('fuelUsedL');
  expect(exported.intervals[0].detail).not.toHaveProperty('addedLiters');
});
