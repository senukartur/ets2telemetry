import type {DesktopBridge, GearboxIdentity, SettingsView, UnitGame} from '../../../packages/contracts/src';
import {isGearboxIdentity, isGearboxLabel} from './gearbox-gear-display';
import {isGearDisplayMode, isUnitGame} from './unit-profiles';

// ET-050: the gear display card's save request, kept free of React so that it can be tested in plain Node. The card shows
// only the committed mode from main's settings view; this helper never applies a choice before main saved it.

export type GearDisplayRequest = 'idle' | 'saving' | 'failed';

/**
 * Requests one game's gear display mode. An invalid game or mode makes no bridge call and changes no state. Otherwise the
 * state becomes `saving`; a resolved save hands main's settings view to `onSaved` and returns to `idle`, and a rejected
 * one becomes `failed`, leaving the previous committed mode in use.
 */
export function chooseGearDisplay(bridge: Pick<DesktopBridge, 'setGearDisplay'>, game: UnitGame, value: string,
  handlers: {onSaved: (view: SettingsView) => void; onState: (state: GearDisplayRequest) => void}): Promise<void> {
  if (!isUnitGame(game) || !isGearDisplayMode(value)) return Promise.resolve();
  handlers.onState('saving');
  return bridge.setGearDisplay(game, value).then(view => {
    handlers.onSaved(view);
    handlers.onState('idle');
  }, () => handlers.onState('failed'));
}

/** The per-gearbox choice that removes the gearbox's own mode, so that the game's mode applies to it again. */
export const GAME_GEAR_DISPLAY = 'game';

/**
 * Requests one gearbox's own gear display mode (ET-050b, settings v12), or with GAME_GEAR_DISPLAY its removal. Like
 * chooseGearDisplay, an invalid request makes no bridge call and changes no state, and only a resolved save applies.
 */
export function chooseGearboxGearDisplay(bridge: Pick<DesktopBridge, 'setGearboxGearDisplay'>, game: UnitGame, gearbox: GearboxIdentity, label: string,
  value: string, handlers: {onSaved: (view: SettingsView) => void; onState: (state: GearDisplayRequest) => void}): Promise<void> {
  const mode = value === GAME_GEAR_DISPLAY ? null : value;
  if (!isUnitGame(game) || !isGearboxIdentity(gearbox) || !isGearboxLabel(label) || (mode !== null && !isGearDisplayMode(mode))) return Promise.resolve();
  handlers.onState('saving');
  return bridge.setGearboxGearDisplay(game, gearbox, label, mode).then(view => {
    handlers.onSaved(view);
    handlers.onState('idle');
  }, () => handlers.onState('failed'));
}
