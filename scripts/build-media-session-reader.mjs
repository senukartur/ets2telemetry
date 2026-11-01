import {spawnSync} from 'node:child_process';
import {copyFileSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {cmakeChannelDefinition, resolveBuildChannel} from './build-channel.mjs';
import {sha256, sourceHashes} from './source-inputs.mjs';
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Media reader requires Windows x64');
const sources = sourceHashes(), channel = resolveBuildChannel();
for (const args of [['-S', 'native/media-session-reader', '-B', 'native/media-session-reader/build', '-A', 'x64', cmakeChannelDefinition(channel)], ['--build', 'native/media-session-reader/build', '--config', 'Release', '--parallel']]) {
  const result = spawnSync('cmake', args, {stdio: 'inherit', shell: false, timeout: 180000});
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Media reader build failed: ${result.status}`);
}
if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('Sources changed during media reader build');
const executable = 'native/media-session-reader/build/Release/media-session-reader.exe', stage = '.local/package-native/media-session-reader';
mkdirSync(stage, {recursive: true});
copyFileSync(executable, path.join(stage, 'media-session-reader.exe'));
writeFileSync(path.join(stage, 'build-evidence.json'), JSON.stringify({channel, sources, executableSha256: sha256(readFileSync(executable))}, null, 2) + '\n');
