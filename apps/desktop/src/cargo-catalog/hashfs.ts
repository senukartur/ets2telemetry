import {lstat, open, type FileHandle} from 'node:fs/promises';
import {setImmediate} from 'node:timers/promises';
import {promisify, TextDecoder} from 'node:util';
import {inflate} from 'node:zlib';
import {hashArchivePath} from './city-hash';

// Only the HashFS v2 metadata and regular text/directory payloads are needed.
// https://github.com/Wilps93/scs_tools/blob/main/FORMAT.md
const HEADER_SIZE = 52;
const ENTRY_SIZE = 16;
const WORD_SIZE = 4;
const MAX_ENTRY_TABLE = 16 * 1024 * 1024;
const MAX_METADATA_TABLE = 32 * 1024 * 1024;
const MAX_PAYLOAD = 1024 * 1024;
const MAX_DIRECTORY_NAMES = 16_384;
const ENTRY_CHECK_BATCH = 16_384;
const decompress = promisify(inflate);
const decoder = new TextDecoder('utf-8', {fatal: true});

function invalid(): never {
  throw new Error('Invalid or unsupported cargo archive');
}

function rangeWithin(offset: number, length: number, limit: number) {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= limit - length;
}

async function read(file: FileHandle, offset: number, length: number, limit: number, signal?: AbortSignal) {
  if (!rangeWithin(offset, length, limit)) invalid();
  const bytes = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    signal?.throwIfAborted();
    const {bytesRead} = await file.read(bytes, filled, length - filled, offset + filled);
    if (!bytesRead) invalid();
    filled += bytesRead;
  }
  return bytes;
}

async function inflateExact(bytes: Buffer, size: number) {
  const result = await decompress(bytes, {maxOutputLength: Math.max(1, size)});
  if (result.length !== size) invalid();
  return result;
}

type DirectoryItem = {name: string; directory: boolean};

function directoryItems(payload: Buffer): DirectoryItem[] {
  if (payload.length < 4) invalid();
  const count = payload.readUInt32LE();
  if (count > MAX_DIRECTORY_NAMES || !rangeWithin(4, count, payload.length)) invalid();
  let offset = 4 + count;
  const items = new Map<string, DirectoryItem>();
  for (let i = 0; i < count; i++) {
    const size = payload[4 + i];
    if (!size || !rangeWithin(offset, size, payload.length)) invalid();
    const raw = decoder.decode(payload.subarray(offset, offset + size));
    const directory = raw.startsWith('/');
    const name = directory ? raw.slice(1) : raw;
    if (!name || name === '.' || name === '..' || /[/\\:\p{Cc}]/u.test(name) || items.has(name)) invalid();
    items.set(name, {name, directory});
    offset += size;
  }
  if (offset !== payload.length) invalid();
  return [...items.values()];
}

class HashFs {
  constructor(
    private readonly file: FileHandle,
    private readonly entries: Buffer,
    private readonly metadata: Buffer,
    private readonly dataEnd: number,
    private readonly signal?: AbortSignal,
  ) {}

  private find(path: string) {
    const hash = hashArchivePath(path);
    let low = 0, high = this.entries.length / ENTRY_SIZE;
    while (low < high) {
      const middle = (low + high) >>> 1, offset = middle * ENTRY_SIZE;
      const current = this.entries.readBigUInt64LE(offset);
      if (current === hash) return offset;
      if (current < hash) low = middle + 1;
      else high = middle;
    }
    return undefined;
  }

