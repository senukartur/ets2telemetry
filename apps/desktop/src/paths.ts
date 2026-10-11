import path from 'node:path';
export function dataPaths(localAppData: string) {
  if (!path.isAbsolute(localAppData)) throw new Error('LOCALAPPDATA must be absolute');
  const root = path.join(localAppData, 'ETS2Telemetry');
  return {root, database:path.join(root,'data','telemetry.sqlite'), settings:path.join(root,'settings'), logs:path.join(root,'logs'), backups:path.join(root,'backups'), pluginMetadata:path.join(root,'plugins')};
}
