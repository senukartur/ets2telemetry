'use strict';
// Private test worker injects local transaction barriers; no fault fields enter the production worker protocol.
const {readFileSync,writeSync}=require('node:fs');
const path=require('node:path');
const {Worker,isMainThread,workerData,parentPort}=require('node:worker_threads');
const GUARD_MS=60_000;
function barrier(name,result){writeSync(1,`barrier ${name} ${JSON.stringify(result??null)}\n`);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,GUARD_MS);writeSync(2,'Upload barrier was not terminated\n');process.exit(4);}
const bundles=process.env.ETS2TELEMETRY_STORAGE_TEST_BUNDLES;
function input(config){return config.operation==='commitUploadReceipt'?{...config.input,body:new Uint8Array(config.input.body)}:config.input;}
if(isMainThread){
  const config=JSON.parse(readFileSync(process.argv[2],'utf8')),worker=new Worker(__filename,{workerData:config});
  const {StorageClient,workerHandle}=require(path.join(bundles,'storage-client.cjs')),client=new StorageClient(workerHandle(worker),{commandDeadlineMs:GUARD_MS});
  (async()=>{const opened=await client.open(config.open);if(!opened.ok)throw Error(opened.error.code);
    const result=await client[config.operation](input(config));if(!result.ok)throw Error(result.error.code);barrier('after-answer',result.value);
  })().catch(error=>{writeSync(2,String(error));process.exit(3);});
}else{
  const {openStorage}=require(path.join(bundles,'storage-core.cjs'));let storage;
  parentPort.on('message',async request=>{
    let result;if(request.command.name==='open'){const opened=await openStorage(request.command.options);if(!opened.ok)result=opened;else{storage=opened.value;result={ok:true,value:storage.summary};}}
    else {const hooks=workerData.boundary==='before-commit'?{testHooks:{beforeCommit:()=>barrier('before-commit')}}:undefined;
      result=storage[workerData.operation](input(workerData),hooks);if(!result.ok)throw Error(result.error.code);if(workerData.boundary==='after-commit')barrier('after-commit',result.value);
    }
    parentPort.postMessage({type:'storage.response',id:request.id,result});
  });
}
