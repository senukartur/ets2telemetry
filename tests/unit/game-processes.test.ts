import {describe, expect, it} from 'vitest';
import type {ExecFilePort} from '../../apps/desktop/src/plugin-setup/fixed-program';
import {blockingProcess, checkRunningGames, listProcesses, parseTasklistCsv, parseTasklistSessions, runningGames, TASKLIST_TIMEOUT_MS} from '../../apps/desktop/src/plugin-setup/game-processes';

// REG-015 (ET-017 P7): running-game detection before a plugin change. CSV fixtures are written by hand in the format
// of `tasklist /fo csv /nh`; the one real run only lists processes and changes nothing.

const env = {SystemRoot: 'C:\\Windows'};
type Call = {file: string; args: readonly string[]; options: Parameters<ExecFilePort>[2]};
function stub(reply: {error?: Record<string, unknown>; stdout?: string}) {
  const calls: Call[] = [];
  const execFile: ExecFilePort = (file, args, options, callback) => {
    calls.push({file, args, options});
    queueMicrotask(() => callback(reply.error ? Object.assign(new Error('child failed'), reply.error) : null, Buffer.from(reply.stdout ?? '', 'latin1'), Buffer.alloc(0)));
  };
  return {execFile, calls};
}
const row = (name: string, pid: number, memory = '12,345 K') => `"${name}","${pid}","Console","1","${memory}"`;

describe('CSV parsing', () => {
  it('reads each row\'s session number for the uninstall hook, and null where the column is not a number', () => {
    const text = [row('ETS2TelemetryDesktop.exe', 10, '1 K'), '"ETS2TelemetryDesktop.exe","11","Services","0","1 K"', '"short.exe","12"', ''].join('\r\n');
    expect(parseTasklistSessions(text)).toEqual([{name: 'ETS2TelemetryDesktop.exe', pid: 10, session: 1}, {name: 'ETS2TelemetryDesktop.exe', pid: 11, session: 0},
      {name: 'short.exe', pid: 12, session: null}]);
    expect(parseTasklistCsv(text)).toEqual([{name: 'ETS2TelemetryDesktop.exe', pid: 10}, {name: 'ETS2TelemetryDesktop.exe', pid: 11}, {name: 'short.exe', pid: 12}]);
  });

  it('reads quoted fields with commas and escaped quotes', () => {
    const text = [row('System Idle Process', 0, '8 K'), row('eurotrucks2.exe', 4242, '1,234,567 K'), '"odd ""quoted"" name.exe","77","Services","0","1,024 K"', ''].join('\r\n');
    expect(parseTasklistCsv(text)).toEqual([{name: 'System Idle Process', pid: 0}, {name: 'eurotrucks2.exe', pid: 4242}, {name: 'odd "quoted" name.exe', pid: 77}]);
  });

  it.each([
    ['an unquoted record', 'eurotrucks2.exe,4242,Console,1,12 K'],
    ['an unterminated quote', '"eurotrucks2.exe,"4242"'],
    ['a non-numeric PID', '"eurotrucks2.exe","N/A","Console","1","12 K"'],
    ['an empty name', '"","4","Console","1","12 K"'],
    ['text after a field', '"a.exe"x,"4"'],
    ['the no-tasks message', 'INFO: No tasks are running which match the specified criteria.'],
    ['no output', ''],
    ['a valid row followed by a malformed one', `${row('eurotrucks2.exe', 1)}\r\ngarbage`]
  ])('refuses %s', (_name, text) => {
    expect(parseTasklistCsv(text)).toBeUndefined();
  });
});

describe('matching', () => {
  it('matches the game executables case-insensitively and exactly', () => {
    expect(runningGames([{name: 'EuroTrucks2.EXE', pid: 1}])).toEqual({ets2: true, ats: false, client: false});
    expect(runningGames([{name: 'AMTRUCKS.exe', pid: 1}])).toEqual({ets2: false, ats: true, client: false});
    expect(runningGames([{name: 'notamtrucks.exe', pid: 1}, {name: 'eurotrucks2.exe.bak', pid: 2}, {name: 'eurotrucks2', pid: 3}, {name: 'eurotrucks.exe', pid: 4}]))
      .toEqual({ets2: false, ats: false, client: false});
  });

  it('treats every truckersmp* image as the client, in any case', () => {
    for (const name of ['TruckersMP-Launcher.exe', 'truckersmp-cli.exe', 'TRUCKERSMP.EXE', 'TruckersMP-Launcher-Updater.exe']) {
      expect([name, runningGames([{name, pid: 9}]).client]).toEqual([name, true]);
    }
    expect(runningGames([{name: 'my-truckersmp.exe', pid: 9}]).client).toBe(false);
  });

  it('blocks a game for its own process or the client, and never for the other game', () => {
    expect(blockingProcess('ets2', {ets2: true, ats: false, client: false})).toBe('GAME_RUNNING');
    expect(blockingProcess('ats', {ets2: true, ats: false, client: false})).toBeNull();
    expect(blockingProcess('ats', {ets2: false, ats: true, client: true})).toBe('GAME_RUNNING');
    expect(blockingProcess('ets2', {ets2: false, ats: false, client: true})).toBe('CLIENT_RUNNING');
    expect(blockingProcess('ats', {ets2: false, ats: false, client: true})).toBe('CLIENT_RUNNING');
    expect(blockingProcess('ets2', {ets2: false, ats: false, client: false})).toBeNull();
  });
});

describe('the fixed tasklist call', () => {
  it('runs absolute tasklist.exe with fixed arguments, a hidden window, no shell, 10 s and 1 MiB', async () => {
    const {execFile, calls} = stub({stdout: [row('explorer.exe', 10), row('TruckersMP-Launcher.exe', 11)].join('\r\n')});
    expect(await checkRunningGames({execFile, env})).toEqual({ok: true, running: {ets2: false, ats: false, client: true}});
    expect(calls).toEqual([{file: 'C:\\Windows\\System32\\tasklist.exe', args: ['/fo', 'csv', '/nh'],
      options: {encoding: 'buffer', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false}}]);
  });

  it.each([
    ['a timeout', {error: {killed: true, signal: 'SIGTERM'}}, 'timeout'],
    ['oversized output', {error: {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}}, 'output-too-large'],
    ['a non-zero exit', {error: {code: 1}}, 'failed'],
    ['unparseable output', {stdout: 'ERROR: Access denied'}, 'output-invalid']
  ])('reports %s as RUNNING_CHECK_FAILED', async (_name, reply, reason) => {
    const {execFile} = stub(reply);
    expect(await checkRunningGames({execFile, env})).toEqual({ok: false, code: 'RUNNING_CHECK_FAILED', reason});
  });

  // A hang guard above TASKLIST_TIMEOUT_MS, so a slow listing on a loaded host fails as the product's own timeout, not as
  // Vitest's default 5 s case timeout.
  const REAL_RUN_GUARD_MS = 20_000;
  it.runIf(process.platform === 'win32')('lists its own node.exe in a real run', async () => {
    expect(REAL_RUN_GUARD_MS).toBeGreaterThan(TASKLIST_TIMEOUT_MS);
    const listing = await listProcesses();
    expect(listing).toMatchObject({ok: true});
    if (!listing.ok) return;
    expect(listing.rows.filter(entry => entry.pid === process.pid).map(entry => entry.name.toLowerCase())).toEqual(['node.exe']);
  }, REAL_RUN_GUARD_MS);
});
