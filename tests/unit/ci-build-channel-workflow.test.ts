import {readdir, readFile} from 'node:fs/promises';
import {expect, it} from 'vitest';

// ET-055 PR-4 (UP13, REG-017): Windows CI builds production only on main, for the release artifact: a push to main or a
// dispatch on main. Pull requests and dispatches on any other branch build the default staging channel, so an unreviewed
// branch never produces a production-identity Setup. The installer artifact names the channel actually built. Until
// ET-055 PR-5 the hosted installer lifecycle skipped a staging build with a notice; since PR-5 it installs the channel that
// was built, and the side-by-side scenario runs on main, beside the staging Setup of windows-staging-build. Since the owner
// decision of October 28, 2026 a branch dispatch's staging build is a staging release artifact with a real run number.
// Text assertions over the workflow, as tests/unit/ci-compiled-artifact.test.ts does for the job layout.

const workflow = async () => (await readFile('.github/workflows/windows-ci.yml', 'utf8')).replaceAll('\r\n', '\n');
const job = (text: string, id: string) => text.split(`\n  ${id}:\n`)[1].split(/\n {2}[a-z-]+:\n/)[0];

it('selects production only on main, in exactly the build, runtime and installer jobs', async () => {
  const text = await workflow();
  const selections = [...text.matchAll(/- name: (.+)\n +if: (.+)\n +run: Add-Content -LiteralPath \$env:GITHUB_ENV -Value 'ETS2TELEMETRY_BUILD_CHANNEL=production'\n/g)];
  expect(selections.map(match => [match[1], match[2]])).toEqual(Array(3).fill(['Build production on main', "github.ref == 'refs/heads/main'"]));
  // No other step or job sets the production channel, and nothing names the owner-only override.
  expect(text.match(/ETS2TELEMETRY_BUILD_CHANNEL=production/g)).toHaveLength(3);
  expect(text).not.toContain('ETS2TELEMETRY_OWNER_PRODUCTION_BUILD');
  for (const id of ['windows-build', 'windows-runtime', 'windows-installer']) expect(job(text, id)).toContain("ETS2TELEMETRY_BUILD_CHANNEL=production'");
  for (const id of ['windows-tests', 'windows-asan', 'windows']) expect(job(text, id)).not.toContain('ETS2TELEMETRY_BUILD_CHANNEL');
});

it('uploads the installer artifact under the channel that was built, with that channel\'s Setup', async () => {
  const build = job(await workflow(), 'windows-build');
  expect(build).toContain('- name: Name the built channel and Setup\n        if: github.event_name != \'pull_request\'\n        id: built\n');
  expect(build).toContain("name: ${{ steps.built.outputs.channel == 'production' && 'windows-installer' || 'windows-installer-staging' }}-${{ github.run_id }}-${{ github.run_attempt }}");
  expect(build).toContain('out/make/squirrel.windows/x64/${{ steps.built.outputs.setup }}\n');
  expect(build).not.toMatch(/YukonUnionTelemetry-(?:Staging-)?Setup-\*/);
});

