const { app, BrowserWindow, shell, session, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow;
let isQuitting = false;
let updateCheckTimer;

function logUpdate(message, details = '') {
  const line = \`[\${new Date().toISOString()}] \${message}\${details ? ' ' + details : ''}\\n\`;
  try {
    const logPath = path.join(app.getPath('userData'), 'fieldinspect-updater.log');
    fs.appendFileSync(logPath, line, 'utf8');
  } catch (error) {
    console.error('[FieldInspect] Could not write updater log:', error);
  }
  console.info(line.trim());
}

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
    if (/^https?:\\/\\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  const indexPath = path.join(__dirname, '..', 'index.html');
  mainWindow.loadFile(indexPath);

  if (isDev) mainWindow.webContents.openDevTools();
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;

  // electron-builder generates app-update.yml from the GitHub publish
  // configuration in package.json. Do not call setFeedURL here.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallEvent = 'onNextLaunch';
  autoUpdater.allowDowngrade = false;

  logUpdate(\`Updater initialized. App version=\${app.getVersion()}\`);

  autoUpdater.on('checking-for-update', () => {
    logUpdate('Checking for updates');
  });

  autoUpdater.on('update-available', (info) => {
    logUpdate('Update available', \`version=\${info?.version || 'unknown'}\`);
  });

  autoUpdater.on('update-not-available', (info) => {
    logUpdate('No update available', \`version=\${info?.version || 'unknown'}\`);
  });

  autoUpdater.on('download-progress', (progress) => {
    logUpdate('Update download progress', \`\${Math.round(progress.percent || 0)}%\`);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    logUpdate('Update downloaded', \`version=\${info?.version || 'unknown'}\`);
    if (isQuitting) return;

    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'FieldInspect Pro update ready',
      message: \`FieldInspect Pro \${info?.version || 'a new version'} is ready to install.\`,
      detail: 'Choose Restart and update to install it now. If you choose Later, the downloaded update will be installed automatically the next time FieldInspect Pro starts.'
    });

    if (result.response === 0) {
      isQuitting = true;
      logUpdate('User chose Restart and update');
      autoUpdater.quitAndInstall(false, true);
    } else {
      logUpdate('User chose Later; update will install on next launch');
    }
  });

  autoUpdater.on('error', (error) => {
    logUpdate('Auto-update error', error?.stack || error?.message || String(error));
  });

  const check = async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logUpdate('Update check failed', error?.stack || error?.message || String(error));
    }
  };

  setTimeout(check, 8000);
  updateCheckTimer = setInterval(check, 6 * 60 * 60 * 1000);
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
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
