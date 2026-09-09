const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPortSettings', {
  get: () => ipcRenderer.invoke('port-settings:get'),
  save: (settings) => ipcRenderer.invoke('port-settings:save', settings),
  close: () => window.close()
});