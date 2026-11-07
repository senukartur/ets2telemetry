import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {UploadCredentialStore,type CredentialContext} from '../../apps/desktop/src/dashboard-upload/credential-store';
import type {UploadCryptoPort,UploadCredentialFiles} from '../../apps/desktop/src/dashboard-upload/credential-ports';
const token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`;
export function credentialFixture(){
  const owner={origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'e'},context:CredentialContext={generation:randomUUID(),channel:'staging',owner,registration:{...owner,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()}};
  const data=new Map<string,Uint8Array>(),operations:string[]=[];
  const files:UploadCredentialFiles={async read(name){await Promise.resolve();operations.push('read');return data.get(name);},async write(name,bytes){await Promise.resolve();operations.push(`sync:${name}`);data.set(name,bytes);},async remove(name){await Promise.resolve();data.delete(name);},async names(limit){await Promise.resolve();return [...data.keys()].slice(0,limit);}};
  const crypto:UploadCryptoPort={async available(){await Promise.resolve();return true;},async encrypt(value){await Promise.resolve();operations.push('encrypt');return Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`);},async decrypt(value){await Promise.resolve();operations.push('decrypt');return {result:Buffer.from(value.toString().slice(7),'base64').toString(),shouldReEncrypt:false};}};
  return {context,data,operations,crypto,files,store:new UploadCredentialStore(files,crypto)};
}
describe('REG-006/007/012 protected credential generations',()=>{
  it('syncs ciphertext before an external confirm and activates only afterwards; an orphan marker gives no read authority',async()=>{
    const f=credentialFixture();await f.store.save(f.context,token);f.operations.push('commit');await f.store.activate(f.context);
    expect(f.operations.indexOf(`sync:generation.${f.context.generation}.bin`)).toBeLessThan(f.operations.indexOf('commit'));expect(f.operations.indexOf('commit')).toBeLessThan(f.operations.indexOf('sync:active.json'));
    expect(await f.store.load(f.context)).toBe(token);await expect(f.store.load({...f.context,generation:randomUUID()})).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
    await expect(f.store.load({...f.context,owner:{...f.context.owner,accountId:'b'}})).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  });
  it('has no plaintext fallback and bounds unavailable or unsettled rotation',async()=>{
    const f=credentialFixture();f.crypto.available=()=>Promise.resolve(false);await expect(f.store.save(f.context,token)).rejects.toThrow('ENCRYPTION_UNAVAILABLE');expect(f.data.size).toBe(0);
    f.crypto.available=()=>Promise.resolve(true);await f.store.save(f.context,token);let calls=0;f.crypto.decrypt=async()=>{await Promise.resolve();calls++;return {result:'',shouldReEncrypt:true};};await expect(f.store.load(f.context)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(calls).toBe(2);
  });
  it('keeps a committed generation recoverable without activation, and persists disconnect intent independently',async()=>{
    const f=credentialFixture();await f.store.save(f.context,token);const reopened=new UploadCredentialStore(f.files,f.crypto);expect(await reopened.load(f.context)).toBe(token);
    const intent={version:1,channel:'staging',origin:f.context.owner.origin,expectedVersion:'1'} as const;await reopened.disconnectIntent(intent);expect(await reopened.readDisconnect()).toEqual(intent);await reopened.clearDisconnect();expect(await reopened.readDisconnect()).toBeUndefined();
  });
  it('bounds cleanup and keeps current ciphertext and intent',async()=>{
    const f=credentialFixture();await f.store.save(f.context,token);for(let i=0;i<30;i++)f.data.set(`generation.${randomUUID()}.bin`,Buffer.from('opaque'));
    const result=await f.store.cleanup([f.context.generation],8);expect(result.examined).toBeLessThanOrEqual(8);expect(result.removed).toBe(8);expect(result.more).toBe(true);expect(await f.store.load(f.context)).toBe(token);
  });
});
