import {defineConfig} from 'vitest/config';
// Opt-in cross-package protocol v1 chain (ET-006b E14; ET-019 PR-8 process death): requires the native plugin and client builds. Not part of `npm test`.
export default defineConfig({test: {include: ['tests/integration/v1-chain.test.ts', 'tests/integration/v1-chain-process-death.test.ts'], testTimeout: 60_000, hookTimeout: 30_000}});
