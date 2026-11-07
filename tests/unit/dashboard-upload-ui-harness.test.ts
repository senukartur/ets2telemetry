import {expect, it} from 'vitest';
import path from 'node:path';
import {build} from 'vite';
// @ts-expect-error Runtime helper is JavaScript, like the existing smoke helpers.
import {validateUploadUiConfiguration, uploadUiBuildInputs, uploadUiIsolationPlugin} from '../../scripts/ci/ui-dashboard-upload-observation.mjs';
const config = {scenario: 'ui', uiCase: 'shell', mode: 'packaged', output: path.resolve('.local/upload-ui-harness'), checkout: process.cwd(), profile: path.resolve('.local/upload-ui-harness/profile'), cwd: path.resolve('.local/upload-ui-harness/cwd')};
it('REG-010/012/017 confines the configured fixture to ui:shell, isolated roots and staging build inputs', () => {
  expect(validateUploadUiConfiguration(config, {})).toBe(path.join(config.output, 'dashboard-upload-ui-fixture'));
  for (const change of [{scenario: 'recording'}, {uiCase: 'journal'}, {mode: 'installed'}, {output: process.cwd()}, {profile: path.resolve('elsewhere')}, {cwd: '.'}]) expect(() => validateUploadUiConfiguration({...config, ...change}, {})).toThrow();
  for (const environment of [{ETS2TELEMETRY_BUILD_CHANNEL: 'production'}, {ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: '1'}]) expect(() => validateUploadUiConfiguration(config, environment)).toThrow();
  const inputs = uploadUiBuildInputs(config); expect(inputs.entries).toHaveLength(4); expect(inputs.entries.every((entry: string) => entry.startsWith(path.join(process.cwd(), 'tests/runtime/dashboard-upload-ui')))).toBe(true); expect(inputs.define.__ETS2TELEMETRY_BUILD_CHANNEL__).toBe('"staging"');
});
const hostedMain = {ETS2TELEMETRY_BUILD_CHANNEL: 'production', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push'};
it.each(['push', 'workflow_dispatch'])('REG-010/012/017 accepts the hosted main %s caller while keeping both fixture modes compiled as staging', event => {
  const environment = {...hostedMain, GITHUB_EVENT_NAME: event};
  for (const mode of ['development', 'packaged']) {
    expect(validateUploadUiConfiguration({...config, mode}, environment)).toBe(path.join(config.output, 'dashboard-upload-ui-fixture'));
    const inputs = uploadUiBuildInputs({...config, mode}, environment);
    expect(inputs.define).toEqual({__ETS2TELEMETRY_BUILD_CHANNEL__: '"staging"', __ETS2TELEMETRY_APP_VERSION__: '"0.0.0"'});
  }
});
it('REG-010/012/017 accepts unset or staging callers and refuses unauthorized production, override and invalid channel contexts', () => {
  for (const environment of [{}, {ETS2TELEMETRY_BUILD_CHANNEL: 'staging'}, {...hostedMain, ETS2TELEMETRY_BUILD_CHANNEL: 'staging', GITHUB_REF: 'refs/pull/1/merge', GITHUB_EVENT_NAME: 'pull_request'}]) {
    expect(validateUploadUiConfiguration(config, environment)).toBe(path.join(config.output, 'dashboard-upload-ui-fixture'));
    expect(uploadUiBuildInputs(config, environment).define.__ETS2TELEMETRY_BUILD_CHANNEL__).toBe('"staging"');
  }
  for (const environment of [
    {ETS2TELEMETRY_BUILD_CHANNEL: 'production'},
    {...hostedMain, GITHUB_ACTIONS: 'false'}, {...hostedMain, RUNNER_ENVIRONMENT: 'self-hosted'},
    {...hostedMain, GITHUB_REF: 'refs/heads/feature'}, {...hostedMain, GITHUB_REF: 'refs/pull/1/merge'},
    {...hostedMain, GITHUB_EVENT_NAME: 'pull_request'}, {...hostedMain, GITHUB_EVENT_NAME: 'pull_request_target'},
    {...hostedMain, GITHUB_EVENT_NAME: 'schedule'}, {...hostedMain, GITHUB_EVENT_NAME: undefined},
    {ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: '1'}, {...hostedMain, ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: '1'},
    {ETS2TELEMETRY_BUILD_CHANNEL: 'staging', ETS2TELEMETRY_OWNER_PRODUCTION_BUILD: ''},
    {ETS2TELEMETRY_BUILD_CHANNEL: ''}, {...hostedMain, ETS2TELEMETRY_BUILD_CHANNEL: 'Production'}, {ETS2TELEMETRY_BUILD_CHANNEL: 'invalid'}
  ]) {
    expect(() => validateUploadUiConfiguration(config, environment)).toThrow();
    expect(() => uploadUiBuildInputs(config, environment)).toThrow();
  }
});
it('REG-010/012/017 checks actual resolved bundler modules and rejects an aliased credential import before launch', async () => {
  const checked: number[] = [];
  const bundle = (target: string) => build({configFile: false, root: config.checkout, logLevel: 'silent',
    resolve: {alias: {'fixture-boundary-input': path.join(config.checkout, target)}},
    plugins: [{name: 'upload-ui-boundary-entry', resolveId(id) {if (id === 'upload-ui-boundary-entry') return '\0upload-ui-boundary-entry';}, load(id) {if (id === '\0upload-ui-boundary-entry') return "export * from 'fixture-boundary-input';";}}, uploadUiIsolationPlugin(config, (modules: number) => checked.push(modules))],
    build: {write: false, minify: false, rollupOptions: {input: 'upload-ui-boundary-entry', external: ['electron', /^node:/]}}});
  await bundle('apps/desktop/src/dashboard-upload/contract.ts'); expect(checked).toHaveLength(1); expect(checked[0]).toBeGreaterThan(0);
  await expect(bundle('apps/desktop/src/dashboard-upload/credential-store.ts')).rejects.toThrow('UPLOAD_UI_FORBIDDEN_MODULE'); expect(checked).toHaveLength(1);
});
