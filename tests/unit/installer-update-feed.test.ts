import {execFile} from 'node:child_process';
import {mkdir, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {FEED_USER_AGENT, feedRoutes} from '../../scripts/installer/update-feed-fixture.mjs';
import {temporaryResources} from '../shared/resources';

// ET-055 PR-8 (REG-019): the driver's update-from-feed commands without an installer. `update-feed` and `stub-launch`
// refuse a run that is not on a GitHub-hosted runner before they read anything; `update-feed-verify` judges hand-written
// evidence (the observed record and the main and service logs of A and the restarted B), so its rules are proven here
// and the hosted run only supplies real evidence.

const driver = path.resolve('scripts/installer/installer-lifecycle.mjs');
const local = Object.fromEntries(Object.entries(process.env).filter(([key]) => !['GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT'].includes(key.toUpperCase())));
const run = (args: string[]) => new Promise<{passed: boolean; failure: {code?: string; message?: string} | null}>((resolve, reject) => {
  execFile(process.execPath, [driver, ...args], {env: local, encoding: 'utf8', timeout: 30000, windowsHide: true}, (_error, stdout) => {
    try {resolve(JSON.parse(String(stdout).trim().split(/\r?\n/).at(-1)!) as {passed: boolean; failure: {code?: string; message?: string} | null});} catch {reject(new Error('DRIVER_OUTPUT_INVALID'));}
  });
});

const ID = '3'.repeat(32), A = 100, A_SERVICE = 101, B = 200, B_SERVICE = 201;
const offered = {package: '0.1.1-stg.000000', installed: '0.1.1-stg000000'};
const release = {tag: 'staging-v0.1.1-stg.000000', name: 'ETS2TelemetryDesktopStaging-0.1.1-stg000000-full.nupkg'};
const routes = feedRoutes(release);
type Row = {time: string; pid: number; event: string; facts?: Record<string, unknown>; detail?: Record<string, unknown>};
const at = (second: number) => new Date(Date.UTC(2026, 9, 28, 12, 0, second)).toISOString();
const request = (phase: string, requestPath: string, status = 200, bytes = 0) => ({phase, method: 'GET', path: requestPath, status, userAgent: FEED_USER_AGENT, accept: null,
  cookie: false, authorization: false, bytes});

function evidence() {
  const main: Row[] = [
    {time: at(1), pid: A, event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 2}},
    {time: at(2), pid: A, event: 'UPDATE_SUPPORTED', facts: {mode: 'test-root', channel: 'staging'}},
    {time: at(3), pid: A, event: 'UPDATE_CHECK', facts: {origin: 'manual', outcome: 'available', code: null}},
    {time: at(4), pid: A, event: 'UPDATE_REFUSED', facts: {code: 'GAME_RUNNING'}},
    {time: at(5), pid: A, event: 'UPDATE_DOWNLOAD_STARTED'},
    {time: at(6), pid: A, event: 'UPDATE_APPLY_STARTED'},
    {time: at(7), pid: A, event: 'UPDATE_APPLIED', facts: {version: offered.package}},
    {time: at(8), pid: A, event: 'UPDATE_RESTART_REQUESTED'},
    {time: at(8), pid: A, event: 'APP_EXIT_REQUESTED', facts: {reason: 'update'}},
    {time: at(9), pid: A, event: 'SERVICE_EXIT', detail: {code: 0}},
    {time: at(9), pid: A, event: 'APP_EXIT', detail: {code: 0}},
    {time: at(9), pid: A, event: 'UPDATE_RESTART_STARTED'},
    {time: at(12), pid: B, event: 'SETTINGS_LOADED', facts: {state: 'loaded', migratedFrom: 2}},
    {time: at(13), pid: B, event: 'UPDATE_SUPPORTED', facts: {mode: 'test-root', channel: 'staging'}},
    {time: at(15), pid: B, event: 'APP_EXIT_REQUESTED', facts: {reason: 'uninstall'}},
    {time: at(16), pid: B, event: 'SERVICE_EXIT', detail: {code: 0}},
    {time: at(16), pid: B, event: 'APP_EXIT', detail: {code: 0}}
  ];
  const service: Row[] = [
    {time: at(1), pid: A_SERVICE, event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 3, created: false, migratedFrom: null}},
    {time: at(1), pid: A_SERVICE, event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}},
    {time: at(8), pid: A_SERVICE, event: 'SHUTDOWN_STEP', facts: {phase: 'flush', name: 'recording-flush', outcome: 'ok', ms: 3}},
    {time: at(9), pid: A_SERVICE, event: 'SHUTDOWN_STEP', facts: {phase: 'storage', name: 'history-storage', outcome: 'ok', ms: 40}},
    {time: at(9), pid: A_SERVICE, event: 'HISTORY_STORAGE_CLOSED'},
    {time: at(13), pid: B_SERVICE, event: 'HISTORY_STORAGE_OPENED', facts: {schemaVersion: 3, created: false, migratedFrom: null}},
    {time: at(13), pid: B_SERVICE, event: 'RECORDING_TARGET', facts: {purpose: 'synthetic'}},
    {time: at(16), pid: B_SERVICE, event: 'HISTORY_STORAGE_CLOSED'}
  ];
  const observed: Record<string, unknown> = {label: 'feed-b', mode: 'complete', channel: 'staging', offered, package: {name: release.name, size: 10, sha256: 'a'.repeat(64)},
    tag: release.tag, mainPid: A, offer: {state: 'available', available: offered.package}, refusal: {view: {state: 'refused', refusal: 'GAME_RUNNING'}, packageRequests: 0, updates: 'absent'},
    outcome: 'exited', states: ['downloading', 'installing'], exit: {code: 0, signal: null}, servicePidsBefore: 1, restartedPid: B,
    restartedImage: `LocalAppData\\ETS2TelemetryDesktopStaging\\app-${offered.installed}\\ETS2TelemetryDesktopStaging.exe`, requester: {locked: true, requests: 2, elapsedMs: 400},
    drain: {remaining: []}, updates: 'absent', routes, diagnostics: 'diagnostics\\update-feed-b',
    requests: [request('offer', routes.list), request('offer', routes.manifest), request('offer', routes.signature), request('refusal', routes.list),
      request('update', routes.package, 200, 10), request('restart', routes.list)]};
  return {main, service, observed};
}

