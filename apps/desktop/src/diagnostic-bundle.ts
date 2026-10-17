// The diagnostic bundle (ET-017 P17): one redacted JSON document of at most 2 MiB that a driver can save and attach to a
// support request. It holds versions, the application health, the settings and plugin views, the live status and
// selection, the bundled plugin's identity, the connection diagnosis and the last rows of the main and service startup
// logs reduced to {time, event, facts}. A log row's `detail` is dropped, a fact string that looks like a path becomes
// `<redacted>`, and the user name and computer name are replaced wherever they appear. Nothing is uploaded. Main
// process only; the builder is pure and the log reader takes its file port. See docs/plugin-setup.md#diagnostic-bundle.
import {open, type FileHandle} from 'node:fs/promises';
import path from 'node:path';
import type {AppHealth, LiveTelemetry, PluginFileView, PluginSetupView, SettingsView, SourceSelection} from '../../../packages/contracts/src';
import type {ConnectionDiagnosis} from './connection-diagnosis';

export const DIAGNOSTIC_BUNDLE_FORMAT = 'ets2telemetry.diagnostics';
export const DIAGNOSTIC_BUNDLE_VERSION = 1;
/** The bundle's upper bound in UTF-8 bytes; the oldest log rows are left out until it fits. */
export const DIAGNOSTIC_BUNDLE_MAX_BYTES = 2 * 1024 * 1024;
/** What replaces a path-like fact or a user or computer name. */
export const REDACTED = '<redacted>';
/** Rows kept per log before the size bound applies: each startup log holds at most 2000 records per process start. */
export const DIAGNOSTIC_LOG_ROW_LIMIT = 2000;
/** The tail of each log file read: the logger rotates at 256 KiB, so this reads a whole file. */
export const DIAGNOSTIC_LOG_READ_BYTES = 256 * 1024;
/** A fact string longer than this is cut; diagnostic facts are fixed codes, numbers and flags. */
const FACT_STRING_LIMIT = 256;
const EVENT_NAME = /^[A-Z0-9_]{1,64}$/;
const FACT_KEY = /^[A-Za-z0-9_]{1,64}$/;
/** An ISO 8601 UTC time as the logger writes it. */
const LOG_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A backslash, a slash or a drive colon (`C:` at the start or after a non-word character). */
const PATH_LIKE = /[\\/]|(?:^|[^A-Za-z0-9_])[A-Za-z]:/;

export type DiagnosticFactValue = string | number | boolean | null;
export interface DiagnosticLogRow {time: string; event: string; facts?: Readonly<Record<string, DiagnosticFactValue>>}
/** The raw text of each log file; a missing or unreadable file is `undefined`. `previous` is the rotated `.1` file. */
export interface DiagnosticLogText {current?: string; previous?: string}
export interface DiagnosticBundleInput {
  createdMs: number;
  app: {version: string; electron: string; node: string; packaged: boolean; osRelease: string};
  health: AppHealth;
  settings: SettingsView;
  plugins: PluginSetupView;
  live: {status: LiveTelemetry['status']; selection: SourceSelection};
  diagnosis: ConnectionDiagnosis;
  logs: {main: DiagnosticLogText; service: DiagnosticLogText};
  /** Names that never appear in the bundle: the Windows user name and computer name, as the main process sees them. */
  identities: readonly (string | undefined)[];
}
export interface DiagnosticBundle {
  format: typeof DIAGNOSTIC_BUNDLE_FORMAT;
  version: typeof DIAGNOSTIC_BUNDLE_VERSION;
  createdUtc: string;
  app: DiagnosticBundleInput['app'];
  health: AppHealth;
  settings: SettingsView;
  plugins: PluginSetupView;
  bundledPlugin: PluginFileView | null;
  live: DiagnosticBundleInput['live'];
  diagnosis: ConnectionDiagnosis;
  logs: {main: DiagnosticLogRow[]; service: DiagnosticLogRow[]};
  /** Log rows left out: unreadable or invalid lines, rows beyond the row limit and the oldest rows dropped for the size bound. */
  omittedLogRows: {main: number; service: number};
}

const pathLike = (value: string) => PATH_LIKE.test(value);
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Replaces every listed name of at least two characters, case-insensitively and as a whole word, in each string of a
 * JSON value. Shorter names are not replaced, because they would erase ordinary text.
 */
