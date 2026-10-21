import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {sha256} from './source-inputs.mjs';

// Use Packager's already locked resource reader, the same one that embeds the application icon.
const packagerRequire = createRequire(import.meta.resolve('@electron/packager'));
const {Data, NtExecutable, NtExecutableResource, Resource} = await import(pathToFileURL(packagerRequire.resolve('resedit')).href);
export function verifyExecutableIcon(executable, icon) {
  const expected = Data.IconFile.from(readFileSync(icon)).icons.map(item => item.data);
  assert.ok(expected.length > 0 && expected.every(item => item.isRaw()), 'Brand ICO must contain PNG frames');
  const resources = NtExecutableResource.from(NtExecutable.from(readFileSync(executable), {ignoreCert: true}));
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
  // Setup may also contain Squirrel's other icon groups; the primary application group must match.
  const matches = groups.filter(group => {
    const actual = group.getIconItemsFromEntries(resources.entries);
    return actual.length === expected.length && actual.every((item, index) => item.isRaw()
      && (item.width || 256) === (expected[index].width || 256) && (item.height || 256) === (expected[index].height || 256)
      && sha256(Buffer.from(item.bin)) === sha256(Buffer.from(expected[index].bin)));
  });
  assert.ok(matches.includes(groups[0]), `Executable does not carry the brand icon: ${executable}`);
  return {sha256: sha256(readFileSync(icon)), sizes: expected.map(item => item.width || 256)};
}
