import type {QualificationGame} from '../../../../packages/contracts/src/qualification';
export type QualificationTask = QualificationGame | 'results' | 'preview' | 'capabilities';
export interface QualificationClock {now():number;random():number;setTimeout(callback:()=>void,ms:number):unknown;clearTimeout(timer:unknown):void}
export const qualificationClock:QualificationClock={now:()=>Date.now(),random:()=>Math.random(),setTimeout:(fn,ms)=>{const timer=setTimeout(fn,ms);timer.unref?.();return timer;},clearTimeout:timer=>clearTimeout(timer as ReturnType<typeof setTimeout>)};
const tasks:QualificationTask[]=['capabilities','ets2','ats','results','preview'];
/** One fair companion flight, at most 60 dispatches/minute; each operation also keeps its five-second minimum. */
export class QualificationScheduler {
  #due=new Map<QualificationTask,number>();#last=new Map<QualificationTask,number>();#cursor=0;#timer:unknown;#busy=false;#stopped=false;#next=0;
  constructor(private readonly run:(task:QualificationTask)=>Promise<number>,private readonly time:QualificationClock=qualificationClock){}
  request(task:QualificationTask):void {if(this.#stopped)return;this.#due.set(task,Math.min(this.#due.get(task)??Infinity,Math.max(this.time.now(),(this.#last.get(task)??-Infinity)+5000)));this.#schedule();}
  #schedule():void {
    if(this.#stopped||this.#busy)return;this.time.clearTimeout(this.#timer);if(!this.#due.size)return;
    const at=Math.max(this.#next,Math.min(...this.#due.values()));this.#timer=this.time.setTimeout(()=>{this.#timer=undefined;void this.#tick();},Math.max(0,at-this.time.now()));
  }
  async #tick():Promise<void> {
    if(this.#stopped||this.#busy)return;const now=this.time.now();
    for(let offset=0;offset<tasks.length;offset++){
      const index=(this.#cursor+offset)%tasks.length,task=tasks[index];if((this.#due.get(task)??Infinity)>now)continue;
      this.#cursor=(index+1)%tasks.length;this.#due.delete(task);this.#last.set(task,now);this.#next=now+1000;this.#busy=true;
      try{const delay=await this.run(task);if(!this.#stopped&&Number.isFinite(delay))this.#due.set(task,Math.min(this.#due.get(task)??Infinity,Math.max(now+5000,this.time.now()+delay)));}
      catch{if(!this.#stopped)this.#due.set(task,this.time.now()+5000);}
      finally{this.#busy=false;this.#schedule();}return;
    }
    this.#schedule();
  }
  stop():void {this.#stopped=true;this.time.clearTimeout(this.#timer);this.#due.clear();}
}
export function qualificationRetry(streak:number,retryAfter:string|null,now:number,random:number):number {
  const jitter=Math.floor(Math.max(0,Math.min(1,random))*Math.min(60000,2000*2**Math.min(9,Math.max(0,streak-1))));
  if(!retryAfter)return jitter;
  const seconds=/^[0-9]{1,9}$/.test(retryAfter)?Number(retryAfter)*1000:Date.parse(retryAfter)-now;
  return Math.max(jitter,Number.isFinite(seconds)?Math.max(0,Math.min(86400000,seconds)):0);
}
