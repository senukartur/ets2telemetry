import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach, expect, it, vi} from 'vitest';
import {discoverGames, parseDiscoveryReceipt} from '../../apps/desktop/src/native-game-discovery';

class Child extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); stdin = new PassThrough(); kill = vi.fn();
}
const children: Child[] = [];
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({spawn}));
const configuration = {executable: 'C:\\isolated\\broker.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
const target = {source: {game: 'ets2', origin: 'game', processId: 123, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: '22222222-2222-4222-8222-222222222222'}, processCreationTime: '123456789', userTag: 'a'.repeat(64)};
const receipt = () => ({type: 'discovery', schemaVersion: 1, protocolMajor: 0, games: {ets2: {status: 'unique', target}, ats: {status: 'absent'}}});
function frame(value: unknown) {const payload = Buffer.from(JSON.stringify(value)), prefix = Buffer.alloc(4); prefix.writeUInt32LE(payload.length); return Buffer.concat([prefix, payload]);}
function fixture() {
  vi.useFakeTimers(); spawn.mockImplementation(() => {const child = new Child(); children.push(child); return child;});
  const controller = new AbortController(), result = discoverGames(configuration, 'v0', controller.signal); void result.catch(() => undefined);
  return {controller, result, child: children.at(-1)!};
}
afterEach(() => {for (const child of children.splice(0)) child.emit('close', 0); vi.useRealTimers(); vi.clearAllMocks();});
it('accepts exactly one framed receipt only after child close, including fragmented bytes', async () => {
  const f = fixture(), done = vi.fn(); void f.result.then(done); const bytes = frame(receipt());
  expect(spawn).toHaveBeenCalledWith(configuration.executable, ['--discover', '--discovery-dir', configuration.discoveryDirectory], {windowsHide: true, stdio: 'pipe'});
  for (const piece of [bytes.subarray(0, 1), bytes.subarray(1, 10), bytes.subarray(10)]) f.child.stdout.write(piece);
  f.child.emit('exit', 0); await Promise.resolve(); expect(done).not.toHaveBeenCalled(); f.child.emit('close', 0);
  expect(await f.result).toEqual(receipt().games); expect(done).toHaveBeenCalledOnce();
});
it.each(['extra', 'version', 'protocol', 'game', 'pid', 'session', 'uuid', 'creation', 'user', 'path', 'status'])('rejects malformed %s receipts', kind => {
  const value = structuredClone(receipt()) as unknown as Record<string, unknown>;
  const mutate = value as {schemaVersion: number; protocolMajor: number; games: {ets2: {status: string; target: {source: Record<string, unknown>; processCreationTime: string; userTag: string}}}};
  if (kind === 'extra') value.extra = true;
  if (kind === 'version') mutate.schemaVersion = 2;
  if (kind === 'protocol') mutate.protocolMajor = 1;
  if (kind === 'game') mutate.games.ets2.target.source.game = 'ats';
  if (kind === 'pid') mutate.games.ets2.target.source.processId = 0;
  if (kind === 'session') mutate.games.ets2.target.source.windowsSessionId = -1;
  if (kind === 'uuid') mutate.games.ets2.target.source.pluginSessionId = 'foreign';
  if (kind === 'creation') mutate.games.ets2.target.processCreationTime = '18446744073709551616';
  if (kind === 'user') mutate.games.ets2.target.userTag = 'bad';
  if (kind === 'path') mutate.games.ets2.target.source.pipeName = 'foreign';
  if (kind === 'status') mutate.games.ets2.status = 'available';
  expect(() => parseDiscoveryReceipt(value, 'v0')).toThrow();
});
it('accepts absent/ambiguous states and requires explicit protocol markers', () => {
  expect(parseDiscoveryReceipt({type: 'discovery', schemaVersion: 1, protocolMajor: 1, games: {ets2: {status: 'ambiguous'}, ats: {status: 'absent'}}}, 'v1')).toEqual({ets2: {status: 'ambiguous'}, ats: {status: 'absent'}});
  expect(() => parseDiscoveryReceipt(receipt(), 'v1')).toThrow();
});
it.each(['oversize', 'zero', 'partial', 'suffix', 'second', 'exit'])('rejects %s discovery output', async kind => {
  const f = fixture();
  if (kind === 'oversize') {const prefix = Buffer.alloc(4); prefix.writeUInt32LE(4097); f.child.stdout.write(prefix);}
  if (kind === 'zero') f.child.stdout.write(Buffer.alloc(4));
  if (kind === 'partial') f.child.stdout.write(frame(receipt()).subarray(0, 10));
  if (kind === 'suffix') f.child.stdout.write(Buffer.concat([frame(receipt()), Buffer.from([1])]));
  if (kind === 'second') f.child.stdout.write(Buffer.concat([frame(receipt()), frame(receipt())]));
  if (kind === 'exit') f.child.stdout.write(frame(receipt()));
  f.child.emit('close', kind === 'exit' ? 1 : 0); await expect(f.result).rejects.toThrow();
});
it.each(['abort', 'deadline'])('owns cancellation through actual close after %s', async kind => {
  const f = fixture(), settled = vi.fn(); void f.result.catch(settled);
  if (kind === 'abort') f.controller.abort(); else await vi.advanceTimersByTimeAsync(5000);
  expect(f.child.kill).toHaveBeenCalledOnce(); f.child.emit('exit', 1); await Promise.resolve(); expect(settled).not.toHaveBeenCalled();
  f.child.stdout.write(frame(receipt())); f.child.emit('close', 1); await expect(f.result).rejects.toThrow();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([3, 4])('reports transient discovery exit %s only after close without accepting a partial receipt', async code => {
  const f = fixture(); f.child.emit('close', code); await expect(f.result).rejects.toMatchObject({transient: true});
  const partial = fixture(); partial.child.stdout.write(Buffer.from([1])); partial.child.emit('close', code);
  await expect(partial.result).rejects.not.toHaveProperty('transient');
});
