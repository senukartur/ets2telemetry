import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';

// The fingerprint covers the EXE, DLLs, resources and unpacked application bytes.
export function verifyPackage(directory) {
  const files = [];
  let treeEntries = 0;
  function walk(relative = '', depth = 0) {
    assert.ok(depth <= 64 && (!relative || ++treeEntries <= 100000), 'Package tree bounds exceeded');
    const absolute = path.join(directory, relative);
    const item = lstatSync(absolute);
    assert.ok(!item.isSymbolicLink(), 'Package links are not allowed');
    if (item.isDirectory()) for (const name of readdirSync(absolute)) walk(relative ? `${relative}/${name}` : name, depth + 1);
    else {assert.ok(item.isFile(), 'Package entry must be a regular file'); files.push(relative);}
  }
  walk();
  const archive = path.join(directory, 'resources/app.asar');
  const fd = openSync(archive, 'r');
  let header;
  try {
    const prefix = Buffer.alloc(8);
    assert.equal(readSync(fd, prefix, 0, 8, 0), 8, 'Truncated ASAR header');
    assert.equal(prefix.readUInt32LE(0), 4, 'Invalid ASAR size pickle');
    const headerSize = prefix.readUInt32LE(4);
    assert.ok(headerSize >= 8 && headerSize <= 16 * 1024 * 1024 && headerSize <= fstatSync(fd).size - 8, 'ASAR header exceeds verification bounds');
    const bytes = Buffer.alloc(headerSize);
    assert.equal(readSync(fd, bytes, 0, headerSize, 8), headerSize, 'Truncated ASAR header');
    const payloadSize = bytes.readUInt32LE(0);
    const jsonSize = bytes.readUInt32LE(4);
    assert.ok(payloadSize === headerSize - 4 && jsonSize <= payloadSize - 4 && headerSize === 8 + Math.ceil(jsonSize / 4) * 4, 'Invalid ASAR header pickle');
    header = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(8, 8 + jsonSize)));
  } finally {closeSync(fd);}
  const expected = new Set();
  let headerEntries = 0;
  function readHeader(entry, relative = '', depth = 0) {
    assert.ok(depth <= 64 && ++headerEntries <= 100000, 'ASAR entry bounds exceeded');
    assert.ok(entry && typeof entry === 'object' && !Array.isArray(entry), 'Invalid ASAR entry');
    assert.ok(!('link' in entry), 'ASAR links are not allowed');
    if ('files' in entry) {
      assert.ok(entry.files && typeof entry.files === 'object' && !Array.isArray(entry.files), 'Invalid ASAR directory');
      for (const [name, child] of Object.entries(entry.files)) {
        // eslint-disable-next-line no-control-regex -- control characters are invalid in Windows path segments.
        assert.ok(name && name !== '.' && name !== '..' && !/[<>:"/\\|?*\x00-\x1f]/.test(name), 'Invalid ASAR path segment');
        readHeader(child, relative ? `${relative}/${name}` : name, depth + 1);
      }
    } else if (entry.unpacked === true) {
      assert.equal(entry.integrity?.algorithm, 'SHA256', `Missing unpacked integrity: ${relative}`);
      assert.match(entry.integrity.hash, /^[a-f0-9]{64}$/i);
      const bytes = readFileSync(path.join(`${archive}.unpacked`, relative));
      assert.equal(bytes.length, entry.size, `Unpacked size mismatch: ${relative}`);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.integrity.hash.toLowerCase(), `Unpacked integrity mismatch: ${relative}`);
      expected.add(`resources/app.asar.unpacked/${relative}`);
    }
  }
  readHeader(header);
  assert.ok(expected.size > 0, 'No unpacked entries found');
  for (const filename of files) if (filename.startsWith('resources/app.asar.unpacked/')) assert.ok(expected.has(filename), `Unexpected unpacked file: ${filename}`);
  const digest = createHash('sha256');
  for (const filename of files.sort()) {
    const hash = createHash('sha256').update(readFileSync(path.join(directory, filename))).digest('hex');
    digest.update(`${filename}\0${hash}\n`, 'utf8');
  }
  return {packageSha256: digest.digest('hex'), unpackedFilesVerified: expected.size, packageFilesVerified: files.length};
}
