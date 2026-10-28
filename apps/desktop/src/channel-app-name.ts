import path from 'node:path';
import type {ChannelIdentity} from './channel';

// Electron's application name of the build channel (ET-055 UP12). The name decides userData (%APPDATA%\<productName>),
// which keys the single-instance lock, so a staging and a production instance must never share it. A packaged staging
// build already carries its productName in the packaged package.json (forge.config.cjs rewrites it); an unpackaged run reads
// the repository's package.json, whose productName is production's. Electron derives userData from the name before the
// main script runs, so the name and the folder are set together, before anything reads userData or takes the lock.

/** The part of Electron's `app` this uses. */
export interface ChannelApp {
  readonly name: string;
  setName(name: string): void;
  getPath(name: 'appData'): string;
  setPath(name: 'userData' | 'sessionData', value: string): void;
}

/** Gives `app` the channel's productName and the userData folder named after it; true when anything changed. */
export function applyChannelAppName(app: ChannelApp, identity: ChannelIdentity): boolean {
  if (app.name === identity.productName) return false;
  app.setName(identity.productName);
  const userData = path.join(app.getPath('appData'), identity.productName);
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  return true;
}
