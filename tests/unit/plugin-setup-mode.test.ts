import {describe, expect, it} from 'vitest';
import {pluginSetupMode} from '../../apps/desktop/src/plugin-setup/mode';

// REG-015 (ET-017 P15): the plugin setup mode gate. Every row of the P15 table, written by hand; the first matching row
// wins. The existing harness environments must all land in `disabled`, so no smoke, test or development launch ever
// discovers a game or writes into a game folder.

const ROOT = 'C:\\ets2telemetry-test\\plugin-root';
const PROFILE = 'C:\\ets2telemetry-test\\profile';

describe('P15 rows in order', () => {
  it('row 1: ETS2TELEMETRY_PLUGIN_SETUP=off disables setup, before any other row', () => {
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'off'}, true)).toEqual({mode: 'disabled', reason: 'off'});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'off', ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT, ETS2TELEMETRY_PROFILE_DIR: PROFILE}, true))
      .toEqual({mode: 'disabled', reason: 'off'});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'off'}, false)).toEqual({mode: 'disabled', reason: 'off'});
  });

  it('row 2: an absolute test root with an absolute profile directory is the test-root mode, packaged or not', () => {
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT, ETS2TELEMETRY_PROFILE_DIR: PROFILE}, false)).toEqual({mode: 'test-root', root: ROOT});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: `${ROOT}\\`, ETS2TELEMETRY_PROFILE_DIR: PROFILE}, true)).toEqual({mode: 'test-root', root: ROOT});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: 'C:/ets2telemetry-test/plugin-root', ETS2TELEMETRY_PROFILE_DIR: PROFILE}, false))
      .toEqual({mode: 'test-root', root: ROOT});
    // The other isolation variables of a smoke do not change the row.
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT, ETS2TELEMETRY_PROFILE_DIR: PROFILE, ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\d',
      ETS2TELEMETRY_LIVE_SMOKE: '1', ETS2TELEMETRY_SOURCE_KIND: 'synthetic'}, true)).toEqual({mode: 'test-root', root: ROOT});
  });

  it('row 3: a test root without a profile directory, a relative one or an unusable one is disabled and rejected', () => {
    const rejected = (rejection: string) => ({mode: 'disabled', reason: 'root-rejected', rejected: rejection});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT}, true)).toEqual(rejected('no-profile'));
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT, ETS2TELEMETRY_PROFILE_DIR: ''}, true)).toEqual(rejected('no-profile'));
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: ROOT, ETS2TELEMETRY_PROFILE_DIR: 'relative\\profile'}, true)).toEqual(rejected('relative-profile'));
    for (const root of ['relative\\root', '.\\root', 'C:root', '\\root', '\\\\server\\share\\root', '\\\\?\\C:\\root', '\\\\.\\C:\\root', '\\??\\C:\\root']) {
      expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: root, ETS2TELEMETRY_PROFILE_DIR: PROFILE}, true), root).toEqual(rejected('relative-root'));
    }
    // A bare drive would make every folder of that drive, including a real Steam library, "inside" the root.
    for (const root of ['C:\\', 'D:/', 'c:\\\\', 'C:\\Steam\\..', 'C:\\a\\..\\.\\']) {
      expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: root, ETS2TELEMETRY_PROFILE_DIR: PROFILE}, true), root).toEqual(rejected('drive-root'));
    }
  });

  it('row 4: any isolation variable without a test root disables setup, also packaged and with =real', () => {
    for (const name of ['ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR', 'ETS2TELEMETRY_LIVE_SMOKE', 'ETS2TELEMETRY_SOURCE_KIND']) {
      expect(pluginSetupMode({[name]: name === 'ETS2TELEMETRY_LIVE_SMOKE' ? '1' : 'C:\\isolated'}, true), name).toEqual({mode: 'disabled', reason: 'isolated-launch'});
      expect(pluginSetupMode({[name]: 'x', ETS2TELEMETRY_PLUGIN_SETUP: 'real'}, false), name).toEqual({mode: 'disabled', reason: 'isolated-launch'});
    }
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'real', ETS2TELEMETRY_PROFILE_DIR: PROFILE}, true)).toEqual({mode: 'disabled', reason: 'isolated-launch'});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'real', ETS2TELEMETRY_PROFILE_DIR: PROFILE}, false)).toEqual({mode: 'disabled', reason: 'isolated-launch'});
  });

  it('row 5: an unpackaged launch is disabled unless ETS2TELEMETRY_PLUGIN_SETUP=real', () => {
    expect(pluginSetupMode({}, false)).toEqual({mode: 'disabled', reason: 'development'});
    for (const value of ['', 'on', 'REAL', 'true', '1']) {
      expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: value}, false), value).toEqual({mode: 'disabled', reason: 'development'});
    }
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'real'}, false)).toEqual({mode: 'active'});
  });

  it('row 6: anything else is active', () => {
    expect(pluginSetupMode({}, true)).toEqual({mode: 'active'});
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP: 'real'}, true)).toEqual({mode: 'active'});
    // Empty variables count as unset, as for the profile override in main.
    expect(pluginSetupMode({ETS2TELEMETRY_PLUGIN_SETUP_ROOT: '', ETS2TELEMETRY_PROFILE_DIR: '', ETS2TELEMETRY_DIAGNOSTIC_DIR: '', ETS2TELEMETRY_LIVE_SMOKE: '',
      ETS2TELEMETRY_SOURCE_KIND: ''}, true)).toEqual({mode: 'active'});
    // Unrelated variables, such as the CAP0 capture request, do not change the mode.
    expect(pluginSetupMode({ETS2TELEMETRY_CAPTURE: 'cap0', LOCALAPPDATA: 'C:\\Users\\driver\\AppData\\Local'}, true)).toEqual({mode: 'active'});
  });
});

