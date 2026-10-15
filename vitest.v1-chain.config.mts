import {defineConfig} from 'vitest/config';
// Opt-in cross-package protocol v1 chain (ET-006b E14): requires the native plugin and client builds. Not part of `npm test`.
export default defineConfig({test: {include: ['tests/integration/v1-chain.test.ts'], testTimeout: 60_000, hookTimeout: 30_000}});
