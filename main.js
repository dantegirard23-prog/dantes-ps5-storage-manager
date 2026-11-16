const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

process.env.DANTE_STORAGE_USER_DATA = app.getPath('userData');
const server = require(path.join(__dirname, 'server.js'));

let mainWindow;
let updateCheckInProgress = false;

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade = false;

function reportUpdate(status, message, extra = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app:update-status', { status, message, ...extra });
  }
}

autoUpdater.on('checking-for-update', () => {
  reportUpdate('checking', 'Checking GitHub for updates…');
});
autoUpdater.on('update-available', info => {
  reportUpdate('available', 'Update ' + info.version + ' found. Downloading…', { version: info.version });
});
autoUpdater.on('update-not-available', info => {
  reportUpdate('current', 'You are using the latest version (' + app.getVersion() + ').');
});
autoUpdater.on('download-progress', progress => {
  reportUpdate('downloading', 'Downloading update… ' + Math.round(progress.percent) + '%', {
    percent: Math.round(progress.percent)
  });
});
autoUpdater.on('update-downloaded', async info => {
  reportUpdate('downloaded', 'Update ' + info.version + ' is ready to install.');
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Dante PS5 Storage Manager Update',
    message: 'Version ' + info.version + ' is ready!',
    detail: 'Restart the app to install the update.',
    buttons: ['Restart and Install', 'Later'],
    defaultId: 0,
    cancelId: 1
  });
  if (result.response === 0) autoUpdater.quitAndInstall();
});
autoUpdater.on('error', error => {
  console.error('Update error:', error);
  reportUpdate('error', 'Update check failed: ' + (error.message || 'Unknown error'));
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('app:check-for-updates', async () => {
  if (!app.isPackaged) {
    return { status: 'development', message: 'Update checks work in the installed Windows app, not in development mode.' };
  }
  if (updateCheckInProgress) {
    return { status: 'checking', message: 'An update check is already running.' };
  }
  updateCheckInProgress = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    return {
      status: result && result.isUpdateAvailable ? 'available' : 'current',
version: result && result.updateInfo ? result.updateInfo.version : app.getVersion(),
message: result && result.isUpdateAvailable
  ? 'Update found. Downloading…'
   : 'You are using the latest version (' + app.getVersion() + ').'
    };
  } catch (error) {
    reportUpdate('error', 'Update check failed: ' + (error.message || 'Unknown error'));
    return { status: 'error', message: error.message || 'Update check failed.' };
  } finally {
    updateCheckInProgress = false;
  }
});

app.whenReady().then(async () => {
  try {
    if (!server.listening) {
      await new Promise((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    const url = 'http://127.0.0.1:' + server.address().port;
    mainWindow = new BrowserWindow({
      width: 1440,
      height: 920,
      minWidth: 900,
      minHeight: 650,
      autoHideMenuBar: true,
      backgroundColor: '#07110b',
      icon: path.join(__dirname, 'toxic-codes.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    await mainWindow.loadURL(url);
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdates().catch(error => {
          console.error('Automatic update check failed:', error);
        });
      }, 5000);
    }
  } catch (error) {
    dialog.showErrorBox('PS5 Storage Manager', error.message);
    app.quit();
  }
});

app.on('before-quit', () => {
  try { server.close(); } catch (_) {}
});
app.on('window-all-closed', () => app.quit());
