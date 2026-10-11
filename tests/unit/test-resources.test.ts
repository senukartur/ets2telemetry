import {describe, it, expect} from 'vitest';
import {access, writeFile, readFile} from 'node:fs/promises';
import {temporaryResources, deterministicContext} from '../shared/resources';

describe('isolated regression resources', () => {
  it('parallel owners cannot overwrite each other and cleanup preserves the other owner', async () => {
    const [first, second] = await Promise.all([temporaryResources(), temporaryResources()]);
    try {
      expect(first.directory).not.toBe(second.directory);
      expect(first.pipe).not.toBe(second.pipe);
      expect(first.pipe).toMatch(/^\\\\\.\\pipe\\ets2telemetry-test-/);
      await Promise.all([writeFile(first.database, 'first synthetic fixture'), writeFile(second.database, 'second synthetic fixture')]);
      await first.dispose();
      await expect(access(first.directory)).rejects.toThrow();
      expect(await readFile(second.database, 'utf8')).toBe('second synthetic fixture');
    } finally {await Promise.all([first.dispose(), second.dispose()]);}
  });
  it('fixture clocks and identities are deterministic and isolated', () => {
    const first = deterministicContext(1000);
    const second = deterministicContext(1000);
    expect(first.nextId()).toBe('synthetic-1');
    expect(first.nextId()).toBe('synthetic-2');
    expect(second.nextId()).toBe('synthetic-1');
    first.advance(1000);
    expect(first.now()).toBe(2000);
    expect(second.now()).toBe(1000);
    for (const invalid of [-1, NaN, Infinity]) expect(() => first.advance(invalid)).toThrow(RangeError);
    expect(first.now()).toBe(2000);
  });
});
