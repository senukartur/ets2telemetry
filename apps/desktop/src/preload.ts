import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge } from '../../../packages/contracts/src';
const bridge: DesktopBridge = {getStatus:() => ipcRenderer.invoke('scaffold:status')};
contextBridge.exposeInMainWorld('desktop',Object.freeze(bridge));
