import {openSync,readSync,closeSync} from 'node:fs';
import {strictJson} from '../../../packages/contracts/src/protocol-v0';

export const MAX_FIXTURE_BYTES=2*1024*1024;

/** Read from one owned handle; metadata and path replacement cannot waive the cap. */
export function readFixtureFile(path:string):unknown {
  const handle=openSync(path,'r');
  try {
    // The extra byte is an overflow probe. Never decode or parse an oversized input.
    const buffer=Buffer.alloc(MAX_FIXTURE_BYTES+1);
    let used=0;
    while(used<buffer.length) {
      const count=readSync(handle,buffer,used,buffer.length-used,null);
      if(count===0)break;
      used+=count;
    }
    if(used>MAX_FIXTURE_BYTES)throw new Error('Synthetic fixture file exceeds 2 MiB');
    const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,used));
    // JSON.parse keeps the last duplicate key; use the protocol's strict parser instead.
    try {return strictJson(text);}catch{throw new Error('Synthetic fixture must be strict JSON without duplicate keys');}
  }finally{closeSync(handle);}
}
