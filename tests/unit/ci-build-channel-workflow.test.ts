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
  const sideBySide = "if: github.event_name != 'pull_request' && github.ref == 'refs/heads/main' && steps.built.outputs.channel == 'production'\n";
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
  expect(text).toContain('    needs: [windows-build, windows-staging-build]\n');
});
