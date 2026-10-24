import {describe, expect, it} from 'vitest';
import {LEGACY_SHORTCUT_NAMES, legacyShortcutCandidates, MAX_SHORTCUT_BYTES, ownsShortcut, removeLegacyShortcuts, SHORTCUT_COMPANY, SHORTCUT_NAME, SQUIRREL_APP_ID,
  type LegacyShortcutPorts, type ShortcutFolders, type ShortcutLink} from '../../apps/desktop/src/legacy-shortcuts';

// REG-017, REG-012 (ET-045h, owner decision D2): the old-name shortcut migration on an in-memory file system. Every path
// is a string the fake records; nothing on the disk, no real shortcut and no real known folder is read or written.

const INSTALL_ROOT = 'C:\\Users\\driver\\AppData\\Local\\ETS2TelemetryDesktop';
const EXE = 'ETS2TelemetryDesktop.exe';
const AUMID = 'com.squirrel.ETS2TelemetryDesktop.ETS2TelemetryDesktop';
const FOLDERS: ShortcutFolders = {desktop: 'C:\\Users\\driver\\Desktop', startMenuPrograms: 'C:\\Users\\driver\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs'};
const DESKTOP_OLD = 'C:\\Users\\driver\\Desktop\\ETS2Telemetry Desktop.lnk';
const DESKTOP_NEW = 'C:\\Users\\driver\\Desktop\\Yukon Union Telemetry.lnk';
const START_OLD = `${FOLDERS.startMenuPrograms}\\Artur Sianiuk\\ETS2Telemetry Desktop.lnk`;
const START_NEW = `${FOLDERS.startMenuPrograms}\\Artur Sianiuk\\Yukon Union Telemetry.lnk`;
const STUB: ShortcutLink = {target: `${INSTALL_ROOT}\\${EXE}`, appUserModelId: AUMID};

type Entry = {kind: 'file' | 'link' | 'directory'; size?: number} | {kind: 'error'; code: string};
interface FakeShell {
  ports: LegacyShortcutPorts;
  /** Every file operation, in order: `lstat <path>` or `unlink <path>`. */
  calls: string[];
  reads: string[];
  advance(milliseconds: number): void;
}
function fake(options: {entries?: Record<string, Entry>; links?: Record<string, ShortcutLink | 'throws'>; folders?: ShortcutFolders | undefined | 'throws';
  unlinkFails?: readonly string[]; onRead?: (file: string, shell: {advance(milliseconds: number): void}) => void} = {}): FakeShell {
  const entries = new Map(Object.entries(options.entries ?? {}).map(([key, value]) => [key.toLowerCase(), value]));
  const calls: string[] = [], reads: string[] = [];
  let clock = 0;
  const advance = (milliseconds: number) => {clock += milliseconds;};
  const ports: LegacyShortcutPorts = {
    fs: {
      lstat: target => {
        calls.push(`lstat ${target}`);
        const entry = entries.get(target.toLowerCase());
        if (!entry) return Promise.reject(Object.assign(new Error('ENOENT'), {code: 'ENOENT'}));
        if (entry.kind === 'error') return Promise.reject(Object.assign(new Error(entry.code), {code: entry.code}));
        return Promise.resolve({isFile: () => entry.kind === 'file', isSymbolicLink: () => entry.kind === 'link', size: BigInt(entry.size ?? 2048)});
      },
      unlink: target => {
        calls.push(`unlink ${target}`);
        if (options.unlinkFails?.includes(target)) return Promise.reject(Object.assign(new Error('EPERM'), {code: 'EPERM'}));
        entries.delete(target.toLowerCase());
        return Promise.resolve();
      }
    },
    folders: () => {
      if (options.folders === 'throws') throw new Error('no known folder');
      return 'folders' in options ? options.folders : FOLDERS;
    },
    readShortcut: file => {
      reads.push(file);
      options.onRead?.(file, {advance});
      const link = options.links?.[file];
      if (link === 'throws') throw new Error('readShortcutLink failed');
      return link;
    },
    clock: () => clock
  };
  return {ports, calls, reads, advance};
}
const run = (shell: FakeShell, requireCurrent = true, deadline = 1000) => removeLegacyShortcuts({installRoot: INSTALL_ROOT, executableName: EXE, ports: shell.ports,
  requireCurrent, deadline});
