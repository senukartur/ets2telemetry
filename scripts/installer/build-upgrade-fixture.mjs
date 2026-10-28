import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cp, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {createWindowsInstaller} from 'electron-winstaller';
import {packageDirectoryName, readBuiltBuild} from '../build-channel.mjs';
import {nugetVersion, setupExeName} from '../release-identity.mjs';
import {lifecycleVersions} from './installer-guard.mjs';

// ET-018 PR-1 (plan U10): builds installer version B, the local update feed of the installer lifecycle. It packs a
// temporary copy of the packaged application folder with the pinned electron-winstaller as installer version B (0.1.1 in
// production, 0.1.1-stg.000000 in staging: lifecycleVersions, ET-055 PR-5); the application bytes stay version A's, as in
// ET-001. electron-winstaller writes into its input (it adds Squirrel.exe and the
// executable stub), so the packaged folder is copied first and never handed over itself. This builds files only; it runs
// no installer. Usage: node scripts/installer/build-upgrade-fixture.mjs <run root fixture folder> <evidence file>

const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// ET-055 PR-4 and PR-5: the package, executable, NuGet id and versions of the build that was made (its desktop build
// evidence), never of the shell's variables. The harness sets ETS2TELEMETRY_BUILD_CHANNEL to that channel for this
// command, so that forge.config.cjs below resolves the same one.
const built = readBuiltBuild(checkout);
export const FIXTURE_VERSION = lifecycleVersions(built.channel, built.version).b.package;
const {identity} = built, executable = `${identity.executableName}.exe`;
const packaged = path.join(checkout, packageDirectoryName(identity));
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
const executableBefore = sha256(await readFile(path.join(packaged, executable)));
await cp(packaged, appDirectory, {recursive: true, errorOnExist: true, force: false});
try {
  // The same options the Forge Squirrel maker passes (forge.config.cjs, read here, and @electron-forge/maker-squirrel), with
  // the installer version raised; `version` overrides the package.json version only in the NuGet metadata. The maker's
  // `title` (the Installed apps DisplayName, ET-045h) applies here too.
  const maker = createRequire(import.meta.url)('../../forge.config.cjs').makers.find(entry => entry.name === '@electron-forge/maker-squirrel').config;
  // forge.config.cjs resolves the channel from this process's variables; it must name the build that was made.
  assert.equal(maker.name, identity.squirrelId, 'forge.config.cjs resolves another build channel than the package: set ETS2TELEMETRY_BUILD_CHANNEL as the build did');
  await createWindowsInstaller({noMsi: true, exe: executable, ...maker, appDirectory, outputDirectory: feed,
    setupExe: setupExeName(FIXTURE_VERSION, identity), version: FIXTURE_VERSION});
} finally {
  await rm(appDirectory, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});
}
// The packaged folder itself is unchanged.
assert.equal(sha256(await readFile(path.join(packaged, executable))), executableBefore, 'Packaged executable changed');
const files = await listing(feed);
const releases = (await readFile(path.join(feed, 'RELEASES'), 'utf8')).trim().split(/\r?\n/);
assert.equal(releases.length, 1, 'Expected one RELEASES entry');
// The package name carries the NuGet form of the version (0.1.1-stg000000 in staging).
assert.match(releases[0], new RegExp(`^[0-9A-Fa-f]{40} ${identity.squirrelId}-${nugetVersion(FIXTURE_VERSION).replaceAll('.', '\\.')}-full\\.nupkg \\d+$`), 'Unexpected RELEASES entry');
await writeFile(evidence, JSON.stringify({channel: built.channel, version: FIXTURE_VERSION, applicationVersion: built.version, feed: files, releases,
  seconds: (Date.now() - started) / 1000}, null, 2) + '\n');
process.stdout.write(`Upgrade fixture ${FIXTURE_VERSION}: ${files.map(file => file.name).join(', ')}\n`);
