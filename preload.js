const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('katastixoNative', {
  all: () => ipcRenderer.invoke('db:all'),
  set: (c, id, data) => ipcRenderer.invoke('db:set', c, id, data),
  del: (c, id) => ipcRenderer.invoke('db:delete', c, id),
  saveFile: (filename, bytes) => ipcRenderer.invoke('file:save', filename, bytes),
  reset: () => ipcRenderer.invoke('db:reset'),
  info: () => ipcRenderer.invoke('app:info'),
  systemDark: () => ipcRenderer.invoke('theme:dark'),
  onSystemTheme: cb => ipcRenderer.on('theme:changed', (_e, dark) => cb(dark))
});
