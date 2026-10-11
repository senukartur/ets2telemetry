import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
const directory = path.resolve('.local/ci');
await mkdir(directory, {recursive: true});
const filename = path.join(directory, 'versions.json');
let initial;
try {initial = JSON.parse(await readFile(filename, 'utf8'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
const startedUtc = initial?.startedUtc ?? new Date().toISOString();
const report = {startedUtc, observedUtc: new Date().toISOString(),
  elapsedSeconds: (Date.now() - Date.parse(startedUtc)) / 1000,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  sourceCommit: process.env.ETS2TELEMETRY_SOURCE_COMMIT,
  platform: process.platform, arch: process.arch, osRelease: os.release(), versions: process.versions,
  image: {name: process.env.ImageOS, version: process.env.ImageVersion},
  github: {runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT},
  dependencies: JSON.parse(await readFile('package.json', 'utf8')).devDependencies,
  lintDependencies: JSON.parse(await readFile('tools/lint/package.json', 'utf8')).devDependencies};
await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
