import type {Buffer} from 'node:buffer';
export interface UploadCryptoPort {available():Promise<boolean>;encrypt(plain:string):Promise<Buffer>;decrypt(cipher:Buffer):Promise<{result:string;shouldReEncrypt:boolean;isTemporarilyUnavailable?:boolean}>}
export interface UploadCredentialFiles {read(name:string,limit:number):Promise<Uint8Array|undefined>;write(name:string,bytes:Uint8Array):Promise<void>;remove(name:string):Promise<void>;names(limit:number):Promise<string[]>}
/** Main-only adapter; the Electron module is supplied after app readiness, never loaded by domain tests. */
export function electronUploadCrypto(storage:Pick<Electron.SafeStorage,'isAsyncEncryptionAvailable'|'encryptStringAsync'|'decryptStringAsync'>):UploadCryptoPort {
  return {available:()=>storage.isAsyncEncryptionAvailable(),encrypt:plain=>storage.encryptStringAsync(plain),decrypt:cipher=>storage.decryptStringAsync(cipher)};
}
