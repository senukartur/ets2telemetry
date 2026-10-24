import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {crc32, inflateRawSync} from 'node:zlib';
import * as asar from '@electron/asar';
import {verifyPackage} from './package-integrity.mjs';
import {PLUGIN_FILE, verifyPluginBundle} from './plugin-bundle.mjs';

// Release artifact identity (ET-018 PR-6, plan U14 and U16; docs/release.md). It reads the Forge package and the Squirrel
// make output, checks that the full NuGet package carries exactly the portable package's files, and writes
// release-identity.json beside the installer: the commit and versions, the artifact hashes, every PE image with its
// Authenticode status and signer, the plugin and broker hashes against their bundle records and the Squirrel helper
// hashes. It never runs Setup, Update.exe or any packaged executable; the only program it starts is Windows PowerShell
// 5.1 for Get-AuthenticodeSignature. Every name it records is relative: no machine path enters the file.

export const IDENTITY_FORMAT = 'ets2telemetry.release-identity';
export const IDENTITY_FILE = 'release-identity.json';
export const PACKAGE_DIRECTORY = 'out/ETS2Telemetry Desktop-win32-x64';
export const MAKE_DIRECTORY = 'out/make/squirrel.windows/x64';
export const VENDOR_DIRECTORY = 'node_modules/electron-winstaller/vendor';
export const NUGET_ID = 'ETS2TelemetryDesktop';
export const EXECUTABLE = 'ETS2TelemetryDesktop.exe';
export const RELEASES = 'RELEASES';
/** The product's display name (ET-045h, owner decision D2): the nuspec title and the executable's ProductName and FileDescription. */
export const PRODUCT_NAME = 'Yukon Union Telemetry';
/** The nuspec authors, which Squirrel writes as the Installed apps Publisher (ET-045h H1). */
export const PUBLISHER = 'Yukon Union Telemetry contributors';
/** The executable's CompanyName, which names the Start menu folder of the shortcuts (ET-045h H2). */
export const COMPANY_NAME = 'Artur Sianiuk';
/** The statuses of System.Management.Automation.SignatureStatus in Windows PowerShell 5.1. */
export const AUTHENTICODE_STATUSES = ['Valid', 'UnknownError', 'NotSigned', 'HashMismatch', 'NotTrusted', 'NotSupportedFileFormat', 'Incompatible'];
/**
 * Statuses that stop the identity (docs/release.md, "Signing status gate"). `HashMismatch`: a signed file whose bytes
 * changed after signing, so it is tampered or corrupt. `UnknownError`: Windows PowerShell maps only a few WinVerifyTrust
 * results to named statuses and every other one to `UnknownError`, so besides a malformed signature or a verifier fault it
 * also covers an untrusted root, a certificate expired without a timestamp, a revoked certificate and a chain that cannot
 * be built. Those are deterministic: a rerun gives the same result, and a person must inspect the file. (An unsigned PE
 * image is `NotSigned`.) `NotSigned` is expected for the unsigned alpha. `NotTrusted` means explicit distrust only, and
 * `NotSupportedFileFormat` and `Incompatible` depend on the file type and the Windows version; they are recorded.
 */
export const SIGNING_FAILURES = ['HashMismatch', 'UnknownError'];
/** EXE and DLL files must be PE images; a PE image with any other name is still found by its header. */
const PE_EXTENSIONS = new Set(['.exe', '.dll']);
/** Node addons are PE images, or the ELF and Mach-O prebuilds of other platforms that better-sqlite3 ships and Windows never loads. */
const ADDON_EXTENSION = '.node';
const MAX_TREE_ENTRIES = 100000;
const MAX_ZIP_ENTRIES = 65535;
const PAYLOAD = 'lib/net45/';
const SIGNATURE_TIMEOUT_MS = 120000;
const SIGNATURE_MAX_OUTPUT = 1024 * 1024;

