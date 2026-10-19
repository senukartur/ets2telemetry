import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {constants, copyFile, mkdir, open, readdir, readFile, realpath, stat} from 'node:fs/promises';
import path from 'node:path';
import {listState, untilPage} from './journal-observation.mjs';
import {RECORDING_DISABLED_TEXT, waitForRecordingText} from './renderer-observation.mjs';

// ET-019 PR-7: the newer-database refusal in the running application (REG-013, REG-014, REG-017). Before the launch the
// driver copies the immutable storage fixture `schema-newer-999.sqlite` (this application's id, schema version 999) to
// the history path of the isolated LOCALAPPDATA. The service must refuse it at inspection with SCHEMA_NEWER and leave
// the file unchanged (docs/storage.md, Opening a database and Error codes); the Journal tab must show the fixed J11
// sentence for DATABASE_UNAVAILABLE with the SCHEMA_NEWER cause (docs/journal.md); the recording status stays `disabled`,
// because production builds no trip recorder (docs/telemetry-service-v1.md, Recording status rule 1); and main's health
// stays ready with the storage self-test verified (docs/app-lifecycle.md). Every expected value below is written by hand
// from those documents and apps/desktop/src/strings.ts; none is read back from the product's code. The record holds
// names, codes, hashes and texts only, never a path.

const FIXTURE = 'schema-newer-999.sqlite';
const APPLICATION_ID = 1163154226;
const FAILURE_EVENTS = /FAILED|TIMEOUT|UNCAUGHT|UNHANDLED|INVALID|RENDER_PROCESS_GONE/;
/** J11: `The database is unavailable: {cause}.` with RECORDING_CODE_TEXT.SCHEMA_NEWER as the cause. */
export const SCHEMA_NEWER_JOURNAL_TEXT = 'The database is unavailable: the database was written by a newer version.';
/** J11: every journal read of a refused database answers DATABASE_UNAVAILABLE with the storage code that refused it. */
const REFUSED_ANSWER = Object.freeze({ok: false, code: 'DATABASE_UNAVAILABLE', storageCode: 'SCHEMA_NEWER'});
/** A well-formed trip UUID that the refused database cannot hold; the read must be refused before any lookup. */
const ANY_TRIP = '7a000000-0000-4000-8000-000000000001';

const sha256 = async file => createHash('sha256').update(await readFile(file)).digest('hex');
const historyFile = config => path.join(config.localappdata, 'ETS2Telemetry', 'data', 'telemetry.sqlite');
async function header(file) {
  const bytes = Buffer.alloc(100), handle = await open(file, 'r');
  try {await handle.read(bytes, 0, 100, 0);} finally {await handle.close();}
  return {magic: bytes.subarray(0, 15).toString('latin1'), applicationId: bytes.readInt32BE(68), userVersion: bytes.readUInt32BE(60)};
}
/** The fixture's SHA-256 as listed in the immutable storage manifest (`<sha256> <file>` lines). */
async function manifestHash(config) {
  const manifest = await readFile(path.join(config.checkout, 'tests', 'fixtures', 'storage', 'manifest.txt'), 'utf8');
  const rows = manifest.split(/\r?\n/).map(line => /^([0-9a-f]{64}) (\S+)$/.exec(line)).filter(match => match?.[2] === FIXTURE);
  assert.equal(rows.length, 1, 'The storage manifest does not list the newer-schema fixture once');
  return rows[0][1];
}

/**
 * Before the launch: copies the fixture to the history path of this run's isolated LOCALAPPDATA, which must not exist
 * yet, and checks the fixture's manifest hash before and after the copy and the copy's own hash.
 */
export async function placeNewerHistory({config, record}) {
  const fixture = path.join(config.checkout, 'tests', 'fixtures', 'storage', FIXTURE), target = historyFile(config);
  const relative = path.relative(path.resolve(config.output), path.resolve(target));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'The history path is outside this run\'s output folder');
  assert.equal(existsSync(path.dirname(path.dirname(target))), false, 'The isolated LOCALAPPDATA already holds an ETS2Telemetry folder');
  // Defence in depth: whatever the configuration says, never write under this driver's own (real) LOCALAPPDATA. Both sides
  // are resolved through existing folders (realpath, so junctions and 8.3 names compare equal) and compared without case.
  const canonical = async folder => {try {return await realpath(folder);} catch {return path.resolve(folder);}};
  const realLocal = process.env.LOCALAPPDATA;
  if (realLocal) {
    const own = (await canonical(realLocal)).toLowerCase();
    const placed = path.join(await canonical(config.localappdata), path.relative(config.localappdata, target)).toLowerCase();
    const inside = path.win32.relative(own, placed);
    assert.ok(inside.startsWith('..') || path.win32.isAbsolute(inside), 'The history path is under the real LOCALAPPDATA');
  }
  const expected = await manifestHash(config);
  assert.equal(await sha256(fixture), expected, 'The newer-schema fixture differs from its manifest before the copy');
  await mkdir(path.dirname(target), {recursive: true});
  await copyFile(fixture, target, constants.COPYFILE_EXCL);
  const placed = record.placed = {fixture: FIXTURE, manifestSha256: expected, fixtureSha256After: await sha256(fixture), sha256: await sha256(target),
    bytes: (await stat(target)).size, header: await header(target)};
  assert.deepEqual({fixtureSha256After: placed.fixtureSha256After, sha256: placed.sha256, header: placed.header},
    {fixtureSha256After: expected, sha256: expected, header: {magic: 'SQLite format 3', applicationId: APPLICATION_ID, userVersion: 999}});
  record.fixtureUnchanged = true; record.placedAtHistoryPath = true;
}

