import {defineConfig} from 'vitest/config';
// Opt-in cross-package chain: requires the native plugin and client builds. Not part of `npm test`.
export default defineConfig({test: {include: ['tests/integration/cap0-chain.test.ts'], testTimeout: 60_000, hookTimeout: 30_000}});
