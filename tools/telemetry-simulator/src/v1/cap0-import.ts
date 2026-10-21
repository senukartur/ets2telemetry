// Read-only import of a sanitized CAP0 export. Neither the source export nor its identifier mapping is published.
import {openSync, closeSync, readSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {strictJson} from '../../../../packages/contracts/src/protocol-v0';
import {sdkText} from '../../../../packages/contracts/src/protocol-v1';
import {Cap0StreamValidator, validateCap0Packet, type Cap0EnvelopeData, type Cap0HeaderData, type Cap0Observation} from '../../../../packages/contracts/src/capture-cap0';
import {exactObject, runLabel, stepsDigest, type CaptureProvenance, type CaptureStep} from './cap0-schema';
import {seededId} from './source';
import {validateScenario} from './scenario';

function fail(): never { throw new Error('CAP0 import rejected: incomplete, inconsistent or unrepresentable sanitized evidence'); }
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
function bounded(file: string, limit: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const b = Buffer.alloc(limit + 1); let n = 0;
    while (n < b.length) { const got = readSync(fd, b, n, b.length - n, null); if (!got) break; n += got; }
    if (n > limit) fail(); return b.subarray(0, n);
  } finally { closeSync(fd); }
}
const decode = (b: Uint8Array): string => new TextDecoder('utf-8', {fatal: true}).decode(b);
const object = (v: unknown): Record<string, unknown> => { if (!v || typeof v !== 'object' || Array.isArray(v)) fail(); return v as Record<string, unknown>; };
const eq = (a: unknown, b: unknown): boolean => {
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    return Object.keys(x).length === Object.keys(y).length && Object.keys(x).every(k => Object.hasOwn(y, k) && eq(x[k], y[k]));
  }
  return a === b;
};
// Only documented game identifiers survive as text. Every other string value is first-appearance tokenized,
// including ignored configurations; empty text and unavailable values keep their distinct representations.
const ID_FIELDS = new Set(['id', 'brand_id', 'body.type', 'chain.type', 'cargo.accessory.id', 'job.market', 'fine.offence',
  'cargo.id', 'source.city.id', 'source.company.id', 'destination.city.id', 'destination.company.id', 'license.plate.country.id', 'source.id', 'target.id']);
function minimize(observations: Cap0Observation[], names: Map<string, string>, plates: Map<string, string>): Cap0Observation[] {
  return observations.map(input => {
    const o = structuredClone(input);
    if (!o.name.available || !/^[a-zA-Z0-9_.-]{1,128}$/.test(o.name.value)) fail();
    if (o.sdkType === 'string' && o.value.available) {
      const value = o.value.value;
      if (typeof value !== 'string') fail();
      if (!value.length) return o;
      if (ID_FIELDS.has(o.name.value)) { if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(value)) fail(); return o; }
      // Minimized text must not turn a native-invalid display name into an available short token.
      if (!sdkText(value, 'name').available) fail();
      const isPlate = o.name.value === 'license.plate', map = isPlate ? plates : names;
      if (!map.has(value)) map.set(value, `${isPlate ? 'plate' : 'name'}-${map.size + 1}`);
      o.value = {available: true, value: map.get(value)!};
    }
    return o;
  });
}
const LEDGER: Record<string, {game: 'ets2' | 'ats'; envelopes: number; hashPrefix: string; commit: string; mode: 'single-player' | 'truckersmp'; display: 'borderless' | 'windowed'}> = {
  'cap01-run2': {game: 'ets2', envelopes: 69, hashPrefix: '39b9cd36', commit: '960dff7', mode: 'single-player', display: 'borderless'},
  'cap01-run4': {game: 'ats', envelopes: 71, hashPrefix: 'b03a6c79', commit: 'a7724de', mode: 'single-player', display: 'borderless'},
  'cap01-run7': {game: 'ats', envelopes: 56, hashPrefix: 'b03a6c79', commit: 'a7724de', mode: 'truckersmp', display: 'borderless'},
  'cap01-run8': {game: 'ets2', envelopes: 29, hashPrefix: 'b03a6c79', commit: 'aa67956', mode: 'single-player', display: 'windowed'},
  'cap01-run9': {game: 'ets2', envelopes: 54, hashPrefix: 'b03a6c79', commit: 'aa67956', mode: 'single-player', display: 'windowed'}
};

