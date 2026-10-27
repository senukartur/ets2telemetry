import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {AppHealth, PluginSetupView, SettingsView} from '../../packages/contracts/src';
import {
  buildDiagnosticBundle, DIAGNOSTIC_BUNDLE_MAX_BYTES, DIAGNOSTIC_LOG_ROW_LIMIT, diagnosticLogRow, readDiagnosticLogs, readFileTail, REDACTED, type DiagnosticBundleInput
} from '../../apps/desktop/src/diagnostic-bundle';
import {temporaryResources} from '../shared/resources';

// REG-015, REG-017 (ET-017 PR-6, P17): the diagnostic bundle. Its format, the reduction of log rows to {time, event,
// facts}, the redaction of paths and of the user and computer names, and the 2 MiB bound. The injected user and
// computer names and paths are invented; expected documents are written by hand from P17.

const USER = 'Jane.Doe', MACHINE = 'TRUCKER-PC7';
const HEALTH: AppHealth = {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null};
const SETTINGS: SettingsView = {language: 'en', autostart: false, units: {ets2: 'metric', ats: 'us-customary'}, gearDisplay: {ets2: 'manual', ats: 'automatic'}, overlay: {enabled: true, backgroundOpacity: 80, layout: 'strip', sections: {
  'speed': true, 'gear': true, 'rpm': true, 'fuel': true, 'range': true, 'sdk-consumption': true, 'cargo': true, 'origin': true, 'destination': true,
  'distance-driven': true, 'distance-remaining': true, 'deadline': true, 'expected-income': true, 'game-time': true, 'mandatory-break': true},
placements: {strip: {x: 0.5, y: 0, scale: 1}, card: {x: 1, y: 0, scale: 1}, cluster: {x: 0, y: 1, scale: 1}, hud: {x: 0, y: 0, scale: 1}}},
state: 'defaults', writable: true, saveError: null};
const PLUGINS: PluginSetupView = {mode: 'active', bundled: {version: '0.2.0', sha256Prefix: '0123456789ab'}, running: false, games: {
  ets2: {excluded: false, discovery: 'found', manualFolder: 'none', unlistedFolders: 0, targets: [{id: 'ets2:steam:0', source: 'steam', ordinal: 0, state: 'installed',
    reason: null, installed: {version: '0.2.0', sha256Prefix: '0123456789ab'}, lastFailure: null}]},
  ats: {excluded: false, discovery: 'not-found', manualFolder: 'none', unlistedFolders: 0, targets: []}}};
const line = (value: unknown) => JSON.stringify(value);
function input(overrides: Partial<DiagnosticBundleInput> = {}): DiagnosticBundleInput {
  return {
    createdMs: Date.UTC(2026, 9, 17, 8, 30, 15, 250),
    app: {version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: '10.0.26200'},
    health: HEALTH, settings: SETTINGS, plugins: PLUGINS, live: {status: 'waiting', selection: 'ets2'}, diagnosis: {code: 'NO_RUNNING_SOURCE', notes: []},
    logs: {main: {current: [
      line({time: '2026-10-17T08:30:00.000Z', pid: 4242, event: 'APP_START', detail: {electron: '44.7.0'}}),
      line({time: '2026-10-17T08:30:02.000Z', pid: 4242, event: 'PLUGIN_ACTION', facts: {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null}})
    ].join('\n') + '\n'}, service: {current: line({time: '2026-10-17T08:30:01.000Z', pid: 4343, event: 'SERVICE_READY'}) + '\n'}},
    identities: [USER, MACHINE],
    ...overrides
  };
}
const parse = (text: string) => JSON.parse(text) as Record<string, unknown> & {logs: {main: unknown[]; service: unknown[]}; omittedLogRows: {main: number; service: number}};

