import { build } from 'vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';
import { builtinModules } from 'node:module';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {resolveBuild} from './build-channel.mjs';
import {sourceHashes} from './source-inputs.mjs';
import {stageUninstallExecutor} from './uninstall-executor.mjs';
const sources = sourceHashes();
// ET-055: the build channel and version (scripts/build-channel.mjs) replace the build-time constants of
// apps/desktop/src/channel.ts and apps/desktop/src/app-version.ts in every bundle, main to renderer.
const resolved = resolveBuild();
const define = {__ETS2TELEMETRY_BUILD_CHANNEL__: JSON.stringify(resolved.channel), __ETS2TELEMETRY_APP_VERSION__: JSON.stringify(resolved.version)};
const external = ['electron', 'better-sqlite3', ...builtinModules, ...builtinModules.map(x => `node:${x}`)];
for (const name of ['main', 'preload', 'overlay-preload', 'telemetry-service', 'storage-worker']) {
  await build({configFile:false, define, build:{outDir:'apps/desktop/dist',emptyOutDir:name === 'main',lib:{entry:`apps/desktop/src/${name}.ts`,formats:['cjs'],fileName:()=>`${name}.cjs`},rollupOptions:{external}}});
}
// The page title is the channel's display name (the main window shows it until the renderer loads). Production keeps the
// tracked index.html text.
const escapeHtml = text => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const channelTitle = {name: 'ets2telemetry-channel-title', transformIndexHtml: html => {
  const replaced = html.replace(/<title>Yukon Union Telemetry<\/title>/, () => `<title>${escapeHtml(resolved.identity.displayName)}</title>`);
  if (replaced === html && resolved.channel !== 'production') throw new Error('apps/desktop/index.html has no <title> to name the channel');
  return replaced;
}};
// Tailwind v4 compiles the renderer stylesheet. The '@' alias mirrors tsconfig.json paths for shadcn/ui components.
// The renderer CSP has no data: source, so assets must never be inlined as data URIs.
await build({configFile:false,root:'apps/desktop',base:'./',define,plugins:[tailwindcss(), channelTitle],resolve:{alias:{'@':path.resolve('apps/desktop/src')}},build:{outDir:'dist/renderer',emptyOutDir:true,assetsInlineLimit:0}});
// The renderer CSP has no data: source. Fail here rather than ship a stylesheet or page the CSP would block.
const rendererOutput = 'apps/desktop/dist/renderer';
const emitted = [['index.html', /\b(?:src|href)\s*=\s*["']?data:/i], ...readdirSync(`${rendererOutput}/assets`).filter(name => name.endsWith('.css')).map(name => [`assets/${name}`, /url\(\s*["']?data:/i])];
for (const [name, pattern] of emitted) {
  if (pattern.test(readFileSync(`${rendererOutput}/${name}`, 'utf8'))) throw new Error(`Renderer output ${name} embeds a data: URI that the renderer CSP blocks`);
}
if (JSON.stringify(sources) !== JSON.stringify(sourceHashes())) throw new Error('Sources changed during build; rebuild before packaging');
// The deferred-cleanup executor with this build's `$Channel` line, which forge.config.cjs packages (ET-055 UP12).
stageUninstallExecutor(resolved.channel);
writeFileSync('apps/desktop/dist/build-evidence.json', JSON.stringify({builtUtc: new Date().toISOString(), channel: resolved.channel, version: resolved.version, sources}, null, 2) + '\n');
