import {describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES} from '../../apps/desktop/src/channel';
import type {UninstallRoots} from '../../apps/desktop/src/uninstall/roots';
import {resolveUpdateContext, TEST_FEED_ORIGIN_VARIABLE, TEST_PUBLIC_KEY_VARIABLE} from '../../apps/desktop/src/updater/update-context';
import {GITHUB_ORIGINS} from '../../apps/desktop/src/updater/update-feed';
import {UPDATE_PUBLIC_KEYS} from '../../apps/desktop/src/updater/update-keys';
import {testKey} from '../shared/update-fixtures';

// ET-055 UP6, UP7, UP19: which launches check for updates, and the only mode that may use a loopback feed and a test key.
// Pure decision on literal roots; no file system or network is touched.

const KEY = testKey().publicKey.publicKey;
const EXE = 'C:\\Users\\owner\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.2.0\\ETS2TelemetryDesktop.exe';
const PRODUCTION_ROOTS: UninstallRoots = {ok: true, mode: 'production', appDirectory: 'C:\\Users\\owner\\AppData\\Local\\ETS2TelemetryDesktop\\app-0.2.0',
  installRoot: 'C:\\Users\\owner\\AppData\\Local\\ETS2TelemetryDesktop', base: 'C:\\Users\\owner\\AppData\\Local', dataRoot: 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry'};
const TEST_ROOT = 'D:\\a\\_temp\\update-root';
const TEST_ROOTS: UninstallRoots = {ok: true, mode: 'test-root', testRoot: TEST_ROOT, testFile: {profileDir: `${TEST_ROOT}\\profile`, runOnceKey: null, shortcuts: false},
  appDirectory: `${TEST_ROOT}\\LocalAppData\\ETS2TelemetryDesktop\\app-0.2.0`, installRoot: `${TEST_ROOT}\\LocalAppData\\ETS2TelemetryDesktop`, base: `${TEST_ROOT}\\LocalAppData`,
  dataRoot: `${TEST_ROOT}\\LocalAppData\\ETS2Telemetry`};
const TEST_ENV = {ETS2TELEMETRY_PROFILE_DIR: `${TEST_ROOT}\\profile`, [TEST_FEED_ORIGIN_VARIABLE]: 'http://127.0.0.1:41234', [TEST_PUBLIC_KEY_VARIABLE]: KEY};
const resolve = (roots: UninstallRoots, env: Record<string, string | undefined> = {}, packaged = true) =>
  resolveUpdateContext({packaged, roots, env, executable: EXE, identity: CHANNEL_IDENTITIES.production});

describe('resolveUpdateContext', () => {
  it('checks a production install against GitHub with the compiled keys of its channel', () => {
    expect(resolve(PRODUCTION_ROOTS)).toEqual({ok: true, context: {installRoot: PRODUCTION_ROOTS.ok && PRODUCTION_ROOTS.installRoot, dataRoot: 'C:\\Users\\owner\\AppData\\Local\\ETS2Telemetry',
      executableName: 'ETS2TelemetryDesktop.exe', origins: GITHUB_ORIGINS, keys: UPDATE_PUBLIC_KEYS.production, mode: 'production'}});
  });
  it('never checks an unpackaged, portable or isolated launch', () => {
    expect(resolve(PRODUCTION_ROOTS, {}, false)).toEqual({ok: false, reason: 'unpackaged'});
    for (const code of ['NOT_INSTALLED', 'ROOT_MISMATCH', 'LAYOUT_INVALID', 'DATA_ROOT_LINKED', 'TEST_ROOT_INVALID'] as const)
      expect(resolve({ok: false, code})).toEqual({ok: false, reason: 'not-installed'});
    for (const name of ['ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR', 'ETS2TELEMETRY_LIVE_SMOKE', 'ETS2TELEMETRY_SOURCE_KIND'])
      expect(resolve(PRODUCTION_ROOTS, {[name]: 'C:\\isolated'}), name).toEqual({ok: false, reason: 'isolated'});
    // An empty variable counts as unset, as in the plugin-setup mode gate.
    expect(resolve(PRODUCTION_ROOTS, {ETS2TELEMETRY_PROFILE_DIR: ''}).ok).toBe(true);
  });
  it('ignores the test feed and key in a production install', () => {
    expect(resolve(PRODUCTION_ROOTS, {[TEST_FEED_ORIGIN_VARIABLE]: 'http://127.0.0.1:41234', [TEST_PUBLIC_KEY_VARIABLE]: KEY}))
      .toMatchObject({ok: true, context: {origins: GITHUB_ORIGINS, keys: UPDATE_PUBLIC_KEYS.production, mode: 'production'}});
  });
  it('uses the loopback feed and only the test key in a test-root install with a profile inside the root', () => {
    expect(resolve(TEST_ROOTS, TEST_ENV)).toEqual({ok: true, context: {installRoot: `${TEST_ROOT}\\LocalAppData\\ETS2TelemetryDesktop`, dataRoot: `${TEST_ROOT}\\LocalAppData\\ETS2Telemetry`,
      executableName: 'ETS2TelemetryDesktop.exe', origins: {web: 'http://127.0.0.1:41234', api: 'http://127.0.0.1:41234'}, keys: [{keyId: 'test', publicKey: KEY}], mode: 'test-root'}});
  });
  it.each([
    ['no profile', {...TEST_ENV, ETS2TELEMETRY_PROFILE_DIR: undefined}],
    ['a profile outside the test root', {...TEST_ENV, ETS2TELEMETRY_PROFILE_DIR: 'C:\\Users\\owner\\profile'}],
    ['a relative profile', {...TEST_ENV, ETS2TELEMETRY_PROFILE_DIR: 'profile'}],
    ['no feed', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: undefined}],
    ['an HTTPS feed', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'https://127.0.0.1:41234'}],
    ['a non-loopback feed', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'http://192.168.1.10:41234'}],
    ['a named host', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'http://localhost:41234'}],
    ['a feed with a path', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'http://127.0.0.1:41234/feed'}],
    ['port 0', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'http://127.0.0.1:0'}],
    ['a port above 65535', {...TEST_ENV, [TEST_FEED_ORIGIN_VARIABLE]: 'http://127.0.0.1:70000'}],
    ['no key', {...TEST_ENV, [TEST_PUBLIC_KEY_VARIABLE]: undefined}],
    ['a short key', {...TEST_ENV, [TEST_PUBLIC_KEY_VARIABLE]: KEY.slice(4)}]
  ])('never checks a test-root install with %s', (_name, env) => {
    expect(resolve(TEST_ROOTS, env)).toEqual({ok: false, reason: 'isolated'});
  });
});
