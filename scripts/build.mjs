import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { builtinModules } from 'node:module';
import {writeFileSync} from 'node:fs';
import {sourceHashes} from './source-inputs.mjs';
const sources = sourceHashes();
const external = ['electron', 'better-sqlite3', 'electron-squirrel-startup', ...builtinModules, ...builtinModules.map(x => `node:${x}`)];
for (const name of ['main', 'preload', 'telemetry-service', 'storage-worker']) {
  await build({configFile:false, build:{outDir:'apps/desktop/dist',emptyOutDir:name === 'main',lib:{entry:`apps/desktop/src/${name}.ts`,formats:['cjs'],fileName:()=>`${name}.cjs`},rollupOptions:{external}}});
}
// Tailwind v4 compiles the renderer stylesheet. The '@' alias mirrors tsconfig.json paths for shadcn/ui components.
// The renderer CSP has no data: source, so assets must never be inlined as data URIs.
await build({configFile:false,root:'apps/desktop',base:'./',plugins:[tailwindcss()],resolve:{alias:{'@':path.resolve('apps/desktop/src')}},build:{outDir:'dist/renderer',emptyOutDir:true,assetsInlineLimit:0}});
if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('Sources changed during build; rebuild before packaging');
writeFileSync('apps/desktop/dist/build-evidence.json', JSON.stringify({builtUtc: new Date().toISOString(), sources}, null, 2) + '\n');
