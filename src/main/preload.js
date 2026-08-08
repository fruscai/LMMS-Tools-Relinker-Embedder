'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('relinker', {
  /** Open a native picker. mode: 'folder' | 'zip' | 'file' */
  chooseSource: (mode) => ipcRenderer.invoke('dialog:openSource', mode),

  /** Resolve a dropped File object to an absolute path. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  scan: (payload) => ipcRenderer.invoke('job:scan', payload),
  repair: (payload) => ipcRenderer.invoke('job:repair', payload),
  revealOutput: (target) => ipcRenderer.invoke('shell:reveal', target),

  onProgress: (handler) => {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on('job:progress', listener);
    return () => ipcRenderer.removeListener('job:progress', listener);
  },
});
