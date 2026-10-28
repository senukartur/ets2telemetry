// The history database files that a synthetic or replay database may never use (ET-013; ET-055 UP12). Both build
// channels keep history at `%LOCALAPPDATA%\<data root>\data\telemetry.sqlite`; this package cannot import the desktop
// channel table (apps/desktop/src/channel.ts), so the data root names of both channels are mirrored here and
// tests/unit/channel-identity.test.ts pins them equal to it. Every channel's file is protected in every build, so a
// synthetic recording can never land in either history.

/** The data root folder names of the production and the staging channel. */
export const HISTORY_DATA_ROOT_NAMES: readonly string[] = Object.freeze(['ETS2Telemetry', 'ETS2TelemetryStaging']);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const HISTORY_FILE = new RegExp(`[\\\\/](?:${HISTORY_DATA_ROOT_NAMES.map(escapeRegExp).join('|')})[\\\\/]data[\\\\/]telemetry\\.sqlite$`, 'i');

/** Whether the normalized absolute path `file` is a channel's history database file. */
export function isHistoryFile(file: string): boolean {
  return HISTORY_FILE.test(file);
}
