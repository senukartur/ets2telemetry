// Repository ESLint flat config, loaded through the root eslint.config.mjs.
// This module lives beside its own lockfile so that typescript-eslint resolves
// `typescript` to the TypeScript 6 API package; TypeScript 7.0 has no compiler API.
import {builtinModules} from 'node:module';
import {fileURLToPath} from 'node:url';
import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const root = fileURLToPath(new URL('../..', import.meta.url));
const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.mts', '**/*.cts'];
const jsFiles = ['**/*.js', '**/*.mjs', '**/*.cjs'];
const nodeBuiltins = [...builtinModules, ...builtinModules.map(name => `node:${name}`)];
// Promote every rule a preset enables to an error; CI must not stay green with known findings.
const asErrors = rules => Object.fromEntries(Object.entries(rules).map(([name, level]) => [name, level === 'off' || level === 0 ? 'off' : 'error']));
const hooks = reactHooks.configs.flat['recommended-latest'];
// Renderer code is every .tsx module of the desktop app; main, preload, service and worker entries are .ts.
const rendererFiles = ['apps/desktop/src/**/*.tsx'];
const preloadFiles = ['apps/desktop/src/preload.ts', 'apps/desktop/src/overlay-preload.ts'];
// Native SQLite (better-sqlite3) loads only in the storage core, the storage worker and the Electron-runtime storage
// suite. The Node-safe storage modules (api, codec, errors, retention) stay importable everywhere; see docs/storage.md.
const sqliteFiles = ['packages/storage/src/sqlite/**', 'apps/desktop/src/storage-worker.ts', 'tests/storage/**'];
const sqliteMessage = 'Native SQLite loads only in packages/storage/src/sqlite, the storage worker and tests/storage (docs/storage.md).';
const storageCorePatterns = [{
  // The SQLite core, and the in-process storage index that re-exports it.
  regex: '(^|/)storage/src(/index|/sqlite(/.*)?)?(\\.[cm]?[jt]s)?$|^@ets2telemetry/storage(/.*)?$',
  message: 'Import the Node-safe storage modules (api, codec, errors, retention), not the SQLite core; see docs/storage.md.'
}];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**', '**/dist/**', 'out/**', '.local/**', 'native/**', 'planning/**',
      'test-results/**', 'playwright-report/**', 'tests/fixtures/**'
    ]
  },
  {linterOptions: {reportUnusedDisableDirectives: 'error', reportUnusedInlineConfigs: 'error'}},
  {
    files: [...tsFiles, ...jsFiles],
    extends: [js.configs.recommended],
    languageOptions: {globals: globals.node},
    // A `let` assigned after a closure that reads it cannot become `const` without a temporal-dead-zone hazard.
    rules: {'prefer-const': ['error', {ignoreReadBeforeAssign: true}]}
  },
  {
    files: tsFiles,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        // Files outside tsconfig.json (root tool configs) use its options as a default project.
        projectService: {allowDefaultProject: ['*.ts', '*.mts'], defaultProject: 'tsconfig.json'},
        tsconfigRootDir: root
      }
    }
  },
  // Plain JavaScript is not part of a TypeScript project, so it gets syntax-only rules.
  {files: jsFiles, extends: [tseslint.configs.disableTypeChecked]},
  {files: ['**/*.cjs'], languageOptions: {sourceType: 'commonjs'}},
  {
    files: ['tests/**'],
    rules: {
      // Tests inspect untyped JSON reports from child processes and files; `expect` checks their shape at
      // runtime, and casts would only silence these rules without adding a check.
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // `expect(mock.method)` passes a mock as a value and never calls it with a lost `this`.
      '@typescript-eslint/unbound-method': 'off'
    }
  },
  {
    files: rendererFiles,
    plugins: hooks.plugins,
    rules: asErrors(hooks.rules),
    languageOptions: {globals: globals.browser}
  },
  // Flat config replaces, not merges, rule options per file, so each block below restates the restrictions it keeps.
  {
    files: [...tsFiles, ...jsFiles],
    ignores: [...sqliteFiles, ...rendererFiles, ...preloadFiles],
    rules: {'no-restricted-imports': ['error', {paths: [{name: 'better-sqlite3', message: sqliteMessage}]}]}
  },
  {
    // Node-safe tests and the main and service processes never load the SQLite core, even indirectly.
    files: ['tests/unit/**', 'apps/desktop/src/main.ts', 'apps/desktop/src/telemetry-service.ts'],
    rules: {'no-restricted-imports': ['error', {paths: [{name: 'better-sqlite3', message: sqliteMessage}], patterns: storageCorePatterns}]}
  },
  {
    // Renderers run sandboxed with context isolation; only the preload bridge reaches Electron.
    files: rendererFiles,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...nodeBuiltins, 'electron', 'better-sqlite3', 'electron-squirrel-startup'].map(name => ({name, message: 'Renderer code must use the typed preload bridge, not Node.js or Electron modules.'})),
        patterns: [{group: ['electron/*'], message: 'Renderer code must use the typed preload bridge.'}, ...storageCorePatterns]
      }]
    }
  },
  {
    // A sandboxed preload can load only Electron's renderer modules, not Node.js built-ins.
    files: preloadFiles,
    rules: {
      'no-restricted-imports': ['error', {
        paths: [...nodeBuiltins, 'better-sqlite3', 'electron-squirrel-startup'].map(name => ({name, message: 'The sandboxed preload may import only electron renderer APIs.'})),
        patterns: storageCorePatterns
      }]
    }
  }
);
