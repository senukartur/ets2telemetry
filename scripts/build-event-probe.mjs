import {build} from 'vite';
import {builtinModules} from 'node:module';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({root, configFile: false, build: {outDir: '.local/validation-tools', emptyOutDir: false,
  lib: {entry: 'tools/telemetry-validation/src/game-events.ts', formats: ['cjs'], fileName: () => 'game-events.cjs'},
  rollupOptions: {external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)]}}});
