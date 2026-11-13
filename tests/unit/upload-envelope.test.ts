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
  it('freezes accounting uncertainty with complete trailers while preserving supported values and exact native money',()=>{
    const e=envelope();e.snapshot.trailers.complete=true;e.snapshot.trailers.items[0].bodyType={available:true,value:'curtainsider'};
    e.snapshot.evidence.ruleContextComplete=false;e.snapshot.evidence.reasons=['accounting-unavailable'];
    const encoded=encodeUploadEnvelope(e);expect(encoded).toBeDefined();
    const frozen=JSON.parse(new TextDecoder().decode(encoded)) as UploadEnvelope;
    expect(frozen.snapshot.trailers.complete).toBe(true);
    expect(frozen.snapshot.evidence).toMatchObject({ruleContextComplete:false,reasons:['accounting-unavailable']});
    expect(frozen.snapshot.revenue).toEqual({available:true,value:{raw:'-9223372036854775808',sdkType:'s64',currency:{status:'unknown'}}});
    expect(frozen.snapshot.expectedIncome).toEqual({available:true,value:{raw:'18446744073709551615',sdkType:'u64',currency:{status:'unknown'}}});
    expect(frozen.snapshot.observedDistance).toEqual({available:true,value:0,unit:'m'});
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
    const receiptMinor1={contract:{major:1,minor:1},eventId:id,receiptId:id,status:'stored',firstReceivedAtUtcMs:0};
    expect(decodeUploadReceipt(bytes(receiptMinor1),202,id)).toEqual(receiptMinor1);
    for(const body of [{...receipt,status:'duplicate'},{...receipt,extra:1},{...receipt,eventId:'80000000-0000-4000-8000-000000000002'},{...receipt,firstReceivedAtUtcMs:-1},{...receipt,firstReceivedAtUtcMs:Number.MAX_SAFE_INTEGER+1},{...receipt,contract:{major:2,minor:0}},{...receipt,receiptId:'no'}])expect(decodeUploadReceipt(bytes(body),202,id)).toBeUndefined();
    expect(decodeUploadReceipt(bytes(JSON.stringify(receipt).replace('"status":"stored"','"status":"stored","status":"stored"')),202,id)).toBeUndefined();
    expect(decodeUploadReceipt(new Uint8Array([0xc3,0x28]),202,id)).toBeUndefined();expect(decodeUploadReceipt(bytes(' '.repeat(4097)),202,id)).toBeUndefined();expect(decodeUploadReceipt(bytes(receipt),201,id)).toBeUndefined();
  });
  it('freezes contract minor 1 with hardModeResult and rejects minor 0 with hardModeResult',()=>{
    const e1=envelope();
    e1.contract.minor=1;
    e1.snapshot.hardModeResult='qualified';
    expect(validateUploadEnvelope(e1)).toBe(true);
    const encoded1=encodeUploadEnvelope(e1);
    expect(encoded1).toBeDefined();
    const frozen1=JSON.parse(new TextDecoder().decode(encoded1)) as UploadEnvelope;
    expect(frozen1.contract.minor).toBe(1);
    expect(frozen1.snapshot.hardModeResult).toBe('qualified');

    // minor 1 missing hardModeResult is invalid
    const e1Missing={...structuredClone(e1)};
    delete e1Missing.snapshot.hardModeResult;
    expect(validateUploadEnvelope(e1Missing)).toBe(false);

    // minor 0 having hardModeResult is invalid
    const e0WithHardMode=envelope();
    e0WithHardMode.snapshot.hardModeResult='not-qualified';
    expect(validateUploadEnvelope(e0WithHardMode)).toBe(false);
  });
  it('freezes contract minor 2 with hardModeResult and accounting and forbids accounting at minors 0 and 1',()=>{
    const e2=envelope();e2.contract.minor=2;e2.snapshot.hardModeResult='not-qualified';e2.snapshot.accounting={distance:'complete',fuel:'partial'};
    expect(validateUploadEnvelope(e2)).toBe(true);
    const encoded2=encodeUploadEnvelope(e2);expect(encoded2).toBeDefined();
    const frozen2=JSON.parse(new TextDecoder().decode(encoded2)) as UploadEnvelope;
    expect(frozen2.contract).toEqual({major:1,minor:2});expect(frozen2.snapshot.accounting).toEqual({distance:'complete',fuel:'partial'});
    const without=(key:'hardModeResult'|'accounting')=>{const e=structuredClone(e2);delete e.snapshot[key];return e;};
    expect(validateUploadEnvelope(without('accounting'))).toBe(false);expect(validateUploadEnvelope(without('hardModeResult'))).toBe(false);
    for(const accounting of [{distance:'unavailable',fuel:'complete'},{distance:'complete'},{distance:'complete',fuel:'complete',extra:'x'},{distance:'complete',fuel:null}]){
      const e=structuredClone(e2);Object.assign(e.snapshot,{accounting});expect(validateUploadEnvelope(e)).toBe(false);expect(encodeUploadEnvelope(e)).toBeUndefined();
    }
    const e1=structuredClone(e2);e1.contract.minor=1;expect(validateUploadEnvelope(e1)).toBe(false);
    const e0=envelope();e0.snapshot.accounting={distance:'unknown',fuel:'unknown'};expect(validateUploadEnvelope(e0)).toBe(false);
    expect(validateUploadEnvelope({...structuredClone(e2),contract:{major:1,minor:3}})).toBe(false);
  });
  it('accepts a receipt that echoes minor 2 and rejects minor 3',()=>{
    const receipt={contract:{major:1,minor:2},eventId:id,receiptId:id,status:'stored',firstReceivedAtUtcMs:0};
    expect(decodeUploadReceipt(bytes(receipt),202,id)).toEqual(receipt);
    expect(decodeUploadReceipt(bytes({...receipt,contract:{major:1,minor:3}}),202,id)).toBeUndefined();
    // Bound to the frozen event's minor, only that minor is a receipt; null (an unreadable frozen version) accepts none.
    expect([0,1,2].map(minor=>decodeUploadReceipt(bytes(receipt),202,id,minor as 0|1|2)!==undefined)).toEqual([false,false,true]);
    expect(decodeUploadReceipt(bytes(receipt),202,id,null)).toBeUndefined();
  });
  it('keeps the accounting status out of the material comparison',()=>{
    const base=structuredClone(summary),complete=structuredClone(summary),partial=structuredClone(summary);
    complete.snapshot.accounting={distance:'complete',fuel:'complete'};partial.snapshot.accounting={distance:'partial',fuel:'unknown'};
    expect(uploadMaterialDigest(complete)).toBe(uploadMaterialDigest(base));expect(uploadMaterialDigest(partial)).toBe(uploadMaterialDigest(base));
    // Other fields stay material next to it.
    partial.snapshot.recordingCompleteness='complete';expect(uploadMaterialDigest(partial)).not.toBe(uploadMaterialDigest(base));
    expect(complete.snapshot.accounting).toEqual({distance:'complete',fuel:'complete'});
  });
});

it('REG-004/009/010 accepts unique DLC IDs and rejects duplicate DLC IDs required unique by the frozen v1 schema',()=>{
  const value=envelope();value.snapshot.context.dlcIds={available:true,value:['x','y']};expect(validateUploadEnvelope(value)).toBe(true);expect(encodeUploadEnvelope(value)).toBeDefined();
  value.snapshot.context.dlcIds={available:true,value:['x','x']};expect(validateUploadEnvelope(value)).toBe(false);expect(encodeUploadEnvelope(value)).toBeUndefined();
});
