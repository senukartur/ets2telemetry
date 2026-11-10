import {describe,it,expect,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {initialDashboardUploadStatus,isDashboardUploadStatus,isDashboardToken,isReleaseDashboardOrigin} from '../../packages/contracts/src/dashboard-upload';
import {configuredDashboardOrigin} from '../../apps/desktop/src/dashboard-upload/config';
import {ACTIVE_CHANNEL, RELEASE_CHANNELS} from '../../apps/desktop/src/channel';
import {connectionResponse,registrationResponse,jsonBody} from '../../apps/desktop/src/dashboard-upload/control-response';
import {isUploadServiceRequest,isUploadServiceCancel,isUploadServiceReply,uploadReplyMatches} from '../../apps/desktop/src/dashboard-upload/service-contract';
const bytes=(v:unknown)=>Buffer.from(JSON.stringify(v));
const token=`vtc1_${randomUUID()}_${'a'.repeat(43)}`;
describe('REG-010/012 closed Dashboard upload boundaries',()=>{
  it('leaves an unconfigured build offline and rejects loopback, paths and credential URLs',()=>{
    expect(configuredDashboardOrigin('production')).toBeNull();expect(configuredDashboardOrigin('staging')).toBeNull();
    for(const value of ['https://localhost','https://127.0.0.1','https://[::1]','http://dashboard.example','https://dashboard.example/','https://user@dashboard.example'])expect(isReleaseDashboardOrigin(value)).toBe(false);
  });
  it('uses the embedded origin for the active channel only',()=>{
    const origin = 'https://dashboard.example';
    vi.stubGlobal('__ETS2TELEMETRY_DASHBOARD_ORIGIN__', origin);
    try {
      expect(configuredDashboardOrigin(ACTIVE_CHANNEL)).toBe(origin);
      const otherChannel = RELEASE_CHANNELS.find(channel => channel !== ACTIVE_CHANNEL)!;
      expect(configuredDashboardOrigin(otherChannel)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('fails closed when the embedded origin is invalid',()=>{
    vi.stubGlobal('__ETS2TELEMETRY_DASHBOARD_ORIGIN__', 'http://dashboard.example');
    try {
      expect(()=>configuredDashboardOrigin(ACTIVE_CHANNEL)).toThrow('INVALID_UPLOAD_CONFIGURATION');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('rejects an invalid staging build origin before bundling',async()=>{
    const env: NodeJS.ProcessEnv = {...process.env, ETS2TELEMETRY_DASHBOARD_ORIGIN: 'http://dashboard.example'};
    delete env.ETS2TELEMETRY_BUILD_CHANNEL;
    delete env.ETS2TELEMETRY_STAGING_RUN_NUMBER;
    await expect(promisify(execFile)(process.execPath, ['scripts/build.mjs'], {env, timeout: 8000}))
      .rejects.toThrow('ETS2TELEMETRY_DASHBOARD_ORIGIN must be a canonical non-loopback HTTPS origin.');
  }, 10000);
  it('never trims or transforms the exact bounded ASCII token',()=>{expect(isDashboardToken(token)).toBe(true);for(const value of [` ${token}`,`${token}\n`,token.replace('vtc1','VTC1'),'x'.repeat(129),null])expect(isDashboardToken(value)).toBe(false);});
  it('validates actual pinned control responses and caps compatible limits',()=>{
    const response={contract:{major:1,minor:0},accountId:'a',companyId:'c',identityEpoch:'e',limits:{maxEventBytes:100000,maxDepth:20,eventsPerMinute:120,burst:30}};
    expect(connectionResponse(bytes(response))?.limits).toEqual({maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10});
    for(const change of [{versions:[1]},{contract:{major:2,minor:0}},{limits:{...response.limits,maxEventBytes:65535}}])expect(connectionResponse(bytes({...response,...change}))).toBeUndefined();
    const owner={origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'e'},registered={contract:{major:1,minor:0},installationId:randomUUID(),bindingId:randomUUID(),identityEpoch:'e'};
    expect(registrationResponse(bytes(registered),owner)).toEqual(registered);expect(registrationResponse(bytes({...registered,identityEpoch:'new'}),owner)).toBeUndefined();
  });
  it('accepts the Dashboard numeric identityEpoch as the owner key decimal text',()=>{
    const response={contract:{major:1,minor:0},accountId:'a',companyId:'c',identityEpoch:2,limits:{maxEventBytes:65536,maxDepth:16,eventsPerMinute:60,burst:10}};
    expect(connectionResponse(bytes(response))).toMatchObject({accountId:'a',companyId:'c',identityEpoch:'2'});
    for(const identityEpoch of [-1,1.5,2**53,'',null,true])expect(connectionResponse(bytes({...response,identityEpoch}))).toBeUndefined();
    const owner={origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'2'},registered={contract:{major:1,minor:0},installationId:randomUUID(),bindingId:randomUUID(),identityEpoch:2};
    expect(registrationResponse(bytes(registered),owner)).toEqual({...registered,identityEpoch:'2'});
    for(const identityEpoch of [3,'3'])expect(registrationResponse(bytes({...registered,identityEpoch}),owner)).toBeUndefined();
  });
  it('rejects duplicate keys, invalid UTF8, excessive depth and secret-bearing safe DTOs',()=>{
    for(const body of [Buffer.from('{"a":1,"a":2}'),Buffer.from([0xff]),Buffer.from('['.repeat(17)+'0'+']'.repeat(17))])expect(()=>jsonBody(body,16384)).toThrow();
    const status=initialDashboardUploadStatus(null);expect(isDashboardUploadStatus(status)).toBe(true);expect(isDashboardUploadStatus({...status,token})).toBe(false);
    const request={type:'dashboard-upload:request',id:randomUUID(),generation:randomUUID(),command:{action:'verify',token}};expect(isUploadServiceRequest(request)).toBe(true);expect(isUploadServiceRequest({...request,origin:'https://evil.example'})).toBe(false);
    const cancel={type:'dashboard-upload:cancel',generation:randomUUID()};expect(isUploadServiceCancel(cancel)).toBe(true);expect(isUploadServiceCancel({...cancel,token})).toBe(false);expect(isUploadServiceCancel({...cancel,generation:'old'})).toBe(false);
  });
  it('keeps private activation status closed, safe and command-specific',()=>{
    const command={action:'activate' as const,token,generation:randomUUID(),version:'1'},status={...initialDashboardUploadStatus('https://dashboard.example'),state:'paused' as const,owner:{origin:'https://dashboard.example',accountId:'a',companyId:'c',identityEpoch:'e'},error:'VALIDATION' as const},reply={ok:true as const,value:{kind:'settled' as const,status}};
    expect(isUploadServiceReply(reply)).toBe(true);expect(uploadReplyMatches(command,reply)).toBe(true);expect(uploadReplyMatches(command,{ok:true,value:{kind:'settled'}})).toBe(false);expect(uploadReplyMatches({action:'suspend'},reply)).toBe(false);
    expect(isUploadServiceReply({...reply,value:{...reply.value,status:{...status,token}}})).toBe(false);expect(isUploadServiceReply({...reply,value:{...reply.value,payload:new Uint8Array([1])}})).toBe(false);
  });
});
