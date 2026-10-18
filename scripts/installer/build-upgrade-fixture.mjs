import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWindowsInstaller} from 'electron-winstaller';

// ET-018 PR-1 (plan U10): builds installer version B, the local update feed of the installer lifecycle. It packs a
// temporary copy of the packaged application folder with the pinned electron-winstaller as installer version 0.1.1; the
// application bytes stay 0.1.0, as in ET-001. electron-winstaller writes into its input (it adds Squirrel.exe and the
// executable stub), so the packaged folder is copied first and never handed over itself. This builds files only; it runs
// no installer. Usage: node scripts/installer/build-upgrade-fixture.mjs <run root fixture folder> <evidence file>

export const FIXTURE_VERSION = '0.1.1';
const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packaged = path.join(checkout, 'out', 'ETS2Telemetry Desktop-win32-x64');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function listing(directory) {
  const rows = [];
  for (const name of (await readdir(directory)).sort()) {
    const bytes = await readFile(path.join(directory, name));
    rows.push({name, size: bytes.length, sha256: sha256(bytes)});
  }
  return rows;
}

const [fixture, evidence] = process.argv.slice(2);
assert.ok(fixture && path.isAbsolute(fixture) && evidence && path.isAbsolute(evidence), 'Usage: build-upgrade-fixture.mjs <absolute fixture folder> <absolute evidence file>');
const appDirectory = path.join(fixture, 'app'), feed = path.join(fixture, 'feed');
const started = Date.now();
await mkdir(fixture, {recursive: true});
await assert.rejects(readdir(appDirectory), {code: 'ENOENT'}, 'Fixture app folder already exists');
const executableBefore = sha256(await readFile(path.join(packaged, 'ETS2TelemetryDesktop.exe')));
await cp(packaged, appDirectory, {recursive: true, errorOnExist: true, force: false});
try {
  // The same options the Forge Squirrel maker passes (forge.config.cjs and @electron-forge/maker-squirrel), with the
  // installer version raised; `version` overrides the package.json version only in the NuGet metadata.
  await createWindowsInstaller({appDirectory, outputDirectory: feed, name: 'ETS2TelemetryDesktop', title: 'ETS2Telemetry Desktop', noMsi: true,
    exe: 'ETS2TelemetryDesktop.exe', setupExe: `ETS2Telemetry Desktop-${FIXTURE_VERSION} Setup.exe`, version: FIXTURE_VERSION});
} finally {
  await rm(appDirectory, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
// The packaged folder itself is unchanged.
assert.equal(sha256(await readFile(path.join(packaged, 'ETS2TelemetryDesktop.exe'))), executableBefore, 'Packaged executable changed');
const files = await listing(feed);
const releases = (await readFile(path.join(feed, 'RELEASES'), 'utf8')).trim().split(/\r?\n/);
assert.equal(releases.length, 1, 'Expected one RELEASES entry');
assert.match(releases[0], new RegExp(`^[0-9A-Fa-f]{40} ETS2TelemetryDesktop-${FIXTURE_VERSION.replaceAll('.', '\\.')}-full\\.nupkg \\d+$`), 'Unexpected RELEASES entry');
await writeFile(evidence, JSON.stringify({version: FIXTURE_VERSION, applicationVersion: '0.1.0', feed: files, releases, seconds: (Date.now() - started) / 1000}, null, 2) + '\n');
process.stdout.write(`Upgrade fixture ${FIXTURE_VERSION}: ${files.map(file => file.name).join(', ')}\n`);
