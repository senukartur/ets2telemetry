import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {build} from 'vite';
/** Runs only inside Invoke-RuntimeSmoke's existing Job, before any recording source or app is launched. */
export async function observeUploadCredentials(config){
  assert.equal(config.scenario,'recording');assert.ok(path.isAbsolute(config.output));assert.equal(path.dirname(config.profile),config.output);assert.equal(path.dirname(config.cwd),config.output);
  const root=path.join(config.output,'upload-credentials-canary');await mkdir(root);await writeFile(path.join(root,'.canary-root'),'ets2telemetry.dashboard-upload.credentials-canary.v1\n',{flag:'wx'});
  await build({configFile:false,root:config.checkout,logLevel:'silent',build:{outDir:root,emptyOutDir:false,minify:false,lib:{entry:path.join(config.checkout,'tests/runtime/dashboard-upload-credentials-main.ts'),formats:['cjs'],fileName:()=> 'main.cjs'},rollupOptions:{external:['electron',/^node:/]}}});
  const require=createRequire(path.join(config.checkout,'package.json')),executable=require('electron');
  for(const mode of ['write','read']){
    const env={...process.env,LOCALAPPDATA:root,APPDATA:root,USERPROFILE:root};delete env.ELECTRON_RUN_AS_NODE;
    const code=await new Promise((resolve,reject)=>{const child=spawn(executable,[path.join(root,'main.cjs'),mode,root],{cwd:root,env,stdio:'ignore',windowsHide:true});let expired=false;const timer=setTimeout(()=>{expired=true;child.kill();},10000);child.once('error',()=>{clearTimeout(timer);reject(Error('CREDENTIAL_CANARY_START_FAILED'));});child.once('close',code=>{clearTimeout(timer);expired?reject(Error('CREDENTIAL_CANARY_DEADLINE')):resolve(code);});});
    assert.equal(code,0,'CREDENTIAL_CANARY_FAILED');
  }
  const write=JSON.parse(await readFile(path.join(root,'write.json'),'utf8')),read=JSON.parse(await readFile(path.join(root,'read.json'),'utf8'));
  assert.deepEqual(write,{passed:true,encryptedOnly:true});assert.deepEqual(read,{passed:true,restartDecrypted:true,missingGenerationRefused:true});
  return {passed:true,encryptedOnly:true,restartDecrypted:true,missingGenerationRefused:true,electron:'44.7.0',processes:2};
}
