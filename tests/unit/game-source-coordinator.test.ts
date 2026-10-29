import {afterEach, expect, it, vi} from 'vitest';
import {GameSourceCoordinator} from '../../apps/desktop/src/game-source-coordinator';
import {resolveSourceMode} from '../../apps/desktop/src/source-mode';
import {NativeDiscoveryError} from '../../apps/desktop/src/native-game-discovery';
import type {Game, GameDiscovery, GameTarget} from '../../apps/desktop/src/native-game-discovery';
import type {BrokerProtocol} from '../../apps/desktop/src/native-pipe-client';

const broker = {executable: 'C:\\isolated\\broker.exe', discoveryDirectory: 'C:\\isolated\\transport\\v0'};
const target = (game: Game = 'ets2', session = '22222222-2222-4222-8222-222222222222'): GameTarget => ({
  source: {game, origin: 'game', processId: game === 'ets2' ? 123 : 124, windowsSessionId: 1, processInstanceId: '11111111-1111-4111-8111-111111111111', pluginSessionId: session},
  processCreationTime: '123456789', userTag: 'a'.repeat(64)
});
const availability = (...targets: GameTarget[]): GameDiscovery => ({ets2: {status: 'absent'}, ats: {status: 'absent'},
  ...Object.fromEntries(targets.map(value => [value.source.game, {status: 'unique', target: value}]))});