function nameRedactor(identities: readonly (string | undefined)[]): (value: string) => string {
  const names = [...new Set(identities.filter((name): name is string => typeof name === 'string').map(name => name.trim()).filter(name => name.length >= 2))];
  if (!names.length) return value => value;
  const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${names.sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})(?![A-Za-z0-9])`, 'giu');
  return value => value.replace(pattern, REDACTED);
}
function redactStrings<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(entry => redactStrings(entry, redact) as unknown) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key), redactStrings(entry, redact)])) as T;
  return value;
}

/** One fact value: scalars only; a path-like string becomes `<redacted>`, and a long one is cut. */
function factValue(value: unknown): DiagnosticFactValue | undefined {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return pathLike(value) ? REDACTED : value.slice(0, FACT_STRING_LIMIT);
  return value === undefined ? undefined : REDACTED;
}

/**
 * One log line reduced to {time, event, facts}: `detail`, `pid` and any other field are dropped, a line that is not a
 * JSON object with a logger time and a fixed event code is left out, and fact keys outside the fixed shape are dropped.
 */
export function diagnosticLogRow(line: string): DiagnosticLogRow | undefined {
  let parsed: unknown;
  try {parsed = JSON.parse(line);} catch {return undefined;}
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const {time, event, facts} = parsed as Record<string, unknown>;
  if (typeof time !== 'string' || !LOG_TIME.test(time) || typeof event !== 'string' || !EVENT_NAME.test(event)) return undefined;
  const row: DiagnosticLogRow = {time, event};
  if (facts && typeof facts === 'object' && !Array.isArray(facts)) {
    const kept: Record<string, DiagnosticFactValue> = {};
    for (const [key, value] of Object.entries(facts)) {
      const reduced = FACT_KEY.test(key) ? factValue(value) : undefined;
      if (reduced !== undefined) kept[key] = reduced;
    }
    row.facts = kept;
  }
  return row;
}

/** The rows of one log, oldest first: the rotated file, then the current one; at most the last DIAGNOSTIC_LOG_ROW_LIMIT. */
function logRows(text: DiagnosticLogText): {rows: DiagnosticLogRow[]; omitted: number} {
  const rows: DiagnosticLogRow[] = [];
  let omitted = 0;
  for (const content of [text.previous, text.current]) {
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    // A tail read can start inside a line; the first line of a tail is then partial and does not parse.
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = diagnosticLogRow(line);
      if (row) rows.push(row); else omitted++;
    }
  }
  const excess = Math.max(0, rows.length - DIAGNOSTIC_LOG_ROW_LIMIT);
  return {rows: rows.slice(excess), omitted: omitted + excess};
}

const serialize = (bundle: DiagnosticBundle) => `${JSON.stringify(bundle, null, 2)}\n`;

/**
 * Builds the bundle text. Every string of the whole document passes the name redaction; when the text exceeds
 * DIAGNOSTIC_BUNDLE_MAX_BYTES, the oldest log rows of the longer log are left out until it fits. Throws only when the
 * document without any log row is still too large.
 */
export function buildDiagnosticBundle(input: DiagnosticBundleInput): string {
  const main = logRows(input.logs.main), service = logRows(input.logs.service);
  const redact = nameRedactor(input.identities);
  const bundle: DiagnosticBundle = redactStrings({
    format: DIAGNOSTIC_BUNDLE_FORMAT, version: DIAGNOSTIC_BUNDLE_VERSION, createdUtc: new Date(input.createdMs).toISOString(), app: input.app,
    health: input.health, settings: input.settings, plugins: input.plugins, bundledPlugin: input.plugins.bundled, live: input.live, diagnosis: input.diagnosis,
    logs: {main: main.rows, service: service.rows}, omittedLogRows: {main: main.omitted, service: service.omitted}
  }, redact);
  let text = serialize(bundle);
  while (Buffer.byteLength(text, 'utf8') > DIAGNOSTIC_BUNDLE_MAX_BYTES) {
    const longer = bundle.logs.main.length >= bundle.logs.service.length ? 'main' : 'service';
    const rows = bundle.logs[longer];
    if (!rows.length) throw new Error('DIAGNOSTIC_BUNDLE_TOO_LARGE');
    const drop = Math.max(1, Math.ceil(rows.length / 8));
    bundle.logs[longer] = rows.slice(drop);
    bundle.omittedLogRows[longer] += drop;
    text = serialize(bundle);
  }
  return text;
}

/** Reads the tail of one file; a missing or unreadable file is `undefined`. */
export type ReadTail = (file: string, maxBytes: number) => Promise<string | undefined>;
/** The real file port: the last `maxBytes` bytes of a file as UTF-8, or `undefined` when it cannot be read. */
export const readFileTail: ReadTail = async (file, maxBytes) => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const {size} = await handle.stat();
    const length = Math.min(size, maxBytes), buffer = Buffer.alloc(length);
    const {bytesRead} = await handle.read(buffer, 0, length, size - length);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {return undefined;} finally {await handle?.close().catch(() => undefined);}
};
/**
 * The main and service startup logs and their rotated `.1` files under the main log directory: `startup.jsonl[.1]` and
 * `service\startup.jsonl[.1]`, the tail of each at most DIAGNOSTIC_LOG_READ_BYTES.
 */
export async function readDiagnosticLogs(logDirectory: string, readTail: ReadTail): Promise<DiagnosticBundleInput['logs']> {
  const read = (directory: string) => Promise.all([readTail(path.join(directory, 'startup.jsonl'), DIAGNOSTIC_LOG_READ_BYTES),
    readTail(path.join(directory, 'startup.jsonl.1'), DIAGNOSTIC_LOG_READ_BYTES)]).then(([current, previous]) => ({current, previous}));
  const [main, service] = await Promise.all([read(logDirectory), read(path.join(logDirectory, 'service'))]);
  return {main, service};
}
