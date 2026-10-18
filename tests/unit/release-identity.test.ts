import {createHash, randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {crc32, deflateRawSync} from 'node:zlib';
import {createPackageWithOptions} from '@electron/asar';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {writePluginBundle} from '../../scripts/plugin-bundle.mjs';
import {AUTHENTICODE_STATUSES, inspectInstaller, nugetVersion, parseAuthenticodeOutput, readAuthenticode, readZip, releaseIdentity, setupExeName,
  windowsPowerShell, type AuthenticodeResult} from '../../scripts/release-identity.mjs';

// ET-018 PR-6 (plan U14, U16; docs/release.md): the release identity and `inspect-package --installer` on a fake package
// tree, a fake Squirrel make output and a fake vendor folder in a temporary checkout. Every PE image is an inert synthetic
// header that nothing loads or runs. Authenticode comes from an injected reader, except one case that calls the real
// fixed Windows PowerShell script on a synthetic file and a Windows system file, read only.

const VERSION = '0.2.0';
const ELECTRON = '44.7.0';
let root: string;
beforeEach(async () => {root = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-release-identity-test-'));});
afterEach(async () => {await rm(root, {recursive: true, force: true});});

const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
/** Headers only: MZ, e_lfanew 0x80, "PE\0\0", the machine and the characteristics (0x2022 = DLL). `tag` makes the bytes unique. */
function pe({machine = 0x8664, characteristics = 0x0022, tag = randomUUID()} = {}) {
  const bytes = Buffer.alloc(1024, 0);
  bytes.write('MZ', 0, 'latin1');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(machine, 0x84);
  bytes.writeUInt16LE(characteristics, 0x80 + 22);
  bytes.write(tag, 0x200, 'latin1');
  return bytes;
}
const elf = () => Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from(randomUUID())]);
const machO = () => Buffer.concat([Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), Buffer.from(randomUUID())]);
/** A marker the fake Authenticode reader treats as a valid signature. */
const SIGNED = 'FAKE-AUTHENTICODE-SIGNATURE';

interface Tree {
  checkout: string; packageDirectory: string; makeDirectory: string; vendorDirectory: string;
  /** Relative paths of the PE images the fixture placed in the package, chosen at random. */
  pe: string[]; foreign: string[];
}
async function put(file: string, bytes: Buffer | string) {
  await mkdir(path.dirname(file), {recursive: true});
  await writeFile(file, bytes);
}

/** A fake checkout with a portable package, the vendored Squirrel binaries and (with buildMake) the make output. */
async function fakeTree(): Promise<Tree> {
  const checkout = path.join(root, 'checkout');
  const packageDirectory = path.join(checkout, 'out', 'ETS2Telemetry Desktop-win32-x64');
  const makeDirectory = path.join(checkout, 'out', 'make', 'squirrel.windows', 'x64');
  const vendorDirectory = path.join(checkout, 'node_modules', 'electron-winstaller', 'vendor');
  await put(path.join(checkout, 'package.json'), JSON.stringify({version: VERSION, devDependencies: {electron: ELECTRON}}));
  const random = () => randomUUID().slice(0, 8);
  const peFiles: string[] = [], foreign: string[] = [];
  const addPe = async (relative: string, bytes = pe()) => {await put(path.join(packageDirectory, relative), bytes); peFiles.push(relative);};
  await addPe('ETS2TelemetryDesktop.exe');
  await addPe(`runtime-${random()}.dll`, pe({characteristics: 0x2022}));
  // A PE image whose name gives no hint: it is still found by its header.
  await addPe(`blob-${random()}.bin`);
  for (const [name, bytes] of [['LICENSE', 'license'], ['LICENSES.chromium.html', 'licenses'], ['version', ELECTRON], ['icudtl.dat', 'icu'],
    ['resources.pak', 'pak'], ['snapshot_blob.bin', 'snapshot'], [`locales/${random()}.pak`, 'locale']] as const) {
    await put(path.join(packageDirectory, name), bytes);
  }
  // The application archive with its unpacked Node addons: one PE per Windows machine and foreign prebuilds.
  const source = path.join(root, 'asar-source');
  const addons: [string, Buffer][] = [[`node_modules/addon-${random()}/build/Release/addon.node`, pe()],
    [`node_modules/better-sqlite3/prebuilds/win32-arm64.node`, pe({machine: 0xaa64})], [`node_modules/better-sqlite3/prebuilds/linux-x64.node`, elf()],
    [`node_modules/better-sqlite3/prebuilds/darwin-x64.node`, machO()], ['apps/desktop/dist/main.cjs', Buffer.from('inert')]];
  for (const [name, bytes] of addons) await put(path.join(source, name), bytes);
  await mkdir(path.join(packageDirectory, 'resources'), {recursive: true});
  await createPackageWithOptions(source, path.join(packageDirectory, 'resources', 'app.asar'), {unpack: '**/*'});
  for (const [name, bytes] of addons) {
    const relative = `resources/app.asar.unpacked/${name}`;
    if (bytes.readUInt16LE(0) === 0x5a4d) peFiles.push(relative); else if (name.endsWith('.node')) foreign.push(relative);
  }
  writePluginBundle(path.join(packageDirectory, 'resources', 'telemetry-plugin'), {dll: pe({characteristics: 0x2022}), appVersion: VERSION,
    pluginSources: {'native/telemetry-plugin/CMakeLists.txt': 'b'.repeat(64)}, known: []});
  peFiles.push('resources/telemetry-plugin/ets2telemetry-plugin.dll');
  const broker = pe();
  await addPe('resources/telemetry-client/telemetry-pipe-client.exe', broker);
  await put(path.join(packageDirectory, 'resources', 'telemetry-client', 'build-evidence.json'), JSON.stringify({executableSha256: sha256(broker)}));
  for (const name of ['Squirrel.exe', 'Setup.exe', 'StubExecutable.exe']) await put(path.join(vendorDirectory, name), pe({machine: 0x014c}));
  return {checkout, packageDirectory, makeDirectory, vendorDirectory, pe: peFiles.sort(), foreign: foreign.sort()};
}

