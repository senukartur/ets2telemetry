// Builds the storage worker entrypoint and the storage modules that the Electron-runtime storage suite starts in real
// worker threads and child processes, then runs the given script under the pinned Electron runtime in Node mode
// (scripts/run-electron-node.mjs) with ETS2TELEMETRY_STORAGE_TEST_BUNDLES naming the bundle directory. Vite runs here
// under plain Node; the bundles live in a new temporary directory that is removed afterwards.
// Usage: node scripts/build-storage-test-bundles.mjs <script> [arguments...]
import {spawn} from 'node:child_process';
import {mkdtemp, rm} from 'node:fs/promises';
import {builtinModules, createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {build} from 'vite';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/build-storage-test-bundles.mjs <script> [arguments...]');
  process.exit(2);
}
// The bundles sit outside the checkout, so better-sqlite3 is required by its absolute package path, the same module
// the application's worker resolves from node_modules.
const sqlite = path.dirname(require.resolve('better-sqlite3/package.json')).replaceAll('\\', '/');
const external = ['better-sqlite3', ...builtinModules, ...builtinModules.map(name => `node:${name}`)];
// The protocol v1 ingestion and its durable sink run in the ingestion crash child (tests/storage/v1-ingestion-crash.test.ts).
// The test-only fault storage worker (ET-015a) injects SQLite errors and holds inside real commit transactions.
const entries = {'storage-worker': 'apps/desktop/src/storage-worker.ts', 'storage-core': 'packages/storage/src/index.ts', 'storage-client': 'packages/storage/src/client.ts',
  'v1-ingestion': 'apps/desktop/src/v1-ingestion.ts', 'durable-sink': 'apps/desktop/src/durable-sink.ts', 'fault-storage-worker': 'tests/storage/fixtures/fault-storage-worker.ts'};
const directory = await mkdtemp(path.join(tmpdir(), 'ets2telemetry-storage-bundles-'));
let code;
try {
  for (const [name, entry] of Object.entries(entries)) {
    await build({configFile: false, root, logLevel: 'warn', build: {outDir: directory, emptyOutDir: false, minify: false,
      lib: {entry: path.join(root, entry), formats: ['cjs'], fileName: () => `${name}.cjs`},
      rollupOptions: {external, output: {paths: {'better-sqlite3': sqlite}}}}});
  }
  code = await new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/run-electron-node.mjs'), script, ...rest],
      {stdio: 'inherit', env: {...process.env, ETS2TELEMETRY_STORAGE_TEST_BUNDLES: directory}, windowsHide: true});
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
    child.on('error', error => { console.error(`Storage suite failed to start: ${error.message}`); resolve(1); });
    child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
} finally {
  await rm(directory, {recursive: true, force: true});
}
process.exit(code);
