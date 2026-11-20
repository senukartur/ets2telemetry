import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {inflateSync} from 'node:zlib';
import {describe, expect, it} from 'vitest';
import {readOfficialCargoCatalog} from '../../apps/desktop/src/cargo-catalog/official-cargo';

// Synthetic HashFS v2 fixtures produced with SCS Game Archive Packer 1.55.
// def.scs uses the default compression and the DLC fixtures use -nocompress.
const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/cargo-catalog/${name}`, import.meta.url));
const base = fixture('def.scs');
const addon = fixture('dlc_fixture.scs');

describe('official cargo catalog (REG-009)', () => {
  it('reads base and DLC registries, follows their includes and looks up exact SDK cargo IDs', async () => {
    const {definitions, conflicts} = await readOfficialCargoCatalog([base, addon]);
    expect([...definitions.keys()].sort()).toEqual([
      'synthetic_heavy', 'synthetic_official_extra', 'synthetic_plain', 'synthetic_same', 'synthetic_sensitive',
    ]);
    expect(conflicts).toEqual(new Set(['synthetic_conflict']));
    // The Packer fixtures put a line comment against the valuable flag's
    // value and a block comment against the heavy cargo's fragility value.
    expect(definitions.get('synthetic_sensitive')).toEqual({
      fragility: 0.75,
      valuable: true,
      adrClass: 8,
      overweight: false,
      oversize: false,
      groups: ['construction', 'fragile'],
    });
    expect(definitions.get('synthetic_heavy')).toEqual({
      fragility: 0.75, valuable: false, adrClass: null, overweight: true, oversize: true, groups: ['gooseneck'],
    });
    expect(definitions.get('synthetic_official_extra')?.groups).toEqual(['inloader']);
    expect(definitions.get('synthetic_plain')).toEqual({
      fragility: null, valuable: false, adrClass: null, overweight: false, oversize: false, groups: [],
    });
    expect(definitions.get('cargo.synthetic_sensitive')).toBeUndefined();
    expect(definitions.get('Synthetic_sensitive')).toBeUndefined();
  });

  it('keeps a conflict unknown regardless of archive order and coalesces equivalent definitions', async () => {
    const {definitions, conflicts} = await readOfficialCargoCatalog([addon, base]);
    expect(definitions.get('synthetic_conflict')).toBeUndefined();
    expect(conflicts.has('synthetic_conflict')).toBe(true);
    expect(definitions.get('synthetic_same')?.groups).toEqual(['bulk', 'machinery']);
  });

  it('rejects include traversal and cycles instead of classifying a partial corpus', async () => {
    for (const filename of ['dlc_escape.scs', 'dlc_cycle.scs']) {
      await expect(readOfficialCargoCatalog([base, fixture(filename)])).rejects.toThrow('official cargo definitions');
    }
  });

  it('rejects invalid inventory paths and respects pre-aborted reads', async () => {
    for (const sources of [[addon], [base, base], [base, fixture('mod_custom.scs')], ['def.scs']]) {
      await expect(readOfficialCargoCatalog(sources)).rejects.toThrow('official cargo definitions');
    }
    const controller = new AbortController();
    controller.abort();
    await expect(readOfficialCargoCatalog([base], controller.signal)).rejects.toMatchObject({name: 'AbortError'});
  });

  it('rejects invalid versions, oversized indexes and truncated metadata', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'et-cargo-catalog-'));
    try {
      const archive = join(directory, 'def.scs');
      const original = await readFile(base);
      const invalidVersion = Buffer.from(original);
      invalidVersion.writeUInt16LE(1, 4);
      const oversizedIndex = Buffer.from(original);
      oversizedIndex.writeUInt32LE(0xffffffff, 12);
      for (const data of [invalidVersion, oversizedIndex, original.subarray(0, original.length - 8)]) {
        await writeFile(archive, data);
        await expect(readOfficialCargoCatalog([archive])).rejects.toThrow('cargo archive');
      }
    } finally {
      await rm(directory, {recursive: true});
    }
  });

  it('reads a stored index and refuses an unordered table', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'et-cargo-catalog-'));
    try {
      const archive = join(directory, 'def.scs');
      const original = await readFile(base);
      const entryOffset = Number(original.readBigUInt64LE(28));
      const entryStored = original.readUInt32LE(16);
      const plain = inflateSync(original.subarray(entryOffset, entryOffset + entryStored));
      original.writeUInt32LE(plain.length, 16);
      original.writeBigUInt64LE(BigInt(original.length), 28);
      await writeFile(archive, Buffer.concat([original, plain]));
      expect((await readOfficialCargoCatalog([archive])).definitions.has('synthetic_sensitive')).toBe(true);

      const firstEntry = Buffer.from(plain.subarray(0, 16));
      plain.copyWithin(0, 16, 32);
      firstEntry.copy(plain, 16);
      await writeFile(archive, Buffer.concat([original, plain]));
      await expect(readOfficialCargoCatalog([archive])).rejects.toThrow('cargo archive');
    } finally {
      await rm(directory, {recursive: true});
    }
  });
});
