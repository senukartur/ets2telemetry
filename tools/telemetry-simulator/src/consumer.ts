import {FrameDecoder,V0Consumer,type CurrentState,type ServerMessage,type AppliedState} from '../../../packages/contracts/src/protocol-v0';
/** A narrow test consumer, not an Electron bridge or history sampler. */
export class SnapshotProbe {
  private decoder=new FrameDecoder();
  private guard=new V0Consumer(false);
  private lastReceivedMs:number|undefined;
  private lastObservedReceiveMs:number|undefined;
  private disconnected=true;
  state:CurrentState|undefined;
  applied:Array<{message:ServerMessage;result:AppliedState|undefined}>=[];
  constructor(private readonly diagnostics=false){}
  connect():void {
    if(!this.disconnected)throw new Error('Already connected');
    this.decoder=new FrameDecoder();this.guard=new V0Consumer(this.diagnostics);
    this.disconnected=false;this.lastReceivedMs=undefined;this.state=undefined;
  }
  push(bytes:Uint8Array,receivedMs:number):void {
    if(this.disconnected || !Number.isSafeInteger(receivedMs) || receivedMs<0 || (this.lastObservedReceiveMs!==undefined && receivedMs<this.lastObservedReceiveMs)) throw new Error('Invalid receive boundary');
    this.lastObservedReceiveMs=receivedMs;
    try {
      this.decoder.push(bytes,m=>{
        if(m.kind==='hello'||m.source.origin!=='synthetic') throw new Error('Synthetic source required');
        if(this.applied.length>=2000)throw new Error('Synthetic probe observation limit');
        const result=this.guard.accept(m);
        this.applied.push({message:m,result});
        if(m.kind==='checkpoint'||m.kind==='snapshot') {this.state=structuredClone(m.data.state);this.lastReceivedMs=receivedMs;}
      });
    }catch(error){this.disconnected=true;throw error;}
  }
  end():void {this.disconnected=true;this.decoder.end();}
  stale(nowMs:number,deadlineMs=500):boolean {
    if(!Number.isSafeInteger(nowMs)||nowMs<0||!Number.isSafeInteger(deadlineMs)||deadlineMs<1) throw new Error('Invalid freshness clock');
    if(this.lastReceivedMs!==undefined && nowMs<this.lastReceivedMs) throw new Error('Receive clock moved backwards');
    return this.disconnected||this.lastReceivedMs===undefined||nowMs-this.lastReceivedMs>=deadlineMs;
  }
}
