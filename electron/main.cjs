const { app, BrowserWindow, shell, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow;
let isQuitting = false;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1050,
    minHeight: 720,
    title: 'FieldInspect Pro',
    backgroundColor: '#f1f5f9',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: isDev
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const indexPath = path.join(__dirname, '..', 'index.html');
  mainWindow.loadFile(indexPath);

  if (isDev) mainWindow.webContents.openDevTools();
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => {
    console.info('[FieldInspect] Checking for updates');
  });

  autoUpdater.on('update-available', (info) => {
    console.info('[FieldInspect] Update available', info?.version || '');
  });

  autoUpdater.on('update-not-available', (info) => {
    console.info('[FieldInspect] No update available', info?.version || '');
  });

  autoUpdater.on('download-progress', (progress) => {
    console.info('[FieldInspect] Update download', Math.round(progress.percent || 0) + '%');
  });

  autoUpdater.on('update-downloaded', async (info) => {
    if (isQuitting) return;
    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'FieldInspect Pro update ready',
      message: 'FieldInspect Pro ' + (info?.version || 'a new version') + ' is ready to install.',
      detail: 'Your inspection data is stored separately from the application. Restart FieldInspect Pro to complete the update.'
    });
    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
    }
  });

  autoUpdater.on('error', (error) => {
    console.error('[FieldInspect] Auto-update error:', error);
  });

  const check = () => {
    autoUpdater.checkForUpdates().catch(error => {
      console.error('[FieldInspect] Update check failed:', error);
    });
  };

  // First check after startup, then periodically so long-running sessions
  // also receive releases without requiring a manual installer download.
  setTimeout(check, 8000);
  setInterval(check, 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  createWindow();
  configureAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
