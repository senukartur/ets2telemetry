import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {IncomingMessage,ClientRequest,RequestOptions} from 'node:http';
import {randomUUID} from 'node:crypto';
import {it,expect,vi,afterEach} from 'vitest';
import {QualificationHttp,type QualificationRequestPort} from '../../apps/desktop/src/qualification/http';
const token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`;
afterEach(()=>vi.useRealTimers());
function fixture(){let options:RequestOptions|undefined,reply:((r:IncomingMessage)=>void)|undefined;const request=new EventEmitter() as ClientRequest;request.end=vi.fn(()=>request);request.destroy=vi.fn(()=>request);
  const send:QualificationRequestPort=(o,fn)=>{options=o;reply=fn;return request;};const http=new QualificationHttp('https://dashboard.example',send);
  const respond=(status=200,headers:Record<string,string>={'content-type':'application/json'},complete=true)=>{const stream=new PassThrough() as PassThrough&IncomingMessage;Object.assign(stream,{statusCode:status,headers,rawHeaders:Object.entries(headers).flat(),complete});reply!(stream);return stream;};return {http,request,respond,options:()=>options};}
it('REG-010/011 isolates cookies, fixes routes and bearer, keeps one flight including controls, rejects redirects',async()=>{
  const f=fixture(),first=f.http.request('capabilities',token);expect(f.options()).toMatchObject({protocol:'https:',hostname:'dashboard.example',path:'/api/telemetry/companion/v1/capabilities',method:'GET',maxHeaderSize:16384});expect(f.options()?.headers).toEqual({Authorization:`Bearer ${token}`,Accept:'application/json','Accept-Encoding':'identity'});
  expect(await f.http.request('results',token,Buffer.from('{}'))).toMatchObject({ok:false,code:'BUSY'});f.respond(302,{'content-type':'application/json',location:'https://evil.example'});expect(await first).toMatchObject({ok:false,code:'REDIRECT'});expect(f.request.destroy).toHaveBeenCalled();f.http.close();
});
it.each([
  ['duplicate',Buffer.from('{"a":1,"a":2}'),{'content-type':'application/json'},true],
  ['invalid UTF8',Buffer.from([255]),{'content-type':'application/json'},true],
  ['compressed',Buffer.from('{}'),{'content-type':'application/json','content-encoding':'gzip'},true],
  ['cookie',Buffer.from('{}'),{'content-type':'application/json','set-cookie':'private=refused'},true],
  ['wrong media',Buffer.from('{}'),{'content-type':'text/html'},true],
  ['truncated',Buffer.from('{}'),{'content-type':'application/json'},false],
  ['oversize',Buffer.alloc(1048577,32),{'content-type':'application/json'},true]
] as const)('REG-010/011 rejects %s without exposing raw response',async(_name,body,headers,complete)=>{
  const f=fixture(),pending=f.http.request('results',token,Buffer.from('{}')),stream=f.respond(202,headers,complete);stream.end(body);expect(await pending).toMatchObject({ok:false,code:'INVALID_RESPONSE'});f.http.close();
});
it('REG-011 aborts the absolute deadline during a stalled body and supports synchronous stop cancellation',async()=>{
  vi.useFakeTimers();const f=fixture(),pending=f.http.request('capabilities',token);f.respond();await vi.advanceTimersByTimeAsync(10000);expect(await pending).toMatchObject({ok:false,code:'TIMEOUT'});const next=f.http.request('capabilities',token);f.http.abort();expect(await next).toMatchObject({ok:false,code:'ABORTED'});f.http.close();
});
it.each(['UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','CERT_HAS_EXPIRED','ECONNRESET'])('REG-010/011 sanitizes %s into configuration hold or transient network failure',async code=>{
  const f=fixture(),pending=f.http.request('capabilities',token);f.request.emit('error',Object.assign(Error('must never be returned'),{code}));expect(await pending).toEqual({ok:false,code:code==='ECONNRESET'?'NETWORK':'TLS_CONFIGURATION',statusCode:null,retryAfter:null});f.http.close();
});