/**
 * While the application runs: the bridge's journal reads answer the refusal once the open has finished (DATABASE_OPENING
 * is retried for up to 10 s, as in the scaffold smoke); main's health is ready with the self-test verified and the
 * recording disabled; the dashboard shows the disabled recording texts; the Journal tab shows only the J11 sentence.
 */
export async function runRefusalSmoke({dashboard, config, record}) {
  record.bridge = await dashboard.evaluate(async trip => {
    let list;
    for (let attempt = 0; attempt < 100; attempt++) {
      list = await globalThis.desktop.listJournalTrips();
      if (list.ok || list.code !== 'DATABASE_OPENING') break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return {list, detail: await globalThis.desktop.getJournalTrip(trip), events: await globalThis.desktop.listJournalEvents(trip)};
  }, ANY_TRIP);
  assert.deepEqual(record.bridge, {list: REFUSED_ANSWER, detail: REFUSED_ANSWER, events: REFUSED_ANSWER}, 'The journal reads were not refused with SCHEMA_NEWER');
  record.bridgeRefused = true;
  record.health = (await dashboard.evaluate(() => globalThis.desktop.getAppState())).health;
  assert.deepEqual(record.health, {service: 'ready', storage: 'verified', recording: {state: 'disabled'}, lastError: null}, 'Main\'s health is not ready and disabled');
  record.healthConsistent = true;
  record.recordingText = await waitForRecordingText(dashboard, RECORDING_DISABLED_TEXT, 'RECORDING_DISABLED_TEXT_NOT_SHOWN');
  record.recordingDisabledShown = true;
  await dashboard.getByTestId('tab-journal').click({timeout: 5000});
  // listState answers as soon as an error is shown; an empty or filled list must have no row to pass the wait instead.
  const shown = await untilPage(dashboard, listState, {page: 1, count: 0});
  record.journal = {error: shown.error, empty: shown.empty, emptyNote: shown.emptyNote, banner: shown.banner, rows: shown.rows.length, next: shown.next, previous: shown.previous};
  assert.deepEqual(record.journal, {error: SCHEMA_NEWER_JOURNAL_TEXT, empty: null, emptyNote: null, banner: null, rows: 0, next: false, previous: false},
    'The Journal tab does not show the newer-database refusal');
  record.journalRefusalShown = true;
  await dashboard.screenshot({path: path.join(config.output, 'refusal.png')});
}

/**
 * After the orderly exit: the history file keeps its bytes, and no WAL, shared-memory, journal, partial or backup file
 * exists beside it; the service logged the refusal once and neither opened nor closed a database; main's opt-in timeline
 * has exactly one recording status row, `disabled`.
 */
export async function verifyRefusalRun({config, record, mainEvents, serviceEvents}) {
  // Every fact is recorded before the first assertion, so a failed run keeps the file and the log facts together.
  const target = historyFile(config), root = path.dirname(path.dirname(target));
  record.file = {sha256After: await sha256(target), bytesAfter: (await stat(target)).size, header: await header(target),
    dataEntries: (await readdir(path.dirname(target))).sort(), backups: existsSync(path.join(root, 'backups'))};
  record.historyEvents = {
    unavailable: serviceEvents.filter(row => row.event === 'HISTORY_STORAGE_UNAVAILABLE').map(row => row.facts ?? null),
    opened: serviceEvents.filter(row => row.event === 'HISTORY_STORAGE_OPENED').length,
    closed: serviceEvents.filter(row => row.event === 'HISTORY_STORAGE_CLOSED').length,
    targets: serviceEvents.filter(row => row.event === 'RECORDING_TARGET').length,
    historyStep: serviceEvents.filter(row => row.event === 'SHUTDOWN_STEP' && row.facts?.name === 'history-storage').map(row => row.facts.outcome)};
  record.recordingStatusRows = mainEvents.filter(row => row.event === 'RECORDING_STATUS').map(row => row.facts ?? null);
  assert.deepEqual(record.file, {sha256After: record.placed.manifestSha256, bytesAfter: record.placed.bytes,
    header: {magic: 'SQLite format 3', applicationId: APPLICATION_ID, userVersion: 999}, dataEntries: ['telemetry.sqlite'], backups: false},
  'The refused history database changed or gained a file beside it');
  record.fileUnchanged = true;
  assert.deepEqual(record.historyEvents, {unavailable: [{code: 'SCHEMA_NEWER'}], opened: 0, closed: 0, targets: 0, historyStep: ['ok']},
    'The service did not refuse the history database exactly once');
  // Rule 1 comes before the database rules, so the service reports `disabled` from its start: no `opening` or `stopped`.
  assert.deepEqual(record.recordingStatusRows, [{state: 'disabled'}], 'Main reported a recording state other than disabled');
  assert.deepEqual(mainEvents.filter(row => row.event === 'APP_EXIT_REQUESTED').map(row => row.facts?.reason), ['app-quit']);
  assert.deepEqual(serviceEvents.filter(row => row.event === 'SERVICE_REPORT' && row.detail?.type === 'stopped').map(row => row.detail), [{type: 'stopped', clean: true}]);
  assert.ok(![...mainEvents, ...serviceEvents].some(row => FAILURE_EVENTS.test(row.event)), 'A failure event was logged');
  record.shutdownClean = true;
}
