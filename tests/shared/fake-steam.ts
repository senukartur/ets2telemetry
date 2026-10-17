import {mkdir, writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Builds fake Steam installations and game folders for plugin-setup tests (ET-017 P19). Every path it creates must lie
// inside os.tmpdir() and must not be, or be inside, a real Steam location; the builder refuses anything else before it
// writes. Nothing here reads the registry.

export type FakeGame = 'ets2' | 'ats';
const APP: Record<FakeGame, {id: string; folder: string; executable: string}> = {
  ets2: {id: '227300', folder: 'Euro Truck Simulator 2', executable: 'eurotrucks2.exe'},
  ats: {id: '270880', folder: 'American Truck Simulator', executable: 'amtrucks.exe'}
};

const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
const isInside = (child: string, parent: string) => normal(child) === normal(parent) || normal(child).startsWith(`${normal(parent)}\\`);

/** Real Steam locations a fake root must never be inside: the default install folders. */
function realSteamFolders(): string[] {
  const folders: string[] = [];
  for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.ProgramW6432, 'C:\\Program Files (x86)', 'C:\\Program Files']) {
    if (base) folders.push(path.win32.join(base, 'Steam'));
  }
  return folders;
}

/** Throws unless `target` is strictly inside os.tmpdir() and outside every default Steam install folder. */
export function assertFakePath(target: string): void {
  const temporary = [tmpdir(), realpathSync.native(tmpdir())];
  if (!path.win32.isAbsolute(target) || !temporary.some(folder => isInside(target, folder) && normal(target) !== normal(folder))) {
    throw new Error(`Fake Steam path is not inside the temporary folder: ${target}`);
  }
  if (realSteamFolders().some(folder => isInside(target, folder))) throw new Error(`Fake Steam path is a real Steam path: ${target}`);
}

/** A KeyValues string with `\` and `"` escaped as Steam writes them. */
export const vdfString = (value: string) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export interface FakeGameOptions {
  /** The installdir written into the manifest; defaults to the game's Steam folder name. */
  installdir?: string;
  /** Creates the folder layout (bin\win_x64\<exe>); false leaves only a manifest, as after an uninstall. */
  layout?: boolean;
  /** Creates bin\win_x64\plugins. */
  plugins?: boolean;
  /** Overrides the manifest text completely. */
  manifest?: string;
}

export interface FakeSteam {
  readonly base: string;
  readonly steam: string;
  /** Creates an empty library folder `<base>\<name>` with steamapps\common and returns its path. */
  library(name: string): Promise<string>;
  /** Writes libraryfolders.vdf listing `paths`, in the current or legacy format, under steamapps or config. */
  libraryFolders(paths: readonly string[], options?: {format?: 'current' | 'legacy'; location?: 'steamapps' | 'config'}): Promise<void>;
  /** Writes libraryfolders.vdf with exactly these bytes. */
  rawLibraryFolders(content: string | Uint8Array, location?: 'steamapps' | 'config'): Promise<void>;
  /** Writes an appmanifest and, by default, the game folder; returns the game root. */
  install(library: string, game: FakeGame, options?: FakeGameOptions): Promise<string>;
  /** Creates a game folder layout at an arbitrary root inside the base (a manually installed copy). */
  gameFolder(root: string, game: FakeGame, options?: {plugins?: boolean}): Promise<string>;
}

/** Creates `<base>\Steam\steamapps` and returns a builder confined to `base`. */
export async function fakeSteam(base: string): Promise<FakeSteam> {
  assertFakePath(base);
  const steam = path.win32.join(base, 'Steam');
  const confined = (target: string) => {
    if (!isInside(target, base)) throw new Error(`Fake Steam write outside its base: ${target}`);
    assertFakePath(target);
    return target;
  };
  const write = async (target: string, content: string | Uint8Array) => {
    await mkdir(path.win32.dirname(confined(target)), {recursive: true});
    await writeFile(target, content);
  };
  await mkdir(confined(path.win32.join(steam, 'steamapps', 'common')), {recursive: true});
  const gameFolder = async (root: string, game: FakeGame, options: {plugins?: boolean} = {}) => {
    const win64 = path.win32.join(confined(root), 'bin', 'win_x64');
    await write(path.win32.join(win64, APP[game].executable), 'fake executable');
    if (options.plugins) await mkdir(path.win32.join(win64, 'plugins'), {recursive: true});
    return root;
  };
  return {
    base, steam,
    async library(name) {
      const library = path.win32.join(base, name);
      await mkdir(confined(path.win32.join(library, 'steamapps', 'common')), {recursive: true});
      return library;
    },
    async libraryFolders(paths, options = {}) {
      const body = paths.map((library, index) => options.format === 'legacy'
        ? `\t${vdfString(String(index + 1))}\t\t${vdfString(library)}\n`
        : `\t${vdfString(String(index))}\n\t{\n\t\t"path"\t\t${vdfString(library)}\n\t\t"label"\t\t""\n\t\t"apps"\n\t\t{\n\t\t}\n\t}\n`).join('');
      const legacyHeader = options.format === 'legacy' ? '\t"TimeNextStatsReport"\t\t"1700000000"\n\t"ContentStatsID"\t\t"-1"\n' : '';
      await write(path.win32.join(steam, options.location ?? 'steamapps', 'libraryfolders.vdf'),
        `"${options.format === 'legacy' ? 'LibraryFolders' : 'libraryfolders'}"\n{\n${legacyHeader}${body}}\n`);
    },
    async rawLibraryFolders(content, location = 'steamapps') {
      await write(path.win32.join(steam, location, 'libraryfolders.vdf'), content);
    },
    async install(library, game, options = {}) {
      const installdir = options.installdir ?? APP[game].folder;
      const manifest = options.manifest ?? `"AppState"\n{\n\t"appid"\t\t"${APP[game].id}"\n\t"Universe"\t\t"1"\n\t"name"\t\t${vdfString(APP[game].folder)}\n\t"StateFlags"\t\t"4"\n\t"installdir"\t\t${vdfString(installdir)}\n}\n`;
      await write(path.win32.join(library, 'steamapps', `appmanifest_${APP[game].id}.acf`), manifest);
      const root = path.win32.join(library, 'steamapps', 'common', APP[game].folder);
      if (options.layout !== false) await gameFolder(root, game, {plugins: options.plugins});
      return root;
    },
    gameFolder
  };
}