const coordinators: GameSourceCoordinator[] = [];
afterEach(async () => {for (const coordinator of coordinators.splice(0)) await coordinator.stop(); vi.useRealTimers();});
async function settle() {await vi.advanceTimersByTimeAsync(0);}
function fixture(initial = availability()) {
  vi.useFakeTimers(); let discovery = initial;
  const discover = vi.fn<(configuration: typeof broker, protocol: BrokerProtocol, signal: AbortSignal) => Promise<GameDiscovery>>(() => Promise.resolve(discovery));
  const attach = vi.fn(), publish = vi.fn(), retire = vi.fn(() => Promise.resolve());
  const coordinator = new GameSourceCoordinator({discover, attach, publish, retire}); coordinators.push(coordinator);
  return {coordinator, discover, attach, publish, retire, available: (next: GameDiscovery) => {discovery = next;}};
}
it('waits without a game and attaches after either launch order', async () => {
  const first = fixture(); first.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(first.publish).toHaveBeenLastCalledWith('waiting', 'Waiting for game'); expect(first.attach).not.toHaveBeenCalled();
  first.available(availability(target('ats'))); await vi.advanceTimersByTimeAsync(250);
  expect(first.attach).toHaveBeenCalledExactlyOnceWith('ats', target('ats'));
  const second = fixture(availability(target())); second.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(second.attach).toHaveBeenCalledExactlyOnceWith('ets2', target());
  expect(second.discover.mock.calls.map(call => call[1])).toEqual(['v0', 'v1']);
});
it('waits for both protocol scans before offering an explicit simultaneous choice', async () => {
  const f = fixture(); f.discover.mockImplementation((_config, protocol) => Promise.resolve(availability(target(protocol === 'v0' ? 'ets2' : 'ats'))));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Both games are available; choose ETS2 or ATS'); expect(f.attach).not.toHaveBeenCalled();
  f.coordinator.select({kind: 'game', selection: 'ats'}, broker); await settle(); expect(f.attach).toHaveBeenCalledExactlyOnceWith('ats', target('ats'));
});
it.each([['ets2', 'ats'], ['ats', 'ets2']] as const)('keeps %s stable then discovers %s when both streams are lost', async (first, next) => {
  const f = fixture(availability(target(first))); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  f.available(availability(target(first), target(next))); await vi.advanceTimersByTimeAsync(5000); expect(f.attach).toHaveBeenCalledTimes(1);
  f.coordinator.observe('v0', {status: 'disconnected', reason: 'Source closed'}); await settle(); expect(f.attach).toHaveBeenCalledTimes(1);
  f.available(availability(target(next))); f.coordinator.observe('v1', {status: 'disconnected', reason: 'Source closed'}); await settle();
  expect(f.attach).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(250);
  expect(f.attach).toHaveBeenLastCalledWith(next, target(next)); expect(f.retire).toHaveBeenCalledTimes(2);
});
it('retires terminal sessions and binds a restarted game to its new plugin session', async () => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  const restarted = target('ets2', '33333333-3333-4333-8333-333333333333'); f.available(availability(restarted));
  f.coordinator.observe('v1', {status: 'disconnected', reason: 'Source ended (plugin-shutdown)'}); await settle();
  expect(f.attach).toHaveBeenCalledTimes(1); await vi.advanceTimersByTimeAsync(250);
  expect(f.attach).toHaveBeenLastCalledWith('ets2', restarted);
});
it('retains explicit game mode and refuses ambiguous or mismatched candidates', async () => {
  const f = fixture(availability(target('ats'))); f.coordinator.select({kind: 'game', selection: 'ets2'}, broker); await settle();
  expect(f.attach).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Waiting for game');
  f.available({ets2: {status: 'ambiguous'}, ats: {status: 'absent'}}); await vi.advanceTimersByTimeAsync(250);
  expect(f.publish).toHaveBeenLastCalledWith('incompatible', 'Multiple game instances are ambiguous');
  f.discover.mockImplementation((_config, protocol) => Promise.resolve(availability(target('ets2', protocol === 'v0' ? target().source.pluginSessionId : '33333333-3333-4333-8333-333333333333'))));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(f.attach).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Game protocol targets changed; retrying discovery');
});
it('keeps authority/protocol failures visible without switching away from the attached sibling', async () => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  f.coordinator.observe('v1', {status: 'incompatible', reason: 'Native game target mismatch'});
  f.coordinator.observe('v0', {status: 'disconnected', reason: 'Source closed'}); await vi.advanceTimersByTimeAsync(5000);
  expect(f.attach).toHaveBeenCalledTimes(1); expect(f.discover).toHaveBeenCalledTimes(2);
});
it('invalidates superseded results immediately but waits for actual completion before starting another child', async () => {
  const f = fixture(); let finish!: (value: GameDiscovery) => void; let signal!: AbortSignal;
  f.discover.mockImplementationOnce((_config, _protocol, cancellation) => {signal = cancellation; return new Promise(resolve => {finish = resolve;});});
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  f.coordinator.select({kind: 'game', selection: 'ats'}, broker); await settle();
  expect(signal.aborted).toBe(true); expect(f.discover).toHaveBeenCalledTimes(1);
  f.available(availability(target('ats'))); finish(availability(target())); await settle();
  expect(f.attach).toHaveBeenCalledExactlyOnceWith('ats', target('ats'));
});
it('stop waits for discovery close and publishes no cancelled result', async () => {
  const f = fixture(); let finish!: (value: GameDiscovery) => void;
  f.discover.mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  const stopped = vi.fn(); const stopping = f.coordinator.stop().then(stopped); await settle(); expect(stopped).not.toHaveBeenCalled();
  finish(availability(target())); await stopping; expect(f.attach).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
});
it.each(['synthetic', 'replay'] as const)('never discovers games for %s launches, missing fixtures or disconnects', async selection => {
  const f = fixture(availability(target(), target('ats')));
  f.coordinator.select(resolveSourceMode('game', {ETS2TELEMETRY_SOURCE_KIND: selection}), broker); await settle();
  f.coordinator.observe('v0', {status: 'disconnected', reason: 'Fixture missing'}); f.coordinator.observe('v1', {status: 'disconnected', reason: 'Fixture missing'});
  await vi.advanceTimersByTimeAsync(10000); expect(f.discover).not.toHaveBeenCalled(); expect(f.attach).toHaveBeenCalledExactlyOnceWith(selection);
});

it('retries pre-authority contention only after discovery completion on bounded backoff', async () => {
  const f = fixture(availability(target())); f.discover.mockRejectedValueOnce(new NativeDiscoveryError('Owned policy busy', true));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Game discovery did not complete; retrying');
  await vi.advanceTimersByTimeAsync(249); expect(f.discover).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.attach).toHaveBeenCalledExactlyOnceWith('ets2', target());
});
it('does not replace a target because a stream is paused, stale, or temporarily waiting', async () => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  for (const status of ['paused', 'stale', 'waiting']) for (const protocol of ['v0', 'v1'] as const) f.coordinator.observe(protocol, {status, reason: 'No recent SDK capture'});
  await vi.advanceTimersByTimeAsync(5000); expect(f.discover).toHaveBeenCalledTimes(2); expect(f.attach).toHaveBeenCalledTimes(1);
});