  private async payload(path: string, directory: boolean) {
    this.signal?.throwIfAborted();
    const entry = this.find(path);
    if (entry === undefined) return undefined;
    const flags = this.entries.readUInt16LE(entry + 14);
    const descriptor = this.entries.readUInt32LE(entry + 8) * WORD_SIZE;
    if (Boolean(flags & 1) !== directory || this.entries.readUInt16LE(entry + 12) !== 1
      || !rangeWithin(descriptor, WORD_SIZE, this.metadata.length)) invalid();
    const part = this.metadata.readUInt32LE(descriptor);
    const header = (part & 0xffffff) * WORD_SIZE;
    if (!(part >>> 31) || !rangeWithin(header, 16, this.metadata.length)) invalid();
    const storedSize = this.metadata.readUIntLE(header, 3);
    const plainSize = this.metadata.readUIntLE(header + 4, 3);
    const codec = this.metadata[header + 3] & 0xf0;
    const offset = this.metadata.readUInt32LE(header + 12) * 16;
    if (storedSize > MAX_PAYLOAD || plainSize > MAX_PAYLOAD || (storedSize > 0 && offset < HEADER_SIZE)) invalid();
    if (codec !== 0 && codec !== 0x10) invalid();
    const bytes = await read(this.file, offset, storedSize, this.dataEnd, this.signal);
    if (codec === 0x10) return inflateExact(bytes, plainSize);
    if (bytes.length !== plainSize) invalid();
    return bytes;
  }

  async list(path: string) {
    const bytes = await this.payload(path, true);
    return bytes === undefined ? undefined : directoryItems(bytes);
  }

  async text(path: string) {
    const bytes = await this.payload(path, false);
    return bytes === undefined ? undefined : decoder.decode(bytes);
  }
}

function sameFile(before: Awaited<ReturnType<FileHandle['stat']>>, after: Awaited<ReturnType<FileHandle['stat']>>) {
  return before.dev === after.dev && before.ino === after.ino && before.size === after.size
    && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
}

async function readIndex(file: FileHandle, offset: number, stored: number, inflated: number, fileSize: number, signal?: AbortSignal) {
  const bytes = await read(file, offset, stored, fileSize, signal);
  return stored === inflated ? bytes : inflateExact(bytes, inflated);
}

async function verifyOrder(entries: Buffer, signal?: AbortSignal) {
  let previous = -1n;
  for (let start = 0; start < entries.length; start += ENTRY_CHECK_BATCH * ENTRY_SIZE) {
    if (start > 0) await setImmediate();
    signal?.throwIfAborted();
    const end = Math.min(entries.length, start + ENTRY_CHECK_BATCH * ENTRY_SIZE);
    for (let offset = start; offset < end; offset += ENTRY_SIZE) {
      const hash = entries.readBigUInt64LE(offset);
      if (hash <= previous) invalid();
      previous = hash;
    }
  }
}

export async function withHashFs<T>(path: string, use: (archive: HashFs) => Promise<T>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const listed = await lstat(path);
  if (!listed.isFile()) invalid();
  const file = await open(path, 'r');
  try {
    const source = await file.stat();
    if (!source.isFile() || !sameFile(listed, source)) invalid();
    const header = await read(file, 0, HEADER_SIZE, source.size, signal);
    if (header.toString('ascii', 0, 4) !== 'SCS#' || header.readUInt16LE(4) !== 2
      || header.readUInt16LE(6) !== 0 || header.toString('ascii', 8, 12) !== 'CITY') invalid();
    const entrySize = header.readUInt32LE(12) * ENTRY_SIZE;
    const entryStored = header.readUInt32LE(16);
    const metadataSize = header.readUInt32LE(20) * WORD_SIZE;
    const metadataStored = header.readUInt32LE(24);
    const entryOffset = Number(header.readBigUInt64LE(28));
    const metadataOffset = Number(header.readBigUInt64LE(36));
    const dataEnd = Math.min(entryOffset, metadataOffset);
    if (entrySize > MAX_ENTRY_TABLE || entryStored > MAX_ENTRY_TABLE || metadataSize > MAX_METADATA_TABLE
      || metadataStored > MAX_METADATA_TABLE || dataEnd < HEADER_SIZE
      || (entryOffset < metadataOffset ? entryOffset + entryStored > metadataOffset : metadataOffset + metadataStored > entryOffset)) invalid();
    const entries = await readIndex(file, entryOffset, entryStored, entrySize, source.size, signal);
    await verifyOrder(entries, signal);
    const metadata = await readIndex(file, metadataOffset, metadataStored, metadataSize, source.size, signal);
    const result = await use(new HashFs(file, entries, metadata, dataEnd, signal));
    signal?.throwIfAborted();
    if (!sameFile(source, await file.stat()) || !sameFile(source, await lstat(path))) invalid();
    return result;
  } finally {
    await file.close();
  }
}