/** A stored or deflated ZIP archive, as Squirrel's NuGet package; directory entries end in `/`. */
function zip(entries: [string, Buffer][]) {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8'), method = name.endsWith('/') || /LICENSE$|.pak$/.test(name) ? 0 : 8;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8); local.writeUInt32LE(crc32(data) >>> 0, 14);
    local.writeUInt32LE(stored.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc32(data) >>> 0, 16); central.writeUInt32LE(stored.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, stored); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + stored.length;
  }
  const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

interface MakeOptions {
  change?: (entries: Map<string, Buffer>) => void;
  nuspecVersion?: string;
  releases?: (nupkg: Buffer) => string;
}
/** Builds the make output from the package as it is now: Setup, the full NuGet package and RELEASES. */
async function buildMake(tree: Tree, {change, nuspecVersion = nugetVersion(VERSION), releases}: MakeOptions = {}) {
  const entries = new Map<string, Buffer>();
  entries.set('ETS2TelemetryDesktop.nuspec', Buffer.from(`<package><metadata><id>ETS2TelemetryDesktop</id><version>${nuspecVersion}</version></metadata></package>`));
  for (const relative of await listRelative(tree.packageDirectory)) {
    if (['LICENSES.chromium.html', 'version'].includes(relative)) continue;
    entries.set(`lib/net45/${relative}`, await readFile(path.join(tree.packageDirectory, relative)));
  }
  entries.set('lib/net45/squirrel.exe', await readFile(path.join(tree.vendorDirectory, 'Squirrel.exe')));
  entries.set('lib/net45/ETS2TelemetryDesktop_ExecutionStub.exe', pe({machine: 0x014c}));
  entries.set('[Content_Types].xml', Buffer.from('<Types/>'));
  entries.set('_rels/.rels', Buffer.from('<Relationships/>'));
  entries.set(`package/services/metadata/core-properties/${'0123456789abcdef'.repeat(2)}.psmdcp`, Buffer.from('<coreProperties/>'));
  change?.(entries);
  const nupkg = zip([['lib/', Buffer.alloc(0)], ['lib/net45/', Buffer.alloc(0)], ...entries]);
  await rm(tree.makeDirectory, {recursive: true, force: true});
  await put(path.join(tree.makeDirectory, `ETS2TelemetryDesktop-${VERSION}-full.nupkg`), nupkg);
  await put(path.join(tree.makeDirectory, setupExeName(VERSION)), pe({machine: 0x014c}));
  await put(path.join(tree.makeDirectory, 'RELEASES'), releases?.(nupkg)
    ?? `\uFEFF${createHash('sha1').update(nupkg).digest('hex').toUpperCase()} ETS2TelemetryDesktop-${VERSION}-full.nupkg ${nupkg.length}`);
}
async function listRelative(directory: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(directory, prefix), {withFileTypes: true})) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listRelative(directory, relative)); else files.push(relative);
  }
  return files;
}

