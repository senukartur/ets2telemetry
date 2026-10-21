import {readFileSync} from 'node:fs';
import path from 'node:path';
import {expect, it, vi} from 'vitest';
import {applicationIconPath, createTrayIcon} from '../../apps/desktop/src/tray-icon';

const assets = path.resolve('apps/desktop/src/assets/icons');
it('ships the Windows ICO frames as the same PNG assets, including every tray scale', () => {
  const ico = readFileSync(path.join(assets, 'brand.ico'));
  expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]);
  const sizes = [16, 20, 24, 32, 48, 64, 128, 256];
  expect(ico.readUInt16LE(4)).toBe(sizes.length);
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16;
    expect([ico[entry] || 256, ico[entry + 1] || 256, ico.readUInt16LE(entry + 6)]).toEqual([size, size, 32]);
    const png = readFileSync(path.join(assets, `brand-${size}.png`));
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([size, size]);
    const offset = ico.readUInt32LE(entry + 12), length = ico.readUInt32LE(entry + 8);
    expect(ico.subarray(offset, offset + length)).toEqual(png);
  }
});

it.each(['C:\\development', 'C:\\portable\\resources\\app.asar'])('loads all four tray scales from app.getAppPath %s', applicationPath => {
  const images: {filename: string; representations: Electron.AddRepresentationOptions[]}[] = [];
  const api = {createFromPath: vi.fn((filename: string) => {
    const image = {filename, representations: [] as Electron.AddRepresentationOptions[], isEmpty: () => false,
      toPNG: () => Buffer.from(path.basename(filename)), addRepresentation: (options: Electron.AddRepresentationOptions) => image.representations.push(options)};
    images.push(image); return image as unknown as Electron.NativeImage;
  })};
  const image = createTrayIcon(applicationPath, api);
  expect(image).toBe(images[0]);
  expect(images.map(item => item.filename)).toEqual([16, 20, 24, 32].map(size => path.join(applicationPath, `apps/desktop/dist/icons/brand-${size}.png`)));
  expect(images[0].representations).toEqual([1.25, 1.5, 2].map((scaleFactor, index) => ({scaleFactor, buffer: Buffer.from(`brand-${[20, 24, 32][index]}.png`)})));
  expect(applicationIconPath(applicationPath)).toBe(path.join(applicationPath, 'apps/desktop/dist/icons/brand.ico'));
});
it('refuses an empty decoded tray image so main can apply its existing unavailable-tray fallback', () => {
  const api = {createFromPath: () => ({isEmpty: () => true}) as Electron.NativeImage};
  expect(() => createTrayIcon('C:\\missing', api)).toThrow('Application tray icon is unavailable');
});
