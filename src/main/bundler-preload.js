'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('bundler', {
  detectLmms: () => ipcRenderer.invoke('lmms:detect'),
  chooseSource: (mode) => ipcRenderer.invoke('dialog:open', mode),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch { return null; }
  },
  check: (payload) => ipcRenderer.invoke('bundler:check', payload),
  run: (payload) => ipcRenderer.invoke('bundler:run', payload),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  onProgress: (handler) => {
    const listener = (_e, data) => handler(data);
    ipcRenderer.on('bundler:progress', listener);
    return () => ipcRenderer.removeListener('bundler:progress', listener);
  },
});
