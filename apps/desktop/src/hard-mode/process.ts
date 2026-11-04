import {spawn} from 'node:child_process';
import path from 'node:path';
import type {SourceIdentity} from '../../../../packages/contracts/src/protocol-v1';
import {parseGameTarget, sameTarget, type GameTarget} from '../native-game-discovery';
import type {GameProcess, ProfileDiagnostic} from './reader';
export function processLifetime(target: GameTarget, source: SourceIdentity): string | undefined {
  const peer = target.source;
  if (source.origin !== 'game' || source.game !== peer.game || source.processId !== peer.processId || source.windowsSessionId !== peer.windowsSessionId
    || source.processInstanceId !== peer.processInstanceId || source.pluginSessionId !== peer.pluginSessionId) return undefined;
  return JSON.stringify([source.game, source.processId, source.windowsSessionId, target.processCreationTime, target.userTag]);
}
/** A fixed native operation on the active authenticated peer; settles only after actual child close. */
export function inspectGameProcess(source: SourceIdentity, signal: AbortSignal, diagnostic: (value: ProfileDiagnostic) => void,
  authority: {executable: string; target: GameTarget} | undefined, launch = spawn): Promise<GameProcess | null> {
  if (!authority || !processLifetime(authority.target, source) || signal.aborted) return Promise.resolve(null);
  const {target, executable} = authority;
  return new Promise(resolve => {
    const child = launch(executable, ['--inspect-profile-process'], {windowsHide: true, stdio: 'pipe'});
    let buffer = Buffer.alloc(0), failure: ProfileDiagnostic['code'] | undefined;
    const stop = (code: ProfileDiagnostic['code']) => {failure ??= code; child.kill();};
    const cancel = () => stop('PROFILE_CANCELLED');
    const timer = setTimeout(() => stop('PROFILE_PROCESS_QUERY_DEADLINE'), 2000);
    signal.addEventListener('abort', cancel, {once: true});
    child.on('error', () => {failure ??= 'PROFILE_PROCESS_QUERY_FAILED';});
    child.stdin.on('error', () => stop('PROFILE_PROCESS_QUERY_FAILED'));
    child.stderr.resume();
    const bytes = Buffer.from(JSON.stringify(target)), prefix = Buffer.alloc(4); prefix.writeUInt32LE(bytes.length);
    if (bytes.length > 16384) stop('PROFILE_PROCESS_QUERY_INVALID'); else child.stdin.end(Buffer.concat([prefix, bytes]));
    child.stdout.on('data', (bytes: unknown) => {
      if (failure) return;
      if (!(bytes instanceof Uint8Array) || buffer.length + bytes.length > 16388) {stop('PROFILE_PROCESS_QUERY_INVALID'); return;}
      buffer = Buffer.concat([buffer, bytes]);
      if (buffer.length >= 4 && (!buffer.readUInt32LE() || buffer.readUInt32LE() > 16384 || buffer.length > buffer.readUInt32LE() + 4)) stop('PROFILE_PROCESS_QUERY_INVALID');
    });
    child.once('close', code => {
      clearTimeout(timer); signal.removeEventListener('abort', cancel);
      try {
        if (failure || signal.aborted || code !== 0) throw new Error('Inspection failed');
        if (buffer.length < 4 || buffer.readUInt32LE() !== buffer.length - 4) throw new Error('Inspection frame');
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(buffer.subarray(4))) as Record<string, unknown>;
        if (Object.keys(value).sort().join(',') !== 'executable,homeDirectory,schemaVersion,target,type' || value.type !== 'profile-process' || value.schemaVersion !== 1
          || !sameTarget(parseGameTarget(value.target, source.game), target) || typeof value.executable !== 'string' || value.executable.length > 8192
          || !path.win32.isAbsolute(value.executable) || path.win32.basename(value.executable).toLowerCase() !== (source.game === 'ets2' ? 'eurotrucks2.exe' : 'amtrucks.exe')
          || value.homeDirectory !== null && (typeof value.homeDirectory !== 'string' || !value.homeDirectory || value.homeDirectory.length > 4096 || !path.win32.isAbsolute(value.homeDirectory))) throw new Error('Inspection receipt');
        const createdUtcMs = Number((BigInt(target.processCreationTime) - 116444736000000000n) / 10000n);
        resolve({pid: source.processId, createdUtcMs, executable: value.executable, homeDirectory: value.homeDirectory});
      } catch {diagnostic({code: failure ?? (code === 0 ? 'PROFILE_PROCESS_QUERY_INVALID' : 'PROFILE_PROCESS_QUERY_FAILED')}); resolve(null);}
    });
    if (signal.aborted) cancel();
  });
}