const both: Record<string, Entry> = {[DESKTOP_OLD]: {kind: 'file'}, [DESKTOP_NEW]: {kind: 'file'}, [START_OLD]: {kind: 'file'}, [START_NEW]: {kind: 'file'}};
const unlinks = (shell: FakeShell) => shell.calls.filter(call => call.startsWith('unlink '));

describe('the names and candidates', () => {
  it('names the current shortcut after the product and keeps the Start menu company and the Squirrel id', () => {
    expect(SHORTCUT_NAME).toBe('Yukon Union Telemetry');
    expect(SHORTCUT_COMPANY).toBe('Artur Sianiuk');
    expect(SQUIRREL_APP_ID).toBe('ETS2TelemetryDesktop');
    expect(LEGACY_SHORTCUT_NAMES).toEqual(['ETS2Telemetry Desktop']);
  });

  it('lists exactly Squirrel\'s two locations, desktop first, each beside its new-name sibling', () => {
    expect(legacyShortcutCandidates(FOLDERS)).toEqual([
      {location: 'desktop', legacy: DESKTOP_OLD, current: DESKTOP_NEW},
      {location: 'start-menu', legacy: START_OLD, current: START_NEW}]);
  });
});

describe('ownsShortcut', () => {
  it.each([
    ['the root stub', {target: `${INSTALL_ROOT}\\${EXE}`}],
    ['the root stub with the AUMID', STUB],
    ['an empty AUMID', {target: `${INSTALL_ROOT}\\${EXE}`, appUserModelId: ''}],
    ['the versioned executable', {target: `${INSTALL_ROOT}\\app-0.1.0\\${EXE}`, appUserModelId: AUMID}],
    ['a prerelease folder', {target: `${INSTALL_ROOT}\\app-0.2.0-alpha.1\\${EXE}`}],
    ['mixed case', {target: 'c:\\USERS\\Driver\\appdata\\LOCAL\\ets2telemetrydesktop\\ets2telemetrydesktop.EXE', appUserModelId: AUMID.toUpperCase()}],
    ['a trailing separator and doubled separators in the root', {target: `${INSTALL_ROOT.replace('\\AppData', '\\\\AppData')}\\${EXE}`}],
    ['Update.exe --processStart, bare', {target: `${INSTALL_ROOT}\\Update.exe`, args: `--processStart ${EXE}`}],
    ['Update.exe --processStart, quoted', {target: `${INSTALL_ROOT}\\Update.exe`, args: `--processStart "${EXE}"`}],
    ['Update.exe with --process-start-args', {target: `${INSTALL_ROOT}\\update.EXE`, args: `--processStart "${EXE}" --process-start-args "--hidden"`}]
  ] as const)('owns %s', (_label, link) => {
    expect(ownsShortcut(link, INSTALL_ROOT, EXE)).toBe(true);
    expect(ownsShortcut(link, `${INSTALL_ROOT}\\`, EXE)).toBe(true);
  });

  it.each([
    ['a foreign target', {target: 'C:\\Program Files\\Other\\ETS2TelemetryDesktop.exe'}],
    ['another executable in the root', {target: `${INSTALL_ROOT}\\Other.exe`}],
    ['a target that leaves the root', {target: `${INSTALL_ROOT}\\..\\decoy-target\\${EXE}`}],
    ['a deeper folder', {target: `${INSTALL_ROOT}\\app-0.1.0\\resources\\${EXE}`}],
    ['a folder that is not app-<version>', {target: `${INSTALL_ROOT}\\packages\\${EXE}`}],
    ['the stub with arguments', {target: `${INSTALL_ROOT}\\${EXE}`, args: '--inspect'}],
    ['a foreign AUMID', {target: `${INSTALL_ROOT}\\${EXE}`, appUserModelId: 'com.squirrel.Other.Other'}],
    ['Update.exe without arguments', {target: `${INSTALL_ROOT}\\Update.exe`}],
    ['Update.exe starting another executable', {target: `${INSTALL_ROOT}\\Update.exe`, args: '--processStart Other.exe'}],
    ['Update.exe with an extra argument', {target: `${INSTALL_ROOT}\\Update.exe`, args: `--processStart ${EXE} --extra`}],
    ['Update.exe with two start arguments', {target: `${INSTALL_ROOT}\\Update.exe`, args: `--processStart ${EXE} --process-start-args a b`}],
    ['Update.exe with an unbalanced quote', {target: `${INSTALL_ROOT}\\Update.exe`, args: `--processStart "${EXE}`}],
    ['another Update.exe', {target: `C:\\Users\\driver\\AppData\\Local\\Other\\Update.exe`, args: `--processStart ${EXE}`}]
  ] as const)('does not own %s', (_label, link) => {
    expect(ownsShortcut(link, INSTALL_ROOT, EXE)).toBe(false);
  });

  it('owns nothing for a relative install root', () => {
    expect(ownsShortcut({target: `ETS2TelemetryDesktop\\${EXE}`}, 'ETS2TelemetryDesktop', EXE)).toBe(false);
  });
});

