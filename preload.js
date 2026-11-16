const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('appUpdates', {
  getVersion: () => ipcRenderer.invoke('app:version'),
  check: () => ipcRenderer.invoke('app:check-for-updates'),
  onStatus: callback => {
    if (typeof callback !== 'function') return;
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.removeListener('app:update-status', listener);
  }
});