/** The fake Authenticode reader: Valid for bytes that carry the marker, NotSigned otherwise. It records every file. */
function fakeSignatures() {
  const calls: string[][] = [];
  const reader = (files: string[]): AuthenticodeResult[] => {
    calls.push(files);
    return files.map(file => {
      const bytes = readFileSync(file);
      return bytes.includes(SIGNED) ? {status: 'Valid', signer: 'CN=Fake Signer', thumbprint: 'A'.repeat(40), timestamped: true}
        : {status: 'NotSigned', signer: null, thumbprint: null, timestamped: false};
    });
  };
  return {reader, calls};
}
const SOURCE = {commit: 'c'.repeat(40), sourceCommit: null, treeClean: true};
const identityOf = (tree: Tree, signatures = fakeSignatures().reader) => releaseIdentity({checkout: tree.checkout, packageDirectory: tree.packageDirectory,
  makeDirectory: tree.makeDirectory, vendorDirectory: tree.vendorDirectory, signatures, source: SOURCE, now: () => new Date('2026-10-18T12:00:00Z')});
const inspect = (tree: Tree) => inspectInstaller({packageDirectory: tree.packageDirectory, makeDirectory: tree.makeDirectory, version: VERSION});

describe('PE images', () => {
  it('lists every PE image found by walking the package, the NuGet additions and Setup, each with its Authenticode result', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    const {reader, calls} = fakeSignatures();
    const identity = identityOf(tree, reader);
    expect(identity.peImages.filter(image => image.location === 'package').map(image => image.path).sort()).toEqual(tree.pe);
    expect(identity.peImages.filter(image => image.location !== 'package').map(image => `${image.location}:${image.path}`)).toEqual([
      'nupkg:lib/net45/ETS2TelemetryDesktop_ExecutionStub.exe', 'nupkg:lib/net45/squirrel.exe', `installer:${setupExeName(VERSION)}`]);
    // The Windows .node addons are PE images with Authenticode results; the foreign prebuilds are listed with their format.
    expect(identity.peImages.find(image => image.path.endsWith('win32-arm64.node'))).toMatchObject({machine: 'arm64', authenticode: {status: 'NotSigned'}});
    expect(identity.peImages.find(image => image.path.endsWith('/addon.node'))).toMatchObject({machine: 'x64', authenticode: {status: 'NotSigned'}});
    expect(identity.foreignNodeAddons.map(addon => `${addon.path}:${addon.format}`).sort())
      .toEqual(['resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/darwin-x64.node:mach-o',
        'resources/app.asar.unpacked/node_modules/better-sqlite3/prebuilds/linux-x64.node:elf']);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(identity.peImages.length);
    for (const image of identity.peImages) expect(image.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(identity.signing.summary).toEqual({NotSigned: identity.peImages.length});
  });

  it('records the status and signer the Authenticode reader returns, never a fixed value', async () => {
    const tree = await fakeTree();
    const dll = path.join(tree.packageDirectory, `signed-${randomUUID().slice(0, 8)}.dll`);
    await writeFile(dll, Buffer.concat([pe({characteristics: 0x2022}), Buffer.from(SIGNED)]));
    await buildMake(tree);
    const identity = identityOf(tree);
    expect(identity.peImages.find(image => image.path === path.basename(dll))?.authenticode)
      .toEqual({status: 'Valid', signer: 'CN=Fake Signer', thumbprint: 'A'.repeat(40), timestamped: true});
    expect(identity.signing.summary).toEqual({Valid: 1, NotSigned: identity.peImages.length - 1});
  });

  it('refuses an EXE or DLL that is not a PE image and a Node addon that is no executable image', async () => {
    for (const name of ['resources/tools/fake.exe', 'fake.dll', 'resources/fake.node']) {
      const tree = await fakeTree();
      await put(path.join(tree.packageDirectory, name), 'not an image');
      await buildMake(tree);
      expect(() => identityOf(tree)).toThrow(name.endsWith('.node') ? 'Not an executable image' : 'Not a PE image');
      await rm(tree.checkout, {recursive: true, force: true});
    }
  });

  it('writes relative names only', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    const text = JSON.stringify(identityOf(tree));
    expect(text).not.toContain(root);
    expect(text).not.toContain(tmpdir());
    expect(text).not.toMatch(/[A-Za-z]:[\\/]|\\\\/);
  });
});

