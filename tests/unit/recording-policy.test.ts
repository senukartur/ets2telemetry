// The recording gate of the telemetry service (ET-015a, R3). Expected plans are written by hand from the decision R3
// (concept.md) and docs/telemetry-service-v1.md: production records no game history, and ETS2TELEMETRY_RECORDING can
// only select a named synthetic or replay database, never the history path.
import {describe, expect, it, vi} from 'vitest';
import {GAME_HISTORY_RECORDING, RECORDING_NAME_PATTERN, recordingPlan} from '../../apps/desktop/src/recording-policy';

const plan = (value: string | undefined, gameHistory = false) => {
  const log = vi.fn();
  return {plan: recordingPlan({ETS2TELEMETRY_RECORDING: value}, {gameHistory, log}), log: log.mock.calls};
};

describe('recording gate (R3)', () => {
  it('tripwire: production records game history since the owner authorization of October 25, 2026', () => {
    // Changing this value is an owner decision (AGENTS.md, "Game history recording enablement"); this test must change
    // with it, never on its own.
    expect(GAME_HISTORY_RECORDING).toBe(true);
  });

  it('opens history with no durable selection when the variable is unset or empty', () => {
    expect(recordingPlan({}, {gameHistory: false})).toEqual({database: {purpose: 'history'}, durableSelections: []});
    expect(plan(undefined)).toEqual({plan: {database: {purpose: 'history'}, durableSelections: []}, log: []});
    expect(plan('')).toEqual({plan: {database: {purpose: 'history'}, durableSelections: []}, log: []});
  });

  it('makes only the game selections durable in history once game recording is enabled', () => {
    expect(plan(undefined, true)).toEqual({plan: {database: {purpose: 'history'}, durableSelections: ['ets2', 'ats']}, log: []});
  });

  it('selects a named synthetic or replay database instead of history, durable only for the matching selection', () => {
    expect(plan('synthetic:abc')).toEqual({plan: {database: {purpose: 'synthetic', name: 'abc'}, durableSelections: ['synthetic']}, log: []});
    expect(plan('replay:x')).toEqual({plan: {database: {purpose: 'replay', name: 'x'}, durableSelections: ['replay']}, log: []});
    expect(plan('synthetic:smoke-01')).toEqual({plan: {database: {purpose: 'synthetic', name: 'smoke-01'}, durableSelections: ['synthetic']}, log: []});
    const longest = 'a'.repeat(64);
    expect(plan(`replay:${longest}`).plan).toEqual({database: {purpose: 'replay', name: longest}, durableSelections: ['replay']});
    // A recording target never makes a game selection durable, even with game recording enabled: its database's
    // purpose refuses the game origin.
    expect(plan('synthetic:t', true).plan).toEqual({database: {purpose: 'synthetic', name: 't'}, durableSelections: ['synthetic']});
  });

  it.each([
    ['history'], ['synthetic:'], ['synthetic:A'], ['synthetic:../x'], [`synthetic:${'a'.repeat(65)}`], ['game:x'],
    ['replay:..'], ['synthetic:a.b'], ['synthetic:a/b'], ['synthetic:a\\b'], ['synthetic:x\n'], [' synthetic:x'], ['Synthetic:x'], ['synthetic:x:y'],
    ['history:telemetry'], ['synthetic'], ['C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry\\data\\telemetry.sqlite']
  ])('rejects %j once and falls back to history without a durable selection', value => {
    expect(plan(value)).toEqual({plan: {database: {purpose: 'history'}, durableSelections: []}, log: [['RECORDING_TARGET_REJECTED']]});
    // With game recording enabled the fallback is exactly the default plan, never a synthetic database.
    expect(plan(value, true)).toEqual({plan: {database: {purpose: 'history'}, durableSelections: ['ets2', 'ats']}, log: [['RECORDING_TARGET_REJECTED']]});
  });

  it('accepts only lower-case letters, digits and hyphens as a database name', () => {
    for (const name of ['a', 'smoke', 'run-2', '0', 'a'.repeat(64)]) expect(RECORDING_NAME_PATTERN.test(name)).toBe(true);
    for (const name of ['', 'A', 'a b', 'a.b', '..', 'a/b', 'a\\b', 'telemetry.sqlite', 'a'.repeat(65), 'x\n']) expect(RECORDING_NAME_PATTERN.test(name)).toBe(false);
  });
});
