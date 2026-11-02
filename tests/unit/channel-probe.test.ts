// ET-051 (REG-009, REG-010): the development probe that records the raw SDK average consumption from the v0 diagnostics mode.
import {EventEmitter} from 'node:events';
import {mkdir, readFile} from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {decodePayload, type DiagnosticObservation, type HelloMessage, type SourceIdentity} from '../../packages/contracts/src/protocol-v0';
import {replay, type Scenario} from '../../tools/telemetry-simulator/src/scenario';
import {startPipe} from '../../tools/telemetry-simulator/src/pipe';
import {FRAMES_FILE, SUMMARY_FILE, frameLine, runProbe} from '../../tools/channel-probe/src/probe';
import {parseArguments, stagingBroker} from '../../tools/channel-probe/src/options';
import {summarize, type ProbeFrame, type RawValue} from '../../tools/channel-probe/src/summarize';
import {temporaryResources} from '../shared/resources';

let resources: Awaited<ReturnType<typeof temporaryResources>>;
beforeEach(async () => {resources = await temporaryResources();});
afterEach(async () => {await resources.dispose();});

const frame = (connection: number, ms: number, consumption: RawValue, speed: RawValue, coalesced = '0'): ProbeFrame =>
  ({connection, monotonicNs: String(ms * 1_000_000), simulation: 'running', consumption, speed, rpm: 1200, fuel: 400, coalescedSnapshots: coalesced, lostObservations: '0'});

describe('channel probe summary', () => {
  it('counts zero frames, runs, durations and the frame interval from a hand-written sequence', () => {
    // 10 ms frames: a single zero between close neighbours, a two-frame run (one of them -0), an unavailable reading,
    // a frame without the callback, and a zero that is still open when the capture ends.
    const consumption: RawValue[] = [0.35, 0, 0.3501, 0.35, 0, -0, 0.36, 'unavailable', null, 0];
    const speed: RawValue[] = [20, 20, 20, 20, 20, 20, 20, 0, 0, 0.1];
    const s = summarize(consumption.map((value, i) => frame(1, i * 10, value, speed[i], i === 9 ? '7' : '5')));
    expect(s.frames).toBe(10); expect(s.connections).toBe(1);
    expect(s.consumption).toEqual({observed: 8, unavailable: 1, absent: 1, zero: 4, negativeZero: 1, zeroPercent: 50,
      running: {frames: 8, zero: 4, zeroPercent: 50}, paused: {frames: 0, zero: 0, zeroPercent: 0},
      standing: {frames: 1, zero: 1, zeroPercent: 100}, moving: {frames: 7, zero: 3, zeroPercent: 42.9}});
    expect(s.zeroRuns.count).toBe(3); expect(s.zeroRuns.open).toBe(1);
    expect(s.zeroRuns.lengthFrames).toEqual({'1': 2, '2': 1, '3': 0, '4-10': 0, '11-60': 0, '61+': 0});
    // Closed runs: 10 → 20 ms and 40 → 60 ms. Run starts: 10, 40 and 90 ms.
    expect(s.zeroRuns.durationMs).toMatchObject({count: 2, median: 10, max: 20});
    expect(s.zeroRuns.startIntervalMs).toMatchObject({count: 2, median: 30, max: 50});
    expect(s.zeroRuns.singleFrameBetweenCloseNeighbours).toBe(1);
    expect(s.frameIntervalMs).toMatchObject({count: 9, median: 10, max: 10, approximateFps: 100});
    expect(s.missed).toEqual({coalescedSnapshots: '2', lostObservations: '0'});
  });
  it('never joins runs, intervals or counters across connections', () => {
    const s = summarize([frame(1, 0, 0.3, 20, '10'), frame(1, 10, 0, 20, '11'), frame(2, 5, 0, 20, '0'), frame(2, 15, 0.3, 20, '3')]);
    expect(s.connections).toBe(2);
    expect(s.zeroRuns).toMatchObject({count: 2, open: 1, lengthFrames: {'1': 2}, startIntervalMs: {count: 0}});
    expect(s.zeroRuns.durationMs).toMatchObject({count: 1, median: 10});
    expect(s.frameIntervalMs).toMatchObject({count: 2, median: 10});
    expect(s.missed.coalescedSnapshots).toBe('4');
  });
  it('keeps zero and unavailable distinct and writes -0 visibly', () => {
    const s = summarize([frame(1, 0, 'unavailable', 0), frame(1, 10, 'unavailable', 0)]);
    expect(s.consumption).toMatchObject({observed: 0, unavailable: 2, zero: 0, zeroPercent: 0});
    expect(s.zeroRuns.count).toBe(0);
    expect(frameLine(frame(1, 0, -0, 0))).toContain('"consumption":"-0"');
  });
});

