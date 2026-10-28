import {expect, it, vi} from 'vitest';
import type {SettingsView} from '../../packages/contracts/src';
import {chooseGearDisplay, type GearDisplayRequest} from '../../apps/desktop/src/gear-display-choice';

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