describe('plugin, broker and Squirrel helpers', () => {
  it('records the plugin and broker hashes that match their bundle records', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    const identity = identityOf(tree);
    const manifest = JSON.parse(await readFile(path.join(tree.packageDirectory, 'resources/telemetry-plugin/plugin-manifest.json'), 'utf8')) as {sha256: string};
    expect(identity.plugin).toMatchObject({file: 'resources/telemetry-plugin/ets2telemetry-plugin.dll', appVersion: VERSION, matchesManifest: true,
      sha256: sha256(await readFile(path.join(tree.packageDirectory, 'resources/telemetry-plugin/ets2telemetry-plugin.dll')))});
    expect(identity.plugin.sha256).toBe(manifest.sha256);
    expect(identity.broker.sha256).toBe(sha256(await readFile(path.join(tree.packageDirectory, 'resources/telemetry-client/telemetry-pipe-client.exe'))));
    expect(identity.versions).toEqual({app: VERSION, nuget: VERSION, electron: ELECTRON, plugin: VERSION});
    expect(identity.squirrel.updateExe).toEqual({path: 'lib/net45/squirrel.exe', matchesVendor: true,
      sha256: sha256(await readFile(path.join(tree.vendorDirectory, 'Squirrel.exe')))});
    expect(Object.keys(identity.squirrel.vendor).sort()).toEqual(['Setup.exe', 'Squirrel.exe', 'StubExecutable.exe']);
  });

  it('fails when the plugin DLL differs from its manifest, even when the NuGet package carries the same bytes', async () => {
    const tree = await fakeTree();
    await writeFile(path.join(tree.packageDirectory, 'resources/telemetry-plugin/ets2telemetry-plugin.dll'), pe({characteristics: 0x2022}));
    await buildMake(tree);
    expect(() => inspect(tree)).not.toThrow();
    expect(() => identityOf(tree)).toThrow('Plugin DLL hash differs from its manifest');
  });

  it('fails when the broker differs from its build evidence', async () => {
    const tree = await fakeTree();
    await writeFile(path.join(tree.packageDirectory, 'resources/telemetry-client/telemetry-pipe-client.exe'), pe());
    await buildMake(tree);
    expect(() => identityOf(tree)).toThrow('Broker hash differs from its build evidence');
  });

  it('fails when Update.exe differs from the vendored Squirrel.exe or the Electron runtime from the pin', async () => {
    const tree = await fakeTree();
    await buildMake(tree, {change: entries => entries.set('lib/net45/squirrel.exe', pe({machine: 0x014c}))});
    expect(() => identityOf(tree)).toThrow('Update.exe differs from the vendored Squirrel.exe');
    await buildMake(tree);
    await writeFile(path.join(tree.packageDirectory, 'version'), '44.7.1');
    expect(() => identityOf(tree)).toThrow('Packaged Electron differs from the package.json pin');
  });
});

