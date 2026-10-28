import path from 'node:path';
import {CHANNEL} from './channel';
export function dataPaths(localAppData: string) {
  if (!path.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be absolute');
  const root = path.join(localAppData, CHANNEL.dataRootName);
  // `synthetic` holds synthetic and replay databases (<name>.sqlite, own backups); they never share the history file.
  return {root, database:path.join(root,'data','telemetry.sqlite'), settings:path.join(root,'settings'), logs:path.join(root,'logs'), backups:path.join(root,'backups'), synthetic:path.join(root,'synthetic'), pluginMetadata:path.join(root,'plugins'), captures:path.join(root,'captures')};
}
