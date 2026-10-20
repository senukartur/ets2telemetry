import {mkdtemp, readFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {latencyBits, readLatencyMarker} from '../../apps/desktop/src/latency-marker';
import {latencyEnabled, latencyReply, OverlayLatency, type LatencyRequest} from '../../apps/desktop/src/overlay-latency';
import {overlayPresentation} from '../../apps/desktop/src/overlay-presentation';
import {initialLive} from '../../apps/desktop/src/live-state';
import type {V1SourceState} from '../../apps/desktop/src/v1-ingestion';
import {v0Message} from '../shared/live-v1-fixtures';

const snapshot = v0Message('snapshot');
const live = {...initialLive('ets2'), status: 'connected' as const, fresh: true, observation: {source: {...snapshot.source, origin: 'game' as const},
  capture: {...snapshot.capture, monotonicNs: '1000000000'}, state: snapshot.data.state, seq: '1', receivedMonotonicMs: 0, windowReceivedMonotonicMs: 0,
  windowFresh: true, applied: {hydration: false, skippedSequences: '0', continuity: snapshot.data.continuity}}};
const view = overlayPresentation(live);
const request: LatencyRequest = {type: 'overlay-latency', token: 1, source: live.observation.source, capture: live.observation.capture};
// Only fields consulted by the measurement are populated. Observation v1 state/status are deliberately irrelevant.
const state = {selection: 'ets2', status: 'connected', fresh: true, observation: {source: request.source, capture: request.capture},
  clockMapping: {sourceClockId: request.capture.clockId, clientClockId: 'service', offsetNs: '-9000000000', uncertaintyNs: '2000000', measuredAtClientNs: '10000000000'}} as V1SourceState;
let temporary: string | undefined;
afterEach(async () => {vi.useRealTimers(); if (temporary) await rm(temporary, {recursive: true, force: true}); temporary = undefined;});

it('requires explicit opt-in AND absolute evidence/profile paths', () => {
  const env = {ETS2TELEMETRY_OVERLAY_LATENCY: '1', ETS2TELEMETRY_PROFILE_DIR: path.resolve('profile'), ETS2TELEMETRY_DIAGNOSTIC_DIR: path.resolve('evidence')};
  expect(latencyEnabled(env)).toBe(true);
  expect(latencyEnabled({...env, ETS2TELEMETRY_OVERLAY_LATENCY: undefined})).toBe(false);
  expect(latencyEnabled({...env, ETS2TELEMETRY_PROFILE_DIR: 'relative'})).toBe(false);
  expect(latencyEnabled({...env, ETS2TELEMETRY_DIAGNOSTIC_DIR: undefined})).toBe(false);
});
it.each([0.5, 1, 1.25, 1.5, 2, 3, 4])('decodes opaque composited pixels at CSS scale %s and rejects corruption', scale => {
  const width = Math.ceil(140 * scale), height = Math.ceil(20 * scale), bitmap = new Uint8Array(width * height * 4);
  // Render an independent known byte pattern A5 12 34 7C (token 4660), rather than using the encoder as oracle.
  const bytes = [0xa5, 0x12, 0x34, 0x7c];
  for (let y = 0; y < Math.floor(8 * scale); y++) for (let x = 0; x < Math.floor(128 * scale); x++) {
    const cell = Math.floor(x / (4 * scale)), white = (bytes[Math.floor(cell / 8)] >>> (7 - cell % 8)) & 1;
    bitmap.set([white * 255, white * 255, white * 255, 255], (y * width + x) * 4);
  }
  expect(readLatencyMarker(bitmap, width, height, scale)).toBe(4660);
  bitmap.fill(128);
  expect(readLatencyMarker(bitmap, width, height, scale)).toBeUndefined();
});
it('encodes hand-computed checksum and excludes zero/oversized tokens', () => {
  expect(latencyBits(4660).map(String).join('')).toBe('10100101000100100011010001111100');
  expect(() => latencyBits(0)).toThrow(); expect(() => latencyBits(65536)).toThrow();
});
it('computes a causal upper bound without comparing main and service clocks', () => {
  // Source capture 1s; service 10.050s; source=service-9s ±2ms: upper=52ms.
  expect(latencyReply(request, state, 10050000000n)).toEqual({type: 'overlay-latency-result', token: 1, upperNs: '52000000', uncertaintyNs: '2000000', mappingAgeNs: '50000000'});
  expect(latencyReply(request, {...state, clockMapping: undefined}, 10050000000n)).toMatchObject({reason: 'clock-not-mapped'});
  expect(latencyReply(request, state, 11600000000n)).toMatchObject({reason: 'mapping-not-current'});
  expect(latencyReply(request, state, 9999999999n)).toMatchObject({reason: 'mapping-not-current'});
  expect(latencyReply(request, {...state, status: 'paused'}, 10050000000n)).toMatchObject({reason: 'source-not-current'});
  expect(latencyReply({...request, source: {...request.source, pluginSessionId: 'different'}}, state, 10050000000n)).toMatchObject({reason: 'source-not-current'});
  expect(latencyReply({...request, capture: {...request.capture, clockId: 'different'}}, state, 10050000000n)).toMatchObject({reason: 'clock-not-mapped'});
  expect(latencyReply({...request, capture: {...request.capture, monotonicNs: '2000000000'}}, state, 10050000000n)).toMatchObject({reason: 'impossible-clock-order'});
  expect(latencyReply({...request, token: 0}, state, 10050000000n)).toBeUndefined();
});
it('reports bounds, outliers, retired and missing frames without treating them as zero or pass', async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'et009-latency-'));
  let now = 900000000000n; const sent = vi.fn();
  const collector = new OverlayLatency(temporary, sent, vi.fn(), () => now);
  expect(collector.project(view, live, false)).not.toHaveProperty('diagnosticFrame');
  expect(collector.project(view, live, true).diagnosticFrame).toBe(1);
  expect(collector.project(view, live, true).diagnosticFrame).toBe(1);
  now += 300000000n; collector.frame(1, true); collector.frame(1, true);
  expect(sent).toHaveBeenCalledTimes(1);
  collector.reply({type: 'overlay-latency-result', token: 1, upperNs: '350000000', uncertaintyNs: '1000000', mappingAgeNs: '20000000'});
  const next = (capture: string) => ({...live, observation: {...live.observation, capture: {...live.observation.capture, monotonicNs: capture}}});
  collector.project(view, next('1100000000'), true); collector.retire();
  collector.project(view, next('1200000000'), true);
  collector.finish('exit'); await collector.idle();
  const report = JSON.parse(await readFile(path.join(temporary, 'overlay-latency.json'), 'utf8'));
  expect(report).toMatchObject({attempted: 3, valid: 1, unresolved: 2, upperBoundWithinTarget: 0, lowerBoundOverTarget: 1,
    lowerMs: {p50: 300, p95: 300, p99: 300, max: 300}, upperMs: {p50: 350, max: 350}});
  expect(report.samples.map((row: {reason?: string}) => row.reason)).toEqual([undefined, 'source-or-document-retired', 'unfinished']);
  expect(collector.project(view, live, true)).not.toHaveProperty('diagnosticFrame');
});
it('ends automatically after 120s even when updates stop', async () => {
  vi.useFakeTimers(); temporary = await mkdtemp(path.join(os.tmpdir(), 'et009-latency-'));
  const collector = new OverlayLatency(temporary, vi.fn(), vi.fn());
  collector.project(view, live, true); vi.advanceTimersByTime(120000); await collector.idle();
  expect(collector.complete).toBe(true);
  expect(JSON.parse(await readFile(path.join(temporary, 'overlay-latency.json'), 'utf8'))).toMatchObject({reason: 'duration', valid: 0, unresolved: 1});
});
it('bounds pending memory and counts expired, inconsistent and malformed replies', async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), 'et009-latency-'));
  let now = 1n; const collector = new OverlayLatency(temporary, vi.fn(), vi.fn(), () => now);
  const project = (ns: string) => collector.project(view, {...live, observation: {...live.observation,
    capture: {...live.observation.capture, monotonicNs: ns}}}, true);
  project('1'); now += 3000000000n; project('2');
  collector.frame(1, true); // expired, cannot be resurrected
  now += 30000000n; collector.frame(2, true);
  collector.reply({token: 2, upperNs: '1000', uncertaintyNs: '1', mappingAgeNs: '1'});
  project('3'); collector.frame(3, true); collector.reply({token: 3, upperNs: 'broken'});
  for (let index = 4; index <= 3001; index++) project(String(index));
  expect(collector.complete).toBe(true); await collector.idle();
  const report = JSON.parse(await readFile(path.join(temporary, 'overlay-latency.json'), 'utf8'));
  expect(report).toMatchObject({reason: 'sample-limit', attempted: 3000, valid: 0, unresolved: 3000});
  expect(report.samples.slice(0, 3).map((row: {reason: string}) => row.reason)).toEqual(['frame-or-reply-timeout', 'inconsistent-bounds', 'invalid-reply']);
});