describe('the NuGet projection (inspect-package --installer)', () => {
  it('accepts a payload equal to the package projection with the known Squirrel additions', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    const facts = inspect(tree);
    expect(facts.excludedPackageFiles).toEqual(['LICENSES.chromium.html', 'version']);
    expect(facts.projectedFiles).toBe((await listRelative(tree.packageDirectory)).length - 2);
    expect(facts.additions).toEqual(['ETS2TelemetryDesktop.nuspec', '[Content_Types].xml', '_rels/.rels', 'lib/net45/ETS2TelemetryDesktop_ExecutionStub.exe',
      'lib/net45/squirrel.exe', `package/services/metadata/core-properties/${'0123456789abcdef'.repeat(2)}.psmdcp`]);
    expect(facts).toMatchObject({setup: `ETS2Telemetry-Setup-${VERSION}.exe`, nupkg: `ETS2TelemetryDesktop-${VERSION}-full.nupkg`, releases: 'RELEASES'});
  });

  const mismatches: [string, MakeOptions, string][] = [
    ['a payload file with other bytes', {change: entries => entries.set('lib/net45/resources.pak', Buffer.from('other'))}, 'NuGet payload differs from the package: resources.pak'],
    ['a package file missing from the payload', {change: entries => entries.delete('lib/net45/resources/telemetry-plugin/ets2telemetry-plugin.dll')}, 'Package files missing from the NuGet package'],
    ['an unknown payload entry', {change: entries => entries.set('lib/net45/extra.dll', pe())}, 'Unexpected NuGet package entries'],
    ['an excluded package file in the payload', {change: entries => entries.set('lib/net45/version', Buffer.from(ELECTRON))}, 'Unexpected NuGet package entries'],
    ['Update.exe missing', {change: entries => entries.delete('lib/net45/squirrel.exe')}, 'Squirrel addition missing: lib/net45/squirrel.exe'],
    ['the execution stub missing', {change: entries => entries.delete('lib/net45/ETS2TelemetryDesktop_ExecutionStub.exe')}, 'Squirrel addition missing'],
    ['another nuspec version', {nuspecVersion: '0.1.0'}, 'Nuspec version differs from package.json'],
    ['a RELEASES SHA-1 of other bytes', {releases: nupkg => `${'0'.repeat(40)} ETS2TelemetryDesktop-${VERSION}-full.nupkg ${nupkg.length}`}, 'RELEASES SHA-1 differs'],
    ['a RELEASES size of other bytes', {releases: nupkg => `${createHash('sha1').update(nupkg).digest('hex')} ETS2TelemetryDesktop-${VERSION}-full.nupkg 1`}, 'RELEASES size differs'],
    ['two RELEASES entries', {releases: () => `${'0'.repeat(40)} a.nupkg 1\n${'0'.repeat(40)} b.nupkg 1`}, 'RELEASES must hold exactly one entry']
  ];
  for (const [label, options, message] of mismatches) {
    it(`detects ${label}`, async () => {
      const tree = await fakeTree();
      await buildMake(tree, options);
      expect(() => inspect(tree)).toThrow(message);
      expect(() => identityOf(tree)).toThrow(message);
    });
  }

  it('refuses a native image that the NuGet package leaves out', async () => {
    const tree = await fakeTree();
    await put(path.join(tree.packageDirectory, 'helper.exe'), pe());
    await buildMake(tree, {change: entries => entries.delete('lib/net45/helper.exe')});
    expect(() => inspect(tree)).toThrow('Package native image left out of the NuGet package: helper.exe');
  });

  it('detects a package file changed after the make', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    await writeFile(path.join(tree.packageDirectory, 'icudtl.dat'), 'changed');
    expect(() => inspect(tree)).toThrow('NuGet payload differs from the package: icudtl.dat');
  });

  it('refuses a stale Setup of another version and a corrupt payload entry', async () => {
    const tree = await fakeTree();
    await buildMake(tree);
    await writeFile(path.join(tree.makeDirectory, setupExeName('0.1.0')), pe());
    expect(() => inspect(tree)).toThrow('Unexpected Squirrel make output');
    await buildMake(tree);
    const nupkg = path.join(tree.makeDirectory, `ETS2TelemetryDesktop-${VERSION}-full.nupkg`);
    const bytes = await readFile(nupkg);
    const zipped = readZip(bytes);
    expect(zipped.names).toContain('lib/net45/LICENSE');
    // The stored LICENSE entry's first data byte, found by its content: the CRC-32 check catches the change.
    const at = bytes.indexOf(Buffer.from('license'));
    bytes[at] ^= 1;
    expect(() => readZip(bytes).extract('lib/net45/LICENSE')).toThrow('ZIP entry CRC mismatch');
  });
});