/** A bounded complete export becomes callback steps plus a durable test connection. No SDK or history I/O. */
export function importCap0(directory: string, label: string) {
  runLabel(label);
  // Errors deliberately contain no source data or paths. The CLI must not echo capture text on rejection.
  try { return convert(directory, label); } catch { fail(); }
}
function convert(directory: string, label: string) {
  const record = exactObject(strictJson(decode(bounded(join(directory, 'export.json'), 1_048_576))), ['format', 'schemaVersion', 'rawIntegrityVerified', 'counts', 'rules']);
  if (record.format !== 'ets2telemetry-cap0-export' || record.schemaVersion !== 1 || record.rawIntegrityVerified !== true) fail();
  const manifestInput = strictJson(decode(bounded(join(directory, 'manifest.json'), 1_048_576)));
  const manifest = exactObject(manifestInput,
    ['format', 'schemaVersion', 'captureSessionId', 'origin', 'status', 'stop', 'activation', 'authority', 'header', 'clockDomains', 'timing', 'counts', ...(Object.hasOwn(object(manifestInput), 'flowControl') ? ['flowControl'] : []), 'loss', 'limits', 'files', 'code', 'platform', 'displays', 'evidence', 'sanitized']);
  if (manifest.format !== 'ets2telemetry-cap0-capture-manifest' || manifest.schemaVersion !== 1 || manifest.sanitized !== true || manifest.status !== 'complete') fail();
  const loss = exactObject(manifest.loss, ['pluginLoss', 'end', 'endMarkerReceived', 'envelopePartial', 'lastPacketSeq', 'lastEnvelopeSeq', 'knownBoundaries', 'boundariesOmitted']);
  if (loss.pluginLoss !== null || loss.endMarkerReceived !== true || loss.envelopePartial !== false || !eq(loss.knownBoundaries, []) || loss.boundariesOmitted !== 0) fail();
  const counts = exactObject(manifest.counts, ['packetsReceived', 'packetsWritten', 'bytesWritten', 'packetsDiscarded', 'bytesDiscarded', 'envelopesCompleted']);
  if (counts.packetsDiscarded !== 0 || counts.bytesDiscarded !== 0) fail();
  const files = manifest.files;
  if (!Array.isArray(files) || files.length !== 1) fail();
  const file = exactObject(files[0], ['name', 'bytes', 'sha256']);
  const bytes = bounded(join(directory, 'packets.ndjson'), 20_971_520);
  if (file.name !== 'packets.ndjson' || file.bytes !== bytes.length || file.sha256 !== hash(bytes)) fail();
  const text = decode(bytes); if (!text.endsWith('\n')) fail();
  const lines = text.slice(0, -1).split('\n'); if (lines.length > 4096) fail();
  const envelopes: Cap0EnvelopeData[] = []; let stream: Cap0StreamValidator | undefined, header: Cap0HeaderData | undefined;
  let end: unknown, partial: Cap0EnvelopeData | undefined, receiptNs = -1n;
  for (const [i, line] of lines.entries()) {
    if (!line.length || Buffer.byteLength(line) > 131_072) fail();
    const row = exactObject(strictJson(line), ['receipt', 'packet']);
    const r = exactObject(row.receipt, ['seq', 'monotonicNs', 'utcUnixMs']);
    if (r.seq !== i + 1 || typeof r.monotonicNs !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(r.monotonicNs) || BigInt(r.monotonicNs) < receiptNs || typeof r.utcUnixMs !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(r.utcUnixMs)) fail();
    receiptNs = BigInt(r.monotonicNs);
    const p = validateCap0Packet(row.packet);
    if (!stream) stream = new Cap0StreamValidator(p.captureSessionId);
    stream.accept(p);
    if (p.kind === 'header') {
      header = p.data;
      if (manifest.captureSessionId !== p.captureSessionId || manifest.origin !== header.origin || !eq(manifest.header, header)) fail();
      const a = object(manifest.authority);
      for (const k of ['game', 'processId', 'windowsSessionId', 'processInstanceId', 'pluginSessionId'] as const) if (a[k] !== header.source[k]) fail();
    } else if (p.kind === 'loss') fail();
    else if (p.kind === 'end') {
      end = p.data;
      if (p.data.reason === 'encoding-failed' || p.data.droppedEnvelopes !== '0' || p.data.droppedBytes !== '0' || p.data.unsentEnvelopes !== '0' ||
          p.data.attemptedEnvelopes !== String(envelopes.length) || p.data.enqueuedEnvelopes !== String(envelopes.length) || p.data.publishedEnvelopes !== String(envelopes.length)) fail();
    } else {
      const d = p.data;
      if (d.droppedBefore !== '0') fail();
      if (partial) {
        const metadata = (x: Cap0EnvelopeData) => { const {observations: _o, attributes: a, ...rest} = x; void _o; const {first: _f, count: _c, final: _z, ...attrs} = a; void _f; void _c; void _z; return {...rest, attributes: attrs}; };
        if (!eq(metadata(partial), metadata(d))) fail();
        partial.observations.push(...d.observations);
      } else partial = structuredClone(d);
      if (d.attributes.final) {
        partial.attributes = {...partial.attributes, first: 0, count: partial.observations.length, final: true};
        envelopes.push(partial); partial = undefined;
      }
    }
  }
  if (!header || !stream?.ended || stream.partial || !envelopes.length || envelopes.length > 998 || !eq(end, loss.end) ||
      loss.lastPacketSeq !== stream.lastPacketSeq || loss.lastEnvelopeSeq !== stream.lastEnvelopeSeq || counts.envelopesCompleted !== envelopes.length || counts.packetsReceived !== lines.length || counts.packetsWritten !== lines.length) fail();
  if (header.versions.sdkArchive !== 'scs-sdk-1.15') fail();
  const currency = header.currency;
  if (currency.available && (currency.value.code !== (header.source.game === 'ets2' ? 'EUR' : 'USD') || currency.value.source !== `scs-sdk-1.15/include/${header.source.game === 'ets2' ? 'eurotrucks2/scssdk_telemetry_eut2.h' : 'amtrucks/scssdk_telemetry_ats.h'}#game-specific-units`)) fail();
  const names = new Map<string, string>(), plates = new Map<string, string>(), clocks = new Map<string, string>();
  const clockToken = (id: string) => { if (!clocks.has(id)) clocks.set(id, seededId('cap0-clock-token', String(clocks.size))); return clocks.get(id)!; };
  clockToken(header.clocks.gameClockIdAtOpen);
  const firstNs = envelopes[0].callbackMonotonicNs; if (!firstNs.available) fail();
  let previousNs = -1n, previousBoundary = BigInt(header.publishedBoundaryOrderAtOpen);
  const base = BigInt(firstNs.value) - 1_000_000n, boundaryBase = previousBoundary;
  const steps: (CaptureStep | {action: 'shutdown'; atMs: number; reason: 'plugin-shutdown' | 'source-retired'})[] = envelopes.map(d => {
    if (!d.callbackMonotonicNs.available || !d.callback.id.available || !/^[a-z0-9_.-]{1,128}$/.test(d.callback.id.value)) fail();
    const ns = BigInt(d.callbackMonotonicNs.value), boundary = BigInt(d.sharedBoundaryOrder);
    if (ns < previousNs || boundary <= previousBoundary || boundary <= boundaryBase) fail(); previousNs = ns; previousBoundary = boundary;
    if (d.callback.group === 'lifecycle' && !['timers.restart', 'game.time.regression', 'simulation.started', 'simulation.paused'].includes(d.callback.id.value)) fail();
    if ((d.callback.id.value === 'simulation.started' && d.simulation !== 'running') || (d.callback.id.value === 'simulation.paused' && d.simulation !== 'paused')) fail();
    const {sdkFrame: _s, ...data} = structuredClone(d); void _s;
    data.callbackMonotonicNs = {available: true, value: String(ns - base)};
    data.sharedBoundaryOrder = String(boundary - boundaryBase);
    data.gameTime.clockId = clockToken(data.gameTime.clockId);
    data.observations = minimize(data.observations, names, plates);
    return {action: 'capture', atMs: Number((ns - base + 999_999n) / 1_000_000n), data};
  });
  const lastAt = steps.at(-1)!.atMs;
  steps.push({action: 'shutdown', atMs: lastAt + 1, reason: (end as {reason: 'plugin-shutdown' | 'source-retired'}).reason});
  const image = header.versions.pluginImage, ledger = header.origin === 'game' ? LEDGER[label] : undefined;
  if (ledger && (ledger.game !== header.source.game || ledger.envelopes !== envelopes.length || !image.available || !image.value.sha256.startsWith(ledger.hashPrefix))) fail();
  const provenance: CaptureProvenance = {converter: 'cap0-v1-1', run: label, inputOrigin: header.origin, packetsSha256: hash(bytes), stepsSha256: stepsDigest(steps),
    envelopes: envelopes.length, orderingComplete: true, lossFree: true, review: 'docs/validation/cap-01a.md#expectation-updates',
    operator: {mode: ledger?.mode ?? 'unknown', display: ledger?.display ?? 'unknown', gameVersion: ['cap01-run8', 'cap01-run9'].includes(label) && ledger ? '1.61.1.1s' : null},
    build: {pluginSha256: ledger && image.available ? image.value.sha256 : null, sourceCommit: ledger?.commit ?? null, source: ledger ? 'coordinator-ledger' : 'unrecorded'}};
  const scenario = {format: 'ets2telemetry-simulator-v1', schemaVersion: 1, id: label, purpose: 'Minimized CAP0 callback replay; no observed channel samples or inferred job state',
    reg: ['REG-001', 'REG-002', 'REG-008', 'REG-009'], origin: header.origin === 'game' ? 'replay' as const : 'synthetic' as const, game: header.source.game, seed: label, provenance,
    source: {versions: {telemetryApi: header.versions.telemetryApi, gameTelemetry: header.versions.gameTelemetry, sdkArchive: header.versions.sdkArchive}, gameplayEvents: 'registered', currency: currency.available ? 'sdk-documented' : 'unknown', gameMode: 'unknown'},
    steps, transport: [{atMs: 0, action: 'connect', client: {durable: true, commit: 'each', ack: 'each'}}]};
  validateScenario(scenario);
  return scenario;
}
