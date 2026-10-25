// ET-019 PR-9: seeded mutation fuzzing of the TypeScript frame parsers (REG-010). Valid shared fixtures are mutated by a
// seeded generator and fed to every TypeScript payload decoder, streaming frame decoder and broker stdout reader. Every
// expectation below comes from the protocol documents (docs/protocol/v0.md, v1.md, cap0.md and the broker control in
// docs/telemetry-service-v0.md), never from the code under test (TESTING.md section 4). There is no coverage guidance and
// no native target here; coverage-guided fuzzing is TD-017.
import {EventEmitter} from 'node:events';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';
import {describe, expect, it, vi} from 'vitest';
import * as v0 from '../../packages/contracts/src/protocol-v0';
import * as v1 from '../../packages/contracts/src/protocol-v1';
import * as cap0 from '../../packages/contracts/src/capture-cap0';
import {NativeClientError, NativePipeClient} from '../../apps/desktop/src/native-pipe-client';
import {CaptureTransportError, NativeCaptureClient} from '../../apps/desktop/src/capture-session';
import {between, mulberry32, pick} from '../shared/seeded-random';
import {delivered, end, envelope, header, loss, observation, payload as cap0Payload, SESSION} from '../shared/cap0-fixtures';

// The broker readers spawn the fixed native broker; here `spawn` returns an in-memory child, so no process starts.
const spawnHook = vi.hoisted(() => ({create: undefined as undefined | (() => unknown)}));
vi.mock('node:child_process', () => ({spawn: () => {
  if (!spawnHook.create) throw new Error('No fake broker child is configured');
  return spawnHook.create();
}}));

// ---------------------------------------------------------------------------------------------------------------------
// Campaign configuration (ET-019 decision D4: 2,000 inputs per parser on a PR, more in the extended job).
function envInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[0-9]{1,10}$/.test(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`${name} must be an integer from ${min} to ${max}, got ${JSON.stringify(raw)}`);
  return Number(raw);
}
// At most 10,000,000, so that CAMPAIGN_CPU_BUDGET_MS stays a valid timer delay.
const ITERATIONS = envInteger('ETS2TELEMETRY_FUZZ_ITERATIONS', 2_000, 1, 10_000_000);
const SEED = envInteger('ETS2TELEMETRY_FUZZ_SEED', 20_261_019, 0, 0xffff_ffff);
/**
 * Hang guard: an input whose processing has not returned by then is reported as a hang, with its seed and bytes. It
 * interrupts even a synchronous endless loop (node:vm terminates the running script). Iterations run in guarded batches
 * of GUARD_BATCH_ITERATIONS, because each guarded call starts a watchdog thread; no single iteration can outlast the
 * guard, and the report names the one that was running. An iteration normally takes milliseconds; this is no speed
 * assertion.
 */
const ITERATION_HANG_GUARD_MS = 10_000;
const GUARD_BATCH_ITERATIONS = 25;
/** Bounds the CPU work of one campaign of ITERATIONS inputs. It grows with the count and asserts no timing. */
const CAMPAIGN_CPU_BUDGET_MS = 30_000 + ITERATIONS * 25;
/**
 * The default (minor-0) v1 readers get half a campaign: the minor-1 readers already fuzz every minor-0 seed, and this
 * keeps the default entry points and the minor-swap defect under test without doubling the v1 cost (ET-050b).
 */
const DEFAULT_READER_ITERATIONS = Math.ceil(ITERATIONS / 2);
/** A campaign of at least this many inputs must reach both acceptance and rejection, or its mutations are too weak. */
const OUTCOME_COVERAGE_MIN_ITERATIONS = 100;

// Documented bounds, written from the protocol documents rather than read from the code under test.
const V0_PAYLOAD_BYTES = 65_536; // v0.md "Encoding and bounds"
const V1_SERVER_PAYLOAD_BYTES = 65_536, V1_CLIENT_PAYLOAD_BYTES = 4_096, V1_EVENT_BYTES = 16_384; // v1.md §3
const CAP0_PACKET_BYTES = 65_536; // cap0.md "Wire format"
const BROKER_RECEIPT_BYTES = 4_096, BROKER_RELAY_BYTES = 65_536; // telemetry-service-v0.md "Native broker control"
const V1_LIMITS_DOC = {serverFrameBytes: 65_536, clientFrameBytes: 4_096, eventBytes: 16_384, retainedEntries: 256, retainedBytes: 1_048_576,
  disconnectRetentionMs: 300_000, helloTimeoutMs: 5_000, writeDeadlineMs: 1_000, snapshotIntervalMs: 50, trailerSlots: 10}; // v1.md §4, §9
const V1_EVENT_TYPES_DOC = ['job.configured', 'job.cleared', 'truck.configured', 'truck.cleared', 'trailer.configured', 'trailer.cleared', 'simulation.paused',
  'simulation.started', 'timers.restart', 'gameTime.regression', 'job.delivered', 'job.cancelled', 'player.fined', 'player.tollgate.paid', 'player.use.ferry',
  'player.use.train', 'source.gameMode']; // v1.md §8
const V1_LOSS_CAUSES_DOC = ['offline', 'noDurableConsumer', 'queueCount', 'queueBytes', 'retentionExpired', 'encodingFailed']; // v1.md §7
const V1_MAX_EVENT_SEQ_DOC = 18_446_744_073_709_551_614n; // v1.md §8
const CAP0_BOUNDS_DOC = {queueEnvelopes: 128, queueBytes: 2_097_152, packetBytes: 65_536, attributeScan: 256, identifierBytes: 128, stringBytes: 1_024}; // cap0.md

// ---------------------------------------------------------------------------------------------------------------------
// Reproducible iterations and bounded failure reports.
type Random = () => number;
const fmix32 = (value: number) => {
  let h = value >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x85eb_ca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2_ae35); h ^= h >>> 16;
  return h >>> 0;
};
/** Each iteration has its own generator, so a reported iteration reproduces without replaying the ones before it. */
const iterationRandom = (campaign: number, iteration: number): Random => mulberry32(fmix32((fmix32(SEED ^ fmix32(campaign + 1)) + iteration) >>> 0));
const HEX_HEAD_BYTES = 256, HEX_TAIL_BYTES = 64;
function hex(bytes: Uint8Array): string {
  const h = (part: Uint8Array) => Buffer.from(part).toString('hex');
  if (bytes.length <= HEX_HEAD_BYTES + HEX_TAIL_BYTES) return h(bytes);
  return `${h(bytes.subarray(0, HEX_HEAD_BYTES))}...(${bytes.length - HEX_HEAD_BYTES - HEX_TAIL_BYTES} bytes omitted)...${h(bytes.subarray(-HEX_TAIL_BYTES))}`;
}
const describeError = (error: unknown) => error instanceof Error ? `${error.constructor.name}: ${error.message}` : `non-Error ${String(error)}`;
/** A broken invariant. Parsers never throw it, so it cannot be mistaken for a documented rejection. */
class Violation extends Error {}
function violate(message: string): never { throw new Violation(message); }
function check(condition: boolean, message: () => string): void { if (!condition) violate(message()); }

