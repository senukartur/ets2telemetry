import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {CHANNEL_IDENTITIES} from '../../apps/desktop/src/channel';
import {exportTargetRefused, targetInsideDataRoot, type ExportFileSystem} from '../../apps/desktop/src/export-file';

// ET-055 UP12 (REG-015): the export refusal of each build channel. Production refuses only its own data root; staging
// refuses its own and production's, so a staging export can never land in either history folder. Every check takes the
// folder names, so both channels are covered under Vitest, whose build is production.

const LOCAL = 'C:\\Users\\owner\\AppData\\Local';
const PRODUCTION = CHANNEL_IDENTITIES.production.exportRefusalDataRootNames;
const STAGING = CHANNEL_IDENTITIES.staging.exportRefusalDataRootNames;
const inProduction = `${LOCAL}\\ETS2Telemetry\\exports\\trip.json`;
const inStaging = `${LOCAL}\\ETS2TelemetryStaging\\exports\\trip.json`;
const outside = 'C:\\Users\\owner\\Documents\\trip.json';

/**
 * A file system of fixed folders: `realpath` resolves `aliases` (a junction or short name) and otherwise returns the
 * path of an existing folder; `stat` gives each existing folder its own file identity. Missing folders reject both.
 */
function fakeFs(folders: readonly string[], aliases: Readonly<Record<string, string>> = {}): ExportFileSystem {
  const key = (target: string) => path.win32.normalize(target).toLowerCase();
  const identities = new Map(folders.map((folder, index) => [key(folder), BigInt(index + 1)]));
  const missing = (target: string) => Object.assign(new Error(`ENOENT ${target}`), {code: 'ENOENT'});
  const resolve = (target: string) => aliases[key(target)] ?? target;
  return {
    open: () => Promise.reject(new Error('not used')), rename: () => Promise.reject(new Error('not used')), unlink: () => Promise.reject(new Error('not used')),
    realpath: target => identities.has(key(resolve(target))) ? Promise.resolve(resolve(target)) : Promise.reject(missing(target)),
    stat: target => {
      const ino = identities.get(key(resolve(target)));
      return ino === undefined ? Promise.reject(missing(target)) : Promise.resolve({dev: 7n, ino});
    }
  };
}

describe('the export refusal by name', () => {
  it('refuses only its own data root in production', () => {
    expect(PRODUCTION).toEqual(['ETS2Telemetry']);
    expect(exportTargetRefused(inProduction, LOCAL, PRODUCTION)).toBe(true);
    expect(exportTargetRefused(inStaging, LOCAL, PRODUCTION)).toBe(false);
    expect(exportTargetRefused(outside, LOCAL, PRODUCTION)).toBe(false);
  });

  it('refuses both data roots in staging', () => {
    expect(STAGING).toEqual(['ETS2TelemetryStaging', 'ETS2Telemetry']);
    expect(exportTargetRefused(inStaging, LOCAL, STAGING)).toBe(true);
    expect(exportTargetRefused(inProduction, LOCAL, STAGING)).toBe(true);
    expect(exportTargetRefused(`${LOCAL}\\ETS2TELEMETRYSTAGING\\x.json`, LOCAL, STAGING)).toBe(true);
    expect(exportTargetRefused(`${LOCAL}\\ETS2TelemetryStaging`, LOCAL, STAGING)).toBe(true);
    expect(exportTargetRefused(outside, LOCAL, STAGING)).toBe(false);
    // A sibling folder that only starts with a data root name is not inside it.
    expect(exportTargetRefused(`${LOCAL}\\ETS2TelemetryStagingNotes\\x.json`, LOCAL, STAGING)).toBe(false);
  });

  it('defaults to this build channel, production under Vitest', () => {
    expect(exportTargetRefused(inProduction, LOCAL)).toBe(true);
    expect(exportTargetRefused(inStaging, LOCAL)).toBe(false);
  });
});

describe('the export refusal by real path and identity in staging', () => {
  const production = `${LOCAL}\\ETS2Telemetry`, staging = `${LOCAL}\\ETS2TelemetryStaging`, documents = 'C:\\Users\\owner\\Documents';

  it('still checks the production root when the staging root does not exist yet', async () => {
    // The first name of the staging list has no folder: realpath and stat reject it, and the second still refuses.
    const fs = fakeFs([production, `${production}\\exports`, documents]);
    await expect(targetInsideDataRoot(fs, `${production}\\exports\\trip.json`, LOCAL, STAGING)).resolves.toBe(true);
    await expect(targetInsideDataRoot(fs, `${documents}\\trip.json`, LOCAL, STAGING)).resolves.toBe(false);
  });

  it('refuses a folder that resolves into either data root through a junction', async () => {
    const intoStaging = fakeFs([staging, production, documents, `${staging}\\inner`], {[`${documents}\\link`.toLowerCase()]: `${staging}\\inner`});
    await expect(targetInsideDataRoot(intoStaging, `${documents}\\link\\trip.json`, LOCAL, STAGING)).resolves.toBe(true);
    const intoProduction = fakeFs([staging, production, documents, `${production}\\inner`], {[`${documents}\\link`.toLowerCase()]: `${production}\\inner`});
    await expect(targetInsideDataRoot(intoProduction, `${documents}\\link\\trip.json`, LOCAL, STAGING)).resolves.toBe(true);
    // Production refuses only its own root: the junction into the staging root is allowed there.
    await expect(targetInsideDataRoot(intoStaging, `${documents}\\link\\trip.json`, LOCAL, PRODUCTION)).resolves.toBe(false);
  });

  it('refuses a UNC alias of either data root by file identity', async () => {
    const share = '\\\\localhost\\C$\\Users\\owner\\AppData\\Local\\ETS2Telemetry';
    // The share resolves to itself (realpath keeps UNC paths) but has the production root's identity.
    const fs = fakeFs([staging, production, documents]);
    const aliased: ExportFileSystem = {...fs, realpath: target => target.toLowerCase().startsWith(share.toLowerCase()) ? Promise.resolve(target) : fs.realpath(target),
      stat: (target, options) => target.toLowerCase().startsWith(share.toLowerCase()) ? fs.stat(production, options) : fs.stat(target, options)};
    await expect(targetInsideDataRoot(aliased, `${share}\\trip.json`, LOCAL, STAGING)).resolves.toBe(true);
  });
});
