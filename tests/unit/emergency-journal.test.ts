import {randomUUID} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EmergencyDelivery} from '../../apps/desktop/src/emergency-delivery';
import {EmergencyJournal, type EmergencyEntry} from '../../apps/desktop/src/emergency-journal';
import {temporaryResources} from '../shared/resources';
import {ETS2_A, Script, r} from '../shared/trip-messages';

let resources: Awaited<ReturnType<typeof temporaryResources>>;
beforeEach(async () => { resources = await temporaryResources(); });
afterEach(async () => { await resources.dispose(); });

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
    await append(entry);
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
