import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {CHANNEL_IDENTITIES, TRANSPORT_DIRECTORY} from '../../../apps/desktop/src/channel';
import {TEST_PIPE_PATTERN} from '../../../apps/desktop/src/telemetry-ingestion';

export const USAGE = `Usage: npm run channel:probe -- --game ets2|ats --output <new-directory> [--seconds 600] [--broker <telemetry-pipe-client.exe> --discovery-dir <transport\\v0 directory>]
Close Yukon Union Telemetry first: the probe takes the plugin's live connection. Without --broker it uses the newest installed staging build.`;

/** The newest installed staging broker and the staging discovery directory, from the channel table. */
export async function stagingBroker(localAppData: string): Promise<{executable: string; discoveryDirectory: string}> {
  const staging = CHANNEL_IDENTITIES.staging, root = path.win32.join(localAppData, staging.squirrelId);
  const versions = (await readdir(root, {withFileTypes: true})).filter(entry => entry.isDirectory() && entry.name.startsWith('app-')).map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b, 'en', {numeric: true}));
  if (!versions.length) throw new Error('No installed staging build was found; pass --broker and --discovery-dir.');
  return {executable: path.win32.join(root, versions[versions.length - 1], 'resources', 'telemetry-client', 'telemetry-pipe-client.exe'),
    discoveryDirectory: path.win32.join(localAppData, staging.dataRootName, TRANSPORT_DIRECTORY, 'v0')};
}
export function parseArguments(argv: string[]): Record<string, string> {
  const allowed = ['--game', '--output', '--seconds', '--broker', '--discovery-dir', '--fixture-endpoint'], result: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!allowed.includes(key) || value === undefined || Object.hasOwn(result, key)) throw new Error(USAGE);
    result[key] = value;
  }
  if (!result['--output'] || (result['--game'] !== 'ets2' && result['--game'] !== 'ats') || (result['--broker'] === undefined) !== (result['--discovery-dir'] === undefined)) throw new Error(USAGE);
  if (result['--fixture-endpoint'] !== undefined && (result['--broker'] !== undefined || !TEST_PIPE_PATTERN.test(result['--fixture-endpoint']))) throw new Error(USAGE);
  return result;
}