describe('existing harnesses', () => {
  // The environments the existing launchers set, copied from them by hand. Each lands in `disabled`.
  const harnesses: Record<string, {env: Record<string, string>; packaged: boolean}> = {
    'runtime smokes (scripts/ci/runtime-smoke.mjs), development': {packaged: false,
      env: {LOCALAPPDATA: 'C:\\ci\\local', ETS2TELEMETRY_PROFILE_DIR: 'C:\\ci\\profile', ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\ci\\diagnostics'}},
    'runtime smokes with a live source, packaged': {packaged: true,
      env: {ETS2TELEMETRY_PROFILE_DIR: 'C:\\ci\\profile', ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\ci\\diagnostics', ETS2TELEMETRY_LIVE_SMOKE: '1',
        ETS2TELEMETRY_SOURCE_KIND: 'synthetic', ETS2TELEMETRY_SOURCE_PIPE: '\\\\.\\pipe\\ets2telemetry-smoke'}},
    'Playwright startup (tests/electron/startup.spec.ts), packaged': {packaged: true,
      env: {TEMP: 'C:\\t', LOCALAPPDATA: 'C:\\t', ETS2TELEMETRY_PROFILE_DIR: 'C:\\t\\profile', ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\t\\diagnostics'}},
    'native installer acceptance and the VM harness, packaged': {packaged: true,
      env: {ETS2TELEMETRY_PROFILE_DIR: 'C:\\scratch\\profile', ETS2TELEMETRY_DIAGNOSTIC_DIR: 'C:\\scratch\\diagnostics'}},
    'main-boundaries unit fixture, unpackaged': {packaged: false, env: {ETS2TELEMETRY_SOURCE_KIND: 'synthetic'}},
    'npm run dev': {packaged: false, env: {}}
  };
  it.each(Object.entries(harnesses))('%s is disabled', (_name, {env, packaged}) => {
    expect(pluginSetupMode(env, packaged).mode).toBe('disabled');
  });
});
