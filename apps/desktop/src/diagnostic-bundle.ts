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
  logs: {main: DiagnosticLogText; service: DiagnosticLogText; plugin?: DiagnosticLogText;
    /** Reader-only availability, distinct from finding recognized rows; never serialized into the bundle. */
    pluginRead?: Readonly<Record<'ets2' | 'ats', boolean>>};
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
  logs: {main: DiagnosticLogRow[]; service: DiagnosticLogRow[]; plugin?: DiagnosticLogRow[]};
  /** Log rows left out: unreadable or invalid lines, rows beyond the row limit and the oldest rows dropped for the size bound. */
  omittedLogRows: {main: number; service: number; plugin?: number};
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
/**
 * Redacts the names in one log row's runtime content only: its fact keys and string fact values. The row's time and
 * event code passed fixed patterns and are schema, not free text, so they stay as they are (PR #111 review).
 */
function redactRow(row: DiagnosticLogRow, redact: (text: string) => string): DiagnosticLogRow {
  if (!row.facts) return row;
  return {...row, facts: Object.fromEntries(Object.entries(row.facts).map(([key, value]) => [redact(key), typeof value === 'string' ? redact(value) : value]))};
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
function logRows(text: DiagnosticLogText, redact: (text: string) => string): {rows: DiagnosticLogRow[]; omitted: number} {
  const rows: DiagnosticLogRow[] = [];
  let omitted = 0;
  for (const content of [text.previous, text.current]) {
    if (content === undefined) continue;
    const lines = content.split(/\r?\n/);
    // A tail read can start inside a line; the first line of a tail is then partial and does not parse.
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = diagnosticLogRow(line);
      if (row) rows.push(redactRow(row, redact)); else omitted++;
    }
  }
  const excess = Math.max(0, rows.length - DIAGNOSTIC_LOG_ROW_LIMIT);
  return {rows: rows.slice(excess), omitted: omitted + excess};
}

const serialize = (bundle: DiagnosticBundle) => `${JSON.stringify(bundle, null, 2)}\n`;

/**
 * Builds the bundle text. The user and computer names are redacted only in runtime content: the log rows' fact keys and
 * string fact values, and the operating system's release text. The format, every schema key, enum code, version and
 * event code stay exactly as written, so a name such as `main` or `diagnostics` can never change the document's shape
 * (PR #111 review). When the text exceeds DIAGNOSTIC_BUNDLE_MAX_BYTES, the oldest log rows of the longer log are left
 * out until it fits. Throws only when the document without any log row is still too large.
 */