/** The versioned Setup name of forge.config.cjs. */
export const setupExeName = version => `YukonUnionTelemetry-Setup-${version}.exe`;
/** electron-winstaller's convertVersion: NuGet takes the prerelease label without dots and drops build metadata. */
export function nugetVersion(version) {
  const [main, ...prerelease] = version.split('+')[0].split('-');
  return prerelease.length ? `${main}-${prerelease.join('-').replace(/\./g, '')}` : main;
}
export const nupkgName = version => `${NUGET_ID}-${nugetVersion(version)}-full.nupkg`;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** SHA-256 and size of a file, read in 1 MiB blocks. */
export function hashFile(filename) {
  const hash = createHash('sha256'), block = Buffer.alloc(1024 * 1024), fd = openSync(filename, 'r');
  let size = 0;
  try {
    for (let read; (read = readSync(fd, block, 0, block.length, null)) > 0; size += read) hash.update(block.subarray(0, read));
  } finally {closeSync(fd);}
  return {size, sha256: hash.digest('hex')};
}

/** Every regular file below `root`, as sorted `/`-separated relative names. Links are refused, never followed. */
export function listFiles(root) {
  const files = [];
  let entries = 0;
  function walk(relative, depth) {
    assert.ok(depth <= 64 && ++entries <= MAX_TREE_ENTRIES, 'Package tree bounds exceeded');
    const item = lstatSync(relative ? path.join(root, relative) : root);
    assert.ok(!item.isSymbolicLink(), `Package entry must not be a link: ${relative || '.'}`);
    if (item.isDirectory()) for (const name of readdirSync(path.join(root, relative))) walk(relative ? `${relative}/${name}` : name, depth + 1);
    else {assert.ok(item.isFile(), `Package entry must be a regular file: ${relative}`); files.push(relative);}
  }
  walk('', 0);
  return files.sort();
}

const MACHINES = new Map([[0x8664, 'x64'], [0x014c, 'x86'], [0xaa64, 'arm64']]);
/** The machine of a PE image (MZ header, e_lfanew, `PE\0\0`), or null when `bytes` is not one. */
export function peMachine(read) {
  const dos = read(0, 64);
  if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return null;
  const offset = dos.readUInt32LE(0x3c);
  if (offset < 64 || offset > 0x10000000) return null;
  const header = read(offset, 6);
  if (header.length < 6 || header.readUInt32LE(0) !== 0x4550) return null;
  const machine = header.readUInt16LE(4);
  return MACHINES.get(machine) ?? `0x${machine.toString(16).padStart(4, '0')}`;
}
function fileReader(filename) {
  const fd = openSync(filename, 'r');
  return {read: (position, length) => {const buffer = Buffer.alloc(length); return buffer.subarray(0, readSync(fd, buffer, 0, length, position));}, close: () => closeSync(fd)};
}
const bufferReader = bytes => (position, length) => bytes.subarray(position, position + length);
/** The executable format of a file that is not a PE image: `elf`, `mach-o` or null. */
export function foreignFormat(read) {
  const magic = read(0, 4);
  if (magic.length < 4) return null;
  if (magic.readUInt32BE(0) === 0x7f454c46) return 'elf';
  return [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic.readUInt32BE(0)) ? 'mach-o' : null;
}
/**
 * Classifies one file by its header: `{pe: machine}`, `{foreign: format}` for another platform's Node addon, or null.
 * An EXE or DLL that is not a PE image, and a Node addon that is no executable image at all, fail.
 */
function classify(relative, read) {
  const extension = path.posix.extname(relative).toLowerCase(), machine = peMachine(read);
  if (machine !== null) return {pe: machine};
  assert.ok(!PE_EXTENSIONS.has(extension), `Not a PE image: ${relative}`);
  if (extension !== ADDON_EXTENSION) return null;
  const format = foreignFormat(read);
  assert.ok(format !== null, `Not an executable image: ${relative}`);
  return {foreign: format};
}
function classifyFile(relative, filename) {
  const reader = fileReader(filename);
  try {return classify(relative, reader.read);} finally {reader.close();}
}

/**
 * Every native image below `root`, found by walking the tree and reading each file's header, never from a list of names:
 * `pe` holds the PE images `{path, size, sha256, machine}`, `foreign` the ELF and Mach-O Node addons `{path, size,
 * sha256, format}`.
 */
export function listNativeFiles(root) {
  const pe = [], foreign = [];
  for (const relative of listFiles(root)) {
    const filename = path.join(root, relative), kind = classifyFile(relative, filename);
    if (kind?.pe) pe.push({path: relative, ...hashFile(filename), machine: kind.pe});
    else if (kind?.foreign) foreign.push({path: relative, ...hashFile(filename), format: kind.foreign});
  }
  return {pe, foreign};
}

