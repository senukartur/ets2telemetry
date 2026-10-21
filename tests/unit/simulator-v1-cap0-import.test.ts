import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {afterEach, describe, expect, it} from 'vitest';
import {importCap0} from '../../tools/telemetry-simulator/src/v1/cap0-import';
import {stepsDigest} from '../../tools/telemetry-simulator/src/v1/cap0-schema';
import {validateScenario} from '../../tools/telemetry-simulator/src/v1/scenario';
import {replayV1, transcriptLines} from '../../tools/telemetry-simulator/src/v1/replay';
import {header, envelope, end, observation} from '../shared/cap0-fixtures';
import type {Cap0Packet} from '../../packages/contracts/src/capture-cap0';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, {recursive: true, force: true}); });
type Json = Record<string, unknown>;
function fixture(packets: Cap0Packet[] = [header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: [observation(0, 'cargo', 'string', 'Private Cargo'), observation(1, 'income', 'u64', '1000')]}), end(2, 1)],
  change?: (manifest: Json, packets: Cap0Packet[]) => void): string {
  const dir = mkdtempSync(join(tmpdir(), 'et005-cap0-')); dirs.push(dir);
  const h = packets[0]; if (h.kind !== 'header') throw new Error('test header expected');
  const last = packets.at(-1)!;
  const manifest: Json = {format: 'ets2telemetry-cap0-capture-manifest', schemaVersion: 1, sanitized: true, captureSessionId: h.captureSessionId, origin: h.data.origin,
    status: 'complete', stop: {}, activation: {}, authority: structuredClone(h.data.source), header: h.data, clockDomains: {}, timing: {},
    counts: {packetsReceived: packets.length, packetsWritten: packets.length, bytesWritten: 0, packetsDiscarded: 0, bytesDiscarded: 0, envelopesCompleted: Number(last.kind === 'end' ? last.data.attemptedEnvelopes : 0)},
    loss: {pluginLoss: null, end: last.data, endMarkerReceived: true, envelopePartial: false, lastPacketSeq: last.packetSeq, lastEnvelopeSeq: last.kind === 'end' ? last.data.attemptedEnvelopes : '0', knownBoundaries: [], boundariesOmitted: 0},
    limits: {}, files: [], code: {}, platform: {}, displays: [], evidence: {}};
  change?.(manifest, packets);
  const text = packets.map((packet, i) => JSON.stringify({receipt: {seq: i + 1, monotonicNs: String(10_000 + i), utcUnixMs: String(i)}, packet})).join('\n') + '\n';
  manifest.files = [{name: 'packets.ndjson', bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex')}];
  writeFileSync(join(dir, 'packets.ndjson'), text);
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'export.json'), JSON.stringify({format: 'ets2telemetry-cap0-export', schemaVersion: 1, rawIntegrityVerified: true, counts: {}, rules: []}));
  return dir;
}
const events = (s: unknown) => replayV1(s).transcript.flatMap(l => l.message.kind === 'event' ? [l.message] : []);

