import {createHash} from 'node:crypto';
import {readFixtureFile} from './fixture-file';
import {replay,validateScenario} from './scenario';
import {startPipe,consumePipe} from './pipe';
import {checkCadence} from './cadence';
import {replayV1,transcriptLines} from './v1/replay';
import {clientPlan,pipeDifferences,runV1PipeClient,serveV1} from './v1/pipe';
import {checkStateRate,checkV1Cadence} from './v1/cadence';
import {reactiveDifferences,runIndependentClient,serveV1Reactive} from './v1/reactive';

/**
 * `<file> [--scale <real ms per scenario ms>] [--lockstep | --reactive]` of the v1 pipe commands. serve-v1 also takes
 * `--await-scripted-acks` (reactive mode only): serveV1Reactive's `awaitScriptedAcks` for a consumer whose commits may be
 * slower than the 1,000 ms quiesce bound, such as the desktop service in the recording runtime journey.
 */
function v1Args(command:string,args:string[]):{file:string;scale:number;flag:boolean;awaitScriptedAcks:boolean} {
  const flagName=command==='serve-v1'?'--lockstep':'--reactive',awaitName=command==='serve-v1'?' [--await-scripted-acks]':'';
  const usage=`Usage: cli.cjs ${command} <simulator-v1-scenario.json> [--scale <0-10>] [${flagName}]${awaitName}`;
  const [file,...rest]=args;let scale=1,flag=false,awaitScriptedAcks=false;
  for(let i=0;i<rest.length;i++) {
    if(rest[i]==='--scale'&&/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(rest[i+1]??''))scale=Number(rest[++i]);
    else if(rest[i]===flagName&&!flag)flag=true;
    else if(command==='serve-v1'&&rest[i]==='--await-scripted-acks'&&!awaitScriptedAcks)awaitScriptedAcks=true;
    else throw new Error(usage);
  }
  // Lockstep mode follows the scripted client exactly and has no quiesce bound to lift.
  if(!file||(awaitScriptedAcks&&flag))throw new Error(usage);
  return {file,scale,flag,awaitScriptedAcks};
}
const sha256=(lines:string[])=>createHash('sha256').update(lines.map(l=>l+'\n').join('')).digest('hex');

