import * as fsp from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';

// A file-system facade for plugin-setup tests (ET-017 P19). Every path argument, and every path realpath returns, must
// lie inside the guard's own mkdtemp root; anything else is refused before the real call and recorded, so a test can
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
  const guarded = {} as Record<Operation, (...args: unknown[]) => Promise<unknown>>;
  for (const operation of OPERATIONS) {
    const real = fsp[operation] as (...args: unknown[]) => Promise<unknown>;
    guarded[operation] = async (...args: unknown[]) => {
      if (!inside(args[0])) refuse(operation, args[0]);
      // For symlink the first path is the link target, which must be absolute here as well.
      if (TWO_PATHS.has(operation) && !inside(args[1])) refuse(operation, args[1]);
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
