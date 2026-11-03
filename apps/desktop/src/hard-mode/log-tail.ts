import {open, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import type {BoundProfile} from './reader';

/** Ordered log markers; an unfinished selection never retains an earlier loaded save. */
export class ProfileLogParser {
  private selected: string | null = null;
  private loaded: BoundProfile | null = null;
  private generation = 0;
  private pending = Buffer.alloc(0);
  header = '';
  push(bytes: Buffer): void {
    const input = Buffer.concat([this.pending, bytes]);
    let start = 0, end: number;
    while ((end = input.indexOf(10, start)) >= 0) {
      this.line(input.subarray(start, end)); start = end + 1;
    }
    this.pending = Buffer.from(input.subarray(start));
    if (this.pending.length > 8192) throw new Error('Unbounded log line');
  }
  private line(bytes: Buffer): void {
    if (bytes.length > 8192) throw new Error('Unbounded log line');
    const line = new TextDecoder('utf-8', {fatal: true}).decode(bytes).replace(/\r$/, '');
    if (this.header.length < 8192) this.header = (this.header + line + '\n').slice(0, 8192);
    if (line.includes('Set profile finished:')) {this.selected = null; this.loaded = null; this.generation++;}
    const selection = /New profile selected:\s*(.*?)\s*$/.exec(line);
    if (selection) {
      let name = selection[1];
      if (name.startsWith("'") && name.endsWith("'") || name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
      this.selected = name.length > 0 && name.length <= 128 ? Buffer.from(name, 'utf8').toString('hex').toUpperCase() : null;
      this.loaded = null; this.generation++;
    }
    if (line.includes('Loading save.')) {
      this.generation++;
      const save = /\/(home|steam)\/profiles\/([0-9a-f]+)\/save\//i.exec(line);
      this.loaded = save && this.selected && save[2].toUpperCase() === this.selected
        ? {profile: this.selected, storage: save[1].toLowerCase() === 'home' ? 'local' : 'cloud', generation: this.generation} : null;
    }
  }
  value(): BoundProfile | null {
    if (/(?:New profile selected:|Set profile finished:|Loading save\.)/.test(this.pending.toString('utf8'))) return null;
    return this.loaded && {...this.loaded};
  }
}

/** A bounded positioned tail. Ordinary appends never reread a verified prefix. */
export class ProfileLogTail {
  private identity: string | undefined;
  private offset = 0;
  private modified: bigint | undefined;
  private parser = new ProfileLogParser();
  constructor(private readonly observeRead: (offset: number, bytes: number) => void = () => undefined) {}
  async read(filename: string, signal: AbortSignal): Promise<{identity: string; text: string; profile: BoundProfile | null}> {
    signal.throwIfAborted();
    if (path.resolve(await realpath(filename)).toLowerCase() !== path.resolve(filename).toLowerCase()) throw new Error('Redirected file');
    const file = await open(filename, 'r');
    try {
      const before = await file.stat({bigint: true}), identity = `${before.dev}:${before.ino}:${before.birthtimeNs}`;
      if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unbounded log');
      if (this.identity !== undefined && (identity !== this.identity || before.size < BigInt(this.offset)
        || before.size === BigInt(this.offset) && before.mtimeNs !== this.modified)) {
        this.identity = undefined; this.offset = 0; this.modified = undefined; this.parser = new ProfileLogParser();
        throw new Error('Log replaced or truncated');
      }
      if (before.size - BigInt(this.offset) > 4n * 1024n * 1024n) throw new Error('Unbounded log catch-up');
      this.identity = identity;
      const end = Number(before.size), buffer = Buffer.alloc(64 * 1024);
      while (this.offset < end) {
        signal.throwIfAborted();
        const {bytesRead} = await file.read(buffer, 0, Math.min(buffer.length, end - this.offset), this.offset);
        this.observeRead(this.offset, bytesRead);
        if (!bytesRead) throw new Error('Log truncated during read');
        this.parser.push(buffer.subarray(0, bytesRead)); this.offset += bytesRead;
      }
      const after = await file.stat({bigint: true}), current = await stat(filename, {bigint: true});
      if (after.ino !== current.ino || after.dev !== current.dev || after.birthtimeNs !== current.birthtimeNs
        || after.size < before.size || current.size < before.size || after.size === before.size && after.mtimeNs !== before.mtimeNs) throw new Error('Log changed during read');
      this.modified = before.mtimeNs; signal.throwIfAborted();
      return {identity, text: this.parser.header, profile: this.parser.value()};
    } finally {await file.close();}
  }
}
