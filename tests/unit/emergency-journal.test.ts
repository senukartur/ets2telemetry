import {randomUUID} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import type {DurableSink, SinkResult} from '../../apps/desktop/src/durable-sink';
import {EmergencyDelivery} from '../../apps/desktop/src/emergency-delivery';
import {EmergencyJournal, EmergencyJournalFull, type EmergencyEntry} from '../../apps/desktop/src/emergency-journal';
import type {StorageClient} from '../../packages/storage/src/client';
import {temporaryResources} from '../shared/resources';
import {ETS2_A, Script, r} from '../shared/trip-messages';

let resources: Awaited<ReturnType<typeof temporaryResources>>;
beforeEach(async () => { resources = await temporaryResources(); });
afterEach(async () => { await resources.dispose(); });

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return {promise, resolve};
}

const ok = <T>(value: T): Promise<SinkResult<T>> => Promise.resolve({ok: true, value});

function frames(): EmergencyEntry[] {
  const script = new Script(ETS2_A);
  const welcome = script.welcome(), checkpoint = script.checkpoint(null);
  const common = {connection: randomUUID(), welcome, checkpoint, checkpointReceivedUtcMs: 1, before: '0'};
  return [
    {...common, message: checkpoint, receivedUtcMs: 1},
    {...common, message: script.event(r.jobConfigured()), receivedUtcMs: 2}
  ];
}

it('recovers synced entries in order, ignores a partial write and deletes only a consumed head', async () => {
  const entries = frames();
  const origin = entries[0].welcome.source.origin;
  const writer = new EmergencyJournal(resources.directory, origin);
  await writer.initialize();
  for (const entry of entries) await writer.append(entry);
  await writeFile(path.join(resources.directory, '000000000002.partial'), 'unfinished');

  const reader = new EmergencyJournal(resources.directory, origin);
  await reader.initialize();
  expect(reader.pending).toBe(2);
  expect(await readdir(resources.directory)).not.toContain('000000000002.partial');
  const head = (await reader.head())!;
  expect(head.entry).toEqual(entries[0]);
  await expect(reader.consume('000000000001.frame')).rejects.toThrow('out of order');
  await reader.consume(head.name);
  expect((await reader.head())?.entry).toEqual(entries[1]);
  const restarted = new EmergencyJournal(resources.directory, origin);
  await restarted.initialize();
  const remaining = (await restarted.head())!;
  expect(remaining.entry).toEqual(entries[1]);
  await restarted.hold(remaining.name);
  const next = new EmergencyJournal(resources.directory, origin);
  await next.initialize();
  expect(next.pending).toBe(0);
  expect(await readdir(resources.directory)).toEqual(['000000000001.held']);
  await next.append(entries[0]);
  expect((await next.head())?.name).toBe('000000000002.frame');
});

it('refuses a foreign recording origin and keeps a corrupt published file for diagnosis', async () => {
  const [entry] = frames();
  const wrongOrigin = entry.welcome.source.origin === 'game' ? 'synthetic' : 'game';
  const rejected = new EmergencyJournal(resources.directory, wrongOrigin);
  await rejected.initialize();
  await expect(rejected.append(entry)).rejects.toThrow('source mismatch');

  const writer = new EmergencyJournal(resources.directory, entry.welcome.source.origin);
  await writer.initialize();
  await writer.append(entry);
  const location = path.join(resources.directory, (await writer.head())!.name);
  const bytes = await readFile(location);
  bytes[65] ^= 1;
  await writeFile(location, bytes);
  await expect(writer.head()).rejects.toThrow('checksum');
  expect(writer.pending).toBe(1);
  expect(await readFile(location)).toEqual(bytes);
});

it('leaves an event unacknowledged if its emergency write fails', async () => {
  const [first, next] = frames();
  const journal = new EmergencyJournal(resources.directory, first.welcome.source.origin);
  const append = journal.append.bind(journal);
  vi.spyOn(journal, 'append').mockImplementation(async entry => {
    if (entry.message.kind === 'event') throw new Error('file is read-only');
    return append(entry);
  });
  const log = vi.fn();
  const delivery = new EmergencyDelivery(journal, () => undefined, () => {throw new Error('SQLite is unavailable');},
    () => undefined, () => undefined, log);
  await delivery.start();
  const link = {current: () => true, close: vi.fn(), write: vi.fn()};
  const source = delivery.connect(first.welcome, link);
  source.checkpoint(first.checkpoint, 1);
  if (next.message.kind !== 'event') throw new Error('Expected authored event');
  source.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, next.message, 2);
  await delivery.stop();
  expect(link.write).not.toHaveBeenCalled();
  expect(link.close).toHaveBeenCalledWith('retryable', 'IO_ERROR');
  expect(log).toHaveBeenCalledWith('EMERGENCY_JOURNAL_UNAVAILABLE', {stage: 'WRITE'});
  expect(journal.pending).toBe(1);
});

