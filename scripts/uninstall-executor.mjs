import assert from 'node:assert/strict';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {BUILD_CHANNELS} from './build-channel.mjs';

// The deferred-cleanup executor of the build channel (ET-018 PR-5, ET-055 UP12; docs/uninstall.md). The tracked script
// resources/uninstall/Complete-ETS2TelemetryUninstall.ps1 holds both channels' names and exactly one line
// `$Channel = 'production'`. The build stamps the resolved channel into that line of a staged copy, which forge.config.cjs
// packages as resources/uninstall; inspect-package compares the packaged copy with the same stamp. Production's copy is
// byte-identical to the tracked script.

export const EXECUTOR_FILE = 'Complete-ETS2TelemetryUninstall.ps1';
export const EXECUTOR_SOURCE = `resources/uninstall/${EXECUTOR_FILE}`;
export const EXECUTOR_STAGE = '.local/package-native/uninstall';
const CHANNEL_LINE = /^\$Channel = 'production'(?=\r?$)/gm;

/** The executor text with `channel` stamped into its single `$Channel = 'production'` line. */
export function stampExecutorChannel(text, channel) {
  assert.ok(BUILD_CHANNELS.includes(channel), `Unknown build channel ${JSON.stringify(channel)}`);
  assert.equal([...text.matchAll(CHANNEL_LINE)].length, 1, `${EXECUTOR_FILE} must hold exactly one $Channel = 'production' line`);
  return text.replace(CHANNEL_LINE, () => `$Channel = '${channel}'`);
}

/** The bytes the build stages and packages for `channel`, from the tracked script of the checkout `root`. */
export function executorBytes(channel, root = '.') {
  return Buffer.from(stampExecutorChannel(readFileSync(path.join(root, EXECUTOR_SOURCE), 'latin1'), channel), 'latin1');
}

/** Writes the stamped executor alone into EXECUTOR_STAGE (replacing it) and returns its bytes. */
export function stageUninstallExecutor(channel, root = '.') {
  const bytes = executorBytes(channel, root), stage = path.join(root, EXECUTOR_STAGE);
  rmSync(stage, {recursive: true, force: true});
  mkdirSync(stage, {recursive: true});
  writeFileSync(path.join(stage, EXECUTOR_FILE), bytes, {flag: 'wx'});
  return bytes;
}
