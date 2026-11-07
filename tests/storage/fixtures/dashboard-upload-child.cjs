'use strict';
// Dummy crypto and a fake remote commit; production controller/files and the real SQLite worker remain unchanged.
const {readFileSync,writeSync,openSync,writeFileSync,fsyncSync,closeSync}=require('node:fs');
const path=require('node:path'),{randomUUID}=require('node:crypto'),{Worker}=require('node:worker_threads');
const config=JSON.parse(readFileSync(process.argv[2],'utf8')),bundles=process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
const {StorageClient,workerHandle}=require(path.join(bundles,'storage-client.cjs'));
const {UploadMainController}=require(path.join(bundles,'upload-main-controller.cjs'));
const {CredentialFiles,UploadCredentialStore}=require(path.join(bundles,'upload-credential-store.cjs'));
const token='vtc1_10000000-0000-4000-8000-000000000001_'+'a'.repeat(43);
function barrier(){writeSync(1,'barrier\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60000);process.exit(4);}
function value(answer){if(!answer.ok)throw Error('STORAGE_FAILED');return answer.value;}
(async()=>{
  const client=new StorageClient(workerHandle(new Worker(path.join(bundles,'storage-worker.cjs'),{workerData:{kind:'storage'}})));value(await client.open(config.open));
  if(config.mode==='lost-claim'||config.mode==='remote-commit'){
    const attempt=value(await client.claimUploadAttempt({attemptId:randomUUID(),registrationId:config.registration.registrationId,expectedVersion:'1',mode:'any',nowMs:1000}));if(attempt.status!=='claimed')throw Error('CLAIM_FAILED');
    if(config.mode==='remote-commit'){const file=openSync(config.remote,'wx');try{writeFileSync(file,JSON.stringify({eventId:attempt.eventId,payload:Buffer.from(attempt.payload).toString('base64')}));fsyncSync(file);}finally{closeSync(file);}}
    barrier();return;
  }
  const files=new CredentialFiles(config.credentials),store=new UploadCredentialStore({read:files.read.bind(files),remove:files.remove.bind(files),names:files.names.bind(files),async write(name,bytes){await files.write(name,bytes);if(config.mode==='candidate-before-binding'&&name.endsWith('.bin'))barrier();}},{async available(){return true;},async encrypt(plain){return Buffer.from('test-protected:'+plain);},async decrypt(cipher){return {result:cipher.toString().slice(15),shouldReEncrypt:false};}});
  const owner={origin:config.registration.origin,accountId:config.registration.accountId,companyId:config.registration.companyId,identityEpoch:config.registration.identityEpoch};
  const controller=new UploadMainController(owner.origin,'staging',()=>store,()=>{});
  await controller.attach({generation:randomUUID(),retire(){},async call(command){
    if(command.action==='configuration')return {ok:true,value:{kind:'configuration',configuration:value(await client.getUploadConfiguration())}};
    if(command.action==='verify')return {ok:true,value:{kind:'verified',owner,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}}};
    if(command.action==='prepare')return {ok:true,value:{kind:'prepared',owner,registration:config.registration,expectedVersion:'0'}};
    if(command.action==='confirm'){const connection=value(await client.confirmUploadOwner({confirmationId:command.confirmationId,registrationId:command.registrationId,credentialGeneration:command.credentialGeneration,expectedVersion:command.expectedVersion}));if(config.mode==='binding-before-activation')barrier();return {ok:true,value:{kind:'connection',connection}};}
    if(command.action==='disconnect'){const connection=value(await client.disconnectUploadOwner({expectedVersion:command.expectedVersion}));if(config.mode==='disconnect-after-commit')barrier();return {ok:true,value:{kind:'connection',connection}};}
    return {ok:true,value:{kind:'settled'}};
  }});
  if(config.mode==='disconnect-after-commit')await controller.handle('disconnect',[]);else{const verified=await controller.handle('verify',[token]);await controller.handle('confirm',[verified.candidateId]);}
  throw Error('BARRIER_NOT_REACHED');
})().catch(()=>{writeSync(2,'UPLOAD_CHILD_FAILED\n');process.exit(3);});
