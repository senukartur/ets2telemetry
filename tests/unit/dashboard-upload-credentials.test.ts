import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,readFile,readdir,rename,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {CredentialFiles,UploadCredentialStore,type CredentialContext} from '../../apps/desktop/src/dashboard-upload/credential-store';
import type {UploadCryptoPort,UploadCredentialFiles} from '../../apps/desktop/src/dashboard-upload/credential-ports';
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,rename:vi.fn(actual.rename)};});
const token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`;
export function credentialFixture(){
  const owner={origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'e'},context:CredentialContext={generation:randomUUID(),channel:'staging',owner,registration:{...owner,registrationId:randomUUID(),clientInstallationId:randomUUID(),installationId:randomUUID(),bindingId:randomUUID()}};
  const data=new Map<string,Uint8Array>(),operations:string[]=[];
  const files:UploadCredentialFiles={async read(name){await Promise.resolve();operations.push('read');return data.get(name);},async write(name,bytes){await Promise.resolve();operations.push(`sync:${name}`);data.set(name,bytes);},async remove(name){await Promise.resolve();data.delete(name);},async names(limit){await Promise.resolve();return [...data.keys()].slice(0,limit);}};
  const crypto:UploadCryptoPort={async available(){await Promise.resolve();return true;},async encrypt(value){await Promise.resolve();operations.push('encrypt');return Buffer.from(`cipher:${Buffer.from(value).toString('base64')}`);},async decrypt(value){await Promise.resolve();operations.push('decrypt');return {result:Buffer.from(value.toString().slice(7),'base64').toString(),shouldReEncrypt:false};}};
  return {context,data,operations,crypto,files,store:new UploadCredentialStore(files,crypto)};
}
describe('REG-006/007/012 protected credential generations',()=>{
  it('rotates validated ciphertext when every decrypt reports shouldReEncrypt and reopens the same generation',async()=>{
    const f=credentialFixture(),directory=await mkdtemp(path.join(tmpdir(),'ets2-upload-credentials-')),files=new CredentialFiles(directory),store=new UploadCredentialStore(files,f.crypto),name=`generation.${f.context.generation}.bin`;
    try{await store.save(f.context,token);const original=await readFile(path.join(directory,name));let decrypts=0,encrypts=0;
      f.crypto.decrypt=async value=>{await Promise.resolve();decrypts++;return {result:Buffer.from(value.toString().split(':').at(-1)!,'base64').toString(),shouldReEncrypt:true};};f.crypto.encrypt=async value=>{await Promise.resolve();return Buffer.from(`rotated:${++encrypts}:${Buffer.from(value).toString('base64')}`);};
      expect(await store.load(f.context)).toBe(token);const rotated=await readFile(path.join(directory,name));expect(rotated).not.toEqual(original);expect(decrypts).toBe(1);expect(encrypts).toBe(1);expect(await readdir(directory)).toEqual([name]);
      const reopened=new UploadCredentialStore(new CredentialFiles(directory),f.crypto);expect(await reopened.load(f.context)).toBe(token);expect(decrypts).toBe(2);expect(encrypts).toBe(2);expect(await readFile(path.join(directory,name))).not.toEqual(rotated);expect(await readdir(directory)).toEqual([name]);
    }finally{await rm(directory,{recursive:true,force:true});}
  });
  it('preserves the original ciphertext and cleans the synced temporary file if rotation rename fails',async()=>{
    const f=credentialFixture(),directory=await mkdtemp(path.join(tmpdir(),'ets2-upload-credentials-')),files=new CredentialFiles(directory),store=new UploadCredentialStore(files,f.crypto),name=`generation.${f.context.generation}.bin`;
    try{await store.save(f.context,token);const original=await readFile(path.join(directory,name)),decrypt=f.crypto.decrypt;f.crypto.decrypt=async value=>({...await decrypt(value),shouldReEncrypt:true});
      vi.mocked(rename).mockRejectedValueOnce(Error('INJECTED_RENAME_FAILURE'));await expect(store.load(f.context)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(rename).toHaveBeenLastCalledWith(expect.stringMatching(/\.tmp$/),path.join(directory,name));expect(await readFile(path.join(directory,name))).toEqual(original);expect(await readdir(directory)).toEqual([name]);
      f.crypto.decrypt=decrypt;expect(await new UploadCredentialStore(files,f.crypto).load(f.context)).toBe(token);
    }finally{vi.mocked(rename).mockReset();await rm(directory,{recursive:true,force:true});}
  });
  it.each(['unavailable','malformed-json','invalid-token','wrong-context','bad-flag','extra-result-field'] as const)('refuses %s rotation before encryption or replacement',async kind=>{
    const f=credentialFixture();await f.store.save(f.context,token);const name=`generation.${f.context.generation}.bin`,original=f.data.get(name),saved={version:1,context:f.context,token};
    const decrypted:Record<string,unknown>={result:JSON.stringify(saved),shouldReEncrypt:true};if(kind==='unavailable')decrypted.isTemporarilyUnavailable=true;if(kind==='malformed-json')decrypted.result='{';if(kind==='invalid-token')decrypted.result=JSON.stringify({...saved,token:'invalid'});if(kind==='wrong-context')decrypted.result=JSON.stringify({...saved,context:{...f.context,generation:randomUUID()}});if(kind==='bad-flag')decrypted.shouldReEncrypt='true';if(kind==='extra-result-field')decrypted.extra=true;
    f.crypto.decrypt=()=>Promise.resolve(decrypted as Awaited<ReturnType<UploadCryptoPort['decrypt']>>);f.operations.length=0;await expect(f.store.load(f.context)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(f.operations).not.toContain('encrypt');expect(f.data.get(name)).toEqual(original);expect(f.data.size).toBe(1);
  });
  it.each(['encrypt-failure','empty-cipher','oversize-cipher','write-failure'] as const)('keeps the old generation recoverable after rotation %s',async kind=>{
    const f=credentialFixture();await f.store.save(f.context,token);const name=`generation.${f.context.generation}.bin`,original=f.data.get(name),decrypt=f.crypto.decrypt,encrypt=f.crypto.encrypt,write=f.files.write;f.crypto.decrypt=async value=>({...await decrypt(value),shouldReEncrypt:true});
    if(kind==='encrypt-failure')f.crypto.encrypt=()=>Promise.reject(Error('PRIVATE_CRYPTO_FAILURE'));if(kind==='empty-cipher')f.crypto.encrypt=()=>Promise.resolve(Buffer.alloc(0));if(kind==='oversize-cipher')f.crypto.encrypt=()=>Promise.resolve(Buffer.alloc(16385));if(kind==='write-failure')f.files.write=()=>Promise.reject(Error('PRIVATE_WRITE_FAILURE'));
    await expect(f.store.load(f.context)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(f.data.get(name)).toEqual(original);expect(f.data.size).toBe(1);f.crypto.decrypt=decrypt;f.crypto.encrypt=encrypt;f.files.write=write;expect(await new UploadCredentialStore(f.files,f.crypto).load(f.context)).toBe(token);
  });
  it('syncs ciphertext before an external confirm and activates only afterwards; an orphan marker gives no read authority',async()=>{
    const f=credentialFixture();await f.store.save(f.context,token);f.operations.push('commit');await f.store.activate(f.context);
    expect(f.operations.indexOf(`sync:generation.${f.context.generation}.bin`)).toBeLessThan(f.operations.indexOf('commit'));expect(f.operations.indexOf('commit')).toBeLessThan(f.operations.indexOf('sync:active.json'));
    expect(await f.store.load(f.context)).toBe(token);await expect(f.store.load({...f.context,generation:randomUUID()})).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
    await expect(f.store.load({...f.context,owner:{...f.context.owner,accountId:'b'}})).rejects.toThrow('CREDENTIAL_UNAVAILABLE');
  });
  it('has no plaintext fallback and refuses unavailable or malformed rotation after one decrypt',async()=>{
    const f=credentialFixture();f.crypto.available=()=>Promise.resolve(false);await expect(f.store.save(f.context,token)).rejects.toThrow('ENCRYPTION_UNAVAILABLE');expect(f.data.size).toBe(0);
    f.crypto.available=()=>Promise.resolve(true);await f.store.save(f.context,token);let calls=0;f.crypto.decrypt=async()=>{await Promise.resolve();calls++;return {result:'',shouldReEncrypt:true};};await expect(f.store.load(f.context)).rejects.toThrow('CREDENTIAL_UNAVAILABLE');expect(calls).toBe(1);
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