describe('removeLegacyShortcuts', () => {
  it('removes owned old-name shortcuts in both locations once the new ones exist, and touches nothing else', async () => {
    const shell = fake({entries: both, links: {[DESKTOP_OLD]: STUB, [START_OLD]: {target: `${INSTALL_ROOT}\\app-0.1.0\\${EXE}`, appUserModelId: AUMID}}});
    expect(await run(shell)).toEqual({removed: 2, kept: 0, unresolved: 0, failed: 0});
    expect(shell.calls).toEqual([`lstat ${DESKTOP_OLD}`, `lstat ${DESKTOP_NEW}`, `unlink ${DESKTOP_OLD}`, `lstat ${START_OLD}`, `lstat ${START_NEW}`, `unlink ${START_OLD}`]);
  });

  it('counts absent old names as nothing', async () => {
    const shell = fake({entries: {[DESKTOP_NEW]: {kind: 'file'}, [START_NEW]: {kind: 'file'}}});
    expect(await run(shell)).toEqual({removed: 0, kept: 0, unresolved: 0, failed: 0});
    expect(unlinks(shell)).toEqual([]);
    expect(shell.reads).toEqual([]);
  });

  it.each([
    ['a foreign shortcut', {[DESKTOP_OLD]: {kind: 'file'}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: {target: 'C:\\Other\\Other.exe'}}, 0],
    ['an unreadable shortcut', {[DESKTOP_OLD]: {kind: 'file'}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: 'throws' as const}, 1],
    ['a shortcut the reader cannot describe', {[DESKTOP_OLD]: {kind: 'file'}, [DESKTOP_NEW]: {kind: 'file'}}, {}, 1],
    ['a link at the old name', {[DESKTOP_OLD]: {kind: 'link'}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: STUB}, 0],
    ['a folder at the old name', {[DESKTOP_OLD]: {kind: 'directory'}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: STUB}, 0],
    ['an oversize file', {[DESKTOP_OLD]: {kind: 'file', size: MAX_SHORTCUT_BYTES + 1}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: STUB}, 0],
    ['an old name that cannot be inspected', {[DESKTOP_OLD]: {kind: 'error', code: 'EACCES'}, [DESKTOP_NEW]: {kind: 'file'}}, {[DESKTOP_OLD]: STUB}, 1],
    ['no new-name shortcut beside it', {[DESKTOP_OLD]: {kind: 'file'}}, {[DESKTOP_OLD]: STUB}, 0],
    ['a new-name entry that is a link', {[DESKTOP_OLD]: {kind: 'file'}, [DESKTOP_NEW]: {kind: 'link'}}, {[DESKTOP_OLD]: STUB}, 0]
  ] as const)('keeps %s', async (_label, entries, links, undecided) => {
    const shell = fake({entries, links});
    // Unresolved: its ownership was never decided, so an uninstall receipt must not call the shortcuts removed.
    expect(await run(shell)).toEqual({removed: 0, kept: 1, unresolved: undecided, failed: 0});
    expect(unlinks(shell)).toEqual([]);
  });

  it('accepts an exactly 64 KiB shortcut', async () => {
    const shell = fake({entries: {[DESKTOP_OLD]: {kind: 'file', size: MAX_SHORTCUT_BYTES}, [DESKTOP_NEW]: {kind: 'file'}}, links: {[DESKTOP_OLD]: STUB}});
    expect(await run(shell)).toEqual({removed: 1, kept: 0, unresolved: 0, failed: 0});
  });

  it('removes an owned old name without a new one when the current one is not required (uninstall)', async () => {
    const shell = fake({entries: {[DESKTOP_OLD]: {kind: 'file'}, [START_OLD]: {kind: 'file'}}, links: {[DESKTOP_OLD]: STUB, [START_OLD]: STUB}});
    expect(await run(shell, false)).toEqual({removed: 2, kept: 0, unresolved: 0, failed: 0});
    expect(shell.calls).not.toContain(`lstat ${DESKTOP_NEW}`);
    expect(unlinks(shell)).toEqual([`unlink ${DESKTOP_OLD}`, `unlink ${START_OLD}`]);
  });

  it('counts a failed deletion as failed, without a retry, and still handles the next location', async () => {
    const shell = fake({entries: both, links: {[DESKTOP_OLD]: STUB, [START_OLD]: STUB}, unlinkFails: [DESKTOP_OLD]});
    expect(await run(shell)).toEqual({removed: 1, kept: 0, unresolved: 0, failed: 1});
    expect(unlinks(shell)).toEqual([`unlink ${DESKTOP_OLD}`, `unlink ${START_OLD}`]);
  });

  it('keeps every candidate left at the deadline and deletes nothing after it', async () => {
    // Reading the desktop shortcut takes the whole budget: it is kept, and the Start menu is never inspected.
    const shell = fake({entries: both, links: {[DESKTOP_OLD]: STUB, [START_OLD]: STUB}, onRead: (_file, clock) => clock.advance(1000)});
    expect(await run(shell)).toEqual({removed: 0, kept: 2, unresolved: 2, failed: 0});
    expect(unlinks(shell)).toEqual([]);
    expect(shell.calls).not.toContain(`lstat ${START_OLD}`);
  });

  it('keeps everything when the deadline has already passed', async () => {
    const shell = fake({entries: both, links: {[DESKTOP_OLD]: STUB, [START_OLD]: STUB}});
    shell.advance(1000);
    expect(await run(shell)).toEqual({removed: 0, kept: 2, unresolved: 2, failed: 0});
    expect(shell.calls).toEqual([]);
  });

  it.each([
    ['unknown', undefined],
    ['failing', 'throws' as const],
    ['relative', {desktop: 'Desktop', startMenuPrograms: FOLDERS.startMenuPrograms}],
    ['UNC', {desktop: FOLDERS.desktop, startMenuPrograms: '\\\\server\\share\\Programs'}]
  ])('touches nothing when the folders are %s', async (_label, folders) => {
    const shell = fake({entries: both, links: {[DESKTOP_OLD]: STUB, [START_OLD]: STUB}, folders});
    expect(await run(shell)).toEqual({removed: 0, kept: 0, unresolved: 0, failed: 0});
    expect(shell.calls).toEqual([]);
    expect(shell.reads).toEqual([]);
  });
});
