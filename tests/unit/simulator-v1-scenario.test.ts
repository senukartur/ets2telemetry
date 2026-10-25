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