// ET-055 PR-5 changed this requirement: the staging lifecycle exists, so the notice step is gone and a staging build is
// installed like a production one; the side-by-side step needs both channels and so runs on main only.
it('runs the hosted installer lifecycle for the built channel, and the side-by-side scenario on main only', async () => {
  const text = await workflow();
  const installer = job(text, 'windows-installer');
  expect(installer).toContain('- name: Name the built channel and Setup\n        id: built\n');
  expect(installer).toContain("- name: Installer lifecycle in a test root\n        if: github.event_name != 'pull_request'\n        timeout-minutes: 8\n" +
    '        run: ./scripts/installer/Invoke-InstallerLifecycle.ps1\n');
  expect(installer).not.toContain('Installer lifecycle skipped');
  const sideBySide = "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && steps.built.outputs.channel == 'production' && " +
    "needs.windows-staging-build.result == 'success'\n";
  expect(installer.split(sideBySide)).toHaveLength(3);
  expect(installer).toContain('- name: Side-by-side installer lifecycle in a test root\n        ' + sideBySide +
    '        timeout-minutes: 8\n        run: ./scripts/installer/Invoke-InstallerLifecycle.ps1 -Scenario side-by-side -StagingInput "$PWD/.local/staging-input"\n');
  expect(installer.indexOf('id: built')).toBeLessThan(installer.indexOf('Installer lifecycle in a test root'));
  expect(installer.indexOf('Installer lifecycle in a test root')).toBeLessThan(installer.indexOf('Side-by-side installer lifecycle'));
  // The staging job runs on main only, builds staging and hands its sealed Setup to the installer job.
  const staging = job(text, 'windows-staging-build');
  expect(staging).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'\n");
  expect(staging).toContain('ETS2TELEMETRY_BUILD_CHANNEL: staging\n');
  expect(staging).toContain('node scripts/installer/side-by-side-input.mjs create "$PWD/.local/staging-input"');
  expect(staging).toContain('name: windows-staging-input-${{ github.run_id }}-${{ github.run_attempt }}');
  expect(staging).toContain('run: ./scripts/installer/Invoke-InstallerLifecycle.ps1\n');
  // The job runs whenever windows-build succeeded, so a failed staging build on main never skips the production lifecycle;
  // a final step fails the job there instead, after the production evidence exists.
  expect(text).toContain("  windows-installer:\n    name: Windows x64 hosted installer\n");
  expect(installer).toContain("    needs: [windows-build, windows-staging-build]\n    if: \"!cancelled() && github.event_name != 'pull_request' && " +
    "needs.windows-build.result == 'success'\"\n    runs-on: windows-2022\n");
  expect(installer).toContain("- name: Require the staging build on main\n        if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && " +
    "needs.windows-staging-build.result != 'success'\n        run: |\n          throw ('STAGING_BUILD_NOT_SUCCESSFUL: ");
  expect(installer.indexOf('- name: Side-by-side installer lifecycle')).toBeLessThan(installer.indexOf('- name: Require the staging build on main'));
});

it('makes main\'s staging build the staging release artifact, with this run\'s staging number and release-identity.json', async () => {
  // ET-055 PR-9 (UP15, UP16): release.yml downloads windows-installer-staging-<run>-<attempt> of a main run and refuses the
  // local staging number 000000, so the main staging build sets the run number and uploads the four files it verifies.
  const text = await workflow();
  const staging = job(text, 'windows-staging-build');
  const number = "- name: Staging run number for the release version\n        run: |\n" +
    "          if ($env:GITHUB_RUN_NUMBER -cnotmatch '^[1-9][0-9]{0,5}$') { throw 'GITHUB_RUN_NUMBER must be 1 to 6 digits for the staging version.' }\n" +
    "          Add-Content -LiteralPath $env:GITHUB_ENV -Value ('ETS2TELEMETRY_STAGING_RUN_NUMBER=' + $env:GITHUB_RUN_NUMBER.PadLeft(6, '0'))\n";
  expect(staging).toContain(number);
  expect(staging.indexOf(number)).toBeLessThan(staging.indexOf('npm run make'));
  // On main only this job sets the run number unconditionally; the three branch-dispatch steps are asserted below. Every
  // pull request keeps the local 000000.
  expect(text.match(/ETS2TELEMETRY_STAGING_RUN_NUMBER=/g)).toHaveLength(4);
  const identity = staging.indexOf('- name: Staging release artifact identity\n        run: |\n          node scripts/release-identity.mjs\n');
  expect(identity).toBeGreaterThan(staging.indexOf('npm run inspect:package -- --installer'));
  expect(staging).toContain("if ($built.channel -cne 'staging') { throw");
  expect(staging).toContain("if ($built.version -cnotmatch ('-stg\\.' + $env:ETS2TELEMETRY_STAGING_RUN_NUMBER + '$')) { throw");
  const upload = staging.indexOf('          name: windows-installer-staging-${{ github.run_id }}-${{ github.run_attempt }}\n          path: |\n' +
    '            out/make/squirrel.windows/x64/${{ steps.built.outputs.setup }}\n            out/make/squirrel.windows/x64/*-full.nupkg\n' +
    '            out/make/squirrel.windows/x64/RELEASES\n            out/make/squirrel.windows/x64/release-identity.json\n          retention-days: 14\n' +
    '          if-no-files-found: error\n');
  expect(upload).toBeGreaterThan(identity);
  // PR-5's hand-off and lifecycle still come from the same build, after the artifact exists.
  expect(upload).toBeLessThan(staging.indexOf('node scripts/installer/side-by-side-input.mjs create'));
  expect(staging.indexOf('node scripts/installer/side-by-side-input.mjs create')).toBeLessThan(staging.indexOf('run: ./scripts/installer/Invoke-InstallerLifecycle.ps1\n'));
  // The required job names are unchanged.
  for (const name of ['Windows x64 tests', 'Windows x64 scaffold', 'Windows x64 native AddressSanitizer']) expect(text).toContain(`    name: ${name}\n`);
});

