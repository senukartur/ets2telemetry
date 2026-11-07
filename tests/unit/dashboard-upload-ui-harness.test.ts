import {expect, it} from 'vitest';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
// @ts-expect-error Runtime helper is JavaScript, like the existing smoke helpers.
import {validateUploadUiConfiguration, uploadUiBuildInputs} from '../../scripts/ci/ui-dashboard-upload-observation.mjs';
const config = {scenario: 'ui', uiCase: 'shell', mode: 'packaged', output: path.resolve('.local/upload-ui-harness'), checkout: process.cwd(), profile: path.resolve('.local/upload-ui-harness/profile'), cwd: path.resolve('.local/upload-ui-harness/cwd')};
it('REG-010/012/017 confines the configured fixture to ui:shell, isolated roots and staging build inputs', () => {
  expect(validateUploadUiConfiguration(config, {})).toBe(path.join(config.output, 'dashboard-upload-ui-fixture'));
  for (const change of [{scenario: 'recording'}, {uiCase: 'journal'}, {mode: 'installed'}, {output: process.cwd()}, {profile: path.resolve('elsewhere')}, {cwd: '.'}]) expect(() => validateUploadUiConfiguration({...config, ...change}, {})).toThrow();
  for (const environment of [{ETS2TELEMETRY_BUILD_CHANNEL: 'production'}, {ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: '1'}]) expect(() => validateUploadUiConfiguration(config, environment)).toThrow();
  const inputs = uploadUiBuildInputs(config); expect(inputs.entries).toHaveLength(4); expect(inputs.entries.every((entry: string) => entry.startsWith(path.join(process.cwd(), 'tests/runtime/dashboard-upload-ui')))).toBe(true); expect(inputs.define.__ETS2TELEMETRY_BUILD_CHANNEL__).toBe('"staging"');
});
it('REG-010/012/017 keeps the fixture separate from credential, scheduler and production main authority', async () => {
  const [main, preload, renderer, helper, runtime] = await Promise.all(['tests/runtime/dashboard-upload-ui-main.ts', 'tests/runtime/dashboard-upload-ui-preload.ts', 'tests/runtime/dashboard-upload-ui-renderer.tsx', 'scripts/ci/ui-dashboard-upload-observation.mjs', 'scripts/ci/runtime-smoke.mjs'].map(file => readFile(file, 'utf8')));
  expect(main).not.toMatch(/from ['"].*(?:credential|scheduler|main-controller|dashboard-upload\/service|src\/main)['"]/);
  expect(main).toMatch(/fromPartition\('upload-ui-fixture'\)/); expect(main).toMatch(/sandbox: true, contextIsolation: true, nodeIntegration: false/); expect(main).toMatch(/setPermissionRequestHandler/); expect(main).toMatch(/setPermissionCheckHandler/); expect(main).toMatch(/onBeforeRequest/);
  expect(preload).toMatch(/dashboardUploadPreload\(ipcRenderer\)/); expect(preload).toMatch(/validateJournalTripPage/); expect(renderer).toMatch(/AccountScreen/); expect(renderer).toMatch(/useDashboardUpload/);
  expect(helper).not.toMatch(/from ['"].*scripts\/build|tracing\.start|ignoreHTTPSErrors|production.*define/);
  expect(runtime.indexOf('result.uploadUi=await runDashboardUploadUiFixture(config)')).toBeLessThan(runtime.indexOf('telemetrySource = await startLiveSmokeSource'));
});
