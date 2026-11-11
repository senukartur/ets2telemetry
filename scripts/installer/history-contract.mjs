import assert from 'node:assert/strict';

// The upgraded database, written by hand from the frozen version-1 fixture and migrations 0002-journal through 0009-membership-decisions
// (docs/storage.md); `backup` is filled from the one manifest the migration wrote, and `appVersion` is the version the
// migrating application reports: `0.1.0` in production, `0.1.0-stg.000000` in staging (ET-055 PR-5). The fixture's own
// rows (its creation and migration 0001) keep the `0.1.0` they were written with.
// Historical migration creates one retired singleton, without learning any live identity or progress.
function expectedSingleton() {
  const uuid = '70000000-0000-4000-8000-000000000001';
  const integer = value => ({$integer: String(value)});
  return {
    logicalTrips: [{id: 1, trip_uuid: uuid, latest_trip_ref: 1, game: 'ets2', profile_scope: null, fingerprint: null, canonical_constraints: '{}',
      retired: 1, hard_mode_lost: 1, progress_head: null, accounting_rebased: 0, reconciliation_unknown: 0, member_count: 1, mode_ambiguous: 0,
      first_loss_json: null, interrupted: 0}],
    memberships: [{trip_ref: 1, logical_ref: 1, previous_logical_ref: null, joined_after_revision: null, decision_key: 'migration-v4:' + uuid, observation_key: null, proof_json: null}],
    revisions: [{id: 1, logical_ref: 1, state_ref: 1, member_through: 1, event_through: 5, gap_through: 1, sample_through: 3, interval_through: 1, progress_head: null}],
    states: [{id: 1, summary: {id: integer(1), trip_uuid: uuid, plugin_session_ref: integer(1), game: 'ets2', game_mode: 'single-player', game_mode_method: 'module-scan',
      game_mode_confidence: 'weak', game_mode_ambiguous: integer(0), job_configuration_ref: integer(1), truck_configuration_ref: integer(1),
      opened_event_ref: integer(1), opened_by: 'event', outcome: 'cancelled', outcome_event_ref: integer(4), close_reason: 'outcome', recording_completeness: 'partial',
      started_utc_ms: integer(1791676800000), ended_utc_ms: integer(1791677100000), observed_distance_m: 1500.5, observed_distance_m_state: 'available',
      created_utc_ms: integer(1791676801000), updated_utc_ms: integer(1791676806000), fuel_used_l: null, fuel_used_l_state: 'not-observed',
      closed_by_session_ref: null, closed_by_event_seq: null, is_hard_mode: integer(0), hard_mode_details: null,
      _moneyIncomplete: false, _currentProgress: true, _rawDistance: true, _rawFuel: false}}]
  };
}

