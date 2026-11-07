import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {it,expect} from 'vitest';
import {Storage} from '../../packages/storage/src';
import {openConnection} from '../../packages/storage/src/sqlite/connection';
import {CredentialFiles,UploadCredentialStore} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {workspace,ok,uploadTestOwner,uploadTestSource,uploadTestWork,uploadReceipt} from './helpers';
async function kill(ws:Awaited<ReturnType<typeof workspace>>,mode:string,registration:unknown){
  const config=path.join(ws.directory,'upload-child.json');await writeFile(config,JSON.stringify({mode,registration,open:ws.options({purpose:'history'}),credentials:path.join(ws.directory,'credentials'),remote:path.join(ws.directory,'remote.json')}));
  const child=spawn(process.execPath,[path.resolve('tests/storage/fixtures/dashboard-upload-child.cjs'),config],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',LOCALAPPDATA:ws.directory},stdio:['ignore','pipe','pipe'],windowsHide:true}),ended=once(child,'close');let output='',errors='',timer:ReturnType<typeof setTimeout>|undefined;
  try{await new Promise<void>((resolve,reject)=>{timer=setTimeout(()=>reject(Error('UPLOAD_CHILD_DEADLINE')),15000);child.stdout.on('data',chunk=>{output+=String(chunk);if(output==='barrier\n')resolve();else if(output.length>100)reject(Error('UPLOAD_CHILD_OUTPUT'));});child.stderr.on('data',chunk=>{errors+=String(chunk);});child.once('exit',()=>reject(Error('UPLOAD_CHILD_EXITED')));});expect(errors).toBe('');}
  finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await ended;}
}
const crypto={async available(){await Promise.resolve();return true;},async encrypt(value:string){await Promise.resolve();return Buffer.from(`test-protected:${value}`);},async decrypt(value:Buffer){await Promise.resolve();return {result:value.toString().slice(15),shouldReEncrypt:false};}};
it.each(['candidate-before-binding','binding-before-activation','disconnect-after-commit'] as const)('REG-006/012 real-process %s recovery never promotes an orphan or resurrects disconnect',async mode=>{
  const ws=await workspace();let storage:Storage|undefined;
  try{
    let conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);const owner=await uploadTestOwner(storage),row=conn.writer().prepare('SELECT * FROM upload_registrations WHERE registration_id=?').get(owner.registrationId) as Record<string,unknown>;
    const registration={registrationId:owner.registrationId,clientInstallationId:String(row.client_uuid),origin:String(row.origin),accountId:String(row.account_id),companyId:String(row.company_id),identityEpoch:String(row.identity_epoch),installationId:String(row.installation_id),bindingId:String(row.binding_id)};
    if(mode==='disconnect-after-commit')ok(storage.confirmUploadOwner({confirmationId:owner.runId,registrationId:owner.registrationId,credentialGeneration:randomUUID(),expectedVersion:'0'}));storage.close();storage=undefined;
    await kill(ws,mode,registration);conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);const configuration=ok(storage.getUploadConfiguration()),files=new CredentialFiles(path.join(ws.directory,'credentials')),store=new UploadCredentialStore(files,crypto);
    if(mode==='candidate-before-binding'){expect(configuration.registration).toBeNull();expect((await readdir(path.join(ws.directory,'credentials'))).filter(name=>name.endsWith('.bin'))).toHaveLength(1);expect(configuration.version).toBe('0');}
    if(mode==='binding-before-activation'){expect(configuration.registration).toEqual(registration);expect(await files.read('active.json',1024)).toBeUndefined();expect(await store.load({generation:configuration.credentialGeneration!,channel:'staging',owner:{origin:registration.origin,accountId:registration.accountId,companyId:registration.companyId,identityEpoch:registration.identityEpoch},registration})).toMatch(/^vtc1_/);}
    if(mode==='disconnect-after-commit'){expect(configuration.registration).toBeNull();expect(await store.readDisconnect()).toMatchObject({expectedVersion:'1'});expect(configuration.version).toBe('2');}
  }finally{storage?.close();await ws.dispose();}
});
it.each(['lost-claim','remote-commit'] as const)('REG-006/012 restarts after %s without retaining the old attempt UUID and retries identical frozen bytes',async mode=>{
  const ws=await workspace();let storage:Storage|undefined;
  try{
    let conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);const source=await uploadTestSource(storage),workId=await uploadTestWork(storage,source);ok(storage.freezeUploadMaterialization({workId,producerVersion:'test',createdUtcMs:1000}));const wire=conn.writer().prepare('SELECT payload,event_id FROM upload_envelopes').get() as {payload:Uint8Array;event_id:string};storage.close();storage=undefined;
    await kill(ws,mode,{registrationId:source.registrationId});conn=await openConnection(ws.options({purpose:'history'}));storage=new Storage(conn);expect(ok(storage.recoverUploadAttempt({startup:true})).status).toBe('recovered');const retry=ok(storage.claimUploadAttempt({attemptId:randomUUID(),registrationId:source.registrationId,expectedVersion:'1',mode:'any',nowMs:2000}));expect(Buffer.from(retry.payload!)).toEqual(Buffer.from(wire.payload));expect(retry.eventId).toBe(wire.event_id);
    if(mode==='remote-commit'){const remote=JSON.parse(await readFile(path.join(ws.directory,'remote.json'),'utf8'));expect(remote.eventId).toBe(retry.eventId);expect(Buffer.from(remote.payload,'base64')).toEqual(Buffer.from(retry.payload!));}
    expect(ok(storage.commitUploadReceipt({attemptId:retry.attemptId!,statusCode:202,body:uploadReceipt(retry.eventId!)})).status).toBe('delivered');
  }finally{storage?.close();await ws.dispose();}
});
