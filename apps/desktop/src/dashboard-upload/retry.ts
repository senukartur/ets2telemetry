export const UPLOAD_RETRY_BASE_MS=2000,UPLOAD_RETRY_CAP_MS=300000;
export function retryAfter(value:string|null,now:number):number {
  if(value===null||value.length>128)return 0;
  if(/^[0-9]{1,9}$/.test(value))return Math.min(UPLOAD_RETRY_CAP_MS,Number(value)*1000);
  if(!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT$/.test(value))return 0;
  const parsed=Date.parse(value);return Number.isFinite(parsed)?Math.min(UPLOAD_RETRY_CAP_MS,Math.max(0,parsed-now)):0;
}
export function uploadRetryDelay(streak:number,advertised:string|null,now:number,random:()=>number=Math.random):number {
  const ceiling=Math.min(UPLOAD_RETRY_CAP_MS,UPLOAD_RETRY_BASE_MS*2**Math.max(0,Math.min(8,streak-1)));
  return Math.max(1,Math.floor(Math.max(0,Math.min(1,random()))*ceiling),retryAfter(advertised,now));
}
export class UploadRate {
  #tokens:number;#at:number;
  constructor(private rate=60,private burst=10,now=0){this.#tokens=burst;this.#at=now;}
  configure(rate:number,burst:number){this.rate=Math.max(1,Math.min(60,rate));this.burst=Math.max(1,Math.min(10,burst));this.#tokens=Math.min(this.#tokens,this.burst);}
  delay(now:number,consume=true):number {this.#tokens=Math.min(this.burst,this.#tokens+Math.max(0,now-this.#at)*this.rate/60000);this.#at=Math.max(now,this.#at);if(this.#tokens>=1){if(consume)this.#tokens--;return 0;}return Math.ceil((1-this.#tokens)*60000/this.rate);}
}
