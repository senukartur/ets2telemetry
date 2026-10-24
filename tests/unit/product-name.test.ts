import {readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {EN_DICTIONARY} from '../../apps/desktop/src/i18n/en';
import {RU_DICTIONARY} from '../../apps/desktop/src/i18n/ru';
import {tripExportHeader} from '../../apps/desktop/src/journal-export';
import {SHORTCUT_COMPANY, SHORTCUT_NAME, SQUIRREL_APP_ID} from '../../apps/desktop/src/legacy-shortcuts';
import {APP_COPY_KEYS} from '../../apps/desktop/src/screens/app-copy';
import {ROAMING_USER_DATA_NAME} from '../../apps/desktop/src/squirrel-events';
import * as STRINGS_MODULE from '../../apps/desktop/src/strings';
import {deferralReadme} from '../../apps/desktop/src/uninstall/deferral';
import {DATA_ROOT_NAME, PRODUCT_ROOT_NAME} from '../../apps/desktop/src/uninstall/roots';
import {COMPANY_NAME, PRODUCT_NAME, PUBLISHER} from '../../scripts/release-identity.mjs';
import {ROAMING_ROOT} from '../../scripts/installer/installer-guard.mjs';

// ET-045h (owner decision D2): the product's user-facing name is "Yukon Union Telemetry". This guard collects every
// user-facing text this repository ships (the EN/RU dictionaries, every exported copy table, the deferral README, the
// deferred-cleanup executor's README and message box, the window title and the installer's display metadata) and fails
// on any remaining "ETS2Telemetry" outside an explicit allowlist of literal folder and file names. It also pins the
// technical identities that must not change with the name.

const checkout = path.resolve(import.meta.dirname, '..', '..');
const read = (relative: string) => readFileSync(path.join(checkout, relative), 'utf8');
const OLD_NAME = /ETS2\s*Telemetry/i;
/** Literal folder and file names a user may need to type or find; they keep the technical name. */
const ALLOWED = [
  /%LOCALAPPDATA%\\ETS2Telemetry\b(?!\s*Desktop)/g,
  /%LOCALAPPDATA%\\ETS2TelemetryDesktop/g,
  /%APPDATA%\\ETS2Telemetry Desktop/g,
  /ets2telemetry-plugin\.dll/g,
  /ets2telemetry-diagnostics-/g,
  /Complete-ETS2TelemetryUninstall\.ps1/g
];
const strip = (text: string) => ALLOWED.reduce((rest, pattern) => rest.replace(pattern, ''), text);

/** Every string value of `value`, recursively through arrays and plain objects; functions and numbers are skipped. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}
/** The quoted literals of the executor's user-facing lines: its README lines, the failure notice and the message box. */
function executorTexts(): string[] {
  const lines = read('resources/uninstall/Complete-ETS2TelemetryUninstall.ps1').split(/\r?\n/);
  const start = lines.findIndex(line => line.startsWith('function Write-Readme'));
  const end = lines.findIndex(line => line.startsWith('function Write-Receipt'));
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const texts: string[] = [];
  for (const line of lines.slice(start, end)) {
    if (/^\s*#/.test(line)) continue;
    if (!/\$lines\.Add\(|\$notice = |MessageBox\]::Show\(|^\s*'(complete|deferred|stopped|refused)' \{/.test(line)) continue;
    for (const match of line.matchAll(/'((?:[^']|'')*)'|"((?:[^"`]|`.)*)"/g)) texts.push(match[1] ?? match[2]);
  }
  return texts;
}

/** The user-facing texts, each with where it came from. */
function userFacingTexts(): {source: string; text: string}[] {
  const texts: {source: string; text: string}[] = [];
  const add = (source: string, values: readonly string[]) => {for (const text of values) texts.push({source, text});};
  add('i18n/en.ts', Object.values(EN_DICTIONARY));
  add('i18n/ru.ts', Object.values(RU_DICTIONARY));
  for (const [name, table] of Object.entries(STRINGS_MODULE)) if (typeof table === 'object') add(`strings.ts ${name}`, strings(table));
  add('APP_COPY_KEYS source texts', Object.keys(APP_COPY_KEYS));
  for (const automatic of [false, true]) {
    add('deferralReadme', [deferralReadme('%LOCALAPPDATA%\\ETS2Telemetry', [{game: 'ETS2', root: 'D:\\Games\\Euro Truck Simulator 2', hashes: ['a'.repeat(64)]}],
      ['b'.repeat(64)], 'GAME_RUNNING', automatic)]);
  }
  add('Complete-ETS2TelemetryUninstall.ps1', executorTexts());
  add('index.html <title>', [/<title>([^<]*)<\/title>/.exec(read('apps/desktop/index.html'))?.[1] ?? '']);
  return texts;
}

describe('the user-facing product name', () => {
  it('collects the texts it guards', () => {
    const texts = userFacingTexts();
    const has = (source: string, text: string) => texts.some(entry => entry.source.startsWith(source) && entry.text.includes(text));
    expect(has('strings.ts STRINGS', 'Exit Yukon Union Telemetry')).toBe(true);
    expect(has('i18n/ru.ts', 'Удалить Yukon Union Telemetry')).toBe(true);
    expect(has('deferralReadme', 'Yukon Union Telemetry finishes this cleanup')).toBe(true);
    expect(has('Complete-ETS2TelemetryUninstall.ps1', 'Yukon Union Telemetry uninstall')).toBe(true);
    expect(has('Complete-ETS2TelemetryUninstall.ps1', 'Yukon Union Telemetry finished removing')).toBe(true);
    expect(has('index.html', 'Yukon Union Telemetry')).toBe(true);
  });

  it('never shows the old product name, apart from literal folder and file names', () => {
    const offending = userFacingTexts().filter(({text}) => OLD_NAME.test(strip(text))).map(({source, text}) => `${source}: ${text}`);
    expect(offending).toEqual([]);
  });

  it('keeps the literal folder names that the user may need', () => {
    expect(STRINGS_MODULE.UNINSTALL_STRINGS.finishedFailed).toContain('%LOCALAPPDATA%\\ETS2Telemetry by hand');
  });

  it('gives the installer and the executable the product name', async () => {
    const forge = (await import(pathToFileURL(path.join(checkout, 'forge.config.cjs')).href) as {default: {
      packagerConfig: {win32metadata: Record<string, string>; executableName: string; appBundleId: string};
      makers: {name: string; config: Record<string, string>}[];
    }}).default;
    const squirrel = forge.makers.find(maker => maker.name === '@electron-forge/maker-squirrel')?.config ?? {};
    const {version} = JSON.parse(read('package.json')) as {version: string};
    expect({title: squirrel.title, authors: squirrel.authors, setupExe: squirrel.setupExe}).toEqual({title: PRODUCT_NAME, authors: PUBLISHER,
      setupExe: `YukonUnionTelemetry-Setup-${version}.exe`});
    expect(forge.packagerConfig.win32metadata).toEqual({CompanyName: COMPANY_NAME, FileDescription: PRODUCT_NAME, ProductName: PRODUCT_NAME});
    // The shortcut migration derives the new name and the Start menu folder from the same values.
    expect(SHORTCUT_NAME).toBe(forge.packagerConfig.win32metadata.ProductName);
    expect(SHORTCUT_COMPANY).toBe(forge.packagerConfig.win32metadata.CompanyName);
    for (const text of [squirrel.title, squirrel.authors, squirrel.setupExe, ...Object.values(forge.packagerConfig.win32metadata)]) expect(text).not.toMatch(OLD_NAME);
  });
});

describe('the technical identities stay', () => {
  it('keeps productName, the Squirrel id, the executable, the bundle id, the data root and the export identity', async () => {
    const forge = (await import(pathToFileURL(path.join(checkout, 'forge.config.cjs')).href) as {default: {
      packagerConfig: {executableName: string; appBundleId: string}; makers: {name: string; config: Record<string, string>}[];
    }}).default;
    const squirrel = forge.makers.find(maker => maker.name === '@electron-forge/maker-squirrel')?.config ?? {};
    const {productName} = JSON.parse(read('package.json')) as {productName: string};
    // productName decides %APPDATA%\ETS2Telemetry Desktop (userData), the single-instance lock and the out/ folder.
    expect(productName).toBe('ETS2Telemetry Desktop');
    expect(ROAMING_USER_DATA_NAME).toBe(productName);
    expect(ROAMING_ROOT).toBe(productName);
    // The Squirrel id decides the install root, the Uninstall key and the shortcut AUMID: one installation, one entry.
    expect(squirrel.name).toBe('ETS2TelemetryDesktop');
    expect(PRODUCT_ROOT_NAME).toBe(squirrel.name);
    expect(SQUIRREL_APP_ID).toBe(squirrel.name);
    expect(forge.packagerConfig.executableName).toBe('ETS2TelemetryDesktop');
    expect(forge.packagerConfig.appBundleId).toBe('com.ets2telemetry.desktop');
    expect(DATA_ROOT_NAME).toBe('ETS2Telemetry');
    expect(tripExportHeader({uuid: '00000000-0000-4000-8000-000000000000', purpose: 'history', schemaVersion: 3}, '0.1.0', 0).application.name).toBe('ETS2Telemetry');
  });
});

describe('Russian copy for the renamed texts', () => {
  const tables = Object.entries(STRINGS_MODULE as Record<string, unknown>).filter((entry): entry is [string, object] => typeof entry[1] === 'object' && entry[1] !== null);
  const englishTexts = new Set(tables.filter(([name]) => !name.endsWith('_RU')).flatMap(([, table]) => strings(table)));

  // The English text of strings.ts is the lookup key of APP_COPY_KEYS: a text renamed without its key would silently show
  // English in Russian, and the stale key would match nothing.
  it('every translation key that names the product still matches an English table text, and translates it', () => {
    const keys = Object.keys(APP_COPY_KEYS).filter(text => text.includes(SHORTCUT_NAME));
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter(text => !englishTexts.has(text))).toEqual([]);
    for (const text of keys) expect(RU_DICTIONARY[APP_COPY_KEYS[text]], text).not.toBe(text);
  });

  it('every product-naming text of a table with a Russian twin is translated there', () => {
    for (const [name, table] of tables) {
      const twin = (STRINGS_MODULE as Record<string, unknown>)[`${name}_RU`];
      if (name.endsWith('_RU') || !twin || typeof twin !== 'object') continue;
      for (const [key, text] of Object.entries(table)) {
        if (typeof text !== 'string' || !text.includes(SHORTCUT_NAME) || text === SHORTCUT_NAME) continue;
        const russian = (twin as Record<string, unknown>)[key];
        expect(typeof russian, `${name}.${key}`).toBe('string');
        expect(russian, `${name}.${key}`).not.toBe(text);
      }
    }
  });
});
