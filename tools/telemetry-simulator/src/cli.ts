import {readFixtureFile} from './fixture-file';
import {replay,validateScenario} from './scenario';
import {startPipe,consumePipe} from './pipe';
import {checkCadence} from './cadence';

async function main():Promise<void> {
  const [command,file,...extra]=process.argv.slice(2);
  if(!['replay','serve','smoke'].includes(command)||!file||extra.length)throw new Error('Usage: cli.cjs replay|serve|smoke <synthetic-fixture.json>');
  const scenario=validateScenario(readFixtureFile(file)),emissions=replay(scenario);
  if(command==='replay') {for(const {connection,atMs,message} of emissions)console.log(JSON.stringify({scenario:scenario.id,origin:'synthetic',connection,atMs,message}));return;}
  const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  const run=await startPipe(emissions,{realtime:true,signal:controller.signal});
  try {
    if(command==='serve')console.log(JSON.stringify({origin:'synthetic',endpoint:run.endpoint,history:false,timeoutMs:5000}));
    else {
      const result=await consumePipe(run.endpoint,new Set(emissions.map(e=>e.connection)).size,5000,scenario.diagnostics??false);
      if(result.probe.applied.length!==emissions.length)throw new Error('Missing synthetic messages');
      result.probe.applied.forEach(({message},i)=>{if(JSON.stringify(message)!==JSON.stringify(emissions[i].message))throw new Error('Wire replay differs from deterministic source');});
      const cadence=checkCadence(emissions,result.arrivalsMs);
      if(result.freshness.some(f=>!f.freshAtLastMessage||!f.staleAfterTimeout||!f.staleAfterDisconnect))throw new Error('Synthetic freshness observation failed');
      console.log(JSON.stringify({origin:'synthetic',messages:result.probe.applied.length,connections:new Set(emissions.map(e=>e.connection)).size,arrivalsMs:result.arrivalsMs,cadence:cadence??null,freshness:result.freshness,history:false}));
    }
    await run.closed;
  }finally {await run.stop();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Synthetic replay failed');process.exitCode=1;});
