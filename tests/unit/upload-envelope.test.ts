import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';
import {canonicalUpload,decodeUploadReceipt,encodeUploadEnvelope,uploadMaterialDigest,validateUploadEnvelope,type UploadEnvelope} from '../../packages/storage/src/upload-envelope';
import type {UploadSummary} from '../../packages/storage/src/upload-projection';
const summary=JSON.parse(readFileSync('tests/fixtures/dashboard-upload/continued-summary.json','utf8')).expected as UploadSummary;
const id='80000000-0000-4000-8000-000000000001';
function envelope():UploadEnvelope {return {...structuredClone(summary),contract:{major:1,minor:0},producer:{application:'ets2telemetry',version:'test'},eventId:id,revision:1,installationId:id,bindingId:id,delivery:{mode:'backfill',syncRunId:id},type:'trip.completed',createdUtcMs:0};}
const bytes=(v:unknown)=>new TextEncoder().encode(typeof v==='string'?v:JSON.stringify(v));
describe('REG-004/005/009/010 frozen Dashboard v1 boundary',()=>{
  it('uses the hand-authored summary, exact money strings and deterministic closed UTF8 bytes',()=>{
    const e=envelope();expect(validateUploadEnvelope(e)).toBe(true);const encoded=encodeUploadEnvelope(e)!;
    expect(JSON.parse(new TextDecoder().decode(encoded))).toEqual(e);expect(encoded).toEqual(bytes(canonicalUpload(e)));
    expect(e.snapshot.revenue).toMatchObject({available:true,value:{raw:'-9223372036854775808',sdkType:'s64'}});
    expect(e.snapshot.expectedIncome).toMatchObject({available:true,value:{raw:'18446744073709551615',sdkType:'u64'}});
    expect(validateUploadEnvelope({...e,type:'trip.corrected'})).toBe(true);
  });
  it.each(['extra','unsafe','zero-revision','money','lone-surrogate','lifecycle','owner','oversize','depth'] as const)('rejects invalid envelope: %s',fault=>{
    const e=envelope();if(fault==='extra')Object.assign(e,{token:'private'});
    if(fault==='unsafe')e.createdUtcMs=Number.MAX_SAFE_INTEGER+1;
    if(fault==='zero-revision')e.revision=0;
    if(fault==='money')e.snapshot.revenue={available:true,value:{raw:'9223372036854775808',sdkType:'s64',currency:{status:'unknown'}}};
    if(fault==='lone-surrogate')e.producer.version='\ud800';
    if(fault==='lifecycle')e.type='trip.started';if(fault==='owner')e.bindingId='invalid';
    if(fault==='oversize')e.snapshot.context.dlcIds={available:true,value:Array.from({length:256},()=> 'a'.repeat(256))};
    if(fault==='depth')Object.assign(e.snapshot,{nested:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:{a:1}}}}}}}}}}}}}}}}}});
    expect(validateUploadEnvelope(e)).toBe(false);expect(encodeUploadEnvelope(e)).toBeUndefined();
  });
  it('compares ordinary OPEN counters as equal, but keeps availability, quality and terminal counters material',()=>{
    const a=structuredClone(summary),b=structuredClone(summary);for(const s of [a,b])Object.assign(s.snapshot,{outcome:'open',end:null,closeReason:null,outcomeEventSeq:null});
    a.snapshot.observedDistance={available:true,value:1,unit:'m'};b.snapshot.observedDistance={available:true,value:123,unit:'m'};
    a.snapshot.fuelUsed={available:true,value:1,unit:'L'};b.snapshot.fuelUsed={available:true,value:12,unit:'L'};
    expect(uploadMaterialDigest(a)).toBe(uploadMaterialDigest(b));b.snapshot.fuelUsed={available:false,reason:'not-observed',unit:'L'};expect(uploadMaterialDigest(a)).not.toBe(uploadMaterialDigest(b));
    const terminal=structuredClone(summary);terminal.snapshot.observedDistance={available:true,value:999,unit:'m'};expect(uploadMaterialDigest(terminal)).not.toBe(uploadMaterialDigest(summary));
  });
  it('accepts only a complete status-matched immutable receipt identity',()=>{
    const receipt={contract:{major:1,minor:0},eventId:id,receiptId:id,status:'stored',firstReceivedAtUtcMs:0};
    expect(decodeUploadReceipt(bytes(receipt),202,id)).toEqual(receipt);expect(decodeUploadReceipt(bytes({...receipt,status:'duplicate'}),200,id)?.receiptId).toBe(id);
    for(const body of [{...receipt,status:'duplicate'},{...receipt,extra:1},{...receipt,eventId:'80000000-0000-4000-8000-000000000002'},{...receipt,firstReceivedAtUtcMs:-1},{...receipt,firstReceivedAtUtcMs:Number.MAX_SAFE_INTEGER+1},{...receipt,contract:{major:1,minor:1}},{...receipt,receiptId:'no'}])expect(decodeUploadReceipt(bytes(body),202,id)).toBeUndefined();
    expect(decodeUploadReceipt(bytes(JSON.stringify(receipt).replace('"status":"stored"','"status":"stored","status":"stored"')),202,id)).toBeUndefined();
    expect(decodeUploadReceipt(new Uint8Array([0xc3,0x28]),202,id)).toBeUndefined();expect(decodeUploadReceipt(bytes(' '.repeat(4097)),202,id)).toBeUndefined();expect(decodeUploadReceipt(bytes(receipt),201,id)).toBeUndefined();
  });
});

it('REG-004/009/010 accepts unique DLC IDs and rejects duplicate DLC IDs required unique by the frozen v1 schema',()=>{
  const value=envelope();value.snapshot.context.dlcIds={available:true,value:['x','y']};expect(validateUploadEnvelope(value)).toBe(true);expect(encodeUploadEnvelope(value)).toBeDefined();
  value.snapshot.context.dlcIds={available:true,value:['x','x']};expect(validateUploadEnvelope(value)).toBe(false);expect(encodeUploadEnvelope(value)).toBeUndefined();
});