describe('the format', () => {
  it('is one JSON document with the versions, the views, the live status, the diagnosis and the reduced log rows', () => {
    const text = buildDiagnosticBundle(input());
    expect(text.endsWith('}\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      format: 'ets2telemetry.diagnostics', version: 1, createdUtc: '2026-10-17T08:30:15.250Z',
      app: {version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: '10.0.26200'},
      health: HEALTH, settings: SETTINGS, plugins: PLUGINS, bundledPlugin: {version: '0.2.0', sha256Prefix: '0123456789ab'},
      live: {status: 'waiting', selection: 'ets2'}, diagnosis: {code: 'NO_RUNNING_SOURCE', notes: []},
      logs: {
        main: [{time: '2026-10-17T08:30:00.000Z', event: 'APP_START'},
          {time: '2026-10-17T08:30:02.000Z', event: 'PLUGIN_ACTION', facts: {game: 'ets2', source: 'steam', ordinal: 0, op: 'install', outcome: 'installed', code: null, step: null, errno: null}}],
        service: [{time: '2026-10-17T08:30:01.000Z', event: 'SERVICE_READY'}]
      },
      omittedLogRows: {main: 0, service: 0}
    });
  });
  it('puts the rotated file before the current one and keeps at most the last 2000 rows of each log', () => {
    const rows = (from: number, count: number) => Array.from({length: count}, (_, index) => line({time: '2026-10-17T08:30:00.000Z', event: 'ROW', facts: {n: from + index}})).join('\n');
    const bundle = parse(buildDiagnosticBundle(input({logs: {main: {previous: rows(0, 1500), current: rows(1500, 1000)}, service: {}}})));
    expect(bundle.logs.main).toHaveLength(DIAGNOSTIC_LOG_ROW_LIMIT);
    expect(bundle.logs.main[0]).toEqual({time: '2026-10-17T08:30:00.000Z', event: 'ROW', facts: {n: 500}});
    expect(bundle.logs.main.at(-1)).toEqual({time: '2026-10-17T08:30:00.000Z', event: 'ROW', facts: {n: 2499}});
    expect(bundle.omittedLogRows).toEqual({main: 500, service: 0});
    expect(bundle.logs.service).toEqual([]);
  });
});

describe('log rows', () => {
  it('keep only {time, event, facts}, dropping detail, pid and every other field', () => {
    expect(diagnosticLogRow(line({time: '2026-10-17T08:30:00.000Z', pid: 1, event: 'SERVICE_EXIT', detail: {message: 'ENOENT C:\\Users\\Jane.Doe\\x'}, stack: 'at C:\\x', facts: {code: 0}})))
      .toEqual({time: '2026-10-17T08:30:00.000Z', event: 'SERVICE_EXIT', facts: {code: 0}});
  });
  it.each([
    ['not JSON', '{"time": "2026-10-17T08:30:00.000Z", "event": "A'],
    ['an array', '[1, 2]'],
    ['no time', line({event: 'APP_START'})],
    ['an invalid time', line({time: 'yesterday', event: 'APP_START'})],
    ['an event that is not a fixed code', line({time: '2026-10-17T08:30:00.000Z', event: 'C:\\Users\\Jane.Doe'})]
  ])('leave out a line with %s', (_name, text) => {
    expect(diagnosticLogRow(text)).toBeUndefined();
  });
  it('count unreadable lines as omitted, such as a partial first line of a tail', () => {
    const bundle = parse(buildDiagnosticBundle(input({logs: {main: {current: 'e":"APP_START"}\n' + line({time: '2026-10-17T08:30:00.000Z', event: 'APP_START'})}, service: {}}})));
    expect(bundle.logs.main).toEqual([{time: '2026-10-17T08:30:00.000Z', event: 'APP_START'}]);
    expect(bundle.omittedLogRows.main).toBe(1);
  });
});

describe('redaction', () => {
  it.each([
    ['a drive path', 'C:\\Program Files (x86)\\Steam'],
    ['a forward-slash path', 'D:/SteamLibrary/steamapps/common'],
    ['a UNC path', '\\\\server\\share\\ETS2'],
    ['a relative path', 'steamapps\\common\\Euro Truck Simulator 2'],
    ['a bare drive', 'E:'],
    ['a drive after text', 'library on F:'],
    ['a POSIX-style path', '/home/driver']
  ])('replaces %s in a fact', (_name, value) => {
    expect(diagnosticLogRow(line({time: '2026-10-17T08:30:00.000Z', event: 'PLUGIN_DISCOVERY', facts: {library: value, count: 2}})))
      .toEqual({time: '2026-10-17T08:30:00.000Z', event: 'PLUGIN_DISCOVERY', facts: {library: REDACTED, count: 2}});
  });
  it('keeps fixed codes, target ids, versions and numbers, and replaces nested values and drops invalid keys', () => {
    expect(diagnosticLogRow(line({time: '2026-10-17T08:30:00.000Z', event: 'PLUGIN_ACTION', facts: {
      id: 'ets2:steam:0', version: '0.2.0', mode: 'test-root', ok: true, none: null, size: 12.5, nested: {path: 'x'}, list: ['a'], 'bad key': 'x', huge: Infinity
    }}))).toEqual({time: '2026-10-17T08:30:00.000Z', event: 'PLUGIN_ACTION', facts: {
      id: 'ets2:steam:0', version: '0.2.0', mode: 'test-root', ok: true, none: null, size: 12.5, nested: REDACTED, list: REDACTED, huge: null}});
  });
  it('replaces the user and computer names wherever they appear, in any case, but not inside other words', () => {
    const injected = input({
      app: {version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: `10.0 ${MACHINE.toLowerCase()}`},
      logs: {main: {current: [
        line({time: '2026-10-17T08:30:00.000Z', event: 'USER_SEEN', facts: {user: 'jane.doe', host: MACHINE, label: `${USER}-backup`, word: 'Jane.Doestown'}}),
        line({time: '2026-10-17T08:30:01.000Z', event: 'PATH_SEEN', facts: {where: `C:\\Users\\${USER}\\AppData\\Local\\ETS2Telemetry`}})
      ].join('\n')}, service: {}}
    });
    const text = buildDiagnosticBundle(injected);
    expect(text).not.toMatch(/jane\.doe(?![a-z])|trucker-pc7/i);
    expect(text).not.toContain('Users');
    const bundle = parse(text);
    expect(bundle.app).toEqual({version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: `10.0 ${REDACTED}`});
    expect(bundle.logs.main).toEqual([
      {time: '2026-10-17T08:30:00.000Z', event: 'USER_SEEN', facts: {user: REDACTED, host: REDACTED, label: `${REDACTED}-backup`, word: 'Jane.Doestown'}},
      {time: '2026-10-17T08:30:01.000Z', event: 'PATH_SEEN', facts: {where: REDACTED}}
    ]);
  });
  it('ignores empty and one-character names, which would erase ordinary text', () => {
    const bundle = parse(buildDiagnosticBundle(input({identities: [undefined, '', ' ', 'a']})));
    expect(bundle.live).toEqual({status: 'waiting', selection: 'ets2'});
  });
  it('never carries a path in a full bundle with path facts in every log', () => {
    const paths = ['C:\\Users\\Jane.Doe\\AppData\\Local\\ETS2Telemetry\\logs', 'D:\\SteamLibrary\\steamapps\\common\\Euro Truck Simulator 2\\bin\\win_x64\\plugins'];
    const rows = paths.map(where => line({time: '2026-10-17T08:30:00.000Z', event: 'SOMETHING', facts: {where}, detail: where})).join('\n');
    const text = buildDiagnosticBundle(input({logs: {main: {current: rows, previous: rows}, service: {current: rows}}}));
    expect(text).not.toMatch(/[A-Za-z]:\\\\|steamapps|win_x64|Users/);
  });
});

