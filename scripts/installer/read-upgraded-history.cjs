'use strict';
// ET-018 PR-1 (REG-013, REG-017): reads the upgraded synthetic history database and its pre-migration backup with the
// installed application's own Electron runtime and better-sqlite3. The installer lifecycle runs it as
// `<installed ETS2TelemetryDesktop.exe> read-upgraded-history.cjs <database> <backups> <output>` with ELECTRON_RUN_AS_NODE=1,
// so a successful read also proves that the installed native SQLite binding loads. Read-only: every connection opens with
// `readonly` and `fileMustExist`. It writes facts only; installer-lifecycle.mjs compares them with hand-written values.
const {createHash} = require('node:crypto');
const {readdirSync, readFileSync, writeFileSync} = require('node:fs');
const path = require('node:path');

const [database, backups, output] = process.argv.slice(2);
const appDirectory = path.dirname(process.execPath);
// The packaged module path the application itself resolves; Electron's ASAR support redirects the unpacked binding.
const Database = require(path.join(appDirectory, 'resources', 'app.asar', 'node_modules', 'better-sqlite3'));
const sha256 = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const counted = ['plugin_sessions', 'clocks', 'events', 'event_gaps', 'job_configurations', 'truck_configurations', 'trailer_configurations', 'event_amounts',
  'trips', 'trip_trailers', 'event_attributions', 'completeness_intervals', 'samples'];

function read(file, work) {
  const db = new Database(file, {readonly: true, fileMustExist: true});
  try {return work(db);} finally {db.close();}
}
function common(db) {
  return {
    userVersion: db.pragma('user_version', {simple: true}),
    applicationId: db.pragma('application_id', {simple: true}),
    integrity: db.pragma('integrity_check').map(row => row.integrity_check),
    foreignKeyViolations: db.pragma('foreign_key_check').length,
    info: db.prepare('SELECT database_uuid, purpose, accepted_origin, created_utc_ms, created_app_version FROM database_info').all(),
    counts: Object.fromEntries(counted.map(table => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]))
  };
}

const facts = {
  runtime: {electron: process.versions.electron, node: process.versions.node, execPath: process.execPath},
  database: read(database, db => ({
    ...common(db),
    migrations: db.prepare('SELECT version, name, app_version, backup_file_name, backup_sha256 FROM schema_migrations ORDER BY version').all(),
    sessions: db.prepare('SELECT plugin_session_uuid, game, origin, committed_through_event_seq FROM plugin_sessions ORDER BY id').all(),
    events: db.prepare('SELECT id, event_seq, type FROM events ORDER BY id').all(),
    trips: db.prepare(`SELECT id, trip_uuid, outcome, recording_completeness, opened_event_ref, opened_by, observed_distance_m, fuel_used_l, fuel_used_l_state,
      closed_by_session_ref, closed_by_event_seq FROM trips ORDER BY id`).all(),
    jobSources: db.prepare('SELECT id, plugin_session_ref, source, event_ref FROM job_configurations ORDER BY id').all()
  })),
  backups: readdirSync(backups).sort(),
  manifests: []
};
for (const name of facts.backups.filter(entry => entry.endsWith('.json'))) {
  const manifest = JSON.parse(readFileSync(path.join(backups, name), 'utf8'));
  // Only a plain file name in the same folder is read; anything else is reported, never followed.
  if (typeof manifest.fileName !== 'string' || !/^[A-Za-z0-9.-]{1,128}\.sqlite$/.test(manifest.fileName)) {facts.manifests.push({name, manifest, error: 'FILE_NAME_INVALID'}); continue;}
  const file = path.join(backups, manifest.fileName);
  facts.manifests.push({name, manifest, file: {sha256: sha256(file), size: readFileSync(file).length}, content: read(file, common)});
}
// The native SQLite binding the runtime loaded (better-sqlite3 loads it on the first open), relative to the application directory.
facts.runtime.nativeBindings = Object.keys(require.cache).filter(name => name.toLowerCase().endsWith('.node')).map(name => path.relative(appDirectory, name));
writeFileSync(output, JSON.stringify(facts, null, 2) + '\n');