// --- The full NuGet package -----------------------------------------------------------------------------------------

/**
 * Reads a ZIP archive's central directory: stored and deflated entries only, no ZIP64, encryption or spanning. Every
 * central record must lie inside the directory, and every local header and its data before the directory.
 */
export function readZip(bytes) {
  const minimum = Math.max(0, bytes.length - 0xffff - 22);
  let end = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset--) if (bytes.readUInt32LE(offset) === 0x06054b50) {end = offset; break;}
  assert.ok(end >= 0, 'ZIP end of central directory not found');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  assert.ok(count !== 0xffff && size !== 0xffffffff && start !== 0xffffffff, 'ZIP64 archives are not supported');
  assert.ok(count <= MAX_ZIP_ENTRIES && start + size <= end, 'Invalid ZIP central directory');
  const directoryEnd = start + size;
  const entries = new Map();
  let offset = start;
  for (let index = 0; index < count; index++) {
    assert.ok(offset + 46 <= directoryEnd, 'ZIP central directory record outside the directory');
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50, 'Invalid ZIP central directory entry');
    const flags = bytes.readUInt16LE(offset + 8), method = bytes.readUInt16LE(offset + 10), crc = bytes.readUInt32LE(offset + 16);
    const compressed = bytes.readUInt32LE(offset + 20), length = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28), extraLength = bytes.readUInt16LE(offset + 30), commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    assert.ok(next <= directoryEnd, 'ZIP central directory record outside the directory');
    const name = new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    assert.ok((flags & 1) === 0, `Encrypted ZIP entry: ${name}`);
    assert.ok(compressed !== 0xffffffff && length !== 0xffffffff && local !== 0xffffffff, 'ZIP64 archives are not supported');
    assert.ok(method === 0 || method === 8, `Unsupported ZIP compression method ${method}: ${name}`);
    assert.ok(name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').some(part => part === '.' || part === '..'), `Invalid ZIP entry name: ${name}`);
    assert.ok(!entries.has(name), `Repeated ZIP entry: ${name}`);
    entries.set(name, {name, method, crc, compressed, length, local, nameBytes: bytes.subarray(offset + 46, offset + 46 + nameLength)});
    offset = next;
  }
  assert.equal(offset, directoryEnd, 'ZIP central directory size differs from its records');
  /** The bytes of one entry, inflated and checked against its CRC-32 and size. */
  function extract(name) {
    const entry = entries.get(name);
    assert.ok(entry, `Missing ZIP entry: ${name}`);
    assert.ok(entry.local + 30 <= start, `ZIP local header outside the archive data: ${name}`);
    assert.equal(bytes.readUInt32LE(entry.local), 0x04034b50, `Invalid ZIP local header: ${name}`);
    const nameLength = bytes.readUInt16LE(entry.local + 26);
    assert.ok(bytes.subarray(entry.local + 30, entry.local + 30 + nameLength).equals(entry.nameBytes), `ZIP local header names another entry: ${name}`);
    const data = entry.local + 30 + nameLength + bytes.readUInt16LE(entry.local + 28);
    assert.ok(data + entry.compressed <= start, `Truncated ZIP entry: ${name}`);
    const raw = bytes.subarray(data, data + entry.compressed);
    const content = entry.method === 0 ? raw : entry.length ? inflateRawSync(raw, {maxOutputLength: entry.length}) : Buffer.alloc(0);
    assert.equal(content.length, entry.length, `ZIP entry size mismatch: ${name}`);
    assert.equal(crc32(content) >>> 0, entry.crc, `ZIP entry CRC mismatch: ${name}`);
    return content;
  }
  return {names: [...entries.keys()], extract};
}

/**
 * Where a portable package file lands in the NuGet package, or null when the package leaves it out. These are the
 * `<files>` rules of electron-winstaller 5.4.4's template.nuspectemplate and its swiftshader additions; a change in
 * that template shows up here as a projection mismatch.
 */
export function projectPackageFile(relative, executable = EXECUTABLE) {
  const topLevel = !relative.includes('/');
  const included = /^(locales|resources|swiftshader)\//.test(relative)
    || (topLevel && (/\.(bin|dll|pak)$/.test(relative) || /\.exe\.(config|sig)$/.test(relative)
      || ['icudtl.dat', 'LICENSE', 'vk_swiftshader_icd.json', executable].includes(relative)));
  return included ? `${PAYLOAD}${relative}` : null;
}