describe('the 2 MiB bound', () => {
  it('leaves out the oldest rows of the longer log until the bundle fits, and counts them', () => {
    // About 1.1 KB per row: 4000 kept rows are about twice the bound.
    const big = (prefix: string, count: number) => Array.from({length: count}, (_, index) => line({time: '2026-10-17T08:30:00.000Z', event: 'ROW', facts: {n: index, a: `${prefix}${'x'.repeat(240)}`, b: 'y'.repeat(250), c: 'z'.repeat(250), d: 'w'.repeat(250)}})).join('\n');
    const text = buildDiagnosticBundle(input({logs: {main: {previous: big('a', 2000), current: big('b', 2000)}, service: {previous: big('c', 2000), current: big('d', 2000)}}}));
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DIAGNOSTIC_BUNDLE_MAX_BYTES);
    const bundle = parse(text);
    // Each log first keeps its last 2000 rows (the current files), then the oldest of those go for the size bound.
    expect(bundle.omittedLogRows.main).toBeGreaterThan(2000);
    expect(bundle.omittedLogRows.main + bundle.logs.main.length).toBe(4000);
    expect(bundle.omittedLogRows.service + bundle.logs.service.length).toBe(4000);
    expect((bundle.logs.main.at(-1) as {facts: {n: number}}).facts.n).toBe(1999);
    expect((bundle.logs.service.at(-1) as {facts: {n: number}}).facts.n).toBe(1999);
  });
  it('stays well below the bound with full startup logs of the real logger size', () => {
    // The logger writes at most 256 KiB per file; four full files fit without dropping a row.
    const full = (count: number) => Array.from({length: count}, (_, index) => line({time: '2026-10-17T08:30:00.000Z', pid: 1, event: 'PLUGIN_ACTION', facts: {game: 'ets2', ordinal: index % 4}})).join('\n');
    const bundle = parse(buildDiagnosticBundle(input({logs: {main: {current: full(1500)}, service: {current: full(1500)}}})));
    expect(bundle.omittedLogRows).toEqual({main: 0, service: 0});
  });
});

describe('reading the logs', () => {
  let resources: Awaited<ReturnType<typeof temporaryResources>>;
  beforeEach(async () => { resources = await temporaryResources(); });
  afterEach(async () => { await resources.dispose(); });
  it('reads startup.jsonl[.1] and service\\startup.jsonl[.1] of the log directory, and a missing file as absent', async () => {
    const logs = path.join(resources.directory, 'logs');
    await mkdir(path.join(logs, 'service'), {recursive: true});
    await writeFile(path.join(logs, 'startup.jsonl'), 'main current');
    await writeFile(path.join(logs, 'startup.jsonl.1'), 'main previous');
    await writeFile(path.join(logs, 'service', 'startup.jsonl'), 'service current');
    expect(await readDiagnosticLogs(logs, readFileTail)).toEqual({main: {current: 'main current', previous: 'main previous'}, service: {current: 'service current', previous: undefined}});
  });
  it('reads only the tail of a file', async () => {
    const file = path.join(resources.directory, 'startup.jsonl');
    await writeFile(file, 'head\ntail');
    expect(await readFileTail(file, 4)).toBe('tail');
    expect(await readFileTail(path.join(resources.directory, 'missing.jsonl'), 4)).toBeUndefined();
  });
});

