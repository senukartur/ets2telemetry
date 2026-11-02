import {build} from 'vite';
import {builtinModules} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('.', import.meta.url));
await build({configFile: false, root, logLevel: 'warn', build: {outDir: 'dist', emptyOutDir: true, lib: {entry: 'src/cli.ts', formats: ['cjs'], fileName: () => 'cli.cjs'}, rollupOptions: {external: [...builtinModules, ...builtinModules.map(x => `node:${x}`)]}}});
