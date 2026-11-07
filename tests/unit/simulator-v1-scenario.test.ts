import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {builtinModules} from 'node:module';
import {describe, expect, it} from 'vitest';
import {readFixtureFile} from '../../tools/telemetry-simulator/src/fixture-file';
import {validateScenario} from '../../tools/telemetry-simulator/src/v1/scenario';
import {MAX_TRANSCRIPT_MESSAGES, replayV1, transcriptLines} from '../../tools/telemetry-simulator/src/v1/replay';
import {scenarioPath, summarize} from '../shared/simulator-v1-expected';

type Json = Record<string, unknown>;
const base = () => readFixtureFile(scenarioPath('normal-delivery')) as Json;
const steps = (s: Json) => s.steps as Json[];
const transport = (s: Json) => s.transport as Json[];
const source = (s: Json) => s.source as Json;
function variant(edit: (s: Json) => void): Json { const s = base(); edit(s); return s; }
const job = (atMs: number, extra: Json = {}): Json => ({atMs, action: 'configuration', id: 'job', attributes: [], ...extra});
// Reaching the transcript limit needs 20,000 real encoded and decoded messages: up to about 1.5 s of CPU work in a
// default-worker run and more than 5 s when every core is busy. This budget bounds that computation; the case asserts
// no timing.
const TRANSCRIPT_LIMIT_REPLAY_BUDGET_MS = 30_000;

