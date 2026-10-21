import path from 'node:path';
import {mkdir, writeFile} from 'node:fs/promises';
import {HardModeReader} from '../../apps/desktop/src/hard-mode/reader';
import {Worker} from 'node:worker_threads';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {StorageClient, workerHandle} from '../../packages/storage/src/client';
import {HardModeMonitor} from '../../apps/desktop/src/hard-mode/monitor';
import {TripRecorderSink} from '../../apps/desktop/src/trip-recorder';
import type {HardModeObservation} from '../../packages/contracts/src/hard-mode';
import {DurableDelivery} from '../../apps/desktop/src/v1-durable-delivery';
import {decodePayload, type ClientMessage} from '../../packages/contracts/src/protocol-v1';
import type {EventRecord} from '../../packages/contracts/src/protocol-v1';
import type {TripEffect} from '../../packages/storage/src/api';
import {evaluateHardMode, parseHardModeConfig, unknownHardMode} from '../../packages/telemetry-core/src/hard-mode';
import {HARD_MODE_CONFIG} from '../shared/hard-mode';
import {Script, ETS2_A, r} from '../shared/trip-messages';
import {ok, failed, TEST_CLOSE_GRACE_MS, workspace} from './helpers';
let ws: Awaited<ReturnType<typeof workspace>>, worker: Worker | undefined;
beforeEach(async () => {ws = await workspace();});
afterEach(async () => {await worker?.terminate(); await ws.dispose();});
const evidence = (config = HARD_MODE_CONFIG): HardModeObservation => ({assessment: evaluateHardMode(parseHardModeConfig(config), Date.now(), 'fixture'), binding: 'a'.repeat(64), pluginSessionId: ETS2_A, sourceMonotonicNs: '1'});
const id = '70000000-0000-4000-8000-000000000001';
const opening: TripEffect = {kind: 'trip.open', tripUuid: id, game: 'ets2', gameMode: {mode: 'unknown', method: 'none', confidence: 'none'}, jobConfiguration: 'this-event', recordingCompleteness: 'complete', startedUtcMs: Date.now()};
function delivery(): EventRecord {const d = r.delivered(); if (d.type !== 'job.delivered') throw new Error('fixture'); return {...d, autoParkUsed: {available: true, value: false}};}
function sinkOk<T>(result: {ok: true; value: T} | {ok: false; error: {code: string}}): T {if (!result.ok) throw new Error(result.error.code); return result.value;}
describe('ET-026 integrity (REG-005/006/007)', () => {
  it('rolls back failed audit/event/coverage changes together, then commits the originally captured failing evidence', async () => {
    const storage = await ws.open({now: Date.now}), script = new Script(ETS2_A); ok(storage.upsertSession({message: script.welcome()}));
    ok(storage.commitEvent({message: script.event(r.jobConfigured()), hardMode: evidence(), hardModeFresh: true, effects: [opening]}));
    const before = ok(storage.getTrip(id)), captured = evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
    const message = script.event(delivery()), effects: TripEffect[] = [{kind: 'trip.close', tripUuid: id, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: Date.now()}];
    failed(storage.commitEvent({message, hardMode: captured, effects}, {testHooks: {beforeCommit: () => {throw Object.assign(new Error('injected disk failure'), {code: 'SQLITE_IOERR'});}}}), 'IO_ERROR');
    expect(ok(storage.committedThrough(ETS2_A))).toBe('1'); expect(ok(storage.getTrip(id))).toEqual(before);
    ok(storage.commitEvent({message, hardMode: captured, effects}));
    expect(ok(storage.getTrip(id))).toMatchObject({outcome: 'delivered', isHardMode: false, hardModeDetails: {firstLoss: {rule: 'fatigue', values: [0]}}});
  });
  it('holds delivery and every ACK behind a pending loss write in the production delivery FIFO', async () => {
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    worker = new Worker(path.join(directory, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    const recorder = new TripRecorderSink(client, {hardModeEvidence: evidence}), pipeline = new DurableDelivery(recorder), acks: string[] = [], failures: string[] = [];
    try {
      ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      const script = new Script(ETS2_A), connection = pipeline.connect(script.welcome(), {current: () => true,
        write: bytes => {const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage; if (m.kind === 'ack') acks.push(m.data.throughEventSeq);}, close: (_kind, code) => failures.push(code)});
      connection.checkpoint(script.checkpoint(null), Date.now());
      const first = script.event(r.jobConfigured()); connection.enqueue({firstEventSeq: first.data.eventSeq, lastEventSeq: first.data.eventSeq}, first, Date.now()); await pipeline.idle();
      expect(acks.at(-1)).toBe('1'); const trip = ok(await client.listTrips()).trips[0];
      const original = client.observeHardMode.bind(client); let release!: () => void;
      client.observeHardMode = (game, observation, fresh) => new Promise(resolve => {release = () => {void original(game, observation, fresh).then(resolve);};});
      recorder.observeHardMode('ets2', evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"')));
      const last = script.event(delivery()); connection.enqueue({firstEventSeq: last.data.eventSeq, lastEventSeq: last.data.eventSeq}, last, Date.now());
      // The worker can answer another read, so this is an observable pending barrier, not a timing sleep.
      expect(ok(await client.committedThrough(ETS2_A))).toBe('1'); expect(ok(await client.getTrip(trip.tripUuid))!.outcome).toBe('open'); expect(acks.at(-1)).toBe('1');
      release(); await pipeline.idle(); expect(acks.at(-1)).toBe('2'); expect(failures).toEqual([]);
      expect(ok(await client.getTrip(trip.tripUuid))).toMatchObject({outcome: 'delivered', isHardMode: false, hardModeDetails: {firstLoss: {rule: 'fatigue', values: [0]}}});
    } finally {await pipeline.stop(); expect(await client.close()).toEqual({clean: true});}
  });
  it.each(['queued', 'delayed-first-arrival'] as const)('refuses retrospective proof for a %s opening after a delayed scan', async mode => {
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    worker = new Worker(path.join(directory, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    let finish!: (value: HardModeObservation) => void;
    const monitor = new HardModeMonitor(() => new Promise(resolve => {finish = resolve;}));
    const recorder = new TripRecorderSink(client, {hardModeEvidence: () => monitor.evidence()}), pipeline = new DurableDelivery(recorder), acks: string[] = [];
    try {
      ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      const script = new Script(ETS2_A), welcome = script.welcome(), first = script.event(r.jobConfigured());
      const upsert = client.upsertSession.bind(client); let release!: () => void, sessionEntered!: () => void;
      const sessionHeld = new Promise<void>(resolve => {sessionEntered = resolve;});
      if (mode === 'queued') client.upsertSession = input => new Promise(resolve => {release = () => {void upsert(input).then(resolve);}; sessionEntered();});
      monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: welcome.capture.monotonicNs});
      const connection = pipeline.connect(welcome, {current: () => true, write: bytes => {const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage; if (m.kind === 'ack') acks.push(m.data.throughEventSeq);}, close: () => undefined});
      connection.checkpoint(script.checkpoint(null, 1), Date.now());
      if (mode === 'queued') connection.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, first, Date.now());
      else await pipeline.idle();
      // Bytes first become available now, after the opening occurred; no UI or recorder proof before the causal reply.
      finish(evidence()); await Promise.resolve(); expect(monitor.status().assessment.state).toBe('unknown');
      monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: welcome.capture.monotonicNs,
        boundary: {clockId: script.clockId, probeSentClientNs: process.hrtime.bigint().toString(), receivedSourceNs: first.capture.monotonicNs}});
      await monitor.refresh(); expect(monitor.status().assessment.state).toBe('pass');
      if (mode === 'queued') {expect(acks).toEqual([]); await sessionHeld; release();}
      else connection.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, first, Date.now());
      await pipeline.idle(); expect(acks).toEqual(['1']);
      const last = script.event(delivery()); connection.enqueue({firstEventSeq: '2', lastEventSeq: '2'}, last, Date.now()); await pipeline.idle();
      const trip = ok(await client.listTrips()).trips[0];
      expect(ok(await client.getTrip(trip.tripUuid))).toMatchObject({isHardMode: false, outcome: 'delivered', hardModeDetails: {firstLoss: {reason: 'historical'}}});
    } finally {monitor.close(); await pipeline.stop(); expect(await client.close()).toEqual({clean: true});}
  });
  it.each(['loss', 'loss-retry', 'observation-write-failure'] as const)('latches loss during a held opening coverage read: %s', async mode => {
    const retry = mode === 'loss-retry';
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    worker = new Worker(path.join(directory, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    let current = evidence(); const recorder = new TripRecorderSink(client, {hardModeEvidence: () => current}), pipeline = new DurableDelivery(recorder), acks: string[] = [];
    const link = {current: () => true, write: (bytes: Uint8Array) => {const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage; if (m.kind === 'ack') acks.push(m.data.throughEventSeq);}, close: () => undefined};
    try {
      ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      const script = new Script(ETS2_A); let connection = pipeline.connect(script.welcome(), link); connection.checkpoint(script.checkpoint(null), Date.now()); await pipeline.idle();
      const through = client.committedThrough.bind(client); let release!: () => void, entered!: () => void;
      const held = new Promise<void>(resolve => {entered = resolve;});
      client.committedThrough = session => {client.committedThrough = through; return new Promise(resolve => {release = () => {void through(session).then(resolve);}; entered();});};
      const first = script.event(r.jobConfigured()); connection.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, first, Date.now()); await held;
      const observe = client.observeHardMode.bind(client); let stored!: () => void; const lossStored = new Promise<void>(resolve => {stored = resolve;});
      let observationFailed = false;
      client.observeHardMode = async (game, observation, fresh) => {
        if (mode === 'observation-write-failure' && !observationFailed) {observationFailed = true; stored(); return {ok: false, error: {code: 'IO_ERROR', retryable: true, message: 'Injected'}};}
        const result = await observe(game, observation, fresh); stored(); return result;
      };
      recorder.observeHardMode('ets2', mode === 'observation-write-failure' ? evidence() : evidence(HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'))); await lossStored; await Promise.resolve();
      expect(ok(await client.listTrips()).trips).toEqual([]); expect(ok(await through(ETS2_A))).toBe('0'); expect(acks).toEqual([]);
      current = evidence(); recorder.observeHardMode('ets2', current);
      if (retry) {const commit = client.commitEvent.bind(client); client.commitEvent = () => {client.commitEvent = commit; return Promise.resolve({ok: false, error: {code: 'IO_ERROR', retryable: true, message: 'Injected'}});};}
      release(); await pipeline.idle();
      if (retry) {
        expect(acks).toEqual([]); expect(ok(await through(ETS2_A))).toBe('0');
        connection = pipeline.connect(script.welcome(), link); connection.checkpoint(script.checkpoint(null, 1), Date.now());
        connection.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, script.redeliver(first), Date.now()); await pipeline.idle();
      }
      expect(acks).toEqual(['1']); expect(ok(await through(ETS2_A))).toBe('1');
      const trip = ok(await client.listTrips()).trips[0];
      const expectedLoss = mode === 'observation-write-failure' ? {reason: 'interrupted', values: [null]} : {rule: 'fatigue', values: [0]};
      expect(ok(await client.getTrip(trip.tripUuid))).toMatchObject({hardModeDetails: {firstLoss: expectedLoss}});
      if (!retry) expect(ok(await client.getTrip(trip.tripUuid))!.hardModeDetails!.opening.state).toBe('pass');
      const last = script.event(delivery()); connection.enqueue({firstEventSeq: '2', lastEventSeq: '2'}, last, Date.now()); await pipeline.idle();
      expect(acks).toEqual(['1', '2']); expect(ok(await client.getTrip(trip.tripUuid))).toMatchObject({isHardMode: false, outcome: 'delivered', hardModeDetails: {firstLoss: expectedLoss}});
    } finally {await pipeline.stop(); expect(await client.close()).toEqual({clean: true});}
  });
  it('continues monitoring through UTC rollback with snapshots but no coverage events, retaining a restored fatigue loss', async () => {
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    worker = new Worker(path.join(directory, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    let utc = Date.now(), mono = 0n, config = HARD_MODE_CONFIG;
    const utcClock = vi.spyOn(Date, 'now').mockImplementation(() => utc);
    let recorder!: TripRecorderSink, observing = false;
    // Establish the known passing baseline before attaching recording observations; all later observations are persisted.
    const monitor = new HardModeMonitor(() => Promise.resolve(evidence(config)), value => {if (observing) recorder.observeHardMode('ets2', value);}, () => mono);
    recorder = new TripRecorderSink(client, {hardModeEvidence: () => monitor.evidence()});
    const pipeline = new DurableDelivery(recorder);
    try {
      ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      const script = new Script(ETS2_A), welcome = script.welcome();
      const connection = pipeline.connect(welcome, {current: () => true, write: () => undefined, close: () => undefined});
      connection.checkpoint(script.checkpoint(null), Date.now()); await pipeline.idle();
      const observe = async (ns: string) => {
        monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: ns}); const pending = monitor.refresh(); await Promise.resolve();
        mono++; monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: ns, boundary: {clockId: script.clockId, probeSentClientNs: mono.toString(), receivedSourceNs: ns}}); await pending;
      };
      await observe(welcome.capture.monotonicNs); observing = true;
      const first = script.event(r.jobConfigured()); connection.enqueue({firstEventSeq: '1', lastEventSeq: '1'}, first, Date.now()); await pipeline.idle();
      const trip = ok(await client.listTrips()).trips[0]; expect(ok(await client.getTrip(trip.tripUuid))!.hardModeDetails!.firstLoss).toBeNull();
      const original = client.observeHardMode.bind(client); let failedStored!: () => void;
      const failureStored = new Promise<void>(resolve => {failedStored = resolve;});
      client.observeHardMode = async (game, observation, fresh) => {const result = await original(game, observation, fresh); if (observation.assessment.state === 'fail') failedStored(); return result;};
      utc -= 120_000; mono += 1_000_000_000n; config = HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"');
      const low = script.snapshot(); connection.snapshot(low, Date.now()); await observe(low.capture.monotonicNs); await failureStored;
      expect(monitor.status().assessment.state).toBe('fail'); expect(ok(await client.committedThrough(ETS2_A))).toBe('1');
      expect(ok(await client.getTrip(trip.tripUuid))!.hardModeDetails!.firstLoss).toMatchObject({rule: 'fatigue', values: [0]});
      config = HARD_MODE_CONFIG; mono += 1_000_000_000n; const restored = script.snapshot(); connection.snapshot(restored, Date.now()); await observe(restored.capture.monotonicNs);
      expect(monitor.status().assessment.state).toBe('pass'); utc += 120_000;
      const last = script.event(delivery()); connection.enqueue({firstEventSeq: '2', lastEventSeq: '2'}, last, Date.now()); await pipeline.idle();
      expect(ok(await client.getTrip(trip.tripUuid))).toMatchObject({outcome: 'delivered', isHardMode: false, hardModeDetails: {firstLoss: {rule: 'fatigue', values: [0]}}});
    } finally {utcClock.mockRestore(); monitor.close(); await pipeline.stop(); expect(await client.close()).toEqual({clean: true});}
  });
  it.each(['delay', 'utc-forward', 'utc-back', 'expired-intake', 'pending-unknown', 'pending-failure', 'process-probe'] as const)('freezes monotonic intake freshness across held opening/delivery: %s', async mode => {
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    // Only this isolated real worker's UTC label is controlled; no clock is added to the production command surface.
    const clock = new BigInt64Array(new SharedArrayBuffer(8)); Atomics.store(clock, 0, BigInt(Date.now()));
    worker = new Worker(`const {workerData}=require('node:worker_threads'); const clock=new BigInt64Array(workerData.clock);
      Date.now=()=>Number(Atomics.load(clock,0)); require(workerData.entry);`, {eval: true, workerData: {kind: 'storage', clock: clock.buffer, entry: path.join(directory, 'storage-worker.cjs')}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    const utc = vi.spyOn(Date, 'now').mockImplementation(() => Number(Atomics.load(clock, 0)));
    const game = path.join(ws.directory, 'Documents', 'Euro Truck Simulator 2'), profile = path.join(game, 'profiles', '53796E746865746963');
    await mkdir(profile, {recursive: true});
    await writeFile(path.join(game, 'game.log.txt'), "************ : log created on : Tuesday October 20 2026 @ 12:00:00\nNew profile selected: 'Synthetic'\nLoading save. Type: 0, path: /home/profiles/53796E746865746963/save/autosave/game.sii\n");
    await writeFile(path.join(game, 'config.cfg'), 'uset g_traffic "1"'); await writeFile(path.join(profile, 'config_local.cfg'), 'uset g_brake_intensity "0.75"');
    await writeFile(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG);
    let mono = 0n, probeFailed = false, observe = false, readFinished: (() => void) | undefined;
    const reader = new HardModeReader({documents: path.join(ws.directory, 'Documents'), fixtureOrigin: 'synthetic', process: source => Promise.resolve(probeFailed ? null : {
      pid: source.processId, createdUtcMs: new Date(2026, 9, 20, 12, 0, 0).getTime(), executable: 'C:/Synthetic/eurotrucks2.exe', commandLine: 'synthetic'})});
    let recorder!: TripRecorderSink;
    const monitor = new HardModeMonitor(async (...args) => {try {return await reader.read(...args);} finally {readFinished?.();}}, value => {if (observe) recorder.observeHardMode('ets2', value);}, () => mono);
    recorder = new TripRecorderSink(client, {hardModeEvidence: () => monitor.evidence()});
    const pipeline = new DurableDelivery(recorder), acks: string[] = [], failures: string[] = [];
    const script = new Script(ETS2_A), welcome = script.welcome();
    const scan = async () => {
      const snapshot = script.snapshot(); monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: snapshot.capture.monotonicNs});
      const readDone = new Promise<void>(resolve => {readFinished = resolve;}); const pending = monitor.refresh(); await readDone; await Promise.resolve();
      mono++; monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: snapshot.capture.monotonicNs,
        boundary: {clockId: script.clockId, probeSentClientNs: mono.toString(), receivedSourceNs: snapshot.capture.monotonicNs}}); await pending;
      return snapshot;
    };
    try {
      ok(await client.open({path: ws.database, purpose: 'synthetic', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      // The first scan is auto-started by selection, so install the read barrier before selecting.
      const initialDone = new Promise<void>(resolve => {readFinished = resolve;});
      monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: welcome.capture.monotonicNs}); const initial = monitor.refresh(); await initialDone; await Promise.resolve();
      mono++; monitor.select({source: welcome.source, clockId: script.clockId, monotonicNs: welcome.capture.monotonicNs,
        boundary: {clockId: script.clockId, probeSentClientNs: mono.toString(), receivedSourceNs: welcome.capture.monotonicNs}}); await initial; observe = true;
      const connection = pipeline.connect(welcome, {current: () => true, write: bytes => {const m = decodePayload(bytes.subarray(4), 'client') as ClientMessage; if (m.kind === 'ack') acks.push(m.data.throughEventSeq);}, close: (_kind, code) => failures.push(code)});
      connection.checkpoint(script.checkpoint(null), Date.now()); await pipeline.idle();
      const through = client.committedThrough.bind(client);
      for (const seq of ['1', '2']) {
        if (mode === 'expired-intake' && seq === '1') mono += 3_000_000_001n;
        let release!: () => void, entered!: () => void; const held = new Promise<void>(resolve => {entered = resolve;});
        client.committedThrough = session => {client.committedThrough = through; return new Promise(resolve => {release = () => {void through(session).then(resolve);}; entered();});};
        const event = script.event(seq === '1' ? r.jobConfigured() : delivery());
        connection.enqueue({firstEventSeq: seq, lastEventSeq: seq}, event, Date.now()); await held;
        if (mode === 'utc-forward') Atomics.add(clock, 0, 120_000n); if (mode === 'utc-back') Atomics.sub(clock, 0, 120_000n);
        for (let tick = 0; tick < 5; tick++) {
          mono += 1_000_000_000n; Atomics.add(clock, 0, 1000n);
          if (seq === '1' && tick === 1) {
            if (mode === 'pending-failure') await writeFile(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG.replace('g_fatigue "1"', 'g_fatigue "0"'));
            if (mode === 'process-probe') probeFailed = true;
            if (mode === 'pending-unknown') recorder.observeHardMode('ets2', {...evidence(), assessment: unknownHardMode(Date.now(), 'interrupted')});
          }
          const snapshot = await scan(); connection.snapshot(snapshot, Date.now());
          if (seq === '1' && tick === 1) {probeFailed = false; await writeFile(path.join(profile, 'config.cfg'), HARD_MODE_CONFIG);}
        }
        expect(monitor.status().assessment.state).toBe('pass'); expect(ok(await through(ETS2_A))).toBe(seq === '1' ? '0' : '1'); expect(acks).toEqual(seq === '1' ? [] : ['1']);
        release(); await pipeline.idle(); expect(failures).toEqual([]); expect(acks.at(-1)).toBe(seq);
      }
      const trip = ok(await client.listTrips()).trips[0], details = ok(await client.getTrip(trip.tripUuid))!;
      const qualified = ['delay', 'utc-forward', 'utc-back'].includes(mode);
      expect(details).toMatchObject({outcome: 'delivered', isHardMode: qualified});
      if (qualified) expect(details.hardModeDetails!.firstLoss).toBeNull();
      else {expect(details.hardModeDetails!.firstLoss).not.toBeNull(); if (mode === 'pending-failure') expect(details.hardModeDetails!.firstLoss).toMatchObject({rule: 'fatigue', values: [0]});}
      expect(acks).toEqual(['1', '2']);
    } finally {monitor.close(); await pipeline.stop(); utc.mockRestore(); expect(await client.close()).toEqual({clean: true});}
  });
  it('qualifies deterministic injected replay-origin observations through the real recorder/worker in a replay database', async () => {
    const directory = process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES; if (!directory) throw new Error('Run storage suite');
    worker = new Worker(path.join(directory, 'storage-worker.cjs'), {workerData: {kind: 'storage'}});
    const client = new StorageClient(workerHandle(worker), {closeGraceMs: TEST_CLOSE_GRACE_MS});
    try {
      ok(await client.open({path: path.join(ws.directory, 'replay.sqlite'), purpose: 'replay', backupsDirectory: ws.backups, appVersion: 'test-et026'}));
      const script = new Script(ETS2_A), recorder = new TripRecorderSink(client, {hardModeEvidence: evidence});
      const welcome = script.welcome(); welcome.source.origin = 'replay'; sinkOk(await recorder.openSession(welcome));
      for (const record of [r.jobConfigured(), delivery()]) {const message = script.event(record); message.source.origin = 'replay'; sinkOk(await recorder.commit(message, {receivedUtcMs: Date.now()}));}
      const trips = ok(await client.listTrips()).trips; expect(trips).toHaveLength(1); expect(trips[0].isHardMode).toBe(true);
      expect(ok(await client.journalTrips()).database.purpose).toBe('replay');
    } finally {expect(await client.close()).toEqual({clean: true});}
  });
});
