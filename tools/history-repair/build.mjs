import {build} from 'vite';
import {builtinModules} from 'node:module';
import {fileURLToPath} from 'node:url';
// better-sqlite3 stays external: dist/cli.cjs resolves it from the checkout's node_modules under the pinned Electron runtime.
const root = fileURLToPath(new URL('.', import.meta.url));
await build({configFile: false, root, logLevel: 'warn', build: {outDir: 'dist', emptyOutDir: true, minify: false, lib: {entry: 'src/cli.ts', formats: ['cjs'], fileName: () => 'cli.cjs'},
  rollupOptions: {external: ['better-sqlite3', ...builtinModules, ...builtinModules.map(x => `node:${x}`)]}}});
