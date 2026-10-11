// Fixed harmless console fixture; no Electron, installer, observer or native query.
const fs=require('node:fs');const path=require('node:path');const {spawn}=require('node:child_process');
const [mode,directory]=process.argv.slice(2);
if(mode==='leaf'){fs.writeFileSync(path.join(directory,'leaf-'+process.pid+'.json'),JSON.stringify({pid:process.pid,parentPid:process.ppid}));setInterval(()=>{},1000);}
else{
  fs.writeFileSync(path.join(directory,'driver-marker.json'),JSON.stringify({pid:process.pid,parentPid:process.ppid,marker:'SIBLING_NODE_REACHED'}));
  if(['deadline','owner-death','orphan'].includes(mode)){
    const child=spawn(process.execPath,[__filename,'leaf',directory],{detached:true,windowsHide:true,stdio:'ignore'});
    child.once('spawn',()=>{fs.writeFileSync(path.join(directory,'driver-child.json'),JSON.stringify({pid:child.pid}));if(mode==='orphan')process.exit(0);});
    setInterval(()=>{},1000);
  }else{
    const requestStop=()=>{
      fs.writeFileSync(path.join(directory,'observer-stop.json'),'{}');
      const timer=setInterval(()=>{const file=path.join(directory,'job/observer-exit.json');if(fs.existsSync(file)){const proof=JSON.parse(fs.readFileSync(file,'utf8'));clearInterval(timer);process.exit(proof.signaled&&proof.exitCode===0?0:1);}},10);
    };
    // Do not request observer stop or exit before all fixture output is flushed.
    if(mode==='output')process.stdout.write('x'.repeat(2*1024*1024),error=>{if(error)throw error;requestStop();});else requestStop();
  }
}