/**
 * The NuGet entries Squirrel adds beyond the projected package files: Update.exe as `squirrel.exe`, an execution stub
 * for each top-level executable, the nuspec and the Open Packaging Conventions metadata.
 */
export function knownAddition(name, stubs) {
  return name === `${PAYLOAD}squirrel.exe` || stubs.has(name) || name === `${NUGET_ID}.nuspec` || name === '[Content_Types].xml'
    || name === '_rels/.rels' || /^package\/services\/metadata\/core-properties\/[0-9a-f]{32}\.psmdcp$/.test(name);
}

/** Parses RELEASES: exactly one full-package line `<SHA-1> <name> <size>`, with an optional UTF-8 byte order mark. */
export function parseReleases(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  assert.equal(lines.length, 1, 'RELEASES must hold exactly one entry');
  const match = /^([0-9A-Fa-f]{40}) (\S+) (\d+)$/.exec(lines[0].trim());
  assert.ok(match, 'Invalid RELEASES entry');
  return {sha1: match[1].toLowerCase(), name: match[2], size: Number(match[3])};
}

/**
 * Checks the Squirrel make output against the portable package (`inspect-package --installer`): exactly Setup, the full
 * NuGet package and RELEASES (and release-identity.json once written); RELEASES names the package with its SHA-1 and
 * size; the nuspec has this id and version; and the payload holds every projected package file with the same bytes,
 * nothing else beyond the known Squirrel additions. Returns the facts with relative names only.
 */
export function inspectInstaller(options) {
  return checkInstaller(options).facts;
}
function checkInstaller({packageDirectory, makeDirectory, version, executable = EXECUTABLE}) {
  const setup = setupExeName(version), nupkg = nupkgName(version);
  const present = readdirSync(makeDirectory).sort();
  const expected = [setup, nupkg, RELEASES].sort();
  assert.deepEqual(present.filter(name => name !== IDENTITY_FILE), expected, 'Unexpected Squirrel make output');
  for (const name of expected) {
    const item = lstatSync(path.join(makeDirectory, name));
    assert.ok(item.isFile() && !item.isSymbolicLink(), `Squirrel make output must be a regular file: ${name}`);
  }
  const releases = parseReleases(readFileSync(path.join(makeDirectory, RELEASES), 'utf8'));
  const nupkgFile = path.join(makeDirectory, nupkg);
  const nupkgBytes = readFileSync(nupkgFile);
  assert.equal(releases.name, nupkg, 'RELEASES names another package');
  assert.equal(releases.size, nupkgBytes.length, 'RELEASES size differs from the package');
  assert.equal(createHash('sha1').update(nupkgBytes).digest('hex'), releases.sha1, 'RELEASES SHA-1 differs from the package');
  const zip = readZip(nupkgBytes);
  const nuspec = zip.extract(`${NUGET_ID}.nuspec`).toString('utf8');
  assert.equal(/<id>([^<]*)<\/id>/.exec(nuspec)?.[1], NUGET_ID, 'Nuspec id differs');
  assert.equal(/<version>([^<]*)<\/version>/.exec(nuspec)?.[1], nugetVersion(version), 'Nuspec version differs from package.json');
  // Squirrel writes the Installed apps DisplayName from the title and the Publisher from the authors (ET-045h).
  assert.equal(/<title>([^<]*)<\/title>/.exec(nuspec)?.[1], PRODUCT_NAME, 'Nuspec title differs from the product name');
  assert.equal(/<authors>([^<]*)<\/authors>/.exec(nuspec)?.[1], PUBLISHER, 'Nuspec authors differ from the publisher');

  const projection = new Map(), excluded = [];
  for (const relative of listFiles(packageDirectory)) {
    const target = projectPackageFile(relative, executable);
    if (target) projection.set(target, relative);
    else {
      // Squirrel's template drops these files; a native image among them would ship in the portable package only.
      assert.equal(classifyFile(relative, path.join(packageDirectory, relative)), null, `Package native image left out of the NuGet package: ${relative}`);
      excluded.push(relative);
    }
  }
  const stubs = new Set([...projection.keys()].filter(name => /^lib\/net45\/[^/]+\.exe$/i.test(name))
    .map(name => name.replace(/\.exe$/i, '_ExecutionStub.exe')));
  const files = zip.names.filter(name => !name.endsWith('/'));
  const missing = [...projection.keys()].filter(name => !files.includes(name));
  const unexpected = files.filter(name => !projection.has(name) && !knownAddition(name, stubs));
  assert.deepEqual(missing, [], 'Package files missing from the NuGet package');
  assert.deepEqual(unexpected, [], 'Unexpected NuGet package entries');
  for (const name of [`${PAYLOAD}squirrel.exe`, ...stubs]) assert.ok(files.includes(name), `Squirrel addition missing: ${name}`);
  for (const [name, relative] of projection) {
    assert.equal(sha256(zip.extract(name)), hashFile(path.join(packageDirectory, relative)).sha256, `NuGet payload differs from the package: ${relative}`);
  }
  return {facts: {setup, nupkg, releases: RELEASES, projectedFiles: projection.size, excludedPackageFiles: excluded,
    additions: files.filter(name => !projection.has(name)).sort()}, zip};
}

