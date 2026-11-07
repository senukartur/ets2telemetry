import https from 'node:https';
import type {ClientRequest,IncomingMessage,RequestOptions} from 'node:http';
import {dashboardOrigin,isDashboardToken} from '../../../../packages/contracts/src/dashboard-upload';
import {jsonBody} from './control-response';
export type UploadRoute='connection'|'installations'|'events';
export type UploadHttpResult={ok:true;statusCode:number;body:Uint8Array;retryAfter:string|null}|{ok:false;code:'NETWORK'|'TIMEOUT'|'ABORTED'|'BUSY'|'INVALID_RESPONSE'|'REDIRECT'|'TLS_CONFIGURATION';statusCode:number|null;retryAfter:null};
const TLS_CONFIGURATION_CODES=new Set(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_GET_ISSUER_CERT','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_REVOKED','ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED','ERR_SSL_WRONG_VERSION_NUMBER','ERR_SSL_UNSUPPORTED_PROTOCOL','ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION','ERR_TLS_PROTOCOL_VERSION_CONFLICT','ERR_SSL_NO_SHARED_CIPHER','ERR_SSL_EE_KEY_TOO_SMALL','ERR_SSL_CA_MD_TOO_WEAK','ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC']);
const networkFailure=(error:unknown):'TLS_CONFIGURATION'|'NETWORK'=>error&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&error.code.length<=64&&TLS_CONFIGURATION_CODES.has(error.code)?'TLS_CONFIGURATION':'NETWORK';
export type UploadRequestPort=(options:RequestOptions,listener:(response:IncomingMessage)=>void)=>ClientRequest;
export interface UploadTransport {request(route:UploadRoute,token:string,body?:Uint8Array,signal?:AbortSignal):Promise<UploadHttpResult>;abort():void;close():void}
/** Dedicated Node HTTPS policy. Test composition may inject a request port; release callers supply only a fixed origin. */
export class UploadHttp implements UploadTransport {
  #active:(()=>void)|undefined;
  #closed=false;
  #agent=new https.Agent({keepAlive:false,maxSockets:1,maxTotalSockets:1,maxCachedSessions:0});
  constructor(private readonly origin:string,private readonly send:UploadRequestPort=https.request,private readonly deadlineMs=30000){if(!dashboardOrigin(origin))throw Error('INVALID_UPLOAD_CONFIGURATION');}
  request(route:UploadRoute,token:string,body?:Uint8Array,signal?:AbortSignal):Promise<UploadHttpResult>{
    const fail=(code:Extract<UploadHttpResult,{ok:false}>['code']):UploadHttpResult=>({ok:false,code,statusCode:null,retryAfter:null});
    if(this.#closed||signal?.aborted)return Promise.resolve(fail('ABORTED'));if(this.#active)return Promise.resolve(fail('BUSY'));
    if(!isDashboardToken(token)||!['connection','installations','events'].includes(route)||route==='connection'&&body!==undefined||route!=='connection'&&(!(body instanceof Uint8Array)||body.byteLength>65536))return Promise.resolve(fail('INVALID_RESPONSE'));
    return new Promise(resolve=>{
      let request:ClientRequest|undefined,response:IncomingMessage|undefined,done=false,statusCode:number|null=null,received=0;
      let timer:ReturnType<typeof setTimeout>|undefined;const chunks:Buffer[]=[];
      const finish=(result:UploadHttpResult,destroy=false)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);this.#active=undefined;if(destroy){response?.destroy();request?.destroy();}resolve(result);};
      const failure=(code:Extract<UploadHttpResult,{ok:false}>['code'])=>finish({ok:false,code,statusCode,retryAfter:null},true);
      const abort=()=>failure('ABORTED');this.#active=abort;
      signal?.addEventListener('abort',abort,{once:true});
      timer=setTimeout(()=>failure('TIMEOUT'),this.deadlineMs);timer.unref?.();
      try{
        const url=new URL(this.origin),headers:Record<string,string>={Authorization:`Bearer ${token}`,Accept:'application/json','Accept-Encoding':'identity'};
        if(body){headers['Content-Type']='application/json';headers['Content-Length']=String(body.byteLength);}
        request=this.send({protocol:'https:',hostname:url.hostname,port:url.port||443,path:`/api/telemetry/v1/${route}`,method:route==='connection'?'GET':'POST',agent:this.#agent,maxHeaderSize:16384,insecureHTTPParser:false,headers},incoming=>{
          response=incoming;if(done){incoming.destroy();return;}statusCode=incoming.statusCode??0;
          if(statusCode>=300&&statusCode<400){failure('REDIRECT');return;}
          const critical=new Set<string>();for(let i=0;i<incoming.rawHeaders.length;i+=2){const key=incoming.rawHeaders[i].toLowerCase();if(['content-type','content-encoding','content-length','retry-after'].includes(key)){if(critical.has(key)){failure('INVALID_RESPONSE');return;}critical.add(key);}}
          const contentType=incoming.headers['content-type'],encoding=incoming.headers['content-encoding'];
          if(typeof contentType!=='string'||!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)||encoding!==undefined&&encoding!=='identity'){failure('INVALID_RESPONSE');return;}
          const limit=route!=='events'&&statusCode>=200&&statusCode<300?16384:4096,length=incoming.headers['content-length'];
          if(length!==undefined&&(!/^(0|[1-9][0-9]{0,8})$/.test(length)||Number(length)>limit)){failure('INVALID_RESPONSE');return;}
          incoming.on('data',(chunk:Buffer)=>{if(done)return;received+=chunk.byteLength;if(received>limit){failure('INVALID_RESPONSE');return;}chunks.push(Buffer.from(chunk));});
          incoming.once('aborted',()=>failure('INVALID_RESPONSE'));incoming.once('error',()=>failure('NETWORK'));
          incoming.once('close',()=>{if(!done&&!incoming.complete)failure('INVALID_RESPONSE');});
          incoming.once('end',()=>{
            if(done)return;if(!incoming.complete||length!==undefined&&Number(length)!==received){failure('INVALID_RESPONSE');return;}
            const bytes=new Uint8Array(Buffer.concat(chunks));try{jsonBody(bytes,limit);}catch{failure('INVALID_RESPONSE');return;}
            const advertised=incoming.headers['retry-after'];const retryAfter=typeof advertised==='string'&&advertised.length<=128?advertised:null;
            finish({ok:true,statusCode:statusCode!,body:bytes,retryAfter});
          });
        });
        request.once('error',error=>failure(networkFailure(error)));if(done)request.destroy();else{if(body)request.end(body);else request.end();}
      }catch(error){failure(networkFailure(error));}
    });
  }
  abort():void {this.#active?.();}
  close():void {this.#closed=true;this.abort();this.#agent.destroy();}
}
