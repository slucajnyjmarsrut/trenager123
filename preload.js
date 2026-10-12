const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jarvis', {
  ask: text => ipcRenderer.invoke('jarvis:ask', text),
  hasKey: () => ipcRenderer.invoke('jarvis:hasKey'),
  setKey: key => ipcRenderer.invoke('jarvis:setKey', key),
  reset: () => ipcRenderer.invoke('jarvis:reset'),
  addApp: name => ipcRenderer.invoke('jarvis:addApp', name),
  onEvent: cb => ipcRenderer.on('jarvis:event', (_, e) => cb(e)),
});
