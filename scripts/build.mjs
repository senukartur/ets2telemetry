import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { builtinModules } from 'node:module';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {sourceHashes} from './source-inputs.mjs';
const sources = sourceHashes();
const external = ['electron', 'better-sqlite3', ...builtinModules, ...builtinModules.map(x => `node:${x}`)];
for (const name of ['main', 'preload', 'overlay-preload', 'telemetry-service', 'storage-worker']) {
  await build({configFile:false, build:{outDir:'apps/desktop/dist',emptyOutDir:name === 'main',lib:{entry:`apps/desktop/src/${name}.ts`,formats:['cjs'],fileName:()=>`${name}.cjs`},rollupOptions:{external}}});
}
// Tailwind v4 compiles the renderer stylesheet. The '@' alias mirrors tsconfig.json paths for shadcn/ui components.
// The renderer CSP has no data: source, so assets must never be inlined as data URIs.
await build({configFile:false,root:'apps/desktop',base:'./',plugins:[tailwindcss()],resolve:{alias:{'@':path.resolve('apps/desktop/src')}},build:{outDir:'dist/renderer',emptyOutDir:true,assetsInlineLimit:0}});
// The renderer CSP has no data: source. Fail here rather than ship a stylesheet or page the CSP would block.
const rendererOutput = 'apps/desktop/dist/renderer';
const emitted = [['index.html', /\b(?:src|href)\s*=\s*["']?data:/i], ...readdirSync(`${rendererOutput}/assets`).filter(name => name.endsWith('.css')).map(name => [`assets/${name}`, /url\(\s*["']?data:/i])];
for (const [name, pattern] of emitted) {
  if (pattern.test(readFileSync(`${rendererOutput}/${name}`, 'utf8'))) throw new Error(`Renderer output ${name} embeds a data: URI that the renderer CSP blocks`);
}
if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('Sources changed during build; rebuild before packaging');
writeFileSync('apps/desktop/dist/build-evidence.json', JSON.stringify({builtUtc: new Date().toISOString(), sources}, null, 2) + '\n');