it('converges automatically when sequential protocol discovery straddles a game restart', async () => {
  const old = target(), restarted = target('ets2', '33333333-3333-4333-8333-333333333333'), f = fixture(availability(restarted));
  f.discover.mockResolvedValueOnce(availability(old)).mockResolvedValueOnce(availability(restarted));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(f.attach).not.toHaveBeenCalled(); expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Game protocol targets changed; retrying discovery');
  await vi.advanceTimersByTimeAsync(249); expect(f.discover).toHaveBeenCalledTimes(2); expect(f.attach).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1); expect(f.discover).toHaveBeenCalledTimes(4); expect(f.attach).toHaveBeenCalledExactlyOnceWith('ets2', restarted);
});
it('keeps persistent hint mismatches visible with bounded retries and never opens either protocol', async () => {
  const f = fixture(); f.discover.mockImplementation((_config, protocol) => Promise.resolve(availability(protocol === 'v0' ? target() : target('ets2', '33333333-3333-4333-8333-333333333333'))));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 + 4000);
  expect(f.discover).toHaveBeenCalledTimes(12); expect(f.attach).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Game protocol targets changed; retrying discovery');
});
it('pins a single available protocol and keeps it attached while its missing sibling retries', async () => {
  const f = fixture(); f.discover.mockImplementation((_config, protocol) => Promise.resolve(protocol === 'v0' ? availability(target()) : availability()));
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  f.coordinator.observe('v0', {status: 'connected', reason: 'Validated current observation'});
  f.coordinator.observe('v1', {status: 'waiting', reason: 'No selected game discovery record'});
  await vi.advanceTimersByTimeAsync(5000); expect(f.attach).toHaveBeenCalledExactlyOnceWith('ets2', target()); expect(f.retire).toHaveBeenCalledTimes(1);
});

it.each(['unique', 'absent', 'both'] as const)('rescans an ambiguous automatic source and recovers to %s availability', async result => {
  const f = fixture({ets2: {status: 'ambiguous'}, ats: {status: 'absent'}});
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  expect(f.publish).toHaveBeenLastCalledWith('incompatible', 'Multiple game instances are ambiguous'); expect(f.attach).not.toHaveBeenCalled();
  f.available(result === 'absent' ? availability() : result === 'both' ? availability(target(), target('ats')) : availability(target()));
  await vi.advanceTimersByTimeAsync(249); expect(f.discover).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  if (result === 'unique') expect(f.attach).toHaveBeenCalledExactlyOnceWith('ets2', target());
  else {
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenLastCalledWith('waiting', result === 'both' ? 'Both games are available; choose ETS2 or ATS' : 'Waiting for game');
  }
});
it.each(['ets2', 'ats'] as const)('keeps explicit %s selection during ambiguity recovery', async game => {
  const other = game === 'ets2' ? 'ats' : 'ets2', f = fixture({...availability(target(other)), [game]: {status: 'ambiguous'}});
  f.coordinator.select({kind: 'game', selection: game}, broker); await settle(); expect(f.attach).not.toHaveBeenCalled();
  f.available(availability(target(other))); await vi.advanceTimersByTimeAsync(250);
  expect(f.publish).toHaveBeenLastCalledWith('waiting', 'Waiting for game'); expect(f.attach).not.toHaveBeenCalled();
  f.available(availability(target(game), target(other))); await vi.advanceTimersByTimeAsync(500);
  expect(f.attach).toHaveBeenCalledExactlyOnceWith(game, target(game));
});
it('keeps persistent ambiguity visible with bounded cadence and never attaches an ambiguous game', async () => {
  const f = fixture({ets2: {status: 'ambiguous'}, ats: {status: 'absent'}});
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000 + 4000);
  expect(f.discover).toHaveBeenCalledTimes(12); expect(f.attach).not.toHaveBeenCalled();
  expect(f.publish).toHaveBeenLastCalledWith('incompatible', 'Multiple game instances are ambiguous');
});
it.each(['stop', 'fixture'] as const)('cancels an ambiguity rescan on %s without a late discovery callback', async action => {
  const f = fixture({ets2: {status: 'ambiguous'}, ats: {status: 'absent'}});
  f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  if (action === 'stop') await f.coordinator.stop(); else {f.coordinator.select({kind: 'fixture', selection: 'replay'}, broker); await settle();}
  f.available(availability(target())); await vi.advanceTimersByTimeAsync(10000);
  expect(f.discover).toHaveBeenCalledTimes(2);
  if (action === 'stop') expect(f.attach).not.toHaveBeenCalled(); else expect(f.attach).toHaveBeenCalledExactlyOnceWith('replay');
});