// Owner decision of October 28, 2026 (DESIGN-DECISIONS.md, "UP15 and UP16 amended"): a dispatch on a branch
// other than main is a releasable staging build. windows-build, windows-runtime and windows-installer set this run's
// staging number there, as they set the production channel on main, so windows-build's staging artifact carries
// <base>-stg.<6-digit run number> and release-identity.json in the shape release.yml downloads. Pull requests, dispatches on
// a tag and main keep their earlier behaviour.
it('gives a branch dispatch this run\'s staging number and a releasable staging artifact', async () => {
  const text = await workflow();
  const step = "      - name: Staging run number on a branch dispatch\n" +
    "        if: github.event_name == 'workflow_dispatch' && startsWith(github.ref, 'refs/heads/') && github.ref != 'refs/heads/main'\n" +
    "        run: |\n" +
    "          if ($env:GITHUB_RUN_NUMBER -cnotmatch '^[1-9][0-9]{0,5}$') { throw 'GITHUB_RUN_NUMBER must be 1 to 6 digits for the staging version.' }\n" +
    "          Add-Content -LiteralPath $env:GITHUB_ENV -Value ('ETS2TELEMETRY_STAGING_RUN_NUMBER=' + $env:GITHUB_RUN_NUMBER.PadLeft(6, '0'))\n";
  const production = "        run: Add-Content -LiteralPath $env:GITHUB_ENV -Value 'ETS2TELEMETRY_BUILD_CHANNEL=production'\n";
  for (const id of ['windows-build', 'windows-runtime', 'windows-installer']) {
    const body = job(text, id);
    expect(body.split(step), id).toHaveLength(2);
    // Right after the production selection (only comment lines between) and before anything installs or builds.
    const between = body.slice(body.indexOf(production) + production.length, body.indexOf(step));
    expect(between.split('\n').filter(Boolean).every(line => line.startsWith('      # ')), id).toBe(true);
    expect(body.indexOf(production), id).toBeGreaterThan(0);
    expect(body.indexOf(step), id).toBeLessThan(body.indexOf('run: npm ci'));
  }
  expect(text.split(step)).toHaveLength(4);
  for (const id of ['windows-tests', 'windows-asan', 'windows']) expect(job(text, id)).not.toContain('ETS2TELEMETRY_STAGING_RUN_NUMBER');
  const build = job(text, 'windows-build');
  expect(build.indexOf(step)).toBeLessThan(build.indexOf('npm run make'));
  // The built step refuses a branch-dispatch build that is not staging or lacks this run's number, before the upload.
  const check = "          if ($env:ETS2TELEMETRY_STAGING_RUN_NUMBER -and ($built.channel -cne 'staging' -or $built.version -cnotmatch ('-stg\\.' + " +
    "$env:ETS2TELEMETRY_STAGING_RUN_NUMBER + '$'))) { throw 'The branch dispatch did not build staging with this run''s staging number.' }\n";
  expect(build).toContain(check);
  expect(build.indexOf(check)).toBeLessThan(build.indexOf("name: ${{ steps.built.outputs.channel == 'production' && 'windows-installer' || 'windows-installer-staging' }}"));
  // The staging artifact of a branch dispatch has the four files release.yml verifies, after the identity is written.
  const identity = build.indexOf("- name: Release artifact identity\n        if: github.event_name != 'pull_request'\n        run: |\n          node scripts/release-identity.mjs\n");
  const upload = build.indexOf("          name: ${{ steps.built.outputs.channel == 'production' && 'windows-installer' || 'windows-installer-staging' }}-${{ github.run_id }}-${{ github.run_attempt }}\n" +
    '          path: |\n            out/make/squirrel.windows/x64/${{ steps.built.outputs.setup }}\n            out/make/squirrel.windows/x64/*-full.nupkg\n' +
    '            out/make/squirrel.windows/x64/RELEASES\n            out/make/squirrel.windows/x64/release-identity.json\n');
  expect(identity).toBeGreaterThan(build.indexOf('npm run inspect:package -- --installer'));
  expect(upload).toBeGreaterThan(identity);
  // Main keeps its layout: production in windows-build, the staging artifact in windows-staging-build only.
  expect(job(text, 'windows-staging-build')).toContain("if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main'\n");
});