interface Iteration {random: Random; steps: string[]; input: Uint8Array}
interface Outcomes {accepted: number; rejected: number}
const guardScript = new vm.Script('iteration()');
const guardContext = vm.createContext({iteration: undefined as unknown});
/** Runs under the hang guard. Errors keep their identity; a timeout surfaces as ERR_SCRIPT_EXECUTION_TIMEOUT. */
function guarded(run: () => void): void { guardContext.iteration = run; guardScript.runInContext(guardContext, {timeout: ITERATION_HANG_GUARD_MS}); }
function campaign(name: string, index: number, body: (iteration: Iteration, outcomes: Outcomes) => void, iterations = ITERATIONS): Outcomes {
  const outcomes: Outcomes = {accepted: 0, rejected: 0};
  for (let first = 0; first < iterations; first += GUARD_BATCH_ITERATIONS) {
    let i = first, iteration: Iteration = {random: iterationRandom(index, i), steps: [], input: new Uint8Array()};
    try {
      guarded(() => {
        for (; i < Math.min(iterations, first + GUARD_BATCH_ITERATIONS); i++) {
          iteration = {random: iterationRandom(index, i), steps: [], input: new Uint8Array()};
          body(iteration, outcomes);
        }
      });
    } catch (error) {
      // A guard timeout terminates the script without running its finally blocks: restore the allocation probe and end
      // a broker reader the iteration left open (its startup timer), so neither reaches a later case.
      globalThis.Uint8Array = NativeUint8Array;
      openBrokerClient?.destroy(); openBrokerClient = undefined;
      const hung = (error as {code?: unknown} | null)?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
      const cause = hung ? `hang: no return within the ${ITERATION_HANG_GUARD_MS} ms guard` : error instanceof Violation ? error.message : `unexpected ${describeError(error)}`;
      expect.fail(`${name}: seed ${SEED}, iteration ${i} (reproduce with ETS2TELEMETRY_FUZZ_SEED=${SEED} and at least ${i + 1} iterations): ${cause}\n` +
        `mutations: ${iteration.steps.join(', ') || 'none'}\ninput (${iteration.input.length} bytes): ${hex(iteration.input)}`);
    }
  }
  return outcomes;
}
function expectBothOutcomes(outcomes: Outcomes, iterations = ITERATIONS): void {
  if (iterations < OUTCOME_COVERAGE_MIN_ITERATIONS) return;
  expect(outcomes.accepted, 'inputs accepted').toBeGreaterThan(0); expect(outcomes.rejected, 'inputs rejected').toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------------------------------------------------
// JSON helpers and doc-derived oracles.
type Json = Record<string, unknown>;
const utf8 = new TextEncoder();
const toText = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString('utf8');
const concat = (...parts: Uint8Array[]) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const frameOf = (payload: Uint8Array) => { const out = new Uint8Array(4 + payload.length); new DataView(out.buffer).setUint32(0, payload.length, true); out.set(payload, 4); return out; };
const prefixOf = (bytes: Uint8Array, at = 0) => new DataView(bytes.buffer, bytes.byteOffset + at, 4).getUint32(0, true);
const sameBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a.buffer, a.byteOffset, a.length).equals(Buffer.from(b.buffer, b.byteOffset, b.length));
const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasKeys = (v: unknown, keys: readonly string[]): v is Json => isRecord(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (v: unknown) => typeof v === 'string' && UUID.test(v);
/** Canonical decimal uint64: `0` or digits without a leading zero, at most 18446744073709551615 (v0.md, v1.md §5). */
const isU64 = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= 18_446_744_073_709_551_615n;
const isInt = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isVersion = (v: unknown, major: number, minors: readonly number[] = [0]) => hasKeys(v, ['major', 'minor']) && v.major === major && minors.includes(v.minor as number);
/** The documented v1 minors (v1.md §2): 0 and, from ET-050b, 1. */
const V1_MINORS_DOC = [0, 1];
/** Kinds whose schema or rules name the minor: the hello is always 1.0, the welcome repeats it, and state carries the gearbox only in minor 1 (v1.md §2, §4, §7). */
const V1_MINOR_DEPENDENT_KINDS = ['hello', 'welcome', 'checkpoint', 'snapshot'];
/** Minor-1 gearbox bounds (v1.md §7, ET-050b B2). */
const V1_GEARBOX_DOC = {maxGears: 100, maxSelectorCount: 6, maxSlots: 64, maxHandlePosition: 255};
const isAvailability = (v: unknown, value: (x: unknown) => boolean) => hasKeys(v, ['available', 'value']) ? v.available === true && value(v.value) :
  hasKeys(v, ['available', 'reason']) && v.available === false && ['not-supported', 'not-observed', 'invalid'].includes(v.reason as string);
function gearboxProblem(g: unknown): string | undefined {
  if (!hasKeys(g, ['forwardGears', 'reverseGears', 'hshifter'])) return 'gearbox keys';
  const count = (x: unknown) => isInt(x, 0, V1_GEARBOX_DOC.maxGears);
  if (!isAvailability(g.forwardGears, count) || !isAvailability(g.reverseGears, count)) return 'gear counts';
  const layout = (x: unknown) => {
    if (!hasKeys(x, ['selectorCount', 'slots']) || !isInt(x.selectorCount, 0, V1_GEARBOX_DOC.maxSelectorCount) || !Array.isArray(x.slots) || x.slots.length > V1_GEARBOX_DOC.maxSlots) return false;
    const pairs = x.slots.map(s => hasKeys(s, ['gear', 'handlePosition', 'selectors']) && isInt(s.gear, -V1_GEARBOX_DOC.maxGears, V1_GEARBOX_DOC.maxGears) && s.gear !== 0 &&
      isInt(s.handlePosition, 0, V1_GEARBOX_DOC.maxHandlePosition) && isInt(s.selectors, 0, 2 ** (x.selectorCount as number) - 1) ? `${s.handlePosition as number}/${s.selectors as number}` : undefined);
    return pairs.every(p => p !== undefined) && new Set(pairs).size === pairs.length;
  };
  return isAvailability(g.hshifter, layout) ? undefined : 'hshifter layout';
}
/** JSON value equality: member order is immaterial and numbers compare by value (v0.md "Encoding and bounds"). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
}
function sourceProblem(s: unknown): string | undefined {
  if (!hasKeys(s, ['game', 'pluginSessionId', 'processInstanceId', 'processId', 'windowsSessionId', 'origin'])) return 'source keys';
  if (!['ets2', 'ats'].includes(s.game as string) || !isUuid(s.pluginSessionId) || !isUuid(s.processInstanceId) || !isInt(s.processId, 1, 0xffff_ffff) ||
    !isInt(s.windowsSessionId, 0, 0xffff_ffff) || !['game', 'synthetic', 'replay'].includes(s.origin as string)) return 'source values';
  return undefined;
}
/** The envelope of every server message (v0.md "Source, ordering and time"; v1.md §5). */
function serverEnvelopeProblem(m: Json, major: number, minors: readonly number[] = [0]): string | undefined {
  if (!hasKeys(m, ['version', 'kind', 'source', 'seq', 'capture', 'data'])) return 'server envelope keys';
  if (!isVersion(m.version, major, minors)) return `version ${JSON.stringify(m.version)}`;
  const source = sourceProblem(m.source); if (source) return source;
  if (!isU64(m.seq)) return 'seq is not a canonical uint64';
  if (!hasKeys(m.capture, ['clockId', 'monotonicNs']) || !isUuid(m.capture.clockId) || !isU64(m.capture.monotonicNs)) return 'capture time';
  if (m.kind === 'checkpoint' && (!isRecord(m.data) || m.data.boundarySeq !== m.seq)) return 'checkpoint boundarySeq differs from seq';
  return undefined;
}
function helloProblem(m: Json, major: number, flag: string): string | undefined {
  if (!hasKeys(m, ['version', 'kind', 'data'])) return 'hello envelope keys';
  if (!isVersion(m.version, major)) return `version ${JSON.stringify(m.version)}`;
  if (!hasKeys(m.data, ['clientInstanceId', 'minMinor', 'maxMinor', flag]) || !isUuid(m.data.clientInstanceId) || m.data.minMinor !== 0 ||
    !isInt(m.data.maxMinor, 0, 65_535) || typeof m.data[flag] !== 'boolean') return 'hello data';
  return undefined;
}
function v0Problem(m: unknown): string | undefined {
  if (!isRecord(m)) return 'not an object';
  if (m.kind === 'hello') return helloProblem(m, 0, 'diagnostics');
  if (!['welcome', 'checkpoint', 'snapshot', 'diagnostic'].includes(m.kind as string)) return `kind ${String(m.kind)}`;
  const envelope = serverEnvelopeProblem(m, 0); if (envelope) return envelope;
  const data = m.data as Json;
  if (m.kind === 'welcome' && data.durableRecording !== false) return 'welcome advertises durable recording';
  if (m.kind === 'diagnostic') {
    const observations = data.observations;
    if (!Array.isArray(observations) || observations.length > 32 || new Set(observations.map(o => isRecord(o) ? o.channel : o)).size !== observations.length) return 'diagnostic batch';
  }
  return undefined;
}
function v1ServerProblem(m: unknown, size: number, minors: readonly number[]): string | undefined {
  if (!isRecord(m)) return 'not an object';
  if (!['welcome', 'checkpoint', 'snapshot', 'event', 'gap', 'clock.reply', 'end'].includes(m.kind as string)) return `server kind ${String(m.kind)}`;
  const envelope = serverEnvelopeProblem(m, 1, minors); if (envelope) return envelope;
  const data = m.data as Json, minor = (m.version as Json).minor;
  // The welcome's envelope minor equals the minor it selects (v1.md §2, §4).
  if (m.kind === 'welcome' && (data.minor !== minor || !jsonEqual(data.limits, V1_LIMITS_DOC))) return 'welcome minor or limits';
  // State carries `gearbox` exactly in minor 1, within the documented bounds (v1.md §7).
  if (m.kind === 'checkpoint' || m.kind === 'snapshot') {
    const state = isRecord(data) ? data.state : undefined;
    if (!isRecord(state) || Object.hasOwn(state, 'gearbox') !== (minor === 1)) return 'gearbox presence differs from the envelope minor';
    if (minor === 1) { const problem = gearboxProblem(state.gearbox); if (problem) return problem; }
  }
  if (m.kind === 'event') {
    if (size > V1_EVENT_BYTES) return `event of ${size} bytes`;
    if (!isU64(data.eventSeq) || BigInt(data.eventSeq) < 1n || BigInt(data.eventSeq) > V1_MAX_EVENT_SEQ_DOC) return 'eventSeq range';
    if (!isRecord(data.record) || !V1_EVENT_TYPES_DOC.includes(data.record.type as string)) return 'record type';
  }
  if (m.kind === 'gap') {
    const causes = data.causes;
    if (!hasKeys(causes, V1_LOSS_CAUSES_DOC) || !isU64(data.firstEventSeq) || !isU64(data.lastEventSeq) || !V1_LOSS_CAUSES_DOC.every(k => isU64(causes[k]))) return 'gap fields';
    const sum = V1_LOSS_CAUSES_DOC.reduce((n, k) => n + BigInt(causes[k] as string), 0n);
    if (BigInt(data.lastEventSeq) < BigInt(data.firstEventSeq) || sum !== BigInt(data.lastEventSeq) - BigInt(data.firstEventSeq) + 1n) return 'gap causes do not sum to its range';
  }
  if (m.kind === 'end' && (!isU64(data.nextEventSeq) || !isU64(data.ackedThroughEventSeq) || BigInt(data.ackedThroughEventSeq) >= BigInt(data.nextEventSeq))) return 'end cursor';
  return undefined;
}
function v1ClientProblem(m: unknown, minors: readonly number[]): string | undefined {
  if (!isRecord(m)) return 'not an object';
  if (m.kind === 'hello') return helloProblem(m, 1, 'durableEvents');
  if (!hasKeys(m, ['version', 'kind', 'data']) || !isVersion(m.version, 1, minors)) return 'client envelope';
  if (m.kind === 'ack') return hasKeys(m.data, ['pluginSessionId', 'throughEventSeq']) && isUuid(m.data.pluginSessionId) && isU64(m.data.throughEventSeq) ? undefined : 'ack data';
  if (m.kind === 'clock.probe') return hasKeys(m.data, ['probeId']) && isU64(m.data.probeId) && m.data.probeId !== '0' ? undefined : 'probe data';
  return `client kind ${String(m.kind)}`;
}
function cap0Problem(m: unknown): string | undefined {
  if (!hasKeys(m, ['format', 'version', 'kind', 'captureSessionId', 'packetSeq', 'publishMonotonicNs', 'data'])) return 'packet keys';
  if (m.format !== 'ets2telemetry-cap0' || !isVersion(m.version, 0)) return 'format or version';
  if (!['header', 'envelope', 'loss', 'end'].includes(m.kind as string)) return `kind ${String(m.kind)}`;
  if (!isUuid(m.captureSessionId) || !isU64(m.packetSeq) || !isU64(m.publishMonotonicNs)) return 'packet identity';
  const data = m.data as Json, count = (key: string) => BigInt(data[key] as string);
  if (m.kind === 'header' && !jsonEqual(data.bounds, CAP0_BOUNDS_DOC)) return 'header bounds';
  if (m.kind === 'envelope' && (!isU64(data.envelopeSeq) || data.envelopeSeq === '0' || !Array.isArray(data.observations) || !isRecord(data.attributes) ||
    data.observations.length !== data.attributes.count)) return 'envelope sequence or attribute count';
  if (m.kind === 'loss' && count('droppedQueueFull') + count('droppedBytesFull') !== count('droppedEnvelopes')) return 'loss causes';
  if (m.kind === 'end' && count('enqueuedEnvelopes') + count('droppedEnvelopes') !== count('attemptedEnvelopes')) return 'end counts';
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Payload decoders. Each rejects only with its module's protocol error (v1.md §13 names `ProtocolError`; CAP0 has
// `Cap0Error`) and re-encodes an accepted message to an equal one where the documents define an encoder.
interface PayloadDecoder {
  name: string; limit: number;
  /** Decoders of one protocol and direction (the two v1 readers of a sender) share it; isolation is between protocols. */
  protocol: string;
  decode(bytes: Uint8Array): unknown;
  isRejection(error: unknown): boolean;
  /** Doc-derived checks of an accepted message, or undefined. */
  problem(message: unknown, bytes: Uint8Array): string | undefined;
  /** The re-encoded payload, or undefined when the documented encoder refuses it for size alone. */
  reencode(message: unknown): Uint8Array | undefined;
}
function encodedOrSizeRefusal(encode: () => Uint8Array, isRejection: (error: unknown) => boolean, tooLarge: boolean): Uint8Array | undefined {
  let frame: Uint8Array;
  try { frame = encode(); } catch (error) {
    // "Encoding validates the schema first, then enforces the payload byte limit" (v0.md; v1.md §3): an accepted message
    // can only be refused for its size.
    if (isRejection(error) && tooLarge) return undefined;
    return violate(`the encoder refused an accepted message: ${describeError(error)}`);
  }
  check(prefixOf(frame) === frame.length - 4, () => `encoded prefix ${prefixOf(frame)} differs from the ${frame.length - 4}-byte payload`);
  return frame.subarray(4);
}
const jsonBytes = (message: unknown) => utf8.encode(JSON.stringify(message)).length;
const v0Decoder: PayloadDecoder = {
  name: 'protocol v0 decodePayload', limit: V0_PAYLOAD_BYTES, protocol: 'v0',
  decode: bytes => v0.decodePayload(bytes), isRejection: error => error instanceof v0.ProtocolError,
  problem: message => {
    const problem = v0Problem(message); if (problem) return problem;
    const m = message as v0.ProtocolMessage;
    // A hello negotiates version 0.0 without durable recording; diagnostics may be declined but never exceed the request
    // (v0.md "Versions and handshake").
    if (m.kind === 'hello') {
      const n = v0.negotiateV0(m);
      if (!isVersion(n.version, 0) || n.durableRecording !== false || typeof n.diagnostics !== 'boolean' || (n.diagnostics && !m.data.diagnostics)) return 'negotiation';
    }
    return undefined;
  },
  reencode: message => encodedOrSizeRefusal(() => v0.encodeFrame(message as v0.ProtocolMessage), error => error instanceof v0.ProtocolError, jsonBytes(message) > V0_PAYLOAD_BYTES)
};
/**
 * A v1 reader: `maxMinor: 1` accepts every documented minor, so minor-1 seeds and minor swaps are in scope; the
 * default reader accepts minor 0 only, as every current caller does (v1.md §2, ET-050b).
 */
const v1Decoder = (sender: v1.Sender, maxMinor: 0 | 1): PayloadDecoder => {
  const reader = maxMinor === 1 ? {maxMinor} : {}, minors = V1_MINORS_DOC.slice(0, maxMinor + 1);
  return {
  name: `protocol v1 decodePayload (${sender}, ${maxMinor === 1 ? 'maxMinor 1' : 'default minor-0'} reader)`, limit: sender === 'server' ? V1_SERVER_PAYLOAD_BYTES : V1_CLIENT_PAYLOAD_BYTES,
  protocol: `v1-${sender}`,
  decode: bytes => v1.decodePayload(bytes, sender, reader), isRejection: error => error instanceof v1.ProtocolError,
  problem: (message, bytes) => {
    if (sender === 'server') return v1ServerProblem(message, bytes.length, minors);
    const problem = v1ClientProblem(message, minors); if (problem) return problem;
    const m = message as v1.ClientMessage;
    // The server selects min(hello maxMinor, its own maxMinor), 0 by default, and durable delivery is never granted beyond
    // the request, nor by a server that does not offer it (v1.md §4; the endpoint stays live-only without its service
    // policy, ET-004b OD-2).
    if (m.kind === 'hello') for (const allowDurable of [true, false]) for (const own of [undefined, 0, 1]) {
      const n = v1.negotiateV1(m, own === undefined ? {allowDurable} : {allowDurable, maxMinor: own}), selected = Math.min(m.data.maxMinor, own ?? 0);
      if (!hasKeys(n.version, ['major', 'minor']) || n.version.major !== 1 || n.version.minor !== selected || n.minor !== selected ||
        typeof n.durableEvents !== 'boolean' || (n.durableEvents && !(m.data.durableEvents && allowDurable))) return 'negotiation';
    }
    return undefined;
  },
  reencode: message => {
    const size = jsonBytes(message), kind = (message as {kind?: unknown}).kind;
    const tooLarge = size > (sender === 'server' ? V1_SERVER_PAYLOAD_BYTES : V1_CLIENT_PAYLOAD_BYTES) || (kind === 'event' && size > V1_EVENT_BYTES);
    return encodedOrSizeRefusal(() => v1.encodeFrame(message as v1.ProtocolMessage, reader), error => error instanceof v1.ProtocolError, tooLarge);
  }
  };
};
const cap0Decoder: PayloadDecoder = {
  name: 'CAP0 decodeCap0Payload', limit: CAP0_PACKET_BYTES, protocol: 'cap0',
  decode: bytes => cap0.decodeCap0Payload(bytes), isRejection: error => error instanceof cap0.Cap0Error,
  problem: message => cap0Problem(message),
  // CAP0 defines no TypeScript packet encoder; the exporter re-serializes packets as JSON (cap0.md "Export and
  // sanitization"), so a re-serialized accepted packet must decode to an equal packet.
  reencode: message => { const bytes = utf8.encode(JSON.stringify(message)); return bytes.length > CAP0_PACKET_BYTES ? undefined : bytes; }
};
const v1Server = v1Decoder('server', 1), v1Client = v1Decoder('client', 1);
const v1ServerDefault = v1Decoder('server', 0), v1ClientDefault = v1Decoder('client', 0);
const PAYLOAD_DECODERS = [v0Decoder, v1Server, v1Client, cap0Decoder, v1ServerDefault, v1ClientDefault];
/** The maxMinor-1 reader of the same sender, which must accept whatever the default reader accepts. */
const WIDER_READER = new Map<PayloadDecoder, PayloadDecoder>([[v1ServerDefault, v1Server], [v1ClientDefault, v1Client]]);
type Outcome = {accepted: true; message: unknown} | {accepted: false};
function decodeWith(decoder: PayloadDecoder, bytes: Uint8Array): Outcome {
  try { return {accepted: true, message: decoder.decode(bytes)}; } catch (error) {
    if (error instanceof Violation) throw error;
    check(decoder.isRejection(error), () => `${decoder.name} threw an undocumented ${describeError(error)}`);
    return {accepted: false};
  }
}
/** Every invariant of an accepted payload: bounds, doc-derived checks and an equal re-encoding. */
function checkAccepted(decoder: PayloadDecoder, bytes: Uint8Array, message: unknown): void {
  check(bytes.length >= 1 && bytes.length <= decoder.limit, () => `${decoder.name} accepted a ${bytes.length}-byte payload beyond its 1-${decoder.limit} byte bound`);
  const problem = decoder.problem(message, bytes);
  check(problem === undefined, () => `${decoder.name} accepted a message outside its documented contract: ${problem}`);
  const again = decoder.reencode(message);
  if (!again) return;
  const outcome = decodeWith(decoder, again);
  check(outcome.accepted && jsonEqual(outcome.message, message), () => `${decoder.name} did not round-trip an accepted message: ${toText(again).slice(0, 512)}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Seeds: the valid shared fixtures (and synthetic CAP0 packets, tests/shared/cap0-fixtures.ts).
const manifest = (dir: string) => readFileSync(resolve(dir, 'manifest.txt'), 'utf8').trim().split(/\r?\n/).map(line => line.trim().split(/\s+/));
const fixtures = (dir: string, result: string) => manifest(dir).filter(([, r]) => r === result).map(([file]) => new Uint8Array(readFileSync(resolve(dir, file))));
const V0_SEEDS = fixtures(resolve('tests/fixtures/protocol-v0'), 'valid');
// The frozen minor-0 corpus and the ET-050b minor-1 corpus.
const V1_DIRS = [resolve('tests/fixtures/protocol-v1'), resolve('tests/fixtures/protocol-v1/minor1')];
const V1_SERVER_SEEDS = V1_DIRS.flatMap(dir => fixtures(dir, 'valid'));
const V1_CLIENT_SEEDS = V1_DIRS.flatMap(dir => fixtures(dir, 'valid-client'));
const V1_MINOR0_SERVER_SEEDS = fixtures(V1_DIRS[0], 'valid'), V1_MINOR0_CLIENT_SEEDS = fixtures(V1_DIRS[0], 'valid-client');
const CAP0_SEEDS = [header(0), header(0, 'game'), envelope(1, 1, {observations: delivered()}), envelope(2, 2, {group: 'lifecycle', id: 'simulation.paused'}),
  envelope(3, 4, {droppedBefore: 1, group: 'configuration', id: 'job', observations: [observation(0, 'cargo', 'string', 'Caf\u00e9 \u0001\t\u{1f69a}'),
    observation(1, 'cargo.mass', 'float', 1.5e4), observation(2, 'planned_distance.km', 'u32', 4_294_967_295)], total: 5, final: false}),
  loss(4, 7, 2), end(5, 7, 2)].map(packet => cap0Payload(packet));

// ---------------------------------------------------------------------------------------------------------------------
// Mutations. "preserve" keeps the documented meaning, "defect" adds exactly one documented rejection cause, "havoc"
// stacks arbitrary byte and structure edits.
interface Scan {gaps: number[]; objects: number[]; keys: [number, number][]; plain: number[]; numbers: [number, number][]; digitStrings: [number, number][]}
/** Token positions of JSON text: structural gaps, object starts, key and number ranges and unescaped printable string characters. */
function scan(text: string): Scan {
  const s: Scan = {gaps: [0, text.length], objects: [], keys: [], plain: [], numbers: [], digitStrings: []};
  for (let i = 0; i < text.length;) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; const plain: number[] = [];
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += text[j + 1] === 'u' ? 6 : 2; continue; }
        const code = text.charCodeAt(j); if (code >= 0x20 && code < 0x7f) plain.push(j); j++;
      }
      let k = j + 1; while (k < text.length && ' \t\r\n'.includes(text[k])) k++;
      if (text[k] === ':') s.keys.push([i + 1, j]);
      else if (/^-?[0-9]+$/.test(text.slice(i + 1, j))) s.digitStrings.push([i + 1, j]);
      s.plain.push(...plain); i = j + 1; continue;
    }
    if ('{}[],:'.includes(c)) { if (c === '{') s.objects.push(i); s.gaps.push(i, i + 1); i++; continue; }
    const number = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(i, i + 64));
    if (number) { s.numbers.push([i, i + number[0].length]); i += number[0].length; continue; }
    i++;
  }
  return s;
}
const splice = (text: string, start: number, end: number, insert: string) => text.slice(0, start) + insert + text.slice(end);
const spliceBytes = (bytes: Uint8Array, start: number, end: number, insert: Uint8Array) => concat(bytes.subarray(0, start), insert, bytes.subarray(end));
const textStep = (edit: (text: string, s: Scan) => string | undefined) => (bytes: Uint8Array) => {
  const text = toText(bytes), edited = edit(text, scan(text));
  return edited === undefined ? undefined : utf8.encode(edited);
};
const treeStep = (edit: (root: unknown) => unknown) => (bytes: Uint8Array) => {
  let root: unknown;
  try { root = JSON.parse(toText(bytes)); } catch { return undefined; }
  const edited = edit(root);
  return edited === undefined ? undefined : utf8.encode(JSON.stringify(edited));
};
interface Slot {parent: Json | unknown[]; key: string | number}
function slots(root: unknown): Slot[] {
  const out: Slot[] = [], stack: unknown[] = [root];
  while (stack.length) {
    const node = stack.pop();
    if (Array.isArray(node)) node.forEach((child, key) => { out.push({parent: node, key}); stack.push(child); });
    else if (isRecord(node)) for (const key of Object.keys(node)) { out.push({parent: node, key}); stack.push(node[key]); }
  }
  return out;
}
const objectsOf = (root: unknown) => [root, ...slots(root).map(({parent, key}) => (parent as Json)[key as string])].filter(isRecord);
const read = (slot: Slot) => (slot.parent as Json)[slot.key as string];
const write = (slot: Slot, value: unknown) => { (slot.parent as Json)[slot.key as string] = value; };
const nested = (depth: number) => { let value: unknown = 0; for (let i = 0; i < depth; i++) value = [value]; return value; };
const escapeChar = (r: Random, c: string) => c === '/' && r() < 0.5 ? '\\/' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')[r() < 0.5 ? 'toLowerCase' : 'toUpperCase']()}`;
const WHITESPACE = [' ', '\t', '\n', '\r'];
const BARE_EDGES = ['0', '-0', '1', '-1', '0.5', '-0.5', '1e308', '-1e308', '1.7976931348623157e308', '5e-324', '1e-400', '9007199254740991', '9007199254740993',
  '4294967295', '4294967296', '2147483647', '2147483648', '-2147483648', '-2147483649', '65535', '65536', '16', '17', '255', '256', '1000', '1001',
  '100000', '1000000', '1000000000000', '3.4028234663852886e38', '3.5e38', '1e400'];
const QUOTED_EDGES = ['0', '1', '18446744073709551614', '18446744073709551615', '18446744073709551616', '99999999999999999999', '9223372036854775807',
  '-9223372036854775808', '-9223372036854775809', '01', '-0', '', '1e3', '4294967295', '4294967296', '9007199254740993', ' 1'];
const VALID_UTF8 = [[0xc3, 0xa9], [0xe2, 0x82, 0xac], [0xf0, 0x9f, 0x9a, 0x9a], [0xef, 0xbb, 0xbf], [0x7f]];
const INVALID_UTF8 = [[0xc0, 0xaf], [0xe0, 0x80, 0xaf], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0x80], [0xff], [0xe2, 0x82], [0xf0, 0x9f, 0x9a]];
/** Byte positions between two ASCII bytes, where an inserted multi-byte sequence cannot join a neighbouring character. */
const asciiBoundaries = (bytes: Uint8Array) => { const out: number[] = []; for (let p = 0; p <= bytes.length; p++) if ((p === 0 || bytes[p - 1] < 0x80) && (p === bytes.length || bytes[p] < 0x80)) out.push(p); return out; };

type Step = (bytes: Uint8Array) => Uint8Array | undefined;
interface Mutator {preserve: Record<string, Step>; defect: Record<string, Step>; havoc: Record<string, Step>}
/** The mutation sets for one generator; `sizes` are the documented bounds that padding aims at, `schema` adds the v0/v1-only defects. */
function mutator(r: Random, sizes: number[], schema: boolean, minorSwapsValid = false): Mutator {
  const preserve: Record<string, Step> = {
    // JSON whitespace between tokens, including before and after the value (v0.md, v1.md §3).
    whitespace: textStep((text, s) => { const at = pick(r, s.gaps); return splice(text, at, at, Array.from({length: between(r, 1, 4)}, () => pick(r, WHITESPACE)).join('')); }),
    // Member order is immaterial (v0.md, v1.md §3).
    reorder: treeStep(root => {
      const objects = objectsOf(root); if (!objects.length) return undefined;
      const object = pick(r, objects), entries = Object.entries(object);
      for (let i = entries.length - 1; i > 0; i--) { const j = between(r, 0, i); [entries[i], entries[j]] = [entries[j], entries[i]]; }
      for (const [key] of entries) delete object[key];
      for (const [key, value] of entries) object[key] = value;
      return root;
    }),
    // Decoders accept any valid JSON escape (v1.md §3); member names included, as duplicate detection relies on it.
    escape: textStep((text, s) => { if (!s.plain.length) return undefined; const at = pick(r, s.plain); return splice(text, at, at + 1, escapeChar(r, text[at])); }),
    // Trailing whitespace up to, or just past, a documented byte bound.
    pad: bytes => {
      const targets = [...sizes, ...sizes.map(n => n + 1), bytes.length + between(r, 1, 64)].filter(n => n > bytes.length);
      return targets.length ? concat(bytes, utf8.encode(' '.repeat(pick(r, targets) - bytes.length))) : undefined;
    }
  };
  const defect: Record<string, Step> = {
    // Duplicate member names, also spelled with escapes, are rejected at every level (v0.md, v1.md §3, cap0.md).
    duplicateMember: textStep((text, s) => {
      if (!s.keys.length) return undefined;
      const [start, stop] = pick(r, s.keys), name = text.slice(start, stop);
      const spelled = r() < 0.5 && /^[A-Za-z0-9]/.test(name) ? escapeChar(r, name[0]) + name.slice(1) : name;
      return splice(text, start - 1, start - 1, `"${spelled}":0,`);
    }),
    // Unknown fields are rejected (v0.md, v1.md §3, cap0.md "Unknown keys are rejected").
    unknownMember: textStep((text, s) => { if (!s.objects.length) return undefined; const at = pick(r, s.objects) + 1; return splice(text, at, at, '"fuzzUnknownMember":0,'); }),
    // Invalid or overlong UTF-8 anywhere (v0.md, v1.md §3, cap0.md).
    invalidUtf8: bytes => { const at = pick(r, asciiBoundaries(bytes)); return spliceBytes(bytes, at, at, Uint8Array.from(pick(r, INVALID_UTF8))); },
    // Unpaired surrogate escapes (v0.md, v1.md §3, cap0.md).
    loneSurrogate: textStep((text, s) => { if (!s.plain.length) return undefined; const at = pick(r, s.plain); return splice(text, at, at, pick(r, ['\\ud800', '\\udbff', '\\udc00', '\\udfff'])); }),
    // Raw control characters are never valid inside JSON strings.
    rawControl: textStep((text, s) => { if (!s.plain.length) return undefined; const at = pick(r, s.plain); return splice(text, at, at, pick(r, ['\u0000', '\u0001', '\u001f'])); }),
    // Trailing non-whitespace (v0.md, v1.md §3, cap0.md).
    trailingData: bytes => concat(bytes, utf8.encode(pick(r, ['x', '0', '}', ']', ',', '{}', 'null', '"', '\u0000']))),
    // No BOM (v0.md, v1.md §3).
    byteOrderMark: bytes => concat(Uint8Array.of(0xef, 0xbb, 0xbf), bytes),
    // Non-finite numbers (v0.md, v1.md §3).
    nonFinite: textStep((text, s) => { if (!s.numbers.length) return undefined; const [start, stop] = pick(r, s.numbers); return splice(text, start, stop, pick(r, ['1e400', '-1e400', '1E999'])); }),
    // Malformed numeric grammar (v0.md, v1.md §3).
    malformedNumber: textStep((text, s) => {
      if (!s.numbers.length) return undefined;
      const [start, stop] = pick(r, s.numbers);
      return splice(text, start, stop, pick(r, ['01', '-01', '00', '1.', '+1', '.5', '-', '1e', '1e+', '0x10', 'NaN', 'Infinity', '--1', '1.e5']));
    }),
    // Any other version fails closed (v0.md, v1.md §2, cap0.md).
    version: treeStep(root => {
      const version = isRecord(root) ? root.version : undefined;
      if (!isRecord(root) || !hasKeys(version, ['major', 'minor'])) return undefined;
      // For a reader that accepts both minors, a v1 message whose kind does not depend on the minor stays valid at the
      // other documented minor (v1.md §2), so that swap is no defect for it. The default reader still refuses it.
      const sameSchema = minorSwapsValid && version.major === 1 && V1_MINORS_DOC.includes(version.minor as number) && !V1_MINOR_DEPENDENT_KINDS.includes(root.kind as string);
      const options = [[0, 0], [1, 0], [0, 1], [1, 1], [2, 0], [255, 0], [0, 65_535], [-1, 0]]
        .filter(([major, minor]) => (major !== version.major || minor !== version.minor) && !(sameSchema && major === 1 && V1_MINORS_DOC.includes(minor)));
      const [major, minor] = pick(r, options); root.version = {major, minor}; return root;
    })
  };
  if (schema) {
    // Every documented field is mandatory, and none is null (v0.md "All object fields below are mandatory ... never
    // omission or null"; v1.md §3 "unknown or missing fields; null in place of an availability object").
    defect.missingMember = treeStep(root => { const objects = objectsOf(root).filter(o => Object.keys(o).length); if (!objects.length) return undefined; const object = pick(r, objects); delete object[pick(r, Object.keys(object))]; return root; });
    defect.nullValue = treeStep(root => { const all = slots(root); if (!all.length) return undefined; write(pick(r, all), null); return root; });
  }
  const havoc: Record<string, Step> = {
    bitFlip: bytes => { if (!bytes.length) return undefined; const out = bytes.slice(); for (let n = between(r, 1, 4); n > 0; n--) out[between(r, 0, out.length - 1)] ^= 1 << between(r, 0, 7); return out; },
    insertByte: bytes => { const at = between(r, 0, bytes.length); return spliceBytes(bytes, at, at, Uint8Array.of(r() < 0.5 ? between(r, 0, 255) : pick(r, [0x22, 0x5c, 0x7b, 0x7d, 0x5b, 0x5d, 0x2c, 0x3a, 0x00, 0x20]))); },
    deleteBytes: bytes => { if (!bytes.length) return undefined; const at = between(r, 0, bytes.length - 1); return spliceBytes(bytes, at, Math.min(bytes.length, at + between(r, 1, 8)), new Uint8Array()); },
    truncate: bytes => bytes.slice(0, between(r, 0, bytes.length)),
    duplicateSlice: bytes => { if (!bytes.length) return undefined; const from = between(r, 0, bytes.length - 1), slice = bytes.slice(from, Math.min(bytes.length, from + between(r, 1, 64))); const at = between(r, 0, bytes.length); return spliceBytes(bytes, at, at, slice); },
    utf8: bytes => { const at = between(r, 0, bytes.length); return spliceBytes(bytes, at, at, Uint8Array.from(pick(r, r() < 0.5 ? VALID_UTF8 : INVALID_UTF8))); },
    numericEdge: textStep((text, s) => {
      if (s.digitStrings.length && (r() < 0.5 || !s.numbers.length)) { const [start, stop] = pick(r, s.digitStrings); return splice(text, start, stop, pick(r, QUOTED_EDGES)); }
      if (!s.numbers.length) return undefined;
      const [start, stop] = pick(r, s.numbers); return splice(text, start, stop, pick(r, BARE_EDGES));
    }),
    tree: treeStep(root => {
      const all = slots(root); if (!all.length) return undefined;
      const slot = pick(r, all);
      switch (between(r, 0, 5)) {
        case 0: write(slot, pick(r, [null, true, false, 0, -1, '', 'x', [], {}, Number(pick(r, BARE_EDGES)), pick(r, QUOTED_EDGES)])); break;
        case 1: write(slot, structuredClone(read(pick(r, all)))); break;
        case 2: write(slot, nested(between(r, 14, 18))); break;
        case 3: if (Array.isArray(slot.parent)) slot.parent.splice(slot.key as number, 1); else delete slot.parent[slot.key as string]; break;
        case 4: if (Array.isArray(slot.parent)) slot.parent.push(structuredClone(read(slot))); else slot.parent[`${String(slot.key)}${between(r, 0, 9)}`] = read(slot); break;
        default: write(slot, [read(slot)]); break;
      }
      return root;
    })
  };
  return {preserve, defect, havoc};
}
/** Applies one randomly chosen applicable step of a set; returns undefined if none applies. */
function applyOne(it: Iteration, set: Record<string, Step>, bytes: Uint8Array): Uint8Array | undefined {
  const names = Object.keys(set);
  for (let i = names.length - 1; i > 0; i--) { const j = between(it.random, 0, i); [names[i], names[j]] = [names[j], names[i]]; }
  for (const name of names) { const out = set[name](bytes); if (out !== undefined) { it.steps.push(name); return out; } }
  return undefined;
}
type Mode = 'preserve' | 'defect' | 'havoc';
/** Mutates a valid payload in one mode and returns the input. */
function mutatePayload(it: Iteration, m: Mutator, seed: Uint8Array, mode: Mode): Uint8Array {
  let bytes = seed;
  if (mode === 'preserve') { for (let n = between(it.random, 1, 3); n > 0; n--) bytes = applyOne(it, m.preserve, bytes) ?? bytes; return bytes; }
  if (mode === 'defect') {
    // At most one preserving step first, so the defect is not always found in the fixture's own spelling.
    if (it.random() < 0.5) bytes = applyOne(it, {whitespace: m.preserve.whitespace, reorder: m.preserve.reorder, escape: m.preserve.escape}, bytes) ?? bytes;
    return applyOne(it, m.defect, bytes) ?? violate('no defect applies to a valid seed');
  }
  const all = {...m.havoc, ...m.havoc, ...m.preserve, ...m.defect};
  for (let n = between(it.random, 1, 4); n > 0; n--) bytes = applyOne(it, all, bytes) ?? bytes;
  return bytes;
}
const chooseMode = (r: Random): Mode => { const x = r(); return x < 0.25 ? 'preserve' : x < 0.5 ? 'defect' : 'havoc'; };

// ---------------------------------------------------------------------------------------------------------------------
// Payload campaigns: every input goes to every payload decoder, including both v1 readers of each direction.
interface PayloadFamily {decoder: PayloadDecoder; seeds: Uint8Array[]; sizes: number[]; schema: boolean; minorSwapsValid: boolean; iterations: number}
const PAYLOAD_FAMILIES: PayloadFamily[] = [
  {decoder: v0Decoder, seeds: V0_SEEDS, sizes: [V0_PAYLOAD_BYTES], schema: true, minorSwapsValid: false, iterations: ITERATIONS},
  {decoder: v1Server, seeds: V1_SERVER_SEEDS, sizes: [V1_SERVER_PAYLOAD_BYTES, V1_EVENT_BYTES], schema: true, minorSwapsValid: true, iterations: ITERATIONS},
  {decoder: v1Client, seeds: V1_CLIENT_SEEDS, sizes: [V1_CLIENT_PAYLOAD_BYTES], schema: true, minorSwapsValid: true, iterations: ITERATIONS},
  {decoder: cap0Decoder, seeds: CAP0_SEEDS, sizes: [CAP0_PACKET_BYTES], schema: false, minorSwapsValid: false, iterations: ITERATIONS},
  // The default readers start from the frozen minor-0 corpus, with every version swap a defect, as before ET-050b.
  {decoder: v1ServerDefault, seeds: V1_MINOR0_SERVER_SEEDS, sizes: [V1_SERVER_PAYLOAD_BYTES, V1_EVENT_BYTES], schema: true, minorSwapsValid: false, iterations: DEFAULT_READER_ITERATIONS},
  {decoder: v1ClientDefault, seeds: V1_MINOR0_CLIENT_SEEDS, sizes: [V1_CLIENT_PAYLOAD_BYTES], schema: true, minorSwapsValid: false, iterations: DEFAULT_READER_ITERATIONS}
];
/** Whether a meaning-preserving variant of a valid payload stays within the documented byte bounds. */
const withinBounds = (decoder: PayloadDecoder, bytes: Uint8Array, kind: unknown) => bytes.length <= decoder.limit && !(decoder.protocol === 'v1-server' && kind === 'event' && bytes.length > V1_EVENT_BYTES);
function payloadIteration(family: PayloadFamily, it: Iteration, outcomes: Outcomes): void {
  const foreign = it.random() < 0.15, mode: Mode = foreign ? 'havoc' : chooseMode(it.random);
  const pool = foreign ? pick(it.random, PAYLOAD_FAMILIES.filter(f => f !== family)).seeds : family.seeds;
  const seed = pick(it.random, pool);
  it.steps.push(`${foreign ? 'foreign ' : ''}${mode}`);
  const input = mutatePayload(it, mutator(it.random, family.sizes, family.schema, family.minorSwapsValid), seed, mode);
  it.input = input;
  const results = PAYLOAD_DECODERS.map(decoder => decodeWith(decoder, input));
  results.forEach((result, i) => { if (result.accepted) checkAccepted(PAYLOAD_DECODERS[i], input, result.message); });
  // Each decoder rejects the other protocols' payloads (v1.md §2, cap0.md "Isolation from protocol v0").
  const accepting = PAYLOAD_DECODERS.filter((_, i) => results[i].accepted);
  check(new Set(accepting.map(d => d.protocol)).size <= 1, () => `one payload accepted by ${accepting.map(d => d.name).join(' and ')}`);
  // A default reader is a restriction of the maxMinor-1 reader: whatever it accepts, the wider one accepts identically.
  for (const [narrow, wide] of WIDER_READER) {
    const a = results[PAYLOAD_DECODERS.indexOf(narrow)], b = results[PAYLOAD_DECODERS.indexOf(wide)];
    if (a.accepted) check(b.accepted && jsonEqual(a.message, b.message), () => `${narrow.name} accepted a payload that ${wide.name} rejected or decoded differently`);
  }
  const own = results[PAYLOAD_DECODERS.indexOf(family.decoder)];
  if (mode === 'preserve') {
    const expected = family.decoder.decode(seed) as {kind?: unknown};
    if (withinBounds(family.decoder, input, expected.kind)) check(own.accepted && jsonEqual(own.message, expected), () => 'a meaning-preserving variant of a valid payload was rejected or decoded differently');
    else check(!own.accepted, () => `a ${input.length}-byte payload beyond the documented bound was accepted`);
  }
  if (mode === 'defect') check(!own.accepted, () => `a payload with the documented defect ${it.steps.at(-1)} was accepted`);
  if (own.accepted) outcomes.accepted++; else outcomes.rejected++;
}

// ---------------------------------------------------------------------------------------------------------------------
// Streaming frame decoders, checked against a framing model written from the documents: a four-byte little-endian
// length of 1..max, then the payload; a bad prefix or payload rejects at once and closes the decoder for good; a partial
// header or payload at EOF is an error; any byte split gives the same result (v0.md "Encoding and bounds", v1.md §3,
// cap0.md "Wire format").
interface Framing {
  name: string; max: number; family: PayloadFamily;
  push(chunk: Uint8Array, emit: (item: unknown) => void): void;
  /** True when the stream ended cleanly on a frame boundary. Throws the documented error otherwise, where the API does. */
  finish(): boolean;
  isRejection(error: unknown): boolean;
  /** What the decoder emits for one complete payload: the decoded message, or the payload bytes for CAP0. */
  item(payload: Uint8Array): unknown;
  same(a: unknown, b: unknown): boolean;
}
const v0Framing = (): Framing => {
  const d = new v0.FrameDecoder();
  return {name: 'protocol v0 FrameDecoder', max: V0_PAYLOAD_BYTES, family: PAYLOAD_FAMILIES[0], push: (chunk, emit) => d.push(chunk, emit),
    finish: () => { d.end(); return true; }, isRejection: e => e instanceof v0.ProtocolError, item: payload => v0.decodePayload(payload), same: jsonEqual};
};
const v1Framing = (sender: v1.Sender, maxMinor: 0 | 1) => (): Framing => {
  const reader = maxMinor === 1 ? {maxMinor} : {}, d = maxMinor === 1 ? new v1.FrameDecoder(sender, reader) : new v1.FrameDecoder(sender);
  return {name: `protocol v1 FrameDecoder (${sender}, ${maxMinor === 1 ? 'maxMinor 1' : 'default minor-0'} reader)`, max: sender === 'server' ? V1_SERVER_PAYLOAD_BYTES : V1_CLIENT_PAYLOAD_BYTES,
    family: PAYLOAD_FAMILIES[maxMinor === 1 ? (sender === 'server' ? 1 : 2) : (sender === 'server' ? 4 : 5)], push: (chunk, emit) => d.push(chunk, emit), finish: () => { d.end(); return true; },
    isRejection: e => e instanceof v1.ProtocolError, item: payload => v1.decodePayload(payload, sender, reader), same: jsonEqual};
};
const cap0Framing = (): Framing => {
  const d = new cap0.Cap0FrameDecoder();
  return {name: 'CAP0 Cap0FrameDecoder', max: CAP0_PACKET_BYTES, family: PAYLOAD_FAMILIES[3], push: (chunk, emit) => d.push(chunk, emit), finish: () => d.idle,
    isRejection: e => e instanceof cap0.Cap0Error, item: payload => payload.slice(), same: (a, b) => sameBytes(a as Uint8Array, b as Uint8Array)};
};
type StreamEnd = 'clean' | 'truncated' | 'rejected';
interface StreamResult {items: unknown[]; end: StreamEnd}
/** The documented framing over a whole stream. Payload acceptance is the payload decoder's, fuzzed separately above. */
function framingModel(framing: Framing, stream: Uint8Array): StreamResult {
  const items: unknown[] = [];
  for (let at = 0; ;) {
    if (at === stream.length) return {items, end: 'clean'};
    if (stream.length - at < 4) return {items, end: 'truncated'};
    const length = prefixOf(stream, at);
    if (length === 0 || length > framing.max) return {items, end: 'rejected'};
    if (stream.length - at - 4 < length) return {items, end: 'truncated'};
    try { items.push(framing.item(stream.subarray(at + 4, at + 4 + length))); } catch (error) {
      check(framing.isRejection(error), () => `${framing.name} payload decoding threw an undocumented ${describeError(error)}`);
      return {items, end: 'rejected'};
    }
    at += 4 + length;
  }
}
const NativeUint8Array = Uint8Array;
/**
 * Runs a push while `new Uint8Array(n)` refuses any n above the documented payload bound, before allocating it: "Decoder
 * rejects larger prefixes before allocating" (v1.md §9) and "retains at most one payload" (v0.md). This observes
 * allocations made through the global constructor, which is how these decoders allocate their payload buffer.
 */
function withAllocationBound(max: number, run: () => void): void {
  const bounded = new Proxy(NativeUint8Array, {construct(target, args: unknown[], newTarget: new (...a: unknown[]) => object) {
    if (typeof args[0] === 'number' && args[0] > max) violate(`the decoder allocated a ${args[0]}-byte array beyond the documented ${max}-byte payload bound`);
    return Reflect.construct(target, args, newTarget) as object;
  }});
  globalThis.Uint8Array = bounded;
  try { run(); } finally { globalThis.Uint8Array = NativeUint8Array; }
}
/** An emit count no correct decoder can reach: every frame has at least five bytes. */
const emitGuard = (stream: Uint8Array) => Math.floor(stream.length / 5) + 1;
function feed(create: () => Framing, stream: Uint8Array, chunks: Uint8Array[]): StreamResult {
  const framing = create(), items: unknown[] = [], guard = emitGuard(stream);
  const emit = (item: unknown) => { check(items.length < guard, () => `more than ${guard} items emitted from ${stream.length} bytes`); items.push(item); };
  for (const chunk of chunks) {
    try { withAllocationBound(framing.max, () => framing.push(chunk, emit)); } catch (error) {
      if (error instanceof Violation) throw error;
      check(framing.isRejection(error), () => `${framing.name} threw an undocumented ${describeError(error)}`);
      // Fail closed: a rejected decoder never scans for a later prefix, so a valid frame afterwards is refused too.
      const after = items.length;
      try { framing.push(frameOf(pick(mulberry32(stream.length), framing.family.seeds)), emit); } catch (closed) {
        if (closed instanceof Violation) throw closed;
        check(framing.isRejection(closed), () => `a closed ${framing.name} threw an undocumented ${describeError(closed)}`);
        check(items.length === after, () => 'a closed decoder emitted another item');
        return {items, end: 'rejected'};
      }
      return violate(`${framing.name} accepted input after rejecting the stream`);
    }
  }
  try { return {items, end: framing.finish() ? 'clean' : 'truncated'}; } catch (error) {
    if (error instanceof Violation) throw error;
    check(framing.isRejection(error), () => `${framing.name} end() threw an undocumented ${describeError(error)}`);
    return {items, end: 'truncated'};
  }
}
function splitPoints(r: Random, length: number): number[] {
  if (length > 1 && length <= 4_096 && r() < 0.1) return Array.from({length: length - 1}, (_, i) => i + 1);
  return [...new Set(Array.from({length: between(r, 1, 8)}, () => between(r, 1, Math.max(1, length - 1))))].filter(p => p < length).sort((a, b) => a - b);
}
const cut = (bytes: Uint8Array, points: number[]) => [0, ...points].map((start, i) => bytes.subarray(start, points[i] ?? bytes.length));
function sameResult(framing: Framing, a: StreamResult, b: StreamResult): boolean {
  return a.end === b.end && a.items.length === b.items.length && a.items.every((item, i) => framing.same(item, b.items[i]));
}
const summary = (result: StreamResult) => `${result.items.length} items, ${result.end}`;
function frameIteration(create: () => Framing, it: Iteration, outcomes: Outcomes): void {
  const probe = create(), r = it.random, family = probe.family, m = mutator(r, family.sizes, family.schema, family.minorSwapsValid);
  const frames: Uint8Array[] = [];
  for (let n = between(r, 1, 4); n > 0; n--) {
    const seed = pick(r, family.seeds);
    frames.push(frameOf(r() < 0.5 ? seed : mutatePayload(it, m, seed, chooseMode(r))));
  }
  if (r() < 0.15) { const k = between(r, 0, frames.length - 1); frames.splice(k, 0, frames[k]); it.steps.push('duplicate frame'); }
  if (r() < 0.1) {
    // A frame at, or one byte past, the documented payload bound; JSON whitespace keeps the padded payload valid.
    const seed = pick(r, family.seeds), size = probe.max + (r() < 0.5 ? 0 : 1);
    if (seed.length <= size) { frames.push(frameOf(concat(seed, utf8.encode(' '.repeat(size - seed.length))))); it.steps.push(`frame of ${size} bytes`); }
  }
  let stream: Uint8Array = concat(...frames);
  if (r() < 0.25) {
    // Length-field corruption, including zero, one past the payload and oversize values.
    let at = 0; const starts: number[] = []; for (const f of frames) { starts.push(at); at += f.length; }
    const start = pick(r, starts), real = prefixOf(stream, start);
    const value = pick(r, [0, 1, real - 1, real + 1, probe.max, probe.max + 1, 0xffff_ffff, between(r, 0, 0xffff_ffff)]) >>> 0;
    stream = stream.slice(); new DataView(stream.buffer).setUint32(start, value, true); it.steps.push(`prefix ${value}`);
  }
  if (r() < 0.15) { const at = between(r, 0, stream.length); stream = stream.slice(0, at); it.steps.push(`truncate at ${at}`); }
  if (r() < 0.15) stream = applyOne(it, {bitFlip: m.havoc.bitFlip, insertByte: m.havoc.insertByte, deleteBytes: m.havoc.deleteBytes}, stream) ?? stream;
  it.input = stream;
  const model = framingModel(probe, stream), points = splitPoints(r, stream.length);
  it.steps.push(`split at ${points.length > 16 ? `${points.length} points` : points.join(' ')}`);
  const whole = feed(create, stream, [stream]), split = feed(create, stream, cut(stream, points));
  check(sameResult(probe, whole, model), () => `whole stream gave ${summary(whole)}, the documented framing ${summary(model)}`);
  check(sameResult(probe, split, model), () => `split stream gave ${summary(split)}, the documented framing ${summary(model)}`);
  if (model.items.length) outcomes.accepted++;
  if (model.end !== 'clean') outcomes.rejected++;
}

// ---------------------------------------------------------------------------------------------------------------------
// Broker stdout readers. The first stdout frame is the authority receipt of at most 4,096 payload bytes; later frames are
// relayed unchanged, one per credit, with at most 65,536 payload bytes; an unsolicited frame, a malformed frame or an
// oversize payload closes the connection (telemetry-service-v0.md "Native broker control" and "Protocol v1 mode",
// cap0.md "Activation and authority"). Receipt and relay violations are final, not transient.
class FakeStream extends EventEmitter { resume(): this { return this; } }
class FakeStdin extends EventEmitter {
  readonly writes: Buffer[] = []; writableEnded = false;
  write(bytes: Uint8Array): boolean { this.writes.push(Buffer.from(bytes)); return true; }
  end(): this { this.writableEnded = true; return this; }
}
class FakeChild extends EventEmitter { readonly stdout = new FakeStream(); readonly stderr = new FakeStream(); readonly stdin = new FakeStdin(); }
let lastChild: FakeChild | undefined;
/** The broker reader of the running iteration, so that a hang-guard termination can still end it. */
let openBrokerClient: {destroy(): void} | undefined;
spawnHook.create = () => (lastChild = new FakeChild());
const BROKER = {executable: 'C:\\isolated\\telemetry-pipe-client.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
const RECEIPT_SOURCE = {game: 'ets2', processId: 4242, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: '22222222-2222-4222-8222-222222222222', origin: 'game'};
interface BrokerMode {
  name: string; receiptExtra: Json; relays: Uint8Array[]; family: PayloadFamily;
  start(): {client: EventEmitter & {destroy(): void}; afterAuthority(): void; afterRelay(): void};
  isRejection(error: unknown): boolean;
  /** The authority the documents expect from a receipt. */
  authority(receipt: Json): Json;
  /** Whether a relayed item is the payload alone (CAP0) or the whole frame. */
  payloadOnly: boolean;
}
// The hello the service sends after an authority receipt: the shared valid hello fixtures, framed without decoding them
// here, so that no product decoding runs outside the hang guard.
const v0Hello = frameOf(new Uint8Array(readFileSync(resolve('tests/fixtures/protocol-v0/hello.json'))));
const v1Hello = frameOf(new Uint8Array(readFileSync(resolve('tests/fixtures/protocol-v1/hello.json'))));
const pipeAuthority = (receipt: Json) => { const s = receipt.source as Json; return {game: 'ets2', origin: s.origin, processId: s.processId, windowsSessionId: s.windowsSessionId, processInstanceId: s.processInstanceId, pluginSessionId: s.pluginSessionId}; };
const pipeMode = (protocol: 'v0' | 'v1'): BrokerMode => ({
  name: `NativePipeClient ${protocol} stdout`, receiptExtra: protocol === 'v1' ? {protocolMajor: 1} : {}, relays: protocol === 'v1' ? V1_SERVER_SEEDS : V0_SEEDS,
  family: PAYLOAD_FAMILIES[protocol === 'v1' ? 1 : 0], payloadOnly: false, authority: pipeAuthority,
  isRejection: error => error instanceof NativeClientError && !error.transient,
  start: () => {
    const client = protocol === 'v1' ? new NativePipeClient(BROKER, 'ets2', undefined, 'v1') : new NativePipeClient(BROKER, 'ets2');
    return {client, afterAuthority: () => client.write(protocol === 'v1' ? v1Hello : v0Hello), afterRelay: () => undefined};
  }
});
const cap0Mode: BrokerMode = {
  name: 'NativeCaptureClient stdout', receiptExtra: {evidence: 'cap0'}, relays: CAP0_SEEDS, family: PAYLOAD_FAMILIES[3], payloadOnly: true,
  authority: receipt => { const s = receipt.source as Json; return {game: 'ets2', processId: s.processId, windowsSessionId: s.windowsSessionId, processInstanceId: s.processInstanceId, pluginSessionId: s.pluginSessionId, processCreationTime: receipt.processCreationTime}; },
  isRejection: error => error instanceof CaptureTransportError && !error.transient,
  start: () => {
    const client = new NativeCaptureClient(BROKER, 'ets2');
    // The service sends its hello after the receipt and returns one credit per packet it has admitted.
    return {client, afterAuthority: () => client.sendHello(cap0.encodeCap0Hello(SESSION)), afterRelay: () => client.credit()};
  }
};
type ReceiptKind = 'authority' | 'waiting' | 'invalid';
/** The documented receipt: five keys in v0, `protocolMajor: 1` in v1 and `evidence: "cap0"` in CAP0, or the waiting record. */
function receiptKind(mode: BrokerMode, payload: Uint8Array): {kind: ReceiptKind; receipt?: Json} {
  if (payload.length < 1 || payload.length > BROKER_RECEIPT_BYTES) return {kind: 'invalid'};
  let receipt: unknown;
  try { receipt = JSON.parse(toText(payload)); } catch { return {kind: 'invalid'}; }
  if (hasKeys(receipt, ['type', 'schemaVersion']) && receipt.type === 'waiting' && receipt.schemaVersion === 1) return {kind: 'waiting'};
  const extra = Object.keys(mode.receiptExtra);
  if (!hasKeys(receipt, ['type', 'schemaVersion', 'source', 'processCreationTime', 'userTag', ...extra]) || receipt.type !== 'authority' || receipt.schemaVersion !== 1 ||
    !extra.every(key => receipt[key] === mode.receiptExtra[key]) || !isU64(receipt.processCreationTime) || typeof receipt.userTag !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.userTag)) return {kind: 'invalid'};
  const s = receipt.source;
  if (!hasKeys(s, ['game', 'processId', 'windowsSessionId', 'processInstanceId', 'pluginSessionId', 'origin']) || s.game !== 'ets2' || s.origin !== 'game' ||
    !isInt(s.processId, 1, 0xffff_ffff) || !isInt(s.windowsSessionId, 0, 0xffff_ffff) || !isUuid(s.processInstanceId) || !isUuid(s.pluginSessionId)) return {kind: 'invalid'};
  return {kind: 'authority', receipt};
}
/** Complete frames of a stdout byte stream by the documented four-byte little-endian length prefix, with their offsets. */
function stdoutFrames(stream: Uint8Array): {start: number; bytes: Uint8Array}[] {
  const frames: {start: number; bytes: Uint8Array}[] = [];
  for (let at = 0; stream.length - at >= 4 && stream.length - at - 4 >= prefixOf(stream, at); at += 4 + prefixOf(stream, at)) frames.push({start: at, bytes: stream.subarray(at, at + 4 + prefixOf(stream, at))});
  return frames;
}
interface BrokerResult {log: string[]; relayed: Uint8Array[]; authority?: unknown; failed: boolean}
function runBroker(mode: BrokerMode, stream: Uint8Array, chunks: Uint8Array[]): BrokerResult {
  const {client, afterAuthority, afterRelay} = mode.start(), child = lastChild!;
  openBrokerClient = client;
  const result: BrokerResult = {log: [], relayed: [], failed: false};
  // Listener checks are recorded, never thrown: the reader turns a listener exception into a rejection.
  let problem: string | undefined;
  const note = (condition: boolean, message: string) => { if (!condition && problem === undefined) problem = message; };
  const credits = () => child.stdin.writes.filter(w => w.length === 1 && w[0] === 0x01).length;
  // Credits sent before each read, by the read's stream offset.
  const reads: {start: number; credits: number}[] = [];
  const onAuthority = (authority: unknown) => {
    note(!result.failed && result.authority === undefined, 'authority after an error or a second authority');
    result.authority = authority; result.log.push(`authority ${JSON.stringify(authority)}`); afterAuthority();
  };
  const onRelay = (bytes: Uint8Array) => {
    note(!result.failed, 'a relayed frame after the rejection');
    note(credits() - result.relayed.length === 1, `relayed frame ${result.relayed.length + 1} without exactly one outstanding credit (${credits()} credits)`);
    result.relayed.push(Uint8Array.from(bytes)); result.log.push(`relay ${bytes.length}`); afterRelay();
  };
  client.on(mode.payloadOnly ? 'authority' : 'connect', mode.payloadOnly ? onAuthority : () => onAuthority((client as NativePipeClient).authority));
  client.on(mode.payloadOnly ? 'packet' : 'data', onRelay);
  client.on('error', (error: unknown) => {
    note(!result.failed, 'a second error');
    note(mode.isRejection(error), `an undocumented or transient rejection ${describeError(error)}`);
    result.failed = true; result.log.push('error');
  });
  try {
    let offset = 0;
    for (const chunk of chunks) {
      reads.push({start: offset, credits: credits()}); offset += chunk.length;
      try { child.stdout.emit('data', Buffer.from(chunk)); } catch (error) { violate(`the stdout reader threw ${describeError(error)}`); }
      check(problem === undefined, () => problem!);
    }
    if (result.failed) check(child.stdin.writableEnded, () => 'the connection stayed open after a rejection');
  } finally { client.destroy(); openBrokerClient = undefined; }
  // Safety: relayed frames are the stream's own frames in order, unchanged and within the bound, after a valid receipt.
  const frames = stdoutFrames(stream);
  if (result.authority !== undefined) {
    const receipt = frames.length ? receiptKind(mode, frames[0].bytes.subarray(4)) : {kind: 'invalid' as const};
    check(receipt.kind === 'authority' && jsonEqual(result.authority, mode.authority(receipt.receipt!)), () => 'authority granted from a receipt outside the documented schema');
  }
  result.relayed.forEach((bytes, i) => {
    const expected = frames[i + 1]?.bytes;
    check(expected !== undefined && sameBytes(bytes, mode.payloadOnly ? expected.subarray(4) : expected), () => `relayed frame ${i + 1} differs from the stream's frame`);
    check(expected.length - 4 >= 1 && expected.length - 4 <= BROKER_RELAY_BYTES, () => `relayed a ${expected.length - 4}-byte payload beyond the documented bound`);
    // The broker writes a frame only after receiving its credit, so the read that delivered the frame's first byte must
    // have been made after that credit was sent; bytes read earlier are unsolicited, even if a credit follows in between.
    const read = reads.filter(entry => entry.start <= frames[i + 1].start).at(-1)!;
    check(read.credits >= i + 1, () => `relayed frame ${i + 1} began in a read made before its credit was sent`);
  });
  return result;
}
function brokerIteration(mode: BrokerMode, it: Iteration, outcomes: Outcomes): void {
  const r = it.random, m = mutator(r, [BROKER_RECEIPT_BYTES, BROKER_RELAY_BYTES], false);
  let receipt: Uint8Array = utf8.encode(JSON.stringify({type: 'authority', schemaVersion: 1, source: RECEIPT_SOURCE, processCreationTime: '133000000000000000', userTag: 'a'.repeat(64), ...mode.receiptExtra}));
  if (r() < 0.05) receipt = utf8.encode(JSON.stringify({type: 'waiting', schemaVersion: 1}));
  if (r() < 0.4) receipt = mutatePayload(it, m, receipt, chooseMode(r));
  const relays = Array.from({length: between(r, 0, 3)}, () => { const seed = pick(r, mode.relays); return r() < 0.3 ? mutatePayload(it, m, seed, 'havoc') : seed; });
  if (r() < 0.1) {
    const seed = pick(r, mode.relays), size = BROKER_RELAY_BYTES + (r() < 0.5 ? 0 : 1);
    relays.push(concat(seed, utf8.encode(' '.repeat(Math.max(0, size - seed.length))))); it.steps.push(`relay of ${size} bytes`);
  }
  const writes = [receipt, ...relays].map(payload => frameOf(payload));
  if (r() < 0.1) { const k = between(r, 0, writes.length - 1); writes.splice(k, 0, writes[k]); it.steps.push('duplicate write'); }
  if (r() < 0.5) {
    // The broker writes one frame per credit: the receipt, then each relayed frame. Fragmented reads of those writes
    // must give exactly the same result as whole writes, and that result follows from the documents alone.
    const stream = concat(...writes); it.input = stream;
    const pieces = writes.flatMap(write => cut(write, splitPoints(r, write.length)));
    it.steps.push(`well-formed writes in ${pieces.length} reads`);
    const whole = runBroker(mode, stream, writes), split = runBroker(mode, stream, pieces);
    check(jsonEqual(whole.log, split.log), () => `fragmented reads gave [${split.log.join('; ')}], whole writes [${whole.log.join('; ')}]`);
    const {kind} = receiptKind(mode, writes[0].subarray(4));
    let expected: string[];
    if (kind === 'invalid') expected = ['error'];
    else if (kind === 'waiting') expected = writes.length > 1 ? ['error'] : [];
    else {
      expected = ['authority'];
      // A payload of 1 to 65,536 bytes is relayed; an empty or larger one (havoc can truncate a seed to nothing) is a
      // malformed frame that closes the connection.
      for (const write of writes.slice(1)) { if (write.length - 4 < 1 || write.length - 4 > BROKER_RELAY_BYTES) { expected.push('error'); break; } expected.push(`relay ${mode.payloadOnly ? write.length - 4 : write.length}`); }
    }
    const shape = whole.log.map(entry => entry.startsWith('authority') ? 'authority' : entry);
    check(jsonEqual(shape, expected), () => `whole writes gave [${shape.join('; ')}], the documents [${expected.join('; ')}]`);
    if (whole.relayed.length) outcomes.accepted++;
    if (whole.failed) outcomes.rejected++;
    return;
  }
  // Arbitrary stdout bytes: corrupted prefixes, coalesced writes and byte edits, in random reads. Only the safety
  // invariants apply, because whether bytes share a read is significant by design (one frame per credit).
  let stream: Uint8Array = concat(...writes);
  let at = 0; const starts = writes.map(w => { const s = at; at += w.length; return s; });
  if (r() < 0.4) {
    const start = pick(r, starts), real = prefixOf(stream, start);
    const value = pick(r, [0, 1, real - 1, real + 1, BROKER_RECEIPT_BYTES, BROKER_RECEIPT_BYTES + 1, BROKER_RELAY_BYTES, BROKER_RELAY_BYTES + 1, 0xffff_ffff, between(r, 0, 0xffff_ffff)]) >>> 0;
    stream = stream.slice(); new DataView(stream.buffer).setUint32(start, value, true); it.steps.push(`prefix ${value}`);
  }
  if (r() < 0.3) stream = applyOne(it, {bitFlip: m.havoc.bitFlip, insertByte: m.havoc.insertByte, deleteBytes: m.havoc.deleteBytes, truncate: m.havoc.truncate}, stream) ?? stream;
  it.input = stream;
  // Reads mostly follow the broker's writes; some adjacent writes share one read (coalesced), and some reads are cut.
  const kept = starts.slice(1).filter(start => start < stream.length && r() < 0.7);
  const points = r() < 0.5 ? [...new Set([...kept, ...splitPoints(r, stream.length)])].sort((a, b) => a - b) : r() < 0.5 ? kept : splitPoints(r, stream.length);
  it.steps.push(`reads at ${points.length > 16 ? `${points.length} points` : points.join(' ')}`);
  const result = runBroker(mode, stream, cut(stream, points));
  if (result.relayed.length) outcomes.accepted++;
  if (result.failed) outcomes.rejected++;
}

// ---------------------------------------------------------------------------------------------------------------------
describe('REG-010 seeded mutation fuzzing of the TypeScript frame parsers', () => {
  it('starts every campaign from seeds that the documents call valid', () => {
    const problems: string[] = [];
    // Decoding runs under the hang guard here too, so a decoder that never returns fails this case instead of stalling it.
    guarded(() => {
      for (const family of PAYLOAD_FAMILIES) {
        if (!family.seeds.length) problems.push(`${family.decoder.name}: no seeds`);
        for (const seed of family.seeds) {
          const problem = family.decoder.problem(family.decoder.decode(seed), seed);
          if (problem) problems.push(`${family.decoder.name}: ${problem}`);
        }
      }
    });
    expect(problems).toEqual([]);
  });
  PAYLOAD_FAMILIES.forEach((family, index) => it(`${family.decoder.name}: rejects only with its protocol error, accepts only documented messages and round-trips them`, () => {
    expectBothOutcomes(campaign(family.decoder.name, index, (it, outcomes) => payloadIteration(family, it, outcomes), family.iterations), family.iterations);
  }, CAMPAIGN_CPU_BUDGET_MS));
  [v0Framing, v1Framing('server', 1), v1Framing('client', 1), cap0Framing, v1Framing('server', 0), v1Framing('client', 0)].forEach((create, index) => {
    const probe = create(), name = probe.name, iterations = probe.family.iterations;
    it(`${name}: follows the documented framing for any byte split and never allocates beyond the bound`, () => {
      expectBothOutcomes(campaign(name, 10 + index, (it, outcomes) => frameIteration(create, it, outcomes), iterations), iterations);
    }, CAMPAIGN_CPU_BUDGET_MS);
  });
  [pipeMode('v0'), pipeMode('v1'), cap0Mode].forEach((mode, index) => it(`${mode.name}: grants authority and relays frames only as documented`, () => {
    expectBothOutcomes(campaign(mode.name, 20 + index, (it, outcomes) => brokerIteration(mode, it, outcomes)));
  }, CAMPAIGN_CPU_BUDGET_MS));
});
