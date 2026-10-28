import {readFile} from 'node:fs/promises';
import {expect, it} from 'vitest';

// ET-055 PR-4 (UP13, REG-017): Windows CI builds production only on main, for the release artifact: a push to main or a
// dispatch on main. Pull requests and dispatches on any other branch build the default staging channel, so an unreviewed
// branch never produces a production-identity Setup. The installer artifact names the channel actually built. Until
// ET-055 PR-5 the hosted installer lifecycle skipped a staging build with a notice; since PR-5 it installs the channel that
// was built, and the side-by-side scenario runs on main, beside the staging Setup of windows-staging-build. Text
// assertions over the workflow, as tests/unit/ci-compiled-artifact.test.ts does for the job layout.

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
  // A plain YAML scalar must not contain ': ' (GitHub rejected the whole workflow on that): every run line carrying one is
  // a block scalar.
  for (const line of text.split('\n')) {
    const run = /^\s*run: (?!\|)(.*)$/.exec(line);
    if (run) expect(run[1], line).not.toMatch(/: /);
  }
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
  // Only this job sets the run number; a branch dispatch and every pull request keep the local 000000.
  expect(text.match(/ETS2TELEMETRY_STAGING_RUN_NUMBER=/g)).toHaveLength(1);
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