const reading = (atMs: number, simulation: 'running' | 'paused' = 'running') => ({action: 'reading' as const, reading: {atMs, speedMps: 20, fuelL: 400, simulation, revision: '1', truck: null, gameMinute: '0'}});
const observations = (consumption: number | null, speed: number): DiagnosticObservation[] => [
  {channel: 'truck.fuel.consumption.average', sdkType: 'float', unit: 'raw', value: consumption === null ? {available: false, reason: 'invalid'} : {available: true, value: consumption}},
  {channel: 'truck.speed', sdkType: 'float', unit: 'raw', value: {available: true, value: speed}},
  {channel: 'synthetic.private', sdkType: 'string', unit: 'raw', value: {available: true, value: 'not-recorded'}}
];
const diagnostic = (atMs: number, consumption: number | null, speed = 20) => ({action: 'diagnostic' as const, atMs, observations: observations(consumption, speed)});
const scenario = (diagnostics = true): Scenario => ({id: 'synthetic-channel-probe', origin: 'synthetic', game: 'ets2', seed: 'channel-probe', diagnostics, steps: [
  {action: 'connect', atMs: 0}, reading(10), diagnostic(10, 0.35), reading(20), diagnostic(20, 0), reading(30), diagnostic(30, 0.3501), {action: 'disconnect', atMs: 31},
  {action: 'connect', atMs: 40}, reading(50, 'paused'), diagnostic(50, null, 0), diagnostic(60, 0, 0), {action: 'disconnect', atMs: 61}
]});
/** A broker-like socket replaying one connection's frames after the hello, then ending. */
class FakeSocket extends EventEmitter {
  hello?: HelloMessage['data'];
  constructor(private readonly frames: Uint8Array[], readonly authority?: SourceIdentity) {super(); setImmediate(() => this.emit('connect'));}
  write(bytes: Uint8Array): void {
    this.hello = (decodePayload(bytes.subarray(4)) as HelloMessage).data;
    setImmediate(() => {for (const frame of this.frames) this.emit('data', frame); this.emit('end'); this.emit('close');});
  }
  destroy(): void {}
}
async function output(directory: string) {
  const lines = (await readFile(path.join(directory, FRAMES_FILE), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as ProbeFrame);
  const text = await readFile(path.join(directory, SUMMARY_FILE), 'utf8');
  return {lines, summary: JSON.parse(text) as {origin: string; stopReason: string; summary: ReturnType<typeof summarize>}, text: text + await readFile(path.join(directory, FRAMES_FILE), 'utf8')};
}

describe('channel probe capture', () => {
  it('opts into diagnostics, pairs each batch with its snapshot and records only the fixed channels', async () => {
    const emissions = replay(scenario()), connections = [1, 2].map(n => emissions.filter(e => e.connection === n).map(e => e.frame));
    const sockets: FakeSocket[] = [], controller = new AbortController(), directory = path.join(resources.directory, 'probe');
    const result = await runProbe({output: directory, game: 'ets2', origin: 'synthetic', seconds: 60, retryMs: 1, signal: controller.signal,
      connect: () => {const socket = new FakeSocket(connections[sockets.length] ?? []); sockets.push(socket); if (sockets.length === 3) controller.abort(); return socket;}});
    expect(sockets[0].hello).toMatchObject({diagnostics: true, minMinor: 0, maxMinor: 0});
    expect(result.stopReason).toBe('interrupted');
    const {lines, summary, text} = await output(directory);
    expect(lines.map(l => [l.connection, l.simulation, l.consumption, l.speed])).toEqual([[1, 'running', 0.35, 20], [1, 'running', 0, 20], [1, 'running', 0.3501, 20], [2, 'paused', 'unavailable', 0], [2, null, 0, 0]]);
    expect(lines.every(l => l.rpm === null && l.fuel === null)).toBe(true);
    expect(summary).toMatchObject({origin: 'synthetic', stopReason: 'interrupted', summary: {frames: 5, connections: 2, consumption: {observed: 4, zero: 2, unavailable: 1}, zeroRuns: {count: 2, open: 1}}});
    // No source identity and no other channel reaches the output.
    const source = emissions[0].message.source;
    for (const value of [source.pluginSessionId, source.processInstanceId, 'not-recorded', 'synthetic.private']) expect(text).not.toContain(value);
  });
  it('stops when the plugin does not enable diagnostics', async () => {
    const frames = replay(scenario(false)).filter(e => e.connection === 1).map(e => e.frame);
    const result = await runProbe({output: path.join(resources.directory, 'refused'), game: 'ets2', origin: 'synthetic', seconds: 60, connect: () => new FakeSocket(frames)});
    expect(result.stopReason).toBe('diagnostics-refused'); expect(result.summary.frames).toBe(0);
  });
  it('rejects a game frame whose source differs from the broker authority', async () => {
    const frames = replay(scenario()).filter(e => e.connection === 1).map(e => e.frame);
    const authority: SourceIdentity = {...replay(scenario())[0].message.source, origin: 'game'};
    const result = await runProbe({output: path.join(resources.directory, 'mismatch'), game: 'ets2', origin: 'game', seconds: 60, connect: () => new FakeSocket(frames, authority)});
    expect(result.stopReason).toBe('protocol-error'); expect(result.summary.frames).toBe(0);
  });
  it('refuses an existing output directory and out-of-range durations before connecting', async () => {
    const connect = () => {throw new Error('must not connect');};
    await mkdir(path.join(resources.directory, 'exists'));
    await expect(runProbe({output: path.join(resources.directory, 'exists'), game: 'ets2', origin: 'synthetic', seconds: 60, connect})).rejects.toThrow();
    await expect(runProbe({output: path.join(resources.directory, 'long'), game: 'ets2', origin: 'synthetic', seconds: 3601, connect})).rejects.toThrow('--seconds');
  });
  it.runIf(process.platform === 'win32')('records two connections from the simulator over a real named pipe', async () => {
    const run = await startPipe(replay(scenario())), controller = new AbortController(), directory = path.join(resources.directory, 'pipe');
    let ended = 0;
    try {
      const result = await runProbe({output: directory, game: 'ets2', origin: 'synthetic', seconds: 60, retryMs: 20, signal: controller.signal, connect: () => net.connect(run.endpoint),
        log: line => {if (line.startsWith('Connection ended') && ++ended === 2) controller.abort();}});
      expect(result.stopReason).toBe('interrupted');
    } finally {await run.stop().catch(() => {});}
    const {lines, summary} = await output(directory);
    expect(lines.map(l => [l.connection, l.consumption])).toEqual([[1, 0.35], [1, 0], [1, 0.3501], [2, 'unavailable'], [2, 0]]);
    expect(summary.summary.zeroRuns).toMatchObject({count: 2, open: 1, singleFrameBetweenCloseNeighbours: 1});
  });
});

describe('channel probe options', () => {
  it('requires a game and a new output, pairs --broker with --discovery-dir and limits the fixture endpoint', () => {
    expect(parseArguments(['--game', 'ats', '--output', 'out'])).toEqual({'--game': 'ats', '--output': 'out'});
    for (const argv of [['--output', 'out'], ['--game', 'ets3', '--output', 'out'], ['--game', 'ets2', '--output', 'out', '--broker', 'b.exe'],
      ['--game', 'ets2', '--output', 'out', '--fixture-endpoint', '\\\\.\\pipe\\anything'], ['--game', 'ets2', '--output', 'out', '--unknown', 'x'], ['--game', 'ets2', '--game', 'ats', '--output', 'out']])
      expect(() => parseArguments(argv)).toThrow('Usage');
  });
  it('resolves the newest installed staging broker and the staging discovery directory', async () => {
    const root = path.join(resources.directory, 'ETS2TelemetryStagingDesktop');
    for (const name of ['app-0.1.0-stg000969', 'app-0.1.0-stg001000', 'app-0.1.0-stg000948', 'packages']) await mkdir(path.join(root, name), {recursive: true});
    expect(await stagingBroker(resources.directory)).toEqual({executable: path.win32.join(root, 'app-0.1.0-stg001000', 'resources', 'telemetry-client', 'telemetry-pipe-client.exe'),
      discoveryDirectory: path.win32.join(resources.directory, 'ETS2TelemetryStaging', 'transport', 'v0')});
  });
});
