import path from 'node:path';
import type {PluginGame} from './steam-discovery';
import {nodeExecFile, runFixedProgram, systemRoot, type ExecFilePort} from './fixed-program';

// Running-game detection before every plugin change (ET-017 P7; docs/plugin-setup.md, "Running games"). It runs the
// fixed `tasklist.exe /fo csv /nh` and matches image names only, case-insensitively. A failed or unparseable listing is
// RUNNING_CHECK_FAILED, and the caller then changes nothing. Matching by name is conservative: a process with the same
// name from another folder also blocks (TD-010 records path-aware detection).

export const TASKLIST_TIMEOUT_MS = 3000;
export const TASKLIST_MAX_OUTPUT_BYTES = 1024 * 1024;
export const GAME_PROCESS_NAMES: Readonly<Record<PluginGame, string>> = Object.freeze({ets2: 'eurotrucks2.exe', ats: 'amtrucks.exe'});
/** Any image name starting with this prefix is a TruckersMP client process and blocks both games. */
export const CLIENT_PROCESS_PREFIX = 'truckersmp';

export interface ProcessRow {readonly name: string; readonly pid: number}
export interface RunningGames {readonly ets2: boolean; readonly ats: boolean; readonly client: boolean}
export type BlockingProcess = 'GAME_RUNNING' | 'CLIENT_RUNNING';
export type ProcessListing = {readonly ok: true; readonly rows: readonly ProcessRow[]} | {readonly ok: false; readonly code: 'RUNNING_CHECK_FAILED'; readonly reason: string};

/** One CSV record of quoted fields with `""` as an escaped quote, as tasklist writes it. Undefined if malformed. */
function csvFields(line: string): string[] | undefined {
  const fields: string[] = [];
  let position = 0;
  while (true) {
    if (line[position] !== '"') return undefined;
    position++;
    let value = '';
    while (true) {
      if (position >= line.length) return undefined;
      const character = line[position++];
      if (character !== '"') {value += character; continue;}
      if (line[position] === '"') {value += '"'; position++; continue;}
      break;
    }
    fields.push(value);
    if (position === line.length) return fields;
    if (line[position] !== ',') return undefined;
    position++;
  }
}

/**
 * Parses `tasklist /fo csv /nh` output: one `"Image Name","PID",…` record per line. Undefined when any non-empty line
 * is malformed or no process is listed, because a partial listing could hide a running game.
 */
export function parseTasklistCsv(text: string): ProcessRow[] | undefined {
  const rows: ProcessRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = csvFields(line.trim());
    if (!fields || fields.length < 2 || !fields[0] || !/^\d{1,10}$/.test(fields[1])) return undefined;
    rows.push({name: fields[0], pid: Number(fields[1])});
  }
  return rows.length ? rows : undefined;
}

export function runningGames(rows: readonly ProcessRow[]): RunningGames {
  const names = rows.map(row => row.name.toLowerCase());
  return {
    ets2: names.includes(GAME_PROCESS_NAMES.ets2),
    ats: names.includes(GAME_PROCESS_NAMES.ats),
    client: names.some(name => name.startsWith(CLIENT_PROCESS_PREFIX))
  };
}

/** Why a change to `game`'s plugin must wait: the game itself, or a TruckersMP client that may start either game. */
export function blockingProcess(game: PluginGame, running: RunningGames): BlockingProcess | null {
  if (running[game]) return 'GAME_RUNNING';
  return running.client ? 'CLIENT_RUNNING' : null;
}

export interface ProcessListOptions {
  execFile?: ExecFilePort;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}

/** Lists the processes of this Windows session through the absolute tasklist.exe path. */
export async function listProcesses(options: ProcessListOptions = {}): Promise<ProcessListing> {
  const tasklist = path.win32.join(systemRoot(options.env ?? process.env), 'System32', 'tasklist.exe');
  const result = await runFixedProgram(options.execFile ?? nodeExecFile, tasklist, ['/fo', 'csv', '/nh'],
    {timeoutMs: TASKLIST_TIMEOUT_MS, maxOutputBytes: TASKLIST_MAX_OUTPUT_BYTES, signal: options.signal});
  if (!result.ok) return {ok: false, code: 'RUNNING_CHECK_FAILED', reason: result.failure};
  // tasklist writes in the console code page. The names matched here are ASCII, so latin1 never changes them.
  const rows = parseTasklistCsv(result.stdout.toString('latin1'));
  return rows ? {ok: true, rows} : {ok: false, code: 'RUNNING_CHECK_FAILED', reason: 'output-invalid'};
}

/** Which games and clients run now, or RUNNING_CHECK_FAILED. */
export async function checkRunningGames(options: ProcessListOptions = {}): Promise<{readonly ok: true; readonly running: RunningGames} | {readonly ok: false; readonly code: 'RUNNING_CHECK_FAILED'; readonly reason: string}> {
  const listing = await listProcesses(options);
  return listing.ok ? {ok: true, running: runningGames(listing.rows)} : listing;
}
