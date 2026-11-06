'use strict';
// Real process/worker barriers are in-process test code, never private worker request fields.
const {readFileSync,writeSync}=require('node:fs');
const path=require('node:path');
const {Worker,isMainThread,workerData,parentPort}=require('node:worker_threads');
const BARRIER_HANG_GUARD_MS=60_000;
function barrier(name){
  writeSync(1,`barrier ${name}\n`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,BARRIER_HANG_GUARD_MS);
  writeSync(2,'Projection barrier was never terminated\n');process.exit(4);
}
const bundles=process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
if(isMainThread){
  const config=JSON.parse(readFileSync(process.argv[2],'utf8'));
  const worker=new Worker(__filename,{workerData:config});
  const {StorageClient,workerHandle}=require(path.join(bundles,'storage-client.cjs'));
  const client=new StorageClient(workerHandle(worker),{commandDeadlineMs:BARRIER_HANG_GUARD_MS});
  (async()=>{
    const opened=await client.open(config.open);if(!opened.ok)throw Error(opened.error.code);
    const result=await client[config.operation](config.pinId);
    if(!result.ok)throw Error(result.error.code);
    barrier('after-answer');
  })().catch(error=>{writeSync(2,String(error));process.exit(3);});
}else{
  const {openStorage}=require(path.join(bundles,'storage-core.cjs'));
  let storage;
  parentPort.on('message',async request=>{
    let result;
    if(request.command.name==='open'){
      const opened=await openStorage(request.command.options);if(!opened.ok)result=opened;
      else{storage=opened.value;result={ok:true,value:storage.summary};}
    }else{
      const hooks=workerData.boundary==='before-commit'?{testHooks:{beforeCommit:()=>barrier('before-commit')}}:undefined;
      result=storage[workerData.operation](workerData.pinId,hooks);
      if(workerData.boundary==='after-commit')barrier('after-commit');
    }
    parentPort.postMessage({type:'storage.response',id:request.id,result});
  });
}