// --- Authenticode --------------------------------------------------------------------------------------------------

/**
 * The fixed Windows PowerShell 5.1 script. It reads base64 UTF-8 paths from standard input, one per line, so a path never
 * becomes script text, and prints one line per file: `<index> <status> <base64 signer subject or -> <thumbprint or -> <0|1
 * timestamped>`. It imports only the built-in Microsoft.PowerShell.Security module, by its full path under $PSHOME.
 */
export const AUTHENTICODE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Import-Module -Name (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1')",
  '$index = 0',
  'foreach ($line in [Console]::In.ReadToEnd().Split([char]10)) {',
  '  $line = $line.Trim()',
  "  if ($line -eq '') { continue }",
  '  $signature = Get-AuthenticodeSignature -LiteralPath ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)))',
  "  $signer = '-'; $thumbprint = '-'",
  '  if ($null -ne $signature.SignerCertificate) {',
  '    $signer = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signature.SignerCertificate.Subject))',
  '    $thumbprint = $signature.SignerCertificate.Thumbprint',
  '  }',
  '  $stamped = [int]($null -ne $signature.TimeStamperCertificate)',
  "  [Console]::Out.Write([string]$index + ' ' + [string]$signature.Status + ' ' + $signer + ' ' + $thumbprint + ' ' + $stamped + [char]10)",
  '  $index++',
  '}'
].join('\n');

/** Parses the script's output for `count` files, strictly: one line per file, in order, with a known status. */
export function parseAuthenticodeOutput(stdout, count) {
  const lines = stdout.split(/\r?\n/).filter(line => line.length);
  assert.equal(lines.length, count, 'Authenticode output has the wrong number of lines');
  return lines.map((line, index) => {
    const match = /^(\d+) ([A-Za-z]+) ([A-Za-z0-9+/]+={0,2}|-) ([0-9A-F]{40}|-) ([01])$/.exec(line);
    assert.ok(match, `Invalid Authenticode output line ${index}`);
    assert.equal(Number(match[1]), index, 'Authenticode output is out of order');
    assert.ok(AUTHENTICODE_STATUSES.includes(match[2]), `Unknown Authenticode status: ${match[2]}`);
    let signer = null;
    if (match[3] !== '-') {
      const bytes = Buffer.from(match[3], 'base64');
      assert.equal(bytes.toString('base64'), match[3], 'Invalid signer encoding');
      signer = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    }
    assert.equal(signer === null, match[4] === '-', 'Signer and thumbprint disagree');
    return {status: match[2], signer, thumbprint: match[4] === '-' ? null : match[4], timestamped: match[5] === '1'};
  });
}