export function expectedDatabase(backup, appVersion) {
  const counts = {plugin_sessions: 1, clocks: 2, events: 5, event_gaps: 1, job_configurations: 1, truck_configurations: 1, trailer_configurations: 1,
    event_amounts: 1, trips: 1, trip_trailers: 1, event_attributions: 4, completeness_intervals: 1, samples: 3};
  return {
    userVersion: 9, applicationId: 1163154226, integrity: ['ok'], foreignKeyViolations: 0,
    info: [{database_uuid: 'f0000000-0000-4000-8000-000000000001', purpose: 'synthetic', accepted_origin: 'synthetic', created_utc_ms: 1791676800000, created_app_version: '0.1.0'}],
    counts: {...counts, observation_closes: 0, logical_trips: 1, logical_memberships: 1, logical_trucks: 0, logical_progress: 0, logical_projection_states: 1, logical_revisions: 1},
    migrations: [{version: 1, name: '0001-initial', app_version: '0.1.0', backup_file_name: null, backup_sha256: null},
      {version: 2, name: '0002-journal', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 3, name: '0003-hard-mode', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 4, name: '0004-logical-trips', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 5, name: '0005-upload-projections', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 6, name: '0006-upload-ownership-queue', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 7, name: '0007-trailer-baselines', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 8, name: '0008-haulmp-mode', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256},
      {version: 9, name: '0009-membership-decisions', app_version: appVersion, backup_file_name: backup.fileName, backup_sha256: backup.fileSha256}],
    sessions: [{plugin_session_uuid: '10000000-0000-4000-8000-000000000001', game: 'ets2', origin: 'synthetic', committed_through_event_seq: '00000000000000000006'}],
    events: [{id: 1, event_seq: '00000000000000000001', type: 'job.configured'}, {id: 2, event_seq: '00000000000000000002', type: 'truck.configured'},
      {id: 3, event_seq: '00000000000000000003', type: 'trailer.configured'}, {id: 4, event_seq: '00000000000000000006', type: 'job.cancelled'},
      {id: 5, event_seq: '00009007199254740993', type: 'job.cleared'}],
    trips: [{id: 1, trip_uuid: '70000000-0000-4000-8000-000000000001', outcome: 'cancelled', recording_completeness: 'partial', opened_event_ref: 1, opened_by: 'event',
      observed_distance_m: 1500.5, fuel_used_l: null, fuel_used_l_state: 'not-observed', closed_by_session_ref: null, closed_by_event_seq: null}],
    ...expectedSingleton(),
    jobSources: [{id: 1, plugin_session_ref: 1, source: 'event', event_ref: 1}]
  };
}
/** The pre-migration backup: the version 1 content, unchanged row counts and a manifest that matches its file. */
export const EXPECTED_BACKUP_COUNTS = {plugin_sessions: 1, clocks: 2, events: 5, event_gaps: 1, job_configurations: 1, truck_configurations: 1, trailer_configurations: 1,
  event_amounts: 1, trips: 1, trip_trailers: 1, event_attributions: 4, completeness_intervals: 1, samples: 3};
const BACKUP_NAME = /^telemetry-f0000000-v1-\d{8}T\d{9}Z\.sqlite$/;


export function assertHistoryFacts(facts, appVersion) {
  // Exactly one verified pre-migration backup with its manifest, written last.
  assert.equal(facts.manifests.length, 1, 'BACKUP_MANIFEST_COUNT');
  const [{manifest, file, content}] = facts.manifests;
  assert.match(manifest.fileName, BACKUP_NAME, 'BACKUP_NAME_UNEXPECTED');
  assert.deepEqual(facts.backups, [manifest.fileName.replace(/\.sqlite$/, '.json'), manifest.fileName].sort(), 'BACKUP_FILES_UNEXPECTED');
  assert.deepEqual({format: manifest.format, databaseUuid: manifest.databaseUuid, fromVersion: manifest.fromVersion, reason: manifest.reason, appVersion: manifest.appVersion},
    {format: 'ets2telemetry-backup-1', databaseUuid: 'f0000000-0000-4000-8000-000000000001', fromVersion: 1, reason: 'pre-migration', appVersion}, 'BACKUP_MANIFEST_UNEXPECTED');
  assert.deepEqual({sha256: file.sha256, size: file.size}, {sha256: manifest.fileSha256, size: manifest.size}, 'BACKUP_FILE_DIFFERS');
  assert.deepEqual(content, {userVersion: 1, applicationId: 1163154226, integrity: ['ok'], foreignKeyViolations: 0,
    info: expectedDatabase(manifest, appVersion).info, counts: EXPECTED_BACKUP_COUNTS}, 'BACKUP_CONTENT_UNEXPECTED');
  assert.deepEqual(Object.fromEntries(Object.entries(manifest.rowCounts).filter(([table]) => table in EXPECTED_BACKUP_COUNTS)), EXPECTED_BACKUP_COUNTS, 'BACKUP_ROW_COUNTS_UNEXPECTED');
  // The upgraded database itself.
  assert.deepEqual(facts.database, expectedDatabase(manifest, appVersion), 'HISTORY_CONTENT_UNEXPECTED');
}
