import type {GuardedRoot} from './guarded-fs';

// Load-sensitive file work in unit tests (TESTING.md section 6; ET-019, docs/validation/et-019.md).

/**
 * The per-operation allowance of a named file-work budget: the 67 ms upper end of the October 18, 2026 probe of single
 * fs.promises operations on a loaded host (ET-019, load-sensitive unit tests; under 0.5 ms idle), used as an average
 * across a case's counted operations. It does not bound one call: single requests of 365 to 1,798 ms were observed on
 * October 28, 2026, and the aggregate absorbs them.
 */
export const FS_OPERATION_ALLOWANCE_MS = 67;

/**
 * A case budget for `operations` counted file requests (libuv promise and callback requests and handle closes, rounded
 * up) at FS_OPERATION_ALLOWANCE_MS each. It bounds irreducible file work, not behaviour timing: a case that takes it asserts
 * no timing and waits on no real timer.
 */
export const fileWorkBudget = (operations: number): number => operations * FS_OPERATION_ALLOWANCE_MS;

/**
 * `open` with the flush to disk of every file it opens skipped: the handle's `sync` resolves at once, and every other
 * property and call of the handle is unchanged. On Windows `FileHandle.sync()` is FlushFileBuffers, which waits for the
 * disk itself and so for other processes' unwritten data: single syncs took 0.1 to 2.3 s on the shared host (October 28,
 * 2026), while no other guarded call took over 100 ms. Use it only where no case observes durability across a power
 * loss; a process death keeps what the operating system already accepted. A failing sync stays covered where a case
 * injects it (plugin-registry.test.ts, installed-app-icon.test.ts).
 */
export function unflushedOpen<Open extends (...args: never[]) => Promise<object>>(open: Open): Open {
  return (async (...args: Parameters<Open>) => {
    const handle = await open(...args);
    return new Proxy(handle, {get(target, property) {
      if (property === 'sync') return () => Promise.resolve();
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...values: unknown[]) => unknown).bind(target) : value;
    }});
  }) as Open;
}

/** `fileSystem` with its `open` replaced by `unflushedOpen(open)`; every other operation unchanged. */
export function unflushed<FileSystem extends {open: (...args: never[]) => Promise<object>}>(fileSystem: FileSystem): FileSystem {
  return {...fileSystem, open: unflushedOpen(fileSystem.open)};
}

/** The guard with the flush to disk of every opened file skipped (`unflushedOpen`); every other call, and the guard's checks, unchanged. */
export function withoutFlush(root: GuardedRoot): GuardedRoot {
  return {...root, fs: unflushed(root.fs)};
}
