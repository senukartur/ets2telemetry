import {describe,it,expect,vi} from 'vitest';
import {dashboardUploadPreload,UPLOAD_CHANNELS} from '../../apps/desktop/src/dashboard-upload/contract';
import {initialDashboardUploadStatus} from '../../packages/contracts/src/dashboard-upload';
describe('REG-010/012 upload preload',()=>{
  it('rejects extra args, token transformations and URL objects before IPC',async()=>{
    const invoke=vi.fn(()=>Promise.resolve(initialDashboardUploadStatus(null))),bridge=dashboardUploadPreload({invoke,on:vi.fn(),removeListener:vi.fn()});
    for(const [method,args] of [['getDashboardUploadContext',[{}]],['verifyDashboardUploadToken',[' vtc1_bad']],['confirmDashboardUpload',[{origin:'https://evil.example'}]],['disconnectDashboardUpload',[true]]] as const)await expect(Reflect.apply(bridge[method],bridge,args)).rejects.toThrow('INVALID_UPLOAD_REQUEST');
    expect(invoke).not.toHaveBeenCalled();await expect(bridge.getDashboardUploadContext()).resolves.toMatchObject({state:'unavailable'});expect(invoke).toHaveBeenCalledExactlyOnceWith(UPLOAD_CHANNELS.context);
  });
  it('rejects secret-bearing replies and ignores malformed pushes; unsubscribe removes only its listener',async()=>{
    let receive:((event:unknown,value:unknown)=>void)|undefined;const removeListener=vi.fn(),port={invoke:vi.fn(()=>Promise.resolve({...initialDashboardUploadStatus(null),token:'hidden'})),on:vi.fn((_channel,fn)=>{receive=fn;}),removeListener};const bridge=dashboardUploadPreload(port);
    await expect(bridge.getDashboardUploadContext()).rejects.toThrow('INVALID_UPLOAD_REPLY');const listener=vi.fn(),unsubscribe=bridge.subscribeDashboardUpload(listener);receive?.({},{});expect(listener).not.toHaveBeenCalled();receive?.({},initialDashboardUploadStatus(null));expect(listener).toHaveBeenCalledOnce();unsubscribe();expect(removeListener).toHaveBeenCalledWith(UPLOAD_CHANNELS.status,receive);
  });
});

it('REG-010/012 provides exactly the existing six safe upload methods for the Account controller', () => {
  const bridge = dashboardUploadPreload({invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn()});
  expect(Object.keys(bridge)).toEqual(['getDashboardUploadContext', 'verifyDashboardUploadToken', 'confirmDashboardUpload', 'cancelDashboardUpload', 'disconnectDashboardUpload', 'subscribeDashboardUpload']);
});
