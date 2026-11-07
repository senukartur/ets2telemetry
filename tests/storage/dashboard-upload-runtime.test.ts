import {guardJournalSync} from '../../apps/desktop/src/dashboard-upload/journal-sync-guard';
import {createHash,randomUUID} from 'node:crypto';
import {it,expect,vi} from 'vitest';
import {StorageClient} from '../../packages/storage/src/client';
import {DashboardUploadService} from '../../apps/desktop/src/dashboard-upload/service';
import {UploadMainController} from '../../apps/desktop/src/dashboard-upload/main-controller';
import {UploadCredentialStore} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import type {UploadServiceCommand} from '../../apps/desktop/src/dashboard-upload/service-contract';
import type {UploadRegistration} from '../../packages/storage/src/upload-sync';
import {storageWorker,terminateWorkers} from './recording-helpers';
import {workspace,ok,uploadTestWork,uploadReceipt,TEST_CLOSE_GRACE_MS} from './helpers';
import {source,tlsDashboard,uploadToken,game} from './dashboard-upload-helpers';
import {r} from '../shared/trip-messages';
it('REG-003/005/007/010/011/012 verifies/registers through real TLS, freezes original bytes and records while HTTP is stalled',async()=>{
  const ws=await workspace(),remote=await tlsDashboard(),worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});let service:DashboardUploadService|undefined;
  try{
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));const trip=await source(client),files=new Map<string,Uint8Array>();expect(await remote.rejectProbe('ca')).toMatchObject({ok:false,code:'TLS_CONFIGURATION'});expect(await remote.rejectProbe('hostname')).toMatchObject({ok:false,code:'TLS_CONFIGURATION'});remote.hold();
    const store=new UploadCredentialStore({async read(name){await Promise.resolve();return files.get(name);},async write(name,bytes){await Promise.resolve();files.set(name,bytes);},async remove(name){await Promise.resolve();files.delete(name);},async names(limit){await Promise.resolve();return [...files.keys()].slice(0,limit);}},{async available(){await Promise.resolve();return true;},async encrypt(v){await Promise.resolve();return Buffer.from(`protected:${v}`);},async decrypt(v){await Promise.resolve();return {result:v.toString().slice(10),shouldReEncrypt:false};}});
    let received!:()=>void,observe:((status:import('../../packages/contracts/src/dashboard-upload').DashboardUploadStatus)=>void)|undefined;const receiptStatus=new Promise<void>(resolve=>{received=resolve;});const controller=new UploadMainController(remote.origin,'staging',()=>store,status=>{if(status.progress.lastDurableUploadUtcMs===5000)received();observe?.(status);});service=new DashboardUploadService(client,remote.transport,remote.origin,'test',status=>controller.acceptStatus(status));const running=service;
    await controller.attach({generation:randomUUID(),call:command=>running.execute(command),cancel:()=>running.cancel(),retire(){}});const verified=await controller.handle('verify',[uploadToken]);expect(remote.errors).toEqual([]);expect(verified.error).toBeNull();expect(verified.state).toBe('confirmation-required');expect(remote.tlsFacts()).toEqual({authorized:true,fixturePeer:true});expect(verified.owner).toMatchObject({accountId:'a',origin:remote.origin});expect((await controller.handle('confirm',[verified.candidateId])).state).toBe('connected');
    const journalScope=controller.journalReadScope;expect(journalScope).toMatchObject({owner:{accountId:'a'},connectionVersion:'1'});
    const journalPage=ok(await client.journalTrips());expect(guardJournalSync(journalPage,journalScope,controller.journalReadScope).sync?.rows.map(row=>row.tripUuid)).toEqual(journalPage.trips.map(row=>row.tripUuid));
    await remote.waitForEvent(1);const wire=Buffer.from(remote.events[0]);expect(JSON.parse(wire.toString())).toMatchObject({source:{tripId:trip.tripUuid},delivery:{mode:'backfill'}});
    // No response exists yet. A real recorder mutation still crosses the shared worker.
    ok(await client.commitEvent({message:game(trip.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:trip.tripUuid,set:{observedDistanceM:{available:true,value:25}}}]}));
    remote.releaseOne();let guard:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([receiptStatus,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('UPLOAD_RECEIPT_STATUS_HANG_GUARD')),6000);})]);}finally{clearTimeout(guard);}
    const config=ok(await client.getUploadConfiguration());expect(ok(await client.getUploadStoreStatus({registrationId:config.registration!.registrationId})).deliveredEvents).toBe(1);expect(remote.events[0]).toEqual(wire);expect(controller.status.progress.distinctSources).toBe(1);
    const replacement=`vtc1_${randomUUID()}_${'b'.repeat(43)}`;remote.allowToken(replacement,'b');const candidate=await controller.handle('verify',[replacement]);expect(candidate).toMatchObject({state:'confirmation-required',owner:{accountId:'b'}});
    expect(controller.journalReadScope).toBeUndefined();expect(guardJournalSync(ok(await client.journalTrips()),journalScope,controller.journalReadScope).sync).toBeUndefined();
    const resumed=new Promise<void>(resolve=>{observe=status=>{if(['connected','paused'].includes(status.state)&&status.owner?.accountId==='a'&&status.candidateId===null)resolve();};});controller.documentChanged();try{await Promise.race([resumed,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('OWNER_NAVIGATION_RESUME_HANG_GUARD')),6000);})]);}finally{clearTimeout(guard);}
    expect(ok(await client.getUploadConfiguration())).toMatchObject({version:config.version,credentialGeneration:config.credentialGeneration,registration:{accountId:'a'}});const resumedHints=ok(await client.getUploadSchedulingHints({registrationId:config.registration!.registrationId}));expect(controller.status).toMatchObject(resumedHints.failureStreak>0?{state:'paused',error:'NETWORK'}:{state:'connected',error:null});const before=remote.events.length;ok(await client.recordCompleteness(trip.s.session,{tripUuid:trip.tripUuid,kind:'sample-loss'}));await remote.waitForEvent(before+1);expect(remote.eventOwners.every(account=>account==='a')).toBe(true);expect(controller.status.candidateId).toBeNull();
    controller.stop();await service.stop();await client.close();
  }finally{await service?.stop();await terminateWorkers();await remote.close();await ws.dispose();}
});

