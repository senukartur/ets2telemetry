import * as fsp from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// A file-system facade for plugin-setup tests (ET-017 P19). Every path argument, its real location through any
// junction or symbolic link, and every path realpath returns, must lie inside the guard's own mkdtemp root; anything
// else is refused before the real call and recorded, so a test can
// fail even when the code under test swallows the error. It protects real Steam libraries, game folders and
// %LOCALAPPDATA%\ETS2Telemetry from a test that resolves a path it should not.

/** Thrown for a path outside the guard root. Production code may catch it; `violations` still records it. */
export class GuardedFsEscape extends Error {
  constructor(readonly operation: string, readonly target: string) {
    super(`Guarded file system refused ${operation} outside its temporary root: ${target}`);
    this.name = 'GuardedFsEscape';
  }
}

const OPERATIONS = ['lstat', 'stat', 'realpath', 'open', 'readdir', 'mkdir', 'rmdir', 'rm', 'unlink', 'rename', 'readFile', 'writeFile', 'copyFile',
  'symlink', 'access', 'chmod', 'utimes'] as const;
type Operation = typeof OPERATIONS[number];
/** Operations whose first two arguments are both paths. */
const TWO_PATHS: ReadonlySet<Operation> = new Set(['rename', 'copyFile', 'symlink']);
/** Operations that act on a final link itself instead of following it. */
const NOT_FOLLOWING: ReadonlySet<Operation> = new Set(['lstat', 'unlink', 'rmdir', 'rm', 'rename', 'symlink']);
export type GuardedFs = Pick<typeof fsp, Operation>;

export interface GuardedRoot {
  /** The canonical temporary root; every allowed path is inside it. */
  readonly root: string;
  readonly fs: GuardedFs;
  /** Every refused access, in order. Tests assert it stays empty. */
  readonly violations: readonly string[];
  dispose(): Promise<void>;
}

function normal(value: string): string {
  return path.win32.normalize(value).replace(/\\+$/, '').toLowerCase();
}

/** Creates a new temporary root under os.tmpdir() and a facade confined to it. */
export async function guardedTempRoot(prefix = 'ets2telemetry-plugin-test-'): Promise<GuardedRoot> {
  const created = await fsp.mkdtemp(path.join(tmpdir(), prefix));
  // Both spellings: os.tmpdir() can be an 8.3 short path, while realpath returns the long one.
  const roots = [...new Set([normal(created), normal(realpathSync.native(created))])];
  const violations: string[] = [];
  const inside = (value: unknown) => {
    if (typeof value !== 'string') return false;
    if (/^(\\\\|\/\/|\\\?\?\\)/.test(value) || !path.win32.isAbsolute(value) || !/^[A-Za-z]:/.test(value)) return false;
    const candidate = normal(path.win32.resolve(value));
    return roots.some(root => candidate === root || candidate.startsWith(`${root}\\`));
  };
  const refuse = (operation: string, target: unknown): never => {
    const text = typeof target === 'string' ? target : String(target);
    violations.push(`${operation} ${text}`);
    throw new GuardedFsEscape(operation, text);
  };
  // The real location an operation reaches: links in every existing ancestor are resolved, and the final component too
  // when the operation follows it. A component realpath cannot resolve is either missing, and appended as written, or a
  // dangling link, which is resolved through readlink. More than 8 link hops count as outside the root.
  const realLocation = async (target: string, followFinal: boolean, hops = 0): Promise<string> => {
    const resolved = path.win32.resolve(target);
    if (hops > 8) return '\\\\?\\link-hop-limit';
    let probe = followFinal ? resolved : path.win32.dirname(resolved);
    const rest = followFinal ? [] : [path.win32.basename(resolved)];
    while (true) {
      try {return path.win32.join(await fsp.realpath(probe), ...rest);} catch {
        let link: string | undefined;
        try {if ((await fsp.lstat(probe)).isSymbolicLink()) link = await fsp.readlink(probe);} catch {/* missing: keep walking up */}
        if (link !== undefined) {
          // Junction targets may carry the \\?\ or \??\ prefix; a relative symbolic link is relative to its folder.
          const linkTarget = path.win32.resolve(path.win32.dirname(probe), link.replace(/^(\\\\\?\\|\\\?\?\\)/, ''));
          return realLocation(path.win32.join(linkTarget, ...rest), rest.length ? followFinal : true, hops + 1);
        }
        const parent = path.win32.dirname(probe);
        if (parent === probe) return resolved;
        rest.unshift(path.win32.basename(probe));
        probe = parent;
      }
    }
  };
  const check = async (operation: Operation, target: unknown, followFinal: boolean) => {
    if (!inside(target)) refuse(operation, target);
    // A junction inside the root may point outside it; the real location must be inside too.
    if (!inside(await realLocation(target as string, followFinal))) refuse(`${operation}-through-link`, target);
  };
  const guarded = {} as Record<Operation, (...args: unknown[]) => Promise<unknown>>;
  for (const operation of OPERATIONS) {
    const real = fsp[operation] as (...args: unknown[]) => Promise<unknown>;
    guarded[operation] = async (...args: unknown[]) => {
      if (operation === 'symlink') {
        // symlink(target, path): the link target must be inside lexically; creating the link follows nothing.
        if (!inside(args[0])) refuse(operation, args[0]);
        await check(operation, args[1], false);
      } else {
        await check(operation, args[0], !NOT_FOLLOWING.has(operation));
        if (TWO_PATHS.has(operation)) await check(operation, args[1], !NOT_FOLLOWING.has(operation));
      }
      const result = await real(...args);
      if (operation === 'realpath' && typeof result === 'string' && !inside(result)) refuse('realpath-result', result);
      return result;
    };
  }
  return {
    root: path.win32.normalize(realpathSync.native(created)),
    fs: guarded as unknown as GuardedFs,
    violations,
    dispose: () => fsp.rm(created, {recursive: true, force: true})
  };
}
