import type {ReleaseChannel} from '../channel';
import {APP_VERSION_PATTERN} from './update-view';

// Versions and release tags of the update feed (ET-055 UP4, UP15). An application version `0.2.0-stg.000042` becomes the
// NuGet version `0.2.0-stg000042` exactly as electron-winstaller's convertVersion makes it (the prerelease dots are
// removed), and the nupkg is `<Squirrel id>-<NuGet version>-full.nupkg`. Versions are compared by NuGet's SemVer 2.0
// precedence, never by the order a list arrives in.

/** A staging release tag (UP4): `staging-v<x.y.z>-stg.<6 digits>`. */
export const STAGING_TAG = /^staging-v\d+\.\d+\.\d+-stg\.\d{6}$/;
/** A production release tag: `v<application version>`. */
export const PRODUCTION_TAG = /^v\d{1,9}\.\d{1,9}\.\d{1,9}(-[0-9A-Za-z.-]{1,40})?$/;

/** The release tag of `appVersion` in `channel`. */
export function releaseTag(channel: ReleaseChannel, appVersion: string): string {
  return channel === 'staging' ? `staging-v${appVersion}` : `v${appVersion}`;
}
/** Whether `tag` is a release tag of `channel`. A staging tag never matches production's pattern, nor the reverse. */
export function isChannelTag(channel: ReleaseChannel, tag: string): boolean {
  return (channel === 'staging' ? STAGING_TAG : PRODUCTION_TAG).test(tag);
}
/** The application version a channel tag names, or undefined. */
export function tagVersion(channel: ReleaseChannel, tag: string): string | undefined {
  if (!isChannelTag(channel, tag)) return undefined;
  const version = tag.slice(channel === 'staging' ? 'staging-v'.length : 1);
  return APP_VERSION_PATTERN.test(version) ? version : undefined;
}

/** The NuGet version of an application version (electron-winstaller's convertVersion). */
export function nugetVersionOf(appVersion: string): string {
  const [main, ...prerelease] = appVersion.split('+')[0].split('-');
  return prerelease.length ? `${main}-${prerelease.join('-').replace(/\./g, '')}` : main;
}

const NUGET_VERSION = /^(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z.-]{1,60}))?$/;
/** Whether `value` is a NuGet version this updater compares. */
export const isNugetVersion = (value: string) => NUGET_VERSION.test(value);

function compareIdentifier(a: string, b: string): number {
  const numericA = /^\d+$/.test(a), numericB = /^\d+$/.test(b);
  if (numericA && numericB) {const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0;}
  if (numericA !== numericB) return numericA ? -1 : 1;
  const lowerA = a.toLowerCase(), lowerB = b.toLowerCase();
  return lowerA < lowerB ? -1 : lowerA > lowerB ? 1 : 0;
}

/**
 * Compares two NuGet versions by SemVer 2.0 precedence, prerelease labels case-insensitively as NuGet does: negative,
 * zero or positive. Both must satisfy isNugetVersion; leading zeros of numeric parts are compared by value.
 */
export function compareNugetVersions(a: string, b: string): number {
  const left = NUGET_VERSION.exec(a), right = NUGET_VERSION.exec(b);
  if (!left || !right) throw new Error('Not a NuGet version');
  for (let index = 1; index <= 3; index++) {
    const difference = Number(left[index]) - Number(right[index]);
    if (difference !== 0) return difference;
  }
  const [preA, preB] = [left[4], right[4]];
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  const partsA = preA.split('.'), partsB = preB.split('.');
  for (let index = 0; index < Math.min(partsA.length, partsB.length); index++) {
    const difference = compareIdentifier(partsA[index], partsB[index]);
    if (difference !== 0) return difference;
  }
  return partsA.length - partsB.length;
}
