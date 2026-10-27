import {expect, it, vi} from 'vitest';
import type {SettingsView} from '../../packages/contracts/src';
import {chooseGearboxGearDisplay, chooseGearDisplay, GAME_GEAR_DISPLAY, type GearDisplayRequest} from '../../apps/desktop/src/gear-display-choice';

// ET-050: the gear display card's save request. The card applies only main's committed view; a failed request leaves the
// previous mode in use, and an invalid choice never reaches the bridge.
const VIEW = {gearDisplay: {ets2: 'manual', ats: 'automatic'}, state: 'loaded', writable: true, saveError: null} as unknown as SettingsView;
const setup = (result: Promise<SettingsView>) => {
  const states: GearDisplayRequest[] = [];
  const bridge = {setGearDisplay: vi.fn(() => result)}, onSaved = vi.fn();
  return {states, bridge, onSaved, handlers: {onSaved, onState: (state: GearDisplayRequest) => states.push(state)}};
};

it('hands the committed view to onSaved and returns to idle after a successful save', async () => {
  const {states, bridge, onSaved, handlers} = setup(Promise.resolve(VIEW));
  await chooseGearDisplay(bridge, 'ets2', 'manual', handlers);
  expect(bridge.setGearDisplay).toHaveBeenCalledExactlyOnceWith('ets2', 'manual');
  expect(onSaved).toHaveBeenCalledExactlyOnceWith(VIEW);
  expect(states).toEqual(['saving', 'idle']);
});
it('reports a failed save without calling onSaved', async () => {
  const {states, bridge, onSaved, handlers} = setup(Promise.reject(new Error('Settings could not be saved')));
  await chooseGearDisplay(bridge, 'ats', 'automatic', handlers);
  expect(bridge.setGearDisplay).toHaveBeenCalledExactlyOnceWith('ats', 'automatic');
  expect(onSaved).not.toHaveBeenCalled();
  expect(states).toEqual(['saving', 'failed']);
});
it.each([['ets2', 'Manual'], ['ets2', ''], ['ats', 'semi'], ['synthetic', 'manual'], ['ETS2', 'automatic']])('makes no bridge call for game %j and mode %j', async (game, mode) => {
  const {states, bridge, onSaved, handlers} = setup(Promise.resolve(VIEW));
  await chooseGearDisplay(bridge, game as never, mode, handlers);
  expect(bridge.setGearDisplay).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(states).toEqual([]);
});

// ET-050b settings v12: the per-gearbox request. "As for the game" removes the gearbox's own mode (null); an invalid request
// never reaches the bridge.
const GA867R = {model: 'vehicle.scania.r_2016', forwardGears: 6, reverseGears: 1};
const gearboxSetup = (result: Promise<SettingsView>) => {
  const states: GearDisplayRequest[] = [];
  const bridge = {setGearboxGearDisplay: vi.fn(() => result)}, onSaved = vi.fn();
  return {states, bridge, onSaved, handlers: {onSaved, onState: (state: GearDisplayRequest) => states.push(state)}};
};
it('requests a gearbox mode or, for "as for the game", its removal, and applies only the saved view', async () => {
  const saved = gearboxSetup(Promise.resolve(VIEW));
  await chooseGearboxGearDisplay(saved.bridge, 'ets2', GA867R, 'Scania R', 'automatic', saved.handlers);
  await chooseGearboxGearDisplay(saved.bridge, 'ets2', GA867R, 'Scania R', GAME_GEAR_DISPLAY, saved.handlers);
  expect(saved.bridge.setGearboxGearDisplay.mock.calls).toEqual([['ets2', GA867R, 'Scania R', 'automatic'], ['ets2', GA867R, 'Scania R', null]]);
  expect(saved.onSaved).toHaveBeenCalledTimes(2);
  expect(saved.states).toEqual(['saving', 'idle', 'saving', 'idle']);
  const failed = gearboxSetup(Promise.reject(new Error('Settings could not be saved')));
  await chooseGearboxGearDisplay(failed.bridge, 'ats', GA867R, 'Mack', 'manual', failed.handlers);
  expect(failed.onSaved).not.toHaveBeenCalled();
  expect(failed.states).toEqual(['saving', 'failed']);
});
it.each([
  ['truck', GA867R, 'Scania R', 'manual'], ['ets2', {...GA867R, label: 'Scania R'}, 'Scania R', 'manual'], ['ets2', {...GA867R, forwardGears: 0}, 'Scania R', 'manual'],
  ['ets2', GA867R, '', 'manual'], ['ets2', GA867R, 'Scania R', 'Manual'], ['ets2', GA867R, 'Scania R', 'Game']
])('makes no per-gearbox bridge call for %j %j %j %j', async (game, gearbox, label, value) => {
  const {states, bridge, onSaved, handlers} = gearboxSetup(Promise.resolve(VIEW));
  await chooseGearboxGearDisplay(bridge, game as never, gearbox, label, value, handlers);
  expect(bridge.setGearboxGearDisplay).not.toHaveBeenCalled();
  expect(onSaved).not.toHaveBeenCalled();
  expect(states).toEqual([]);
});
