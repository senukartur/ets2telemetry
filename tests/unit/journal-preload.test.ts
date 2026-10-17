// ET-016 PR-3 (J10): the five journal read methods of the dashboard preload, and since PR-5 the sixth, the trip export.
// Each validates its arguments before it invokes its fixed channel and forwards only a fresh copy of the validated values;
// anything else rejects without IPC. Expected values are written by hand from J10.
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DesktopBridge} from '../../packages/contracts/src';

const TRIP = '7a000000-0000-4000-8000-00000000000b';
let ipc: EventEmitter & {send: ReturnType<typeof vi.fn>; invoke: ReturnType<typeof vi.fn>};
let bridge: DesktopBridge;
beforeEach(async () => {
  vi.resetModules();
  ipc = Object.assign(new EventEmitter(), {send: vi.fn(), invoke: vi.fn(() => Promise.resolve({ok: false, code: 'DATABASE_OPENING'}))});
  vi.doMock('electron', () => ({ipcRenderer: ipc, contextBridge: {exposeInMainWorld: (_key: string, value: DesktopBridge) => {bridge = value;}}}));
  await import('../../apps/desktop/src/preload');
});
afterEach(() => {vi.doUnmock('electron');});

it('appends the six journal methods after the overlay edit methods of the frozen bridge', () => {
  expect(Object.isFrozen(bridge)).toBe(true);
  // ET-016 PR-5 appends exportJournalTrip after the five reads (J10). ET-017 PR-4 appends the plugin setup methods after
  // them, so the journal block is located from the overlay edit methods instead of the end of the bridge.
  const keys = Object.keys(bridge), start = keys.indexOf('finishOverlayEdit');
  expect(keys.slice(start, start + 7)).toEqual(['finishOverlayEdit', 'listJournalTrips', 'getJournalTrip', 'listJournalEvents', 'listJournalIntervals', 'listJournalSamples',
    'exportJournalTrip']);
});

it('forwards exactly a validated trip UUID on the export channel and nothing else (ET-016 PR-5, J16)', async () => {
  await bridge.exportJournalTrip(TRIP);
  expect(ipc.invoke.mock.calls).toEqual([['journal:export-trip', TRIP]]);
  for (const id of [TRIP.toUpperCase(), 'C:\\Users\\owner\\trip.json', '', 42, null, undefined, {tripUuid: TRIP}]) {
    await expect(bridge.exportJournalTrip(id as string)).rejects.toThrow('Invalid journal request');
  }
  expect(ipc.invoke).toHaveBeenCalledTimes(1);
  expect(ipc.send).not.toHaveBeenCalled();
});

it('forwards validated arguments on the fixed channels and resolves with main\'s answer', async () => {
  await expect(bridge.listJournalTrips()).resolves.toEqual({ok: false, code: 'DATABASE_OPENING'});
  await bridge.listJournalTrips({cursor: '9223372036854775807', game: 'ats', outcome: 'cancelled', completeness: 'complete'});
  await bridge.listJournalTrips({game: undefined, outcome: 'none'});
  await bridge.getJournalTrip(TRIP);
  await bridge.listJournalEvents(TRIP);
  await bridge.listJournalEvents(TRIP, '18446744073709551614');
  await bridge.listJournalIntervals(TRIP, '7');
  await bridge.listJournalSamples(TRIP);
  await bridge.listJournalSamples(TRIP, '310');
  expect(ipc.invoke.mock.calls).toEqual([
    ['journal:list-trips', {}],
    ['journal:list-trips', {cursor: '9223372036854775807', game: 'ats', outcome: 'cancelled', completeness: 'complete'}],
    ['journal:list-trips', {outcome: 'none'}],
    ['journal:get-trip', TRIP],
    ['journal:list-events', TRIP, null],
    ['journal:list-events', TRIP, '18446744073709551614'],
    ['journal:list-intervals', TRIP, '7'],
    ['journal:list-samples', TRIP, null],
    ['journal:list-samples', TRIP, '310']
  ]);
  expect(ipc.send).not.toHaveBeenCalled();
});

it('forwards a fresh copy of the filter, never the renderer object', async () => {
  const filter = {game: 'ets2' as const};
  await bridge.listJournalTrips(filter);
  const forwarded = ipc.invoke.mock.calls[0][1] as unknown;
  expect(forwarded).toEqual({game: 'ets2'});
  expect(forwarded).not.toBe(filter);
  // A filter read through a prototype is not forwarded.
  await bridge.listJournalTrips(Object.create({game: 'ats'}) as never);
  expect(ipc.invoke.mock.calls[1]).toEqual(['journal:list-trips', {}]);
});

const INVALID_UUIDS = [TRIP.toUpperCase(), `{${TRIP}}`, TRIP.slice(1), 'C:\\Users\\owner\\telemetry.sqlite', '', 42, null, undefined, {tripUuid: TRIP}];
it.each(INVALID_UUIDS)('rejects the trip id %j in every trip method without IPC', async tripUuid => {
  const id = tripUuid as string;
  await expect(bridge.getJournalTrip(id)).rejects.toThrow('Invalid journal request');
  await expect(bridge.listJournalEvents(id)).rejects.toThrow('Invalid journal request');
  await expect(bridge.listJournalIntervals(id)).rejects.toThrow('Invalid journal request');
  await expect(bridge.listJournalSamples(id)).rejects.toThrow('Invalid journal request');
  expect(ipc.invoke).not.toHaveBeenCalled();
});

it.each<[string, (bridge: DesktopBridge) => Promise<unknown>]>([
  ['an event cursor beyond the last eventSeq', b => b.listJournalEvents(TRIP, '18446744073709551615')],
  ['an event cursor of 0', b => b.listJournalEvents(TRIP, '0')],
  ['an interval cursor beyond 2^63 - 1', b => b.listJournalIntervals(TRIP, '9223372036854775808')],
  ['a numeric sample cursor', b => b.listJournalSamples(TRIP, 310 as never)],
  ['a null sample cursor', b => b.listJournalSamples(TRIP, null as never)],
  ['a page size in the filter', b => b.listJournalTrips({limit: 51} as never)],
  ['an unknown filter key', b => b.listJournalTrips({path: 'C:\\'} as never)],
  ['an unlisted game', b => b.listJournalTrips({game: 'ets' as never})],
  ['an unlisted outcome', b => b.listJournalTrips({outcome: 'finished' as never})],
  ['an unlisted completeness', b => b.listJournalTrips({completeness: 'full' as never})],
  ['a trip cursor of 0', b => b.listJournalTrips({cursor: '0'})],
  ['a filter that is not an object', b => b.listJournalTrips('ets2' as never)],
  ['a null filter', b => b.listJournalTrips(null as never)]
])('rejects %s without IPC', async (_name, call) => {
  await expect(call(bridge)).rejects.toThrow('Invalid journal request');
  expect(ipc.invoke).not.toHaveBeenCalled();
});
