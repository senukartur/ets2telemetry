import {realpath} from 'node:fs/promises';
import path from 'node:path';
import type {AtomicFileSystem} from './atomic-json-file';
import type {InstallerFileSystem} from './plugin-installer';
import {isDrivePath} from './steam-discovery';
import {CHANNEL} from '../channel';

// The plugin setup mode gate (ET-017 P15; docs/plugin-setup.md, "Mode gate"). A pure decision from the launch
// environment and the packaged flag, evaluated once at startup. It fails closed: every isolated or development launch
// is disabled unless it names a fake test root, so smokes, tests and `npm run dev` never write into a real game folder.

export type PluginSetupDecision =
  | {readonly mode: 'active'}
  /** `root` is the normalized absolute test root; every path setup touches must stay inside it. */
  | {readonly mode: 'test-root'; readonly root: string}
  | {readonly mode: 'disabled'; readonly reason: PluginSetupDisabledReason; readonly rejected?: PluginSetupRootRejection};
/**
 * `off`: ETS2TELEMETRY_PLUGIN_SETUP holds any value other than `real`. `root-rejected`: a test root that is not usable.
 * `isolated-launch`: a profile, diagnostic, live-smoke or source override without a test root. `development`: an
 * unpackaged launch without ETS2TELEMETRY_PLUGIN_SETUP=real.
 */
export type PluginSetupDisabledReason = 'off' | 'root-rejected' | 'isolated-launch' | 'development';
/** Why a test root was rejected (logged as PLUGIN_SETUP_MODE_REJECTED); `no-marker` is found by the setup run. */
export type PluginSetupRootRejection = 'no-profile' | 'relative-profile' | 'relative-root' | 'drive-root' | 'no-marker';

type Environment = Readonly<Record<string, string | undefined>>;
const set = (value: string | undefined): value is string => typeof value === 'string' && value !== '';
/** Variables that mark an isolated launch (P15 row 4). */
const ISOLATED = ['ETS2TELEMETRY_PROFILE_DIR', 'ETS2TELEMETRY_DIAGNOSTIC_DIR', 'ETS2TELEMETRY_LIVE_SMOKE', 'ETS2TELEMETRY_SOURCE_KIND'] as const;

/**
 * The first matching row of P15 wins:
 *
 * | Condition | Mode |
 * | --- | --- |
 * | ETS2TELEMETRY_PLUGIN_SETUP set to any value other than exactly `real` (`off`, `Off`, `false`, `0`, `REAL`, ...) | disabled |
 * | ETS2TELEMETRY_PLUGIN_SETUP_ROOT=<absolute> and an absolute ETS2TELEMETRY_PROFILE_DIR | test-root |
 * | ETS2TELEMETRY_PLUGIN_SETUP_ROOT without a profile directory, or relative | disabled (rejected) |
 * | Any of PROFILE_DIR, DIAGNOSTIC_DIR, LIVE_SMOKE or SOURCE_KIND set, without a root | disabled |
 * | Unpackaged without ETS2TELEMETRY_PLUGIN_SETUP=real | disabled |
 * | Anything else | active |
 *
 * The opt-out fails closed: a misspelled or differently cased value disables setup rather than leaving it active. A
 * test root must be an absolute drive path (no UNC or device path) and not a bare drive such as `C:\`, which would make
 * every folder of that drive "inside" the root; such a root is rejected like a relative one. The setup run also requires
 * the root's marker file (TEST_ROOT_MARKER). An empty variable counts as unset, as for the profile override in main.
 */
export function pluginSetupMode(env: Environment, packaged: boolean): PluginSetupDecision {
  const setup = env.ETS2TELEMETRY_PLUGIN_SETUP;
  if (set(setup) && setup !== 'real') return {mode: 'disabled', reason: 'off'};
  const root = env.ETS2TELEMETRY_PLUGIN_SETUP_ROOT;
  if (set(root)) {
    const profile = env.ETS2TELEMETRY_PROFILE_DIR;
    const rejected: PluginSetupRootRejection | undefined = !isDrivePath(root) ? 'relative-root'
      : /^[A-Za-z]:\\*$/.test(path.win32.normalize(root)) ? 'drive-root'
        : !set(profile) ? 'no-profile'
          : !path.win32.isAbsolute(profile) ? 'relative-profile' : undefined;
    if (rejected) return {mode: 'disabled', reason: 'root-rejected', rejected};
    return {mode: 'test-root', root: path.win32.normalize(root).replace(/\\+$/, '')};
  }
  if (ISOLATED.some(name => set(env[name]))) return {mode: 'disabled', reason: 'isolated-launch'};
  if (!packaged && setup !== 'real') return {mode: 'disabled', reason: 'development'};
  return {mode: 'active'};
}

