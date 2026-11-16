const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('browserAutoDesktop', {
  onCommand: callback => ipcRenderer.on('menu-command', (_event, command) => callback(command)),
  ready: () => ipcRenderer.send('renderer-ready'),
});
