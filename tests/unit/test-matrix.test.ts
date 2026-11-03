import {describe, expect, it} from 'vitest';
import {areaOf, runtimeScenariosOf} from '../../scripts/test-affected-plan.mjs';
import {MARKERS, buildMatrix, ctestEntry, junitTimes, majorityArea, reachedSources, renderMatrix, replaceSection, scenarioAreas} from '../../scripts/test-matrix.mjs';

// ET-066: the area × layer test matrix generator (docs/regression-registry.md#area--layer-matrix). Every expectation is
// written by hand from TEST_AREAS and the CI step titles of .github/workflows/windows-ci.yml, never produced by the generator.

describe('test areas', () => {
  it('gives each path the first area whose pattern matches it', () => {
    expect(Object.fromEntries(['packages/storage/src/sqlite/writes.ts', 'apps/desktop/src/overlay-geometry.ts', 'native/telemetry-client/src/main.cpp',
      'packages/telemetry-core/src/trips/reducer.ts', 'packages/telemetry-core/src/normalize-v1.ts', 'scripts/ci/runtime-smoke.mjs', 'apps/desktop/src/main.ts',
      'tools/telemetry-simulator/src/v1/soak.ts', 'apps/desktop/src/updater/update-feed.ts', 'scripts/installer/update-feed-fixture.mjs',
      'scripts/installer/installer-lifecycle.mjs', 'native/media-session-reader/src/reader.cpp', 'apps/desktop/src/hard-mode/view.ts', 'docs/TESTING.md'].map(file => [file, areaOf(file)])))
      .toEqual({'packages/storage/src/sqlite/writes.ts': 'storage', 'apps/desktop/src/overlay-geometry.ts': 'overlay', 'native/telemetry-client/src/main.cpp': 'native-client',
        'packages/telemetry-core/src/trips/reducer.ts': 'trip', 'packages/telemetry-core/src/normalize-v1.ts': 'ingestion', 'scripts/ci/runtime-smoke.mjs': 'ci',
        'apps/desktop/src/main.ts': 'shell', 'tools/telemetry-simulator/src/v1/soak.ts': 'protocol', 'apps/desktop/src/updater/update-feed.ts': 'updater',
        'scripts/installer/update-feed-fixture.mjs': 'updater', 'scripts/installer/installer-lifecycle.mjs': 'setup', 'native/media-session-reader/src/reader.cpp': 'now-playing',
        'apps/desktop/src/hard-mode/view.ts': 'hard-mode', 'docs/TESTING.md': null});
  });

  it('selects the runtime scenarios of a source as the local plan does', () => {
    expect(runtimeScenariosOf('apps/desktop/src/overlay-rows.ts')).toEqual(['overlay', 'ui:overlay']);
    expect(runtimeScenariosOf('apps/desktop/src/strings.ts')).toEqual(['scaffold', 'ui:shell']);
    expect(runtimeScenariosOf('packages/storage/src/api.ts')).toEqual(['recording', 'refusal']);
    expect(runtimeScenariosOf('tools/telemetry-simulator/src/cli.ts')).toEqual([]);
  });

  it('assigns a runtime scenario to the area of its name, else to the area that owns most of its selecting sources', () => {
    const tracked = new Set(['apps/desktop/src/overlay-rows.ts', 'apps/desktop/src/journal-view.ts', 'apps/desktop/src/trip-recorder.ts', 'apps/desktop/src/trip-seeds.ts',
      'apps/desktop/src/live-sources.ts', 'apps/desktop/src/main.ts', 'docs/journal.md']);
    // journal|trip|history|export selects journal from two trip files and one journal file; the name decides.
    // telemetry has no area of its name: live-sources.ts (ingestion) is the only source that selects it.
    expect(scenarioAreas(tracked)).toMatchObject({overlay: 'overlay', 'ui:overlay': 'overlay', journal: 'journal', telemetry: 'ingestion', scaffold: 'shell', 'session-end': 'shell'});
  });
});