it.each([
  ['both', 'game'], ['terminal', 'game'], ['both', 'ets2'], ['terminal', 'ets2']
] as const)('paces repeated %s retirement cycles in %s mode until the connection proves healthy', async (loss, selection) => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection}, broker); await settle();
  for (const delay of [250, 500, 1000, 2000, 4000, 4000]) {
    const attached = f.attach.mock.calls.length, scanned = f.discover.mock.calls.length;
    // Hydration/connected status alone must not reset durable first-commit backoff.
    f.coordinator.observe('v0', {status: 'connected', reason: 'Validated current observation'});
    f.coordinator.observe('v1', {status: 'connected', reason: 'Validated current observation'});
    if (loss === 'both') f.coordinator.observe('v0', {status: 'disconnected', reason: 'Source closed'});
    f.coordinator.observe('v1', {status: 'disconnected', reason: loss === 'terminal' ? 'Source ended (plugin-shutdown)' : 'Source closed'});
    await settle(); expect(f.retire).toHaveBeenCalledTimes(attached + 1);
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(f.discover).toHaveBeenCalledTimes(scanned); expect(f.attach).toHaveBeenCalledTimes(attached);
    await vi.advanceTimersByTimeAsync(1); expect(f.attach).toHaveBeenCalledTimes(attached + 1);
  }
});
it('restarts recovery backoff only for matching ingestion health or an explicit selection', async () => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  const drop = () => f.coordinator.observe('v1', {status: 'disconnected', reason: 'Source ended (plugin-shutdown)'});
  drop(); await settle(); await vi.advanceTimersByTimeAsync(250);
  f.coordinator.healthy(target('ats')); drop(); await settle();
  await vi.advanceTimersByTimeAsync(499); expect(f.attach).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); expect(f.attach).toHaveBeenCalledTimes(3);
  f.coordinator.healthy(target()); drop(); await settle();
  await vi.advanceTimersByTimeAsync(249); expect(f.attach).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1); expect(f.attach).toHaveBeenCalledTimes(4);
  drop(); await settle(); f.coordinator.select({kind: 'game', selection: 'ets2'}, broker); await settle();
  expect(f.attach).toHaveBeenCalledTimes(5); drop(); await settle();
  await vi.advanceTimersByTimeAsync(250); expect(f.attach).toHaveBeenCalledTimes(6);
});
it('waits for retired children to close before starting recovery backoff', async () => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  let close!: () => void; f.retire.mockImplementationOnce(() => new Promise(resolve => {close = resolve;}));
  f.coordinator.observe('v1', {status: 'disconnected', reason: 'Source ended (plugin-shutdown)'}); await settle();
  try {
    // Duplicate close notifications and a late predecessor health signal cannot replace the pending retirement.
    f.coordinator.observe('v0', {status: 'disconnected', reason: 'Source closed'}); f.coordinator.healthy(target());
    await vi.advanceTimersByTimeAsync(5000); expect(f.attach).toHaveBeenCalledTimes(1); expect(f.retire).toHaveBeenCalledTimes(2);
  } finally {close();}
  await settle(); await vi.advanceTimersByTimeAsync(249); expect(f.attach).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); expect(f.attach).toHaveBeenCalledTimes(2);
});
it.each(['stop', 'fixture', 'explicit'] as const)('cancels automatic recovery on %s', async action => {
  const f = fixture(availability(target())); f.coordinator.select({kind: 'game', selection: 'game'}, broker); await settle();
  f.coordinator.observe('v1', {status: 'disconnected', reason: 'Source ended (plugin-shutdown)'}); await settle();
  if (action === 'stop') await f.coordinator.stop();
  else if (action === 'fixture') {f.coordinator.select({kind: 'fixture', selection: 'replay'}, broker); await settle();}
  else {f.available(availability(target('ats'))); f.coordinator.select({kind: 'game', selection: 'ets2'}, broker); await settle();}
  const scanned = f.discover.mock.calls.length;
  await vi.advanceTimersByTimeAsync(249); expect(f.discover).toHaveBeenCalledTimes(scanned);
  if (action !== 'explicit') {await vi.advanceTimersByTimeAsync(10000); expect(f.discover).toHaveBeenCalledTimes(scanned);}
  expect(f.attach.mock.calls.map(call => call[0])).toEqual(action === 'fixture' ? ['ets2', 'replay'] : ['ets2']);
});