describe('simulator v1 scenario schema', () => {
  it('accepts the corpus format and rebuilds it without aliasing the input', () => {
    const input = base(), before = JSON.stringify(input), scenario = validateScenario(input);
    expect(scenario.steps).not.toBe(input.steps);
    steps(input)[0].atMs = 999_999;
    expect(scenario.steps[0].atMs).toBe(10);
    steps(input)[0].atMs = 10;
    expect(JSON.stringify(input)).toBe(before);
  });

  it.each([
    ['root', (s: Json) => { s.unused = 1; }],
    ['source', (s: Json) => { source(s).processId = 4; }],
    ['source step', (s: Json) => { steps(s)[0].unused = true; }],
    ['attribute', (s: Json) => { (steps(s)[0].attributes as Json[])[0].arrayIndex = 1; }],
    ['frame channel', (s: Json) => { (steps(s)[4].channels as Json)['truck.speed'] = 1; }],
    ['client', (s: Json) => { (transport(s)[0].client as Json).replayFaults = true; }],
    ['transport step', (s: Json) => { transport(s)[1].client = {durable: true}; }],
    ['missing field', (s: Json) => { delete s.purpose; }]
  ])('rejects an unknown or missing field at %s', (_, edit) => expect(() => validateScenario(variant(edit))).toThrow(/Invalid simulator v1 scenario/));

  it('requires provenance for replay origins; the simulator never emits game', () => {
    expect(() => validateScenario(variant(s => { s.origin = 'game'; }))).toThrow(/never emits origin game/);
    expect(() => validateScenario(variant(s => { s.origin = 'replay'; }))).toThrow(/replay requires capture provenance/);
    expect(() => validateScenario(variant(s => { s.provenance = {run: 'x'}; }))).toThrow(/provenance/);
    expect(() => validateScenario(variant(s => { s.format = 'ets2telemetry-simulator-v0'; }))).toThrow(/format/);
  });

  it('rejects disordered or impossible timelines', () => {
    expect(() => validateScenario(variant(s => { steps(s)[1].atMs = 5; }))).toThrow(/ordered by atMs/);
    expect(() => validateScenario(variant(s => { steps(s).splice(1, 0, {atMs: 15, action: 'suspend', durationMs: 100, sourceClockAdvances: true}); }))).toThrow(/suspended/);
    expect(() => validateScenario(variant(s => { steps(s).splice(3, 0, {atMs: 35, action: 'shutdown', reason: 'plugin-shutdown'}); }))).toThrow(/follow shutdown/);
    expect(() => validateScenario(variant(s => { transport(s).splice(1, 0, {atMs: 500, action: 'connect', client: {durable: true}}); }))).toThrow(/one client at a time/);
    expect(() => validateScenario(variant(s => { transport(s).unshift({atMs: 0, action: 'disconnect'}); }))).toThrow(/without a connection/);
    expect(() => validateScenario(variant(s => { (transport(s)[0].client as Json).probes = [1000, 1500]; }))).toThrow(/1,000 ms apart/);
    expect(() => validateScenario(variant(s => { (transport(s)[0].client as Json).probes = [2000]; }))).toThrow(/needs its connection/);
  });

  it('rejects inexact or out-of-range SDK values and inconsistent session options', () => {
    const attr = (a: Json) => variant(s => { steps(s)[0].attributes = [a]; });
    expect(() => validateScenario(attr({name: 'fuel.capacity', sdkType: 'float', value: 0.1}))).toThrow(/float32-exact/);
    expect(() => validateScenario(attr({name: 'cargo.unit.count', sdkType: 'u32', value: 4_294_967_296}))).toThrow(/integer/);
    expect(() => validateScenario(attr({name: 'income', sdkType: 'u64', value: '018'}))).toThrow(/u64/);
    expect(() => validateScenario(attr({name: 'revenue', sdkType: 's64', value: '-0'}))).toThrow(/s64/);
    expect(() => validateScenario(attr({name: 'revenue', sdkType: 's64', value: 12}))).toThrow(/s64/);
    expect(() => validateScenario(variant(s => { steps(s)[0].list = 'null'; }))).toThrow(/null attribute list/);
    expect(() => validateScenario(variant(s => { steps(s)[10].list = 'unterminated'; }))).toThrow(/unterminated attribute list/);
    expect(validateScenario(variant(s => { steps(s)[0].list = 'unterminated'; })).steps[0]).toMatchObject({list: 'unterminated'});
    expect(() => validateScenario(variant(s => { transport(s)[0].client = {durable: false, commit: 'each'}; }))).toThrow(/live-only/);
    expect(() => validateScenario(variant(s => { (transport(s)[0].client as Json).commit = 'failAt:0'; }))).toThrow(/commit/);
    expect(() => validateScenario(variant(s => { source(s).gameplayEvents = 'not-supported'; }))).toThrow(/not registered/);
    expect(() => validateScenario(variant(s => { steps(s).push({atMs: 700, action: 'gameMode', mode: 'single-player', method: 'module-scan', confidence: 'weak'}); }))).toThrow(/synthetic detection/);
    expect(() => validateScenario(variant(s => { source(s).gameMode = 'synthetic-detection'; steps(s).push({atMs: 700, action: 'gameMode', mode: 'single-player', method: 'module-scan', confidence: 'strong'}); }))).toThrow(/D9/);
    expect(() => validateScenario(variant(s => { source(s).startEventSeq = '18446744073709551615'; }))).toThrow(/startEventSeq/);
    expect(() => validateScenario(variant(s => { steps(s)[0].id = 'trailer.10'; }))).toThrow(/one of/);
  });

  it('enforces the step, time, repeat and attribute caps', () => {
    expect(() => validateScenario(variant(s => { s.steps = Array.from({length: 999}, (_, i) => job(i)); }))).toThrow(/at most 1000 steps/);
    expect(() => validateScenario(variant(s => { steps(s)[0].repeat = 1_001; }))).toThrow(/repeat/);
    expect(() => validateScenario(variant(s => { transport(s)[1].atMs = 86_400_001; }))).toThrow(/atMs/);
    expect(() => validateScenario(variant(s => { steps(s)[0].attributes = Array.from({length: 256}, () => ({name: 'id', sdkType: 'string', value: 'x'})); }))).toThrow(/attributes/);
  });

  it('bounds one replay at 20,000 transcript messages', () => {
    const big = variant(s => { s.steps = Array.from({length: 11}, (_, i) => ({atMs: i, action: 'gameplay', id: 'player.tollgate.paid', attributes: [], repeat: 1_000})); });
    expect(MAX_TRANSCRIPT_MESSAGES).toBe(20_000);
    expect(() => replayV1(big)).toThrow(/transcript limit/);
  }, TRANSCRIPT_LIMIT_REPLAY_BUDGET_MS);

  it('rejects duplicate keys through the bounded strict reader', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ETS2Telemetry-SYNTHETIC-TEST-v1-scenario-'));
    try {
      const path = join(directory, 'duplicate.json');
      writeFileSync(path, readFileSync(scenarioPath('normal-delivery'), 'utf8').replace('"seed":', '"seed": "shadow", "seed":'));
      expect(() => readFixtureFile(path)).toThrow(/duplicate/);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  });
});