it('reconnects after a transient write failure and acknowledges the retransmission after publication', async () => {
  const [first, next] = frames();
  const journal = new EmergencyJournal(resources.directory, first.welcome.source.origin);
  const publish = journal.append.bind(journal);
  const append = vi.spyOn(journal, 'append');
  const writeFailed = deferred(), resumed = deferred();
  const sourceReady = vi.fn(() => undefined);
  sourceReady.mockImplementationOnce(() => undefined).mockImplementationOnce(() => { resumed.resolve(); });
  const delivery = new EmergencyDelivery(journal, () => undefined, () => {throw new Error('SQLite is unavailable');},
    () => undefined, sourceReady, () => undefined);
  try {
    await delivery.start();
    append.mockImplementationOnce(publish).mockRejectedValueOnce(new Error('temporary disk error'));
    const link = {current: () => true, close: vi.fn(() => { writeFailed.resolve(); }), write: vi.fn()};
    const source = delivery.connect(first.welcome, link);
    if (next.message.kind !== 'event') throw new Error('Expected authored event');
    source.checkpoint(first.checkpoint, 1);
    source.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, next.message, 2);
    await writeFailed.promise;
    expect(delivery.status).toEqual({state: 'failed', code: 'IO_ERROR'});
    expect(delivery.durableAllowed()).toBe(false);
    expect(link.write).not.toHaveBeenCalled();
    await resumed.promise;
    expect(delivery.durableAllowed()).toBe(true);
    const reconnect = {...link, write: vi.fn()};
    const retry = delivery.connect(first.welcome, reconnect);
    retry.checkpoint(first.checkpoint, 1);
    retry.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, next.message, 2);
    await delivery.stop();
    expect(reconnect.write).toHaveBeenCalledOnce();
    expect(journal.pending).toBe(3);
    expect((await readdir(resources.directory)).every(file => file.endsWith('.frame'))).toBe(true);
  } finally { await delivery.stop(); }
});

it.each([false, true])('preserves a corrupt head and later frames and disables ACKs (detected during replay=%s)', async duringReplay => {
  const entries = frames(), first = entries[0];
  const journal = new EmergencyJournal(resources.directory, first.welcome.source.origin);
  await journal.initialize();
  for (const entry of entries) await journal.append(entry);
  const pathToHead = path.join(resources.directory, '000000000000.frame');
  const bytes = await readFile(pathToHead);
  bytes[65] ^= 1;
  if (!duringReplay) await writeFile(pathToHead, bytes);
  const failed = deferred();
  let client: StorageClient | undefined;
  const sourceReady = vi.fn(), sink = vi.fn<() => DurableSink>();
  const delivery = new EmergencyDelivery(new EmergencyJournal(resources.directory, first.welcome.source.origin),
    () => client, sink, () => undefined, sourceReady, (event, facts) => {
      if (event === 'EMERGENCY_JOURNAL_UNAVAILABLE' && facts.stage === 'INTEGRITY') failed.resolve();
    });
  const link = {current: () => true, close: vi.fn(), write: vi.fn()};
  try {
    await delivery.start();
    if (duringReplay) {
      expect(delivery.durableAllowed()).toBe(true);
      delivery.connect(first.welcome, link);
      await writeFile(pathToHead, bytes);
      client = {} as StorageClient; // Replay fails before calling any storage command.
      delivery.storageChanged();
    }
    await failed.promise;
    expect(delivery.durableAllowed()).toBe(false);
    expect(delivery.status).toEqual({state: 'failed', code: 'IO_ERROR'});
    expect(sourceReady).toHaveBeenCalledTimes(duringReplay ? 1 : 0);
    if (duringReplay) expect(link.close).toHaveBeenCalledWith('unavailable', 'IO_ERROR');
    expect(link.write).not.toHaveBeenCalled();
    expect(sink).not.toHaveBeenCalled();
    expect(await readFile(pathToHead)).toEqual(bytes);
    expect((await readdir(resources.directory)).sort()).toEqual(['000000000000.frame', '000000000001.frame']);
  } finally { await delivery.stop(); }
});