describe('test entry points', () => {
  const files: Record<string, string> = {
    'tests/unit/a.test.ts': "import type {X} from '../../packages/contracts/src/journal';\nimport {helper} from '../shared/helper';\nimport {run} from '../../apps/desktop/src/overlay-view';\nconst cli = path.resolve('scripts/ci/runtime-smoke.mjs');",
    'tests/shared/helper.ts': "export {open} from '../../packages/storage/src/index';\nconst late = () => import('../../tools/telemetry-simulator/src/v1/soak.js');",
    'packages/storage/src/index.ts': "import {x} from './sqlite/writes';"
  };
  const tracked = new Set([...Object.keys(files), 'packages/contracts/src/journal.ts', 'apps/desktop/src/overlay-view.ts', 'scripts/ci/runtime-smoke.mjs',
    'tools/telemetry-simulator/src/v1/soak.ts', 'packages/storage/src/sqlite/writes.ts']);

  it('follows the test\'s own helpers and named paths, not product modules or type-only imports', () => {
    expect(reachedSources('tests/unit/a.test.ts', file => files[file], tracked))
      .toEqual(['apps/desktop/src/overlay-view.ts', 'packages/storage/src/index.ts', 'scripts/ci/runtime-smoke.mjs', 'tools/telemetry-simulator/src/v1/soak.ts']);
  });

  it('takes the area of the test name first, then the import majority without simulator tooling, then ci', () => {
    expect(majorityArea(['packages/storage/src/index.ts'], 'tests/unit/overlay-x.test.ts')).toBe('overlay');
    expect(majorityArea(['tools/telemetry-simulator/src/v1/soak.ts', 'tools/telemetry-simulator/src/v1/replay.ts', 'packages/storage/src/index.ts'], 'tests/storage/other.test.ts')).toBe('storage');
    expect(majorityArea(['tools/telemetry-simulator/src/v1/soak.ts'], 'tests/unit/other.test.ts')).toBe('protocol');
    // A tie goes to the earlier area of TEST_AREAS.
    expect(majorityArea(['packages/storage/src/index.ts', 'apps/desktop/src/overlay-view.ts'], 'tests/unit/other.test.ts')).toBe('overlay');
    expect(majorityArea([], 'tests/unit/other.test.ts')).toBe('ci');
  });

  it('folds CTest cases into families by area, with the ASan token removed', () => {
    expect(['v1-producer-asan-contract-store', 'protocol-v1-asan-contract', 'native-pipe-client-asan-discover-none', 'native-pipe-client-quiet', 'media-session-reader-snapshot',
      'game-window-monitor-contract-slow-peer', 'sdk-exports-contract'].map(ctestEntry)).toEqual([
      {area: 'native-plugin', family: 'v1-producer-contract-*'}, {area: 'protocol', family: 'protocol-v1-contract'},
      {area: 'native-client', family: 'native-pipe-client-discover-*'}, {area: 'native-client', family: 'native-pipe-client-*'},
      {area: 'now-playing', family: 'media-session-reader-snapshot'}, {area: 'overlay', family: 'game-window-monitor-contract-*'},
      {area: 'native-plugin', family: 'sdk-exports-contract'}]);
  });

  it('reads Vitest file times and CTest case times from JUnit', () => {
    const vitest = '<testsuites><testsuite name="tests/unit/a.test.ts" timestamp="t" tests="2" time="1.5"><testcase classname="x" name="y" time="1.0"></testcase></testsuite></testsuites>';
    const ctest = '<testsuite name="Win32" tests="1" time="9">\n\t<testcase name="protocol-v0-contract" classname="protocol-v0-contract" time="0.25" status="run"/></testsuite>';
    expect(junitTimes(vitest, 'testsuite')).toEqual([['tests/unit/a.test.ts', 1.5]]);
    expect(junitTimes(ctest, 'testcase')).toEqual([['protocol-v0-contract', 0.25]]);
  });
});

describe('area × layer matrix', () => {
  const matrix = buildMatrix({
    vitest: [['tests/unit/overlay-x.test.ts', 2], ['tests/unit/overlay-y.test.ts', 4]], storage: [['tests/storage/trip-x.test.ts', 12]],
    ctest: [['v1-producer-contract-store', 0.5], ['v1-producer-contract-fuzz', 1]], asan: [['v1-producer-asan-contract-fuzz', 40]],
    steps: [
      {job: 'Windows x64 runtime and UI (ui-2)', name: 'Bounded packaged Yukon UI overlay shard', seconds: 74},
      {job: 'Windows x64 runtime and UI', name: 'Bounded development hidden overlay projection and isolation smoke', seconds: 20},
      {job: 'Windows x64 compiled artifacts', name: 'Plugin image lock check', seconds: 14},
      {job: 'Windows x64 hosted installer', name: 'Update-from-feed installer lifecycle in a test root', seconds: 206},
      {job: 'Windows x64 compiled artifacts', name: 'Build desktop and native x64', seconds: 286}]
  }, file => (file.includes('overlay') ? 'overlay' : file.includes('trip') ? 'trip' : 'setup'), {'ui:overlay': 'overlay', overlay: 'overlay'});

  it('puts each entry point in its area and layer, longest first, and leaves out steps that are not tests', () => {
    expect(matrix.cells.overlay).toMatchObject({unit: [['overlay-y', 4], ['overlay-x', 2]], runtime: [['ui:overlay', 74]], extended: [['overlay (development)', 20]]});
    expect(matrix.cells.trip.storage).toEqual([['trip-x', 12]]);
    expect(matrix.cells['native-plugin']).toMatchObject({ctest: [['v1-producer-contract-*', 1.5]], asan: [['v1-producer-contract-*', 40]]});
    expect(matrix.cells.setup.chains).toEqual([['plugin-image-lock', 14]]);
    expect(matrix.cells.updater.installer).toEqual([['update-from-feed lifecycle', 206]]);
    expect(Object.values(matrix.cells).flatMap(layers => Object.values(layers).flat()).map(([entry]) => entry)).not.toContain('Build desktop and native x64');
  });

  it('renders a count and seconds per cell and the entry points per area between the markers', () => {
    const text = renderMatrix(matrix, [['1', 'Vitest JUnit']]);
    expect(text.startsWith(`${MARKERS[0]}\n`) && text.endsWith(`\n${MARKERS[1]}`)).toBe(true);
    expect(text).toContain('| Overlay | 2 · 6.0 s | — | — | — | — | 1 · 74 s | — | 1 · 20 s | 100 s |');
    expect(text).toContain('- **Overlay.** Vitest unit: `overlay-y` 4.0, `overlay-x` 2.0. Packaged runtime: `ui:overlay` 74. Extended: `overlay (development)` 20.');
  });

  it('replaces only the marked section, in the document\'s line endings, and refuses a document without one pair', () => {
    const document = `# Title\r\n\r\n${MARKERS[0]}\r\nold\r\n${MARKERS[1]}\r\nafter\r\n`;
    expect(replaceSection(document, `${MARKERS[0]}\nnew\n${MARKERS[1]}`)).toBe(`# Title\r\n\r\n${MARKERS[0]}\r\nnew\r\n${MARKERS[1]}\r\nafter\r\n`);
    expect(() => replaceSection('# Title\n', 'x')).toThrow('TEST_MATRIX_MARKERS_INVALID');
    expect(() => replaceSection(`${MARKERS[0]}${MARKERS[1]}${MARKERS[0]}`, 'x')).toThrow('TEST_MATRIX_MARKERS_INVALID');
  });
});
