'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('sp01', Object.freeze({
  subscribe(callback) {
    if (typeof callback !== 'function') throw new TypeError('callback');
    const listener = (_event, value) => callback(value);
    ipcRenderer.on('sp01:snapshot', listener);
    return () => ipcRenderer.removeListener('sp01:snapshot', listener);
  },
}));
