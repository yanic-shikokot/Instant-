const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fieldInspectDesktop', {
  platform: process.platform,
  version: process.versions.electron,
  checkForUpdates: () => {
    try {
      return ipcRenderer.invoke('fieldinspect:check-for-updates');
    } catch (_) {
      return Promise.resolve({ status: 'unavailable' });
    }
  },
  installUpdate: () => {
    try {
      return ipcRenderer.invoke('fieldinspect:install-update');
    } catch (_) {
      return Promise.resolve(false);
    }
  },
  getVersion: () => {
    try {
      return ipcRenderer.invoke('fieldinspect:get-version');
    } catch (_) {
      return Promise.resolve(null);
    }
  },
  onUpdateStatus: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const subscription = (_event, data) => {
      try {
        callback(data);
      } catch (_) {}
    };
    ipcRenderer.on('fieldinspect:update-status', subscription);
    return () => {
      try {
        ipcRenderer.removeListener('fieldinspect:update-status', subscription);
      } catch (_) {}
    };
  }
});

