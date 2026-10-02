const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('fieldInspectDesktop', {
  platform: process.platform,
  version: process.versions.electron
});
