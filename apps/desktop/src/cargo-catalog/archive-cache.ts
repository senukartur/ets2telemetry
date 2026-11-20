import {lstat, opendir, realpath} from 'node:fs/promises';
import path from 'node:path';
import {waitUnlessAborted} from '../wait-unless-aborted';
import {classifyCargo} from './classify';
import {readOfficialCargoCatalog, type OfficialCargoCatalog} from './official-cargo';

type Inventory = {paths: string[]; fingerprint: string};
const regularArchive = /^(?:def|dlc_[a-z0-9_]+)\.scs$/;
const ARCHIVE_LOAD_TIMEOUT_MS = 18_000;

export async function cargoArchiveInventory(root: string, signal: AbortSignal): Promise<Inventory> {
  signal.throwIfAborted();
  const canonical = await realpath(root);
  if (path.resolve(canonical).toLowerCase() !== path.resolve(root).toLowerCase()) throw new Error('Cargo installation redirected');
  const directory = await lstat(root, {bigint: true});
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Cargo installation unavailable');
  const fingerprints: string[] = [];
  const paths: string[] = [];
  const names: string[] = [];
  let scanned = 0;
  for await (const entry of await opendir(root)) {
    signal.throwIfAborted();
    if (++scanned > 8192) throw new Error('Cargo installation inventory is too large');
    if (regularArchive.test(entry.name) && entry.isFile() && !entry.isSymbolicLink()) names.push(entry.name);
  }
  if (!names.includes('def.scs') || names.length > 256) throw new Error('Cargo archive inventory unavailable');
  for (const name of names.sort()) {
    signal.throwIfAborted();
    const file = path.join(root, name);
    const found = await lstat(file, {bigint: true});
    if (!found.isFile() || found.isSymbolicLink()) throw new Error('Cargo archive was replaced');
    paths.push(file);
    fingerprints.push([name, found.dev, found.ino, found.size, found.mtimeNs, found.ctimeNs].join(':'));
  }
  const end = await lstat(root, {bigint: true});
  if (!end.isDirectory() || end.dev !== directory.dev || end.ino !== directory.ino || end.mtimeNs !== directory.mtimeNs
    || end.ctimeNs !== directory.ctimeNs) throw new Error('Cargo inventory changed during listing');
  return {paths, fingerprint: [directory.dev, directory.ino, ...fingerprints].join('\n')};
}

/** One build per installation at a time. Admit a cache hit only after re-reading the exact file inventory. */
export class CargoArchiveCache {
  private readonly cache = new Map<string, {fingerprint: string; catalog: OfficialCargoCatalog}>();
  private readonly pending = new Map<string, Promise<OfficialCargoCatalog>>();
  constructor(private readonly inventory = cargoArchiveInventory, private readonly read = readOfficialCargoCatalog) {}

  async lookup(root: string, cargoId: string, signal: AbortSignal) {
    signal.throwIfAborted();
    const key = root.toLowerCase();
    let active = this.pending.get(key);
    if (!active) {
      if (this.pending.size >= 2) return null;
      active = this.load(root, key, AbortSignal.timeout(ARCHIVE_LOAD_TIMEOUT_MS)).finally(() => this.pending.delete(key));
      this.pending.set(key, active);
    }
    const catalog = await waitUnlessAborted(active, signal);
    signal.throwIfAborted();
    return classifyCargo(catalog.definitions.get(cargoId));
  }

  private async load(root: string, key: string, signal: AbortSignal) {
    const before = await this.inventory(root, signal);
    signal.throwIfAborted();
    const cached = this.cache.get(key);
    if (cached?.fingerprint === before.fingerprint) return cached.catalog;
    this.cache.delete(key);
    const catalog = await this.read(before.paths, signal);
    const after = await this.inventory(root, signal);
    signal.throwIfAborted();
    if (before.fingerprint !== after.fingerprint) throw new Error('Cargo archives changed during indexing');
    if (this.cache.size >= 2) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {fingerprint: after.fingerprint, catalog});
    return catalog;
  }
}