// ET-052: the break channel in a scenario, with variants of the frozen normal-delivery corpus file (the file is untouched).
// normal-delivery's frames are at 100 ms and 200 ms and its single client connects at 0 and disconnects at 1,100 ms.
describe('simulator v1 mandatory break scenarios (ET-052)', () => {
  const frames = (s: Json) => steps(s).filter(step => step.action === 'frame');
  const withBreak = (first: unknown, second?: unknown) => variant(s => {
    (frames(s)[0].channels as Json)['mandatory.break'] = first;
    if (second !== undefined) (frames(s)[1].channels as Json)['mandatory.break'] = second;
  });
  const clientMinor = (maxMinor?: number) => (s: Json) => { if (maxMinor !== undefined) (transport(s)[0].client as Json).maxMinor = maxMinor; };
  const states = (s: Json) => replayV1(s).transcript.flatMap(l => l.message.kind === 'checkpoint' || l.message.kind === 'snapshot' ? [l.message] : []);

  it.each([[95], [0], [-30], [2147483647], [-2147483648], [null], ['invalid']])('accepts the frame channel mandatory.break = %j', value => {
    const scenario = validateScenario(withBreak(value));
    expect((frames(scenario as unknown as Json)[0]).channels).toMatchObject({'mandatory.break': value});
  });
  it.each([[45.5], [2147483648], [-2147483649], ['95'], [true], [{}]])('rejects the frame channel mandatory.break = %j', value => {
    expect(() => validateScenario(withBreak(value))).toThrow(/Invalid simulator v1 scenario/);
  });
  // ET-071 widened the offer to 3; 4 is the first rejected maximum.
  it.each([[0], [1], [2], [3]])('accepts the client offer maxMinor %d and rejects 4 and a fraction', maxMinor => {
    expect(validateScenario(variant(clientMinor(maxMinor))).transport[0]).toMatchObject({client: {maxMinor}});
    expect(() => validateScenario(variant(clientMinor(4)))).toThrow(/maxMinor/);
    expect(() => validateScenario(variant(s => { (transport(s)[0].client as Json).maxMinor = 1.5; }))).toThrow(/maxMinor/);
    expect(() => validateScenario(variant(s => { (transport(s)[0].client as Json).maxMinor = '2'; }))).toThrow(/maxMinor/);
  });
  it('accepts the optional source mandatoryBreak option and rejects another value or a break the session did not register', () => {
    expect(validateScenario(variant(s => { source(s).mandatoryBreak = 'not-supported'; })).source.mandatoryBreak).toBe('not-supported');
    expect(validateScenario(variant(s => { source(s).mandatoryBreak = 'registered'; (frames(s)[0].channels as Json)['mandatory.break'] = 5; })).source.mandatoryBreak).toBe('registered');
    expect(validateScenario(base()).source).not.toHaveProperty('mandatoryBreak');
    expect(() => validateScenario(variant(s => { source(s).mandatoryBreak = 'maybe'; }))).toThrow(/one of/);
    expect(() => validateScenario(variant(s => { source(s).mandatoryBreak = 'not-supported'; (frames(s)[0].channels as Json)['mandatory.break'] = 5; }))).toThrow(/not registered/);
  });
  it('serves a changing break on minor 3 by default (ET-071): 95, then 0, with not-observed before the first callback', () => {
    const s = withBreak(95, 0), all = states(s);
    const breaks = all.map(m => m.data.state.nextMandatoryBreak);
    expect(all.every(m => m.version.minor === 3)).toBe(true);
    // The checkpoint precedes the first frame; the snapshots then follow the frames at 100 ms and 200 ms.
    expect(breaks[0]).toEqual({available: false, reason: 'not-observed', unit: 'min'});
    expect(breaks).toContainEqual({available: true, value: 95, unit: 'min'});
    expect(breaks.at(-1)).toEqual({available: true, value: 0, unit: 'min'});
    // 95 is served before 0, and 0 is the last reading.
    expect(breaks.findIndex(b => b?.available && b.value === 95)).toBeLessThan(breaks.length - 1);
  });
  it('serves negative values and the unavailable readings unchanged', () => {
    expect(states(withBreak(-30)).at(-1)!.data.state.nextMandatoryBreak).toEqual({available: true, value: -30, unit: 'min'});
    expect(states(withBreak(null, null)).at(-1)!.data.state.nextMandatoryBreak).toEqual({available: false, reason: 'not-observed', unit: 'min'});
    expect(states(withBreak('invalid', 'invalid')).at(-1)!.data.state.nextMandatoryBreak).toEqual({available: false, reason: 'invalid', unit: 'min'});
    expect(states(variant(s => { source(s).mandatoryBreak = 'not-supported'; })).at(-1)!.data.state.nextMandatoryBreak).toEqual({available: false, reason: 'not-supported', unit: 'min'});
  });
  it('serves minor 1 or minor 0 bytes without the break to a client that offers less, with the same events and ledger', () => {
    const at = (maxMinor: number) => { const s = withBreak(95, 0); clientMinor(maxMinor)(s); return replayV1(s); };
    const full = at(3);
    for (const [maxMinor, gearbox] of [[1, true], [0, false]] as const) {
      const result = at(maxMinor), all = result.transcript.flatMap(l => l.message.kind === 'checkpoint' || l.message.kind === 'snapshot' ? [l.message] : []);
      expect(all.length).toBeGreaterThan(0);
      for (const m of all) { expect(m.version.minor).toBe(maxMinor); expect(Object.hasOwn(m.data.state, 'nextMandatoryBreak')).toBe(false); expect(Object.hasOwn(m.data.state, 'gearbox')).toBe(gearbox); }
      expect(result.ledger).toEqual(full.ledger);
      expect(result.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.record] : [])).toEqual(full.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.record] : []));
    }
  });
  it.each([[0], [1], [2], [3]])('models a simulated older plugin with source.highestMinor %d: a minor-3 offer is answered with its own highest minor', highestMinor => {
    const s = withBreak(95, 0); source(s).highestMinor = highestMinor;
    expect(validateScenario(s).source.highestMinor).toBe(highestMinor);
    const all = states(s), full = replayV1(withBreak(95, 0));
    expect(all.length).toBeGreaterThan(0);
    for (const m of all) {
      expect(m.version.minor).toBe(highestMinor);
      expect([Object.hasOwn(m.data.state, 'gearbox'), Object.hasOwn(m.data.state, 'nextMandatoryBreak'), Object.hasOwn(m.data.state, 'cruiseControl')])
        .toEqual([highestMinor >= 1, highestMinor >= 2, highestMinor >= 3]);
    }
    const older = replayV1(s);
    expect(older.ledger).toEqual(full.ledger);
    expect(older.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.record] : [])).toEqual(full.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.record] : []));
  });
  it('rejects a highest minor above 3, a fraction and a string', () => {
    for (const value of [4, 1.5, '1', -1]) expect(() => validateScenario(variant(s => { source(s).highestMinor = value; }))).toThrow(/highestMinor/);
  });
  it('gives the same events and the same boundary orders whether or not the game provides the break channel', () => {
    const plain = replayV1(base()), withChannel = replayV1(withBreak(95, 0));
    const boundaries = (r: typeof plain) => r.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.occurred.boundaryOrder] : []);
    expect(boundaries(withChannel)).toEqual(boundaries(plain));
    expect(withChannel.ledger).toEqual(plain.ledger);
  });
});

