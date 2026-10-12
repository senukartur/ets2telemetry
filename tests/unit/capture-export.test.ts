import {appendFile, readdir, readFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {CaptureWriter} from '../../apps/desktop/src/capture-writer';
import {exportCapture} from '../../tools/capture-export/src/sanitize';
import {temporaryResources} from '../shared/resources';
import {AUTHORITY, SESSION, delivered, end, envelope, header} from '../shared/cap0-fixtures';

let resources: Awaited<ReturnType<typeof temporaryResources>>;
beforeEach(async () => {resources = await temporaryResources();});
afterEach(async () => {await resources.dispose();});
async function capture() {
  let clock = 0;
  const writer = new CaptureWriter({root: path.join(resources.directory, 'captures'), now: () => clock += 5, utcNow: () => 1_700_000_000_000 + clock,
    context: {captureSessionId: SESSION, activation: {mechanism: 'environment', deadlineMs: 600_000, operatorLabel: 'ets2-sp-windowed'}, code: {brokerSha256: 'b'.repeat(64)},
      platform: {arch: 'x64'}, displays: [{id: '2779098405', bounds: {x: 0, y: 0, width: 1920, height: 1080}, scaleFactor: 1.5, rotation: 0}]}});
  await writer.start(); writer.bindAuthority(AUTHORITY);
  for (const packet of [header(), envelope(1, 1, {observations: delivered()}), envelope(2, 2, {group: 'lifecycle', id: 'simulation.paused'}), end(3, 2)]) writer.accept(packet);
  await writer.close('disconnect'); return writer.directory;
}
const identifiers = [SESSION, AUTHORITY.processInstanceId, AUTHORITY.pluginSessionId, '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-000000000000', AUTHORITY.processCreationTime, 'C:\\Users\\Driver', '2779098405'];

describe('CAP0 export sanitizer', () => {
  it('replaces identifiers and paths with stable first-appearance tokens while preserving evidence and order', async () => {
    const raw = await capture(), output = path.join(resources.directory, 'export');
    const result = await exportCapture(raw, output);
    expect((await readdir(output)).sort()).toEqual(['export.json', 'manifest.json', 'packets.ndjson']);
    const text = (await readFile(path.join(output, 'packets.ndjson'), 'utf8')) + (await readFile(path.join(output, 'manifest.json'), 'utf8')) + (await readFile(path.join(output, 'export.json'), 'utf8'));
    for (const value of identifiers) expect(text).not.toContain(JSON.stringify(value).slice(1, -1));
    expect(text).not.toMatch(/"processId": ?4242/);
    const lines = (await readFile(path.join(output, 'packets.ndjson'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line) as {receipt: {utcUnixMs: string; monotonicNs: string}; packet: Record<string, unknown> & {data: Record<string, unknown>}});
    expect(lines).toHaveLength(4); expect(result.packets).toBe(4);
    // Equal raw identifiers share one token; distinct identifiers remain distinct.
    const sessions = new Set(lines.map(line => line.packet.captureSessionId)); expect(sessions.size).toBe(1);
    const source = (lines[0].packet.data as {source: Record<string, unknown>}).source;
    expect(source).toMatchObject({processId: 1, windowsSessionId: 1, game: 'ets2', sdkGameId: 'eut2'}); expect(source.processInstanceId).not.toBe(source.pluginSessionId);
    expect((lines[0].packet.data as {versions: {pluginImage: {value: {path: string; sha256: string}}}}).versions.pluginImage.value).toEqual({path: 'redacted-path-1', sha256: 'a'.repeat(64)});
    // Game data, exact values, monotonic clocks and order survive; UTC labels are rebased.
    expect(JSON.stringify(lines[1].packet)).toContain('"18446744073709551615"'); expect(JSON.stringify(lines[1].packet)).toContain('"job.delivered"');
    expect(lines.map(line => Number(line.receipt.utcUnixMs))).toEqual([...lines.map(line => Number(line.receipt.utcUnixMs))].sort((a, b) => a - b));
    expect(Number(lines[0].receipt.utcUnixMs)).toBeLessThan(1_000_000);
    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')) as Record<string, unknown> & {authority: Record<string, unknown>; displays: {id: string}[]; timing: Record<string, string>};
    expect(manifest.sanitized).toBe(true); expect(manifest.authority.processCreationTime).toBe('1'); expect(manifest.displays[0].id).toBe('1'); expect(manifest.timing.startedUtcUnixMs).toBe('0');
    expect(manifest.authority.processInstanceId).toBe(source.processInstanceId);
    const record = JSON.parse(await readFile(path.join(output, 'export.json'), 'utf8')) as {counts: Record<string, number>; rawIntegrityVerified: boolean};
    expect(record.rawIntegrityVerified).toBe(true); expect(record.counts).toMatchObject({path: 1, processId: 1, processCreationTime: 1, displayId: 1}); expect(record.counts.uuid).toBeGreaterThanOrEqual(5);
    // A second export of the same capture yields identical tokens: the mapping is deterministic per input.
    await exportCapture(raw, path.join(resources.directory, 'export-2'));
    expect(await readFile(path.join(resources.directory, 'export-2', 'packets.ndjson'), 'utf8')).toBe(await readFile(path.join(output, 'packets.ndjson'), 'utf8'));
  });
  it('refuses tampered captures and never overwrites an existing export', async () => {
    const raw = await capture(), output = path.join(resources.directory, 'export');
    await exportCapture(raw, output); await expect(exportCapture(raw, output)).rejects.toThrow();
    await appendFile(path.join(raw, 'packets.ndjson'), '{}\n');
    await expect(exportCapture(raw, path.join(resources.directory, 'tampered'))).rejects.toThrow(/do not match/);
    await expect(exportCapture('relative', output)).rejects.toThrow(/absolute/);
  });
});