/** Windows PowerShell 5.1 and an environment whose PSModulePath holds only its own module folder (as steam-registry.ts). */
export function windowsPowerShell(env = process.env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  const child = Object.fromEntries(Object.entries(env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'));
  child.PSModulePath = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  return {executable: path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), env: child};
}

/** The Authenticode status and signer of each absolute path, from one bounded Windows PowerShell call. */
export function readAuthenticode(files, env = process.env) {
  if (!files.length) return [];
  const shell = windowsPowerShell(env);
  const result = spawnSync(shell.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', AUTHENTICODE_SCRIPT], {
    input: files.map(file => Buffer.from(file, 'utf8').toString('base64')).join('\n') + '\n', env: shell.env, encoding: 'utf8',
    timeout: SIGNATURE_TIMEOUT_MS, maxBuffer: SIGNATURE_MAX_OUTPUT, windowsHide: true});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Get-AuthenticodeSignature failed: ${String(result.stderr).slice(0, 2000)}`);
  return parseAuthenticodeOutput(result.stdout, files.length);
}

// --- Executable version information (ET-045h) -----------------------------------------------------------------------

/** The version resource fields that name the product, in the order VERSION_INFO_SCRIPT prints them. */
export const VERSION_INFO_FIELDS = ['ProductName', 'FileDescription', 'CompanyName', 'OriginalFilename'];
/**
 * The fixed Windows PowerShell 5.1 script. It reads one base64 UTF-8 path from standard input, so the path never becomes
 * script text, and prints one line per VERSION_INFO_FIELDS entry: `<field> <base64 UTF-8 value or ->`. It reads the
 * resource with [Diagnostics.FileVersionInfo] and never runs the file.
 */
export const VERSION_INFO_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  '$file = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()))',
  '$info = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)',
  `foreach ($field in @(${VERSION_INFO_FIELDS.map(field => `'${field}'`).join(', ')})) {`,
  '  $value = [string]$info.$field',
  "  $encoded = if ($value.Length) { [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value)) } else { '-' }",
  "  [Console]::Out.Write($field + ' ' + $encoded + [char]10)",
  '}'
].join('\n');

/** Parses the script's output strictly: exactly one line per field, in order; an empty value is null. */
export function parseVersionInfoOutput(stdout) {
  const lines = stdout.split(/\r?\n/).filter(line => line.length);
  assert.equal(lines.length, VERSION_INFO_FIELDS.length, 'Version information output has the wrong number of lines');
  const info = {};
  lines.forEach((line, index) => {
    const match = /^([A-Za-z]+) ([A-Za-z0-9+/]+={0,2}|-)$/.exec(line);
    assert.ok(match, `Invalid version information line ${index}`);
    assert.equal(match[1], VERSION_INFO_FIELDS[index], 'Version information output is out of order');
    if (match[2] === '-') {info[match[1]] = null; return;}
    const bytes = Buffer.from(match[2], 'base64');
    assert.equal(bytes.toString('base64'), match[2], 'Invalid version information encoding');
    info[match[1]] = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  });
  return info;
}

/** The version resource of one absolute path, from one bounded Windows PowerShell call. */
export function readVersionInfo(file, env = process.env) {
  const shell = windowsPowerShell(env);
  const result = spawnSync(shell.executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', VERSION_INFO_SCRIPT], {
    input: Buffer.from(file, 'utf8').toString('base64') + '\n', env: shell.env, encoding: 'utf8', timeout: SIGNATURE_TIMEOUT_MS,
    maxBuffer: SIGNATURE_MAX_OUTPUT, windowsHide: true});
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `FileVersionInfo failed: ${String(result.stderr).slice(0, 2000)}`);
  return parseVersionInfoOutput(result.stdout);
}

/**
 * Checks the packaged executable's version resource (`inspect-package`): ProductName and FileDescription are the product
 * name, which Squirrel uses for the shortcut name; CompanyName names the Start menu folder; OriginalFilename keeps the
 * executable's technical name.
 */
export function assertVersionInfo(info, executable = EXECUTABLE) {
  assert.equal(info.ProductName, PRODUCT_NAME, 'Executable ProductName differs from the product name');
  assert.equal(info.FileDescription, PRODUCT_NAME, 'Executable FileDescription differs from the product name');
  assert.equal(info.CompanyName, COMPANY_NAME, 'Executable CompanyName differs');
  assert.equal(info.OriginalFilename, executable, 'Executable OriginalFilename differs');
}

// --- The identity --------------------------------------------------------------------------------------------------

function git(checkout, args) {
  const result = spawnSync('git', ['-C', checkout, ...args], {encoding: 'utf8', timeout: 30000, windowsHide: true});
  return result.status === 0 ? result.stdout.trim() : null;
}
function readJsonFile(filename) {
  return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(readFileSync(filename)));
}
/** Fails with a fixed message naming the first image whose status is in SIGNING_FAILURES, by its location and relative path. */
export function assertSigningStatuses(images) {
  for (const image of images) {
    assert.ok(!SIGNING_FAILURES.includes(image.authenticode.status), `Authenticode ${image.authenticode.status}: ${image.location} ${image.path}`);
  }
}

/**
 * Entries of the application archive that hold native code without being physically unpacked: a `.node`, `.dll` or
 * `.exe` name, or a PE, ELF or Mach-O header under any name. The PE walk sees only the package tree, so code packed
 * inside app.asar would escape it; Windows cannot load such code from the archive either. Returns relative names.
 */
export function packedNativeEntries(archive) {
  const found = [];
  for (const listed of asar.listPackage(archive, {isPack: false})) {
    const name = listed.replaceAll('\\', '/').replace(/^\//, '');
    const entry = asar.statFile(archive, path.normalize(name), false);
    if ('files' in entry || 'link' in entry || entry.unpacked) continue;
    const extension = path.posix.extname(name).toLowerCase();
    const read = bufferReader(entry.size ? asar.extractFile(archive, path.normalize(name), false) : Buffer.alloc(0));
    if (PE_EXTENSIONS.has(extension) || extension === ADDON_EXTENSION || peMachine(read) !== null || foreignFormat(read) !== null) found.push(name);
  }
  return found.sort();
}
/** inspect-package and the identity: no native code may be packed inside app.asar. */
export function assertNoPackedNativeCode(archive) {
  const found = packedNativeEntries(archive);
  assert.deepEqual(found, [], `Native code packed inside app.asar: ${found.join(', ')}`);
}

const signingSummary = images => Object.fromEntries(AUTHENTICODE_STATUSES.map(status => [status, images.filter(image => image.authenticode.status === status).length])
  .filter(([, count]) => count > 0));

/**
 * Builds the release identity. `signatures` maps absolute paths to Authenticode results (readAuthenticode by default);
 * `source` gives the commit facts (git by default). The result holds relative names only.
 */
export function releaseIdentity({checkout = '.', packageDirectory = path.join(checkout, PACKAGE_DIRECTORY), makeDirectory = path.join(checkout, MAKE_DIRECTORY),
  vendorDirectory = path.join(checkout, VENDOR_DIRECTORY), signatures = readAuthenticode, source, now = () => new Date()}) {
  const manifest = readJsonFile(path.join(checkout, 'package.json'));
  const version = manifest.version, electronPin = manifest.devDependencies?.electron;
  assert.ok(typeof version === 'string' && typeof electronPin === 'string', 'package.json lacks the version or the Electron pin');
  const electron = readFileSync(path.join(packageDirectory, 'version'), 'utf8').trim();
  assert.equal(electron, electronPin, 'Packaged Electron differs from the package.json pin');
  const {facts: installer, zip} = checkInstaller({packageDirectory, makeDirectory, version});
  const integrity = verifyPackage(packageDirectory);
  assertNoPackedNativeCode(path.join(packageDirectory, 'resources/app.asar'));

  // The plugin and the broker against their bundle records; the NuGet payload carries the same bytes (inspectInstaller).
  const plugin = verifyPluginBundle(path.join(packageDirectory, 'resources/telemetry-plugin'));
  assert.equal(plugin.appVersion, version, 'Plugin bundle appVersion differs from package.json');
  const brokerFile = path.join(packageDirectory, 'resources/telemetry-client/telemetry-pipe-client.exe');
  const broker = hashFile(brokerFile);
  const brokerEvidence = readJsonFile(path.join(packageDirectory, 'resources/telemetry-client/build-evidence.json'));
  assert.equal(broker.sha256, brokerEvidence.executableSha256, 'Broker hash differs from its build evidence');

  // Every PE image: the package's, Squirrel's additions to the NuGet payload and Setup itself.
  const native = listNativeFiles(packageDirectory);
  const images = native.pe.map(image => ({location: 'package', ...image, file: path.join(packageDirectory, image.path)}));
  const scratch = mkdtempSync(path.join(tmpdir(), 'ets2telemetry-release-identity-'));
  try {
    for (const [index, name] of installer.additions.entries()) {
      const bytes = zip.extract(name), machine = classify(name, bufferReader(bytes))?.pe;
      if (!machine) continue;
      const file = path.join(scratch, `${index}${path.posix.extname(name)}`);
      writeFileSync(file, bytes, {flag: 'wx'});
      images.push({location: 'nupkg', path: name, size: bytes.length, sha256: sha256(bytes), machine, file});
    }
    const setupFile = path.join(makeDirectory, installer.setup), setupMachine = classifyFile(installer.setup, setupFile)?.pe;
    assert.ok(setupMachine, 'Setup must be a PE image');
    images.push({location: 'installer', path: installer.setup, ...hashFile(setupFile), machine: setupMachine, file: setupFile});
    const results = signatures(images.map(image => image.file));
    assert.equal(results.length, images.length, 'Authenticode results do not match the images');
    images.forEach((image, index) => {image.authenticode = results[index]; delete image.file;});
    assertSigningStatuses(images);
  } finally {rmSync(scratch, {recursive: true, force: true});}

  // Squirrel's helpers: Update.exe is the payload's squirrel.exe, copied unchanged from the vendored Squirrel.exe.
  const vendor = Object.fromEntries(['Squirrel.exe', 'Setup.exe', 'StubExecutable.exe'].map(name => [name, hashFile(path.join(vendorDirectory, name)).sha256]));
  const update = images.find(image => image.location === 'nupkg' && image.path === `${PAYLOAD}squirrel.exe`);
  assert.ok(update, 'Update.exe (squirrel.exe) missing from the NuGet package');
  assert.equal(update.sha256, vendor['Squirrel.exe'], 'Update.exe differs from the vendored Squirrel.exe');
  const stubs = images.filter(image => image.location === 'nupkg' && image.path.endsWith('_ExecutionStub.exe')).map(image => ({path: image.path, sha256: image.sha256}));

  const commit = source?.commit ?? git(checkout, ['rev-parse', 'HEAD']);
  const status = source ? null : git(checkout, ['status', '--porcelain', '--untracked-files=no']);
  const treeClean = source ? source.treeClean : status === null ? null : status === '';
  const artifact = name => ({name, ...hashFile(path.join(makeDirectory, name))});
  return {
    format: IDENTITY_FORMAT, version: 1, createdUtc: now().toISOString(),
    source: {commit, sourceCommit: source?.sourceCommit ?? process.env.ETS2TELEMETRY_SOURCE_COMMIT ?? null, treeClean},
    versions: {app: version, nuget: nugetVersion(version), electron, plugin: plugin.appVersion},
    artifacts: {setup: artifact(installer.setup), nupkg: artifact(installer.nupkg), releases: artifact(RELEASES)},
    package: {sha256: integrity.packageSha256, files: integrity.packageFilesVerified, projectedFiles: installer.projectedFiles,
      excludedFromNupkg: installer.excludedPackageFiles, nupkgAdditions: installer.additions},
    plugin: {file: `resources/telemetry-plugin/${PLUGIN_FILE}`, sha256: plugin.sha256, size: plugin.size, appVersion: plugin.appVersion, matchesManifest: true,
      known: plugin.known.length},
    broker: {file: 'resources/telemetry-client/telemetry-pipe-client.exe', sha256: broker.sha256, size: broker.size, matchesBuildEvidence: true},
    squirrel: {updateExe: {path: update.path, sha256: update.sha256, matchesVendor: true}, executionStubs: stubs, vendor},
    signing: {decision: 'unsigned internal alpha (owner decision O1, docs/release.md)', summary: signingSummary(images)},
    peImages: images,
    // Never loaded on Windows and outside Authenticode; listed so that every shipped native binary has a hash.
    foreignNodeAddons: native.foreign
  };
}

// CLI: node scripts/release-identity.mjs — writes out/make/squirrel.windows/x64/release-identity.json.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const checkout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const identity = releaseIdentity({checkout});
  const target = path.join(checkout, MAKE_DIRECTORY, IDENTITY_FILE);
  writeFileSync(target, JSON.stringify(identity, null, 2) + '\n');
  console.log(JSON.stringify({file: `${MAKE_DIRECTORY}/${IDENTITY_FILE}`, source: identity.source, versions: identity.versions,
    setupSha256: identity.artifacts.setup.sha256, nupkgSha256: identity.artifacts.nupkg.sha256, peImages: identity.peImages.length,
    signing: identity.signing.summary}, null, 2));
}
