import net,{type Socket} from 'node:net';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {FrameDecoder,V0Consumer,negotiateV0,PROTOCOL_V0,encodeFrame} from '../../../packages/contracts/src/protocol-v0';
import {type Emission} from './scenario';
import {SnapshotProbe,STALE_AFTER_MS} from './consumer';

const PREFIX='\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-';
export interface PipeRun { endpoint:string; closed:Promise<void>; stop:()=>Promise<void> }
export interface PipeOptions { realtime?:boolean; timeoutMs?:number; writeTimeoutMs?:number; signal?:AbortSignal }
/** Node is only a synthetic test server. Native DACL and authenticated peers belong to ET-004a. */
export async function startPipe(emissions:Emission[],options:PipeOptions={}):Promise<PipeRun> {
  if(process.platform!=='win32') throw new Error('This smoke requires actual Windows Named Pipes');
  const timeoutMs=options.timeoutMs??5000,writeTimeoutMs=options.writeTimeoutMs??1000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000||!Number.isSafeInteger(writeTimeoutMs)||writeTimeoutMs<1||writeTimeoutMs>timeoutMs) throw new Error('Invalid bounded timeout');
  if(!emissions.length||emissions.length>2000) throw new Error('Invalid bounded emissions');
  let bytes=0;
  let lastConnection=0,lastAtMs=0,guard=new V0Consumer(true);
  for(const emission of emissions) {
    if(!Number.isSafeInteger(emission.atMs)||emission.atMs<lastAtMs||emission.atMs>86_400_000||!Number.isSafeInteger(emission.connection)||emission.connection<1||emission.connection>lastConnection+1||emission.connection<lastConnection)throw new Error('Invalid replay boundary');
    if(emission.connection!==lastConnection){guard=new V0Consumer(true);lastConnection=emission.connection;}
    lastAtMs=emission.atMs;guard.accept(emission.message);
    if(emission.message.source.origin!=='synthetic'||!Buffer.from(encodeFrame(emission.message)).equals(Buffer.from(emission.frame)))throw new Error('Valid synthetic wire source required');
    bytes+=emission.frame.length;if(bytes>16*1024*1024)throw new Error('Synthetic replay byte limit');
  }
  const sessions=[...new Set(emissions.map(e=>e.connection))].map(n=>emissions.filter(e=>e.connection===n));
  const endpoint=PREFIX+process.pid+'-'+randomUUID();
  const sockets=new Set<Socket>();let index=0,activeSocket:Socket|undefined,stopping=false;
  let resolveClosed!:()=>void,rejectClosed!:(e:Error)=>void;
  const closed=new Promise<void>((resolve,reject)=>{resolveClosed=resolve;rejectClosed=reject;});
  // Attach a handler immediately; callers can await the same rejecting promise later.
  void closed.catch(()=>{});
  let timer:NodeJS.Timeout|undefined;
  const controller=new AbortController();
  function finish(error?:Error):void {
    if(stopping)return;stopping=true;controller.abort();if(timer)clearTimeout(timer);
    options.signal?.removeEventListener('abort',abort);
    for(const socket of sockets)socket.destroy();
    server.close(()=>error?rejectClosed(error):resolveClosed());
  }
  const abort=()=>finish();
  const server=net.createServer(socket=>{
    if(activeSocket||stopping){socket.destroy();return;}
    activeSocket=socket;sockets.add(socket);
    const decoder=new FrameDecoder();let started=false,completed=false;
    const handshake=setTimeout(()=>finish(new Error('Synthetic handshake timeout')),writeTimeoutMs);
    socket.on('error',error=>{if(!stopping)finish(error);});
    socket.on('close',()=>{clearTimeout(handshake);sockets.delete(socket);if(activeSocket===socket)activeSocket=undefined;if(!completed&&!stopping)finish(new Error('Synthetic client disconnected before replay completed'));});
    socket.on('data',chunk=>{
      try {
        decoder.push(chunk,message=>{
          if(started)throw new Error('Only one synthetic hello is accepted');
          const negotiated=negotiateV0(message);started=true;clearTimeout(handshake);
          const current=sessions[index++];if(!current)throw new Error('Replay sessions exhausted');
          const welcome=current[0].message;
          if(welcome.kind!=='welcome'||(welcome.data.diagnostics&&!negotiated.diagnostics))throw new Error('This diagnostic fixture requires explicit client opt-in');
          void (async()=>{
            try {
              const sessionStart=performance.now();
              for(const emission of current) {
                // Schedule from the session start so timer and write latency do not accumulate.
                const waitMs=emission.atMs-current[0].atMs-(performance.now()-sessionStart);
                if(options.realtime&&waitMs>0)await delay(Math.ceil(waitMs),undefined,{signal:controller.signal});
                await new Promise<void>((resolve,reject)=>{
                  const deadline=setTimeout(()=>{socket.destroy();reject(new Error('Synthetic write deadline exceeded'));},writeTimeoutMs);
                  socket.write(emission.frame,error=>{clearTimeout(deadline);if(error)reject(error);else resolve();});
                });
              }
              completed=true;
              socket.end(()=>{if(activeSocket===socket)activeSocket=undefined;if(index===sessions.length)finish();});
            }catch(error){if(!stopping)finish(error instanceof Error?error:new Error('Synthetic replay failed'));}
          })();
        });
      }catch(error){finish(error instanceof Error?error:new Error('Synthetic hello failed'));}
    });
    socket.on('end',()=>{try{decoder.end();}catch(error){if(!stopping)finish(error as Error);}});
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,()=>{server.removeListener('error',reject);resolve();});});
  server.on('error',error=>finish(error));
  timer=setTimeout(()=>finish(new Error('Synthetic replay deadline exceeded')),timeoutMs);
  options.signal?.addEventListener('abort',abort,{once:true});
  if(options.signal?.aborted)finish();
  return {endpoint,closed,stop:async()=>{finish();await closed;}};
}
/** Snapshot receipt and timeout checks precede disconnect; diagnostics do not refresh state. */
export interface ConnectionFreshness { connection:number; freshAtSnapshot:boolean; freshBeforeTimeout:boolean; freshAtLastMessage:boolean; staleAfterTimeout:boolean; staleAfterDisconnect:boolean }
export async function consumePipe(endpoint:string,connections:number,timeoutMs=5000,diagnostics=false):Promise<{probe:SnapshotProbe;arrivalsMs:number[];freshness:ConnectionFreshness[]}> {
  if(!endpoint.startsWith(PREFIX)||!/^\\\\\.\\pipe\\ETS2Telemetry-SYNTHETIC-TEST-v0-[0-9]+-[0-9a-f-]{36}$/.test(endpoint)) throw new Error('Private synthetic endpoint required');
  if(!Number.isInteger(connections)||connections<1||connections>1000)throw new Error('Invalid connection count');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60_000)throw new Error('Invalid consumer timeout');
  const probe=new SnapshotProbe(diagnostics),arrivalsMs:number[]=[],freshness:ConnectionFreshness[]=[];const start=performance.now();
  for(let connection=0;connection<connections;connection++) {
    probe.connect();
    await new Promise<void>((resolve,reject)=>{
      let cleanEnd=false,lastReceivedMs:number|undefined,lastSnapshotMs:number|undefined,freshAtSnapshot=true;
      const socket=net.connect(endpoint);const deadline=setTimeout(()=>{socket.destroy();reject(new Error('Synthetic consumer deadline exceeded'));},timeoutMs);
      socket.on('connect',()=>socket.write(encodeFrame({version:PROTOCOL_V0,kind:'hello',data:{clientInstanceId:randomUUID(),minMinor:0,maxMinor:0,diagnostics}})));
      socket.on('data',chunk=>{try{
        const before=probe.applied.length;lastReceivedMs=Math.floor(performance.now()-start);probe.push(chunk,lastReceivedMs);
        for(let i=before;i<probe.applied.length;i++){
          arrivalsMs.push(performance.now()-start);
          const kind=probe.applied[i].message.kind;
          if(kind==='checkpoint'||kind==='snapshot'){
            lastSnapshotMs=lastReceivedMs;freshAtSnapshot=freshAtSnapshot&&!probe.stale(lastSnapshotMs);
            if(!freshAtSnapshot)throw new Error('Synthetic snapshot receipt freshness failed');
          }
        }
      }catch(error){clearTimeout(deadline);socket.destroy();reject(error instanceof Error?error:new Error('Synthetic consumer failed',{cause:error}));}});
      socket.on('error',error=>{clearTimeout(deadline);reject(error);});
      socket.on('end',()=>{
        try {
          if(lastReceivedMs===undefined||lastSnapshotMs===undefined||!probe.state)throw new Error('Synthetic connection ended before hydration');
          // Evaluate while connected against snapshot receive time, never diagnostic receive time.
          const freshAtLastMessage=!probe.stale(lastReceivedMs),freshBeforeTimeout=!probe.stale(lastSnapshotMs+STALE_AFTER_MS-1),staleAfterTimeout=probe.stale(lastSnapshotMs+STALE_AFTER_MS);
          if(!freshBeforeTimeout||!staleAfterTimeout)throw new Error('Synthetic snapshot timeout freshness failed');
          probe.end();if(!probe.state)throw new Error('Synthetic connection ended before hydration');
          freshness.push({connection:connection+1,freshAtSnapshot,freshBeforeTimeout,freshAtLastMessage,staleAfterTimeout,staleAfterDisconnect:probe.stale(lastReceivedMs)});cleanEnd=true;
        }catch(error){clearTimeout(deadline);socket.destroy();reject(error instanceof Error?error:new Error('Synthetic consumer failed',{cause:error}));}
      });
      socket.on('close',()=>{clearTimeout(deadline);if(cleanEnd)resolve();else reject(new Error('Synthetic connection closed before clean EOF'));});
    });
  }
  return {probe,arrivalsMs,freshness};
}
