const { app, BrowserWindow, shell, session, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const fs = require('fs');
const path = require('path');

const isDev = !app.isPackaged;
let mainWindow;
let isQuitting = false;
let updateCheckTimer;

function log(message, details = '') {
  const line = `[${new Date().toISOString()}] ${message}${details ? ' ' + details : ''}\n`;
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'fieldinspect.log'), line, 'utf8');
  } catch (error) {
    console.error('[FieldInspect] Could not write log:', error);
  }
  console.info(line.trim());
}

function logUpdate(message, details = '') {
  log(message, details);
}

function broadcastUpdateStatus(status, details = {}) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('fieldinspect:update-status', { status, ...details });
    }
  } catch (err) {
    log('Renderer IPC notification skipped', err?.message || String(err));
  }
}

function registerIpcHandlers() {
  ipcMain.handle('fieldinspect:get-version', () => app.getVersion());

  ipcMain.handle('fieldinspect:check-for-updates', async () => {
    if (!app.isPackaged) return { status: 'dev-mode', message: 'Auto-updates disabled in dev mode' };
    try {
      const result = await autoUpdater.checkForUpdates();
      return { status: 'checking', updateInfo: result?.updateInfo || null };
    } catch (error) {
      logUpdate('Manual update check error', error?.message || String(error));
      return { status: 'error', error: error?.message || String(error) };
    }
  });

  ipcMain.handle('fieldinspect:install-update', () => {
    if (!app.isPackaged) return false;
    try {
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      logUpdate('Manual install update error', error?.message || String(error));
      return false;
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1050,
    minHeight: 720,
    title: 'FieldInspect Pro',
    backgroundColor: '#f1f5f9',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
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

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    log('Renderer console', `level=${level} source=${sourceId || 'unknown'}:${line || 0} ${message}`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('Renderer process exited', JSON.stringify(details || {}));
    if (!isQuitting) {
      setTimeout(() => {
        if (!mainWindow || mainWindow.isDestroyed()) {
          createWindow();
        } else {
          loadApp();
        }
      }, 500);
    }
  });

  mainWindow.webContents.on('unresponsive', () => {
    log('Renderer became unresponsive');
  });

  mainWindow.webContents.on('responsive', () => {
    log('Renderer became responsive');
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    log('Renderer failed to load', `code=${errorCode} description=${errorDescription} url=${validatedURL}`);
  });

  mainWindow.webContents.on('did-finish-load', () => {
    log('Renderer finished loading', mainWindow.webContents.getURL());
  });

  mainWindow.once('ready-to-show', () => {
    if (!mainWindow.isDestroyed()) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  function loadApp() {
    const distIndex = path.join(app.getAppPath(), 'dist', 'index.html');
    const sourceIndex = path.join(app.getAppPath(), 'index.html');
    const indexPath = fs.existsSync(distIndex) ? distIndex : sourceIndex;

    log('Loading renderer', indexPath);
    mainWindow.loadFile(indexPath).catch(error => {
      log('Renderer loadFile rejected', error?.stack || error?.message || String(error));
    });
  }

  loadApp();

  if (isDev) mainWindow.webContents.openDevTools();
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;

  // Explicitly configure the GitHub feed so the updater does not depend
  // on a generated app-update.yml being present inside the installed app.
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'yanic-shikokot',
    repo: 'Instant-',
    releaseType: 'release'
  });

  autoUpdater.logger = {
    info: (msg) => logUpdate('[Updater Info]', typeof msg === 'string' ? msg : JSON.stringify(msg)),
    warn: (msg) => logUpdate('[Updater Warn]', typeof msg === 'string' ? msg : JSON.stringify(msg)),
    error: (msg) => logUpdate('[Updater Error]', typeof msg === 'string' ? msg : JSON.stringify(msg)),
    debug: (msg) => logUpdate('[Updater Debug]', typeof msg === 'string' ? msg : JSON.stringify(msg))
  };

  autoUpdater.autoDownload = true;
  // electron-updater 6.x uses autoInstallOnAppQuit. Keep installation manual so
  // closing and immediately reopening the Windows app cannot race the NSIS installer.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;

  logUpdate(`Updater initialized. App version=${app.getVersion()} feed=https://github.com/yanic-shikokot/Instant-/releases`);

  autoUpdater.on('checking-for-update', () => {
    logUpdate('Checking for updates');
    broadcastUpdateStatus('checking');
  });

  autoUpdater.on('update-available', info => {
    logUpdate('Update available', `version=${info?.version || 'unknown'}`);
    broadcastUpdateStatus('available', { version: info?.version });
  });

  autoUpdater.on('update-not-available', info => {
    logUpdate('No update available', `version=${info?.version || 'unknown'}`);
    broadcastUpdateStatus('not-available', { version: info?.version });
  });

  autoUpdater.on('download-progress', progress => {
    logUpdate('Update download progress', `${Math.round(progress.percent || 0)}%`);
    broadcastUpdateStatus('download-progress', { percent: Math.round(progress.percent || 0) });
  });

  autoUpdater.on('update-downloaded', async info => {
    logUpdate('Update downloaded', `version=${info?.version || 'unknown'}`);
    broadcastUpdateStatus('downloaded', { version: info?.version });
    if (isQuitting) return;

    const result = await dialog.showMessageBox({
      type: 'info',
      buttons: ['Restart and update', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'FieldInspect Pro update ready',
      message: `FieldInspect Pro ${info?.version || 'a new version'} is ready to install.`,
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

  autoUpdater.on('error', error => {
    logUpdate('Auto-update error', error?.stack || error?.message || String(error));
    broadcastUpdateStatus('error', { error: error?.message || String(error) });
  });

  const check = async (reason = 'scheduled') => {
    if (isQuitting) return;
    try {
      logUpdate('Starting update check', `reason=${reason} current=${app.getVersion()}`);
      const result = await autoUpdater.checkForUpdates();
      logUpdate(
        'Update check completed',
        `reason=${reason} update=${result?.updateInfo?.version || 'none'}`
      );
    } catch (error) {
      logUpdate('Update check failed', error?.stack || error?.message || String(error));
    }
  };

  // Check shortly after startup, then every 6 hours.
  setTimeout(() => check('startup'), 8000);
  updateCheckTimer = setInterval(() => check('scheduled'), 6 * 60 * 60 * 1000);
}

app.whenReady().then(() => {
  registerIpcHandlers();

  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });

  // Initialize the updater before loading the renderer. A hung renderer must
  // never prevent the main-process updater from starting or logging its state.
  configureAutoUpdates();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch(error => {
  log('Application startup failed', error?.stack || error?.message || String(error));
});

app.on('before-quit', () => {
  isQuitting = true;
  if (updateCheckTimer) clearInterval(updateCheckTimer);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
