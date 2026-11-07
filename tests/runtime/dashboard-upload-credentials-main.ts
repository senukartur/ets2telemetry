// Test-only main entry, built and launched exclusively by the bounded recording runtime wrapper.
import {app,safeStorage} from 'electron';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {UploadCredentialStore,CredentialFiles,type CredentialContext} from '../../apps/desktop/src/dashboard-upload/credential-store';
import {electronUploadCrypto} from '../../apps/desktop/src/dashboard-upload/credential-ports';
const [mode,root]=process.argv.slice(2),marker='ets2telemetry.dashboard-upload.credentials-canary.v1\n';
if(!['write','read'].includes(mode)||!path.isAbsolute(root)||readFileSync(path.join(root,'.canary-root'),'utf8')!==marker)throw Error('INVALID_CANARY_ROOT');
mkdirSync(path.join(root,'userData'),{recursive:true});app.setPath('userData',path.join(root,'userData'));app.setPath('sessionData',path.join(root,'userData'));app.disableHardwareAcceleration();
const token='vtc1_10000000-0000-4000-8000-000000000001_'+'a'.repeat(43),owner={origin:'https://canary.invalid',accountId:'canary',companyId:'canary',identityEpoch:'canary'};
const context:CredentialContext={generation:'20000000-0000-4000-8000-000000000001',channel:'staging',owner,registration:{...owner,registrationId:'30000000-0000-4000-8000-000000000001',clientInstallationId:'40000000-0000-4000-8000-000000000001',installationId:'50000000-0000-4000-8000-000000000001',bindingId:'60000000-0000-4000-8000-000000000001'}};
void app.whenReady().then(async()=>{
  if(process.versions.electron!=='44.7.0'||process.platform!=='win32'||!await safeStorage.isAsyncEncryptionAvailable())throw Error('CANARY_UNAVAILABLE');
  const files=new CredentialFiles(path.join(root,'credentials')),store=new UploadCredentialStore(files,electronUploadCrypto(safeStorage));
  if(mode==='write'){await store.save(context,token);await store.activate(context);const bytes=await files.read(`generation.${context.generation}.bin`,16384);if(!bytes||Buffer.from(bytes).includes(Buffer.from(token)))throw Error('CANARY_PLAINTEXT');writeFileSync(path.join(root,'write.json'),JSON.stringify({passed:true,encryptedOnly:true}));}
  else{if(await store.load(context)!==token)throw Error('CANARY_MISMATCH');let missingRefused=false;try{await store.load({...context,generation:'20000000-0000-4000-8000-000000000002'});}catch{missingRefused=true;}if(!missingRefused)throw Error('CANARY_MISSING');writeFileSync(path.join(root,'read.json'),JSON.stringify({passed:true,restartDecrypted:true,missingGenerationRefused:true}));}
  app.exit(0);
}).catch(()=>{writeFileSync(path.join(root,`${mode}.json`),JSON.stringify({passed:false,error:'CREDENTIAL_CANARY_FAILED'}));app.exit(1);});