// ET-071: the cruise control channel in scenarios, with the break's rules: a float32 m/s value, null or "invalid"; an
// optional refused registration; minor 3 only.
describe('simulator v1 cruise control scenarios (ET-071)', () => {
  const frames = (s: Json) => steps(s).filter(step => step.action === 'frame');
  const withCruise = (first: unknown, second?: unknown) => variant(s => {
    (frames(s)[0].channels as Json)['cruise_control'] = first;
    if (second !== undefined) (frames(s)[1].channels as Json)['cruise_control'] = second;
  });
  const states = (s: Json) => replayV1(s).transcript.flatMap(l => l.message.kind === 'checkpoint' || l.message.kind === 'snapshot' ? [l.message] : []);

  it.each([[25], [0], [22.5], [1000], [-1], [1000.5], [null], ['invalid']])('accepts the frame channel cruise_control = %j', value => {
    expect((frames(validateScenario(withCruise(value)) as unknown as Json)[0]).channels).toMatchObject({'cruise_control': value});
  });
  it.each([[0.1], ['25'], [true], [{}]])('rejects the frame channel cruise_control = %j', value => {
    expect(() => validateScenario(withCruise(value))).toThrow(/Invalid simulator v1 scenario/);
  });
  it('accepts the optional source cruiseControl option and rejects another value or a reading the session did not register', () => {
    expect(validateScenario(variant(s => { source(s).cruiseControl = 'not-supported'; })).source.cruiseControl).toBe('not-supported');
    expect(validateScenario(base()).source).not.toHaveProperty('cruiseControl');
    expect(() => validateScenario(variant(s => { source(s).cruiseControl = 'maybe'; }))).toThrow(/one of/);
    expect(() => validateScenario(variant(s => { source(s).cruiseControl = 'not-supported'; (frames(s)[0].channels as Json)['cruise_control'] = 25; }))).toThrow(/not registered/);
  });
  it('serves a set speed, then off, on minor 3, with not-observed before the first callback', () => {
    const all = states(withCruise(25, 0)), cruise = all.map(m => m.data.state.cruiseControl);
    expect(all.every(m => m.version.minor === 3)).toBe(true);
    expect(cruise[0]).toEqual({available: false, reason: 'not-observed', unit: 'm/s'});
    expect(cruise).toContainEqual({available: true, value: 25, unit: 'm/s'});
    expect(cruise.at(-1)).toEqual({available: true, value: 0, unit: 'm/s'});
  });
  it('serves an out-of-range value as invalid and the unavailable readings unchanged', () => {
    expect(states(withCruise(1000.5, -1)).at(-1)!.data.state.cruiseControl).toEqual({available: false, reason: 'invalid', unit: 'm/s'});
    expect(states(withCruise(null, null)).at(-1)!.data.state.cruiseControl).toEqual({available: false, reason: 'not-observed', unit: 'm/s'});
    expect(states(withCruise('invalid', 'invalid')).at(-1)!.data.state.cruiseControl).toEqual({available: false, reason: 'invalid', unit: 'm/s'});
    expect(states(variant(s => { source(s).cruiseControl = 'not-supported'; })).at(-1)!.data.state.cruiseControl).toEqual({available: false, reason: 'not-supported', unit: 'm/s'});
  });
  it('serves minor 2 bytes without cruise control to a client that offers 2, with the same events, ledger and boundary orders', () => {
    const offer2 = withCruise(25, 0); (transport(offer2)[0].client as Json).maxMinor = 2;
    const older = replayV1(offer2), full = replayV1(withCruise(25, 0)), plain = replayV1(base());
    const olderStates = older.transcript.flatMap(l => l.message.kind === 'checkpoint' || l.message.kind === 'snapshot' ? [l.message] : []);
    expect(olderStates.length).toBeGreaterThan(0);
    for (const m of olderStates) { expect(m.version.minor).toBe(2); expect(Object.hasOwn(m.data.state, 'cruiseControl')).toBe(false); }
    const records = (r: typeof full) => r.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.record] : []);
    const boundaries = (r: typeof full) => r.transcript.flatMap(l => l.message.kind === 'event' ? [l.message.data.occurred.boundaryOrder] : []);
    expect(older.ledger).toEqual(full.ledger); expect(records(older)).toEqual(records(full));
    expect(boundaries(full)).toEqual(boundaries(plain)); expect(full.ledger).toEqual(plain.ledger);
  });
});

