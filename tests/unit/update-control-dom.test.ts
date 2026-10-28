import {spawn} from 'node:child_process';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {build} from 'vite';

// ET-055 PR-7 (REG-019): the sidebar update control and the About check in a real DOM. The repository has no DOM
// emulation, so the test bundles tests/fixtures/update-control-dom/entry.ts with Vite and runs it in a hidden, sandboxed
// window of the pinned Electron binary with an isolated userData folder. The page renders the real components with React
// DOM; only the bridge calls are fakes, and the About wait's 30 s timer is a recorded fake timer that the page fires.

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const electron = path.join(repository, 'node_modules', 'electron', 'dist', 'electron.exe');
const fixtures = path.join(repository, 'tests', 'fixtures', 'update-control-dom');
type Facts = Record<string, unknown>;
let root: string | undefined;
let scenarios: Record<string, Facts> = {};

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'ets2telemetry-update-dom-'));
  const page = path.join(root, 'page');
  await build({configFile: false, logLevel: 'silent', root: repository, resolve: {alias: {'@': path.join(repository, 'apps', 'desktop', 'src')}},
    mode: 'production', define: {'process.env.NODE_ENV': JSON.stringify('production')}, oxc: {jsx: {runtime: 'automatic', development: false}},
    build: {outDir: page, emptyOutDir: true, minify: false, lib: {entry: path.join(fixtures, 'entry.ts'), formats: ['iife'], name: 'UpdateControlDom', fileName: () => 'page.js'}}});
  await writeFile(path.join(page, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="page.js"></script></body></html>');
  const environment: NodeJS.ProcessEnv = {...process.env, DOM_PAGE: path.join(page, 'index.html'), DOM_USER_DATA: path.join(root, 'user-data')};
  delete environment.ELECTRON_RUN_AS_NODE;
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(electron, [path.join(fixtures, 'main.cjs')], {env: environment, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true});
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {stdout += chunk.toString('utf8');});
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`Electron exited ${String(code)}: ${stdout}`)));
  });
  const line = output.split(/\r?\n/).find(entry => entry.startsWith('DOM_RESULT '));
  if (!line) throw new Error(`No DOM result: ${output}`);
  const result = JSON.parse(line.slice('DOM_RESULT '.length)) as {scenarios: Record<string, Facts>; error: string | null};
  if (result.error) throw new Error(result.error);
  scenarios = result.scenarios;
}, 90_000);
afterAll(async () => {if (root) await rm(root, {recursive: true, force: true, maxRetries: 5, retryDelay: 200});});

describe('the sidebar update control in a real DOM', () => {
  it('keeps the same focused button from failed through downloading, failed, refused and available', () => {
    expect(scenarios.sidebarFocus).toEqual({initial: {exists: true, active: true}, steps: [
      {state: 'downloading', same: true, active: true, rendered: 'downloading'},
      {state: 'failed', same: true, active: true, rendered: 'failed'},
      {state: 'refused', same: true, active: true, rendered: 'refused'},
      {state: 'available', same: true, active: true, rendered: 'available'}
    ]});
  });
});

describe('the About check in a real DOM', () => {
  it('answers at once from the reply when the throttled check does not start', () => {
    expect(scenarios.throttled).toEqual({busy: false, disabled: false, note: null, message: 'You have the latest version.', severity: 'success', fakeTimers: 0, calls: 1});
  });
  it('waits while a started check runs, with one 30 s timer, then answers with the newer finished check', () => {
    expect(scenarios.started).toEqual({pending: {busy: true, disabled: false, note: null, message: 'Checking for updates…', severity: 'info', fakeTimers: 1},
      busy: false, disabled: false, note: null, message: 'Could not check for updates. The update server could not be reached. Check the internet connection.', severity: 'failed', fakeTimers: 0, calls: 1});
  });
  it('ends the wait when the 30 s timer fires and answers with the latest finished check', () => {
    expect(scenarios.fallback).toEqual({waiting: {busy: true, disabled: false, note: null, message: 'Checking for updates…', severity: 'info', fakeTimers: 1},
      busy: true, disabled: false, note: null, message: 'You have the latest version.', severity: 'success', fakeTimers: 0});
  });
  it('answers at once from the latest finished check when the bridge call rejects', () => {
    expect(scenarios.rejected).toEqual({busy: false, disabled: false, note: null, message: 'You have the latest version.', severity: 'success', fakeTimers: 0, calls: 1});
  });
  it('is busy with a fixed note and ignores the click while an installed update waits for its restart', () => {
    expect(scenarios.ready).toEqual({busy: true, disabled: false, note: 'An update is already installed. Use Restart to finish in the sidebar.', message: null, severity: null, fakeTimers: 0, calls: 0});
  });
  it('answers at once with the offered version when an offer already stands', () => {
    expect(scenarios.offered).toEqual({busy: false, disabled: false, note: null, message: 'Version 0.2.0 is available. Use the button in the sidebar to install it.', severity: 'info', fakeTimers: 0, calls: 1});
  });
});
