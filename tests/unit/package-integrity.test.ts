import {afterEach, expect, it} from 'vitest';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createPackageWithOptions} from '@electron/asar';
import {verifyPackage} from '../../scripts/package-integrity.mjs';

const temporary: string[] = [];
const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
afterEach(async () => {await Promise.all(temporary.splice(0).map(directory => rm(directory, {recursive: true, force: true})));});
async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'ets2-integrity-test-'));
  temporary.push(directory);
  const source = path.join(directory, 'source');
  const packageDirectory = path.join(directory, 'package');
  const files = ['apps/desktop/dist/telemetry-service.cjs', 'apps/desktop/dist/storage-worker.cjs',
    'node_modules/better-sqlite3/lib/database.js', 'node_modules/better-sqlite3/prebuilds/win32-x64.node'];
  for (const filename of files) {
    await mkdir(path.dirname(path.join(source, filename)), {recursive: true});
    // Harmless bytes only: never executable fixtures or a real SQLite binding.
    await writeFile(path.join(source, filename), `fixture:${filename}`);
  }
  await mkdir(path.join(packageDirectory, 'resources'), {recursive: true});
  const archive = path.join(packageDirectory, 'resources/app.asar');
  await createPackageWithOptions(source, archive, {unpack: '**/*'});
  await writeFile(path.join(packageDirectory, 'ETS2TelemetryDesktop.exe'), 'inert EXE fixture');
  const archiveHash = () => readFile(archive).then(bytes => createHash('sha256').update(bytes).digest('hex'));
  const physical = (filename: string) => path.join(`${archive}.unpacked`, filename);
  return {packageDirectory, archive, archiveHash, physical, files};
}
function powershell(packageDirectory: string) {
  // A pwsh 7 parent may otherwise export incompatible module locations to PowerShell 5.1.
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  environment.PSModulePath = [
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/Modules'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell/Modules')
  ].join(';');
  // Only this child process bypasses script policy; machine/user policy is unchanged.
  return JSON.parse(execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve('tests/package-integrity/read.ps1'), '-PackageDirectory', packageDirectory],
  {encoding: 'utf8', timeout: 15000, windowsHide: true, env: environment, stdio: ['ignore', 'pipe', 'pipe']}));
}
function expectPowershellFailure(packageDirectory: string, diagnostic: string) {
  let failure: {status?: number; stderr?: string} | undefined;
  try {powershell(packageDirectory);} catch (error) {failure = error as typeof failure;}
  expect(failure?.status).toBe(1);
  expect(failure?.stderr).toContain(diagnostic);
}

it('matches Node and clean-Windows PowerShell fingerprints without launching package files', async () => {
  const f = await fixture();
  const actual = verifyPackage(f.packageDirectory);
  expect(actual.unpackedFilesVerified).toBe(4);
  expect(powershell(f.packageDirectory)).toEqual(actual);
}, 20000);

for (const kind of ['service', 'sqlite-loader', 'native'] as const) {
  it(`rejects altered unpacked ${kind} bytes while ASAR remains unchanged`, async () => {
    const f = await fixture();
    const hash = await f.archiveHash();
    const filename = f.files[kind === 'service' ? 0 : kind === 'sqlite-loader' ? 2 : 3];
    const bytes = await readFile(f.physical(filename));
    bytes[0] ^= 1; // Preserve length: the SHA256 header check must catch this.
    await writeFile(f.physical(filename), bytes);
    expect(await f.archiveHash()).toBe(hash);
    expect(() => verifyPackage(f.packageDirectory)).toThrow('Unpacked integrity mismatch');
    expectPowershellFailure(f.packageDirectory, 'Unpacked file integrity mismatch');
  }, 20000);
}

it('binds package binary bytes outside ASAR in both fingerprints', async () => {
  const f = await fixture();
  const hash = await f.archiveHash();
  const before = verifyPackage(f.packageDirectory);
  await writeFile(path.join(f.packageDirectory, 'ETS2TelemetryDesktop.exe'), 'different inert EXE fixture');
  const after = verifyPackage(f.packageDirectory);
  expect(after.packageSha256).not.toBe(before.packageSha256);
  expect(await f.archiveHash()).toBe(hash);
  expect(powershell(f.packageDirectory)).toEqual(after);
}, 20000);

it('rejects extra unpacked code without an ASAR header entry', async () => {
  const f = await fixture();
  await writeFile(f.physical('apps/desktop/dist/extra.cjs'), 'inert extra fixture');
  expect(() => verifyPackage(f.packageDirectory)).toThrow('Unexpected unpacked file');
  expectPowershellFailure(f.packageDirectory, 'Unexpected unpacked file');
}, 20000);

async function replaceHeader(archive: string, header: unknown) {
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const paddedLength = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(16 + paddedLength);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(8 + paddedLength, 4);
  bytes.writeUInt32LE(4 + paddedLength, 8);
  bytes.writeUInt32LE(json.length, 12);
  json.copy(bytes, 16);
  await writeFile(archive, bytes);
}

it('rejects header traversal before resolving unpacked paths in either verifier', async () => {
  const f = await fixture();
  await replaceHeader(f.archive, {files: {'..': {files: {}}}});
  expect(() => verifyPackage(f.packageDirectory)).toThrow('Invalid ASAR path segment');
  expectPowershellFailure(f.packageDirectory, 'Invalid ASAR path segment');
}, 20000);

it('rejects ASAR links in either verifier', async () => {
  const f = await fixture();
  await replaceHeader(f.archive, {files: {alias: {link: 'outside'}}});
  expect(() => verifyPackage(f.packageDirectory)).toThrow('ASAR links are not allowed');
  expectPowershellFailure(f.packageDirectory, 'ASAR links are not allowed');
}, 20000);

it('rejects oversized header allocation in either verifier', async () => {
  const f = await fixture();
  const bytes = Buffer.alloc(8);
  bytes.writeUInt32LE(4, 0);
  bytes.writeUInt32LE(16 * 1024 * 1024 + 4, 4);
  await writeFile(f.archive, bytes);
  expect(() => verifyPackage(f.packageDirectory)).toThrow('ASAR header exceeds verification bounds');
  expectPowershellFailure(f.packageDirectory, 'Invalid or oversized ASAR header');
}, 20000);
