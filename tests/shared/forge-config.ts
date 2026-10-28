import {spawnSync} from 'node:child_process';
import path from 'node:path';

// ET-055 PR-4: forge.config.cjs resolves the build channel when Node loads it (scripts/build-channel.mjs), so a test that
// reads the packaging configuration of one channel loads it in a separate Node process with that channel's variables.
// Production is read as a GitHub-hosted Actions build sees it (GITHUB_ACTIONS=true, RUNNER_ENVIRONMENT=github-hosted): it reads the configuration and builds
// nothing; no test uses the owner-only override. Only JSON values come back; the Forge hooks (functions) are dropped.

export type ForgeChannel = 'production' | 'staging';
export interface ForgeConfigValues {
  packagerConfig: Record<string, unknown> & {executableName: string; appBundleId: string; name: string; appVersion: string; icon: string;
    extraResource: string[]; win32metadata: Record<string, string>};
  makers: {name: string; config: Record<string, string>}[];
}

const checkout = path.resolve(import.meta.dirname, '../..');
const BUILD_VARIABLES = ['ETS2TELEMETRY_BUILD_CHANNEL', 'ETS2TELEMETRY_OWNER_PRODUCTION_BUILD', 'ETS2TELEMETRY_STAGING_RUN_NUMBER', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT'];

/** The packaging configuration a `channel` build reads; `env` adds variables such as the staging run number. */
export function forgeConfig(channel: ForgeChannel, env: Record<string, string> = {}): ForgeConfigValues {
  const base: Record<string, string | undefined> = {...process.env};
  for (const name of BUILD_VARIABLES) delete base[name];
  const channelEnv = channel === 'production' ? {ETS2TELEMETRY_BUILD_CHANNEL: 'production', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted'} : {ETS2TELEMETRY_BUILD_CHANNEL: 'staging'};
  const result = spawnSync(process.execPath, ['-e', "process.stdout.write(JSON.stringify(require('./forge.config.cjs')))"],
    {cwd: checkout, encoding: 'utf8', timeout: 30000, env: {...base, ...channelEnv, ...env}});
  if (result.status !== 0) throw new Error(`forge.config.cjs did not load for ${channel}: ${result.stderr}`);
  return JSON.parse(result.stdout) as ForgeConfigValues;
}

/** The Squirrel maker options of a configuration. */
export const squirrelConfig = (config: ForgeConfigValues): Record<string, string> =>
  config.makers.find(maker => maker.name === '@electron-forge/maker-squirrel')?.config ?? {};
