import {build} from 'vite';
const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('Output directory required');
await build({configFile: false, build: {outDir, emptyOutDir: false,
  lib: {entry: 'tests/diagnostics/overlay-bounds-probe.ts', formats: ['cjs'], fileName: () => 'probe.cjs'},
  rollupOptions: {external: ['electron', 'node:path', 'node:fs/promises', 'node:assert/strict']}}});
