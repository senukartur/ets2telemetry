import {createHash} from 'node:crypto';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function sourceHashes(root = '.') {
  const inputs = ['package.json', 'package-lock.json', 'forge.config.cjs', 'scripts/build.mjs', 'scripts/source-inputs.mjs', 'apps/desktop/index.html'];
  function walk(directory) {
    for (const item of readdirSync(path.join(root, directory), {withFileTypes: true})) {
      const filename = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(filename);
      else inputs.push(filename);
    }
  }
  walk('apps/desktop/src');
  for (const name of ['contracts', 'telemetry-core']) walk(`packages/${name}/src`);
  return Object.fromEntries(inputs.sort().map(filename => [filename, sha256(readFileSync(path.join(root, filename)))]));
}
