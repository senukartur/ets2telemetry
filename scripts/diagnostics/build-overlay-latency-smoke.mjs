import {build} from 'vite';
const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error('Output directory required');
await build({configFile: false, build: {outDir, emptyOutDir: false,
  lib: {entry: 'tests/diagnostics/overlay-latency-smoke.ts', formats: ['cjs'], fileName: () => 'smoke.cjs'},
  rollupOptions: {external: ['electron', 'node:path', 'node:fs/promises', 'node:assert/strict']}}});
