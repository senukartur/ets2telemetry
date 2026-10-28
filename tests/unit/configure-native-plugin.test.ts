import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {refusedConfigureArgument} from '../../scripts/configure-native-plugin.mjs';

// ET-055 PR-4 review (REG-017): `npm run native:configure` passes the resolved channel to CMake, and CMake applies the last
// definition it sees. An extra argument that defines ETS2TELEMETRY_CHANNEL, loads an initial cache, removes cache entries or
// selects a preset would leave a tree of another channel, so it is refused before CMake runs.

const checkout = path.resolve(import.meta.dirname, '..', '..');

describe('the extra arguments of native:configure', () => {
  it('passes ordinary CMake arguments through', () => {
    expect(refusedConfigureArgument([])).toBeNull();
    expect(refusedConfigureArgument(['-G', 'Visual Studio 17 2022'])).toBeNull();
    expect(refusedConfigureArgument(['-DETS2TELEMETRY_ASAN_TESTS=ON', '--fresh', '-Wdev', '-D', 'OTHER=1'])).toBeNull();
  });

  it.each([
    [['-DETS2TELEMETRY_CHANNEL=production'], '-DETS2TELEMETRY_CHANNEL=production'],
    [['-G', 'Ninja', '-DETS2TELEMETRY_CHANNEL:STRING=production'], '-DETS2TELEMETRY_CHANNEL:STRING=production'],
    [['-Dets2telemetry_channel=staging'], '-Dets2telemetry_channel=staging'],
    [['-D', 'ETS2TELEMETRY_CHANNEL=production'], '-D ETS2TELEMETRY_CHANNEL=production'],
    [['-D ETS2TELEMETRY_CHANNEL=production'], '-D ETS2TELEMETRY_CHANNEL=production'],
    [['-C', 'cache.cmake'], '-C'],
    [['-Ccache.cmake'], '-Ccache.cmake'],
    [['-U', 'ETS2TELEMETRY_*'], '-U'],
    [['-UETS2TELEMETRY_CHANNEL'], '-UETS2TELEMETRY_CHANNEL'],
    [['--preset', 'release'], '--preset'],
    [['--preset=release'], '--preset=release']
  ])('refuses %j', (args, refused) => {
    expect(refusedConfigureArgument(args)).toBe(refused);
  });

  it('stops before CMake runs, with a message that names the variable to use', () => {
    const run = spawnSync(process.execPath, [path.join(checkout, 'scripts/configure-native-plugin.mjs'), '-DETS2TELEMETRY_CHANNEL=production'],
      {cwd: checkout, encoding: 'utf8', timeout: 30000});
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/refusing the CMake argument "-DETS2TELEMETRY_CHANNEL=production"/);
    expect(run.stderr).toMatch(/ETS2TELEMETRY_BUILD_CHANNEL/);
    expect(run.stdout).not.toMatch(/nativePluginConfigured/);
  });
});
