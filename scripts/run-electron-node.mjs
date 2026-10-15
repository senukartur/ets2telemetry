// Runs a Node.js script under the pinned Electron executable in Node mode (ELECTRON_RUN_AS_NODE=1).
// The storage suite uses it so that better-sqlite3 loads under the same runtime and ABI as the
// telemetry service, never under the plain Node used by the Node-safe Vitest suite (docs/storage.md).
// Usage: node scripts/run-electron-node.mjs <script> [arguments...]
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
// The electron package's main export is the absolute path of the pinned executable.
const electron = /** @type {string} */ (require('electron'));
const [script, ...rest] = process.argv.slice(2);
if (!script) {
  console.error('Usage: node scripts/run-electron-node.mjs <script> [arguments...]');
  process.exit(2);
}
const child = spawn(electron, [script, ...rest], {stdio: 'inherit', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}, windowsHide: true});
// Forward interruption so an aborted local run does not leave the Electron child behind.
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(`Electron runtime failed to start: ${error.message}`); process.exit(1); });
child.on('exit', (code, signal) => { process.exit(code ?? (signal ? 1 : 0)); });
