import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import {StorageClient} from '../../packages/storage/src/client';
import {DashboardUploadService} from '../../apps/desktop/src/dashboard-upload/service';
import {UploadMainController} from '../../apps/desktop/src/dashboard-upload/main-controller';
import {UploadCredentialStore} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {storageWorker,terminateWorkers} from './recording-helpers';
import {workspace,ok,TEST_CLOSE_GRACE_MS} from './helpers';
import {source,tlsDashboard,uploadToken,game} from './dashboard-upload-helpers';
import {r} from '../shared/trip-messages';
it('REG-003/005/007/010/011/012 verifies/registers through real TLS, freezes original bytes and records while HTTP is stalled',async()=>{
  const ws=await workspace(),remote=await tlsDashboard(),worker=storageWorker(),client=new StorageClient(worker.handle,{closeGraceMs:TEST_CLOSE_GRACE_MS});let service:DashboardUploadService|undefined;
  try{
    ok(await client.open({path:ws.database,backupsDirectory:ws.backups,purpose:'history',appVersion:'test'}));const trip=await source(client),files=new Map<string,Uint8Array>();expect(await remote.rejectProbe('ca')).toMatchObject({ok:false,code:'TLS_CONFIGURATION'});expect(await remote.rejectProbe('hostname')).toMatchObject({ok:false,code:'TLS_CONFIGURATION'});remote.hold();
    const store=new UploadCredentialStore({async read(name){await Promise.resolve();return files.get(name);},async write(name,bytes){await Promise.resolve();files.set(name,bytes);},async remove(name){await Promise.resolve();files.delete(name);},async names(limit){await Promise.resolve();return [...files.keys()].slice(0,limit);}},{async available(){await Promise.resolve();return true;},async encrypt(v){await Promise.resolve();return Buffer.from(`protected:${v}`);},async decrypt(v){await Promise.resolve();return {result:v.toString().slice(10),shouldReEncrypt:false};}});
    let received!:()=>void,observe:((status:import('../../packages/contracts/src/dashboard-upload').DashboardUploadStatus)=>void)|undefined;const receiptStatus=new Promise<void>(resolve=>{received=resolve;});const controller=new UploadMainController(remote.origin,'staging',()=>store,status=>{if(status.progress.lastDurableUploadUtcMs===5000)received();observe?.(status);});service=new DashboardUploadService(client,remote.transport,remote.origin,'test',status=>controller.acceptStatus(status));const running=service;
    await controller.attach({generation:randomUUID(),call:command=>running.execute(command),cancel:()=>running.cancel(),retire(){}});const verified=await controller.handle('verify',[uploadToken]);expect(remote.errors).toEqual([]);expect(verified.error).toBeNull();expect(verified.state).toBe('confirmation-required');expect(remote.tlsFacts()).toEqual({authorized:true,fixturePeer:true});expect(verified.owner).toMatchObject({accountId:'a',origin:remote.origin});expect((await controller.handle('confirm',[verified.candidateId])).state).toBe('connected');
    await remote.waitForEvent(1);const wire=Buffer.from(remote.events[0]);expect(JSON.parse(wire.toString())).toMatchObject({source:{tripId:trip.tripUuid},delivery:{mode:'backfill'}});
    // No response exists yet. A real recorder mutation still crosses the shared worker.
    ok(await client.commitEvent({message:game(trip.s.event(r.paused())),effects:[{kind:'trip.update',tripUuid:trip.tripUuid,set:{observedDistanceM:{available:true,value:25}}}]}));
    remote.releaseOne();let guard:ReturnType<typeof setTimeout>|undefined;try{await Promise.race([receiptStatus,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('UPLOAD_RECEIPT_STATUS_HANG_GUARD')),6000);})]);}finally{clearTimeout(guard);}
    const config=ok(await client.getUploadConfiguration());expect(ok(await client.getUploadStoreStatus({registrationId:config.registration!.registrationId})).deliveredEvents).toBe(1);expect(remote.events[0]).toEqual(wire);expect(controller.status.progress.distinctSources).toBe(1);
    const replacement=`vtc1_${randomUUID()}_${'b'.repeat(43)}`;remote.allowToken(replacement,'b');const candidate=await controller.handle('verify',[replacement]);expect(candidate).toMatchObject({state:'confirmation-required',owner:{accountId:'b'}});
    const resumed=new Promise<void>(resolve=>{observe=status=>{if(status.state==='connected'&&status.owner?.accountId==='a')resolve();};});controller.documentChanged();try{await Promise.race([resumed,new Promise((_,reject)=>{guard=setTimeout(()=>reject(Error('OWNER_NAVIGATION_RESUME_HANG_GUARD')),6000);})]);}finally{clearTimeout(guard);}
    expect(ok(await client.getUploadConfiguration())).toMatchObject({version:config.version,credentialGeneration:config.credentialGeneration,registration:{accountId:'a'}});const before=remote.events.length;ok(await client.recordCompleteness(trip.s.session,{tripUuid:trip.tripUuid,kind:'sample-loss'}));await remote.waitForEvent(before+1);expect(remote.eventOwners.every(account=>account==='a')).toBe(true);expect(controller.status.candidateId).toBeNull();
    controller.stop();await service.stop();await client.close();
  }finally{await service?.stop();await terminateWorkers();await remote.close();await ws.dispose();}
});
