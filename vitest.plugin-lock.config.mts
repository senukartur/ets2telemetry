import {defineConfig} from 'vitest/config';
// Opt-in ET-017 plugin image lock check (REG-015): requires the native plugin build (fake-SDK host and test plugin DLL).
// Not part of `npm test`.
export default defineConfig({test: {include: ['tests/integration/plugin-image-lock.test.ts'], testTimeout: 60_000, hookTimeout: 30_000}});
