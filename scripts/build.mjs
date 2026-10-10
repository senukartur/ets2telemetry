import { build } from 'vite';
import { builtinModules } from 'node:module';
import {writeFileSync} from 'node:fs';
import {sourceHashes} from './source-inputs.mjs';
const sources = sourceHashes();
const external = ['electron', 'better-sqlite3', 'electron-squirrel-startup', ...builtinModules, ...builtinModules.map(x => `node:${x}`)];
for (const name of ['main', 'preload', 'telemetry-service', 'storage-worker']) {
  await build({configFile:false, build:{outDir:'apps/desktop/dist',emptyOutDir:name === 'main',lib:{entry:`apps/desktop/src/${name}.ts`,formats:['cjs'],fileName:()=>`${name}.cjs`},rollupOptions:{external}}});
}
await build({configFile:false,root:'apps/desktop',base:'./',build:{outDir:'dist/renderer',emptyOutDir:true}});
if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('Sources changed during build; rebuild before packaging');
writeFileSync('apps/desktop/dist/build-evidence.json', JSON.stringify({builtUtc: new Date().toISOString(), sources}, null, 2) + '\n');
