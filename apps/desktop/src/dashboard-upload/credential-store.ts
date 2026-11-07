import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {mkdir,lstat,open,rename,unlink,opendir} from 'node:fs/promises';
import {strictJson} from '../../../../packages/contracts/src/protocol-v0';
import {dashboardOrigin,isDashboardToken,isDashboardOwner,sameDashboardOwner,uploadShape,uploadOne,uploadUuid,type DashboardOwner} from '../../../../packages/contracts/src/dashboard-upload';
import {registrationCheck,decimal,type UploadRegistration} from '../../../../packages/storage/src/upload-sync';
import type {ReleaseChannel} from '../channel';
import type {UploadCryptoPort,UploadCredentialFiles} from './credential-ports';
export const CREDENTIAL_BYTES=16384;
export interface CredentialContext {generation:string;channel:ReleaseChannel;owner:DashboardOwner;registration:UploadRegistration}
export interface DisconnectIntent {version:1;channel:ReleaseChannel;origin:string;expectedVersion:string}
const fileName=(generation:string)=>{if(!uploadUuid(generation))throw Error('CREDENTIAL_UNAVAILABLE');return `generation.${generation}.bin`;};
const permitted=(name:string)=>/^generation\.[0-9a-f-]{36}\.bin$/.test(name)||name==='active.json'||name==='disconnect.json';
const ownedTemporary=(name:string)=>/^(generation\.[0-9a-f-]{36}\.bin|active\.json|disconnect\.json)\.[0-9a-f-]{36}\.tmp$/.test(name);
const contextCheck=uploadShape({generation:uploadUuid,channel:uploadOne('production','staging'),owner:isDashboardOwner,registration:registrationCheck});
// Do not retain crypto/filesystem exception causes: callers receive only these fixed credential codes.
function credentialFailure(error?:unknown):never {throw Error(error instanceof Error&&error.message==='ENCRYPTION_UNAVAILABLE'?'ENCRYPTION_UNAVAILABLE':'CREDENTIAL_UNAVAILABLE');}
function sameContext(a:CredentialContext,b:CredentialContext):boolean {return a.generation===b.generation&&a.channel===b.channel&&sameDashboardOwner(a.owner,b.owner)&&Object.entries(a.registration).every(([k,v])=>b.registration[k as keyof UploadRegistration]===v)&&a.owner.origin===a.registration.origin&&a.owner.accountId===a.registration.accountId&&a.owner.companyId===a.registration.companyId&&a.owner.identityEpoch===a.registration.identityEpoch;}
/** File bytes are always encrypted or closed nonsecret metadata. Directory enumeration and cleanup are bounded. */
export class CredentialFiles implements UploadCredentialFiles {
  constructor(private readonly root:string){if(!path.isAbsolute(root))throw Error('CREDENTIAL_UNAVAILABLE');}
  async #directory(create=false){if(create)await mkdir(this.root,{recursive:true});const stat=await lstat(this.root);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('CREDENTIAL_UNAVAILABLE');}
  #path(name:string,cleanup=false){if(!permitted(name)&&!(cleanup&&ownedTemporary(name)))throw Error('CREDENTIAL_UNAVAILABLE');return path.join(this.root,name);}
  async read(name:string,limit:number):Promise<Uint8Array|undefined>{try{await this.#directory();const file=this.#path(name),stat=await lstat(file);if(stat.isSymbolicLink()||!stat.isFile())throw Error('CREDENTIAL_UNAVAILABLE');const handle=await open(file,'r');try{const bytes=Buffer.alloc(limit+1);const read=await handle.read(bytes,0,bytes.length,0);if(read.bytesRead>limit)throw Error('CREDENTIAL_UNAVAILABLE');return new Uint8Array(bytes.subarray(0,read.bytesRead));}finally{await handle.close();}}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return undefined;credentialFailure();}}
  async write(name:string,bytes:Uint8Array):Promise<void>{if(bytes.byteLength>CREDENTIAL_BYTES)throw Error('CREDENTIAL_UNAVAILABLE');let temporary:string|undefined;try{await this.#directory(true);const target=this.#path(name);try{const stat=await lstat(target);if(stat.isSymbolicLink()||!stat.isFile())throw Error('CREDENTIAL_UNAVAILABLE');}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))throw error;}
    temporary=path.join(this.root,`${name}.${randomUUID()}.tmp`);const file=await open(temporary,'wx',0o600);try{await file.writeFile(bytes);await file.sync();}finally{await file.close();}await rename(temporary,target);temporary=undefined;
  }catch{credentialFailure();}finally{if(temporary)await unlink(temporary).catch(()=>undefined);}}
  async remove(name:string):Promise<void>{try{await this.#directory();await unlink(this.#path(name,true));}catch(error){if(!(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT'))credentialFailure();}}
  async names(limit:number):Promise<string[]>{try{await this.#directory();const directory=await opendir(this.root),names:string[]=[];try{for await(const entry of directory){if(names.length===limit)break;names.push(entry.name);}}finally{await directory.close().catch(()=>undefined);}return names;}catch(error){if(error&&typeof error==='object'&&'code'in error&&error.code==='ENOENT')return [];credentialFailure();}}
}
export class UploadCredentialStore {
  constructor(private readonly files:UploadCredentialFiles,private readonly crypto:UploadCryptoPort){}
  async #available(){if(!await this.crypto.available())throw Error('ENCRYPTION_UNAVAILABLE');}
  async save(context:CredentialContext,token:string,signal?:AbortSignal):Promise<void>{try{if(!contextCheck(context)||!isDashboardToken(token)||!sameContext(context,context)||signal?.aborted)throw Error('CREDENTIAL_UNAVAILABLE');await this.#available();if(signal?.aborted)throw Error('CREDENTIAL_UNAVAILABLE');
    const existing=await this.files.read(fileName(context.generation),CREDENTIAL_BYTES);if(existing){const saved=await this.load(context);if(saved!==token)throw Error('CREDENTIAL_UNAVAILABLE');return;}
    const cipher=await this.crypto.encrypt(JSON.stringify({version:1,context,token}));if(signal?.aborted||cipher.byteLength===0||cipher.byteLength>CREDENTIAL_BYTES)throw Error('CREDENTIAL_UNAVAILABLE');await this.files.write(fileName(context.generation),cipher);
  }catch(error){credentialFailure(error);}}
  async load(expected:CredentialContext):Promise<string>{try{if(!contextCheck(expected)||!sameContext(expected,expected))throw Error('CREDENTIAL_UNAVAILABLE');await this.#available();const bytes=await this.files.read(fileName(expected.generation),CREDENTIAL_BYTES);if(!bytes||bytes.byteLength===0)throw Error('CREDENTIAL_UNAVAILABLE');let rotate=false;
    for(let count=0;count<2;count++){const decrypted=await this.crypto.decrypt(Buffer.from(bytes));if(decrypted.isTemporarilyUnavailable)throw Error('CREDENTIAL_UNAVAILABLE');if(decrypted.shouldReEncrypt){rotate=true;continue;}
      const value=strictJson(decrypted.result);if(!uploadShape({version:uploadOne(1),context:contextCheck,token:isDashboardToken})(value))throw Error('CREDENTIAL_UNAVAILABLE');const saved=value as {context:CredentialContext;token:string};if(!sameContext(expected,saved.context))throw Error('CREDENTIAL_UNAVAILABLE');
      if(rotate){const replacement=await this.crypto.encrypt(decrypted.result);if(!replacement.length||replacement.length>CREDENTIAL_BYTES)throw Error('CREDENTIAL_UNAVAILABLE');await this.files.write(fileName(expected.generation),replacement);}return saved.token;
    }throw Error('CREDENTIAL_UNAVAILABLE');
  }catch(error){credentialFailure(error);}}
  async activate(context:CredentialContext):Promise<void>{if(!contextCheck(context)||!sameContext(context,context))throw Error('CREDENTIAL_UNAVAILABLE');await this.files.write('active.json',Buffer.from(JSON.stringify({version:1,channel:context.channel,generation:context.generation})));}
  async removeActivation():Promise<void>{await this.files.remove('active.json');}
  async disconnectIntent(intent:DisconnectIntent):Promise<void>{if(!uploadShape({version:uploadOne(1),channel:uploadOne('production','staging'),origin:dashboardOrigin,expectedVersion:decimal})(intent))throw Error('CREDENTIAL_UNAVAILABLE');await this.files.write('disconnect.json',Buffer.from(JSON.stringify(intent)));}
  async readDisconnect():Promise<DisconnectIntent|undefined>{const bytes=await this.files.read('disconnect.json',1024);if(!bytes)return undefined;try{const v=strictJson(new TextDecoder('utf-8',{fatal:true}).decode(bytes));if(!uploadShape({version:uploadOne(1),channel:uploadOne('production','staging'),origin:dashboardOrigin,expectedVersion:decimal})(v))throw Error();return v as DisconnectIntent;}catch{credentialFailure();}}
  async clearDisconnect():Promise<void>{await this.files.remove('disconnect.json');}
  async cleanup(keep:readonly string[],limit=8):Promise<{examined:number;removed:number;more:boolean}>{let removed=0;const names=await this.files.names(limit+keep.length+2);let examined=0;for(const name of names){if(!permitted(name)&&!ownedTemporary(name)||name==='disconnect.json'||name==='active.json'||keep.some(g=>fileName(g)===name))continue;if(examined===limit)break;examined++;await this.files.remove(name);removed++;}return {examined,removed,more:names.length>=limit+keep.length+2};}
}
