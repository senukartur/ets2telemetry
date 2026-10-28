import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {buildNames, readBuiltBuild} from '../build-channel.mjs';

// ET-055 PR-5 (REG-017, REG-019; docs/installer-testing.md, "Side-by-side scenario"): the staging Setup that the hosted
// side-by-side scenario installs beside production. Windows CI builds staging in its own job on main pushes and
// dispatches (docs/ci.md); that job writes this folder, `create`, and the installer job reads it back, `verify`, before
// the harness installs anything. The folder holds exactly the staging Setup and `side-by-side-input.json`: the build's
// names (`node scripts/build-channel.mjs --built`), the Setup's SHA-256 and size, and the source and checkout commits.
// `verify` accepts only a staging build of this same checkout whose Setup has the recorded bytes, and prints the record
// with the Setup's absolute path for the harness. Nothing here runs an installer.

export const INPUT_FILE = 'side-by-side-input.json';
export const INPUT_FORMAT = 'ets2telemetry.side-by-side-input';
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * The checks of a parsed input record against the checkout that reads it: the fixed format, a staging build, a Setup
 * file name of the staging template, commits of fixed form with the checkout's own, and a hash of fixed form. Returns
 * the record; throws the first failure.
 */
export function checkSideBySideInput(record, checkout) {
  assert.ok(record !== null && typeof record === 'object' && !Array.isArray(record), 'SIDE_BY_SIDE_INPUT_INVALID');
  assert.equal(Object.keys(record).sort().join(','), 'build,checkout,format,setup,source,version', 'SIDE_BY_SIDE_INPUT_INVALID');
  assert.equal(record.format, INPUT_FORMAT, 'SIDE_BY_SIDE_INPUT_INVALID');
  assert.equal(record.version, 1, 'SIDE_BY_SIDE_INPUT_INVALID');
  assert.equal(record.build?.channel, 'staging', 'SIDE_BY_SIDE_INPUT_NOT_STAGING');
  assert.ok(typeof record.build.setup === 'string' && /^YukonUnionTelemetry-Staging-Setup-[0-9A-Za-z.-]{5,60}\.exe$/.test(record.build.setup), 'SIDE_BY_SIDE_INPUT_SETUP_NAME');
  assert.equal(record.setup?.name, record.build.setup, 'SIDE_BY_SIDE_INPUT_SETUP_NAME');
  assert.ok(SHA256.test(record.setup.sha256) && Number.isSafeInteger(record.setup.bytes) && record.setup.bytes > 0, 'SIDE_BY_SIDE_INPUT_SETUP_HASH');
  assert.ok(COMMIT.test(record.source) && COMMIT.test(record.checkout), 'SIDE_BY_SIDE_INPUT_COMMIT');
  assert.equal(record.checkout, checkout, 'SIDE_BY_SIDE_INPUT_OTHER_CHECKOUT');
  return record;
}

/** Writes the folder: the staging Setup of the checkout's build (out/make) and the record. Refuses any build but staging. */
export function createSideBySideInput(root, output, source, checkout) {
  const built = readBuiltBuild(root);
  assert.equal(built.channel, 'staging', 'SIDE_BY_SIDE_INPUT_NOT_STAGING');
  const names = buildNames(built), setup = path.join(root, 'out', 'make', 'squirrel.windows', 'x64', names.setup);
  const bytes = readFileSync(setup);
  mkdirSync(output, {recursive: true});
  assert.deepEqual(readdirSync(output), [], 'SIDE_BY_SIDE_INPUT_FOLDER_NOT_EMPTY');
  copyFileSync(setup, path.join(output, names.setup));
  const record = checkSideBySideInput({format: INPUT_FORMAT, version: 1, source, checkout, build: names, setup: {name: names.setup, sha256: sha256(bytes), bytes: bytes.length}}, checkout);
  writeFileSync(path.join(output, INPUT_FILE), `${JSON.stringify(record, null, 2)}\n`, {flag: 'wx'});
  return record;
}

/**
 * Reads and checks the folder: exactly the record and its Setup, both regular files, the record checked against the
 * checkout and the Setup's bytes against the record. Returns the record with the Setup's absolute path.
 */
export function verifySideBySideInput(directory, checkout) {
  const entries = readdirSync(directory).sort();
  const record = checkSideBySideInput(JSON.parse(readFileSync(path.join(directory, INPUT_FILE), 'utf8')), checkout);
  assert.deepEqual(entries, [INPUT_FILE, record.setup.name].sort(), 'SIDE_BY_SIDE_INPUT_FOLDER_UNEXPECTED');
  const setup = path.join(directory, record.setup.name);
  for (const file of [setup, path.join(directory, INPUT_FILE)]) {
    const item = lstatSync(file);
    assert.ok(item.isFile() && !item.isSymbolicLink(), 'SIDE_BY_SIDE_INPUT_NOT_A_FILE');
  }
  const bytes = readFileSync(setup);
  assert.deepEqual({sha256: sha256(bytes), bytes: bytes.length}, {sha256: record.setup.sha256, bytes: record.setup.bytes}, 'SIDE_BY_SIDE_INPUT_SETUP_CHANGED');
  return {...record, setupPath: path.resolve(setup)};
}

// CLI: `create <output folder>` in the staging build job, `verify <folder>` in the harness; both print one JSON line.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const [mode, directory] = process.argv.slice(2);
  assert.ok((mode === 'create' || mode === 'verify') && directory && path.isAbsolute(directory), 'Usage: side-by-side-input.mjs <create|verify> <absolute folder>');
  const checkout = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8', windowsHide: true}).trim();
  const result = mode === 'create' ? createSideBySideInput(root, directory, process.env.ETS2TELEMETRY_SOURCE_COMMIT, checkout) : verifySideBySideInput(directory, checkout);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