describe('simulator v1 determinism', () => {
  it('repeats byte-identical transcripts in process without mutating the input', () => {
    const input = readFixtureFile(scenarioPath('save-load')), before = JSON.stringify(input);
    expect(transcriptLines(replayV1(input)).join('\n')).toBe(transcriptLines(replayV1(input)).join('\n'));
    expect(JSON.stringify(input)).toBe(before);
  });

  it('derives every identity from the seed and keeps outcomes independent of it', () => {
    const a = replayV1(base()), b = replayV1(variant(s => { s.seed = 'another-seed'; }));
    expect(a.transcript[1].message.kind === 'welcome' && b.transcript[1].message.kind === 'welcome' && a.transcript[1].message.source.pluginSessionId !== b.transcript[1].message.source.pluginSessionId).toBe(true);
    expect(summarize(b)).toEqual(summarize(a));
  });

  it('repeats byte-identical output through the built CLI, equal to the in-process transcript', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'ETS2Telemetry-SYNTHETIC-TEST-v1-cli-'));
    try {
      const {build} = await import('vite'), bundle = join(directory, 'bundle');
      await build({configFile: false, logLevel: 'silent', build: {outDir: bundle, emptyOutDir: true, lib: {entry: resolve('tools/telemetry-simulator/src/cli.ts'), formats: ['cjs'], fileName: () => 'cli.cjs'},
        rollupOptions: {external: [...builtinModules, ...builtinModules.map(x => `node:${x}`)]}}});
      const run = () => spawnSync(process.execPath, [join(bundle, 'cli.cjs'), 'replay-v1', scenarioPath('save-load')], {encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true});
      const first = run(), second = run();
      expect([first.status, second.status, first.stderr]).toEqual([0, 0, '']);
      expect(second.stdout).toBe(first.stdout);
      expect(first.stdout).toBe(transcriptLines(replayV1(readFixtureFile(scenarioPath('save-load')))).map(l => `${l}\n`).join(''));
      const usage = spawnSync(process.execPath, [join(bundle, 'cli.cjs'), 'replay-v1'], {encoding: 'utf8', timeout: 10_000, windowsHide: true});
      expect([usage.status, usage.stdout]).toEqual([1, '']);
    } finally { rmSync(directory, {recursive: true, force: true}); }
  }, 60_000);
});