it.each([false, true])('withholds ACK after an untrusted checkpoint and holds the suffix only if SQLite is behind (behind=%s)', async behind => {
  const script = new Script(ETS2_A), welcome = script.welcome();
  script.event(r.jobConfigured());
  const checkpoint = script.checkpoint(null), event = script.event(r.delivered());
  const journal = new EmergencyJournal(resources.directory, welcome.source.origin);
  const persisted = deferred(), projected = deferred();
  const append = journal.append.bind(journal);
  vi.spyOn(journal, 'append').mockImplementation(async entry => {
    const sequence = await append(entry);
    if (entry.message.kind === 'event') persisted.resolve();
    return sequence;
  });
  const settle = behind ? journal.hold.bind(journal) : journal.consume.bind(journal);
  vi.spyOn(journal, behind ? 'hold' : 'consume').mockImplementation(async name => {
    await settle(name);
    if (journal.pending === 0) projected.resolve();
  });
  let client: StorageClient | undefined;
  const restoreLoss = vi.fn(() => ok(undefined));
  const commit = vi.fn(() => ok({status: 'committed' as const, committedThroughEventSeq: '2'}));
  const sink: DurableSink = {openSession: () => ok({committedThroughEventSeq: behind ? '0' : '1'}),
    checkpoint: () => ok(undefined), observe: () => ({ok: true, value: undefined}),
    commit, restoreLoss};
  const delivery = new EmergencyDelivery(journal, () => client, () => sink, () => undefined, () => undefined, () => undefined);
  try {
    await delivery.start();
    const link = {current: () => true, close: vi.fn(), write: vi.fn()};
    const source = delivery.connect(welcome, link);
    source.checkpoint(checkpoint, 1);
    source.enqueue({firstEventSeq: '2', lastEventSeq: '2'}, event, 2);
    await persisted.promise;
    expect(link.write).not.toHaveBeenCalled();
    client = {} as StorageClient;
    delivery.storageChanged();
    await projected.promise;
    await delivery.stop();
    if (behind) {
      expect(restoreLoss).toHaveBeenCalledWith(welcome.source.pluginSessionId, '0', '1');
      expect(link.close).toHaveBeenCalledWith('ack-ahead', 'ACK_AHEAD_OF_STORAGE');
      expect(commit).not.toHaveBeenCalled();
      expect(link.write).not.toHaveBeenCalled();
      expect((await readdir(resources.directory)).sort()).toEqual(['000000000000.held', '000000000001.held']);
    } else {
      expect(restoreLoss).not.toHaveBeenCalled();
      expect(commit).toHaveBeenCalledOnce();
      expect(link.write).toHaveBeenCalledOnce();
      expect(await readdir(resources.directory)).toEqual([]);
    }
  } finally { await delivery.stop(); }
});

it('resumes a full journal only after SQLite consumes an entry and makes room', async () => {
  const [first, next] = frames();
  const journal = new EmergencyJournal(resources.directory, first.welcome.source.origin);
  const publish = journal.append.bind(journal);
  vi.spyOn(journal, 'append').mockImplementationOnce(publish).mockRejectedValueOnce(new EmergencyJournalFull());
  const limit = deferred(), resumed = deferred();
  let client: StorageClient | undefined;
  const sink: DurableSink = {openSession: () => ok({committedThroughEventSeq: '0'}),
    checkpoint: () => ok(undefined), observe: () => ({ok: true, value: undefined}),
    commit: () => ok({status: 'committed', committedThroughEventSeq: '1'})};
  const sourceReady = vi.fn().mockImplementationOnce(() => undefined).mockImplementationOnce(() => resumed.resolve());
  const delivery = new EmergencyDelivery(journal, () => client, () => sink, () => undefined, sourceReady, () => undefined);
  try {
    await delivery.start();
    const link = {current: () => true, close: vi.fn(() => limit.resolve()), write: vi.fn()};
    const source = delivery.connect(first.welcome, link);
    if (next.message.kind !== 'event') throw new Error('Expected authored event');
    source.checkpoint(first.checkpoint, 1);
    source.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, next.message, 2);
    await limit.promise;
    expect(delivery.durableAllowed()).toBe(false);
    expect(link.close).toHaveBeenCalledWith('retryable', 'STORAGE_BUSY');
    expect(link.write).not.toHaveBeenCalled();
    expect(journal.pending).toBe(1);
    client = {} as StorageClient;
    delivery.storageChanged();
    await resumed.promise;
    expect(delivery.durableAllowed()).toBe(true);
    expect(journal.pending).toBe(0);
  } finally { await delivery.stop(); }
});

it('bounds the intake backlog and accepts retransmission once the writer catches up', async () => {
  const script = new Script(ETS2_A), welcome = script.welcome(), checkpoint = script.checkpoint(null);
  const journal = new EmergencyJournal(resources.directory, welcome.source.origin);
  const release = deferred(), drained = deferred();
  const limit = 512;
  let entries = 0;
  const append = vi.spyOn(journal, 'append').mockImplementation(async () => {
    await release.promise;
    if (++entries === limit) drained.resolve();
    return entries;
  });
  const delivery = new EmergencyDelivery(journal, () => undefined, () => {throw new Error('SQLite is unavailable');},
    () => undefined, () => undefined, () => undefined);
  try {
    await delivery.start();
    const link = {current: () => true, close: vi.fn(), write: vi.fn()};
    const source = delivery.connect(welcome, link);
    source.checkpoint(checkpoint, 1);
    for (let i = 0; i < limit; i++) source.snapshot(script.snapshot(), i + 2);
    expect(link.close).toHaveBeenCalledOnce();
    expect(link.close).toHaveBeenCalledWith('retryable', 'BACKLOG_FULL');

    release.resolve();
    await drained.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(delivery.durableAllowed()).toBe(true);
    const reconnect = {...link, write: vi.fn()};
    const retry = delivery.connect(welcome, reconnect);
    retry.checkpoint(checkpoint, limit + 2);
    retry.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, script.event(r.jobConfigured()), limit + 3);
    await delivery.stop();
    expect(reconnect.write).toHaveBeenCalledOnce();
    expect(append).toHaveBeenCalledTimes(limit + 2);
  } finally {
    release.resolve();
    await delivery.stop();
  }
});
