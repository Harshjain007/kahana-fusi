const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flow', {
  on: (ch, fn) => ipcRenderer.on(ch, (_e, v) => fn(v)),
  send: buf => ipcRenderer.send('audio', buf),
  data: () => ipcRenderer.invoke('app:data'),
  saveDict: text => ipcRenderer.invoke('dict:save', text),
  learn: (at, text) => ipcRenderer.invoke('learn', at, text),
});