async function layout(directory: string) {
  const base = await realpath(directory), runRoot = path.join(base, `installer-${ID}`), evidenceFolder = path.join(base, `installer-${ID}-evidence`);
  await mkdir(path.join(runRoot, 'diagnostics', 'update-feed-b', 'service'), {recursive: true});
  await mkdir(evidenceFolder);
  const config = path.join(evidenceFolder, 'config.json');
  await writeFile(config, JSON.stringify({runRoot, evidence: evidenceFolder, setup: path.join(base, 'Setup.exe'), stepBudgetMs: 1000, channel: 'staging', channels: ['staging'],
    appVersion: '0.1.0-stg.000000'}));
  const write = async (value: ReturnType<typeof evidence>) => {
    const lines = (rows: Row[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
    await writeFile(path.join(runRoot, 'diagnostics', 'update-feed-b', 'startup.jsonl'), lines(value.main));
    await writeFile(path.join(runRoot, 'diagnostics', 'update-feed-b', 'service', 'startup.jsonl'), lines(value.service));
    await writeFile(path.join(evidenceFolder, 'update-feed-feed-b-observed.json'), JSON.stringify(value.observed));
  };
  return {config, write};
}

describe('update-from-feed driver commands', () => {
  it('refuses to start the application or a stub outside a GitHub-hosted runner', async () => {
    const resources = await temporaryResources();
    try {
      const {config} = await layout(resources.directory);
      const executable = path.join(resources.directory, 'app.exe');
      expect(await run(['update-feed', config, 'feed-b', executable, 'complete'])).toMatchObject({passed: false, failure: {code: 'LOCAL_RUN_REFUSED'}});
      expect(await run(['update-feed', config, 'feed-c', executable, 'interrupted'])).toMatchObject({passed: false, failure: {code: 'LOCAL_RUN_REFUSED'}});
      expect(await run(['stub-launch', config, 'after-r1'])).toMatchObject({passed: false, failure: {code: 'LOCAL_RUN_REFUSED'}});
      expect((await run(['update-feed', config, 'feed-b', executable, 'other'])).failure?.message).toContain('UPDATE_FEED_MODE_INVALID');
    } finally {await resources.dispose();}
  }, 60000);

  it('accepts the hand-written evidence of a complete update and names each broken rule', async () => {
    const resources = await temporaryResources();
    try {
      const {config, write} = await layout(resources.directory);
      const verify = async (change: (value: ReturnType<typeof evidence>) => void) => {
        const value = evidence();
        change(value);
        await write(value);
        return run(['update-feed-verify', config, 'feed-b']);
      };
      expect(await verify(() => undefined)).toMatchObject({passed: true});
      const failure = async (change: (value: ReturnType<typeof evidence>) => void) => (await verify(change)).failure?.message ?? 'PASSED';
      expect(await failure(value => {value.observed.refusal = {view: {state: 'refused', refusal: 'GAME_RUNNING'}, packageRequests: 1, updates: 'absent'};}))
        .toMatch(/^UPDATE_NOT_REFUSED_WHILE_GAME_RUNS/);
      expect(await failure(value => {(value.observed.requests as unknown[]).push(request('refusal', routes.package, 200, 10));})).toMatch(/^UPDATE_FEED_REQUESTS_UNEXPECTED/);
      expect(await failure(value => {(value.observed.requests as unknown[]).push(request('offer', routes.latestManifest, 404));})).toMatch(/^UPDATE_FEED_REQUESTS_UNEXPECTED/);
      expect(await failure(value => {(value.observed.requests as unknown[]).push(request('restart', routes.package, 200, 10));})).toMatch(/^RESTART_FEED_REQUESTS_UNEXPECTED/);
      expect(await failure(value => {value.main = value.main.filter(row => row.event !== 'UPDATE_REFUSED');})).toMatch(/^UPDATE_EVENTS_OUT_OF_ORDER/);
      expect(await failure(value => {value.main = value.main.map(row => row.event === 'APP_EXIT_REQUESTED' && row.pid === A ? {...row, facts: {reason: 'tray'}} : row);}))
        .toMatch(/^UPDATE_EVENTS_OUT_OF_ORDER/);
      expect(await failure(value => {value.service = value.service.filter(row => row.facts?.name !== 'recording-flush');})).toMatch(/^RECORDING_FLUSH_NOT_RUN/);
      expect(await failure(value => {value.main = value.main.map(row => row.pid === B && row.event === 'SETTINGS_LOADED' ? {...row, time: at(7)} : row);}))
        .toMatch(/^RESTART_BEFORE_RECORDING_FLUSH/);
      expect(await failure(value => {value.observed.restartedImage = 'LocalAppData\\ETS2TelemetryDesktopStaging\\app-0.1.0-stg000000\\ETS2TelemetryDesktopStaging.exe';}))
        .toMatch(/^RESTARTED_IMAGE_NOT_B/);
      expect(await failure(value => {value.service = value.service.map(row => row.pid === B_SERVICE && row.event === 'HISTORY_STORAGE_OPENED' ? {...row, facts: {schemaVersion: 3, created: true, migratedFrom: null}} : row);}))
        .toMatch(/^RESTARTED_HISTORY_UNEXPECTED/);
      expect(await failure(value => {value.observed.requester = {locked: false};})).toMatch(/^RESTARTED_INSTANCE_DID_NOT_EXIT/);
      expect(await failure(value => {value.main.push({time: at(17), pid: B, event: 'RENDER_PROCESS_GONE'});})).toMatch(/^FAILURE_EVENT_LOGGED/);
      expect(await failure(value => {value.observed.updates = ['0.1.1-stg000000'];})).toMatch(/^UPDATES_FOLDER_LEFT/);
      expect(await failure(value => {value.observed.outcome = 'failed';})).toMatch(/^UPDATE_DID_NOT_RESTART/);
    } finally {await resources.dispose();}
  }, 120000);

  it('records the interrupted apply as an observation and asserts only the orderly exit', async () => {
    const resources = await temporaryResources();
    try {
      const {config, write} = await layout(resources.directory);
      const value = evidence();
      value.observed = {...value.observed, mode: 'interrupted', kill: {updaters: 1, killed: 1, entriesAtKill: 3, msAfterInstalling: 900, reason: 'app-folder'},
        afterKill: {view: {state: 'failed', failure: 'APPLY_FAILED'}}, retry: {view: {state: 'installing'}}, after: {}, updaterWait: {remaining: 0}, restarted: 0};
      await write(value);
      expect(await run(['update-feed-verify', config, 'feed-b'])).toMatchObject({passed: true});
      value.observed.exit = {code: 1, signal: null};
      await write(value);
      expect((await run(['update-feed-verify', config, 'feed-b'])).failure?.message).toMatch(/^UPDATE_APP_EXIT_NONZERO/);
    } finally {await resources.dispose();}
  }, 60000);
});
