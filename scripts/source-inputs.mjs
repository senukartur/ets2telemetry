import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function sourceHashes(root = '.') {
  const inputs = ['package.json', 'package-lock.json', 'tsconfig.json', 'forge.config.cjs', 'resources/icon/app.ico', 'scripts/build.mjs', 'scripts/build-native-client.mjs', 'scripts/stage-native-plugin.mjs', 'scripts/plugin-bundle.mjs', 'scripts/source-inputs.mjs', 'apps/desktop/index.html', 'native/telemetry-client/CMakeLists.txt', 'native/telemetry-plugin/src/protocol-v0.cpp', 'native/telemetry-plugin/src/protocol-v0.hpp', 'native/telemetry-plugin/src/protocol-v1.cpp', 'native/telemetry-plugin/src/protocol-v1.hpp', 'native/telemetry-plugin/src/protocol-json.hpp', 'native/telemetry-plugin/src/capture-hello.hpp'];
  function walk(directory) {
    for (const item of readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const filename = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(filename);
      else inputs.push(filename);
    }
  }
  walk('apps/desktop/src');
  walk('native/telemetry-client/src');
  for (const name of ['contracts', 'telemetry-core', 'storage']) walk(`packages/${name}/src`);
  return Object.fromEntries(inputs.sort().map(filename => [filename, sha256(readFileSync(path.join(root, filename)))]));
}
