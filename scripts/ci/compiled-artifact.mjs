// Same-run compiled payload only. Verify every plain file and identity before copying anything into the checkout.
import {createHash} from 'node:crypto';
import {lstat, readdir, readFile, writeFile, mkdir, copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
export const COMPILED_ROOTS = ['apps/desktop/dist', '.local/package-native/telemetry-plugin', 'tools/telemetry-simulator/dist',
  'native/telemetry-client/build/Release', 'native/telemetry-plugin/build/Release', 'out/ETS2Telemetry Desktop-win32-x64',
  'node_modules/better-sqlite3/prebuilds/win32-x64.node'];
const MAKER = 'out/make/squirrel.windows/x64';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => {throw new Error('COMPILED_ARTIFACT_INVALID');};
const safe = name => typeof name === 'string' && !name.includes('\\') && !name.includes(':') && name.split('/').every(part => part && part !== '.' && part !== '..');
/** Check the root itself and every existing ancestor, including an optional not-yet-created CLI destination. */
async function plainRoot(root, allowMissing = false) {
  const resolved = path.resolve(root), drive = path.parse(resolved).root;
  let current = drive;
  for (const part of resolved.slice(drive.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = await lstat(current).catch(error => {if (!allowMissing || error.code !== 'ENOENT') throw error;});
    if (!stat) return;
    if (stat.isSymbolicLink() || !stat.isDirectory()) refuse();
  }
}
async function plain(root, name, directory = false) {
  if (!safe(name)) refuse();
  const parts = name.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(path.join(root, ...parts.slice(0, i)));
    if (stat.isSymbolicLink() || (i < parts.length || directory ? !stat.isDirectory() : !stat.isFile())) refuse();
  }
}
async function files(root, relative) {
  const stat = await lstat(path.join(root, relative));
  if (stat.isSymbolicLink()) refuse();
  if (stat.isFile()) return [relative];
  if (!stat.isDirectory()) refuse();
  const out = [];
  for (const name of (await readdir(path.join(root, relative))).sort()) out.push(...await files(root, `${relative ? `${relative}/` : ''}${name}`));
  return out;
}
function validIdentity(source, checkout) {if (!/^[a-f0-9]{40}$/.test(source) || !/^[a-f0-9]{40}$/.test(checkout)) refuse();}
function allowed(name, installer) {return [...COMPILED_ROOTS, ...(installer ? [MAKER] : [])].some(root => name === root || name.startsWith(`${root}/`));}
export async function createCompiledArtifact(root, output, source, checkout, installer) {
  validIdentity(source, checkout);
  await plainRoot(root); await plainRoot(output, true);
  const entries = [];
  for (const base of [...COMPILED_ROOTS, ...(installer ? [MAKER] : [])]) {
    await plain(root, base, !(await lstat(path.join(root, base))).isFile());
    for (const name of await files(root, base)) {
      // Build libraries/debug outputs are not runtime inputs. Keep native executables, DLLs and build evidence only.
      if (name.startsWith('native/') && !/\.(exe|dll|json)$/.test(name)) continue;
      const bytes = await readFile(path.join(root, name));
      entries.push({path: name, bytes: bytes.length, sha256: sha(bytes)});
      const target = path.join(output, 'payload', name); await mkdir(path.dirname(target), {recursive: true}); await writeFile(target, bytes);
    }
  }
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify({version: 1, source, checkout, installer, files: entries}));
}
export async function restoreCompiledArtifact(input, root, source, checkout, installer) {
  validIdentity(source, checkout);
  await plainRoot(input); await plainRoot(root, true);
  await plain(input, 'manifest.json');
  if ((await lstat(path.join(input, 'manifest.json'))).size > 8 * 1024 * 1024) refuse();
  const manifest = JSON.parse(await readFile(path.join(input, 'manifest.json'), 'utf8'));
  if (manifest.version !== 1 || manifest.source !== source || manifest.checkout !== checkout || manifest.installer !== installer || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 30000) refuse();
  const names = new Set(); let total = 0;
  for (const entry of manifest.files) {
    if (!safe(entry.path) || !allowed(entry.path, installer) || names.has(entry.path.toLowerCase()) || !/^[a-f0-9]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) refuse();
    names.add(entry.path.toLowerCase()); total += entry.bytes; if (total > 4 * 1024 ** 3) refuse();
    await plain(input, `payload/${entry.path}`);
    const bytes = await readFile(path.join(input, 'payload', entry.path));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) refuse();
  }
  for (const base of [...COMPILED_ROOTS, ...(installer ? [MAKER] : [])]) if (!manifest.files.some(entry => entry.path === base || entry.path.startsWith(`${base}/`))) refuse();
  const actual = await files(input, 'payload');
  if (actual.length !== names.size || actual.some(name => !names.has(name.slice(8).toLowerCase()))) refuse();
  // All input validated before mutation. Reject destination links before creating/copying a bounded allowed path.
  for (const entry of manifest.files) {
    const parts = entry.path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const destination = path.join(root, ...parts.slice(0, i));
      const stat = await lstat(destination).catch(error => {if (error.code !== 'ENOENT') throw error;});
      if (stat && (stat.isSymbolicLink() || (i < parts.length ? !stat.isDirectory() : !stat.isFile()))) refuse();
    }
  }
  for (const entry of manifest.files) {const destination = path.join(root, entry.path); await mkdir(path.dirname(destination), {recursive: true}); await copyFile(path.join(input, 'payload', entry.path), destination);}
  return {files: names.size, bytes: total, source, checkout};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, directory, kind, destination] = process.argv.slice(2), root = process.cwd(), source = process.env.ETS2TELEMETRY_SOURCE_COMMIT;
  const checkout = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (!['create', 'restore'].includes(mode) || !directory || !['installer', 'portable'].includes(kind)) refuse();
  if (mode === 'create') await createCompiledArtifact(root, path.resolve(directory), source, checkout, kind === 'installer');
  else {
    if (destination !== undefined && !safe(destination)) refuse();
    console.log(JSON.stringify(await restoreCompiledArtifact(path.resolve(directory), destination ? path.resolve(root, destination) : root, source, checkout, kind === 'installer')));
  }
}