// PR #111 review: a user or computer name that equals a schema word must not change the document. Only runtime content
// (fact keys and string fact values, and the OS release text) is redacted; the format, keys and codes stay exact, also
// when the bundle has to be trimmed.
describe('names that collide with the schema', () => {
  const KEYS = ['format', 'version', 'createdUtc', 'app', 'health', 'settings', 'plugins', 'bundledPlugin', 'live', 'diagnosis', 'logs', 'omittedLogRows'];
  const collisionRow = (name: string, index = 0) => line({time: '2026-10-17T08:30:00.000Z', event: 'USER_SEEN',
    facts: {n: index, [name]: 'key of the name', owner: name.toUpperCase(), label: `${name} here`, pad: 'p'.repeat(250), pad2: 'q'.repeat(250), pad3: 'r'.repeat(250)}});
  const REDACTED_FACTS = {'<redacted>': 'key of the name', owner: REDACTED, label: `${REDACTED} here`};
  function assertSchema(text: string) {
    const bundle = parse(text);
    expect(Object.keys(bundle)).toEqual(KEYS);
    expect([bundle.format, bundle.version, bundle.createdUtc]).toEqual(['ets2telemetry.diagnostics', 1, '2026-10-17T08:30:15.250Z']);
    expect(bundle.app).toEqual({version: '0.1.0', electron: '44.7.0', node: '24.19.0', packaged: true, osRelease: '10.0.26200'});
    expect([bundle.health, bundle.settings, bundle.plugins, bundle.bundledPlugin, bundle.live, bundle.diagnosis])
      .toEqual([HEALTH, SETTINGS, PLUGINS, {version: '0.2.0', sha256Prefix: '0123456789ab'}, {status: 'waiting', selection: 'ets2'}, {code: 'NO_RUNNING_SOURCE', notes: []}]);
    expect(Object.keys(bundle.logs)).toEqual(['main', 'service']);
    expect(Object.keys(bundle.omittedLogRows)).toEqual(['main', 'service']);
    return bundle;
  }
  const NAMES = ['main', 'logs', 'diagnostics', 'ets2telemetry', 'format', 'plugins'];
  const AS = [['user', (name: string) => [name, 'TRUCKER-PC7']], ['computer', (name: string) => ['Jane.Doe', name]]] as const;
  for (const [role, identities] of AS) {
    it.each(NAMES)(`keeps a small bundle exact when the ${role} name is %s, and redacts it in the facts`, name => {
      const text = buildDiagnosticBundle(input({identities: identities(name), logs: {main: {current: collisionRow(name)}, service: {current: line({time: '2026-10-17T08:30:01.000Z', event: 'SERVICE_READY'})}}}));
      const bundle = assertSchema(text);
      expect(bundle.logs.main).toEqual([{time: '2026-10-17T08:30:00.000Z', event: 'USER_SEEN', facts: {n: 0, ...REDACTED_FACTS, pad: 'p'.repeat(250), pad2: 'q'.repeat(250), pad3: 'r'.repeat(250)}}]);
      expect(bundle.logs.service).toEqual([{time: '2026-10-17T08:30:01.000Z', event: 'SERVICE_READY'}]);
      expect(bundle.omittedLogRows).toEqual({main: 0, service: 0});
    });
    it.each(NAMES)(`keeps a trimmed bundle exact when the ${role} name is %s`, name => {
      const rows = (count: number) => Array.from({length: count}, (_, index) => collisionRow(name, index)).join('\n');
      const text = buildDiagnosticBundle(input({identities: identities(name), logs: {main: {previous: rows(2000), current: rows(2000)}, service: {current: rows(2000)}}}));
      expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(DIAGNOSTIC_BUNDLE_MAX_BYTES);
      const bundle = assertSchema(text);
      expect(bundle.omittedLogRows.main).toBeGreaterThan(2000);
      expect(bundle.omittedLogRows.main + bundle.logs.main.length).toBe(4000);
      expect(bundle.omittedLogRows.service + bundle.logs.service.length).toBe(2000);
      expect(bundle.logs.main.at(-1)).toMatchObject({event: 'USER_SEEN', facts: {n: 1999, ...REDACTED_FACTS}});
      expect(text.toLowerCase()).not.toMatch(new RegExp(`"${name}": "key of the name"|"owner": "${name}"`, 'i'));
    });
  }
});