// ET-055 PR-8 (REG-019): the update-from-feed scenario runs for the built channel on every non-PR event (staging on a branch
// dispatch, production on main), after the lifecycle and before the side-by-side scenario, inside a job timeout that holds
// all three step timeouts.
it('runs the update-from-feed scenario for the built channel after the lifecycle', async () => {
  const installer = job(await workflow(), 'windows-installer');
  expect(installer).toContain("- name: Update-from-feed installer lifecycle in a test root\n        if: github.event_name != 'pull_request'\n        timeout-minutes: 30\n" +
    '        run: ./scripts/installer/Invoke-InstallerLifecycle.ps1 -Scenario update-from-feed\n');
  expect(installer.indexOf('- name: Installer lifecycle in a test root')).toBeLessThan(installer.indexOf('- name: Update-from-feed installer lifecycle'));
  expect(installer.indexOf('- name: Update-from-feed installer lifecycle')).toBeLessThan(installer.indexOf('- name: Side-by-side installer lifecycle'));
  const steps = [...installer.matchAll(/\n {8}timeout-minutes: (\d+)\n/g)].map(match => Number(match[1]));
  const jobTimeout = Number(/\n {4}timeout-minutes: (\d+)\n/.exec(installer)?.[1]);
  expect(steps).toEqual([8, 30, 8]);
  expect(jobTimeout).toBeGreaterThanOrEqual(steps.reduce((sum, minutes) => sum + minutes, 0) + 5);
});

// A plain YAML scalar must not contain ': ' (GitHub rejected the whole workflow on that). No YAML parser is a dependency,
// so this is a text guard. ET-055 PR-8 (PR-5 review) extends it from `run:` keys to `- run:` items and `name:` and `if:`
// keys, in every workflow: such a value is a block scalar or quoted.
const PLAIN_SCALAR = /^\s*(?:- )?(?:run|name|if): (?![|>'"])(.*)$/;
it('writes every run, name and if value that contains ": " as a block or quoted scalar', async () => {
  const folder = '.github/workflows';
  const files = (await readdir(folder)).filter(name => /\.ya?ml$/.test(name));
  expect(files).toContain('windows-ci.yml');
  let checked = 0;
  for (const name of files) {
    for (const line of (await readFile(`${folder}/${name}`, 'utf8')).replaceAll('\r\n', '\n').split('\n')) {
      const value = PLAIN_SCALAR.exec(line);
      if (!value) continue;
      checked++;
      expect(value[1], `${name}: ${line}`).not.toMatch(/: /);
    }
  }
  expect(checked).toBeGreaterThan(50);
  // The guard reads a dash item, a name and an if, and leaves block and quoted scalars alone.
  expect(['      - run: echo a: b', '      - name: Step: two', "        if: a == 'b: c'"].map(line => PLAIN_SCALAR.exec(line)?.[1])).toEqual(['echo a: b', 'Step: two', "a == 'b: c'"]);
  expect(['        run: |', "      - name: 'Step: two'", '        if: "a: b"'].map(line => PLAIN_SCALAR.exec(line))).toEqual([null, null, null]);
});

it('builds the game-mode ASan executable before running its registered contract', async () => {
  const asan = job(await workflow(), 'windows-asan');
  const build = asan.split('\n').find(line => line.includes('cmake --build native/telemetry-plugin/build-asan --config Release --target '));
  expect(build).toBeDefined();
  expect(build?.trim().split(/\s+/)).toContain('game-mode-detector-asan-test');
  const test = 'ctest --test-dir native/telemetry-plugin/build-asan -C Release --output-on-failure -R asan-contract';
  expect(asan).toContain(test);
  expect(asan.indexOf(build!)).toBeLessThan(asan.indexOf(test));
});
