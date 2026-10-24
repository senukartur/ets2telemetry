import {mkdtempSync, readFileSync, rmdirSync, unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {validateServerMessage, type ServerMessage} from '../../packages/contracts/src/protocol-v1';
import {EventProbe, EvidenceLog, type ProbeLog} from '../../tools/telemetry-validation/src/event-probe';

/** Synthetic contract corpus; the origin is changed only to test the game-authority branch. No game evidence. */
function fixture(name: string): ServerMessage {
  const input: unknown = JSON.parse(readFileSync(path.resolve('tests/fixtures/protocol-v1', name + '.json'), 'utf8'));
  const message = validateServerMessage(input);
  return validateServerMessage({...message, source: {...message.source, origin: 'game'}});
}
class Log implements ProbeLog {
  rows: {record: unknown; durable: boolean}[] = [];
  rejectEvent = false;
  append(record: unknown, durable: boolean): void {
    const value = record as {message?: ServerMessage};
    if (this.rejectEvent && value.message?.kind === 'event') throw new Error('Diagnostic disk failure');
    this.rows.push({record, durable});
  }
}
function start(log = new Log()) {
  const probe = new EventProbe(log), welcome = fixture('welcome');
  probe.connect(welcome.source); probe.accept(welcome, 1n); probe.accept(fixture('checkpoint'), 2n);
  return {probe, log};
}

describe('standalone game-event diagnostic consumer', () => {
  it('persists events and gaps before cumulative ACK; keeps end distinct from connection close', () => {
    const {probe, log} = start();
    const names = ['event-job-configured', 'snapshot', 'event-truck-configured-e2', 'gap', 'event-simulation-paused-e5', 'end'];
    const acks = names.flatMap((name, i) => probe.accept(fixture(name), BigInt(i + 3)));
    expect(acks.map(m => m.kind === 'ack' ? m.data.throughEventSeq : '')).toEqual(['1', '2', '4', '5']);
    const rows = log.rows.map(row => row.record as {type: string; message?: ServerMessage});
    const eventIndex = rows.findIndex(row => row.message?.kind === 'event');
    expect(log.rows[eventIndex].durable).toBe(true);
    expect(rows[eventIndex + 1].type).toBe('send');
    probe.disconnect('game-exit');
    expect(log.rows.at(-1)?.record).toMatchObject({type: 'connection-closed', endPacketObserved: true});
    expect(probe.summary().sessions[0]).toMatchObject({events: 3, gapMessages: 1, evidenceThrough: '5'});
  });
  it('does not commit or ACK when diagnostic persistence fails, and cannot reconnect afterward', () => {
    const {probe, log} = start(); log.rejectEvent = true;
    expect(() => probe.accept(fixture('event-job-configured'), 3n)).toThrow('Diagnostic disk failure');
    expect(probe.summary()).toMatchObject({failed: true, sessions: [{evidenceThrough: '0'}]});
    probe.disconnect('error');
    expect(() => probe.connect(fixture('welcome').source)).toThrow('Probe failed');
    expect(log.rows.some(row => (row.record as {type?: string}).type === 'send')).toBe(false);
  });
  it('withholds ACKs across a disconnect, checks duplicate contents, and acknowledges only received replay coverage', () => {
    const {probe} = start(); probe.setAcknowledging(false);
    expect(probe.accept(fixture('event-job-configured'), 3n)).toEqual([]);
    probe.accept(fixture('snapshot'), 4n);
    expect(probe.accept(fixture('event-truck-configured-e2'), 5n)).toEqual([]);
    probe.disconnect('operator-reconnect');
    probe.connect(fixture('welcome-reconnect').source);
    probe.accept(fixture('welcome-reconnect'), 6n); probe.accept(fixture('checkpoint-reconnect'), 7n);
    probe.accept(fixture('event-truck-configured-redelivered'), 8n);
    expect(probe.setAcknowledging(true)).toMatchObject([{kind: 'ack', data: {throughEventSeq: '2'}}]);
    expect(probe.summary().sessions[0]).toMatchObject({events: 2, duplicates: 1});
  });
  it('rejects changed redelivery even though framing and stream order remain valid', () => {
    const {probe} = start(); probe.setAcknowledging(false);
    probe.accept(fixture('event-job-configured'), 3n); probe.accept(fixture('snapshot'), 4n);
    probe.accept(fixture('event-truck-configured-e2'), 5n); probe.disconnect('reconnect');
    probe.connect(fixture('welcome-reconnect').source);
    probe.accept(fixture('welcome-reconnect'), 6n); probe.accept(fixture('checkpoint-reconnect'), 7n);
    const message = fixture('event-truck-configured-redelivered');
    if (message.kind !== 'event') throw new Error('Fixture type');
    message.data.occurred.gameTime.minutes = {available: true, value: '9000'};
    expect(() => probe.accept(message, 8n)).toThrow('Redelivered event changed');
  });
  it('compares replay contents independently of JSON member order', () => {
    const {probe} = start(); probe.setAcknowledging(false);
    probe.accept(fixture('event-job-configured'), 3n); probe.accept(fixture('snapshot'), 4n);
    probe.accept(fixture('event-truck-configured-e2'), 5n); probe.disconnect('reconnect');
    probe.connect(fixture('welcome-reconnect').source);
    probe.accept(fixture('welcome-reconnect'), 6n); probe.accept(fixture('checkpoint-reconnect'), 7n);
    const message = fixture('event-truck-configured-redelivered');
    if (message.kind !== 'event') throw new Error('Fixture type');
    message.data.record = Object.fromEntries(Object.entries(message.data.record).reverse()) as typeof message.data.record;
    expect(() => probe.accept(message, 8n)).not.toThrow();
    expect(probe.summary().sessions[0].duplicates).toBe(1);
  });
  it('rejects a stream whose identity differs from the native broker receipt', () => {
    const {probe} = start(); const event = fixture('event-job-configured');
    event.source.processId++;
    expect(() => probe.accept(event, 3n)).toThrow('Broker/source identity mismatch');
  });
  it('refuses synthetic authority rather than treating a simulator run as game evidence', () => {
    const probe = new EventProbe(new Log()), authority = fixture('welcome').source;
    expect(() => probe.connect({...authority, origin: 'synthetic'})).toThrow('Native game authority required');
  });
  it('records a transport close without falsely inventing an end packet', () => {
    const {probe, log} = start(); probe.disconnect('transport-closed');
    expect(log.rows.at(-1)?.record).toMatchObject({endPacketObserved: false});
  });
  it('labels a pre-existing producer ACK boundary without inventing locally captured events', () => {
    const probe = new EventProbe(new Log()), welcome = fixture('welcome-reconnect');
    probe.connect(welcome.source); probe.accept(welcome, 1n); probe.accept(fixture('checkpoint-reconnect'), 2n);
    expect(probe.summary().sessions[0]).toMatchObject({priorProducerAckBoundary: '1', evidenceThrough: '1', events: 0});
    expect(probe.accept(fixture('event-truck-configured-redelivered'), 3n)).toMatchObject([{kind: 'ack', data: {throughEventSeq: '2'}}]);
  });
  it('keeps plugin restart sessions separate', () => {
    const {probe} = start(); probe.accept(fixture('event-job-configured'), 3n); probe.disconnect('game-restart');
    const welcome = fixture('welcome-restart');
    probe.connect(welcome.source); probe.accept(welcome, 4n); probe.accept(fixture('checkpoint-restart'), 5n);
    probe.accept(fixture('event-restart'), 6n);
    expect(probe.summary().sessions.map(s => ({id: s.pluginSessionId, through: s.evidenceThrough}))).toEqual([
      {id: '10000000-0000-4000-8000-000000000001', through: '1'},
      {id: '10000000-0000-4000-8000-000000000002', through: '1'}
    ]);
  });
  it('accepts only registered clock replies', () => {
    const {probe} = start();
    expect(() => probe.accept(fixture('clock-reply'), 3n)).toThrow();
    const second = start().probe; second.expectClock('1');
    expect(() => second.accept(fixture('clock-reply'), 3n)).not.toThrow();
  });
  it('validates all snapshots but stores at most one diagnostic sample per second', () => {
    const {probe, log} = start(); const original = fixture('snapshot');
    const later = structuredClone(original); later.seq = '7'; later.capture.monotonicNs = (BigInt(original.capture.monotonicNs) + 1n).toString();
    probe.accept(original, 3n); probe.accept(later, 4n);
    expect(probe.summary().counts.snapshot).toBe(2);
    expect(log.rows.filter(row => (row.record as {message?: ServerMessage}).message?.kind === 'snapshot')).toHaveLength(1);
  });
});

const temporary: string[] = [];
afterEach(() => {for (const directory of temporary.splice(0)) {unlinkSync(path.join(directory, 'evidence.jsonl')); rmdirSync(directory);}});
describe('bounded diagnostic evidence files', () => {
  it('does not overwrite evidence and writes complete durable JSON lines', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'et044-evidence-')); temporary.push(directory);
    const file = path.join(directory, 'evidence.jsonl'), log = new EvidenceLog(file, 4096);
    log.append({type: 'event', eventSeq: '1'}, true); log.close();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({type: 'event', eventSeq: '1'});
    expect(() => new EvidenceLog(file, 4096)).toThrow();
    expect(() => log.append({}, true)).toThrow('closed');
  });
  it('stops before exceeding the byte limit', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'et044-evidence-')); temporary.push(directory);
    const file = path.join(directory, 'evidence.jsonl'), log = new EvidenceLog(file, 1024);
    expect(() => log.append({data: 'a'.repeat(1024)}, true)).toThrow('Evidence byte bound'); log.close();
    expect(readFileSync(file)).toHaveLength(0);
  });
});
