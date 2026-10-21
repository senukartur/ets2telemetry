import path from 'node:path';
import type {nativeImage} from 'electron';

/** Windows selects a 16 DIP bitmap at the display's scale. */
export const TRAY_ICON_REPRESENTATIONS = Object.freeze([
  {size: 16, scaleFactor: 1}, {size: 20, scaleFactor: 1.25}, {size: 24, scaleFactor: 1.5}, {size: 32, scaleFactor: 2}
] as const);

/** Use app.getAppPath(): packaged main.cjs is physically under app.asar.unpacked. */
export const brandIconDirectory = (applicationPath: string): string => path.join(applicationPath, 'apps/desktop/dist/icons');
export const applicationIconPath = (applicationPath: string): string => path.join(brandIconDirectory(applicationPath), 'brand.ico');

export function createTrayIcon(applicationPath: string, images: Pick<typeof nativeImage, 'createFromPath'>): Electron.NativeImage {
  const directory = brandIconDirectory(applicationPath);
  const load = (size: number) => {
    const image = images.createFromPath(path.join(directory, `brand-${size}.png`));
    if (image.isEmpty()) throw new Error('Application tray icon is unavailable');
    return image;
  };
  const [first, ...rest] = TRAY_ICON_REPRESENTATIONS;
  const image = load(first.size);
  for (const {size, scaleFactor} of rest) image.addRepresentation({scaleFactor, buffer: load(size).toPNG()});
  return image;
}
