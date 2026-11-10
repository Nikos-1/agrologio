const { contextBridge, ipcRenderer } = require('electron');
// Errors from the main process arrive as "Error invoking remote method 'db:set': Error: …": keep only the Greek message.
const invoke = (...a) => ipcRenderer.invoke(...a).catch(e => { throw new Error(String((e && e.message) || e).replace(/^Error invoking remote method '[^']*': (\w*Error: )?/, '')); });
contextBridge.exposeInMainWorld('katastixoNative', {
  all: () => invoke('db:all'),
  set: (c, id, data) => invoke('db:set', c, id, data),
  del: (c, id) => invoke('db:delete', c, id),
  bulk: ops => invoke('db:bulk', ops),
  backup: prefix => invoke('db:backup', prefix),
  saveFile: (filename, bytes) => invoke('file:save', filename, bytes),
  reset: () => invoke('db:reset'),
  info: () => invoke('app:info'),
  systemDark: () => invoke('theme:dark'),
  onSystemTheme: cb => ipcRenderer.on('theme:changed', (_e, dark) => cb(dark))
});
