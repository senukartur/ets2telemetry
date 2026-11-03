// ET-066: the local check plan for a change (docs/TESTING.md#5-automation-and-merge-policy). Locally only the checks that
// cover the changed paths run; Windows CI runs every suite on the PR and stays the merge gate. The plan is a pure function
// of its inputs so that tests can state it by hand; scripts/test-affected.mjs collects the inputs and runs the steps.

/** Entry points that the storage suite bundles and starts in workers and children (scripts/build-storage-test-bundles.mjs). */
export const STORAGE_BUNDLE_ENTRIES = ['apps/desktop/src/storage-worker.ts', 'packages/storage/src/index.ts', 'packages/storage/src/client.ts',
  'apps/desktop/src/v1-ingestion.ts', 'apps/desktop/src/durable-sink.ts', 'tests/storage/fixtures/fault-storage-worker.ts', 'apps/desktop/src/trip-recorder.ts'];

/** Packaged runtime scenarios in the order of the PR runtime job (.github/workflows/windows-ci.yml). */
export const RUNTIME_SCENARIOS = {
  scaffold: [], telemetry: ['-Scenario', 'telemetry'], overlay: ['-Scenario', 'overlay', '-ForceRendererReuse'], 'now-playing': ['-Scenario', 'now-playing'],
  lifecycle: ['-Scenario', 'lifecycle'], plugin: ['-Scenario', 'plugin'], recording: ['-Scenario', 'recording'], journal: ['-Scenario', 'journal'],
  'hard-mode': ['-Scenario', 'hard-mode'], 'ui:shell': ['-Scenario', 'ui', '-UiCase', 'shell'], 'ui:live': ['-Scenario', 'ui', '-UiCase', 'live'],
  'ui:journal': ['-Scenario', 'ui', '-UiCase', 'journal'], 'ui:settings': ['-Scenario', 'ui', '-UiCase', 'settings'],
  'ui:overlay': ['-Scenario', 'ui', '-UiCase', 'overlay'], refusal: ['-Scenario', 'refusal']
};
const ALL_SCENARIOS = Object.keys(RUNTIME_SCENARIOS);
const UI_SHARDS = ALL_SCENARIOS.filter(name => name.startsWith('ui:'));

/** Checks that run only in CI whatever the change; a local plan never claims them. */
export const CI_ONLY = ['the full Vitest, storage, native, chain and runtime suites (every PR run)', 'native AddressSanitizer (windows-asan)',
  'development-mode runtime smokes, the Squirrel maker and release identity (main and dispatch)', 'the packaged session-end audit',
  'the hosted installer lifecycles', 'extended regressions, extended campaigns and the soak workflow'];

/** Above this many selected files a suite runs whole: the selection saves little and the command line stays short. */
export const MAX_SELECTED_FILES = 60;

