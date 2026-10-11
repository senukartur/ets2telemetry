import { build } from 'vite';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('./app/', import.meta.url));
await build({ root, base: './', configFile: false, build: { outDir: '../dist', emptyOutDir: true, target: 'chrome148' } });