describe('CAP0 sanitized export importer', () => {
  it('keeps synthetic captures synthetic; real captures become replay, never game', () => {
    const synthetic = importCap0(fixture(), 'test');
    const real = importCap0(fixture([header(0, 'game'), envelope(1, 1), end(2, 1)]), 'test');
    expect([synthetic.origin, real.origin]).toEqual(['synthetic', 'replay']);
    expect(events(real).map(m => m.source.origin)).toEqual(['replay']);
    expect(synthetic.provenance.build).toEqual({pluginSha256: null, sourceCommit: null, source: 'unrecorded'});
  });
  it('minimizes all non-identifier strings, including unused fields, retaining equality and empty/null distinctions', () => {
    const attrs = [observation(0, 'cargo', 'string', 'Secret Display'), observation(1, 'source.city', 'string', 'Secret Display'),
      observation(2, 'license.plate', 'string', 'PERSONAL'), observation(3, 'unused', 'string', 'C:\\Users\\Private\\profile'),
      observation(4, 'cargo.id', 'string', 'game_cargo'), observation(5, 'destination.city', 'string', ''), observation(6, 'source.company', 'string', 'x')];
    attrs[6].value = {available: false, reason: 'invalid', detail: 'null-value'};
    const dir = fixture([header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: attrs}), end(2, 1)]);
    const before = ['export.json', 'manifest.json', 'packets.ndjson'].map(f => readFileSync(join(dir, f)));
    const a = importCap0(dir, 'privacy'), b = importCap0(dir, 'privacy');
    expect(a).toEqual(b); expect(transcriptLines(replayV1(a))).toEqual(transcriptLines(replayV1(b)));
    const text = JSON.stringify(a);
    for (const privateText of ['Secret Display', 'PERSONAL', 'Private', 'profile', 'sdkFrame', 'processInstanceId', 'receipt', 'displays']) expect(text).not.toContain(privateText);
    expect(a.steps[0].action === 'capture' && a.steps[0].data.observations.map(o => o.value)).toEqual([
      {available: true, value: 'name-1'}, {available: true, value: 'name-1'}, {available: true, value: 'plate-1'}, {available: true, value: 'name-2'},
      {available: true, value: 'game_cargo'}, {available: true, value: ''}, {available: false, reason: 'invalid', detail: 'null-value'}]);
    expect(['export.json', 'manifest.json', 'packets.ndjson'].map(f => readFileSync(join(dir, f)))).toEqual(before);
  });
  it('assembles split attributes and rejects changed context in a continuation part', () => {
    const a = envelope(1, 1, {group: 'configuration', id: 'job', observations: [observation(0, 'cargo.id', 'string', 'cargo')], total: 2, final: false});
    const b = envelope(2, 1, {group: 'configuration', id: 'job', observations: [observation(1, 'income', 'u64', '123')], first: 1, total: 2});
    if (a.kind !== 'envelope' || b.kind !== 'envelope') throw new Error('test envelope expected');
    b.data.callbackMonotonicNs = a.data.callbackMonotonicNs;
    const scenario = importCap0(fixture([header(), a, b, end(3, 1)]), 'split');
    expect(events(scenario)[0].data.record).toMatchObject({type: 'job.configured', cargoId: {value: 'cargo'}, expectedIncome: {value: {raw: '123'}}});
    b.data.simulation = 'paused';
    expect(() => importCap0(fixture([header(), a, b, end(3, 1)]), 'split')).toThrow(/CAP0 import rejected/);
  });
  it.each(['a'.repeat(256), 'я'.repeat(128), '🚚'.repeat(64)])('preserves the v1 256-byte display-name boundary before tokenization', value => {
    expect(Buffer.byteLength(value, 'utf8')).toBe(256);
    const make = (name: string) => fixture([header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: [observation(0, 'cargo', 'string', name)]}), end(2, 1)]);
    expect(events(importCap0(make(value), 'name-boundary'))[0].data.record).toMatchObject({type: 'job.configured', cargo: {available: true, value: 'name-1'}});
    expect(Buffer.byteLength(value + 'a', 'utf8')).toBe(257);
    expect(() => importCap0(make(value + 'a'), 'name-overlength')).toThrow(/^CAP0 import rejected:/);
  });
  it.each(['cargo\nname', 'cargo\tname', 'cargo\u007fname'])('rejects CAP0-valid control characters before display-name tokenization', value => {
    const dir = fixture([header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: [observation(0, 'cargo', 'string', value)]}), end(2, 1)]);
    expect(() => importCap0(dir, 'name-control')).toThrow(/^CAP0 import rejected:/);
  });
  it.each(['150', '90'])('does not infer the immediately previous channel time from a prior callback when regression ends at %s', minutes => {
    const before = envelope(1, 1, {group: 'lifecycle', id: 'simulation.started'}), regression = envelope(2, 2, {group: 'lifecycle', id: 'game.time.regression'});
    if (before.kind !== 'envelope' || regression.kind !== 'envelope') throw new Error('test envelope expected');
    before.data.gameTime.minutes = {available: true, value: '100'};
    regression.data.gameTime = {minutes: {available: true, value: minutes}, clockId: '44444444-4444-4444-8444-000000000001'};
    // CAP0 observes no intervening game.time channel (it might have been 200). The earlier callback is not `from`.
    const result = replayV1(importCap0(fixture([header(), before, regression, end(3, 2)]), 'regression-context'));
    const captured = result.transcript.flatMap(l => l.message.kind === 'event' ? [l.message] : []);
    expect(captured).toHaveLength(2);
    expect(captured[1].data.record).toEqual({type: 'gameTime.regression',
      from: {minutes: {available: false, reason: 'not-observed'}, clockId: captured[0].data.occurred.gameTime.clockId},
      to: captured[1].data.occurred.gameTime});
    expect(captured[1].data.occurred.gameTime.minutes).toEqual({available: true, value: minutes});
    expect(captured[1].data.occurred.gameTime.clockId).not.toBe(captured[0].data.occurred.gameTime.clockId);
    expect(result.transcript.filter(l => l.message.kind === 'gap')).toEqual([]);
    expect(result.store.eventLoss.encodingFailed).toBe('0');
  });
  it('retains per-callback nanoseconds, game time, simulation and unavailable versus invalid', () => {
    const a = envelope(1, 1, {group: 'configuration', id: 'job', observations: [observation(0, 'cargo', 'string', 'unused')]});
    const b = envelope(2, 2, {group: 'lifecycle', id: 'simulation.paused'});
    if (a.kind !== 'envelope' || b.kind !== 'envelope') throw new Error('test envelope expected');
    a.data.observations[0].value = {available: false, reason: 'not-observed', detail: 'none'};
    b.data.gameTime.minutes = {available: true, value: '44'}; b.data.simulation = 'paused';
    const result = events(importCap0(fixture([header(), a, b, end(3, 2)]), 'context'));
    expect(result[0].data.record).toMatchObject({cargo: {available: false, reason: 'not-observed'}});
    expect(result.map(m => m.data.occurred)).toMatchObject([
      {monotonicNs: {value: '1000001000000'}, gameTime: {minutes: {value: '4294967295'}}, simulation: 'running', utcUnixMs: {available: false}},
      {monotonicNs: {value: '1000001000001'}, gameTime: {minutes: {value: '44'}}, simulation: 'paused', utcUnixMs: {available: false}}]);
  });
  it('ignores indexed attributes for scalar lookup without treating an indexed-only list as clear', () => {
    const scalar = observation(0, 'cargo.id', 'string', 'scalar'), indexed = observation(1, 'cargo.id', 'string', 'indexed');
    indexed.arrayIndex = {available: true, value: 0};
    const s = importCap0(fixture([header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: [scalar, indexed]}), end(2, 1)]), 'indexed');
    expect(events(s)[0].data.record).toMatchObject({type: 'job.configured', cargoId: {available: true, value: 'scalar'}});
    indexed.position = 0;
    const only = importCap0(fixture([header(), envelope(1, 1, {group: 'configuration', id: 'job', observations: [indexed]}), end(2, 1)]), 'indexed-only');
    expect(events(only)[0].data.record).toMatchObject({type: 'job.configured', cargoId: {available: false, reason: 'not-observed'}});
  });
  it.each(['status', 'discarded', 'loss', 'unsent', 'end', 'header', 'count', 'packet-order', 'callback-order', 'callback-id', 'attribute-name', 'bad-id', 'missing-time'])('rejects %s without repairing evidence', kind => {
    const dir = fixture(undefined, (m, ps) => {
      const p = ps[1]; if (p.kind !== 'envelope') throw new Error('test envelope expected');
      switch (kind) {
        case 'status': m.status = 'disconnect'; break;
        case 'discarded': (m.counts as Json).packetsDiscarded = 1; break;
        case 'loss': p.data.droppedBefore = '1'; break;
        case 'unsent': (m.loss as {end: Json}).end.unsentEnvelopes = '1'; break;
        case 'end': (m.loss as Json).endMarkerReceived = false; break;
        case 'header': (m.authority as Json).processId = 99; break;
        case 'count': (m.counts as Json).envelopesCompleted = 9; break;
        case 'packet-order': p.packetSeq = '2'; break;
        case 'callback-order': p.data.sharedBoundaryOrder = '1'; break;
        case 'callback-id': p.data.callback = {group: 'lifecycle', id: {available: true, value: 'unknown'}}; p.data.attributes = {expected: false, present: false, terminated: true, total: 0, first: 0, count: 0, final: true, omittedLowerBound: 0}; p.data.observations = []; break;
        case 'attribute-name': p.data.observations[0].name = {available: false, reason: 'invalid', detail: 'null-name'}; break;
        case 'bad-id': p.data.observations[0] = observation(0, 'cargo.id', 'string', 'C:\\private'); break;
        case 'missing-time': p.data.callbackMonotonicNs = {available: false, reason: 'not-observed', detail: 'none'}; break;
      }
    });
    expect(() => importCap0(dir, 'invalid')).toThrow(/^CAP0 import rejected:/);
  });
  it('rejects tampering, duplicate JSON keys, invalid UTF-8 and bounded-file overflow', () => {
    const dir = fixture(), packets = join(dir, 'packets.ndjson');
    writeFileSync(packets, readFileSync(packets, 'utf8') + ' ');
    expect(() => importCap0(dir, 'tampered')).toThrow(/rejected/);
    writeFileSync(join(dir, 'export.json'), '{"format":1,"format":2}');
    expect(() => importCap0(dir, 'tampered')).toThrow(/rejected/);
    writeFileSync(join(dir, 'export.json'), Buffer.from([255]));
    expect(() => importCap0(dir, 'tampered')).toThrow(/rejected/);
    writeFileSync(join(dir, 'export.json'), Buffer.alloc(1_048_577));
    expect(() => importCap0(dir, 'tampered')).toThrow(/rejected/);
  });
  it('rejects capture-step mutation, arbitrary source steps and missing provenance', () => {
    const s = importCap0(fixture(), 'strict');
    const bad = structuredClone(s); bad.steps[0].atMs++;
    expect(() => validateScenario(bad)).toThrow(/integrity mismatch/);
    expect(() => validateScenario({...s, provenance: null})).toThrow(/requires provenance|capture context requires provenance/);
    const x = {...s, steps: [{action: 'frame', atMs: 1, channels: {speed: 0}}, s.steps.at(-1)]};
    expect(() => validateScenario({...x, provenance: {...s.provenance, stepsSha256: stepsDigest(x.steps)}})).toThrow(/capture callbacks/);
  });
  it('CLI import refuses replacement and replay bytes match the library', () => {
    const dir = fixture(), out = join(dir, 'derived.json');
    const cli = resolve('tools/telemetry-simulator/dist/cli.cjs');
    execFileSync(process.execPath, [cli, 'import-cap0', dir, '--run', 'cli-test', '--out', out]);
    const expected = importCap0(dir, 'cli-test');
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual(expected);
    const a = execFileSync(process.execPath, [cli, 'replay-v1', out], {encoding: 'utf8'}), b = execFileSync(process.execPath, [cli, 'replay-v1', out], {encoding: 'utf8'});
    expect(a).toBe(b); expect(a).toBe(transcriptLines(replayV1(expected)).join('\n') + '\n');
    expect(() => execFileSync(process.execPath, [cli, 'import-cap0', dir, '--run', 'cli-test', '--out', out], {stdio: 'pipe'})).toThrow();
  });
});
