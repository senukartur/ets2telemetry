import {configDefaults, defineConfig} from 'vitest/config';
export default defineConfig({test: {projects: [
  {test: {name: 'unit', setupFiles: ['tests/shared/build-channel-environment.ts'], include: ['tests/unit/**/*.test.ts'], exclude: [...configDefaults.exclude, 'tests/unit/plugin-setup.test.ts'], sequence: {groupOrder: 0}}},
  // Real process enumeration and guarded setup I/O run after unit-worker churn. Same tests, command and limits.
  {test: {name: 'host-boundaries', setupFiles: ['tests/shared/build-channel-environment.ts'], include: ['tests/host/**/*.test.ts', 'tests/unit/plugin-setup.test.ts'], sequence: {groupOrder: 1}, fileParallelism: false, maxWorkers: 1}}
]}});