// Agent definitions are instructions, like the Markdown ones; CI still runs for them.
export const DOCUMENTATION =/^docs\/|\.md$|^\.codex\/agents\/[^/]+\.toml$/;
const LINTABLE = /\.(?:[cm]?[jt]s|tsx)$/;
const POWERSHELL = /\.ps(?:1|m1|d1)$/;
const DEPENDENCIES = /(?:^|\/)package(?:-lock)?\.json$/;
/** Configuration that every Vitest file depends on without importing it. */
const FULL_UNIT = [/^tsconfig\.json$/, /^vitest\.config\.mts$/, /^tests\/shared\/build-channel-environment\.ts$/];
const FULL_STORAGE = [/^vitest\.storage\.config\.mts$/, /^tests\/storage\/setup\.ts$/, /^scripts\/build-storage-test-bundles\.mjs$/, /^scripts\/run-electron-node\.mjs$/];
const FULL_LINT = [/^eslint\.config\.mjs$/, /^tools\/lint\//];
const NATIVE_PLUGIN = [/^native\/telemetry-plugin\//, /^tests\/fixtures\/protocol-v[01]\//, /^scripts\/(?:configure-native-plugin|stage-native-plugin|build-channel)\.mjs$/];
const NATIVE_CLIENT = [/^native\/telemetry-client\//, /^tests\/fixtures\/protocol-v0\//, /^scripts\/build-native-client\.mjs$/];
const MEDIA_READER = [/^native\/media-session-reader\//, /^scripts\/build-media-session-reader\.mjs$/];
const SIMULATOR = [/^tools\/telemetry-simulator\//, /^packages\/contracts\//, /^tests\/fixtures\/simulator-v[01]\//];
/** Packaging inputs: the package is inspected and launched once. */
const PACKAGING = [DEPENDENCIES, /^forge\.config\.cjs$/, /^scripts\/(?:build|stage-native-plugin|inspect-package|package-integrity|plugin-bundle|source-inputs)\.mjs$/, /^resources\//, /^apps\/desktop\/(?!src\/)/];
/** The runtime driver's launch and receipt path: every packaged scenario depends on it. */
const RUNTIME_DRIVER = [/^scripts\/ci\/(?:Invoke-RuntimeSmoke\.ps1|RuntimeReceipt\.ps1|smoke-build\.mjs|launch-evidence\.mjs|job-cpu-summary\.mjs)$/, /^scripts\/watchdog\//];
/** The scenario driver holds every scenario's steps: its common path is the scaffold, the scenarios follow from the other changed files. */
const SCENARIO_DRIVER = [/^scripts\/ci\/runtime-smoke\.mjs$/];
/** Scenario drivers and observations under scripts/ci, by the scenario they observe. */
const RUNTIME_OBSERVATIONS = [
  [/^scripts\/ci\/(?:ui-|renderer-observation|dashboard-observation)/, UI_SHARDS], [/^scripts\/ci\/live-smoke-source/, ['telemetry']],
  [/^scripts\/ci\/overlay-/, ['overlay']], [/^scripts\/ci\/journal-/, ['journal']], [/^scripts\/ci\/(?:recording-|history-invariants)/, ['recording']],
  [/^scripts\/ci\/now-playing-/, ['now-playing']], [/^scripts\/ci\/hard-mode-/, ['hard-mode']], [/^scripts\/ci\/(?:lifecycle-|exit-)/, ['lifecycle']],
  [/^scripts\/ci\/refusal-/, ['refusal']], [/^scripts\/ci\/plugin-fixture/, ['plugin']]];
/** Desktop and package sources by the scenarios that show their behavior; a desktop file without a rule gets scaffold and the shell. */
export const RUNTIME_SOURCES = [
  [/overlay/, ['overlay', 'ui:overlay']], [/journal|trip|history|export/, ['journal', 'ui:journal']],
  [/recording|durable-sink|storage-worker|^packages\/storage\//, ['recording', 'refusal']], [/now-playing|media-session/, ['now-playing']],
  [/hard-mode/, ['hard-mode']], [/plugin-setup|plugin-/, ['plugin']], [/settings|-card\.tsx$|\/i18n\//, ['ui:settings']],
  [/live-|dashboard|gear-|telemetry-service|game-source|native-pipe-client|v1-ingestion|capture-|^packages\/(?:contracts|telemetry-core)\//, ['telemetry', 'ui:live']],
  [/app-lifecycle|tray|single-instance|autostart|session-end|\/main\.ts$/, ['scaffold', 'lifecycle']],
  [/\/components\/|\/lib\/|\.css$|\/assets\/|renderer|preload|navigation/, ['ui:shell']]];
const MEDIA_HOST_TEST = 'tests/host/media-session-reader.test.ts';
/** Test entry points whose subject the import graph cannot see (a native executable). */
const EXTRA_TESTS = [[MEDIA_READER, [MEDIA_HOST_TEST]]];

/**
 * Product areas of the area × layer test matrix (docs/regression-registry.md#area--layer-matrix), in matching order: the
 * first area with a pattern that matches a repository path owns it. scripts/test-matrix.mjs assigns a test file to the
 * area that owns most of the files it imports, a runtime scenario to the area that owns most of the sources that
 * RUNTIME_SOURCES selects it for, and a CTest case by its name (`ctest`).
 */
export const TEST_AREAS = [
  {id: 'hard-mode', label: 'Hard Mode', paths: [/hard-mode/]},
  {id: 'now-playing', label: 'Now playing', paths: [...MEDIA_READER, /now-playing|media-session/], ctest: /^media-session-reader-/},
  {id: 'updater', label: 'Updater', paths: [/^apps\/desktop\/src\/updater\//, /update-(?:control|feed|manifest|key)/, /^scripts\/release\/(?!check-github-release)/]},
  {id: 'setup', label: 'Setup, installer and uninstall', paths: [/plugin-setup|plugin-(?:bundle|installer|registry|action|cleanup)|steam-|game-folder|game-processes|fixed-program|atomic-json-file|vdf/,
    /uninstall|squirrel|installer|installed-app-icon|legacy-shortcuts|app-uninstall|data-wipe|deferral/, /^tests\/(?:windows|vm)\//, /^forge\.config\.cjs$/, /^resources\//]},
  {id: 'overlay', label: 'Overlay', paths: [/overlay|window-placement|latency-|game-window/, /^scripts\/diagnostics\//], ctest: /window/},
  {id: 'journal', label: 'Journal and export', paths: [/journal|export|sample-chart/]},
  {id: 'settings', label: 'Settings', paths: [/settings|unit-profiles|language|i18n|display-profile|gear-display|autostart/]},
  {id: 'storage', label: 'Storage', paths: [/^packages\/storage\//, /storage|history-file|recording-(?:status|policy|runtime)|recovery-budget|retention/, /^tests\/fixtures\/storage\//]},
  {id: 'trip', label: 'Trip domain', paths: [/^packages\/telemetry-core\/src\/trips\//, /trip|profile-observation|history-samples/]},
  {id: 'native-client', label: 'Native client', paths: [...NATIVE_CLIENT.slice(0, 1), /native-pipe-client|native-game-discovery|broker-artifact|build-native-client/], ctest: /^native-pipe-client-/},
  {id: 'native-plugin', label: 'Native plugin transport', paths: [/^native\/telemetry-plugin\//, /^scripts\/(?:configure|stage)-native-plugin\.mjs$/, /channel-identity|two-plugin/],
    ctest: /^(?!protocol-v[01]-)/},
  {id: 'protocol', label: 'Protocol v0/v1 and simulator', paths: [/^packages\/contracts\/src\/(?:protocol-|capture-cap0)/, /^tests\/fixtures\/(?:protocol|simulator|cap0)/, /^tools\//, /protocol|simulator|cap0/],
    ctest: /^protocol-v[01]-/},
  {id: 'ingestion', label: 'Ingestion and telemetry service', paths: [/^packages\/telemetry-core\//, /v1-|ingestion|telemetry-service|game-source|durable-sink|capture-|source-mode|service-|connection-diagnosis|shutdown|sample-buffer|event-loop-lag|live-(?:sources|subscriptions|state|freshness|v1|view)|app-health/,
    /telemetry-core|normalize|derived|mandatory-break|consumption-hold/]},
  {id: 'ci', label: 'CI, release scripts and test harness', paths: [/^scripts\//, /receipt|harness|test-resources|test-affected|test-matrix/,/^\.github\//, /^tests\/(?:package-integrity|watchdog)\//, /^tools\/lint\//, /^package(?:-lock)?\.json$/, /^vitest\..*config/]},
  {id: 'shell', label: 'App shell, dashboard and lifecycle', paths: [/^apps\/desktop\//, /^packages\/contracts\//, /dashboard|speed-|tray|lifecycle|scaffold|diagnostic|main-boundaries|renderer|preload/]}
];
/** The area that owns a repository path, or null. */
export function areaOf(file) { return TEST_AREAS.find(area => matches(file, area.paths))?.id ?? null; }
/** The packaged runtime scenarios that show the behavior of a desktop or package source, as planChecks selects them. */
export function runtimeScenariosOf(file) {
  const hits = RUNTIME_SOURCES.filter(([pattern]) => pattern.test(file)).flatMap(([, names]) => names);
  return hits.length > 0 ? sorted(hits) : (file.startsWith('apps/') ? ['scaffold', 'ui:shell'] : []);
}

function matches(file, patterns) { return patterns.some(pattern => pattern.test(file)); }
function sorted(values) { return [...new Set(values)].sort(); }

/**
 * Plans the local checks for `changed` (repository paths, POSIX separators, deleted paths included).
 * `affectedTests` are the test files whose static imports reach a changed file, `affectedEntries` the storage bundle entries
 * they reach, `references` the test files that name each changed path, `existing` the changed paths that still exist and
 * `lintInstalled` whether tools/lint has its dependencies. `unmapped` lists the changed files that no rule, import or test
 * name covers: only CI checks them.
 */
export function planChecks({changed, affectedTests = [], affectedEntries = [], references = {}, existing = changed, lintInstalled = true}) {
  const files = sorted(changed);
  if (files.length === 0) return {kind: 'empty', steps: [], unmapped: [], areas: [], ciOnly: CI_ONLY};
  if (files.every(file => DOCUMENTATION.test(file))) return {kind: 'documentation', steps: [], unmapped: [], areas: [], ciOnly: CI_ONLY};
  const code = files.filter(file => !DOCUMENTATION.test(file));
  const present = new Set(existing);
  const steps = [];
  const add = (id, command, reason, needs = []) => { if (!steps.some(step => step.id === id)) steps.push({id, command, reason, needs}); };
  const mapped = new Set();
  const take = patterns => code.filter(file => matches(file, patterns) && mapped.add(file));

  add('typecheck', 'npm run typecheck', 'every code change');
  const lintFiles = code.filter(file => LINTABLE.test(file) && present.has(file));
  if (take(FULL_LINT).length > 0 || lintFiles.length > MAX_SELECTED_FILES) {
    add('lint', 'npm run lint', 'lint configuration or many files changed', lintInstalled ? [] : ['lint:install']);
  } else if (lintFiles.length > 0) {
    add('lint', `node tools/lint/node_modules/eslint/bin/eslint.js --max-warnings 0 --no-warn-ignored ${lintFiles.join(' ')}`, 'changed lintable files', lintInstalled ? [] : ['lint:install']);
  }
  if (steps.some(step => step.needs.includes('lint:install'))) steps.unshift({id: 'lint:install', command: 'npm run lint:install', reason: 'tools/lint has no dependencies', needs: []});
  if (code.some(file => POWERSHELL.test(file))) { add('lint:ps', 'npm run lint:ps', 'changed PowerShell files'); code.filter(file => POWERSHELL.test(file)).forEach(file => mapped.add(file)); }

  const dependencies = take([DEPENDENCIES]).length > 0;
  const extra = EXTRA_TESTS.flatMap(([patterns, tests]) => take(patterns).length > 0 ? tests : []);
  const changedTests = code.filter(file => /^tests\/.*\.test\.ts$/.test(file) && present.has(file));
  const referencedTests = Object.values(references).flat();
  const tests = sorted([...affectedTests, ...referencedTests, ...changedTests, ...extra]);
  // A module is covered through the import graph; another file is covered when a test names it.
  code.filter(file => LINTABLE.test(file) || changedTests.includes(file) || (references[file] ?? []).length > 0).forEach(file => mapped.add(file));

  const unitTests = tests.filter(test => /^tests\/(?:unit|host)\//.test(test));
  const fullUnit = dependencies || take(FULL_UNIT).length > 0 || unitTests.length > MAX_SELECTED_FILES;
  // The host test drives the built reader executable; CI builds it before npm test too.
  const reader = fullUnit || unitTests.includes(MEDIA_HOST_TEST);
  if (reader) add('media:build', 'node scripts/build-media-session-reader.mjs', `${MEDIA_HOST_TEST} drives the built reader`);
  if (fullUnit) add('vitest', 'npm test', 'shared test configuration, dependencies or many files changed', reader ? ['media:build'] : []);
  else if (unitTests.length > 0) add('vitest', `npm test -- ${unitTests.join(' ')}`, 'tests that import or name the changed files', reader ? ['media:build'] : []);
  const storageTests = tests.filter(test => test.startsWith('tests/storage/'));
  if (dependencies || take(FULL_STORAGE).length > 0 || affectedEntries.length > 0 || storageTests.length > MAX_SELECTED_FILES) {
    add('storage', 'npm run test:storage', affectedEntries.length > 0 ? `the storage bundle reaches ${affectedEntries.join(', ')}` : 'storage configuration, dependencies or many files changed');
  } else if (storageTests.length > 0) add('storage', `npm run test:storage -- ${storageTests.join(' ')}`, 'storage tests that import or name the changed files');

  const plugin = take(NATIVE_PLUGIN).length > 0, client = take(NATIVE_CLIENT).length > 0, media = MEDIA_READER.some(pattern => code.some(file => pattern.test(file)));
  const cap0 = plugin || client || tests.includes('tests/integration/cap0-chain.test.ts');
  const v1 = plugin || client || tests.some(test => /^tests\/integration\/v1-chain/.test(test));
  const lock = plugin || tests.includes('tests/integration/plugin-image-lock.test.ts');
  const simulator = take(SIMULATOR).length > 0;

  const scenarios = new Set();
  const packaging = take(PACKAGING).length > 0;
  if (packaging) scenarios.add('scaffold');
  if (take(RUNTIME_DRIVER).length > 0) ALL_SCENARIOS.forEach(name => scenarios.add(name));
  if (take(SCENARIO_DRIVER).length > 0) scenarios.add('scaffold');
  for (const [pattern, names] of RUNTIME_OBSERVATIONS) if (take([pattern]).length > 0) names.forEach(name => scenarios.add(name));
  for (const file of code.filter(file => /^(?:apps\/desktop\/src|packages\/[^/]+\/src)\//.test(file))) {
    mapped.add(file);
    runtimeScenariosOf(file).forEach(name => scenarios.add(name));
  }
  if (media) scenarios.add('now-playing');
  const runtime = ALL_SCENARIOS.filter(name => scenarios.has(name));

  const build = plugin || client || media || cap0 || v1 || lock || runtime.length > 0;
  if (build) {
    add('native:configure', 'npm run native:configure', 'the build stages the plugin from the configured tree');
    add('build', 'npm run build', 'native, chain or runtime checks need the build', ['native:configure']);
  } else if (simulator) add('simulator:build', 'npm run build --workspace @ets2telemetry/telemetry-simulator', 'the simulator smokes run its build');
  if (media) add('ctest:media', 'ctest --test-dir native/media-session-reader/build -C Release --output-on-failure --no-tests=error', 'media session reader changed', ['build']);
  if (client || plugin) add('ctest:client', 'ctest --test-dir native/telemetry-client/build -C Release --output-on-failure --no-tests=error', 'native client or shared protocol fixtures changed', ['build']);
  if (plugin || cap0 || v1 || lock) add('native:build', 'npm run native:build', 'native tests and chains need the test plugin and fake SDK host', ['build']);
  if (plugin) add('native:test', 'npm run native:test', 'native plugin or shared protocol fixtures changed', ['native:build']);
  if (cap0) add('cap0-chain', 'npm run test:cap0-chain', plugin || client ? 'native plugin or client changed' : 'the chain imports a changed file', ['native:build']);
  if (v1) add('v1-chain', 'npm run test:v1-chain', plugin || client ? 'native plugin or client changed' : 'the chain imports a changed file', ['native:build']);
  if (lock) add('plugin-lock', 'npm run test:plugin-lock', plugin ? 'native plugin changed' : 'the lock check imports a changed file', ['native:build']);
  if (simulator) {
    const needs = [build ? 'build' : 'simulator:build'];
    add('smoke:v0', 'npm run smoke --workspace @ets2telemetry/telemetry-simulator', 'simulator, contracts or simulator fixtures changed', needs);
    add('smoke:v1', 'npm run smoke:v1 --workspace @ets2telemetry/telemetry-simulator', 'simulator, contracts or simulator fixtures changed', needs);
  }
  if (runtime.length > 0) {
    add('package', 'npm run package', 'packaged runtime scenarios', ['build']);
    add('inspect:package', 'npm run inspect:package', 'packaged runtime scenarios', ['package']);
    for (const name of runtime) {
      add(`runtime:${name}`, ['powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/ci/Invoke-RuntimeSmoke.ps1 -Mode packaged', ...RUNTIME_SCENARIOS[name]].join(' '),
        'changed desktop, package or runtime driver files', ['inspect:package']);
    }
  }
  return {kind: 'code', steps, unmapped: code.filter(file => !mapped.has(file) && !POWERSHELL.test(file)), areas: sorted(code.map(areaOf).filter(Boolean)), ciOnly: CI_ONLY};
}