export function buildDiagnosticBundle(input: DiagnosticBundleInput): string {
  const redact = nameRedactor(input.identities);
  const main = logRows(input.logs.main, redact), service = logRows(input.logs.service, redact);
  const plugin = input.logs.plugin ? logRows(input.logs.plugin, redact) : undefined;
  const logs: Record<'main' | 'service' | 'plugin', DiagnosticLogRow[]> = {main: main.rows, service: service.rows, plugin: plugin?.rows ?? []};
  const omitted = {main: main.omitted, service: service.omitted, plugin: plugin?.omitted ?? 0};
  // Work only on these local arrays; a schema-like Windows user name cannot change their keys.
  const document = (): DiagnosticBundle => ({
    format: DIAGNOSTIC_BUNDLE_FORMAT, version: DIAGNOSTIC_BUNDLE_VERSION, createdUtc: new Date(input.createdMs).toISOString(),
    app: {...input.app, osRelease: redact(input.app.osRelease)}, health: input.health, settings: input.settings, plugins: input.plugins,
    bundledPlugin: input.plugins.bundled, live: input.live, diagnosis: input.diagnosis,
    logs: {main: logs.main, service: logs.service, ...(plugin ? {plugin: logs.plugin} : {})},
    omittedLogRows: {main: omitted.main, service: omitted.service, ...(plugin ? {plugin: omitted.plugin} : {})}
  });
  let text = serialize(document());
  while (Buffer.byteLength(text, 'utf8') > DIAGNOSTIC_BUNDLE_MAX_BYTES) {
    const longer = (['main', 'service', 'plugin'] as const).reduce((a, b) => logs[a].length >= logs[b].length ? a : b);
    const rows = logs[longer];
    if (!rows.length) throw new Error('DIAGNOSTIC_BUNDLE_TOO_LARGE');
    const drop = Math.max(1, Math.ceil(rows.length / 8));
    logs[longer] = rows.slice(drop);
    omitted[longer] += drop;
    text = serialize(document());
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
export async function readDiagnosticLogs(logDirectory: string, readTail: ReadTail, plugin?: {documents: string; staging: boolean}): Promise<DiagnosticBundleInput['logs']> {
  const read = (directory: string) => Promise.all([readTail(path.join(directory, 'startup.jsonl'), DIAGNOSTIC_LOG_READ_BYTES),
    readTail(path.join(directory, 'startup.jsonl.1'), DIAGNOSTIC_LOG_READ_BYTES)]).then(([current, previous]) => ({current, previous}));
  const [main, service, gameRows] = await Promise.all([read(logDirectory), read(path.join(logDirectory, 'service')), plugin ? readPluginCloseLogs(plugin, readTail) : undefined]);
  return {main, service, ...(gameRows ? {pluginRead: gameRows.read, ...(gameRows.current ? {plugin: {current: gameRows.current}} : {})} : {})};
}

const CLOSE_REASONS = new Set(['CONNECTION_EXCEPTION', 'WRITE_FAILED', 'WRITE_PARTIAL', 'WRITE_TIMEOUT', 'READ_FAILED', 'CLIENT_EOF',
  'EARLY_CLIENT_DATA', 'CLIENT_PROTOCOL', 'INVALID_ACK', 'INVALID_PROBE', 'PEER_EXITED', 'PEER_CHECK_FAILED', 'PEER_CHANGED', 'SHUTDOWN',
  'INVARIANT_VIOLATION', 'SOURCE_RETIRED', 'SEQUENCE_EXHAUSTED', 'PEER_REJECTED', 'POLICY_REJECTED', 'PEER_INSPECTION_FAILED', 'POLICY_READ_FAILED', 'HELLO_TIMEOUT', 'HELLO_PROTOCOL', 'ENCODING_FAILED']);
/** The game log contains arbitrary private text. Only this exact fixed-code grammar may enter a diagnostic bundle. */
export function pluginCloseLogRow(line: string, game: 'ets2' | 'ats', staging: boolean): DiagnosticLogRow | undefined {
  if (line.length > 512) return undefined;
  const prefix = staging ? 'ETS2TelemetryStaging:' : 'ETS2Telemetry:';
  // SCS may prepend a relative game-log timestamp and severity; anchor the entire project message to the line end.
  const start = line.indexOf(`${prefix} V1_CONNECTION_CLOSED `);
  if (start < 0) return undefined;
  const match = /^V1_CONNECTION_CLOSED reason=([A-Z_]+) phase=(accept|hello|welcome|checkpoint|live) write=(none|welcome|checkpoint|clock-reply|snapshot|event|end) end=(none|plugin-shutdown|source-retired|sequence-exhausted) win32=(\d{1,10}) durable=(unknown|[01]) connection=(\d{1,20}) utcMs=(\d{1,16}) durationMs=(\d{1,20})(?: session=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/.exec(line.slice(start + prefix.length + 1));
  if (!match || !CLOSE_REASONS.has(match[1])) return undefined;
  const [win32, connection, utcMs, durationMs] = [match[5], match[7], match[8], match[9]].map(Number);
  if (![win32, connection, utcMs, durationMs].every(n => Number.isSafeInteger(n) && n >= 0) || win32 > 0xffffffff || connection === 0 || utcMs === 0 || utcMs > 253_402_300_799_999) return undefined;
  return {time: new Date(utcMs).toISOString(), event: 'PLUGIN_V1_CONNECTION_CLOSED', facts: {
    game, reason: match[1], phase: match[2], write: match[3], end: match[4], win32, durable: match[6] === 'unknown' ? null : match[6] === '1', connection, durationMs,
    ...(match[10] ? {pluginSessionId: match[10]} : {})
  }};
}

async function readPluginCloseLogs(plugin: {documents: string; staging: boolean}, readTail: ReadTail): Promise<{current: string; read: Record<'ets2' | 'ats', boolean>}> {
  const rows = await Promise.all((['ets2', 'ats'] as const).map(async game => {
    const directory = game === 'ets2' ? 'Euro Truck Simulator 2' : 'American Truck Simulator';
    const text = await readTail(path.join(plugin.documents, directory, 'game.log.txt'), DIAGNOSTIC_LOG_READ_BYTES);
    return {game, readable: text !== undefined,
      rows: (text ?? '').split(/\r?\n/).map(line => pluginCloseLogRow(line, game, plugin.staging)).filter((row): row is DiagnosticLogRow => row !== undefined)};
  }));
  const combined = rows.flatMap(game => game.rows).sort((a, b) => a.time.localeCompare(b.time));
  return {current: combined.map(row => JSON.stringify(row)).join('\n'), read: {ets2: rows[0].readable, ats: rows[1].readable}};
}