const offlineOrigin = 'https://dashboard.example';
async function runtimeClient(ws: Awaited<ReturnType<typeof workspace>>, purpose: 'history' | 'synthetic' | 'replay') {
  const worker = storageWorker(), client = new StorageClient(worker.handle, {closeGraceMs: TEST_CLOSE_GRACE_MS});
  ok(await client.open({path: ws.database, backupsDirectory: ws.backups, purpose, appVersion: 'test'})); return client;
}
async function runtimeRegistration(client: StorageClient, accountId: string): Promise<UploadRegistration> {
  const installation = ok(await client.ensureUploadInstallation());
  const registration = {registrationId: randomUUID(), clientInstallationId: installation.clientInstallationId!, origin: offlineOrigin, accountId, companyId: 'company', identityEpoch: 'epoch', installationId: randomUUID(), bindingId: randomUUID()};
  const recorded = ok(await client.recordUploadRegistration(registration)); return {...registration, registrationId: recorded.registrationId};
}
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
it.each(['synthetic', 'replay'] as const)('REG-010/012 real %s database denies every service control before startup recovery', async purpose => {
  const ws = await workspace(); let client: StorageClient | undefined, service: DashboardUploadService | undefined;
  try {
    client = await runtimeClient(ws, purpose); const calls: string[] = [], http: string[] = [];
    const port = new Proxy(client, {get(target, key) {const method = Reflect.get(target, key); return typeof method === 'function' ? (...args: unknown[]) => {calls.push(String(key)); return Reflect.apply(method, target, args);} : method;}});
    service = new DashboardUploadService(port, {request(route) {http.push(route); return Promise.reject(Error('UNEXPECTED_HTTP'));}, abort() {}, close() {}}, offlineOrigin, 'test', () => {});
    const activate = vi.spyOn(service.scheduler, 'activate');
    const commands: UploadServiceCommand[] = [{action: 'configuration'}, {action: 'suspend'}, {action: 'disconnect', expectedVersion: '0'}, {action: 'verify', token: uploadToken}, {action: 'prepare', token: uploadToken, owner: {origin: offlineOrigin, accountId: 'A', companyId: 'company', identityEpoch: 'epoch'}}, {action: 'activate', token: uploadToken, generation: randomUUID(), version: '0'}, {action: 'confirm', confirmationId: randomUUID(), registrationId: randomUUID(), credentialGeneration: randomUUID(), expectedVersion: '0'}];
    for (const command of commands) expect(await service.execute(command)).toEqual({ok: false, error: 'STORAGE_UNAVAILABLE'});
    expect(calls).toEqual(['getUploadConfiguration']); expect(http).toEqual([]); expect(activate).not.toHaveBeenCalled();
    expect(ok(await client.getUploadConfiguration())).toMatchObject({purpose, version: '0', registration: null});
  } finally {await service?.stop(); await client?.close(); await terminateWorkers(); await ws.dispose();}
});
function retainedEvidence(db: ReturnType<Awaited<ReturnType<typeof openConnection>>['reader']>) {
  return {
    bindings: db.prepare('SELECT * FROM upload_source_bindings ORDER BY root_ref LIMIT 8').all(),
    reservations: db.prepare('SELECT * FROM upload_reservations ORDER BY candidate_ref LIMIT 8').all(),
    claims: db.prepare('SELECT * FROM upload_history_claims ORDER BY first_ordinal LIMIT 8').all(),
    receipts: db.prepare('SELECT * FROM upload_receipts ORDER BY event_ref LIMIT 8').all(),
    attempts: db.prepare('SELECT * FROM upload_attempt ORDER BY attempt_id LIMIT 8').all() as {active: bigint; outcome: string | null}[],
    envelopes: (db.prepare('SELECT * FROM upload_envelopes ORDER BY event_id LIMIT 8').all() as {payload: Uint8Array | null; state: string}[]).map(row => ({...row, payload: row.payload === null ? null : hash(row.payload)})),
    works: db.prepare('SELECT work_id,root_ref,registration_ref,state,event_ref,pin_released FROM upload_materializations ORDER BY work_id LIMIT 8').all()
  };
}
it.each(['matching-intent', 'committed-intent', 'mismatched-intent', 'no-intent'] as const)('REG-005/006/010/012 real service reconciliation %s preserves durable work and never activates HTTP', async boundary => {
  const ws = await workspace(); let client: StorageClient | undefined, service: DashboardUploadService | undefined, controller: UploadMainController | undefined;
  try {
    client = await runtimeClient(ws, 'history'); const a = await runtimeRegistration(client, 'A'), aGeneration = randomUUID(), aRun = randomUUID();
    ok(await client.confirmUploadOwner({confirmationId: aRun, registrationId: a.registrationId, credentialGeneration: aGeneration, expectedVersion: '0'}));
    for (const state of ['delivered', 'held', 'sending', 'queued']) {
      const trip = await source(client);
      ok(await client.commitEvent({message: game(trip.s.event(r.delivered())), effects: [{kind: 'trip.close', tripUuid: trip.tripUuid, outcome: 'delivered', closeReason: 'outcome', outcomeEvent: 'this-event', recordingCompleteness: 'complete', endedUtcMs: 2000}]}));
      const workId = await uploadTestWork(client, {tripUuid: trip.tripUuid, registrationId: a.registrationId});
      const frozen = ok(await client.freezeUploadMaterialization({workId, producerVersion: 'test', createdUtcMs: 1000})); expect(frozen.status).toBe('frozen'); ok(await client.releaseUploadMaterialization({workId}));
      if (state !== 'queued') {
        const attempt = ok(await client.claimUploadAttempt({attemptId: randomUUID(), registrationId: a.registrationId, expectedVersion: '1', mode: 'any', nowMs: 1000})); expect(attempt.status).toBe('claimed');
        if (state === 'delivered') ok(await client.commitUploadReceipt({attemptId: attempt.attemptId!, statusCode: 202, body: uploadReceipt(attempt.eventId!)}));
        if (state === 'held') ok(await client.recordUploadAttemptOutcome({attemptId: attempt.attemptId!, kind: 'validation', retryAtMs: 1000, nowMs: 1000}));
      }
    }
    const b = await runtimeRegistration(client, 'B'), bGeneration = randomUUID();
    ok(await client.confirmUploadOwner({confirmationId: randomUUID(), registrationId: b.registrationId, credentialGeneration: bGeneration, expectedVersion: '1'}));
    await client.close(); client = undefined;
    const offline = await openConnection(ws.options({purpose: 'history'})); let before: ReturnType<typeof retainedEvidence>;
    try {
      // Both references exist, but the active B connection points at A's scan. No FK is disabled.
      offline.writer().prepare('UPDATE upload_connection SET active_run=? WHERE id=1').run(aRun);
      expect(offline.reader().pragma('foreign_key_check')).toEqual([]); before = retainedEvidence(offline.reader());
      expect(before.envelopes.map(row => row.state).sort()).toEqual(['delivered', 'held', 'queued', 'sending']); expect(before.receipts).toHaveLength(1);
    } finally {offline.close();}
    client = await runtimeClient(ws, 'history'); expect(ok(await client.getUploadConfiguration())).toMatchObject({status: 'reconciliation-required', version: '2', registration: {accountId: 'B'}});
    const currentClient = client, files = new Map<string, Uint8Array>(), removals: string[] = [];
    const store = new UploadCredentialStore({read(name) {return Promise.resolve(files.get(name));}, write(name, bytes) {files.set(name, bytes); return Promise.resolve();}, names(limit) {return Promise.resolve([...files.keys()].slice(0, limit));}, async remove(name) {
      expect(ok(await currentClient.getUploadConfiguration())).toMatchObject({status: 'ready', version: '3', registration: null, credentialGeneration: null, runId: null}); removals.push(name); files.delete(name);
    }}, {available() {return Promise.resolve(true);}, encrypt(value) {return Promise.resolve(Buffer.from(`protected:${value}`));}, decrypt() {return Promise.reject(Error('UNEXPECTED_CREDENTIAL_LOAD'));}});
    for (const [registration, generation] of [[a, aGeneration], [b, bGeneration]] as const) {
      const context = {channel: 'staging' as const, generation, registration, owner: {origin: registration.origin, accountId: registration.accountId, companyId: registration.companyId, identityEpoch: registration.identityEpoch}};
      await store.save(context, uploadToken); if (registration === b) await store.activate(context);
    }
    if (boundary !== 'no-intent') await store.disconnectIntent({version: 1, channel: 'staging', origin: offlineOrigin, expectedVersion: boundary === 'mismatched-intent' ? '1' : '2'});
    if (boundary === 'committed-intent') expect(ok(await client.disconnectUploadOwner({expectedVersion: '2'}))).toMatchObject({status: 'disconnected', version: '3'});
    const credentialsBefore = [...files].map(([name, bytes]) => [name, hash(bytes)]), load = vi.spyOn(store, 'load');
    const storageCalls: {name: string; args: unknown[]}[] = [], commands: string[] = [], http: string[] = [];
    const port = new Proxy(client, {get(target, key) {const method = Reflect.get(target, key); return typeof method === 'function' ? (...args: unknown[]) => {storageCalls.push({name: String(key), args}); return Reflect.apply(method, target, args);} : method;}});
    let activeController: UploadMainController | undefined;
    service = new DashboardUploadService(port, {request(route) {http.push(route); return Promise.reject(Error('UNEXPECTED_HTTP'));}, abort() {}, close() {}}, offlineOrigin, 'test', status => activeController?.acceptStatus(status));
    const activate = vi.spyOn(service.scheduler, 'activate');
    const activeService = service;
    controller = activeController = new UploadMainController(offlineOrigin, 'staging', () => store, () => {});
    await controller.attach({generation: randomUUID(), call(command) {commands.push(command.action); return activeService.execute(command);}, cancel: () => activeService.cancel(), retire() {}});
    const disconnected = boundary === 'matching-intent' || boundary === 'committed-intent';
    expect(controller.status).toMatchObject(disconnected ? {state: 'disconnected', owner: null, error: null} : {state: 'paused', owner: null, error: 'RECONCILIATION'});
    expect(controller.journalReadScope).toBeUndefined(); expect(load).not.toHaveBeenCalled();
    expect(commands).toEqual(boundary === 'matching-intent' ? ['configuration', 'disconnect'] : ['configuration']);
    if (disconnected) {expect(files.size).toBe(0); expect(removals.length).toBeGreaterThan(0); expect(await store.readDisconnect()).toBeUndefined();}
    else {
      expect([...files].map(([name, bytes]) => [name, hash(bytes)])).toEqual(credentialsBefore); expect(removals).toEqual([]);
      expect(await store.readDisconnect()).toEqual(boundary === 'no-intent' ? undefined : {version: 1, channel: 'staging', origin: offlineOrigin, expectedVersion: '1'});
      for (const command of [{action: 'verify', token: uploadToken}, {action: 'prepare', token: uploadToken, owner: {origin: b.origin, accountId: b.accountId, companyId: b.companyId, identityEpoch: b.identityEpoch}}, {action: 'activate', token: uploadToken, generation: bGeneration, version: '2'}, {action: 'confirm', confirmationId: randomUUID(), registrationId: b.registrationId, credentialGeneration: bGeneration, expectedVersion: '2'}] as UploadServiceCommand[]) expect(await service.execute(command)).toEqual({ok: false, error: 'RECONCILIATION'});
      expect(await service.execute({action: 'suspend'})).toEqual({ok: true, value: {kind: 'settled'}});
    }
    expect(storageCalls.filter(call => call.name === 'recoverUploadAttempt').map(call => call.args)).toEqual([[{startup: true}]]); expect(http).toEqual([]); expect(activate).not.toHaveBeenCalled();
    expect(storageCalls.filter(call => call.name === 'disconnectUploadOwner')).toHaveLength(boundary === 'matching-intent' ? 1 : 0);
    controller.stop(); await service.stop(); await client.close(); client = undefined;
    const inspect = await openConnection(ws.options({purpose: 'history'}));
    try {
      const after = retainedEvidence(inspect.reader());
      expect(after).toEqual({...before, envelopes: before.envelopes.map(row => row.state === 'sending' ? {...row, state: 'queued'} : row), attempts: before.attempts.map(row => row.active === 1n ? {...row, active: 0n, outcome: 'ambiguous'} : row)});
      expect(inspect.reader().pragma('foreign_key_check')).toEqual([]);
    } finally {inspect.close();}
    client = await runtimeClient(ws, 'history'); expect(ok(await client.getUploadConfiguration())).toMatchObject(disconnected ? {status: 'ready', version: '3', registration: null, credentialGeneration: null, runId: null} : {status: 'reconciliation-required', version: '2', registration: {accountId: 'B'}});
  } finally {controller?.stop(); await service?.stop(); await client?.close(); await terminateWorkers(); await ws.dispose();}
});