/**
 * The file a test root must hold, as a regular file that is not a link, before the test-root mode reads or writes
 * anything in it. Only a harness that built the fake root creates it, so a mistyped root (for example a real folder
 * that holds a `Steam` folder) is refused.
 */
export const TEST_ROOT_MARKER = 'ets2telemetry-plugin-test-root.marker';
/** The test-root mode's Steam folder: `<root>\Steam`. Nothing reads the Windows registry or runs PowerShell then. */
export const testRootSteam = (root: string) => path.win32.join(root, 'Steam');
/** The test-root mode's install registry folder, inside the root like every other path it touches. */
export const testRootRegistryDirectory = (root: string) => path.win32.join(root, 'LocalAppData', CHANNEL.dataRootName, 'plugins');

const normal = (value: string) => path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
const within = (candidate: string, roots: readonly string[]) => {
  const value = normal(candidate);
  return roots.some(root => value === root || value.startsWith(`${root}\\`));
};
/** The error a confined operation raises for a path outside the test root: the path looks missing, so it is ignored. */
const escapeError = () => Object.assign(new Error('Path outside the plugin setup test root'), {code: 'ENOENT'});

type Resolve = (target: string) => Promise<string>;
/** The checks every confined operation makes: `check` before the real call, `result` on a path realpath returned. */
function confinement(root: string, escaped: () => void, resolve: Resolve) {
  let roots: Promise<string[]> | undefined;
  const allowed = () => roots ??= resolve(root).then(real => [...new Set([normal(root), normal(real)])], () => [normal(root)]);
  const realLocation = async (target: string, followFinal: boolean): Promise<string> => {
    let probe = followFinal ? target : path.win32.dirname(target);
    const rest = followFinal ? [] : [path.win32.basename(target)];
    while (true) {
      try {return path.win32.join(await resolve(probe), ...rest);} catch {
        const parent = path.win32.dirname(probe);
        if (parent === probe) return target;
        rest.unshift(path.win32.basename(probe));
        probe = parent;
      }
    }
  };
  return {
    check: async (target: unknown, followFinal: boolean): Promise<void> => {
      const inside = await allowed();
      if (typeof target === 'string' && isDrivePath(target) && within(target, inside) && within(await realLocation(path.win32.normalize(target), followFinal), inside)) return;
      escaped();
      throw escapeError();
    },
    result: async (target: string): Promise<string> => {
      if (within(target, await allowed())) return target;
      escaped();
      throw escapeError();
    }
  };
}

/**
 * The test-root confinement (P15): every path an operation names, its real location through any junction or symbolic
 * link in an existing ancestor (and in the final component when the operation follows it), and every path realpath
 * returns must lie inside `root`. Anything else is refused before the real call as a missing path, so discovery and
 * the installer ignore it, and `escaped` is called once per refusal for the PLUGIN_TEST_ROOT_ESCAPE log line. Real
 * locations are resolved with the confinement's own `resolve` (Node's realpath), never through `base`, so probing where a
 * link points is not itself an operation of the confined code.
 */
export function confineToRoot(base: InstallerFileSystem, root: string, escaped: () => void, resolve: Resolve = realpath): InstallerFileSystem {
  const {check, result} = confinement(root, escaped, resolve);
  return {
    lstat: async (target, options) => {await check(target, false); return base.lstat(target, options);},
    stat: async (target, options) => {await check(target, true); return base.stat(target, options);},
    realpath: async target => {await check(target, true); return result(await base.realpath(target));},
    open: async (target, flags) => {await check(target, true); return base.open(target, flags);},
    mkdir: async target => {await check(target, false); return base.mkdir(target);},
    rmdir: async target => {await check(target, false); return base.rmdir(target);},
    readdir: async target => {await check(target, true); return base.readdir(target);},
    rename: async (from, to) => {await check(from, false); await check(to, false); return base.rename(from, to);},
    unlink: async target => {await check(target, false); return base.unlink(target);}
  };
}

/** The same confinement for the install registry's file operations (`setup.json` and its temporary files). */
export function confineAtomicToRoot(base: AtomicFileSystem, root: string, escaped: () => void, resolve: Resolve = realpath): AtomicFileSystem {
  const {check} = confinement(root, escaped, resolve);
  return {
    lstat: async target => {await check(target, false); return base.lstat(target);},
    open: async (target, flags) => {await check(target, true); return base.open(target, flags);},
    mkdir: async (target, options) => {await check(target, false); return base.mkdir(target, options);},
    readdir: async target => {await check(target, true); return base.readdir(target);},
    rename: async (from, to) => {await check(from, false); await check(to, false); return base.rename(from, to);},
    unlink: async target => {await check(target, false); return base.unlink(target);}
  };
}
