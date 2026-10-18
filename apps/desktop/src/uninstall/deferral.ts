import path from 'node:path';
import {writeAtomicFile, type AtomicFileSystem} from '../plugin-setup/atomic-json-file';
import {pluginTargetOf} from '../plugin-setup/plugin-registry';
import {PENDING_DIRECTORY, PENDING_FILE, readPendingRecord} from './pending-record';
import type {UninstallCode} from './engine';

// The deferral fallback of an uninstall (ET-018 U7, fallback part; docs/uninstall.md, "Deferral"). PR-5 adds the RunOnce
// executor that finishes a deferred uninstall at the next sign-in; until then a deferred run leaves `plugins\` and
// `uninstall\` with the intent and a README.txt that names what is left and how to remove it by hand. A new install, an
// update or a start of the installed application cancels the deferral: the intent and the README go, and silent plugin
// setup takes over the plugin files again.

export const README_FILE = 'README.txt';

/** A plain-text README for the user: the remaining folders, the hashes that identify this application's plugin, the steps. */
export function deferralReadme(dataRoot: string, folders: readonly {game: string; root: string; hashes: readonly string[]}[], known: readonly string[],
  code: UninstallCode | null): string {
  const hashes = [...new Set([...known, ...folders.flatMap(folder => folder.hashes)])].sort();
  const lines = [
    'ETS2Telemetry was uninstalled, but its cleanup could not finish.',
    `Reason: ${code ?? 'unknown'}`,
    '',
    'Close Euro Truck Simulator 2, American Truck Simulator and TruckersMP first.',
    ''
  ];
  if (folders.length) {
    lines.push('Remove the ETS2Telemetry plugin from these game folders, but only when the file\'s SHA-256 is one of the hashes below:');
    for (const folder of folders) lines.push(`  ${folder.game}: ${pluginTargetOf(folder.root)}`);
    lines.push('', 'Check a file with: Get-FileHash -Algorithm SHA256 "<file>"', '', 'Hashes of this application\'s plugin:');
    for (const hash of hashes) lines.push(`  ${hash}`);
    lines.push('');
  }
  lines.push(`Then delete this folder and everything in it: ${dataRoot}`, '',
    'Reinstalling ETS2Telemetry instead cancels this cleanup and keeps the plugin in use.', '');
  return lines.join('\r\n');
}

/** Writes `<data root>\uninstall\README.txt` from the current intent; false when there is no intent or the write failed. */
export async function writeDeferralReadme(fs: AtomicFileSystem, dataRoot: string, code: UninstallCode | null): Promise<boolean> {
  const pending = await readPendingRecord(fs, dataRoot);
  if (pending.state !== 'present') return false;
  try {
    await writeAtomicFile(fs, path.win32.join(dataRoot, PENDING_DIRECTORY), README_FILE, deferralReadme(dataRoot, pending.record.folders, pending.record.known, code));
    return true;
  } catch {return false;}
}

/** The file operations cancelling needs; `node:fs/promises` satisfies them. */
export interface CancelFileSystem extends AtomicFileSystem {rmdir(target: string): Promise<void>}
export type CancelOutcome = 'none' | 'cancelled' | 'failed';
/**
 * Cancels a pending deferral: removes only `uninstall\pending.json` and `uninstall\README.txt` when they are regular files
 * (never through a link), then the `uninstall` folder when it is empty. `none` when there was nothing to cancel.
 */
export async function cancelDeferral(fs: CancelFileSystem, dataRoot: string): Promise<CancelOutcome> {
  const directory = path.win32.join(dataRoot, PENDING_DIRECTORY);
  let folder;
  try {folder = await fs.lstat(directory);} catch {return 'none';}
  if (folder.isSymbolicLink() || !folder.isDirectory()) return 'failed';
  let removed = 0, failed = false;
  for (const name of [PENDING_FILE, README_FILE]) {
    const file = path.win32.join(directory, name);
    try {
      const stats = await fs.lstat(file);
      if (stats.isSymbolicLink() || !stats.isFile()) {failed = true; continue;}
      await fs.unlink(file);
      removed++;
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) failed = true;
    }
  }
  try {if (!(await fs.readdir(directory)).length) await fs.rmdir(directory);} catch {/* an entry that stays keeps the folder */}
  return failed ? 'failed' : removed ? 'cancelled' : 'none';
}