describe('Authenticode output', () => {
  const subject = Buffer.from('CN=Example, O=Example Ltd', 'utf8').toString('base64');
  it('parses one line per file, in order', () => {
    expect(parseAuthenticodeOutput(`0 NotSigned - - 0\r\n1 Valid ${subject} ${'B'.repeat(40)} 1\n2 HashMismatch - - 0\n`, 3)).toEqual([
      {status: 'NotSigned', signer: null, thumbprint: null, timestamped: false},
      {status: 'Valid', signer: 'CN=Example, O=Example Ltd', thumbprint: 'B'.repeat(40), timestamped: true},
      {status: 'HashMismatch', signer: null, thumbprint: null, timestamped: false}]);
    for (const status of AUTHENTICODE_STATUSES) expect(parseAuthenticodeOutput(`0 ${status} - - 0`, 1)[0].status).toBe(status);
  });
  const invalid: [string, string, number, string][] = [
    ['an unknown status', '0 Signed - - 0', 1, 'Unknown Authenticode status: Signed'],
    ['too few lines', '0 NotSigned - - 0', 2, 'wrong number of lines'],
    ['too many lines', '0 NotSigned - - 0\n1 NotSigned - - 0', 1, 'wrong number of lines'],
    ['lines out of order', '1 NotSigned - - 0\n0 NotSigned - - 0', 2, 'out of order'],
    ['a signer without a thumbprint', `0 Valid ${subject} - 1`, 1, 'Signer and thumbprint disagree'],
    ['a thumbprint without a signer', `0 Valid - ${'B'.repeat(40)} 1`, 1, 'Signer and thumbprint disagree'],
    ['a non-canonical signer encoding', `0 Valid ${subject.slice(0, -1)}x ${'B'.repeat(40)} 1`, 1, 'Invalid'],
    ['a signer that is not UTF-8', `0 Valid ${Buffer.from([0xff, 0xfe]).toString('base64')} ${'B'.repeat(40)} 1`, 1, 'not valid'],
    ['a malformed line', '0 NotSigned', 1, 'Invalid Authenticode output line 0']
  ];
  for (const [label, stdout, count, message] of invalid) it(`refuses ${label}`, () => {expect(() => parseAuthenticodeOutput(stdout, count)).toThrow(message);});

  it('reads real results through the fixed Windows PowerShell script, also for a non-ASCII path', async () => {
    const file = path.join(root, 'Łódź-ñ-файл.dll');
    await writeFile(file, pe({characteristics: 0x2022}));
    const system = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const [unsigned, signed] = readAuthenticode([file, system]);
    expect(unsigned).toEqual({status: 'NotSigned', signer: null, thumbprint: null, timestamped: false});
    expect(signed.status).toBe('Valid');
    expect(signed.signer).toContain('O=Microsoft Corporation');
  }, 60000);

  it('gives Windows PowerShell only its own module folder', () => {
    const shell = windowsPowerShell({SystemRoot: 'C:\\Windows', PSMODULEPATH: 'C:\\pwsh\\Modules', psmodulepath: 'D:\\other', KEEP: '1'});
    expect(shell.executable).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(shell.env).toEqual({SystemRoot: 'C:\\Windows', KEEP: '1', PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules'});
  });
});

describe('maker metadata', () => {
  it('names Setup with the package version and sets the NuGet authors and description', async () => {
    const forge = (await import(pathToFileURL(path.resolve('forge.config.cjs')).href) as {default: {makers: {name: string; config: Record<string, string>}[]}}).default;
    const {version} = JSON.parse(await readFile(path.resolve('package.json'), 'utf8')) as {version: string};
    const squirrel = forge.makers.find(maker => maker.name === '@electron-forge/maker-squirrel')?.config;
    expect(squirrel).toMatchObject({name: 'ETS2TelemetryDesktop', setupExe: setupExeName(version)});
    expect(setupExeName(version)).toBe(`ETS2Telemetry-Setup-${version}.exe`);
    // The installer lifecycle finds Setup by this name.
    expect(await readFile(path.resolve('scripts/installer/Invoke-InstallerLifecycle.ps1'), 'utf8')).toContain(`'out/make/squirrel.windows/x64/${setupExeName(version)}'`);
    expect(squirrel?.authors).toMatch(/\S/);
    expect(squirrel?.description).toMatch(/\S/);
  });

  it('converts versions the way electron-winstaller does', () => {
    expect(nugetVersion('0.1.0')).toBe('0.1.0');
    expect(nugetVersion('0.2.0-beta.1')).toBe('0.2.0-beta1');
    expect(nugetVersion('1.0.0-alpha.1+build.5')).toBe('1.0.0-alpha1');
  });
});
