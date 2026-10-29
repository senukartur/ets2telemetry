import {sameGameSource} from './live-state';
import {spawn} from 'node:child_process';
import {isUint64, type SourceIdentity} from '../../../packages/contracts/src/protocol-v0';
import type {BrokerConfiguration, BrokerProtocol} from './native-pipe-client';

export type Game = 'ets2' | 'ats';
export interface GameTarget {source: SourceIdentity; processCreationTime: string; userTag: string}
export type GameAvailability = {status: 'absent' | 'ambiguous'} | {status: 'unique'; target: GameTarget};
export interface GameDiscovery {ets2: GameAvailability; ats: GameAvailability}
export class NativeDiscoveryError extends Error {
  constructor(message: string, readonly transient: boolean) {super(message);}
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || !keys.every(key => Object.hasOwn(value, key))) throw new Error('Invalid discovery receipt');
  return value as Record<string, unknown>;
}
export function parseGameTarget(value: unknown, game: Game): GameTarget {
  const target = object(value, ['source', 'processCreationTime', 'userTag']);
  const source = object(target.source, ['game', 'origin', 'processId', 'windowsSessionId', 'processInstanceId', 'pluginSessionId']);
  const integer = (n: unknown, min: number) => typeof n === 'number' && Number.isInteger(n) && n >= min && n <= 0xffffffff;
  if (source.game !== game || source.origin !== 'game' || !integer(source.processId, 1) || !integer(source.windowsSessionId, 0) ||
    typeof source.processInstanceId !== 'string' || !UUID.test(source.processInstanceId) || typeof source.pluginSessionId !== 'string' || !UUID.test(source.pluginSessionId) ||
    !isUint64(target.processCreationTime) || typeof target.userTag !== 'string' || !/^[0-9a-f]{64}$/.test(target.userTag)) throw new Error('Invalid discovery target');
  return Object.freeze({source: Object.freeze({...source}) as unknown as SourceIdentity, processCreationTime: target.processCreationTime, userTag: target.userTag});
}
export function sameTarget(left: GameTarget, right: GameTarget): boolean {
  return left.processCreationTime === right.processCreationTime && left.userTag === right.userTag && sameGameSource(left.source, right.source);
}
export function parseDiscoveryReceipt(value: unknown, protocol: BrokerProtocol): GameDiscovery {
  const receipt = object(value, ['type', 'schemaVersion', 'protocolMajor', 'games']);
  if (receipt.type !== 'discovery' || receipt.schemaVersion !== 1 || receipt.protocolMajor !== (protocol === 'v1' ? 1 : 0)) throw new Error('Invalid discovery protocol');
  const games = object(receipt.games, ['ets2', 'ats']);
  const entry = (game: Game): GameAvailability => {
    const raw = games[game];
    const status = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).status : undefined;
    const result = object(raw, status === 'unique' ? ['status', 'target'] : ['status']);
    if (status === 'unique') return {status, target: parseGameTarget(result.target, game)};
    if (status !== 'absent' && status !== 'ambiguous') throw new Error('Invalid discovery status');
    return {status};
  };
  return {ets2: entry('ets2'), ats: entry('ats')};
}
/** Resolves only after `close`: cancelled predecessors retain ownership until the child actually exits. */
export function discoverGames(configuration: BrokerConfiguration, protocol: BrokerProtocol, signal: AbortSignal): Promise<GameDiscovery> {
  if (signal.aborted) return Promise.reject(new Error('Discovery cancelled'));
  return new Promise((resolve, reject) => {
    const child = spawn(configuration.executable, ['--discover', '--discovery-dir', configuration.discoveryDirectory, ...(protocol === 'v1' ? ['--protocol', 'v1'] : [])], {windowsHide: true, stdio: 'pipe'});
    let buffer = Buffer.alloc(0), failure: Error | undefined;
    const cancel = () => {failure ??= new Error('Discovery cancelled'); child.kill();};
    const timer = setTimeout(() => {failure ??= new NativeDiscoveryError('Discovery deadline exceeded', true); child.kill();}, 5000);
    signal.addEventListener('abort', cancel, {once: true});
    child.stdin.on('error', () => {failure ??= new Error('Discovery control failed');});
    child.on('error', () => {failure ??= new Error('Discovery could not start');});
    child.stderr.resume(); child.stdin.end();
    child.stdout.on('data', (bytes: unknown) => {
      if (failure) return;
      if (!(bytes instanceof Uint8Array) || buffer.length + bytes.length > 4100) {failure = new Error('Discovery byte bound exceeded'); child.kill(); return;}
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length >= 4 && (!buffer.readUInt32LE() || buffer.readUInt32LE() > 4096 || buffer.length > buffer.readUInt32LE() + 4)) {failure = new Error('Invalid discovery frame'); child.kill();}
    });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      try {
        if (failure) throw failure;
        if ((code === 3 || code === 4) && buffer.length === 0) throw new NativeDiscoveryError('Discovery did not complete', true);
        if (code !== 0 || buffer.length < 4 || buffer.readUInt32LE() !== buffer.length - 4) throw new Error('Incomplete discovery receipt');
        resolve(parseDiscoveryReceipt(JSON.parse(buffer.subarray(4).toString('utf8')), protocol));
      } catch (error) {reject(error instanceof Error ? error : new Error('Discovery rejected'));}
    });
  });
}