async function main():Promise<void> {
  const [command,file,...extra]=process.argv.slice(2);
  // Protocol v1 deterministic replay (ET-005b); the v0 commands below are unchanged.
  if(command==='replay-v1') {
    if(!file||extra.length)throw new Error('Usage: cli.cjs replay-v1 <simulator-v1-scenario.json>');
    process.stdout.write(transcriptLines(replayV1(readFixtureFile(file))).map(l=>l+'\n').join(''));return;
  }
  // Protocol v1 on an actual synthetic named pipe (ET-005b PR-2). serve-v1 serves any consumer in reactive mode, or only
  // the scenario's scripted client with --lockstep. smoke-v1 runs the scripted client against a lockstep server, or an
  // independent consumer against a reactive server with --reactive, and checks the run against replay-v1.
  if(command==='serve-v1'||command==='smoke-v1') {
    const {file:path,scale,flag,awaitScriptedAcks}=v1Args(command,process.argv.slice(3)),input=readFixtureFile(path);
    const reactive=command==='serve-v1'?!flag:flag;
    const controller=new AbortController();const cancel=()=>controller.abort();process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
    let stop:(()=>Promise<void>)|undefined;
    try {
      if(reactive) {
        const server=await serveV1Reactive(input,{scale,awaitScriptedAcks,signal:controller.signal});stop=server.stop;
        if(command==='serve-v1') {
          console.log(JSON.stringify({origin:'synthetic',mode:'reactive',endpoint:server.endpoint,history:false}));
          const report=await server.done;
          // The verdict of plan item 7 against replay-v1; a cancelled run is not compared.
          const differences=report.cancelled?[]:reactiveDifferences(replayV1(input),report);
          console.log(JSON.stringify({origin:'synthetic',mode:'reactive',scenario:report.scenario.id,cancelled:report.cancelled,connections:report.connections,
            messages:report.transcript.length,refusedClients:report.refusedClients,matchesReplay:report.cancelled?null:differences.length===0,differences,history:false}));
          if(differences.length)process.exitCode=1;
          return;
        }
        const expected=replayV1(input);
        const [client,report]=await Promise.all([runIndependentClient(server.endpoint,input,{seed:1,probe:true,signal:controller.signal}),server.done]);
        if(report.cancelled)throw new Error('Synthetic v1 smoke cancelled');
        const differences=reactiveDifferences(expected,report);
        if(JSON.stringify(client.ledger)!==JSON.stringify(expected.ledger))differences.push('independent client ledger differs from the replay');
        if(differences.length)throw new Error(`Reactive pipe run differs from the deterministic replay: ${differences.join('; ')}`);
        console.log(JSON.stringify({origin:'synthetic',mode:'reactive',scenario:expected.scenario.id,messages:report.transcript.length,connections:report.connections.length,
          clockReplies:client.sessions.reduce((n,s)=>n+s.replies,0),attempts:client.attempts,ledger:client.ledger,history:false}));
        return;
      }
      const server=await serveV1(input,{scale,signal:controller.signal});stop=server.stop;
      if(command==='serve-v1') {
        console.log(JSON.stringify({origin:'synthetic',mode:'lockstep',endpoint:server.endpoint,history:false}));
        const report=await server.done;
        console.log(JSON.stringify({origin:'synthetic',mode:'lockstep',scenario:report.result.scenario.id,cancelled:report.cancelled,connections:report.result.connections.length,
          messages:report.result.transcript.length,transcriptSha256:sha256(transcriptLines(report.result)),refusedClients:report.refusedClients,history:false}));
        return;
      }
      const expected=replayV1(input),plan=clientPlan(expected);
      const [client,report]=await Promise.all([runV1PipeClient(server.endpoint,plan,{scale,signal:controller.signal}),server.done]);
      if(report.cancelled)throw new Error('Synthetic v1 smoke cancelled');
      const differences=pipeDifferences(expected,report.result,client);
      if(differences.length)throw new Error(`Pipe run differs from the deterministic replay: ${differences.join('; ')}`);
      const cadence=scale>0?checkV1Cadence(report.writes,report.result.transcript,new Map(client.connections.map(c=>[c.connection,c.arrivalsMs]))):undefined;
      const mappings=client.connections.flatMap(c=>c.mappings.map(m=>({connection:c.connection,probeId:m.probeId,offsetNs:m.mapping?.offsetNs??null,uncertaintyNs:m.mapping?.uncertaintyNs??null,roundTripNs:m.roundTripNs})));
      const probes=plan.connections.reduce((n,c)=>n+c.actions.filter(a=>a.action==='probe').length,0);
      if(mappings.length!==probes)throw new Error('A clock probe received no reply');
      console.log(JSON.stringify({origin:'synthetic',mode:'lockstep',scenario:expected.scenario.id,messages:report.result.transcript.length,connections:client.connections.length,
        transcriptSha256:sha256(transcriptLines(report.result)),cadence:cadence??null,minStateIntervalNs:checkStateRate(report.result.transcript),mappings,
        refusedClients:report.refusedClients,ledger:client.ledger,history:false}));
    }finally {await stop?.();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
    return;
  }
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
      if(result.freshness.some(f=>!f.freshAtSnapshot||!f.freshBeforeTimeout||!f.staleAfterTimeout||!f.staleAfterDisconnect))throw new Error('Synthetic freshness observation failed');
      console.log(JSON.stringify({origin:'synthetic',messages:result.probe.applied.length,connections:new Set(emissions.map(e=>e.connection)).size,arrivalsMs:result.arrivalsMs,cadence:cadence??null,freshness:result.freshness,history:false}));
    }
    await run.closed;
  }finally {await run.stop();process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);}
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Synthetic replay failed');process.exitCode=1;});
