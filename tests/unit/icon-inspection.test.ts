import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {expect, it} from 'vitest';
import {Data, NtExecutable, NtExecutableResource, Resource} from 'resedit';
import {verifyExecutableIcon} from '../../scripts/icon-inspection.mjs';

it('checks actual PE icon resources and rejects missing or stale artwork', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'ets2telemetry-icons-'));
  try {
    const executable = path.join(root, 'fixture.exe'), icon = 'apps/desktop/src/assets/icons/brand.ico';
    const exe = NtExecutable.createEmpty(false, false), resources = NtExecutableResource.from(exe);
    writeFileSync(executable, Buffer.from(exe.generate()));
    expect(() => verifyExecutableIcon(executable, icon)).toThrow('does not carry the brand icon');
    const frames = Data.IconFile.from(readFileSync(icon)).icons.map(item => item.data);
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 0, frames);
    resources.outputResource(exe); writeFileSync(executable, Buffer.from(exe.generate()));
    expect(verifyExecutableIcon(executable, icon).sizes).toEqual([16, 20, 24, 32, 48, 64, 128, 256]);
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 0, frames.slice(1));
    resources.outputResource(exe); writeFileSync(executable, Buffer.from(exe.generate()));
    expect(() => verifyExecutableIcon(executable, icon)).toThrow('does not carry the brand icon');
    // A correct secondary icon cannot hide a stale primary shell icon.
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 2, 0, frames);
    resources.outputResource(exe); writeFileSync(executable, Buffer.from(exe.generate()));
    expect(() => verifyExecutableIcon(executable, icon)).toThrow('does not carry the brand icon');
  } finally {rmSync(root, {recursive: true, force: true});}
});
