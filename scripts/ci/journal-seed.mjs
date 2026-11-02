// ET-016 PR-4: seeds the journal runtime smoke's synthetic database through the real storage code. journal-observation.mjs
// bundles this file with Vite (it imports the TypeScript storage core and the shared journal seed) into the run's output
// directory and runs the bundle under the checkout's Electron in Node mode (ELECTRON_RUN_AS_NODE=1), so better-sqlite3
// loads with the same runtime and ABI as the telemetry service. The working directory must be the checkout, because the
// shared message scripts read the protocol v1 fixtures from there.
//
// It writes only `<LOCALAPPDATA>\<data root>\synthetic\journal.sqlite`, a synthetic-purpose database that does not
// exist yet, in the LOCALAPPDATA the driver isolated for this run; the data root is `ETS2Telemetry` or, for a staging
// build (ET-055), `ETS2TelemetryStaging`. It refuses any other path. The history database is
// never opened. Contents: the eight hand-written anchors and 110 filler trips of tests/shared/journal-seed.ts, then one
// open ETS2 paging trip with 104 tolls, 104 annotations and 3,600 one-second samples, so the timeline, completeness and
// sample tables each have more than one page. Prints one JSON line with the counts and the elapsed time.
// Usage: electron <bundle> <database path>
import {existsSync} from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {BUILD_CHANNELS, BUILD_IDENTITIES} from '../build-channel.mjs';
import {openStorage} from '../../packages/storage/src/index';
import {EUR, seedJournalAnchors, seedJournalFillers, seedSample} from '../../tests/shared/journal-seed';
import {BASE_UTC, job, money, r, Script} from '../../tests/shared/trip-messages';

/** The paging trip's plugin session and trip; neither is used by the shared seed. */
const PAGING_SESSION = '10000000-0000-4000-8000-0000000000f6';
const PAGING_TRIP = '7b000000-0000-4000-8000-000000000001';
const PAGING_UTC = BASE_UTC + 3_000_000;
const PAGING_TOLLS = 104, PAGING_SAMPLES = 3_600, FILLERS = 110;

// The bundle is CommonJS, which has no top-level await.
async function main() {
  const started = performance.now();
  const [database, variant] = process.argv.slice(2);
  if (variant !== undefined && variant !== '--ui-signed') throw new Error('JOURNAL_SEED_VARIANT_INVALID');
  const localAppData = process.env.LOCALAPPDATA;
  if (!database || !localAppData) { console.error('Usage: journal-seed <database path> (with LOCALAPPDATA set)'); process.exit(2); }
  const expected = BUILD_CHANNELS.map(channel => path.join(localAppData, BUILD_IDENTITIES[channel].dataRootName, 'synthetic', 'journal.sqlite').toLowerCase());
  if (!expected.includes(path.resolve(database).toLowerCase()) || existsSync(database)) {
    console.error('JOURNAL_SEED_REFUSED: only a new synthetic journal.sqlite in the isolated LOCALAPPDATA is seeded');
    process.exit(2);
  }

  const check = (result, what) => {
    if (!result.ok) throw new Error(`JOURNAL_SEED_FAILED ${what}: ${result.error.code}`);
    return result.value;
  };
  const opened = await openStorage({path: database, purpose: 'synthetic', backupsDirectory: path.join(path.dirname(database), 'backups'), appVersion: '0.1.0'});
  const storage = check(opened, 'open');
  try {
    await seedJournalAnchors(storage);
    const fillers = await seedJournalFillers({
      upsertSession: input => storage.upsertSession(input), appendSamples: (...args) => storage.appendSamples(...args),
      commitEvent: input => storage.commitEvent({...input, effects: input.effects?.map(effect => effect.kind === 'trip.open' && effect.tripUuid.endsWith('00000000006d')
        ? {...effect, gameMode: {mode: 'single-player', method: 'module-scan', confidence: 'weak'}} : effect)})
    }, FILLERS);
    // The paging trip: opened by its job, then each toll is attributed to it and adds one truck-change annotation.
    const script = new Script(PAGING_SESSION, 'ets2', {utcMs: PAGING_UTC});
    check(storage.upsertSession({message: script.welcome()}), 'paging session');
    const configured = script.event(r.jobConfigured(job({cargoId: {available: true, value: 'synthetic_paging_cargo'}})));
    check(storage.commitEvent({message: configured, effects: [{kind: 'trip.open', tripUuid: PAGING_TRIP, game: 'ets2', gameMode: {mode: 'truckersmp', method: 'module-scan', confidence: 'strong'},
      jobConfiguration: 'this-event', recordingCompleteness: 'unknown', startedUtcMs: PAGING_UTC + 1_000}, {kind: 'trip.update', tripUuid: PAGING_TRIP, set: {gameModeAmbiguous: true}}]}), 'paging job');
    for (let i = 0; i < PAGING_TOLLS; i++) {
      const toll = script.event({type: 'player.tollgate.paid', amount: money('1', 's64', EUR)});
      const atEventSeq = toll.data.eventSeq;
      check(storage.commitEvent({message: toll, effects: [{kind: 'event.attribute', tripUuid: PAGING_TRIP, attribution: 'trip'},
        {kind: 'completeness.add', interval: {tripUuid: PAGING_TRIP, kind: 'discontinuity', detail: {cause: 'truck-change', annotation: true, atEventSeq}}}]}), `paging toll ${atEventSeq}`);
    }
    check(storage.appendSamples(PAGING_SESSION, Array.from({length: PAGING_SAMPLES}, (_, second) =>
      seedSample(script, PAGING_TRIP, second, PAGING_UTC + 200_000 + second * 1_000, {speed: {available: true, value: variant === '--ui-signed' ? [-20, 0, 20][second % 3] : 20 + (second % 5)}}))), 'paging samples');
    process.stdout.write(JSON.stringify({trips: 8 + fillers.length + 1, fillers: fillers.length, pagingTolls: PAGING_TOLLS, pagingSamples: PAGING_SAMPLES,
      elapsedMs: Math.round(performance.now() - started)}) + '\n');
  } finally {
    check(storage.close(), 'close');
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'JOURNAL_SEED_FAILED'); process.exitCode = 1; });
