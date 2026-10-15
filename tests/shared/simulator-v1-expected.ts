// Compares a protocol v1 simulator replay with a hand-written expectation file (tests/fixtures/simulator-v1). The
// comparator only reads expectations; it never writes or regenerates them. Seeded identifiers are replaced by their
// labels (for example `game-clock-1`), so expectations never contain hashes.
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {seededId} from '../../tools/telemetry-simulator/src/v1/source';
import {type ReplayResult} from '../../tools/telemetry-simulator/src/v1/replay';

export const SIMULATOR_V1_DIR = resolve('tests/fixtures/simulator-v1');
/** Scenario ids listed once each in manifest.txt; readers accept CRLF. */
export function manifest(): string[] {
  return readFileSync(resolve(SIMULATOR_V1_DIR, 'manifest.txt'), 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}
export const scenarioPath = (id: string) => resolve(SIMULATOR_V1_DIR, `${id}.json`);
export const expectedPath = (id: string) => resolve(SIMULATOR_V1_DIR, `${id}.expected.json`);

const nonzero = (counts: Record<string, string>) => Object.fromEntries(Object.entries(counts).filter(([, v]) => v !== '0'));
const lost = (a: {available: boolean; value?: string}) => a.available ? a.value! : null;
type Snapshot = Extract<ServerMessage, {kind: 'checkpoint' | 'snapshot'}>;
function stateSummary(atMs: number, m: Snapshot) {
  const d = m.data.status.delivery;
  return {atMs, seq: m.seq, capture: m.capture.monotonicNs, ackedThroughEventSeq: d.ackedThroughEventSeq, nextEventSeq: d.nextEventSeq, durable: d.durable,
    retainedEvents: d.retainedEvents, retainedBytes: d.retainedBytes, oldestRetainedMonotonicNs: lost(d.oldestRetainedMonotonicNs),
    eventLoss: nonzero(m.data.status.eventLoss as unknown as Record<string, string>), gameMode: m.data.status.gameMode, continuity: m.data.continuity, state: m.data.state};
}

/** A normalized, label-substituted view of one replay: per connection, then the ledger and the producer store. */
export function summarize(result: ReplayResult): unknown {
  const seed = result.scenario.seed, labels = new Map<string, string>();
  for (const label of ['plugin-session', 'process-instance', 'capture-clock']) labels.set(seededId(seed, label), label);
  for (let n = 0; n < 100; n++) for (const label of [`game-clock-${n}`, `client-instance-${n}`, `client-clock-${n}`]) labels.set(seededId(seed, label), label);
  const instances: string[] = [];
  const connections = result.connections.map(rec => {
    const lines = result.transcript.filter(l => l.connection === rec.connection);
    const server = lines.filter(l => l.direction === 'server').map(l => ({atMs: l.atMs, m: l.message as ServerMessage}));
    const acks = lines.flatMap(l => l.message.kind === 'ack' ? [l.message.data.throughEventSeq] : []);
    const welcome = server.find(s => s.m.kind === 'welcome')?.m, checkpoint = server.find(s => s.m.kind === 'checkpoint'), end = server.find(s => s.m.kind === 'end')?.m;
    if (!instances.includes(rec.clientInstanceId)) instances.push(rec.clientInstanceId);
    return {
      durableRequested: rec.durableRequested, closedBy: rec.closedBy, clientInstance: instances.indexOf(rec.clientInstanceId) + 1,
      welcome: welcome?.kind === 'welcome' ? {atMs: server[0].atMs, game: welcome.source.game, origin: welcome.source.origin, ...welcome.data} : null,
      checkpoint: checkpoint && checkpoint.m.kind === 'checkpoint' ? stateSummary(checkpoint.atMs, checkpoint.m) : null,
      coverage: server.flatMap(({atMs, m}): unknown[] => m.kind === 'event' ? [{atMs, event: m.data.eventSeq, type: m.data.record.type, redelivered: m.data.redelivered, occurred: m.data.occurred, record: m.data.record}]
        : m.kind === 'gap' ? [{atMs, gap: [m.data.firstEventSeq, m.data.lastEventSeq], causes: nonzero(m.data.causes as unknown as Record<string, string>), redelivered: m.data.redelivered,
          firstLost: lost(m.data.firstLostMonotonicNs), lastLost: lost(m.data.lastLostMonotonicNs)}] : []),
      snapshots: server.flatMap(({atMs, m}) => m.kind === 'snapshot' ? [stateSummary(atMs, m)] : []),
      acks, ackCount: acks.length, lastAck: acks.at(-1) ?? null,
      clockReplies: server.filter(s => s.m.kind === 'clock.reply').length,
      mappings: rec.mappings.map(x => ({probeId: x.probeId, offsetNs: x.mapping?.offsetNs ?? null, uncertaintyNs: x.mapping?.uncertaintyNs ?? null})),
      end: end?.kind === 'end' ? end.data : null
    };
  });
  const out = {connections, ledger: result.ledger, store: {...result.store, eventLoss: nonzero(result.store.eventLoss)}, retired: result.retired};
  return JSON.parse(JSON.stringify(out), (_, v: unknown) => typeof v === 'string' && labels.has(v) ? labels.get(v) : v);
}

/** Compact coverage form: {"eventRange": [first, last], "type": ..., "redelivered": ...} stands for one item per eventSeq. */
function expandCoverage(items: unknown[]): unknown[] {
  return items.flatMap(item => {
    const r = item as {eventRange?: [string, string]} & Record<string, unknown>;
    if (!r.eventRange) return [item];
    const {eventRange, ...rest} = r, out: unknown[] = [];
    for (let q = BigInt(eventRange[0]); q <= BigInt(eventRange[1]); q++) out.push({...rest, event: q.toString()});
    return out;
  });
}
// Loss counts are compared exactly (zero causes omitted on both sides); every other object is a subset match.
const EXACT = new Set(['causes', 'eventLoss']);
function compare(actual: unknown, expected: unknown, path: string, out: string[]): void {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) { out.push(`${path}: expected an array`); return; }
    const want = path.endsWith('.coverage') ? expandCoverage(expected) : expected;
    if (actual.length !== want.length) out.push(`${path}: expected ${want.length} items, got ${actual.length}`);
    want.forEach((e, i) => compare(actual[i], e, `${path}[${i}]`, out));
    return;
  }
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object') { out.push(`${path}: expected an object, got ${JSON.stringify(actual)}`); return; }
    for (const [key, value] of Object.entries(expected)) {
      const a = (actual as Record<string, unknown>)[key];
      if (EXACT.has(key)) { if (JSON.stringify(a) !== JSON.stringify(value)) out.push(`${path}.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(a)}`); }
      else compare(a, value, `${path}.${key}`, out);
    }
    return;
  }
  if (actual !== expected) out.push(`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

export interface Expected {scenario: string; authoredFrom: string[]; notes?: string; connections: unknown[]; ledger?: unknown; store?: unknown; retired?: string | null}
/** Mismatches between a replay and its expectation; an empty list means the replay meets every stated outcome. */
export function mismatches(result: ReplayResult, expected: Expected): string[] {
  const out: string[] = [];
  if (expected.scenario !== result.scenario.id) out.push(`scenario: expected ${expected.scenario}`);
  if (!Array.isArray(expected.authoredFrom) || !expected.authoredFrom.length) out.push('authoredFrom: every expectation cites its source');
  const {scenario: _s, authoredFrom: _a, notes: _n, ...outcomes} = expected; void _s; void _a; void _n;
  compare(summarize(result), outcomes, '$', out);
  return out;
}
