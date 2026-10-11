import {readFileSync, statSync, lstatSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import type {BrokerConfiguration} from './native-pipe-client';
function boundedJson(filename: string): Record<string, unknown> {
  if (lstatSync(filename).isSymbolicLink() || statSync(filename).size > 1024 * 1024) throw new Error('Native artifact metadata bound rejected');
  return JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
}
/** Fixed build paths only. The receipt binds reviewed build inputs and executable bytes in the same-user model. */
export function brokerConfiguration(directory: string, resources: string, packaged: boolean, localAppData: string | undefined): BrokerConfiguration | undefined {
  if (!localAppData || !path.isAbsolute(localAppData)) return undefined;
  const root = packaged ? path.join(resources, 'telemetry-client') : path.resolve(directory, '../../../native/telemetry-client/build/Release');
  const executable = path.join(root, 'telemetry-pipe-client.exe');
  if (!existsSync(executable)) return undefined;
  const receipt = boundedJson(path.join(root, 'build-evidence.json'));
  const desktop = boundedJson(path.join(directory, 'build-evidence.json'));
  if (typeof receipt.executableSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.executableSha256) || !receipt.sources || JSON.stringify(receipt.sources) !== JSON.stringify(desktop.sources) || lstatSync(executable).isSymbolicLink() || statSync(executable).size > 64 * 1024 * 1024) throw new Error('Native artifact build provenance rejected');
  if (createHash('sha256').update(readFileSync(executable)).digest('hex') !== receipt.executableSha256) throw new Error('Native artifact byte hash rejected');
  return {executable, discoveryDirectory: path.join(localAppData, 'ETS2Telemetry', 'transport', 'v0')};
}

/** Cache verification only while all three fixed artifacts retain their observed file identities. */
export function createBrokerResolver(directory: string, resources: string, packaged: boolean, localAppData: string | undefined, rejected: (error: unknown) => void) {
  const root = packaged ? path.join(resources, 'telemetry-client') : path.resolve(directory, '../../../native/telemetry-client/build/Release');
  const filenames = [path.join(root, 'telemetry-pipe-client.exe'), path.join(root, 'build-evidence.json'), path.join(directory, 'build-evidence.json')];
  let identity: string | undefined, cached: BrokerConfiguration | undefined;
  return (): BrokerConfiguration | undefined => {
    try {
      const current = JSON.stringify(filenames.map(filename => {
        try {
          const stat = lstatSync(filename, {bigint: true});
          return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode].map(String);
        } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error;}
      }));
      if (current === identity) return cached;
      // Failures are also cached until an artifact changes, bounding repeated rejected requests.
      identity = current; cached = undefined;
      try {cached = brokerConfiguration(directory, resources, packaged, localAppData);}
      catch (error) {rejected(error);}
      return cached;
    } catch (error) {identity = undefined; cached = undefined; rejected(error); return undefined;}
  };
}
